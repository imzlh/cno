/**
 * Node.js node:sqlite module.
 *
 * Implements the synchronous DatabaseSync / StatementSync surface on top of
 * circu.js' native sqlite3 binding.
 */

const native = import.meta.use('sqlite3');

type Sqlite3Handle = CModuleSQLite3.Sqlite3Handle;
type Sqlite3Stmt = CModuleSQLite3.Sqlite3Stmt;
type BindParams = any[] | Record<string, any>;

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

function paramsFrom(args: any[]): BindParams | undefined {
    if (args.length === 0) return undefined;
    if (args.length === 1) {
        const value = args[0];
        if (Array.isArray(value) || (value !== null && typeof value === 'object' && !(value instanceof Uint8Array))) {
            return value;
        }
    }
    return args;
}

function allRows(stmt: Sqlite3Stmt, params?: BindParams): any[] {
    return params === undefined ? stmt.all() : stmt.all(params);
}

function runStmt(stmt: Sqlite3Stmt, params?: BindParams): void {
    if (params === undefined) stmt.run();
    else stmt.run(params);
}

function unsupported(name: string): never {
    throw new Error(`node:sqlite ${name} is not implemented by this runtime`);
}

export class StatementSync {
    private returnArrays = false;
    private readBigInts = false;

    constructor(private readonly db: DatabaseSync, private readonly stmt: Sqlite3Stmt, readonly sourceSQL = '') {}

    all(...anonymousParameters: any[]): any[] {
        return this.convertRows(allRows(this.stmt, paramsFrom(anonymousParameters)));
    }

    get(...anonymousParameters: any[]): any {
        return this.all(...anonymousParameters)[0];
    }

    run(...anonymousParameters: any[]): RunResult {
        runStmt(this.stmt, paramsFrom(anonymousParameters));
        return {
            changes: this.db.raw().changes(),
            lastInsertRowid: this.readBigInts
                ? BigInt(this.db.raw().lastInsertRowid())
                : this.db.raw().lastInsertRowid(),
        };
    }

    iterate(...anonymousParameters: any[]): IterableIterator<any> {
        const rows = this.all(...anonymousParameters);
        return rows[Symbol.iterator]();
    }

    columns(): StatementColumnMetadata[] {
        const row = this.get();
        if (!row) return [];
        const names = Array.isArray(row) ? row.map((_: any, index: number) => String(index)) : Object.keys(row);
        return names.map(name => ({ name }));
    }

    setReadBigInts(enabled: boolean): void {
        this.readBigInts = !!enabled;
    }

    setReturnArrays(enabled: boolean): void {
        this.returnArrays = !!enabled;
    }

    expandedSQL(): string {
        return this.stmt.expand();
    }

    raw(): Sqlite3Stmt {
        return this.stmt;
    }

    finalize(): void {
        this.stmt.finalize();
    }

    private convertRows(rows: any[]): any[] {
        if (!this.returnArrays) return rows;
        return rows.map(row => Object.keys(row).map(key => row[key]));
    }
}

export class DatabaseSync {
    private handle: Sqlite3Handle | null = null;
    readonly location: string;

    constructor(location: string, options: DatabaseSyncOptions = {}) {
        this.location = location;
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

    function(): void {
        unsupported('DatabaseSync.function');
    }

    aggregate(): void {
        unsupported('DatabaseSync.aggregate');
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

export class Session {
    constructor() {
        unsupported('Session');
    }
}

export function backup(): never {
    unsupported('backup');
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
