/**
 * Deno KV List Iterator Implementation
 */

import {
    cursorToRawKey,
    deserializeKey,
    deserializeValue,
    rawKeyToCursor,
    serializeKey,
    type InternalEntry,
    validateKey,
} from './types';
import { KvDatabase, getEndKeyForPrefix } from './db';

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
        this.options = {
            reverse: options.reverse ?? false,
            limit: options.limit ?? Infinity,
            batchSize: Math.min(options.batchSize ?? 100, 500),
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
            const entry = this.buffer.shift()!;
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
        let startKey: Uint8Array;
        let endKey: Uint8Array;

        if ('prefix' in this.selector) {
            const prefixKey = serializeKey(this.selector.prefix);
            startKey = ('start' in this.selector && this.selector.start)
                ? serializeKey(this.selector.start)
                : prefixKey;
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
                startKey = getEndKeyForPrefix(cursorKey);
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
    if ('prefix' in selector) {
        validateKey(selector.prefix);
    }
    if ('start' in selector && selector.start) {
        validateKey(selector.start);
    }
    if ('end' in selector && selector.end) {
        validateKey(selector.end);
    }

    return new KvListIterator<T>(db, selector, options);
}
