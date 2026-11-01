/**
 * The supported `bun:sqlite` adapter.
 *
 * Bun's SQLite API is close to the native binding used by `node:sqlite`, but
 * it has different binding, integer, transaction, and close semantics.  Keep
 * those differences here instead of making the Node adapter serve two APIs.
 */

const native = import.meta.use('sqlite3');

type Sqlite3Handle = CModuleSQLite3.Sqlite3Handle;
type Sqlite3Stmt = CModuleSQLite3.Sqlite3Stmt;
type SqliteRow = Record<string, unknown> | unknown[];
type BindingRecord = Record<string, unknown>;
type NativeParams = CModuleSQLite3.SqliteParams;

export type SQLQueryBindings =
    | string
    | bigint
    | ArrayBufferView
    | ArrayBufferLike
    | number
    | boolean
    | null
    | BindingRecord;

export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    readwrite?: boolean;
    safeIntegers?: boolean;
    strict?: boolean;
}

export interface Changes {
    changes: number;
    lastInsertRowid: number | bigint;
}

export type RunResult = Changes;

const DEFAULT_QUERY_CACHE_SIZE = 20;
const SQLITE_INT64_MODULUS = 1n << 64n;
const SQLITE_INT64_SIGN = 1n << 63n;
const SQLITE_INT64_MIN = -SQLITE_INT64_SIGN;
const SQLITE_INT64_MAX = SQLITE_INT64_SIGN - 1n;

const SQLITE_ERROR_NAMES: Record<number, string> = {
    0: 'SQLITE_OK',
    1: 'SQLITE_ERROR',
    2: 'SQLITE_INTERNAL',
    3: 'SQLITE_PERM',
    4: 'SQLITE_ABORT',
    5: 'SQLITE_BUSY',
    6: 'SQLITE_LOCKED',
    7: 'SQLITE_NOMEM',
    8: 'SQLITE_READONLY',
    9: 'SQLITE_INTERRUPT',
    10: 'SQLITE_IOERR',
    11: 'SQLITE_CORRUPT',
    12: 'SQLITE_NOTFOUND',
    13: 'SQLITE_FULL',
    14: 'SQLITE_CANTOPEN',
    15: 'SQLITE_PROTOCOL',
    16: 'SQLITE_EMPTY',
    17: 'SQLITE_SCHEMA',
    18: 'SQLITE_TOOBIG',
    19: 'SQLITE_CONSTRAINT',
    20: 'SQLITE_MISMATCH',
    21: 'SQLITE_MISUSE',
    22: 'SQLITE_NOLFS',
    23: 'SQLITE_AUTH',
    24: 'SQLITE_FORMAT',
    25: 'SQLITE_RANGE',
    26: 'SQLITE_NOTADB',
    27: 'SQLITE_NOTICE',
    28: 'SQLITE_WARNING',
    100: 'SQLITE_ROW',
    101: 'SQLITE_DONE',

    // The extended codes most commonly observed by application code.
    257: 'SQLITE_ERROR_MISSING_COLLSEQ',
    261: 'SQLITE_BUSY_RECOVERY',
    517: 'SQLITE_BUSY_SNAPSHOT',
    773: 'SQLITE_BUSY_TIMEOUT',
    262: 'SQLITE_LOCKED_SHAREDCACHE',
    264: 'SQLITE_READONLY_RECOVERY',
    270: 'SQLITE_CANTOPEN_NOTEMPDIR',
    1299: 'SQLITE_CONSTRAINT_NOTNULL',
    1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    1811: 'SQLITE_CONSTRAINT_TRIGGER',
    2067: 'SQLITE_CONSTRAINT_UNIQUE',
    2579: 'SQLITE_CONSTRAINT_ROWID',
    275: 'SQLITE_CONSTRAINT_CHECK',
    787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
};

/** Bun's public SQLite error shape, including the native extended errno. */
export class SQLiteError extends Error {
    readonly name = 'SQLiteError' as const;
    readonly errno: number;
    readonly code?: string;
    readonly byteOffset = -1;

    constructor(message: string, errno = 0, code?: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.errno = errno;
        this.code = code ?? SQLITE_ERROR_NAMES[errno];
    }
}

function sqliteCode(errno: number): string | undefined {
    return SQLITE_ERROR_NAMES[errno] ?? SQLITE_ERROR_NAMES[errno & 0xff];
}

