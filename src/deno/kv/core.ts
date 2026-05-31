/**
 * Deno KV Implementation
 */
import {
    KvKey, KvEntryMaybe, KvSetOptions,
    KvQueueOptions, serializeKey, serializeValue,
    deserializeValue,
    rawKeyToCursor,
    validateKey,
    validateValue
} from './types';
import { KvDatabase } from './db';
import { createListIterator } from './iterator';
import { AtomicOperation } from './atomic';

const QUEUE_PREFIX = '__kv_queue__';
const MAX_QUEUE_DELAY = 30 * 24 * 60 * 60 * 1000; // 30 days
const { setInterval, clearInterval } = import.meta.use('timers');

interface WatchSubscription {
    keys: KvKey[];
    controller: ReadableStreamDefaultController<KvEntryMaybe<unknown>[]>;
    lastValues: Map<string, { versionstamp: string | null; value: unknown }>;
}

interface QueueEntry {
    id: string;
    data: unknown;
    retryCount: number;
    scheduledAt: number;
    undeliveredKeys?: KvKey[];
    backoffSchedule?: number[];
}

export class Kv implements Deno.Kv {
    private db: KvDatabase;
    private _closed = false;
    private queueHandlers: Array<(msg: unknown) => void | Promise<void>> = [];
    private watchSubscriptions: Set<WatchSubscription> = new Set();
    private queueProcessingInterval: ReturnType<typeof setInterval> | null = null;
    private pendingDeliveries: Map<string, Promise<void>> = new Map();
    private listenQueueResolvers: Array<() => void> = [];

    constructor(dbPath?: string) {
        this.db = new KvDatabase(dbPath);
    }

    async open(): Promise<void> {
        await this.db.open();
        this.startQueueProcessing();
    }

    private startQueueProcessing(): void {
        this.queueProcessingInterval = setInterval(() => {
            this.processDelayedQueue();
        }, 1000);
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        
        if (this.queueProcessingInterval) {
            clearInterval(this.queueProcessingInterval);
            this.queueProcessingInterval = null;
        }

        for (const sub of this.watchSubscriptions) {
            try {
                sub.controller.close();
            } catch {
                // Ignore
            }
        }
        this.watchSubscriptions.clear();
        
        this.queueHandlers = [];
        this.pendingDeliveries.clear();
        
        this.db.close();
    }

    get closed(): boolean {
        return this._closed;
    }

    private checkClosed(): void {
        if (this._closed) {
            throw new Error('KV database is closed');
        }
    }

    commitVersionstamp(): symbol {
        return Symbol('commitVersionstamp');
    }

    [Symbol.dispose](): void {
        this.close();
    }

    get<T = unknown>(key: KvKey, options?: { consistency?: Deno.KvConsistencyLevel }): Promise<Deno.KvEntryMaybe<T>> {
        this.checkClosed();
        validateKey(key);
        
        const rawKey = serializeKey(key);
        const entry = this.db.get(rawKey);
        
        if (entry) {
            return Promise.resolve({
                key,
                value: deserializeValue<T>(entry.value),
                versionstamp: entry.versionstamp,
            });
        } else {
            return Promise.resolve({
                key,
                value: null,
                versionstamp: null,
            });
        }
    }

    getMany<T extends readonly unknown[]>(
        keys: readonly [...{ [K in keyof T]: KvKey }],
        options?: { consistency?: Deno.KvConsistencyLevel }
    ): Promise<{ [K in keyof T]: Deno.KvEntryMaybe<T[K]> }> {
        this.checkClosed();
        
        for (const key of keys) {
            validateKey(key);
        }
        
        const results = keys.map(key => {
            const rawKey = serializeKey(key);
            const entry = this.db.get(rawKey);
            
            if (entry) {
                return {
                    key,
                    value: deserializeValue(entry.value),
                    versionstamp: entry.versionstamp,
                };
            } else {
                return {
                    key,
                    value: null,
                    versionstamp: null,
                };
            }
        });
        
        return Promise.resolve(results as any);
    }

