/**
 * Node.js sqlite3 module.
 *
 * This provides the node-sqlite3 callback API on top of circu.js' native
 * synchronous SQLite handle. Operations complete on a microtask to match the
 * callback shape without pretending there is a worker-backed async queue.
 */

import { EventEmitter } from '../events';

const native = import.meta.use('sqlite3');
const engine = import.meta.use('engine');

type Sqlite3Handle = CModuleSQLite3.Sqlite3Handle;
type Sqlite3Stmt = CModuleSQLite3.Sqlite3Stmt;
type SqliteRow = Record<string, unknown> | unknown[];
type BindParams = unknown[] | Record<string, unknown>;
type Callback = (...args: unknown[]) => void;
type RowCallback = (err: unknown, row?: SqliteRow) => void;
type CompleteCallback = (err: unknown, count?: number) => void;
type QueryMethod = 'run' | 'get' | 'all' | 'each' | 'map';

export type { Sqlite3Handle, Sqlite3Stmt };

export const O_CREATE = native.O_CREATE;
export const O_READONLY = native.O_READONLY;
export const O_READWRITE = native.O_READWRITE;
export const O_MEMORY = native.O_MEMORY;
export const O_URI = native.O_URI ?? native.O_URL;
export const O_URL = O_URI;
export const O_NOMUTEX = native.O_NOMUTEX;
export const O_FULLMUTEX = native.O_FULLMUTEX;
export const O_SHAREDCACHE = native.O_SHAREDCACHE;
export const O_PRIVATECACHE = native.O_PRIVATECACHE;
export const O_NOFOLLOW = native.O_NOFOLLOW;

export const OPEN_CREATE = O_CREATE;
export const OPEN_READONLY = O_READONLY;
export const OPEN_READWRITE = O_READWRITE;
export const OPEN_MEMORY = O_MEMORY;
export const OPEN_URI = O_URI;
export const OPEN_NOMUTEX = O_NOMUTEX;
export const OPEN_FULLMUTEX = O_FULLMUTEX;
export const OPEN_SHAREDCACHE = O_SHAREDCACHE;
export const OPEN_PRIVATECACHE = O_PRIVATECACHE;
export const OPEN_NOFOLLOW = O_NOFOLLOW;

export const VERSION = engine.versions?.sqlite3 ?? '';
export const SOURCE_ID = '';
export const VERSION_NUMBER = 0;

const DEFAULT_OPEN_FLAGS = OPEN_CREATE | OPEN_READWRITE;

export function open(filename: string, flags = DEFAULT_OPEN_FLAGS): Sqlite3Handle {
    return native.open(filename, flags);
}

function defer(fn: () => void): void {
    queueMicrotask(fn);
}

function call(callback: Callback | undefined, self: unknown, args: unknown[]): void {
    if (callback) defer(() => Reflect.apply(callback, self, args));
}

function emitOrThrow(target: EventEmitter, callback: Callback | undefined, self: unknown, err: unknown): void {
    if (callback) {
        call(callback, self, [err]);
        return;
    }
    target.emit('error', err instanceof Error ? err : new Error(String(err)));
}

function isBindObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function splitArgs(args: unknown[]): { params?: BindParams; callback?: Callback } {
    const values = args.slice();
    let callback: Callback | undefined;
    if (typeof values[values.length - 1] === 'function') {
        callback = values.pop();
    }
    if (values.length === 0) return { callback };
    if (values.length === 1) {
        const value = values[0];
        if (Array.isArray(value) || isBindObject(value)) return { params: value, callback };
        return { params: [value], callback };
    }
    return { params: values, callback };
}

function splitEachArgs(args: unknown[]): { params?: BindParams; rowCallback?: RowCallback; completeCallback?: CompleteCallback } {
    const values = args.slice();
    let completeCallback: CompleteCallback | undefined;
    let rowCallback: RowCallback | undefined;
    if (typeof values[values.length - 1] === 'function') {
        rowCallback = values.pop();
        if (typeof values[values.length - 1] === 'function') {
            completeCallback = rowCallback as CompleteCallback;
            rowCallback = values.pop();
        }
    }
    const { params } = splitArgs(values);
    return { params, rowCallback, completeCallback };
}

