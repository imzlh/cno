import { assert } from "../utils/assert";
import { dirname } from "../utils/path";
import { DOMException, StorageEvent } from "./events";

const sqlite3 = import.meta.use('sqlite3');
const fs = import.meta.use('fs');
const os = import.meta.use('os');
const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const console = import.meta.use('console');

// Type Definitions

interface StorageOptions {
    /** Database file path */
    path: string;
    /** Storage name (for namespacing) */
    name?: string;
    /** Enable debug logging */
    debug?: boolean;
    /** Max storage size in bytes (0 = unlimited) */
    quota?: number;
    /** Enable WAL mode for better concurrency */
    useWAL?: boolean;
    /** Auto vacuum mode */
    autoVacuum?: boolean;
}

interface StorageStats {
    count: number;
    totalSize: number;
    quota: number;
    available: number;
}

type StorageEventListener = (event: StorageEvent) => void;
type StorageRow = CModuleSQLite3.SqliteRow;

function emitStorageListener(listener: StorageEventListener, event: StorageEvent): void {
    try {
        listener(event);
    } catch (e) {
        console.error('Error in storage event listener:', e);
    }
}

// Storage Implementation

class Storage {
    private db: CModuleSQLite3.Sqlite3Handle | null = null;
    private options: Required<StorageOptions>;
    private eventListeners: Map<string, Set<StorageEventListener>> = new Map();
    private stmtCache: Map<string, CModuleSQLite3.Sqlite3Stmt> = new Map();
    private _initialized = false;

    // Prepared statement cache keys
    private static readonly STMT_GET = 'get';
    private static readonly STMT_SET = 'set';
    private static readonly STMT_DELETE = 'delete';
    private static readonly STMT_CLEAR = 'clear';
    private static readonly STMT_KEYS = 'keys';
    private static readonly STMT_COUNT = 'count';
    private static readonly STMT_SIZE = 'size';

    constructor(options?: StorageOptions) {
        this.options = {
            name: 'default',
            debug: false,
            quota: 10 * 1024 * 1024, // 10MB default
            useWAL: true,
            autoVacuum: true,
            path: ':memory:',
            ...(options ?? {})
        };
    }

    private getDb(): CModuleSQLite3.Sqlite3Handle {
        if (!this.db) throw new Error('Storage database is not initialized');
        return this.db;
    }

    private getStmt(name: string): CModuleSQLite3.Sqlite3Stmt {
        const stmt = this.stmtCache.get(name);
        if (!stmt) throw new Error(`Storage statement is not prepared: ${name}`);
        return stmt;
    }

    private firstRow(rows: StorageRow[]): StorageRow | null {
        const row = rows[0];
        return row === undefined ? null : row;
    }

    private ensureDb(): void {
        if (this._initialized) return;
        this._initialized = true;

        if (this.options.path !== ':memory:') {
            this.ensureStorageDirectory();
        }

        this.openDatabase();
        this.initializeSchema();
        this.prepareStatements();
    }

    /**
     * Debug logging
     */
    private log(...args: unknown[]): void {
        if (this.options.debug) {
            console.log(`[Storage:${this.options.name}]`, ...args);
        }
    }

    /**
     * Ensure storage directory exists
     */
    private ensureStorageDirectory() {
        const dir = this.getDirectoryPath(this.options.path);
        if (dir && dir !== '.' && !fs.exists(dir)) {
            this.mkdirRecursive(dir);
        }
    }

    /**
     * Get directory path from file path
     */
    private getDirectoryPath(path: string): string {
        if (path === ':memory:' || !path.includes('/')) {
            return '';
        }
        const lastSlash = path.lastIndexOf('/');
        return lastSlash > 0 ? path.substring(0, lastSlash) : '';
    }

