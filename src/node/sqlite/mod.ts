/**
 * Node.js node:sqlite module.
 *
 * Implements the synchronous DatabaseSync / StatementSync surface on top of
 * circu.js' native sqlite3 binding.
 */

import { resolve as resolvePath } from '../path';

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

/**
 * Every native sqlite3 entry point must funnel through here. The C binding
 * throws a bare Error carrying only `message` and a non-enumerable `errno`, so
 * without this wrapper `err.code` is undefined on every failure and the
 * standard `if (err.code === 'ERR_SQLITE_ERROR')` branch never matches.
 */
function nativeCall<T>(fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        throw sqliteError(e);
    }
}

function allRows(stmt: Sqlite3Stmt, params?: BindParams): SqliteRow[] {
    return nativeCall(() => (params === undefined ? stmt.all() : stmt.all(params)));
}

function runStmt(stmt: Sqlite3Stmt, params?: BindParams): void {
    nativeCall(() => {
        if (params === undefined) stmt.run();
        else stmt.run(params);
    });
}

function unsupported(name: string): never {
    throw new Error(`node:sqlite ${name} is not implemented by this runtime`);
}

/** A raw error straight out of the C binding: `errno` set, `code` still absent. */
function isNativeSqliteError(e: unknown): e is Error & { errno: number } {
    return e instanceof Error
        && typeof (e as { errno?: unknown }).errno === 'number'
        && (e as { code?: unknown }).code === undefined;
}

/**
 * The bind path throws plain RangeError/TypeError with the C module's own
 * wording. Node uses different constructors, codes and messages for the same
 * two conditions, and callers branch on the code.
 */
