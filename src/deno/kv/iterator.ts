/**
 * Deno KV List Iterator Implementation
 */

import {
    cursorToRawKey,
    compareKeys,
    deserializeKey,
    deserializeValue,
    keyStartsWith,
    rawKeyToCursor,
    serializeKey,
    type RawKey,
    type InternalEntry,
    validateKey,
} from './types';
import { KvDatabase, getEndKeyForPrefix } from './db';

function keyAfter(rawKey: RawKey): RawKey {
    const out = new Uint8Array(rawKey.byteLength + 1);
    out.set(rawKey);
    return out;
}

export class KvListIterator<T = unknown> implements AsyncIterableIterator<Deno.KvEntry<T>> {
    private db: KvDatabase;
    private selector: Deno.KvListSelector;
    private options: {
        reverse: boolean;
        limit: number;
        batchSize: number;
        consistency: 'strong' | 'eventual';
        cursor?: string;
    };
    private buffer: InternalEntry[] = [];
    private nextCursor: string | null = null;
    private done = false;
    private count = 0;
    private _currentCursor = '';

    constructor(db: KvDatabase, selector: Deno.KvListSelector, options: Deno.KvListOptions = {}) {
        this.db = db;
        this.selector = selector;
        const defaultBatchSize = options.limit === undefined ? 100 : Math.min(options.limit, 500);
        this.options = {
            reverse: options.reverse ?? false,
            limit: options.limit ?? Infinity,
            batchSize: options.batchSize ?? defaultBatchSize,
            cursor: options.cursor,
            consistency: options.consistency ?? 'strong',
        };
        this.nextCursor = options.cursor ?? null;
    }

    get cursor(): string {
        return this._currentCursor;
    }

    async next(): Promise<IteratorResult<Deno.KvEntry<T>, undefined>> {
        if (this.count >= this.options.limit) {
            return { done: true, value: undefined };
        }

        if (this.buffer.length === 0 && !this.done) {
            await this.fetchBatch();
        }

        if (this.buffer.length > 0) {
            const entry = this.buffer.shift();
            if (entry === undefined) return { done: true, value: undefined };
            this.count++;
            this._currentCursor = rawKeyToCursor(entry.key);
            return {
                done: false,
                value: {
                    key: deserializeKey(entry.key),
                    value: deserializeValue<T>(entry.value),
                    versionstamp: entry.versionstamp,
                }
            };
        }

        return { done: true, value: undefined };
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<Deno.KvEntry<T>> {
        return this;
    }

    private async fetchBatch(): Promise<void> {
        let startKey: RawKey;
        let endKey: RawKey;

        if ('prefix' in this.selector) {
            const prefixKey = serializeKey(this.selector.prefix);
            startKey = ('start' in this.selector && this.selector.start)
                ? serializeKey(this.selector.start)
                : (this.selector.prefix.length === 0 ? prefixKey : keyAfter(prefixKey));
            endKey = ('end' in this.selector && this.selector.end)
                ? serializeKey(this.selector.end)
                : getEndKeyForPrefix(prefixKey);
        } else if (this.selector.start && this.selector.end) {
            startKey = serializeKey(this.selector.start);
            endKey = serializeKey(this.selector.end);
        } else {
            startKey = new Uint8Array(0);
            endKey = new Uint8Array([0xFF]);
        }

        if (this.nextCursor) {
            const cursorKey = cursorToRawKey(this.nextCursor);
            if (this.options.reverse) {
                endKey = cursorKey;
            } else {
                startKey = keyAfter(cursorKey);
            }
        }

        const batchLimit = Math.min(this.options.batchSize, this.options.limit - this.count);
        if (batchLimit <= 0) {
            this.done = true;
            return;
        }

        const result = this.db.list(startKey, endKey, {
            reverse: this.options.reverse,
            limit: batchLimit,
        });

        this.buffer = result.entries;

        this.nextCursor = result.cursor ? rawKeyToCursor(result.cursor) : null;
        this.done = !result.cursor || this.buffer.length === 0;
    }
}

export function createListIterator<T = unknown>(
    db: KvDatabase,
    selector: Deno.KvListSelector,
    options?: Deno.KvListOptions
): Deno.KvListIterator<T> {
    if (options?.batchSize !== undefined) {
        if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
            throw new TypeError('batchSize must be a positive integer');
        }
        if (options.batchSize > 1000) {
            throw new TypeError('Too many entries (max 1000)');
        }
    }
    if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
        throw new TypeError('limit must be a non-negative integer');
    }

    const hasPrefix = 'prefix' in selector;
    const hasStart = 'start' in selector;
    const hasEnd = 'end' in selector;

    if (hasPrefix) {
        validateKey(selector.prefix, { allowEmpty: true });
        if (hasStart && hasEnd) {
            throw new TypeError('Invalid list selector');
        }
        if (hasStart) {
            validateKey(selector.start);
            if (!keyStartsWith(selector.start, selector.prefix) || selector.start.length === selector.prefix.length) {
                throw new TypeError('Start key is not in the keyspace defined by prefix');
            }
        }
        if (hasEnd) {
            validateKey(selector.end);
            if (!keyStartsWith(selector.end, selector.prefix) || selector.end.length === selector.prefix.length) {
                throw new TypeError('End key is not in the keyspace defined by prefix');
            }
        }
    } else {
        if (!hasStart || !hasEnd) {
            throw new TypeError('Invalid list selector');
        }
        validateKey(selector.start);
        validateKey(selector.end);
        if (compareKeys(selector.start, selector.end) > 0) {
            throw new TypeError('Start key is greater than end key');
        }
    }

    return new KvListIterator<T>(db, selector, options);
}