    /**
     * Create directory recursively.
     *
     * Seeds the loop with a non-creatable filesystem root rather than an empty
     * prefix. The old version started from `''` and treated a Windows drive spec
     * as an ordinary segment, so the first iteration called `mkdir('D:')`. That
     * is not masked by the `exists` guard, because `fs.exists('D:')` is **false**
     * while `fs.exists('D:/')` is true (measured). Normally hidden — `getDefaultPath`
     * glues forward slashes onto `$HOME`, keeping the drive inside the first
     * segment — but `CNO_STORAGE_DIR=D:/` reproduced it as
     * `EEXIST: file already exists, path 'D:'`.
     *
     * Also normalizes backslashes: this split on `/` only, so a native Windows
     * path arrived as one unsplittable segment.
     */
    private mkdirRecursive(path: string): void {
        if (!path || path === '.') return;

        const normalized = path.replace(/\\/g, '/');
        // Drive-absolute (`D:/x`), drive-relative (`D:x`), UNC/verbatim (`//srv/share`),
        // posix-absolute, or relative — each has a different uncreatable prefix.
        let root = '';
        let rest = normalized;
        const drive = /^([a-zA-Z]:)(\/?)/.exec(normalized);
        if (drive) {
            root = drive[1] + (drive[2] ? '/' : '');
            rest = normalized.slice(drive[0].length);
        } else if (normalized.startsWith('//')) {
            // Keep `//server/share` (or `//?/D:/`) intact; its parts are not creatable.
            const seg = normalized.slice(2).split('/').filter(Boolean);
            const keep = seg.slice(0, 2).join('/');
            root = `//${keep}/`;
            rest = normalized.slice(root.length);
        } else if (normalized.startsWith('/')) {
            root = '/';
            rest = normalized.slice(1);
        }

        let current = root;
        for (const part of rest.split('/').filter(p => p)) {
            current += part;
            if (!fs.exists(current)) {
                try {
                    fs.mkdir(current, 0o755);
                } catch (e) {
                    // Tolerate a lost race only when a directory really is there now.
                    if (!fs.exists(current)) throw e;
                }
            }
            current += '/';
        }
    }

    /**
     * Open SQLite database connection
     */
    private openDatabase(): void {
        this.log('Opening database:', this.options.path);

        const isMemory = this.options.path === ':memory:';
        
        let flags: number;
        if (isMemory) {
            flags = sqlite3.O_READWRITE | 
                    sqlite3.O_CREATE | 
                    sqlite3.O_MEMORY;
        } else {
            flags = sqlite3.O_READWRITE | 
                    sqlite3.O_CREATE;
        }

        try {
            this.db = sqlite3.open(this.options.path, flags);
            this.log('Database opened successfully');
        } catch (error) {
            this.log('Failed to open database:', error, 'with config:', this.options);
            throw new Error(`Failed to open storage database at ${this.options.path}: ${error}`);
        }

        const db = this.getDb();

        if (isMemory) {
            db.exec('PRAGMA foreign_keys=ON;');
            return;
        }

        if (this.options.useWAL) {
            try {
                db.exec('PRAGMA journal_mode=WAL;');
                this.log('Enabled WAL mode');
            } catch (e) {
                this.log('Failed to enable WAL mode:', e);
            }
        }

        db.exec('PRAGMA synchronous=NORMAL;');

        if (this.options.autoVacuum) {
            db.exec('PRAGMA auto_vacuum=INCREMENTAL;');
        }

        db.exec('PRAGMA cache_size=-2000;');

        db.exec('PRAGMA foreign_keys=ON;');
    }

