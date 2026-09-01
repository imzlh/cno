/**
 * Deno KV Database Implementation using SQLite3
 */

const sqlite3 = import.meta.use('sqlite3');
import { getMemoryTier } from '../../utils/memory-tier';
import { dirname } from '../../utils/path';
import { ensureDirectorySync } from '../../utils/fs-path';

import {
    type AtomicDbOperation,
    InternalEntry,
    RawKey,
    compareRawKeys,
    cursorToRawKey,
    deserializeLegacyKey,
    deserializeValue,
    generateVersionstamp,
    serializeKey,
    serializeValue
} from './types';
import { KvU64, MAX_U64, isKvU64 } from './u64';

const { setInterval, clearInterval } = import.meta.use('timers');

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS kv_entries (
    key BLOB PRIMARY KEY,
    value BLOB NOT NULL,
    versionstamp TEXT NOT NULL,
    expire_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_expire ON kv_entries(expire_at);
CREATE INDEX IF NOT EXISTS idx_created ON kv_entries(created_at);
`;

const GET_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key = ?`;
const SET_SQL = `INSERT OR REPLACE INTO kv_entries (key, value, versionstamp, expire_at, created_at) VALUES (?, ?, ?, ?, strftime('%s', 'now') * 1000)`;
const DELETE_SQL = `DELETE FROM kv_entries WHERE key = ?`;
const COUNT_SQL = `SELECT COUNT(*) as count FROM kv_entries WHERE key >= ? AND key < ?`;
const CLEANUP_SQL = `DELETE FROM kv_entries WHERE expire_at IS NOT NULL AND expire_at <= ?`;
const DELETE_PREFIX_SQL = `DELETE FROM kv_entries WHERE key >= ? AND key < ?`;
const LIST_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key >= ? AND key < ? AND (expire_at IS NULL OR expire_at > ?) ORDER BY key ASC LIMIT ?`;
const LIST_REVERSE_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key >= ? AND key < ? AND (expire_at IS NULL OR expire_at > ?) ORDER BY key DESC LIMIT ?`;
const SQLITE_CACHE_SIZE_KIB = getMemoryTier() === 'low' ? -512 : getMemoryTier() === 'normal' ? -4096 : -16384;

function isLegacyKeyRow(row: CModuleSQLite3.SqliteRow): row is CModuleSQLite3.SqliteRow & { key: string } {
    return typeof row.key === 'string';
}

function rollbackQuietly(db: CModuleSQLite3.Sqlite3Handle): void {
    try {
        db.exec('ROLLBACK');
    } catch {
        // Keep the original transaction failure as the actionable error.
    }
}

function readBlob(row: CModuleSQLite3.SqliteRow, column: string): Uint8Array<ArrayBuffer> {
    const value = row[column];
    if (value instanceof Uint8Array) {
        const out = new Uint8Array(value.byteLength);
        out.set(value);
        return out;
    }
    throw new TypeError(`Expected blob column: ${column}`);
}

function readString(row: CModuleSQLite3.SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value === 'string') return value;
    throw new TypeError(`Expected text column: ${column}`);
}

function readNullableNumber(row: CModuleSQLite3.SqliteRow, column: string): number | null {
    const value = row[column];
    if (value === null) return null;
    if (typeof value === 'number') return value;
    throw new TypeError(`Expected integer column: ${column}`);
}

function readNumber(row: CModuleSQLite3.SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value === 'number') return value;
    throw new TypeError(`Expected number column: ${column}`);
}

export class KvDatabase {
    private db: CModuleSQLite3.Sqlite3Handle | null = null;
    private openPromise: Promise<void> | null = null;
    private path: string;
    private isMemory: boolean;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    private stmtCache = new Map<string, CModuleSQLite3.Sqlite3Stmt>();
    private lastCleanupAt = 0;

    constructor(dbPath?: string) {
        if (dbPath === undefined || dbPath === '') {
            this.path = ':memory:';
            this.isMemory = true;
        } else {
            this.path = dbPath;
            this.isMemory = false;
        }
    }

    async open(): Promise<void> {
        if (this.db) return;
        if (this.openPromise) return this.openPromise;

        const openPromise = this.openOnce();
        this.openPromise = openPromise;
        try {
            await openPromise;
        } finally {
            if (this.openPromise === openPromise) this.openPromise = null;
        }
    }

