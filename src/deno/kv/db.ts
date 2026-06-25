/**
 * Deno KV Database Implementation using SQLite3
 */

const sqlite3 = import.meta.use('sqlite3');
const fs = import.meta.use('fs');
import { getMemoryTier } from '../../utils/memory-tier';

import {
    KvKeyPart,
    RawKey,
    InternalEntry,
    serializeValue,
    deserializeValue,
    generateVersionstamp,
    compareRawKeys,
    cursorToRawKey,
    deserializeLegacyKey,
    serializeKey,
    rawKeyToCursor,
} from './types';

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
const CLEANUP_SQL = `DELETE FROM kv_entries WHERE expire_at IS NOT NULL AND expire_at < ?`;
const DELETE_PREFIX_SQL = `DELETE FROM kv_entries WHERE key >= ? AND key < ?`;
const LIST_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key >= ? AND key < ? AND (expire_at IS NULL OR expire_at > ?) ORDER BY key ASC LIMIT ?`;
const LIST_REVERSE_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key >= ? AND key < ? AND (expire_at IS NULL OR expire_at > ?) ORDER BY key DESC LIMIT ?`;
const SQLITE_CACHE_SIZE_KIB = getMemoryTier() === 'low' ? -512 : getMemoryTier() === 'normal' ? -4096 : -16384;

export class KvDatabase {
    private db: CModuleSQLite3.Sqlite3Handle | null = null;
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
        if (!this.isMemory) {
            const dir = this.path.substring(0, this.path.lastIndexOf('/')) || '.';
            this.mkdirRecursive(dir);
        }

