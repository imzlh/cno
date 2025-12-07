const sqlite3 = import.meta.use('sqlite3');
const fs = import.meta.use('fs');
const os = import.meta.use('os');
const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');

// ============================================================================
// Type Definitions
// ============================================================================

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

interface StorageEventInit {
    key: string | null;
    oldValue: string | null;
    newValue: string | null;
    url: string;
    storageArea: Storage | null;
}

interface StorageRow {
    key: string;
    value: string;
    size: number;
    created_at: number;
    updated_at: number;
}

interface StorageStats {
    count: number;
    totalSize: number;
    quota: number;
    available: number;
}

// ============================================================================
// Storage Event (for compatibility)
// ============================================================================

class StorageEvent extends Event {
    readonly key: string | null;
    readonly oldValue: string | null;
    readonly newValue: string | null;
    readonly url: string;
    readonly storageArea: Storage | null;

    constructor(type: string, init: StorageEventInit) {
        super(type);
        this.key = init.key;
        this.oldValue = init.oldValue;
        this.newValue = init.newValue;
        this.url = init.url;
        this.storageArea = init.storageArea;
    }
}

// ============================================================================
// Storage Implementation
// ============================================================================

class Storage {
    private db: CModuleSQLite3.Sqlite3Handle;
    private options: Required<StorageOptions>;
    private eventListeners: Map<string, Set<Function>> = new Map();
    private stmtCache: Map<string, CModuleSQLite3.Sqlite3Stmt> = new Map();

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
            path: ':inmemory:',
            ...(options ?? {})
        };

        this.db = sqlite3.open(this.options.path, sqlite3.SQLITE_OPEN_READWRITE | sqlite3.SQLITE_OPEN_CREATE); // in-memory database for testing
        this.ensureStorageDirectory();
        this.openDatabase();
        this.initializeSchema();
        this.prepareStatements();
    }

    /**
     * Debug logging
     */
    private log(...args: any[]): void {
        if (this.options.debug) {
            console.log(`[Storage:${this.options.name}]`, ...args);
        }
    }

    /**
     * Ensure storage directory exists
     */
    private ensureStorageDirectory(): void {
        const dir = this.getDirectoryPath(this.options.path);
        if (dir && !fs.exists(dir)) {
            this.mkdirRecursive(dir);
        }
    }

    /**
     * Get directory path from file path
     */
    private getDirectoryPath(path: string): string {
        const lastSlash = path.lastIndexOf('/');
        return lastSlash > 0 ? path.substring(0, lastSlash) : '';
    }

    /**
     * Create directory recursively
     */
    private mkdirRecursive(path: string): void {
        const parts = path.split('/').filter(p => p);
        let current = path.startsWith('/') ? '/' : '';

        for (const part of parts) {
            current += part;
            if (!fs.exists(current)) {
                fs.mkdir(current, 0o755);
            }
            current += '/';
        }
    }

    /**
     * Open SQLite database connection
     */
    private openDatabase(): void {
        this.log('Opening database:', this.options.path);

        const flags = sqlite3.SQLITE_OPEN_READWRITE |
            sqlite3.SQLITE_OPEN_CREATE;

        this.db = sqlite3.open(this.options.path, flags);

        // Enable WAL mode for better concurrency
        if (this.options.useWAL) {
            sqlite3.exec(this.db, 'PRAGMA journal_mode=WAL;');
            this.log('Enabled WAL mode');
        }

        // Set synchronous mode for better performance
        sqlite3.exec(this.db, 'PRAGMA synchronous=NORMAL;');

        // Enable auto vacuum if requested
        if (this.options.autoVacuum) {
            sqlite3.exec(this.db, 'PRAGMA auto_vacuum=INCREMENTAL;');
        }

        // Set cache size (negative value = KB)
        sqlite3.exec(this.db, 'PRAGMA cache_size=-2000;'); // 2MB cache

        // Enable foreign keys
        sqlite3.exec(this.db, 'PRAGMA foreign_keys=ON;');
    }

    /**
     * Initialize database schema
     */
    private initializeSchema(): void {
        this.log('Initializing schema');

        // Create storage table with proper indexes
        sqlite3.exec(this.db, `
      CREATE TABLE IF NOT EXISTS storage (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
      ) WITHOUT ROWID;
    `);

        // Create index on updated_at for efficient cleanup
        sqlite3.exec(this.db, `
      CREATE INDEX IF NOT EXISTS idx_storage_updated 
      ON storage(updated_at);
    `);

        // Create metadata table for storage info
        sqlite3.exec(this.db, `
      CREATE TABLE IF NOT EXISTS storage_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
    `);

        // Insert initial metadata
        const stmt = sqlite3.prepare(this.db, `
      INSERT OR IGNORE INTO storage_metadata (key, value)
      VALUES ('version', '1'), ('name', ?);
    `);
        sqlite3.stmt_run(stmt, [this.options.name]);
        sqlite3.stmt_finalize(stmt);

        this.log('Schema initialized');
    }

    /**
     * Prepare commonly used SQL statements
     */
    private prepareStatements(): void {
        // Get item
        this.stmtCache.set(
            Storage.STMT_GET,
            sqlite3.prepare(this.db, 'SELECT value FROM storage WHERE key = ?')
        );

        // Set item (upsert)
        this.stmtCache.set(
            Storage.STMT_SET,
            sqlite3.prepare(this.db, `
        INSERT INTO storage (key, value, size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          size = excluded.size,
          updated_at = excluded.updated_at
      `)
        );

        // Delete item
        this.stmtCache.set(
            Storage.STMT_DELETE,
            sqlite3.prepare(this.db, 'DELETE FROM storage WHERE key = ?')
        );

        // Clear all
        this.stmtCache.set(
            Storage.STMT_CLEAR,
            sqlite3.prepare(this.db, 'DELETE FROM storage')
        );

        // Get all keys
        this.stmtCache.set(
            Storage.STMT_KEYS,
            sqlite3.prepare(this.db, 'SELECT key FROM storage ORDER BY key')
        );

        // Count items
        this.stmtCache.set(
            Storage.STMT_COUNT,
            sqlite3.prepare(this.db, 'SELECT COUNT(*) as count FROM storage')
        );

        // Get total size
        this.stmtCache.set(
            Storage.STMT_SIZE,
            sqlite3.prepare(this.db, 'SELECT COALESCE(SUM(size), 0) as total FROM storage')
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
        });

        const listeners = this.eventListeners.get('storage');
        if (listeners) {
            for (const listener of listeners) {
                try {
                    listener(event);
                } catch (e) {
                    console.error('Error in storage event listener:', e);
                }
            }
        }
    }

    /**
     * Check quota before writing
     */
    private checkQuota(additionalSize: number): void {
        if (this.options.quota <= 0) return;

        const stmt = this.stmtCache.get(Storage.STMT_SIZE)!;
        const result = sqlite3.stmt_all(stmt, []);
        const currentSize = result[0]!.total as number;

        if (currentSize + additionalSize > this.options.quota) {
            throw new DOMException(
                `QuotaExceededError: Storage quota exceeded (${currentSize + additionalSize} / ${this.options.quota} bytes)`,
                'QuotaExceededError'
            );
        }
    }

    // ========================================================================
    // Web Storage API Methods
    // ========================================================================

    /**
     * Get number of items in storage
     */
    get length(): number {
        try {
            const stmt = this.stmtCache.get(Storage.STMT_COUNT)!;
            const result = sqlite3.stmt_all(stmt, []);
            return result[0]!.count as number;
        } catch (error) {
            this.log('Error getting length:', error);
            return 0;
        }
    }

    /**
     * Get item by key
     */
    getItem(key: string): string | null {
        try {
            const stmt = this.stmtCache.get(Storage.STMT_GET)!;
            const result = sqlite3.stmt_all(stmt, [key]);

            if (result.length === 0) {
                return null;
            }

            return result[0]!.value as string;
        } catch (error) {
            this.log('Error getting item:', error);
            return null;
        }
    }

    /**
     * Set item
     */
    setItem(key: string, value: string): void {
        try {
            // Convert value to string (Web Storage API behavior)
            const stringValue = String(value);
            const size = stringValue.length * 2; // Approximate UTF-16 size
            const now = Date.now();

            // Check if key exists to get old value for event
            const oldValue = this.getItem(key);

            // Check quota before writing
            if (oldValue === null) {
                this.checkQuota(size);
            } else {
                const oldSize = oldValue.length * 2;
                this.checkQuota(size - oldSize);
            }

            // Insert or update
            const stmt = this.stmtCache.get(Storage.STMT_SET)!;
            sqlite3.stmt_run(stmt, [key, stringValue, size, now, now]);

            this.log(`Set item: ${key} (${size} bytes)`);

            // Dispatch storage event
            this.dispatchStorageEvent(key, oldValue, stringValue);
        } catch (error) {
            this.log('Error setting item:', error);
            throw error;
        }
    }

    /**
     * Remove item
     */
    removeItem(key: string): void {
        try {
            // Get old value for event
            const oldValue = this.getItem(key);

            if (oldValue === null) {
                return; // Key doesn't exist
            }

            // Delete item
            const stmt = this.stmtCache.get(Storage.STMT_DELETE)!;
            sqlite3.stmt_run(stmt, [key]);

            this.log(`Removed item: ${key}`);

            // Dispatch storage event
            this.dispatchStorageEvent(key, oldValue, null);
        } catch (error) {
            this.log('Error removing item:', error);
            throw error;
        }
    }

    /**
     * Clear all items
     */
    clear(): void {
        try {
            const stmt = this.stmtCache.get(Storage.STMT_CLEAR)!;
            sqlite3.stmt_run(stmt, []);

            this.log('Cleared all items');

            // Dispatch storage event
            this.dispatchStorageEvent(null, null, null);

            // Optimize database after clear
            if (this.options.autoVacuum) {
                sqlite3.exec(this.db, 'PRAGMA incremental_vacuum;');
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
        try {
            if (index < 0) return null;

            const stmt = this.stmtCache.get(Storage.STMT_KEYS)!;
            const result = sqlite3.stmt_all(stmt, []);

            if (index >= result.length) {
                return null;
            }

            return result[index]!.key as string;
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
        try {
            const stmt = this.stmtCache.get(Storage.STMT_KEYS)!;
            const result = sqlite3.stmt_all(stmt, []);
            return result.map(row => row.key as string);
        } catch (error) {
            this.log('Error getting keys:', error);
            return [];
        }
    }

    /**
     * Get all values
     */
    values(): string[] {
        try {
            const stmt = sqlite3.prepare(this.db, 'SELECT value FROM storage ORDER BY key');
            const result = sqlite3.stmt_all(stmt, []);
            sqlite3.stmt_finalize(stmt);
            return result.map(row => row.value as string);
        } catch (error) {
            this.log('Error getting values:', error);
            return [];
        }
    }

    /**
     * Get all entries
     */
    entries(): Array<[string, string]> {
        try {
            const stmt = sqlite3.prepare(this.db, 'SELECT key, value FROM storage ORDER BY key');
            const result = sqlite3.stmt_all(stmt, []);
            sqlite3.stmt_finalize(stmt);
            return result.map(row => [row.key as string, row.value as string]);
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
        try {
            const countStmt = this.stmtCache.get(Storage.STMT_COUNT)!;
            const sizeStmt = this.stmtCache.get(Storage.STMT_SIZE)!;

            const countResult = sqlite3.stmt_all(countStmt, []);
            const sizeResult = sqlite3.stmt_all(sizeStmt, []);

            const count = countResult[0]!.count as number;
            const totalSize = sizeResult[0]!.total as number;
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
        try {
            this.log('Optimizing database');

            if (this.options.autoVacuum) {
                sqlite3.exec(this.db, 'PRAGMA incremental_vacuum;');
            }

            sqlite3.exec(this.db, 'ANALYZE;');

            this.log('Database optimized');
        } catch (error) {
            this.log('Error optimizing database:', error);
        }
    }

    /**
     * Add event listener
     */
    addEventListener(type: string, listener: Function): void {
        if (!this.eventListeners.has(type)) {
            this.eventListeners.set(type, new Set());
        }
        this.eventListeners.get(type)!.add(listener);
    }

    /**
     * Remove event listener
     */
    removeEventListener(type: string, listener: Function): void {
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

            // Finalize all prepared statements
            for (const stmt of this.stmtCache.values()) {
                sqlite3.stmt_finalize(stmt);
            }
            this.stmtCache.clear();

            // Close database
            sqlite3.close(this.db);

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

// ============================================================================
// Storage Manager
// ============================================================================

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
        if (this.storages.has(name)) {
            return this.storages.get(name)!;
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
        const hash = crypto.base64Encode(crypto.md5(engine.encodeString(os.cwd)));
        try {
            const homeDir = os.getenv('HOME') ?? fs.getcwd();
            return `${homeDir}/.storage/${hash}/${name}.db`;
        } catch {
            return `${os.tmpdir}/.storage/${hash}/${name}.db`;
        }
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

// ============================================================================
// Global Instance and Exports
// ============================================================================

const storageManager = new StorageManager();

/**
 * Get localStorage instance (persistent)
 */
export function getLocalStorage(path?: string): Storage {
    return storageManager.getStorage('localStorage', path);
}

/**
 * Get sessionStorage instance (persistent, but typically cleared)
 */
export function getSessionStorage(path?: string): Storage {
    return storageManager.getStorage('sessionStorage', path);
}

/**
 * Create custom storage instance
 */
export function createStorage(name: string, options?: StorageOptions): Storage {
    const path = options?.path || storageManager['getDefaultPath'](name);
    return new Storage({
        name,
        path,
        ...options
    });
}

/**
 * Close all storages (cleanup)
 */
export function closeAllStorages(): void {
    storageManager.closeAll();
}

function StorageCtor(): never {
    throw new Error('Storage is not constructable.');
}
StorageCtor.prototype = Storage.prototype;

globalThis.localStorage = getLocalStorage();
globalThis.sessionStorage = getSessionStorage();
// @ts-ignore
globalThis.Storage = StorageCtor;