    set(key: KvKey, value: unknown, options?: KvSetOptions): Promise<{ ok: true; versionstamp: string }> {
        this.checkClosed();
        validateKey(key);
        validateValue(value);
        
        if (options?.expireIn !== undefined) {
            if (options.expireIn < 0) {
                throw new TypeError('expireIn must be non-negative');
            }
            if (options.expireIn > MAX_QUEUE_DELAY) {
                throw new TypeError('expireIn cannot exceed 30 days');
            }
        }
        
        const rawKey = serializeKey(key);
        const serializedValue = serializeValue(value);
        const versionstamp = this.db.set(rawKey, serializedValue, options?.expireIn);
        
        this.notifyWatchers(key);
        
        return Promise.resolve({ ok: true, versionstamp });
    }

    delete(key: KvKey): Promise<void> {
        this.checkClosed();
        validateKey(key);
        
        const rawKey = serializeKey(key);
        this.db.delete(rawKey);
        
        this.notifyWatchers(key);
        
        return Promise.resolve();
    }

    list<T = unknown>(selector: Deno.KvListSelector, options?: Deno.KvListOptions): Deno.KvListIterator<T> {
        this.checkClosed();
        
        return createListIterator<T>(this.db, selector, options);
    }

    atomic(): Deno.AtomicOperation {
        this.checkClosed();
        
        return new AtomicOperation(this.db);
    }

    enqueue(data: unknown, options?: KvQueueOptions): Promise<Deno.KvCommitResult> {
        this.checkClosed();
        validateValue(data);
        
        const id = crypto.randomUUID();
        const delay = Math.min(options?.delay ?? 0, MAX_QUEUE_DELAY);
        const scheduledAt = Date.now() + delay;
        
        const queueEntry: QueueEntry = {
            id,
            data,
            retryCount: 0,
            scheduledAt,
            undeliveredKeys: options?.keysIfUndelivered,
            backoffSchedule: options?.backoffSchedule ?? [100, 200, 400, 800],
        };
        
        const queueKey: KvKey = [QUEUE_PREFIX, scheduledAt, id];
        const versionstamp = this.db.set(serializeKey(queueKey), serializeValue(queueEntry), delay + 86400000);
        
        if (delay === 0) {
            queueMicrotask(() => this.deliverMessage(queueEntry));
        }
        
        return Promise.resolve({ ok: true, versionstamp });
    }

    listenQueue(handler: (value: unknown) => Promise<void> | void): Promise<void> {
        this.checkClosed();
        
        this.queueHandlers.push(handler);
        
        return new Promise(() => {});
    }

    watch<T extends readonly unknown[]>(
        keys: readonly [...{ [K in keyof T]: KvKey }],
        options?: { raw?: boolean }
    ): ReadableStream<{ [K in keyof T]: Deno.KvEntryMaybe<T[K]> }> {
        this.checkClosed();
        
        for (const key of keys) {
            validateKey(key);
        }
        
        const self = this;
        let subscription: WatchSubscription | null = null;
        
        return new ReadableStream({
            start(controller) {
                const lastValues = new Map<string, { versionstamp: string | null; value: unknown }>();
                
                subscription = {
                    keys: keys as KvKey[],
                    controller: controller as ReadableStreamDefaultController<KvEntryMaybe<unknown>[]>,
                    lastValues,
                };
                
                self.watchSubscriptions.add(subscription);
                
                const initialValues = keys.map(key => {
                    const rawKey = serializeKey(key);
                    const keyId = rawKeyToCursor(rawKey);
                    const entry = self.db.get(rawKey);
                    
                    let value: KvEntryMaybe<unknown>;
                    if (entry) {
                        const deserializedValue = deserializeValue(entry.value);
                        value = {
                            key,
                            value: deserializedValue,
                            versionstamp: entry.versionstamp,
                        };
                        lastValues.set(keyId, { versionstamp: entry.versionstamp, value: deserializedValue });
                    } else {
                        value = {
                            key,
                            value: null,
                            versionstamp: null,
                        };
                        lastValues.set(keyId, { versionstamp: null, value: null });
                    }
                    
                    return value;
                });
                
                try {
                    controller.enqueue(initialValues as any);
                } catch {
                    // Stream might be cancelled
                }
            },
            cancel() {
                if (subscription) {
                    self.watchSubscriptions.delete(subscription);
                }
            }
        });
    }