    private initializeSchema(): void {
        this.log('Initializing schema');

        const db = this.getDb();

        db.exec(`
            CREATE TABLE IF NOT EXISTS storage (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                size INTEGER NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
            ) WITHOUT ROWID;
        `);

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_storage_updated 
            ON storage(updated_at);
        `);

        db.exec(`
            CREATE TABLE IF NOT EXISTS storage_metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            ) WITHOUT ROWID;
        `);

        const stmt = db.prepare(`
            INSERT OR IGNORE INTO storage_metadata (key, value)
            VALUES ('version', '1'), ('name', ?);
        `);
        stmt.run([this.options.name]);
        stmt.finalize();

        this.log('Schema initialized');
    }

    private prepareStatements(): void {
        const db = this.getDb();

        this.stmtCache.set(
            Storage.STMT_GET,
            db.prepare('SELECT value FROM storage WHERE key = ?')
        );

        this.stmtCache.set(
            Storage.STMT_SET,
            db.prepare(`
                INSERT OR REPLACE INTO storage (key, value, size, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `)
        );

        this.stmtCache.set(
            Storage.STMT_DELETE,
            db.prepare('DELETE FROM storage WHERE key = ?')
        );

        this.stmtCache.set(
            Storage.STMT_CLEAR,
            db.prepare('DELETE FROM storage')
        );

        this.stmtCache.set(
            Storage.STMT_KEYS,
            db.prepare('SELECT key FROM storage ORDER BY key')
        );

        this.stmtCache.set(
            Storage.STMT_COUNT,
            db.prepare('SELECT COUNT(*) as count FROM storage')
        );

        this.stmtCache.set(
            Storage.STMT_SIZE,
            db.prepare('SELECT COALESCE(SUM(size), 0) as total FROM storage')
        );
    }

    /**
     * Dispatch storage event
     */
    private dispatchStorageEvent(
        key: string | null,
        oldValue: string | null,
        newValue: string | null
    ): void {
        const event = new StorageEvent('storage', {
            key,
            oldValue,
            newValue,
            url: '',
            storageArea: this
        }, true);

        const listeners = this.eventListeners.get('storage');
        if (listeners) {
            for (const listener of listeners) {
                emitStorageListener(listener, event);
            }
        }
    }

    /**
     * Check quota before writing
     */
    private checkQuota(additionalSize: number): void {
        if (this.options.quota <= 0) return;

        const stmt = this.getStmt(Storage.STMT_SIZE);
        const result = stmt.all([]);
        const currentSize = Number(this.firstRow(result)?.total ?? 0);

        if (currentSize + additionalSize > this.options.quota) {
            throw new DOMException(
                `Storage quota exceeded (${currentSize + additionalSize} / ${this.options.quota} bytes)`,
                'QuotaExceededError'
            );
        }
    }

    /**
     * Helper method to handle created_at preservation on update
     */
    private getCreatedTimeForUpdate(key: string, now: number): number {
        try {
            // Try to get existing created_at
            const existingStmt = this.getDb().prepare('SELECT created_at FROM storage WHERE key = ?');
            const result = existingStmt.all([key]);
            existingStmt.finalize();
            
            const row = this.firstRow(result);
            if (row) {
                return Number(row.created_at);
            }
        } catch (error) {
            this.log('Error getting created_at:', error);
        }
        
        // If key doesn't exist or error, return current time
        return now;
    }

    // ========================================================================
    // Web Storage API Methods
    // ========================================================================

    /**
     * Get number of items in storage
     */
    get length(): number {
        this.ensureDb();
        try {
            const stmt = this.getStmt(Storage.STMT_COUNT);
            const result = stmt.all([]);
            return Number(this.firstRow(result)?.count ?? 0);
        } catch (error) {
            this.log('Error getting length:', error);
            return 0;
        }
    }

    /**
     * Get item by key
     */
    getItem(key: string): string | null {
        this.ensureDb();
        try {
            const stringKey = String(key);
            const stmt = this.getStmt(Storage.STMT_GET);
            const result = stmt.all([stringKey]);

            const row = this.firstRow(result);
            if (!row) {
                return null;
            }

            return typeof row.value === 'string' ? row.value : String(row.value ?? '');
        } catch (error) {
            this.log('Error getting item:', error);
            return null;
        }
    }

    /**
     * Set item
     */
    setItem(key: string, value: string): void {
        this.ensureDb();
        try {
            const stringKey = String(key);
            // Convert value to string (Web Storage API behavior)
            const stringValue = String(value);
            const size = (stringKey.length + stringValue.length) * 2; // Approximate UTF-16 size
            const now = Date.now();

            // Check if key exists to get old value for event
            const oldValue = this.getItem(stringKey);

            // Check quota before writing
            if (oldValue === null) {
                this.checkQuota(size);
            } else {
                const oldSize = (stringKey.length + oldValue.length) * 2;
                this.checkQuota(size - oldSize);
            }

            // For INSERT OR REPLACE, we need to preserve created_at
            const createdTime = oldValue === null ? now : this.getCreatedTimeForUpdate(stringKey, now);

            // Insert or update using INSERT OR REPLACE
            const stmt = this.getStmt(Storage.STMT_SET);
            stmt.run([stringKey, stringValue, size, createdTime, now]);

            this.log(`Set item: ${stringKey} (${size} bytes)`);

            // Dispatch storage event
            this.dispatchStorageEvent(stringKey, oldValue, stringValue);
        } catch (error) {
            this.log('Error setting item:', error);
            throw error;
        }
    }

    /**
     * Remove item
     */
    removeItem(key: string): void {
        this.ensureDb();
        try {
            const stringKey = String(key);
            // Get old value for event
            const oldValue = this.getItem(stringKey);

            if (oldValue === null) {
                return; // Key doesn't exist
            }

            // Delete item
            const stmt = this.getStmt(Storage.STMT_DELETE);
            stmt.run([stringKey]);

            this.log(`Removed item: ${stringKey}`);

            // Dispatch storage event
            this.dispatchStorageEvent(stringKey, oldValue, null);
        } catch (error) {
            this.log('Error removing item:', error);
            throw error;
        }
    }

    /**
     * Clear all items
     */
    clear(): void {
        this.ensureDb();
        try {
            const stmt = this.getStmt(Storage.STMT_CLEAR);
            stmt.run([]);

            this.log('Cleared all items');

            // Dispatch storage event
            this.dispatchStorageEvent(null, null, null);

            // Optimize database after clear 
            if (this.options.autoVacuum && this.options.path !== ':memory:') {
                this.getDb().exec('PRAGMA incremental_vacuum;');
            }
        } catch (error) {
            this.log('Error clearing storage:', error);
            throw error;
        }
    }

    /**
     * Get key at index (for iteration)
     */
    key(index: number): string | null {
        this.ensureDb();
        try {
            index = Number(index);
            if (index < 0) return null;

            const stmt = this.getStmt(Storage.STMT_KEYS);
            const result = stmt.all([]);

            if (index >= result.length) {
                return null;
            }

            const row = result[index];
            return typeof row?.key === 'string' ? row.key : null;
        } catch (error) {
            this.log('Error getting key at index:', error);
            return null;
        }
    }

    // ========================================================================
    // Additional Utility Methods (Non-standard)
    // ========================================================================

    /**
     * Get all keys
     */
    keys(): string[] {
        this.ensureDb();
        try {
            const stmt = this.getStmt(Storage.STMT_KEYS);
            const result = stmt.all([]);
            return result.map(row => String(row.key));
        } catch (error) {
            this.log('Error getting keys:', error);
            return [];
        }
    }

    /**
     * Get all values
     */
    values(): string[] {
        this.ensureDb();
        try {
            const stmt = this.getDb().prepare('SELECT value FROM storage ORDER BY key');
            const result = stmt.all([]);
            stmt.finalize();
            return result.map(row => String(row.value ?? ''));
        } catch (error) {
            this.log('Error getting values:', error);
            return [];
        }
    }

    /**
     * Get all entries
     */
    entries(): Array<[string, string]> {
        this.ensureDb();
        try {
            const stmt = this.getDb().prepare('SELECT key, value FROM storage ORDER BY key');
            const result = stmt.all([]);
            stmt.finalize();
            return result.map(row => [String(row.key ?? ''), String(row.value ?? '')]);
        } catch (error) {
            this.log('Error getting entries:', error);
            return [];
        }
    }

    /**
     * Check if key exists
     */
    has(key: string): boolean {
        return this.getItem(key) !== null;
    }

    /**
     * Get storage statistics
     */
    getStats(): StorageStats {
        this.ensureDb();
        try {
            const countStmt = this.getStmt(Storage.STMT_COUNT);
            const sizeStmt = this.getStmt(Storage.STMT_SIZE);

            const countResult = countStmt.all([]);
            const sizeResult = sizeStmt.all([]);

            const count = Number(this.firstRow(countResult)?.count ?? 0);
            const totalSize = Number(this.firstRow(sizeResult)?.total ?? 0);
            const quota = this.options.quota;
            const available = quota > 0 ? quota - totalSize : Infinity;

            return { count, totalSize, quota, available };
        } catch (error) {
            this.log('Error getting stats:', error);
            return { count: 0, totalSize: 0, quota: this.options.quota, available: this.options.quota };
        }
    }

    /**
     * Optimize database (vacuum and analyze)
     */
    optimize(): void {
        this.ensureDb();
        try {
            this.log('Optimizing database');

            if (this.options.autoVacuum && this.options.path !== ':memory:') {
                this.getDb().exec('PRAGMA incremental_vacuum;');
            }

            this.getDb().exec('ANALYZE;');

            this.log('Database optimized');
        } catch (error) {
            this.log('Error optimizing database:', error);
        }
    }

    /**
     * Add event listener
     */
    addEventListener(type: string, listener: StorageEventListener): void {
        let listeners = this.eventListeners.get(type);
        if (!listeners) {
            listeners = new Set();
            this.eventListeners.set(type, listeners);
        }
        listeners.add(listener);
    }

    /**
     * Remove event listener
     */
    removeEventListener(type: string, listener: StorageEventListener): void {
        const listeners = this.eventListeners.get(type);
        if (listeners) {
            listeners.delete(listener);
        }
    }

    /**
     * Close storage and cleanup
     */
    close(): void {
        try {
            this.log('Closing storage');

            for (const stmt of this.stmtCache.values()) {
                stmt.finalize();
            }
            this.stmtCache.clear();

            if (this.db) {
                this.db.close();
                this.db = null;
            }
            this._initialized = false;

            this.log('Storage closed');
        } catch (error) {
            this.log('Error closing storage:', error);
            throw error;
        }
    }

    /**
     * Iterator support (for...of)
     */
    *[Symbol.iterator](): Iterator<[string, string]> {
        const entries = this.entries();
        for (const entry of entries) {
            yield entry;
        }
    }

    /**
     * forEach support
     */
    forEach(callback: (value: string, key: string, storage: Storage) => void): void {
        const entries = this.entries();
        for (const [key, value] of entries) {
            callback(value, key, this);
        }
    }

    /**
     * Get string representation
     */
    toString(): string {
        return `[object Storage]`;
    }

    /**
     * Get string tag
     */
    get [Symbol.toStringTag](): string {
        return 'Storage';
    }
}

const storageProxyCache = new WeakMap<Storage, Storage>();
const storageInternalProps = new Set(['db', 'options', 'eventListeners', 'stmtCache', '_initialized']);

const isHiddenStorageProp = (prop: PropertyKey): prop is string =>
    typeof prop === 'string' && storageInternalProps.has(prop);

function createStorageProxy(storage: Storage): Storage {
    const cached = storageProxyCache.get(storage);
    if (cached) return cached;

    const proxy = new Proxy(storage, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && (isHiddenStorageProp(prop) || !(prop in target))) {
                const value = target.getItem(prop);
                return value === null ? undefined : value;
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },

        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && (isHiddenStorageProp(prop) || !(prop in target))) {
                target.setItem(prop, String(value));
                return true;
            }
            return Reflect.set(target, prop, value, target);
        },

        has(target, prop) {
            if (typeof prop === 'string' && (isHiddenStorageProp(prop) || !(prop in target))) {
                return target.getItem(prop) !== null;
            }
            return Reflect.has(target, prop);
        },

        deleteProperty(target, prop) {
            if (typeof prop === 'string' && target.getItem(prop) !== null) {
                target.removeItem(prop);
                return true;
            }
            return Reflect.deleteProperty(target, prop);
        },

        ownKeys(target) {
            const targetKeys = Reflect.ownKeys(target).filter(prop => !isHiddenStorageProp(prop));
            const keys = target.keys().filter(key => isHiddenStorageProp(key) || !Reflect.has(target, key));
            return [...targetKeys, ...keys];
        },

        getOwnPropertyDescriptor(target, prop) {
            if (isHiddenStorageProp(prop)) {
                const value = target.getItem(prop);
                if (value === null) return undefined;
                return { value, writable: true, enumerable: true, configurable: true };
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
            if (descriptor) return descriptor;
            if (typeof prop !== 'string' || prop in target) return undefined;
            const value = target.getItem(prop);
            if (value === null) return undefined;
            return { value, writable: true, enumerable: true, configurable: true };
        }
    });

    storageProxyCache.set(storage, proxy);
    return proxy;
}

// Storage Manager

class StorageManager {
    private storages: Map<string, Storage> = new Map();
    private defaultOptions: Partial<StorageOptions> = {
        debug: false,
        quota: 10 * 1024 * 1024,
        useWAL: true,
        autoVacuum: true
    };

    /**
     * Create or get storage instance
     */
    getStorage(name: string, path?: string, options?: Partial<StorageOptions>): Storage {
        const existing = this.storages.get(name);
        if (existing) {
            return existing;
        }

        const storagePath = path || this.getDefaultPath(name);
        const storage = new Storage({
            path: storagePath,
            name,
            ...this.defaultOptions,
            ...options
        });

        this.storages.set(name, storage);
        return storage;
    }

    /**
     * Get default storage path
     */
    private getDefaultPath(name: string): string {
        const getEnv = (env: string): string => {
            try {
                return os.getenv(env) || '';
            } catch {
                return '';
            }
        };
        const writableRoot = (dir: string): boolean => {
            if (!dir) return false;
            const probe = `${dir}/.cno-storage-probe-${os.pid}`;
            try {
                fs.writeFile(probe, new ArrayBuffer(0));
                fs.unlink(probe);
                return true;
            } catch {
                return false;
            }
        };
        const cwd = os.cwd || os.tmpDir || '/tmp';
        const hash = crypto.hexEncode(crypto.md5(engine.encodeString(cwd)));
        const preferred = getEnv('CNO_STORAGE_DIR') || getEnv('HOME') || os.tmpDir || cwd;
        const homeDir = writableRoot(preferred) ? preferred : (os.tmpDir || cwd);
        const baseDir = `${homeDir}/.storage/${hash}`;
        return `${baseDir}/${name}.db`;
    }

    /**
     * Close storage by name
     */
    closeStorage(name: string): void {
        const storage = this.storages.get(name);
        if (storage) {
            storage.close();
            this.storages.delete(name);
        }
    }

    /**
     * Close all storages
     */
    closeAll(): void {
        for (const [name, storage] of this.storages) {
            storage.close();
        }
        this.storages.clear();
    }

    /**
     * Set default options
     */
    setDefaultOptions(options: Partial<StorageOptions>): void {
        Object.assign(this.defaultOptions, options);
    }
}

// Global Instance and Exports

const storageManager = new StorageManager();

/**
 * Get localStorage instance (persistent)
 */
export function getLocalStorage(path?: string): Storage {
    return createStorageProxy(storageManager.getStorage('localStorage', path));
}

/**
 * Get sessionStorage instance (persistent, but typically cleared)
 */
export function getSessionStorage(path?: string): Storage {
    return createStorageProxy(storageManager.getStorage('sessionStorage', path));
}

/**
 * Create custom storage instance
 */
export function createStorage(name: string, options?: StorageOptions): Storage {
    const path = options?.path || storageManager['getDefaultPath'](name);
    return createStorageProxy(new Storage({
        name,
        path,
        ...options
    }));
}

/**
 * Close all storages (cleanup)
 */
export function closeAllStorages(): void {
    storageManager.closeAll();
}

function StorageCtor(): never {
    throw new Error('Storage is not constructable. Use createStorage() or getLocalStorage() instead.');
}
StorageCtor.prototype = Storage.prototype;

const localStorageInstance = getLocalStorage();
const sessionStorageInstance = getSessionStorage();

Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: () => localStorageInstance,
    set: () => {}
});
Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    enumerable: true,
    get: () => sessionStorageInstance,
    set: () => {}
});
if (!Reflect.get(globalThis, 'Storage')) {
    Reflect.set(globalThis, 'Storage', StorageCtor);
}