    private async openOnce(): Promise<void> {
        if (!this.isMemory) {
            const dir = dirname(this.path);
            if (dir !== '.') ensureDirectorySync(dir, 0o755);
        }

        const flags = sqlite3.O_CREATE | sqlite3.O_READWRITE;
        const db = sqlite3.open(this.path, flags);
        this.db = db;

        try {
            db.exec('PRAGMA journal_mode = WAL');
            db.exec('PRAGMA synchronous = NORMAL');
            db.exec(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_KIB}`);
            db.exec('PRAGMA temp_store = MEMORY');

            db.exec(CREATE_TABLE_SQL);
            this.migrateLegacyKeys();
            this.cleanup();

            this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
        } catch (error) {
            this.close();
            throw error;
        }
    }

    close(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        for (const stmt of this.stmtCache.values()) {
            try {
                stmt.finalize();
            } catch {
                // Ignore finalize errors during close.
            }
        }
        this.stmtCache.clear();
        if (this.db) {
            try {
                this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            } catch {
                // Ignore checkpoint errors
            }
            this.db.close();
            this.db = null;
        }
    }

    private getDb(): CModuleSQLite3.Sqlite3Handle {
        if (!this.db) throw new Error('Database not open');
        return this.db;
    }

    private getStmt(sql: string): CModuleSQLite3.Sqlite3Stmt {
        let stmt = this.stmtCache.get(sql);
        if (!stmt) {
            stmt = this.getDb().prepare(sql);
            this.stmtCache.set(sql, stmt);
        }
        return stmt;
    }

    private cleanup(): void {
        try {
            const now = Date.now();
            if (now - this.lastCleanupAt < 60_000) return;
            this.lastCleanupAt = now;
            const stmt = this.getStmt(CLEANUP_SQL);
            stmt.run([now]);
        } catch {
            // Ignore cleanup errors
        }
    }

    private migrateLegacyKeys(): void {
        try {
            const db = this.getDb();
            const stmt = db.prepare(`SELECT key, value, versionstamp, expire_at, created_at FROM kv_entries`);
            let rows: CModuleSQLite3.SqliteRow[];
            try {
                rows = stmt.all();
            } finally {
                stmt.finalize();
            }

            const legacyRows = rows.filter(isLegacyKeyRow);
            if (!legacyRows.length) return;

            db.exec('BEGIN IMMEDIATE');
            let del: CModuleSQLite3.Sqlite3Stmt | null = null;
            let ins: CModuleSQLite3.Sqlite3Stmt | null = null;
            try {
                del = db.prepare(`DELETE FROM kv_entries WHERE key = ?`);
                ins = db.prepare(`INSERT OR REPLACE INTO kv_entries (key, value, versionstamp, expire_at, created_at) VALUES (?, ?, ?, ?, ?)`);
                for (const row of legacyRows) {
                    const key = serializeKey(deserializeLegacyKey(row.key));
                    del.run([row.key]);
                    ins.run([key, row.value, row.versionstamp, row.expire_at, row.created_at]);
                }
                db.exec('COMMIT');
            } catch (error) {
                rollbackQuietly(db);
                throw error;
            } finally {
                try {
                    del?.finalize();
                } catch {
                    // Preserve the migration result when statement cleanup fails.
                }
                try {
                    ins?.finalize();
                } catch {
                    // Preserve the migration result when statement cleanup fails.
                }
            }
        } catch {
            // Ignore migration failures and continue with existing data.
        }
    }

    get(rawKey: RawKey): InternalEntry | null {
        const now = Date.now();
        if (now - this.lastCleanupAt >= 60_000) {
            this.cleanup();
        }
        return this._getInternal(rawKey);
    }

    private _getInternal(rawKey: RawKey): InternalEntry | null {
        const stmt = this.getStmt(GET_SQL);
        const rows = stmt.all([rawKey]);

        if (rows.length === 0) return null;

        const row = rows[0];
        const expireAt = readNullableNumber(row, 'expire_at');
        if (expireAt !== null && expireAt <= Date.now()) return null;

        return {
            key: readBlob(row, 'key'),
            value: readBlob(row, 'value'),
            versionstamp: readString(row, 'versionstamp'),
            expireAt,
        };
    }

    set(rawKey: RawKey, value: Uint8Array, expireIn?: number, versionstamp = generateVersionstamp()): string {
        const expireAt = expireIn === undefined ? null : Date.now() + expireIn;

        const stmt = this.getStmt(SET_SQL);
        stmt.run([rawKey, value, versionstamp, expireAt]);

        return versionstamp;
    }

    delete(rawKey: RawKey): void {
        const stmt = this.getStmt(DELETE_SQL);
        stmt.run([rawKey]);
    }

    deletePrefix(prefix: RawKey): number {
        const db = this.getDb();
        const endKey = getEndKeyForPrefix(prefix);
        const stmt = this.getStmt(DELETE_PREFIX_SQL);
        stmt.run([prefix, endKey]);
        return db.changes();
    }

    count(startKey: RawKey, endKey: RawKey): number {
        const stmt = this.getStmt(COUNT_SQL);
        const rows = stmt.all([startKey, endKey]);
        return rows[0] ? readNumber(rows[0], 'count') : 0;
    }

    list(
        startKey: RawKey,
        endKey: RawKey,
        options: { reverse?: boolean; limit?: number; cursor?: string } = {}
    ): { entries: InternalEntry[]; cursor: RawKey | null } {
        const limit = options.limit ?? 500;
        const stmt = this.getStmt(options.reverse ? LIST_REVERSE_SQL : LIST_SQL);
        const now = Date.now();
        let rows = stmt.all([startKey, endKey, now, limit + 1]);

        if (options.cursor) {
            const cursorKey = cursorToRawKey(options.cursor);
            rows = rows.filter((row) => {
                const key = readBlob(row, 'key');
                return options.reverse
                    ? compareRawKeys(key, cursorKey) < 0
                    : compareRawKeys(key, cursorKey) > 0;
            });
        }

        let nextCursor: RawKey | null = null;
        if (rows.length > limit) {
            nextCursor = readBlob(rows[limit - 1], 'key');
            rows = rows.slice(0, limit);
        }

        const entries = rows.map((row) => ({
            key: readBlob(row, 'key'),
            value: readBlob(row, 'value'),
            versionstamp: readString(row, 'versionstamp'),
            expireAt: readNullableNumber(row, 'expire_at'),
        }));

        return { entries, cursor: nextCursor };
    }

    atomic(operations: AtomicDbOperation[], commitVersionstamp?: string): { success: boolean; versionstamp?: string } {
        const db = this.getDb();
        const setStmt = this.getStmt(SET_SQL);
        const deleteStmt = this.getStmt(DELETE_SQL);

        db.exec('BEGIN IMMEDIATE');

        try {
            let finalVersionstamp = '';
            const mutationVersionstamp = commitVersionstamp ?? generateVersionstamp();

            for (const op of operations) {
                switch (op.type) {
                    case 'check': {
                        const current = this._getInternal(op.key);
                        const currentVersionstamp = current?.versionstamp ?? null;
                        if (currentVersionstamp !== op.versionstamp) {
                            db.exec('ROLLBACK');
                            return { success: false };
                        }
                        break;
                    }
                    case 'set': {
                        const expireAt = op.expireIn === undefined ? null : Date.now() + op.expireIn;
                        setStmt.run([op.key, op.value, mutationVersionstamp, expireAt]);
                        finalVersionstamp = mutationVersionstamp;
                        break;
                    }
                    case 'delete': {
                        deleteStmt.run([op.key]);
                        finalVersionstamp = mutationVersionstamp;
                        break;
                    }
                    case 'sum': {
                        if (typeof op.operand !== 'bigint') {
                            throw new TypeError("Failed to perform 'sum' mutation on a non-U64 operand");
                        }
                        const current = this._getInternal(op.key);
                        let currentValue = 0n;
                        if (current) {
                            const val = deserializeValue(current.value);
                            if (!isKvU64(val)) {
                                throw new TypeError("Failed to perform 'sum' mutation on a non-U64 value in the database");
                            }
                            currentValue = val.value;
                        }
                        const newValue = (currentValue + op.operand) & MAX_U64;
                        setStmt.run([op.key, serializeValue(new KvU64(newValue)), mutationVersionstamp, null]);
                        finalVersionstamp = mutationVersionstamp;
                        break;
                    }
                    case 'max': {
                        if (typeof op.operand !== 'bigint') {
                            throw new TypeError("Failed to perform 'max' mutation on a non-U64 operand");
                        }
                        const current = this._getInternal(op.key);
                        let currentValue = op.operand;
                        if (current) {
                            const val = deserializeValue(current.value);
                            if (!isKvU64(val)) {
                                throw new TypeError("Failed to perform 'max' mutation on a non-U64 value in the database");
                            }
                            if (val.value > currentValue) {
                                currentValue = val.value;
                            }
                        }
                        setStmt.run([op.key, serializeValue(new KvU64(currentValue)), mutationVersionstamp, null]);
                        finalVersionstamp = mutationVersionstamp;
                        break;
                    }
                    case 'min': {
                        if (typeof op.operand !== 'bigint') {
                            throw new TypeError("Failed to perform 'min' mutation on a non-U64 operand");
                        }
                        const current = this._getInternal(op.key);
                        let currentValue = op.operand;
                        if (current) {
                            const val = deserializeValue(current.value);
                            if (!isKvU64(val)) {
                                throw new TypeError("Failed to perform 'min' mutation on a non-U64 value in the database");
                            }
                            if (val.value < currentValue) {
                                currentValue = val.value;
                            }
                        }
                        setStmt.run([op.key, serializeValue(new KvU64(currentValue)), mutationVersionstamp, null]);
                        finalVersionstamp = mutationVersionstamp;
                        break;
                    }
                }
            }

            db.exec('COMMIT');
            return {
                success: true,
                versionstamp: finalVersionstamp || '00000000000000000000'
            };
        } catch (err) {
            rollbackQuietly(db);
            throw err;
        }
    }
}

export function getEndKeyForPrefix(prefix: RawKey): RawKey {
    const key = prefix.slice();
    for (let i = key.length - 1; i >= 0; i--) {
        if (key[i] < 0xFF) {
            key[i]++;
            return key.slice(0, i + 1);
        }
    }
    return new Uint8Array([...key, 0xFF]);
}