function normalizeBindParams(sql: string, params?: BindParams): BindParams | undefined {
    if (params === undefined || !isBindObject(params)) return params;
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (/^[:@$]/.test(key)) {
            normalized[key] = value;
        } else if (sql.includes(`:${key}`)) {
            normalized[`:${key}`] = value;
        } else if (sql.includes(`@${key}`)) {
            normalized[`@${key}`] = value;
        } else if (sql.includes(`$${key}`)) {
            normalized[`$${key}`] = value;
        } else {
            normalized[key] = value;
        }
    }
    return normalized;
}

function bindStmt(stmt: Sqlite3Stmt, params?: BindParams, sql = ''): void {
    params = normalizeBindParams(sql, params);
    if (params === undefined) {
        stmt.bind();
        return;
    }
    stmt.bind(params);
}

function runStmt(stmt: Sqlite3Stmt, params?: BindParams, sql = ''): void {
    params = normalizeBindParams(sql, params);
    if (params === undefined) stmt.run();
    else stmt.run(params);
}

function allStmt(stmt: Sqlite3Stmt, params?: BindParams, sql = ''): SqliteRow[] {
    params = normalizeBindParams(sql, params);
    return params === undefined ? stmt.all() : stmt.all(params);
}

function mapRows(rows: SqliteRow[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const row of rows) {
        const keys = Object.keys(row);
        if (keys.length === 0) continue;
        const key = String(row[keys[0]]);
        result[key] = keys.length === 2 ? row[keys[1]] : row;
    }
    return result;
}

export class Statement extends EventEmitter {
    lastID = 0;
    changes = 0;
    private stmt: Sqlite3Stmt | null;

    constructor(private readonly db: Database, stmt: Sqlite3Stmt | null, readonly sql = '', private readonly prepareError?: unknown) {
        super();
        this.stmt = stmt;
    }

