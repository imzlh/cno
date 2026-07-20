/**
 * Node.js node:sqlite module.
 *
 * Implements the synchronous DatabaseSync / StatementSync surface on top of
 * circu.js' native sqlite3 binding.
 */

const native = import.meta.use('sqlite3');
const engine = import.meta.use('engine');

type Sqlite3Handle = CModuleSQLite3.Sqlite3Handle;
type Sqlite3Stmt = CModuleSQLite3.Sqlite3Stmt;
type SqliteRow = Record<string, unknown> | unknown[];
type BindParams = unknown[] | Record<string, unknown>;
type DatabaseLocation = string | URL | Uint8Array;

const SQLITE_TYPE = Symbol.for('sqlite-type');
const NAMED_PARAM_PREFIXES = new Set([':', '@', '$']);

export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
}

export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
    timeout?: number;
}

export interface StatementColumnMetadata {
    name: string;
    column?: string | null;
    table?: string | null;
    database?: string | null;
    type?: string | null;
}

const DEFAULT_FLAGS = native.O_CREATE | native.O_READWRITE;

function isBindRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function paramsFrom(args: unknown[]): BindParams | undefined {
    if (args.length === 0) return undefined;
    if (args.length === 1) {
        const value = args[0];
        if (Array.isArray(value) || isBindRecord(value)) {
            return value;
        }
    }
    return args;
}

function allRows(stmt: Sqlite3Stmt, params?: BindParams): SqliteRow[] {
    return params === undefined ? stmt.all() : stmt.all(params);
}

function runStmt(stmt: Sqlite3Stmt, params?: BindParams): void {
    if (params === undefined) stmt.run();
    else stmt.run(params);
}

function unsupported(name: string): never {
    throw new Error(`node:sqlite ${name} is not implemented by this runtime`);
}

function optionalBoolean(options: Record<string, unknown>, name: string): boolean {
    const value = options[name];
    if (value !== undefined && typeof value !== 'boolean') {
        throw new TypeError(`The "options.${name}" argument must be of type boolean`);
    }
    return value === true;
}

function normalizeLocation(location: DatabaseLocation): string {
    if (typeof location === 'string') return location;
    if (location instanceof URL) {
        if (location.protocol !== 'file:') {
            throw new TypeError('Database path URL must use the file: protocol');
        }
        return decodeURIComponent(location.pathname);
    }
    if (location instanceof Uint8Array) {
        return engine.decodeString(location);
    }
    throw new TypeError('Database path must be a string, Buffer, Uint8Array, or file: URL');
}

function isNameChar(ch: string | undefined): boolean {
    return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function scanNamedParameters(sql: string): Set<string> {
    const params = new Set<string>();
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        const next = sql[i + 1];

        if (ch === '-' && next === '-') {
            i = sql.indexOf('\n', i + 2);
            if (i < 0) break;
            continue;
        }
        if (ch === '/' && next === '*') {
            const end = sql.indexOf('*/', i + 2);
            if (end < 0) break;
            i = end + 1;
            continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') {
            for (i++; i < sql.length; i++) {
                if (sql[i] !== ch) continue;
                if (sql[i + 1] === ch) i++;
                else break;
            }
            continue;
        }
        if (ch === '[') {
            const end = sql.indexOf(']', i + 1);
            if (end < 0) break;
            i = end;
            continue;
        }
        if (!NAMED_PARAM_PREFIXES.has(ch ?? '') || !isNameChar(next)) continue;

        let end = i + 2;
        while (isNameChar(sql[end])) end++;
        params.add(sql.slice(i, end));
        i = end - 1;
    }
    return params;
}

export class StatementSync {
    private returnArrays = false;
    private readBigInts = false;
    private allowBareNamedParameters = true;
    private allowUnknownNamedParameters = false;
    private namedParameters?: Set<string>;

    constructor(private readonly db: DatabaseSync, private readonly stmt: Sqlite3Stmt, readonly sourceSQL = '') {}

    all(...anonymousParameters: unknown[]): SqliteRow[] {
        return this.convertRows(allRows(this.stmt, this.normalizeParams(paramsFrom(anonymousParameters))));
    }

    get(...anonymousParameters: unknown[]): SqliteRow | undefined {
        return this.all(...anonymousParameters)[0];
    }

    run(...anonymousParameters: unknown[]): RunResult {
        runStmt(this.stmt, this.normalizeParams(paramsFrom(anonymousParameters)));
        return {
            changes: this.db.raw().changes(),
            lastInsertRowid: this.readBigInts
                ? BigInt(this.db.raw().lastInsertRowid())
                : this.db.raw().lastInsertRowid(),
        };
    }

    iterate(...anonymousParameters: unknown[]): IterableIterator<SqliteRow> {
        const rows = this.all(...anonymousParameters);
        let index = 0;
        return {
            next(): IteratorResult<SqliteRow> {
                if (index >= rows.length) return { done: true, value: null };
                const value = rows[index];
                index++;
                return value === undefined
                    ? { done: true, value: null }
                    : { done: false, value };
            },
            [Symbol.iterator]() {
                return this;
            },
        };
    }

