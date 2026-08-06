/**
 * Deno KV Database Implementation using SQLite3
 */

const sqlite3 = import.meta.use('sqlite3');
const fs = import.meta.use('fs');
import { getMemoryTier } from '../../utils/memory-tier';
import { toPosixPath } from '../../utils/path';

import {
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
const CLEANUP_SQL = `DELETE FROM kv_entries WHERE expire_at IS NOT NULL AND expire_at < ?`;
const DELETE_PREFIX_SQL = `DELETE FROM kv_entries WHERE key >= ? AND key < ?`;
const LIST_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key >= ? AND key < ? AND (expire_at IS NULL OR expire_at > ?) ORDER BY key ASC LIMIT ?`;
const LIST_REVERSE_SQL = `SELECT key, value, versionstamp, expire_at FROM kv_entries WHERE key >= ? AND key < ? AND (expire_at IS NULL OR expire_at > ?) ORDER BY key DESC LIMIT ?`;
const SQLITE_CACHE_SIZE_KIB = getMemoryTier() === 'low' ? -512 : getMemoryTier() === 'normal' ? -4096 : -16384;

type AtomicDbOperation =
    | { type: 'check'; key: RawKey; versionstamp: string | null }
    | { type: 'set'; key: RawKey; value: Uint8Array; expireIn?: number }
    | { type: 'delete'; key: RawKey }
    | { type: 'sum' | 'max' | 'min'; key: RawKey; operand: bigint };

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

/**
 * Split a path into a filesystem root that already exists and the segments that
 * may need creating.
 *
 * The root is never passed to mkdir. On Windows a bare drive spec is not a
 * creatable directory: `mkdir("C:")` fails EACCES and `mkdir("C:/")` fails
 * EACCES, so treating "C:" as an ordinary segment made every absolute path
 * fail to open. `fs.exists("C:")` also reports false, so an exists() guard is
 * not enough on its own.
 *
 * Handles: verbatim (`//?/D:/...`, `//./...`), UNC (`//server/share/...`),
 * drive-absolute (`C:/...`), drive-relative (`C:foo` -> root "C:"),
 * POSIX absolute (`/...`) and relative paths.
 */
function splitMkdirPath(posix: string): { root: string; parts: string[] } {
    const split = (rest: string): string[] => rest.split('/').filter(Boolean);

    // Verbatim / device namespace: \\?\D:\x, \\?\UNC\server\share\x, \\.\pipe\x
    const verbatim = posix.match(/^\/\/[?.]\//);
    if (verbatim) {
        const body = posix.slice(verbatim[0].length);
        const unc = body.match(/^UNC\/[^/]+\/[^/]+/i);
        if (unc) {
            return { root: `${verbatim[0]}${unc[0]}/`, parts: split(body.slice(unc[0].length)) };
        }
        const drive = body.match(/^[a-zA-Z]:(?:\/|$)/);
        if (drive) {
            return { root: `${verbatim[0]}${drive[0].replace(/\/?$/, '/')}`, parts: split(body.slice(drive[0].length)) };
        }
        // Unknown device path: do not attempt to create anything under it.
        return { root: posix, parts: [] };
    }

    // UNC share root: //server/share is not creatable.
    const unc = posix.match(/^\/\/[^/]+\/[^/]+/);
    if (unc) {
        return { root: `${unc[0]}/`, parts: split(posix.slice(unc[0].length)) };
    }

    const drive = posix.match(/^[a-zA-Z]:(?:\/|$)/);
    if (drive) {
        // "C:/x" -> root "C:/". Keep the trailing slash so the first segment is
        // anchored at the drive root rather than the drive's current directory.
        return { root: drive[0].replace(/\/?$/, '/'), parts: split(posix.slice(drive[0].length)) };
    }

    // Drive-relative, e.g. "C:foo" means "foo relative to CWD on C:".
    const driveRelative = posix.match(/^[a-zA-Z]:/);
    if (driveRelative) {
        return { root: driveRelative[0], parts: split(posix.slice(driveRelative[0].length)) };
    }

    if (posix.startsWith('/')) return { root: '/', parts: split(posix) };
    return { root: '', parts: split(posix) };
}

/** True when path is a directory right now (used after a losing mkdir race). */
function isExistingDir(path: string): boolean {
    try {
        return fs.stat(path).isDirectory;
    } catch {
        return false;
    }
}

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
            const posixPath = toPosixPath(this.path);
            const dir = posixPath.substring(0, posixPath.lastIndexOf('/')) || '.';
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

        const { root, parts } = splitMkdirPath(toPosixPath(path));
        // `root` is a filesystem root (drive, UNC share, verbatim prefix or "/").
        // It always already exists and must never be passed to mkdir: on Windows
        // `mkdir("C:")` fails with EACCES, which used to make every absolute path
        // unopenable.
        let current = root;

        for (const part of parts) {
            current = current === '' || current.endsWith('/') ? `${current}${part}` : `${current}/${part}`;
            if (fs.exists(current)) continue;
            try {
                fs.mkdir(current, 0o755);
            } catch (e) {
                // Tolerate a concurrent creator, but only if a directory is there now.
                if (!isExistingDir(current)) throw e;
            }
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

            const legacyRows = rows.filter(isLegacyKeyRow);
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
                rollbackQuietly(db);
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
        const expireAt = readNullableNumber(row, 'expire_at');
        if (expireAt !== null && expireAt < Date.now()) return null;

        return {
            key: readBlob(row, 'key'),
            value: readBlob(row, 'value'),
            versionstamp: readString(row, 'versionstamp'),
            expireAt,
        };
    }

    set(rawKey: RawKey, value: Uint8Array, expireIn?: number, versionstamp = generateVersionstamp()): string {
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
                        const expireAt = op.expireIn ? Date.now() + op.expireIn : null;
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