function mapBindError(e: Error): Error | null {
    if (/^BigInt value is out of int64 range at position \d+$/.test(e.message)) {
        return Object.assign(new TypeError('BigInt value is too large to bind.'), {
            code: 'ERR_INVALID_ARG_VALUE',
        });
    }
    const badType = /^Invalid bound parameter type at position (\d+)$/.exec(e.message);
    if (badType) {
        return Object.assign(
            new TypeError(`Provided value cannot be bound to SQLite parameter ${badType[1]}.`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    return null;
}

/**
 * Give a native error Node's `node:sqlite` shape: enumerable `code`, `errcode`
 * and `errstr`, matching Node's own enumerable key set exactly.
 *
 * DIVERGENCE: Node's `errcode` is the *extended* result code (2067 for a UNIQUE
 * violation, 1299 for NOT NULL, 275 for CHECK, 787 for FOREIGN KEY) and its
 * `message` is sqlite3_errmsg (`UNIQUE constraint failed: u.k`). The binding
 * only surfaces the primary code (19 for every one of those) and sqlite3_errstr
 * (`constraint failed` for every one of those), so all five distinguishable
 * constraint failures collapse into one indistinguishable error. Closing that
 * needs sqlite3_extended_errcode + sqlite3_errmsg in mod_sqlite3.c — it cannot
 * be done here, because neither value is reachable from JS and `errstr` is the
 * same string for all five, so there is nothing to derive the distinction from.
 * `code` — the part callers actually branch on — is exact.
 *
 * `errstr` is read from the binding when present and falls back to `message`
 * otherwise. That fallback is today's only path (the binding sets no `errstr`),
 * and it keeps `errstr` *enumerable* either way: defining it only-when-absent
 * would silently drop it out of Object.keys the moment the binding starts
 * reporting it separately, breaking the key set this function exists to match.
 */
function sqliteError(e: unknown): unknown {
    if (!(e instanceof Error)) return e;
    const mapped = mapBindError(e);
    if (mapped) return mapped;
    if (!isNativeSqliteError(e)) return e;
    const prop = (value: unknown) => ({ value, writable: true, enumerable: true, configurable: true });
    const native = (e as { errstr?: unknown }).errstr;
    const shape: PropertyDescriptorMap = {
        code: prop('ERR_SQLITE_ERROR'),
        errcode: prop(e.errno),
        errstr: prop(typeof native === 'string' ? native : e.message),
    };
    return Object.defineProperties(e, shape);
}

function throwOutOfRange(value: unknown): never {
    throw Object.assign(
        new RangeError(`Value is too large to be represented as a JavaScript number: ${value}`),
        { code: 'ERR_OUT_OF_RANGE' },
    );
}

function optionalBoolean(options: object, name: string): boolean {
    const value = Reflect.get(options, name);
    if (value !== undefined && typeof value !== 'boolean') {
        throw Object.assign(new TypeError(`The "options.${name}" argument must be of type boolean.`), {
            code: 'ERR_INVALID_ARG_TYPE',
        });
    }
    return value === true;
}

function normalizeLocation(location: DatabaseLocation): string {
    if (typeof location === 'string') return location;
    if (location instanceof URL) {
        if (location.protocol !== 'file:') {
            throw Object.assign(new TypeError('The URL must be of scheme file:'), {
                code: 'ERR_INVALID_URL_SCHEME',
            });
        }
        // Percent-decoding is deliberate: Node hands the URL to SQLite's own URI
        // parser, which decodes %2F where fileURLToPath throws ERR_INVALID_FILE_URL_PATH.
        const pathname = decodeURIComponent(location.pathname);
        // `/C:/x` → `C:/x`. Windows tolerates the leading slash, so this was latent.
        return /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
    }
    if (location instanceof Uint8Array) {
        return engine.decodeString(location);
    }
    throw new TypeError('Database path must be a string, Buffer, Uint8Array, or file: URL');
}

/**
 * Absolute path SQLite would have captured for the `main` schema, or null for
 * databases with no backing file (`:memory:`, `''`, `file:` URI forms).
 */
function resolveMainLocation(dbPath: string): string | null {
    if (dbPath === '' || dbPath === ':memory:') return null;
    if (dbPath.startsWith('file:')) return null;
    // Emulated: real Node asks SQLite (sqlite3_db_filename). The native binding
    // exposes no filename accessor, so path.resolve stands in for SQLite's win32
    // VFS expansion. Matches the common case; drifts on UNC paths, `\\?\`
    // prefixes and drive-relative forms like `C:foo`.
    return resolvePath(dbPath);
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

/** True only for statements that can produce result rows, so metadata never steps
 *  DML. `WITH` is included only when it does not wrap an INSERT/UPDATE/DELETE. */
function canYieldRows(sql: string): boolean {
    const s = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '').trimStart().toUpperCase();
    if (/^(SELECT|VALUES|PRAGMA|EXPLAIN)\b/.test(s)) return true;
    if (/^WITH\b/.test(s)) return !/\b(INSERT|UPDATE|DELETE)\b/.test(s);
    return false;
}

export class StatementSync {
    private returnArrays = false;
    private readBigInts = false;
    private allowBareNamedParameters = true;
    private allowUnknownNamedParameters = false;
    private namedParameters?: Set<string>;

    constructor(private readonly db: DatabaseSync, private readonly stmt: Sqlite3Stmt, readonly sourceSQL = '') {}

    /**
     * Node finalizes every outstanding statement when the database closes, so
     * any later use reports ERR_INVALID_STATE. The native binding here does not
     * finalize on close and the sqlite3_stmt keeps returning its cached rows, so
     * without this guard a statement outlives its database and reads memory the
     * connection no longer owns. Check before touching the native handle.
     */
    private assertUsable(): void {
        if (!this.db.isOpen) {
            throw Object.assign(new Error('statement has been finalized'), { code: 'ERR_INVALID_STATE' });
        }
    }

    all(...anonymousParameters: unknown[]): SqliteRow[] {
        this.assertUsable();
        return this.convertRows(allRows(this.stmt, this.normalizeParams(paramsFrom(anonymousParameters))));
    }

    get(...anonymousParameters: unknown[]): SqliteRow | undefined {
        return this.all(...anonymousParameters)[0];
    }

    run(...anonymousParameters: unknown[]): RunResult {
        this.assertUsable();
        runStmt(this.stmt, this.normalizeParams(paramsFrom(anonymousParameters)));
        const rowid = nativeCall(() => this.db.raw().lastInsertRowid(this.readBigInts));
        return {
            changes: nativeCall(() => this.db.raw().changes()),
            // Same narrowing as convertCell: only an exact integer may be widened.
            lastInsertRowid: this.readBigInts
                ? (typeof rowid === 'bigint'
                    ? rowid
                    : Number.isSafeInteger(rowid) ? BigInt(rowid) : throwOutOfRange(rowid))
                : rowid,
        };
    }

    iterate(...anonymousParameters: unknown[]): IterableIterator<SqliteRow> {
        this.assertUsable();
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
        this.assertUsable();
        // Metadata must never execute the statement: deriving it via this.get()
        // stepped the statement, so `prepare('DELETE FROM t').columns()` deleted
        // every row. Three paths, best first:
        //   1. native `columnMetadata()` -- Node's full five-key shape.
        //   2. native `columnNames()` -- names only; the other four fields are
        //      not derivable from a name and must NOT be guessed from the SQL.
        //   3. no native accessor -- a non-stepping fallback (see below).
        // Paths 2 and 3 exist because a binary without the newer natives must
        // degrade rather than throw "TypeError: not a function".
        const stmt = this.stmt as unknown as {
            columnMetadata?: () => StatementColumnMetadata[];
            columnNames?: () => string[];
            step?: () => unknown;
            reset?: () => void;
        };
        if (typeof stmt.columnMetadata === 'function') {
            return stmt.columnMetadata();
        }
        if (typeof stmt.columnNames === 'function') {
            // DIVERGENCE: Node also reports `column`, `database`, `table` and
            // `type`. They come from sqlite3_column_origin_name/table_name/
            // database_name/decltype, none of which is reachable from JS on this
            // path, so the keys are omitted rather than filled with a null that
            // would assert "this column has no declared type" untruthfully.
            return stmt.columnNames().map(name => ({ name }));
        }
        // Only a statement that can yield rows is stepped, and it is immediately
        // reset, so the cursor is rewound and no DML side effect can occur. DML is
        // never stepped at all: Node returns [] for statements with no result
        // columns, so that path is node-correct rather than merely safe.
        if (!canYieldRows(this.sourceSQL)) return [];
        const first = this.get();
        try {
            return first === undefined ? [] : Object.keys(first as object).map(name => ({ name }));
        } finally {
            stmt.reset?.();
        }
    }

    setReadBigInts(enabled: boolean): void {
        if (typeof enabled !== 'boolean') {
            throw Object.assign(new TypeError('The "readBigInts" argument must be a boolean.'), {
                code: 'ERR_INVALID_ARG_TYPE',
            });
        }
        this.readBigInts = enabled;
        nativeCall(() => this.stmt.setReadBigInts(enabled));
    }

    setReturnArrays(enabled: boolean): void {
        if (typeof enabled !== 'boolean') {
            throw Object.assign(new TypeError('The "returnArrays" argument must be a boolean.'), {
                code: 'ERR_INVALID_ARG_TYPE',
            });
        }
        this.returnArrays = enabled;
    }

    setAllowBareNamedParameters(enabled: boolean): void {
        if (typeof enabled !== 'boolean') {
            throw Object.assign(new TypeError('The "allowBareNamedParameters" argument must be a boolean.'), {
                code: 'ERR_INVALID_ARG_TYPE',
            });
        }
        this.allowBareNamedParameters = enabled;
    }

    setAllowUnknownNamedParameters(enabled: boolean): void {
        if (typeof enabled !== 'boolean') {
            throw Object.assign(new TypeError('The "enabled" argument must be a boolean.'), {
                code: 'ERR_INVALID_ARG_TYPE',
            });
        }
        this.allowUnknownNamedParameters = enabled;
    }

    get expandedSQL(): string {
        return nativeCall(() => this.stmt.expand());
    }

    raw(): Sqlite3Stmt {
        return this.stmt;
    }

    finalize(): void {
        nativeCall(() => this.stmt.finalize());
    }

    private convertCell(value: unknown): unknown {
        if (typeof value === 'bigint') {
            if (this.readBigInts) return value;
            if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
                return Number(value);
            }
            throwOutOfRange(value);
        }
        return value;
    }

    private convertRow(row: SqliteRow): SqliteRow {
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
    private readonly dbPath: string;
    private readonly allowExtension: boolean;
    private extensionLoadingEnabled: boolean;
    private mainLocation: string | null = null;

    constructor(location: DatabaseLocation, options: DatabaseSyncOptions = {}) {
        this.dbPath = normalizeLocation(location);
        this.allowExtension = optionalBoolean(options, 'allowExtension');
        this.extensionLoadingEnabled = this.allowExtension;
        if (options.open === false) return;
        this.open(options.readOnly ? native.O_READONLY : DEFAULT_FLAGS);
        if (options.enableForeignKeyConstraints !== false) {
            this.exec('PRAGMA foreign_keys = ON');
        }
        if (options.timeout !== undefined) {
            nativeCall(() => this.raw().busyTimeout(options.timeout as number));
        }
    }

    get isOpen(): boolean {
        return this.handle !== null;
    }

    get isTransaction(): boolean {
        return nativeCall(() => this.raw().inTransaction());
    }

    /**
     * Path of an attached database file, or null when it has no backing file.
     * Node checks open state *before* the argument type, so keep that order.
     */
    location(...args: [dbName?: string]): string | null {
        if (!this.handle) {
            throw Object.assign(new Error('database is not open'), { code: 'ERR_INVALID_STATE' });
        }
        const dbName = args[0];
        if (dbName !== undefined && typeof dbName !== 'string') {
            throw Object.assign(new TypeError('The "dbName" argument must be a string.'), {
                code: 'ERR_INVALID_ARG_TYPE',
            });
        }
        // Only `main` is tracked. DIVERGENCE: after ATTACH, Node returns the
        // attached file's real path while this returns null — a wrong answer,
        // not just a missing one. Fixing it needs sqlite3_db_filename natively.
        return dbName === undefined || dbName === 'main' ? this.mainLocation : null;
    }

    open(flags = DEFAULT_FLAGS): void {
        if (this.handle) return;
        this.handle = nativeCall(() => native.open(this.dbPath, flags));
        // Captured at open time, like SQLite does: a later os.chdir must not
        // change what location() reports for an already-open database.
        this.mainLocation = resolveMainLocation(this.dbPath);
    }

    close(): void {
        // Node throws ERR_INVALID_STATE on a second close rather than no-oping.
        if (!this.handle) {
            throw Object.assign(new Error('database is not open'), { code: 'ERR_INVALID_STATE' });
        }
        const handle = this.handle;
        // Drop the reference first: a failed close must not leave a half-usable
        // database whose next call reopens the same failure.
        this.handle = null;
        nativeCall(() => handle.close());
    }

    exec(sql: string): void {
        nativeCall(() => this.raw().exec(sql));
    }

    prepare(sql: string): StatementSync {
        return new StatementSync(this, nativeCall(() => this.raw().prepare(sql)), sql);
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

        nativeCall(() => this.raw().createFunction(name, nArg, fn, nativeOpts));
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

        nativeCall(() => this.raw().createAggregate(name, nArg, {
            start: options.start,
            step: options.step as (...args: unknown[]) => unknown,
            result: typeof options.result === 'function' ? options.result : undefined,
            inverse: options.inverse as ((...args: unknown[]) => unknown) | undefined,
            deterministic: !!options.deterministic,
            directOnly,
            useBigIntArguments,
        }));
    }

    createSession(): void {
        unsupported('DatabaseSync.createSession');
    }

    applyChangeset(): void {
        unsupported('DatabaseSync.applyChangeset');
    }

    enableLoadExtension(allow: boolean): void {
        if (typeof allow !== 'boolean') {
            throw Object.assign(new TypeError('The "allow" argument must be a boolean.'), {
                code: 'ERR_INVALID_ARG_TYPE',
            });
        }
        this.raw();
        if (allow && !this.allowExtension) {
            throw Object.assign(new Error('Cannot enable extension loading because it was disabled at database creation.'), {
                code: 'ERR_INVALID_STATE',
            });
        }
        this.extensionLoadingEnabled = allow;
    }

    loadExtension(path: string, entryPoint?: string): void {
        const handle = this.raw();
        if (!this.extensionLoadingEnabled) {
            throw Object.assign(new Error('extension loading is not allowed'), { code: 'ERR_INVALID_STATE' });
        }
        if (typeof handle.loadExtension !== 'function') {
            throw Object.assign(new Error('SQLite extension loading is not available in this runtime build'), {
                code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
            });
        }
        nativeCall(() => handle.loadExtension(path, entryPoint));
    }

    raw(): Sqlite3Handle {
        // Node's message is lowercase and carries ERR_INVALID_STATE; callers
        // branch on the code, so a bare Error breaks parity.
        if (!this.handle) {
            throw Object.assign(new Error('database is not open'), { code: 'ERR_INVALID_STATE' });
        }
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
        const pages = nativeCall(() => sourceDb.raw().backupTo(destPath, sourceName, destName));
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