    columns(): StatementColumnMetadata[] {
        const row = this.get();
        if (!row) return [];
        const names = Array.isArray(row) ? row.map((_, index: number) => String(index)) : Object.keys(row);
        return names.map(name => ({ name }));
    }

    setReadBigInts(enabled: boolean): void {
        this.readBigInts = !!enabled;
    }

    setReturnArrays(enabled: boolean): void {
        this.returnArrays = !!enabled;
    }

    setAllowBareNamedParameters(enabled: boolean): void {
        this.allowBareNamedParameters = !!enabled;
    }

    setAllowUnknownNamedParameters(enabled: boolean): void {
        this.allowUnknownNamedParameters = !!enabled;
    }

    get expandedSQL(): string {
        return this.stmt.expand();
    }

    raw(): Sqlite3Stmt {
        return this.stmt;
    }

    finalize(): void {
        this.stmt.finalize();
    }

    private convertCell(value: unknown): unknown {
        return this.readBigInts && typeof value === 'number' && Number.isInteger(value)
            ? BigInt(value)
            : value;
    }

    private convertRow(row: SqliteRow): SqliteRow {
        if (!this.readBigInts) return row;
        if (Array.isArray(row)) return row.map(value => this.convertCell(value));
        if (!row || typeof row !== 'object') return row;

        const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(row));
        for (const key of Object.keys(row)) out[key] = this.convertCell(row[key]);
        return out;
    }

    private convertRows(rows: SqliteRow[]): SqliteRow[] {
        const convertedRows = rows.map(row => this.convertRow(row));
        if (!this.returnArrays) return convertedRows;
        return convertedRows.map(row => Array.isArray(row) ? row : Object.keys(row).map(key => row[key]));
    }

    private getNamedParameters(): Set<string> {
        this.namedParameters ??= scanNamedParameters(this.sourceSQL);
        return this.namedParameters;
    }

    private normalizeParams(params: BindParams | undefined): BindParams | undefined {
        if (!isBindRecord(params)) return params;

        const known = this.getNamedParameters();
        if (known.size === 0) return params;

        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(params)) {
            const mapped = this.mapNamedParameter(key, known);
            if (mapped === null) {
                if (this.allowUnknownNamedParameters) continue;
                throw new ReferenceError(`Could not find parameter '${key}'`);
            }
            out[mapped] = value;
        }
        return out;
    }

    private mapNamedParameter(key: string, known: Set<string>): string | null {
        if (NAMED_PARAM_PREFIXES.has(key[0] ?? '')) {
            return known.has(key) ? key : null;
        }
        if (!this.allowBareNamedParameters) {
            throw new ReferenceError(`Could not find parameter '${key}'`);
        }

        const matches = [`:${key}`, `@${key}`, `$${key}`].filter(name => known.has(name));
        const match = matches[0];
        if (match === undefined) return null;
        if (matches.length > 1) {
            throw new TypeError(`Ambiguous named parameter '${key}'`);
        }
        return match;
    }
}

export class DatabaseSync {
    private handle: Sqlite3Handle | null = null;
    readonly location: string;

    constructor(location: DatabaseLocation, options: DatabaseSyncOptions = {}) {
        this.location = normalizeLocation(location);
        if (options.open === false) return;
        this.open(options.readOnly ? native.O_READONLY : DEFAULT_FLAGS);
        if (options.enableForeignKeyConstraints !== false) {
            this.exec('PRAGMA foreign_keys = ON');
        }
        if (options.timeout !== undefined) {
            this.raw().busyTimeout(options.timeout);
        }
    }

    get isOpen(): boolean {
        return this.handle !== null;
    }

    get isTransaction(): boolean {
        return this.raw().inTransaction();
    }

    open(flags = DEFAULT_FLAGS): void {
        if (this.handle) return;
        this.handle = native.open(this.location, flags);
    }

    close(): void {
        if (!this.handle) return;
        this.handle.close();
        this.handle = null;
    }

    exec(sql: string): void {
        this.raw().exec(sql);
    }

    prepare(sql: string): StatementSync {
        return new StatementSync(this, this.raw().prepare(sql), sql);
    }

