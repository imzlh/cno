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
type BindParams = any[] | Record<string, any>;
type Callback = (...args: any[]) => void;
type RowCallback = (err: Error | null, row?: any) => void;
type CompleteCallback = (err: Error | null, count?: number) => void;

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

function call(callback: Callback | undefined, self: any, args: any[]): void {
    if (callback) defer(() => callback.apply(self, args));
}

function emitOrThrow(target: EventEmitter, callback: Callback | undefined, self: any, err: unknown): void {
    if (callback) {
        call(callback, self, [err]);
        return;
    }
    target.emit('error', err instanceof Error ? err : new Error(String(err)));
}

function isBindObject(value: any): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function splitArgs(args: any[]): { params?: BindParams; callback?: Callback } {
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

function splitEachArgs(args: any[]): { params?: BindParams; rowCallback?: RowCallback; completeCallback?: CompleteCallback } {
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
    const normalized: Record<string, any> = {};
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

function allStmt(stmt: Sqlite3Stmt, params?: BindParams, sql = ''): any[] {
    params = normalizeBindParams(sql, params);
    return params === undefined ? stmt.all() : stmt.all(params);
}

function mapRows(rows: any[]): Record<string, any> {
    const result: Record<string, any> = {};
    for (const row of rows) {
        const keys = Object.keys(row);
        if (keys.length === 0) continue;
        const key = String(row[keys[0]]);
        result[key] = keys.length === 2 ? row[keys[1]] : row;
    }
    return result;
}

function notImplemented(name: string): Error {
    return new Error(`sqlite3.${name} is not implemented by this runtime`);
}

export class Statement extends EventEmitter {
    lastID = 0;
    changes = 0;
    private stmt: Sqlite3Stmt | null;

    constructor(private readonly db: Database, stmt: Sqlite3Stmt, readonly sql = '') {
        super();
        this.stmt = stmt;
    }

    bind(...args: any[]): this {
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

    run(...args: any[]): this {
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

    get(...args: any[]): this {
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

    all(...args: any[]): this {
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

    each(...args: any[]): this {
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

    map(...args: any[]): this {
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

    configure(option: string, value: any): this {
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

    run(sql: string, ...args: any[]): this {
        return this._query('run', sql, args);
    }

    get(sql: string, ...args: any[]): this {
        return this._query('get', sql, args);
    }

    all(sql: string, ...args: any[]): this {
        return this._query('all', sql, args);
    }

    each(sql: string, ...args: any[]): this {
        const statement = this.prepare(sql);
        const values = args.slice();
        let wrapped = false;
        if (typeof values[values.length - 1] === 'function' && typeof values[values.length - 2] === 'function') {
            const completeCallback = values.pop() as CompleteCallback;
            values.push(function(this: any, ...cbArgs: any[]) {
                try { completeCallback.apply(this, cbArgs as any); }
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

    prepare(sql: string, ...args: any[]): Statement {
        const { params, callback } = splitArgs(args);
        try {
            const statement = new Statement(this, this.getHandle().prepare(sql), sql);
            if (params !== undefined) statement.bind(params);
            call(callback, statement, [null]);
            return statement;
        } catch (err) {
            if (callback) {
                call(callback, this, [err]);
                return null as any;
            }
            throw err;
        }
    }

    map(sql: string, ...args: any[]): this {
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

    private _query(method: string, sql: string, args: any[]): this {
        const statement = this.prepare(sql);
        const values = args.slice();
        const callback = typeof values[values.length - 1] === 'function' ? values.pop() : undefined;
        try {
            if (callback) {
                (statement as any)[method](...values, function(this: any, ...cbArgs: any[]) {
                    try { callback.apply(this, cbArgs); }
                    finally { statement.finalize(); }
                });
            } else {
                (statement as any)[method](...values);
                statement.finalize();
            }
        } catch (err) {
            statement.finalize();
            throw err;
        }
        return this;
    }
}

export class Backup extends EventEmitter {
    constructor() {
        super();
        throw notImplemented('Backup');
    }
}

const cachedDbs = new Map<string, Database>();
const CACHED_DB_LIMIT = 32;

function CachedDatabase(this: any, filename: string, mode?: number | Callback, callback?: Callback): Database {
    if (!(this instanceof CachedDatabase)) {
        // @ts-ignore - CachedDatabase is a legacy-JS compatible constructor
        return new CachedDatabase(filename, mode, callback);
    }
    const hit = cachedDbs.get(filename);
    if (hit) {
        call(typeof mode === 'function' ? mode : callback, hit, [null]);
        return hit;
    }
    // Evict oldest entry if at capacity
    if (cachedDbs.size >= CACHED_DB_LIMIT) {
        const oldest = cachedDbs.keys().next().value!;
        cachedDbs.delete(oldest);
    }
    const db = new Database(filename, mode, callback);
    cachedDbs.set(filename, db);
    return db;
}

export const cached = {
    Database: CachedDatabase as unknown as typeof Database,
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

export function verbose(): typeof sqlite3 {
    return sqlite3;
}

export default sqlite3;
