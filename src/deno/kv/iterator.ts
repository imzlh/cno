/**
 * Deno KV List Iterator Implementation
 */

import {
    KvKey,
    deserializeKey,
    deserializeValue,
    serializeKey,
    keyStartsWith,
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
    private buffer: Deno.KvEntry<T>[] = [];
    private nextCursor: string | null = null;
    private done = false;
    private count = 0;
    private _currentCursor: string = '';

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
            this._currentCursor = serializeKey(entry.key as KvKey);
            return { done: false, value: entry };
        }

        return { done: true, value: undefined };
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<Deno.KvEntry<T>> {
        return this;
    }

    private async fetchBatch(): Promise<void> {
        let startKey: string;
        let endKey: string;

        if ('prefix' in this.selector) {
            const prefixKey = serializeKey(this.selector.prefix);
            
            if ('start' in this.selector && this.selector.start) {
                startKey = serializeKey(this.selector.start);
            } else {
                startKey = prefixKey;
            }
            
            if ('end' in this.selector && this.selector.end) {
                endKey = serializeKey(this.selector.end);
            } else {
                endKey = getEndKeyForPrefix(prefixKey);
            }
        } else if (this.selector.start && this.selector.end) {
            startKey = serializeKey(this.selector.start);
            endKey = serializeKey(this.selector.end);
        } else {
            startKey = '\x00';
            endKey = '\u{10FFFF}';
        }

        const batchLimit = Math.min(
            this.options.batchSize,
            this.options.limit - this.count
        );
        
        if (batchLimit <= 0) {
            this.done = true;
            return;
        }

        const result = this.db.list(startKey, endKey, {
            reverse: this.options.reverse,
            limit: batchLimit,
            cursor: this.nextCursor || undefined,
        });

        let entries = result.entries;
        
        if ('prefix' in this.selector) {
            const prefixKey = this.selector.prefix;
            entries = entries.filter(e => {
                const key = deserializeKey(e.key);
                return keyStartsWith(key, prefixKey);
            });
        }

        this.buffer = entries
            .filter(e => e.expireAt === null || e.expireAt > Date.now())
            .map(e => ({
                key: deserializeKey(e.key),
                value: deserializeValue<T>(e.value),
                versionstamp: e.versionstamp,
            }));

        if (result.cursor) {
            this.nextCursor = result.cursor;
        } else {
            this.done = true;
        }

        if (entries.length === 0) {
            this.done = true;
        }
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