    /**
     * Register a scalar SQL function (Node DatabaseSync.function).
     * function(name, fn) | function(name, options, fn)
     */
    function(
        name: string,
        optionsOrFn?: Record<string, unknown> | ((...args: unknown[]) => unknown),
        maybeFn?: (...args: unknown[]) => unknown,
    ): void {
        if (typeof name !== 'string' || name.length === 0) {
            throw new TypeError('The "name" argument must be a non-empty string');
        }
        let options: Record<string, unknown> = {};
        let fn: (...args: unknown[]) => unknown;
        if (typeof optionsOrFn === 'function') {
            fn = optionsOrFn;
        } else if (typeof maybeFn === 'function') {
            if (optionsOrFn === null || typeof optionsOrFn !== 'object') {
                throw new TypeError('The "options" argument must be an object');
            }
            options = optionsOrFn;
            fn = maybeFn;
        } else {
            throw new TypeError('The "function" argument must be of type function');
        }

        const deterministic = optionalBoolean(options, 'deterministic');
        const directOnly = optionalBoolean(options, 'directOnly');
        const varargs = optionalBoolean(options, 'varargs');
        const useBigIntArguments = optionalBoolean(options, 'useBigIntArguments');
        const nArg = varargs ? -1 : (typeof fn.length === 'number' ? fn.length : 0);
        const nativeOpts: { deterministic?: boolean; directOnly?: boolean; useBigIntArguments?: boolean } = {};
        if (deterministic) nativeOpts.deterministic = true;
        if (directOnly) nativeOpts.directOnly = true;
        if (useBigIntArguments) nativeOpts.useBigIntArguments = true;

        this.raw().createFunction(name, nArg, fn, nativeOpts);
    }

    /**
     * Register an aggregate SQL function (Node DatabaseSync.aggregate).
     * aggregate(name, options) with options.start + options.step required.
     */
    aggregate(name: string, options: Record<string, unknown>): void {
        if (typeof name !== 'string' || name.length === 0) {
            throw new TypeError('The "name" argument must be a non-empty string');
        }
        if (options === undefined || options === null || typeof options !== 'object') {
            throw new TypeError('The "options" argument must be an object');
        }
        if (options.start === undefined) {
            throw new TypeError('The "options.start" argument must be a function or a primitive value');
        }
        if (typeof options.step !== 'function') {
            throw new TypeError('The "options.step" argument must be a function');
        }
        if (options.inverse !== undefined && typeof options.inverse !== 'function') {
            throw new TypeError('The "options.inverse" argument must be a function');
        }

        const directOnly = optionalBoolean(options, 'directOnly');
        const varargs = optionalBoolean(options, 'varargs');
        const useBigIntArguments = optionalBoolean(options, 'useBigIntArguments');
        let nArg = -1;
        if (!varargs) {
            // Node infers arity from step.length minus the accumulator argument.
            const stepLen = typeof (options.step as Function).length === 'number'
                ? (options.step as Function).length
                : 1;
            nArg = Math.max(0, stepLen - 1);
        }

        this.raw().createAggregate(name, nArg, {
            start: options.start,
            step: options.step as (...args: unknown[]) => unknown,
            result: typeof options.result === 'function' ? options.result : undefined,
            inverse: options.inverse as ((...args: unknown[]) => unknown) | undefined,
            deterministic: !!options.deterministic,
            directOnly,
            useBigIntArguments,
        });
    }

    createSession(): void {
        unsupported('DatabaseSync.createSession');
    }

    applyChangeset(): void {
        unsupported('DatabaseSync.applyChangeset');
    }

    enableLoadExtension(_allow: boolean): void {}

    loadExtension(path: string, entryPoint?: string): void {
        this.raw().loadExtension(path, entryPoint);
    }

    raw(): Sqlite3Handle {
        if (!this.handle) throw new Error('Database is not open');
        return this.handle;
    }
}

Object.defineProperty(DatabaseSync.prototype, SQLITE_TYPE, {
    value: 'node:sqlite',
    configurable: true,
});

export class Session {
    constructor() {
        unsupported('Session');
    }
}

export interface BackupOptions {
    source?: string;
    target?: string;
}

/**
 * Online backup of an open DatabaseSync to a destination path (Node node:sqlite.backup).
 * Resolves with the total page count of the source database.
 */
export function backup(
    sourceDb: DatabaseSync,
    path: string | URL | Uint8Array,
    options: BackupOptions = {},
): Promise<number> {
    if (!(sourceDb instanceof DatabaseSync) && !(sourceDb && typeof (sourceDb as DatabaseSync).raw === 'function')) {
        return Promise.reject(new TypeError('The "sourceDb" argument must be a DatabaseSync'));
    }
    if (path === undefined || path === null) {
        return Promise.reject(new TypeError('The "path" argument must be a string, Buffer, or file: URL'));
    }
    const destPath = normalizeLocation(path as DatabaseLocation);
    const sourceName = options.source ?? 'main';
    const destName = options.target ?? 'main';
    try {
        const pages = sourceDb.raw().backupTo(destPath, sourceName, destName);
        return Promise.resolve(pages);
    } catch (e) {
        return Promise.reject(e);
    }
}

export const constants = {
    SQLITE_CHANGESET_OMIT: 0,
    SQLITE_CHANGESET_REPLACE: 1,
    SQLITE_CHANGESET_ABORT: 2,
    SQLITE_CHANGESET_DATA: 1,
    SQLITE_CHANGESET_NOTFOUND: 2,
    SQLITE_CHANGESET_CONFLICT: 3,
    SQLITE_CHANGESET_CONSTRAINT: 4,
    SQLITE_CHANGESET_FOREIGN_KEY: 5,
};

export const sqlite = {
    DatabaseSync,
    StatementSync,
    Session,
    backup,
    constants,
};

export default sqlite;