function toSQLiteError(error: unknown): unknown {
    if (error instanceof SQLiteError || !(error instanceof Error)) return error;
    const errno = (error as { errno?: unknown }).errno;
    if (typeof errno !== 'number') return error;

    const converted = new SQLiteError(error.message, errno, sqliteCode(errno));
    converted.stack = error.stack;
    return converted;
}

function nativeCall<T>(fn: () => T): T {
    try {
        return fn();
    } catch (error) {
        throw toSQLiteError(error);
    }
}

function closedError(): SQLiteError {
    return new SQLiteError('Database has closed', 0, 'ERR_SQLITE_CONNECTION_CLOSED');
}

function finalizedError(databaseClosed: boolean): Error {
    return new Error(databaseClosed ? 'Database has closed' : 'Statement has finalized');
}

function unsupported(name: string): never {
    throw new Error(`bun:sqlite ${name} is not implemented by this runtime`);
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
    return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value);
}

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true;
    return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
}

function asBlob(value: unknown): Uint8Array | undefined {
    if (isArrayBufferView(value)) {
        const view = value as ArrayBufferView & { byteOffset: number; byteLength: number; buffer: ArrayBufferLike };
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (isArrayBufferLike(value)) return new Uint8Array(value);
    return undefined;
}

function isBindingRecord(value: unknown): value is BindingRecord {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (asBlob(value)) return false;
    return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeBigInt(value: bigint, safeIntegers: boolean): bigint {
    if (value >= SQLITE_INT64_MIN && value <= SQLITE_INT64_MAX) return value;
    if (safeIntegers) {
        throw new RangeError('BigInt value is out of range for SQLite int64');
    }

    // Bun keeps the low 64 bits when safeIntegers is disabled.
    let wrapped = value % SQLITE_INT64_MODULUS;
    if (wrapped < 0n) wrapped += SQLITE_INT64_MODULUS;
    if (wrapped >= SQLITE_INT64_SIGN) wrapped -= SQLITE_INT64_MODULUS;
    return wrapped;
}

function normalizeBindingValue(value: unknown, safeIntegers: boolean): unknown {
    if (typeof value === 'bigint') return normalizeBigInt(value, safeIntegers);
    const blob = asBlob(value);
    if (blob) return blob;
    if (value !== null && typeof value === 'object' && !isBindingRecord(value)) {
        throw new TypeError('SQLite bindings must be primitive values, binary data, or a named object');
    }
    return value;
}

function hasOwn(object: BindingRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function isNameChar(value: string | undefined): boolean {
    return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

interface SqlParameterInfo {
    named: Set<string>;
    maxIndex: number;
    hasPositional: boolean;
    positional: number[];
}

/** Scan enough SQLite syntax to make Bun's strict/named binding deterministic. */
function scanParameters(sql: string): SqlParameterInfo {
    const named = new Set<string>();
    const indexes = new Map<string, number>();
    let nextIndex = 0;
    let maxIndex = 0;
    let hasPositional = false;
    const positional: number[] = [];

    const addParameter = (name: string | undefined, explicitIndex?: number) => {
        if (explicitIndex !== undefined) {
            maxIndex = Math.max(maxIndex, explicitIndex);
            nextIndex = Math.max(nextIndex, explicitIndex);
            hasPositional = true;
            positional.push(explicitIndex);
            return;
        }
        if (name !== undefined) {
            named.add(name);
            const existing = indexes.get(name);
            if (existing !== undefined) return;
            nextIndex++;
            indexes.set(name, nextIndex);
            maxIndex = Math.max(maxIndex, nextIndex);
            return;
        }
        nextIndex++;
        maxIndex = Math.max(maxIndex, nextIndex);
        hasPositional = true;
        positional.push(nextIndex);
    };

    for (let index = 0; index < sql.length; index++) {
        const current = sql[index];
        const next = sql[index + 1];

        if (current === '-' && next === '-') {
            const end = sql.indexOf('\n', index + 2);
            index = end < 0 ? sql.length : end;
            continue;
        }
        if (current === '/' && next === '*') {
            const end = sql.indexOf('*/', index + 2);
            index = end < 0 ? sql.length : end + 1;
            continue;
        }
        if (current === '\'' || current === '"' || current === '`') {
            for (index++; index < sql.length; index++) {
                if (sql[index] !== current) continue;
                if (sql[index + 1] === current) index++;
                else break;
            }
            continue;
        }
        if (current === '[') {
            const end = sql.indexOf(']', index + 1);
            index = end < 0 ? sql.length : end;
            continue;
        }

        if (current === '?') {
            let end = index + 1;
            while (/[0-9]/.test(sql[end] ?? '')) end++;
            if (end > index + 1) {
                addParameter(undefined, Number(sql.slice(index + 1, end)));
                index = end - 1;
            } else {
                addParameter(undefined);
            }
            continue;
        }

        if (current === ':' || current === '@' || current === '$') {
            if (!isNameChar(next)) continue;
            let end = index + 2;
            while (isNameChar(sql[end])) end++;
            const name = sql.slice(index, end);
            addParameter(name);
            index = end - 1;
        }
    }

    return { named, maxIndex, hasPositional, positional };
}

function stripSqlCommentsAndWhitespace(sql: string): string {
    // Whitespace may separate consecutive comments, so it belongs to the
    // repeated group rather than only preceding it.
    return sql
        .replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '')
        .trim();
}

/** Split multi-statement SQL while keeping a CREATE TRIGGER body together. */
function splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let start = 0;
    let quote: string | undefined;
    let prefixState: 'start' | 'create' | 'create-temp' | 'other' = 'start';
    let trigger = false;
    let triggerBody = false;
    let triggerBodyStatementStart = false;
    let triggerEnd = false;

    const resetStatement = () => {
        prefixState = 'start';
        trigger = false;
        triggerBody = false;
        triggerBodyStatementStart = false;
        triggerEnd = false;
    };

    const visitWord = (word: string) => {
        if (trigger) {
            if (!triggerBody) {
                if (word === 'BEGIN') {
                    triggerBody = true;
                    triggerBodyStatementStart = true;
                }
            } else if (triggerBodyStatementStart) {
                // Trigger bodies only allow update, insert, delete, and select
                // statements. END at this boundary is therefore the delimiter,
                // while END inside a CASE expression is part of that statement.
                triggerEnd = word === 'END';
                triggerBodyStatementStart = false;
            }
            return;
        }

        if (prefixState === 'start') {
            prefixState = word === 'CREATE' ? 'create' : 'other';
        } else if (prefixState === 'create') {
            if (word === 'TRIGGER') trigger = true;
            else prefixState = word === 'TEMP' || word === 'TEMPORARY' ? 'create-temp' : 'other';
        } else if (prefixState === 'create-temp') {
            if (word === 'TRIGGER') trigger = true;
            else prefixState = 'other';
        }
    };

    for (let index = 0; index < sql.length; index++) {
        const current = sql[index];
        const next = sql[index + 1];

        if (quote !== undefined) {
            if (current === quote) {
                if (next === quote) index++;
                else quote = undefined;
            }
            continue;
        }
        if (current === '\'' || current === '"' || current === '`') {
            quote = current;
            continue;
        }
        if (current === '[') {
            const end = sql.indexOf(']', index + 1);
            if (end >= 0) index = end;
            continue;
        }
        if (current === '-' && next === '-') {
            const end = sql.indexOf('\n', index + 2);
            index = end < 0 ? sql.length : end;
            continue;
        }
        if (current === '/' && next === '*') {
            const end = sql.indexOf('*/', index + 2);
            index = end < 0 ? sql.length : end + 1;
            continue;
        }

        if (/[A-Za-z_]/.test(current)) {
            let end = index + 1;
            while (/[A-Za-z0-9_$]/.test(sql[end] ?? '')) end++;
            visitWord(sql.slice(index, end).toUpperCase());
            index = end - 1;
            continue;
        }
        if (current !== ';') continue;

        if (triggerBody && !triggerEnd) {
            triggerBodyStatementStart = true;
            continue;
        }

        const statement = sql.slice(start, index);
        if (stripSqlCommentsAndWhitespace(statement) !== '') statements.push(statement);
        start = index + 1;
        resetStatement();
    }

    const last = sql.slice(start);
    if (stripSqlCommentsAndWhitespace(last) !== '') statements.push(last);
    return statements;
}

function firstStatement(sql: string): string {
    return splitStatements(sql)[0] ?? sql;
}

function invocationParams(args: unknown[]): { provided: boolean; params?: unknown[] | BindingRecord } {
    if (args.length === 0) return { provided: false };
    if (args.length === 1) {
        const value = args[0];
        if (Array.isArray(value)) return { provided: true, params: value };
        if (isBindingRecord(value)) return { provided: true, params: value };
    }
    return { provided: true, params: args };
}

function normalizeNamedBindings(
    sql: string,
    record: BindingRecord,
    strict: boolean,
    safeIntegers: boolean,
): BindingRecord {
    const info = scanParameters(firstStatement(sql));
    const result: BindingRecord = {};

    if (strict && info.hasPositional) {
        const position = info.positional[0] ?? 1;
        throw new TypeError(`Missing parameter "?${position}"`);
    }

    for (const name of info.named) {
        const bare = name.slice(1);
        const hasBare = hasOwn(record, bare);
        const hasPrefixed = hasOwn(record, name);
        // Bun gives the unprefixed spelling precedence in strict mode and the
        // exact prefixed spelling precedence in non-strict mode.
        const selected = strict
            ? (hasBare ? bare : hasPrefixed ? name : undefined)
            : (hasPrefixed ? name : hasBare ? bare : undefined);

        if (selected === undefined) {
            if (strict) throw new TypeError(`Missing parameter "${bare}"`);
            continue;
        }

        result[name] = normalizeBindingValue(record[selected], safeIntegers);
        // Both spellings are aliases for the same SQLite parameter.  Unknown
        // object keys are ignored by Bun, including in strict mode; strictness
        // only changes whether each SQL parameter must have a value.
    }

    return result;
}

function normalizeParams(
    sql: string,
    params: unknown[] | BindingRecord,
    strict: boolean,
    safeIntegers: boolean,
): unknown[] | BindingRecord {
    if (isBindingRecord(params)) return normalizeNamedBindings(sql, params, strict, safeIntegers);

    const values = params as unknown[];
    const info = scanParameters(firstStatement(sql));
    if (values.length !== 0 && values.length !== info.maxIndex) {
        throw new TypeError(`SQLite query expected ${info.maxIndex} values, received ${values.length}`);
    }
    return values.map(value => normalizeBindingValue(value, safeIntegers));
}

function convertInteger(value: unknown, safeIntegers: boolean): unknown {
    if (typeof value !== 'bigint') return value;
    return safeIntegers ? value : Number(value);
}

function plainRow(row: SqliteRow, safeIntegers: boolean, rowPrototype?: object): unknown {
    if (Array.isArray(row)) return row.map(value => convertInteger(value, safeIntegers));
    if (!row || typeof row !== 'object') return row;

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
        Object.defineProperty(result, key, {
            value: convertInteger(row[key], safeIntegers),
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }
    if (rowPrototype) Object.setPrototypeOf(result, rowPrototype);
    return result;
}

function integerResult(value: number | bigint, safeIntegers: boolean): number | bigint {
    return safeIntegers ? value : typeof value === 'bigint' ? Number(value) : value;
}

export interface StatementOptions {
    safeIntegers?: boolean;
}

type StatementConstructor<T> = new (...args: any[]) => T;

/** A Bun prepared statement backed by circu.js' native SQLite statement. */
export class Statement<ReturnType = unknown> {
    private finalized = false;
    private finalizedByDatabase = false;
    private rowPrototype: object | undefined;
    private safeIntegerMode: boolean;

    constructor(
        private readonly database: Database,
        private readonly statement: Sqlite3Stmt,
        readonly sourceSQL: string,
        private readonly closeWithDatabase: boolean,
    ) {
        this.safeIntegerMode = database.safeIntegers;
        database._registerStatement(this);
    }

    get isFinalized(): boolean {
        return this.finalized;
    }

    get columnNames(): string[] {
        this.assertUsable();
        return nativeCall(() => this.statement.columnNames?.() ?? []);
    }

    get paramsCount(): number {
        this.assertUsable();
        return scanParameters(firstStatement(this.sourceSQL)).maxIndex;
    }

    get reader(): boolean {
        return this.columnNames.length > 0;
    }

    get readonly(): boolean {
        this.assertUsable();
        const sql = stripSqlCommentsAndWhitespace(firstStatement(this.sourceSQL)).toUpperCase();
        return /^(SELECT|VALUES|PRAGMA|EXPLAIN|WITH|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(sql);
    }

    get declaredTypes(): Array<string | null> {
        this.assertUsable();
        const metadata = this.statement.columnMetadata?.();
        if (metadata) return metadata.map(column => column.type ?? null);
        return this.columnNames.map(() => null);
    }

    get columnTypes(): Array<'INTEGER' | 'FLOAT' | 'TEXT' | 'BLOB' | 'NULL' | null> {
        return unsupported('Statement.columnTypes');
    }

    get native(): Sqlite3Stmt {
        this.assertUsable();
        return this.statement;
    }

    safeIntegers(): boolean;
    safeIntegers(enabled: boolean): this;
    safeIntegers(enabled?: boolean): boolean | this {
        if (enabled === undefined) return this.safeIntegerMode;
        if (typeof enabled !== 'boolean') throw new TypeError('safeIntegers must be a boolean');
        this.safeIntegerMode = enabled;
        this.assertUsable();
        nativeCall(() => this.statement.setReadBigInts(enabled));
        return this;
    }

    all(...args: unknown[]): ReturnType[] {
        const rows = this.execute(args, params => (
            params === undefined
                ? nativeCall(() => this.statement.all())
                : nativeCall(() => this.statement.all(params as NativeParams))
        ));
        return rows.map(row => plainRow(row, this.safeIntegerMode, this.rowPrototype) as ReturnType);
    }

    get(...args: unknown[]): ReturnType | null {
        return this.all(...args)[0] ?? null;
    }

    run(...args: unknown[]): Changes {
        this.execute(args, params => {
            nativeCall(() => {
                if (params === undefined) this.statement.run();
                else this.statement.run(params as NativeParams);
            });
            return [];
        });
        return this.database._statementResult(this.safeIntegerMode);
    }

    iterate(...args: unknown[]): IterableIterator<ReturnType> {
        const rows = this.all(...args);
        let index = 0;
        return {
            next: (): IteratorResult<ReturnType> => {
                if (index >= rows.length) return { done: true, value: undefined as never };
                return { done: false, value: rows[index++] as ReturnType };
            },
            [Symbol.iterator](): IterableIterator<ReturnType> {
                return this;
            },
        };
    }

    [Symbol.iterator](): IterableIterator<ReturnType> {
        return this.iterate();
    }

    values(...args: unknown[]): unknown[][] {
        return this.all(...args).map(row => {
            if (Array.isArray(row)) return row as unknown[];
            return Object.keys(row as object).map(key => (row as Record<string, unknown>)[key]);
        });
    }

    raw(..._args: unknown[]): Array<Array<Uint8Array | null>> {
        unsupported('Statement.raw');
    }

    as<T>(Class: StatementConstructor<T>): Statement<T> {
        if (typeof Class !== 'function' || !Class.prototype) {
            throw new TypeError('Statement.as expects a class or constructor');
        }
        this.rowPrototype = Class.prototype;
        return this as unknown as Statement<T>;
    }

    toString(): string {
        if (this.finalized) return '';
        return nativeCall(() => this.statement.expand());
    }

    toJSON(): { sql: string; isFinalized: boolean; paramsCount: number; columnNames: string[] } {
        this.assertUsable();
        return {
            sql: this.toString(),
            isFinalized: this.finalized,
            paramsCount: this.finalized ? 0 : this.paramsCount,
            columnNames: this.finalized ? [] : this.columnNames,
        };
    }

    finalize(): void {
        this.finalizeInternal(false);
    }

    private finalizeInternal(fromDatabase: boolean): void {
        if (this.finalized) return;
        this.finalizedByDatabase = fromDatabase;
        this.finalized = true;
        try {
            nativeCall(() => this.statement.finalize());
        } finally {
            this.database._statementFinalized(this, this.closeWithDatabase);
        }
    }

    [Symbol.dispose](): void {
        this.finalize();
    }

    /** @internal */
    _runWithArgs(args: unknown[]): Changes {
        return this.run(...args);
    }

    /** @internal */
    _finalizeFromDatabase(): void {
        this.finalizeInternal(true);
    }

    /** @internal */
    _closesWithDatabase(): boolean {
        return this.closeWithDatabase;
    }

    private assertUsable(): void {
        if (this.finalized) throw finalizedError(this.finalizedByDatabase);
    }

    private execute<T>(args: unknown[], operation: (params: unknown[] | BindingRecord | undefined) => T): T {
        this.assertUsable();
        const invocation = invocationParams(args);
        if (!invocation.provided) {
            return operation(undefined);
        }

        const params = normalizeParams(
            this.sourceSQL,
            invocation.params!,
            this.database.strict,
            this.safeIntegerMode,
        );
        return operation(params);
    }

    /** @internal */
    _bindInitial(params: unknown): void {
        this.execute([params], normalized => {
            nativeCall(() => this.statement.bind(normalized as NativeParams));
        });
    }
}

export class Database {
    static MAX_QUERY_CACHE_SIZE = DEFAULT_QUERY_CACHE_SIZE;

    readonly filename: string;
    readonly handle: number;
    readonly safeIntegers: boolean;
    readonly strict: boolean;

    private nativeHandle: Sqlite3Handle | null;
    private closed = false;
    private readonly statements = new Set<Statement>();
    private readonly queryCache = new Map<string, Statement>();
    private transactionSerial = 0;

    constructor(filename?: string, options: number | DatabaseOptions = {}) {
        if (filename !== undefined && typeof filename !== 'string') {
            throw new TypeError('Database filename must be a string');
        }
        this.filename = filename ?? ':memory:';
        this.handle = nextDatabaseHandle++;

        let flags: number;
        if (typeof options === 'number') {
            if (!Number.isInteger(options)) throw new TypeError('Database flags must be an integer');
            flags = options;
            this.safeIntegers = false;
            this.strict = false;
        } else {
            const parsed = parseOptions(options);
            flags = parsed.flags;
            this.safeIntegers = parsed.safeIntegers;
            this.strict = parsed.strict;
        }

        this.nativeHandle = nativeCall(() => native.open(this.filename, flags));
    }

    static open(filename?: string, options: number | DatabaseOptions = {}): Database {
        return new Database(filename, options);
    }

    get inTransaction(): boolean {
        return nativeCall(() => this.requireOpen().inTransaction());
    }

    run(sql: string, ...bindings: unknown[]): Changes {
        return this.executeSql(sql, bindings);
    }

    exec(sql: string, ...bindings: unknown[]): Changes {
        return this.run(sql, ...bindings);
    }

    query<ReturnType = unknown>(sql: string): Statement<ReturnType> {
        this.requireOpen();
        if (typeof sql !== 'string') throw new TypeError(`Expected 'query' to be a string, got '${typeof sql}'`);
        if (sql.length === 0) throw new Error('SQL query cannot be empty.');
        const cached = this.queryCache.get(sql);
        if (cached && !cached.isFinalized) {
            this.queryCache.delete(sql);
            this.queryCache.set(sql, cached);
            return cached as Statement<ReturnType>;
        }

        const statement = this.prepareInternal<ReturnType>(sql, true);
        if (sql.length <= 64 * 1024 && Database.MAX_QUERY_CACHE_SIZE > 0) {
            this.queryCache.set(sql, statement);
            this.evictQueryCache();
        }
        return statement;
    }

    prepare<ReturnType = unknown>(sql: string, params?: unknown): Statement<ReturnType> {
        this.requireOpen();
        const statement = this.prepareInternal<ReturnType>(sql, false);
        if (params !== undefined) {
            try {
                statement._bindInitial(params);
            } catch (error) {
                statement.finalize();
                throw error;
            }
        }
        return statement;
    }

    clearQueryCache(): void {
        const cached = [...this.queryCache.values()];
        this.queryCache.clear();
        let firstError: unknown;
        for (const statement of cached) {
            try {
                statement._finalizeFromDatabase();
            } catch (error) {
                firstError ??= error;
            }
        }
        if (firstError !== undefined) throw firstError;
    }

    close(throwOnError = false): void {
        if (typeof throwOnError !== 'boolean') throw new TypeError('throwOnError must be a boolean');

        this.closed = true;
        let firstError: unknown;
        try {
            this.clearQueryCache();
        } catch (error) {
            firstError = error;
        }

        for (const statement of [...this.statements]) {
            if (throwOnError || statement._closesWithDatabase()) {
                try {
                    statement._finalizeFromDatabase();
                } catch (error) {
                    firstError ??= error;
                }
            }
        }

        try {
            this.closeNativeIfReady();
        } catch (error) {
            firstError ??= error;
        }

        if (firstError !== undefined) throw firstError;
    }

    transaction<T extends (...args: any[]) => any>(insideTransaction: T): Transaction<T> {
        if (typeof insideTransaction !== 'function') {
            throw new TypeError('transaction expects a function');
        }

        const execute = (mode: '' | 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE', args: any[]): any => {
            const nested = this.inTransaction;
            const savepoint = nested ? `cno_bun_transaction_${++this.transactionSerial}` : '';
            this.run(nested ? `SAVEPOINT ${savepoint}` : mode === '' ? 'BEGIN' : `BEGIN ${mode}`);
            try {
                const result = Reflect.apply(insideTransaction, undefined, args);
                this.run(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
                return result;
            } catch (error) {
                try {
                    if (nested) {
                        this.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                        this.run(`RELEASE SAVEPOINT ${savepoint}`);
                    } else {
                        this.run('ROLLBACK');
                    }
                } catch {
                    // Preserve the callback or commit error; rollback cannot
                    // make the original failure more actionable.
                }
                throw error;
            }
        };

        const wrapped = ((...args: any[]) => execute('', args)) as Transaction<T>;
        wrapped.deferred = ((...args: any[]) => execute('DEFERRED', args)) as T;
        wrapped.immediate = ((...args: any[]) => execute('IMMEDIATE', args)) as T;
        wrapped.exclusive = ((...args: any[]) => execute('EXCLUSIVE', args)) as T;
        return wrapped;
    }

    loadExtension(extension: string, entryPoint?: string): void {
        if (typeof extension !== 'string') throw new TypeError('extension must be a string');
        const handle = this.requireOpen() as Sqlite3Handle & {
            loadExtension?: (file: string, proc?: string) => void;
        };
        if (typeof handle.loadExtension !== 'function') {
            throw new Error('SQLite extension loading is not available in this runtime build');
        }
        nativeCall(() => handle.loadExtension!(extension, entryPoint));
    }

    function(
        name: string,
        optionsOrFunction: Record<string, unknown> | ((...args: unknown[]) => unknown),
        maybeFunction?: (...args: unknown[]) => unknown,
    ): this {
        if (typeof name !== 'string' || name.length === 0) throw new TypeError('function name must be non-empty');
        const fn = typeof optionsOrFunction === 'function' ? optionsOrFunction : maybeFunction;
        if (typeof fn !== 'function') throw new TypeError('function callback must be a function');
        const options = typeof optionsOrFunction === 'function' ? {} : optionsOrFunction;
        const varargs = options.varargs === true;
        nativeCall(() => this.requireOpen().createFunction(name, varargs ? -1 : fn.length, fn, {
            deterministic: options.deterministic === true,
            directOnly: options.directOnly === true,
            useBigIntArguments: this.safeIntegers,
        }));
        return this;
    }

    aggregate(name: string, options: Record<string, unknown>): this {
        if (typeof name !== 'string' || name.length === 0) throw new TypeError('aggregate name must be non-empty');
        if (!options || typeof options !== 'object' || typeof options.step !== 'function') {
            throw new TypeError('aggregate options.step must be a function');
        }
        const step = options.step as (...args: unknown[]) => unknown;
        nativeCall(() => this.requireOpen().createAggregate(name, options.varargs === true ? -1 : Math.max(0, step.length - 1), {
            start: options.start === undefined ? null : options.start,
            step,
            result: typeof options.result === 'function' ? options.result as (...args: unknown[]) => unknown : undefined,
            inverse: typeof options.inverse === 'function' ? options.inverse as (...args: unknown[]) => unknown : undefined,
            deterministic: options.deterministic === true,
            directOnly: options.directOnly === true,
            useBigIntArguments: this.safeIntegers,
        }));
        return this;
    }

    [Symbol.dispose](): void {
        this.close(true);
    }

    /** @internal */
    _registerStatement(statement: Statement): void {
        this.statements.add(statement);
    }

    /** @internal */
    _statementFinalized(statement: Statement, closeWithDatabase: boolean): void {
        this.statements.delete(statement);
        if (closeWithDatabase) {
            for (const [sql, cached] of this.queryCache) {
                if (cached === statement) this.queryCache.delete(sql);
            }
        }
        if (this.closed) this.closeNativeIfReady();
    }

    /** @internal */
    _statementResult(safeIntegers: boolean): Changes {
        const handle = this.nativeHandle;
        if (!handle) throw closedError();
        return {
            changes: nativeCall(() => handle.changes()),
            lastInsertRowid: integerResult(nativeCall(() => handle.lastInsertRowid(safeIntegers)), safeIntegers),
        };
    }

    private requireOpen(): Sqlite3Handle {
        if (this.closed || !this.nativeHandle) throw closedError();
        return this.nativeHandle;
    }

    private prepareInternal<ReturnType>(sql: string, closeWithDatabase: boolean): Statement<ReturnType> {
        if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
        const statement = nativeCall(() => this.requireOpen().prepare(sql));
        let wrapped: Statement<ReturnType> | undefined;
        try {
            // sqlite3_prepare_v2 succeeds with a null sqlite3_stmt for blank or
            // comment-only input. Reject it before wrapping so it never enters
            // the database's outstanding-statement set.
            if (nativeCall(() => statement.expand()) === '') {
                throw new RangeError('Invalid SQL statement');
            }
            nativeCall(() => statement.setReadBigInts(this.safeIntegers));
            wrapped = new Statement<ReturnType>(this, statement, sql, closeWithDatabase);
            return wrapped;
        } catch (error) {
            if (!wrapped) {
                try {
                    nativeCall(() => statement.finalize());
                } catch {
                    // Preserve the prepare/validation error.
                }
            }
            throw error;
        }
    }

    private executeSql(sql: string, bindings: unknown[]): Changes {
        if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
        this.requireOpen();
        const statements = splitStatements(sql);
        if (statements.length === 0) {
            if (sql.length === 0) throw new Error("SQL string mustn't be blank");
            throw new Error('Query contained no valid SQL statement; likely empty query.');
        }

        let changes = 0;
        let lastInsertRowid: number | bigint = this.safeIntegers ? 0n : 0;
        for (let index = 0; index < statements.length; index++) {
            const statement = this.prepareInternal(statements[index], false);
            try {
                const result = statement._runWithArgs(index === 0 ? bindings : []);
                changes += result.changes;
                lastInsertRowid = result.lastInsertRowid;
            } finally {
                statement.finalize();
            }
        }
        return { changes, lastInsertRowid };
    }

    private evictQueryCache(): void {
        const limit = Number.isInteger(Database.MAX_QUERY_CACHE_SIZE) && Database.MAX_QUERY_CACHE_SIZE >= 0
            ? Database.MAX_QUERY_CACHE_SIZE
            : DEFAULT_QUERY_CACHE_SIZE;
        while (this.queryCache.size > limit) {
            const oldest = this.queryCache.keys().next().value as string | undefined;
            if (oldest === undefined) return;
            this.queryCache.delete(oldest);
            // Eviction drops the cache's reference, but the statement remains
            // live if user code retained it. Database.close() still owns every
            // query statement through the outstanding-statement set.
        }
    }

    private closeNativeIfReady(): void {
        if (!this.closed || this.statements.size !== 0 || !this.nativeHandle) return;
        const handle = this.nativeHandle;
        nativeCall(() => handle.close());
        this.nativeHandle = null;
    }
}

export interface Transaction<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): ReturnType<T>;
    deferred: T;
    immediate: T;
    exclusive: T;
}

interface ParsedOptions {
    flags: number;
    safeIntegers: boolean;
    strict: boolean;
}

function parseOptions(options: DatabaseOptions): ParsedOptions {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Database options must be an object');
    }

    const booleanOption = (name: keyof DatabaseOptions, fallback: boolean): boolean => {
        const value = options[name];
        if (value === undefined) return fallback;
        if (typeof value !== 'boolean') throw new TypeError(`Database option '${name}' must be a boolean`);
        return value;
    };

    const readonly = booleanOption('readonly', false);
    const readwrite = booleanOption('readwrite', !readonly);
    const effectiveReadonly = readonly || !readwrite;
    const create = booleanOption('create', !effectiveReadonly);
    if (effectiveReadonly && (create || (readonly && readwrite))) {
        throw new TypeError(
            'A read-only database ("readonly: true" or "readwrite: false") cannot have "create: true" or "readwrite: true"',
        );
    }

    const flags = effectiveReadonly
        ? native.O_READONLY
        : native.O_READWRITE | (create ? native.O_CREATE : 0);
    return {
        flags,
        safeIntegers: booleanOption('safeIntegers', false),
        strict: booleanOption('strict', false),
    };
}

let nextDatabaseHandle = 1;

export const constants = {
    SQLITE_OPEN_READONLY: native.O_READONLY,
    SQLITE_OPEN_READWRITE: native.O_READWRITE,
    SQLITE_OPEN_CREATE: native.O_CREATE,
    SQLITE_OPEN_URI: native.O_URI ?? native.O_URL,
    SQLITE_OPEN_MEMORY: native.O_MEMORY,
    SQLITE_OPEN_NOMUTEX: native.O_NOMUTEX,
    SQLITE_OPEN_FULLMUTEX: native.O_FULLMUTEX,
    SQLITE_OPEN_SHAREDCACHE: native.O_SHAREDCACHE,
    SQLITE_OPEN_PRIVATECACHE: native.O_PRIVATECACHE,
    SQLITE_OPEN_NOFOLLOW: native.O_NOFOLLOW,
};

export default Database;