    bind(...args: unknown[]): this {
        const { params, callback } = splitArgs(args);
        try {
            bindStmt(this.getStmt(), params, this.sql);
            call(callback, this, [null]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    reset(callback?: Callback): this {
        try {
            const stmt = this.getStmt();
            stmt.reset();
            call(callback, this, [null]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    finalize(callback?: Callback): this {
        try {
            if (this.stmt) {
                this.stmt.finalize();
                this.stmt = null;
            }
            call(callback, this, [null]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    run(...args: unknown[]): this {
        const { params, callback } = splitArgs(args);
        this.db.trace(this.sql);
        const started = Date.now();
        try {
            runStmt(this.getStmt(), params, this.sql);
            this.lastID = this.db.lastInsertRowid();
            this.changes = this.db.changesCount();
            this.db.profile(this.sql, Date.now() - started);
            call(callback, this, [null]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    get(...args: unknown[]): this {
        const { params, callback } = splitArgs(args);
        this.db.trace(this.sql);
        const started = Date.now();
        try {
            const row = allStmt(this.getStmt(), params, this.sql)[0];
            this.db.profile(this.sql, Date.now() - started);
            call(callback, this, [null, row]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    all(...args: unknown[]): this {
        const { params, callback } = splitArgs(args);
        this.db.trace(this.sql);
        const started = Date.now();
        try {
            const rows = allStmt(this.getStmt(), params, this.sql);
            this.db.profile(this.sql, Date.now() - started);
            call(callback, this, [null, rows]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    each(...args: unknown[]): this {
        const { params, rowCallback, completeCallback } = splitEachArgs(args);
        this.db.trace(this.sql);
        const started = Date.now();
        try {
            const rows = allStmt(this.getStmt(), params, this.sql);
            this.db.profile(this.sql, Date.now() - started);
            for (const row of rows) call(rowCallback, this, [null, row]);
            call(completeCallback, this, [null, rows.length]);
        } catch (err) {
            if (rowCallback) call(rowCallback, this, [err]);
            else this.emit('error', err instanceof Error ? err : new Error(String(err)));
            call(completeCallback, this, [err]);
        }
        return this;
    }

    map(...args: unknown[]): this {
        const { params, callback } = splitArgs(args);
        this.db.trace(this.sql);
        const started = Date.now();
        try {
            const rows = allStmt(this.getStmt(), params, this.sql);
            this.db.profile(this.sql, Date.now() - started);
            call(callback, this, [null, mapRows(rows)]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    expand(): string {
        return this.getStmt().expand();
    }

    raw(): Sqlite3Stmt {
        return this.getStmt();
    }

    private getStmt(): Sqlite3Stmt {
        if (this.prepareError) {
            throw this.prepareError;
        }
        if (!this.stmt) throw new Error('Statement has been finalized');
        return this.stmt;
    }
}

export class Database extends EventEmitter {
    private handle: Sqlite3Handle | null = null;
    private traceCallback: ((sql: string) => void) | null = null;
    private profileCallback: ((sql: string, ms: number) => void) | null = null;

    constructor(filename: string, mode?: number | Callback, callback?: Callback) {
        super();
        const flags = typeof mode === 'number' ? mode : DEFAULT_OPEN_FLAGS;
        const cb = typeof mode === 'function' ? mode : callback;
        try {
            this.handle = open(filename, flags);
            call(cb, this, [null]);
            defer(() => this.emit('open'));
        } catch (err) {
            emitOrThrow(this, cb, this, err);
        }
    }

    close(callback?: Callback): this {
        try {
            if (this.handle) {
                this.handle.close();
                this.handle = null;
            }
            call(callback, this, [null]);
            defer(() => this.emit('close'));
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    configure(option: string, value: unknown): this {
        switch (option) {
            case 'trace':
                this.traceCallback = typeof value === 'function' ? value : null;
                return this;
            case 'profile':
                this.profileCallback = typeof value === 'function' ? value : null;
                return this;
            case 'busyTimeout':
                this.getHandle().busyTimeout(Number(value));
                return this;
            default:
                throw new Error(`Unsupported sqlite3 configure option: ${option}`);
        }
    }

    run(sql: string, ...args: unknown[]): this {
        return this._query('run', sql, args);
    }

    get(sql: string, ...args: unknown[]): this {
        return this._query('get', sql, args);
    }

    all(sql: string, ...args: unknown[]): this {
        return this._query('all', sql, args);
    }

    each(sql: string, ...args: unknown[]): this {
        const statement = this.prepare(sql);
        const values = args.slice();
        let wrapped = false;
        if (typeof values[values.length - 1] === 'function' && typeof values[values.length - 2] === 'function') {
            const completeCallback = values.pop() as CompleteCallback;
            values.push(function(this: unknown, ...cbArgs: unknown[]) {
                try { Reflect.apply(completeCallback, this, cbArgs); }
                finally { statement.finalize(); }
            });
            wrapped = true;
        }
        try {
            statement.each(...values);
            if (!wrapped) defer(() => statement.finalize());
        } catch (err) {
            statement.finalize();
            throw err;
        }
        return this;
    }

    exec(sql: string, callback?: Callback): this {
        this.trace(sql);
        const started = Date.now();
        try {
            this.getHandle().exec(sql);
            this.profile(sql, Date.now() - started);
            call(callback, this, [null]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    prepare(sql: string, ...args: unknown[]): Statement {
        const { params, callback } = splitArgs(args);
        try {
            const statement = new Statement(this, this.getHandle().prepare(sql), sql);
            if (params !== undefined) statement.bind(params);
            call(callback, statement, [null]);
            return statement;
        } catch (err) {
            if (callback) {
                call(callback, this, [err]);
                return new Statement(this, null, sql, err);
            }
            throw err;
        }
    }

    map(sql: string, ...args: unknown[]): this {
        return this._query('map', sql, args);
    }

    loadExtension(file: string, callback?: Callback): this {
        try {
            this.getHandle().loadExtension(file);
            call(callback, this, [null]);
        } catch (err) {
            emitOrThrow(this, callback, this, err);
        }
        return this;
    }

    interrupt(): void {
        this.getHandle().interrupt();
    }

    serialize(callback?: () => void): this {
        callback?.();
        return this;
    }

    parallelize(callback?: () => void): this {
        callback?.();
        return this;
    }

    wait(callback?: Callback): this {
        call(callback, this, [null]);
        return this;
    }

    raw(): Sqlite3Handle {
        return this.getHandle();
    }

    /** Create a node-sqlite3-style backup; data moves when Backup.step() runs. */
    backup(filename: string, callback?: Callback): Backup;
    backup(
        filename: string,
        destName: string,
        sourceName: string,
        filenameIsDest: boolean,
        callback?: Callback,
    ): Backup;
    backup(filename: string, ...args: unknown[]): Backup {
        const values = args.slice();
        const callback = typeof values[values.length - 1] === 'function'
            ? values.pop() as Callback
            : undefined;

        let destName = 'main';
        let sourceName = 'main';
        let filenameIsDest = true;
        if (values.length !== 0) {
            if (values.length !== 3
                || typeof values[0] !== 'string'
                || typeof values[1] !== 'string'
                || typeof values[2] !== 'boolean') {
                throw new TypeError(
                    'backup(filename, destName, sourceName, filenameIsDest[, callback]) expected',
                );
            }
            destName = values[0];
            sourceName = values[1];
            filenameIsDest = values[2];
        }

        if (typeof filename !== 'string' || filename.length === 0) {
            const err = new TypeError('The "filename" argument must be a non-empty string');
            if (!callback) throw err;
            const failed = new Backup(this, filename, destName, sourceName, filenameIsDest, err);
            failed.initialize(callback);
            return failed;
        }
        const backup = new Backup(this, filename, destName, sourceName, filenameIsDest);
        backup.initialize(callback);
        return backup;
    }

    inTransaction(): boolean {
        return this.getHandle().inTransaction();
    }

    changesCount(): number {
        return this.getHandle().changes();
    }

    lastInsertRowid(): number {
        return this.getHandle().lastInsertRowid();
    }

    trace(sql: string): void {
        this.traceCallback?.(sql);
        this.emit('trace', sql);
    }

    profile(sql: string, ms: number): void {
        this.profileCallback?.(sql, ms);
        this.emit('profile', sql, ms);
    }

    private getHandle(): Sqlite3Handle {
        if (!this.handle) throw new Error('Database is closed');
        return this.handle;
    }

    private _query(method: QueryMethod, sql: string, args: unknown[]): this {
        const statement = this.prepare(sql);
        const values = args.slice();
        const callback = typeof values[values.length - 1] === 'function' ? values.pop() : undefined;
        try {
            const query = statement[method] as (...queryArgs: unknown[]) => Statement;
            if (callback) {
                query.call(statement, ...values, function(this: unknown, ...cbArgs: unknown[]) {
                    try { Reflect.apply(callback, this, cbArgs); }
                    finally { statement.finalize(); }
                });
            } else {
                query.call(statement, ...values);
                statement.finalize();
            }
        } catch (err) {
            statement.finalize();
            throw err;
        }
        return this;
    }
}

/** node-sqlite3-compatible Backup backed by the native full-copy primitive. */
export class Backup extends EventEmitter {
    completed = false;
    failed = false;
    idle = true;
    remaining = 0;
    pageCount = 0;
    retryErrors = [5, 6];
    private error: unknown = null;
    private initialized = false;
    private finished = false;
    private completionNotified = false;

    constructor(
        private readonly db: Database,
        readonly filename: string,
        readonly destName = 'main',
        readonly sourceName = 'main',
        readonly filenameIsDest = true,
        initError?: unknown,
    ) {
        super();
        if (initError !== undefined) {
            this.failed = true;
            this.error = initError;
        }
        if (!filenameIsDest && initError === undefined) {
            this.failed = true;
            this.error = new Error(
                'Restoring a file into an existing database is not supported by this runtime',
            );
        }
        this.initialized = true;
    }

    /** Notify the optional Database#backup initialization callback. */
    initialize(callback?: Callback): this {
        if (!callback) return this;
        call(callback, this, [this.error ?? null]);
        return this;
    }

    /** Copy all pages. The native binding does not expose partial stepping. */
    step(pages?: number | Callback, callback?: Callback): this {
        const count = typeof pages === 'number' ? pages : -1;
        const cb = typeof pages === 'function' ? pages : callback;
        if (!Number.isInteger(count) || count === 0) {
            return this.fail(new RangeError('Backup.step() pages must be a non-zero integer'), cb, false);
        }
        if (this.finished) {
            return this.fail(new Error('Backup has already been finished'), cb, false);
        }
        if (!this.initialized) {
            return this.fail(new Error('Backup has not been initialized'), cb);
        }
        if (this.failed) {
            return this.fail(this.error ?? new Error('Backup failed'), cb, false);
        }
        if (this.completed) {
            call(cb, this, [null]);
            return this;
        }

        this.idle = false;
        try {
            if (!this.filenameIsDest) {
                throw new Error(
                    'Restoring a file into an existing database is not supported by this runtime',
                );
            }
            this.pageCount = this.db.raw().backupTo(this.filename, this.sourceName, this.destName);
            this.remaining = 0;
            this.completed = true;
            this.idle = true;
            call(cb, this, [null]);
            if (!this.completionNotified) {
                this.completionNotified = true;
                defer(() => this.emit('completed', this.pageCount));
            }
        } catch (err) {
            return this.fail(err, cb);
        }
        return this;
    }

    /** Backward-compatible alias for callers that used the previous shim. */
    run(callback?: Callback): this {
        return this.step(-1, callback);
    }

    finish(callback?: Callback): this {
        if (this.failed) {
            this.finished = true;
            this.idle = true;
            emitOrThrow(this, callback, this, this.error ?? new Error('Backup failed'));
            return this;
        }
        if (this.finished) {
            call(callback, this, [null]);
            return this;
        }
        this.finished = true;
        this.idle = true;
        call(callback, this, [null]);
        return this;
    }

    private fail(err: unknown, callback?: Callback, remember = true): this {
        this.idle = true;
        if (remember) {
            this.failed = true;
            this.error = err;
        }
        emitOrThrow(this, callback, this, err);
        if (remember) {
            defer(() => this.emit('failed', err instanceof Error ? err : new Error(String(err))));
        }
        return this;
    }
}

const cachedDbs = new Map<string, Database>();
const CACHED_DB_LIMIT = 32;

function CachedDatabase(this: unknown, filename: string, mode?: number | Callback, callback?: Callback): Database {
    if (!(this instanceof CachedDatabase)) {
        return Reflect.construct(CachedDatabase, [filename, mode, callback]) as Database;
    }
    const hit = cachedDbs.get(filename);
    if (hit) {
        call(typeof mode === 'function' ? mode : callback, hit, [null]);
        return hit;
    }
    // Evict oldest entry if at capacity
    if (cachedDbs.size >= CACHED_DB_LIMIT) {
        const oldest = cachedDbs.keys().next().value;
        if (oldest !== undefined) cachedDbs.delete(oldest);
    }
    const db = new Database(filename, mode, callback);
    cachedDbs.set(filename, db);
    return db;
}

export const cached = {
    Database: CachedDatabase as typeof Database,
};

export const sqlite3 = {
    Database,
    Statement,
    Backup,
    cached,
    open,
    verbose,
    VERSION,
    SOURCE_ID,
    VERSION_NUMBER,
    O_CREATE,
    O_READONLY,
    O_READWRITE,
    O_MEMORY,
    O_URI,
    O_URL,
    O_NOMUTEX,
    O_FULLMUTEX,
    O_SHAREDCACHE,
    O_PRIVATECACHE,
    O_NOFOLLOW,
    OPEN_CREATE,
    OPEN_READONLY,
    OPEN_READWRITE,
    OPEN_MEMORY,
    OPEN_URI,
    OPEN_NOMUTEX,
    OPEN_FULLMUTEX,
    OPEN_SHAREDCACHE,
    OPEN_PRIVATECACHE,
    OPEN_NOFOLLOW,
};

/** node-sqlite3 returns its own module exports; mirror the CJS interop view. */
export function verbose(): typeof sqlite3 {
    try {
        const mod = require('node:sqlite3');
        if (mod && typeof mod === 'object' && 'Database' in mod) return mod as typeof sqlite3;
    } catch { /* module still evaluating; fall back to the literal */ }
    return sqlite3;
}

export default sqlite3;