        const flags = sqlite3.O_CREATE | sqlite3.O_READWRITE;
        this.db = sqlite3.open(this.path, flags);

        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_KIB}`);
        this.db.exec('PRAGMA temp_store = MEMORY');

        this.db.exec(CREATE_TABLE_SQL);
        this.migrateLegacyKeys();
        this.cleanup();

        this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    }

    private mkdirRecursive(path: string): void {
        if (!path || path === '.') return;

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
            const rows = stmt.all();
            stmt.finalize();

            const legacyRows = rows.filter((row: any) => typeof row.key === 'string');
            if (!legacyRows.length) return;

            db.exec('BEGIN IMMEDIATE');
            try {
                const del = db.prepare(`DELETE FROM kv_entries WHERE key = ?`);
                const ins = db.prepare(`INSERT OR REPLACE INTO kv_entries (key, value, versionstamp, expire_at, created_at) VALUES (?, ?, ?, ?, ?)`);
                for (const row of legacyRows) {
                    const key = serializeKey(deserializeLegacyKey(row.key));
                    del.run([row.key]);
                    ins.run([key, row.value, row.versionstamp, row.expire_at, row.created_at]);
                }
                del.finalize();
                ins.finalize();
                db.exec('COMMIT');
            } catch (error) {
                try { db.exec('ROLLBACK'); } catch {}
                throw error;
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
        const expireAt = row.expire_at;
        if (expireAt !== null && expireAt < Date.now()) return null;

        return {
            key: new Uint8Array(row.key),
            value: new Uint8Array(row.value),
            versionstamp: row.versionstamp,
            expireAt,
        };
    }

    set(rawKey: RawKey, value: Uint8Array, expireIn?: number): string {
        const versionstamp = generateVersionstamp();
        const expireAt = expireIn ? Date.now() + expireIn : null;

        const stmt = this.getStmt(SET_SQL);
        stmt.run([rawKey, value, versionstamp, expireAt]);

        return versionstamp;
    }

    delete(rawKey: RawKey): void {
        const stmt = this.getStmt(DELETE_SQL);
        stmt.run([rawKey]);
    }

    deletePrefix(prefix: RawKey): number {
        const endKey = getEndKeyForPrefix(prefix);
        const stmt = this.getStmt(DELETE_PREFIX_SQL);
        const result = stmt.run([prefix, endKey]);
        return result.changes || 0;
    }

    count(startKey: RawKey, endKey: RawKey): number {
        const stmt = this.getStmt(COUNT_SQL);
        const rows = stmt.all([startKey, endKey]);
        return rows[0]?.count || 0;
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
            rows = rows.filter((row: any) => {
                const key = new Uint8Array(row.key);
                return options.reverse
                    ? compareRawKeys(key, cursorKey) < 0
                    : compareRawKeys(key, cursorKey) > 0;
            });
        }

        let nextCursor: RawKey | null = null;
        if (rows.length > limit) {
            nextCursor = new Uint8Array(rows[limit - 1].key);
            rows = rows.slice(0, limit);
        }

        const entries = rows.map((row: any) => ({
            key: new Uint8Array(row.key),
            value: new Uint8Array(row.value),
            versionstamp: row.versionstamp,
            expireAt: row.expire_at,
        }));

        return { entries, cursor: nextCursor };
    }

    atomic(operations: Array<{
        type: 'check' | 'set' | 'delete' | 'sum' | 'max' | 'min';
        key: RawKey;
        versionstamp?: string | null;
        value?: Uint8Array;
        expireIn?: number;
        operand?: KvKeyPart;
    }>): { success: boolean; versionstamp?: string } {
        const db = this.getDb();
        const setStmt = this.getStmt(SET_SQL);
        const deleteStmt = this.getStmt(DELETE_SQL);

        db.exec('BEGIN IMMEDIATE');

        try {
            let finalVersionstamp = '';

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
                        const versionstamp = generateVersionstamp();
                        const expireAt = op.expireIn ? Date.now() + op.expireIn : null;
                        setStmt.run([op.key, op.value!, versionstamp, expireAt]);
                        finalVersionstamp = versionstamp;
                        break;
                    }
                    case 'delete': {
                        deleteStmt.run([op.key]);
                        break;
                    }
                    case 'sum': {
                        const current = this._getInternal(op.key);
                        let currentValue: number | bigint = 0;
                        if (current) {
                            const val = deserializeValue(current.value);
                            if (typeof val === 'number') currentValue = val;
                            else if (typeof val === 'bigint') currentValue = val;
                        }
                        const operand = op.operand as number | bigint;
                        const newValue = (typeof currentValue === 'bigint' || typeof operand === 'bigint')
                            ? BigInt(currentValue) + BigInt(operand)
                            : currentValue + operand;
                        const versionstamp = generateVersionstamp();
                        setStmt.run([op.key, serializeValue(newValue), versionstamp, null]);
                        finalVersionstamp = versionstamp;
                        break;
                    }
                    case 'max': {
                        const current = this._getInternal(op.key);
                        let currentValue: number | bigint = op.operand as number | bigint;
                        if (current) {
                            const val = deserializeValue(current.value);
                            if ((typeof val === 'number' || typeof val === 'bigint') && BigInt(val) > BigInt(currentValue)) {
                                currentValue = val as number | bigint;
                            }
                        }
                        const versionstamp = generateVersionstamp();
                        setStmt.run([op.key, serializeValue(currentValue), versionstamp, null]);
                        finalVersionstamp = versionstamp;
                        break;
                    }
                    case 'min': {
                        const current = this._getInternal(op.key);
                        let currentValue: number | bigint = op.operand as number | bigint;
                        if (current) {
                            const val = deserializeValue(current.value);
                            if ((typeof val === 'number' || typeof val === 'bigint') && BigInt(val) < BigInt(currentValue)) {
                                currentValue = val as number | bigint;
                            }
                        }
                        const versionstamp = generateVersionstamp();
                        setStmt.run([op.key, serializeValue(currentValue), versionstamp, null]);
                        finalVersionstamp = versionstamp;
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
            try {
                db.exec('ROLLBACK');
            } catch {
                // Ignore rollback errors
            }
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