    private async deliverMessage(entry: QueueEntry): Promise<void> {
        if (this._closed || this.queueHandlers.length === 0) return;
        
        for (const handler of this.queueHandlers) {
            try {
                await handler(entry.data);
                return;
            } catch (err) {
                console.error('Queue handler error:', err);
                if (entry.undeliveredKeys && entry.undeliveredKeys.length > 0) {
                    const backoffSchedule = entry.backoffSchedule ?? [100, 200, 400, 800];
                    const nextRetry = entry.retryCount + 1;
                    
                    if (nextRetry <= backoffSchedule.length) {
                        const delay = backoffSchedule[nextRetry - 1];
                        const newEntry: QueueEntry = {
                            ...entry,
                            retryCount: nextRetry,
                            scheduledAt: Date.now() + delay,
                        };
                        
                        const queueKey: KvKey = [QUEUE_PREFIX, newEntry.scheduledAt, entry.id];
                        this.db.set(serializeKey(queueKey), serializeValue(newEntry), delay + 86400000);
                    } else {
                        for (const key of entry.undeliveredKeys) {
                            try {
                                await this.set(key, { undelivered: entry.data, id: entry.id });
                            } catch {
                                // Ignore
                            }
                        }
                    }
                }
            }
        }
    }

    private async processDelayedQueue(): Promise<void> {
        if (this._closed) return;
        
        const now = Date.now();
        const prefix: KvKey = [QUEUE_PREFIX];
        const endPrefix: KvKey = [QUEUE_PREFIX, now + 1];
        
        const iterator = createListIterator<QueueEntry>(this.db, {
            prefix,
            end: endPrefix,
        });
        
        try {
            for await (const entry of iterator) {
                const queueEntry = entry.value;
                if (queueEntry.scheduledAt <= now) {
                    const deliveryKey = `${queueEntry.id}:${queueEntry.retryCount}`;
                    if (!this.pendingDeliveries.has(deliveryKey)) {
                        const promise = this.deliverMessage(queueEntry)
                            .finally(() => {
                                this.pendingDeliveries.delete(deliveryKey);
                            });
                        this.pendingDeliveries.set(deliveryKey, promise);
                        
                        this.db.delete(serializeKey(entry.key as KvKey));
                    }
                }
            }
        } catch {
            // Ignore processing errors
        }
    }

    private notifyWatchers(changedKey: KvKey): void {
        const rawChangedKey = serializeKey(changedKey);
        const changedKeyId = rawKeyToCursor(rawChangedKey);
        
        for (const sub of this.watchSubscriptions) {
            try {
                const keyIndex = sub.keys.findIndex(k => rawKeyToCursor(serializeKey(k)) === changedKeyId);
                if (keyIndex === -1) continue;
                
                const entry = this.db.get(rawChangedKey);
                const lastValue = sub.lastValues.get(changedKeyId);
                
                const newVersionstamp = entry?.versionstamp ?? null;
                if (lastValue && lastValue.versionstamp === newVersionstamp) {
                    continue;
                }
                
                const values = sub.keys.map(key => {
                    const rawKey = serializeKey(key);
                    const keyId = rawKeyToCursor(rawKey);
                    const e = this.db.get(rawKey);
                    
                    if (e) {
                        const v = deserializeValue(e.value);
                        sub.lastValues.set(keyId, { versionstamp: e.versionstamp, value: v });
                        return { key, value: v, versionstamp: e.versionstamp };
                    } else {
                        sub.lastValues.set(keyId, { versionstamp: null, value: null });
                        return { key, value: null, versionstamp: null };
                    }
                });
                
                sub.controller.enqueue(values);
            } catch {
                // Controller might be closed
            }
        }
    }
}

export * from './types';
