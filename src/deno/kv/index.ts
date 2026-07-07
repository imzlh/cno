/**
 * Deno KV Module
 * 
 * Usage:
 * ```ts
 * const kv = await Deno.openKv();
 * await kv.set(["users", "alice"], { name: "Alice", age: 30 });
 * const entry = await kv.get(["users", "alice"]);
 * console.log(entry.value); // { name: "Alice", age: 30 }
 * 
 * // Atomic operations
 * const result = await kv.atomic()
 *   .check({ key: ["users", "alice"], versionstamp: entry.versionstamp })
 *   .set(["users", "alice"], { name: "Alice", age: 31 })
 *   .commit();
 * 
 * // List entries
 * for await (const entry of kv.list({ prefix: ["users"] })) {
 *   console.log(entry.key, entry.value);
 * }
 * ```
 */

import { Kv } from './core';
import { KvListIterator } from './iterator';
import { AtomicOperation } from './atomic';
import { KvU64 } from './u64';
const console = import.meta.use('console');

export { Kv, KvListIterator, AtomicOperation, KvU64 };
export * from './types';
export * from './u64';

const DEFAULT_KV_PATH = '.deno/kv.db.cnodb';

function normalizeKvPath(path?: string): string {
    if (path === undefined) return DEFAULT_KV_PATH;
    if (path === '') throw new TypeError('Filename cannot be empty');
    if (path === ':memory:') return path;
    if (path.startsWith(':')) throw new TypeError("Filename cannot start with ':' unless prefixed with './'");
    if (path.endsWith('.cnodb')) return path;
    return `${path}.cnodb`;
}

export class KvError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KvError';
    }
}

export class KvKeyError extends KvError {
    constructor(message: string) {
        super(message);
        this.name = 'KvKeyError';
    }
}

export class KvValueError extends KvError {
    constructor(message: string) {
        super(message);
        this.name = 'KvValueError';
    }
}

export class KvTransactionError extends KvError {
    constructor(message: string) {
        super(message);
        this.name = 'KvTransactionError';
    }
}

export class KvClosedError extends KvError {
    constructor() {
        super('KV database is closed');
        this.name = 'KvClosedError';
    }
}

async function openKv(path?: string): Promise<Deno.Kv> {
    const kv = new Kv(normalizeKvPath(path));
    await kv.open();
    return kv;
}

Object.assign(Deno, {
    openKv,
    KvU64,
    AtomicOperation,
});
