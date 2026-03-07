/**
 * Deno KV Database Implementation using SQLite3
 */

const sqlite3 = import.meta.use('sqlite3');
const fs = import.meta.use('fs');

import {
    KvKey,
    KvKeyPart,
    RawKey,
    InternalEntry,
    serializeKey,
    deserializeKey,
    serializeValue,
    deserializeValue,
    generateVersionstamp,
    keyStartsWith,
    validateKey,
    validateValue,
} from './types';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS kv_entries (
    key TEXT PRIMARY KEY,
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
const LIST_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key >= ? AND key < ? ORDER BY key ASC`;
const LIST_REVERSE_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key >= ? AND key < ? ORDER BY key DESC`;

export class KvDatabase {
    private db: CModuleSQLite3.Sqlite3Handle | null = null;
    private path: string;
    private isMemory: boolean;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

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
        this.db.exec('PRAGMA cache_size = -64000');
        this.db.exec('PRAGMA temp_store = MEMORY');

        this.db.exec(CREATE_TABLE_SQL);

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

    private cleanup(): void {
        try {
            const now = Date.now();
            const db = this.getDb();
            const stmt = db.prepare(CLEANUP_SQL);
            stmt.run([now]);
            stmt.finalize();
        } catch {
            // Ignore cleanup errors
        }
    }

    get(rawKey: RawKey): InternalEntry | null {
        this.cleanup();
        return this._getInternal(rawKey);
    }

    private _getInternal(rawKey: RawKey): InternalEntry | null {
        const db = this.getDb();
        const stmt = db.prepare(GET_SQL);
        const rows = stmt.all([rawKey]);
        stmt.finalize();

        if (rows.length === 0) return null;

        const row = rows[0];
        const expireAt = row.expire_at;
        
        if (expireAt !== null && expireAt < Date.now()) {
            return null;
        }

        return {
            key: row.key,
            value: new Uint8Array(row.value),
            versionstamp: row.versionstamp,
            expireAt: expireAt,
        };
    }

    set(rawKey: RawKey, value: Uint8Array, expireIn?: number): string {
        const versionstamp = generateVersionstamp();
        const expireAt = expireIn ? Date.now() + expireIn : null;

        const db = this.getDb();
        const stmt = db.prepare(SET_SQL);
        stmt.run([rawKey, value, versionstamp, expireAt]);
        stmt.finalize();

        return versionstamp;
    }

    delete(rawKey: RawKey): void {
        const db = this.getDb();
        const stmt = db.prepare(DELETE_SQL);
        stmt.run([rawKey]);
        stmt.finalize();
    }

    deletePrefix(prefix: RawKey): number {
        const endKey = getEndKeyForPrefix(prefix);
        const db = this.getDb();
        const stmt = db.prepare(DELETE_PREFIX_SQL);
        const result = stmt.run([prefix, endKey]);
        stmt.finalize();
        return result.changes || 0;
    }

    count(startKey: RawKey, endKey: RawKey): number {
        const db = this.getDb();
        const stmt = db.prepare(COUNT_SQL);
        const rows = stmt.all([startKey, endKey]);
        stmt.finalize();
        return rows[0]?.count || 0;
    }

    list(
        startKey: RawKey,
        endKey: RawKey,
        options: { reverse?: boolean; limit?: number; cursor?: string } = {}
    ): { entries: InternalEntry[]; cursor: string | null } {
        const db = this.getDb();
        const sql = options.reverse ? LIST_REVERSE_SQL : LIST_SQL;
        
        const limit = options.limit ?? 500;
        const sqlWithLimit = sql + ` LIMIT ${limit + 1}`;
        
        const stmt = db.prepare(sqlWithLimit);
        let rows = stmt.all([startKey, endKey]);
        stmt.finalize();

        const now = Date.now();
        rows = rows.filter((row: any) => {
            if (row.expire_at !== null && row.expire_at < now) {
                return false;
            }
            return true;
        });

        if (options.cursor) {
            const cursorKey = options.cursor;
            let found = false;
            rows = rows.filter((row: any) => {
                if (found) return true;
                if (options.reverse) {
                    if (row.key < cursorKey) {
                        found = true;
                        return true;
                    }
                } else {
                    if (row.key > cursorKey) {
                        found = true;
                        return true;
                    }
                }
                return false;
            });
        }

        let nextCursor: string | null = null;
        if (rows.length > limit) {
            nextCursor = rows[limit - 1].key;
            rows = rows.slice(0, limit);
        }

        const entries = rows.map((row: any) => ({
            key: row.key,
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
                        const stmt = db.prepare(SET_SQL);
                        stmt.run([op.key, op.value!, versionstamp, expireAt]);
                        stmt.finalize();
                        finalVersionstamp = versionstamp;
                        break;
                    }
                    case 'delete': {
                        const stmt = db.prepare(DELETE_SQL);
                        stmt.run([op.key]);
                        stmt.finalize();
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
                        let newValue: number | bigint;
                        
                        if (typeof currentValue === 'bigint' || typeof operand === 'bigint') {
                            newValue = BigInt(currentValue) + BigInt(operand);
                        } else {
                            newValue = currentValue + operand;
                        }
                        
                        const versionstamp = generateVersionstamp();
                        const stmt = db.prepare(SET_SQL);
                        stmt.run([op.key, serializeValue(newValue), versionstamp, null]);
                        stmt.finalize();
                        finalVersionstamp = versionstamp;
                        break;
                    }
                    case 'max': {
                        const current = this._getInternal(op.key);
                        let currentValue: number | bigint = op.operand as number | bigint;
                        
                        if (current) {
                            const val = deserializeValue(current.value);
                            if (typeof val === 'number' || typeof val === 'bigint') {
                                if (BigInt(val) > BigInt(currentValue)) {
                                    currentValue = val as number | bigint;
                                }
                            }
                        }
                        
                        const versionstamp = generateVersionstamp();
                        const stmt = db.prepare(SET_SQL);
                        stmt.run([op.key, serializeValue(currentValue), versionstamp, null]);
                        stmt.finalize();
                        finalVersionstamp = versionstamp;
                        break;
                    }
                    case 'min': {
                        const current = this._getInternal(op.key);
                        let currentValue: number | bigint = op.operand as number | bigint;
                        
                        if (current) {
                            const val = deserializeValue(current.value);
                            if (typeof val === 'number' || typeof val === 'bigint') {
                                if (BigInt(val) < BigInt(currentValue)) {
                                    currentValue = val as number | bigint;
                                }
                            }
                        }
                        
                        const versionstamp = generateVersionstamp();
                        const stmt = db.prepare(SET_SQL);
                        stmt.run([op.key, serializeValue(currentValue), versionstamp, null]);
                        stmt.finalize();
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
    const key = prefix;
    const chars = key.split('');
    for (let i = chars.length - 1; i >= 0; i--) {
        const code = chars[i].charCodeAt(0);
        if (code < 0x10FFFF) {
            chars[i] = String.fromCharCode(code + 1);
            return chars.join('');
        }
    }
    return key + '\u{10FFFF}';
}
