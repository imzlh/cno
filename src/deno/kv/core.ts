/**
 * Deno KV Implementation
 */
import {
    KvKey, KvEntryMaybe, KvSetOptions,
    KvQueueOptions, serializeKey, serializeValue,
    deserializeValue,
    COMMIT_VERSIONSTAMP_KEY,
    rawKeyToCursor,
    KV_QUEUE_PREFIX,
    DEFAULT_QUEUE_BACKOFF,
    type KvQueueEntry,
    prepareQueueEntry,
    generateVersionstamp,
    resolveCommitVersionstampKey,
    validateExpireIn,
    validateKey,
    validateValue,
    type RawKey
} from './types';
import { KvDatabase } from './db';
import { createListIterator } from './iterator';
import { AtomicOperation } from './atomic';

const { setInterval, clearInterval } = import.meta.use('timers');
const console = import.meta.use('console');

interface WatchSubscription {
    keys: readonly KvKey[];
    rawKeys: RawKey[];
    keyIds: string[];
    controller: ReadableStreamDefaultController<KvEntryMaybe<unknown>[]>;
    lastValues: Map<string, { versionstamp: string | null; value: unknown }>;
}

type KvEntryTuple<T extends readonly unknown[]> = { [K in keyof T]: Deno.KvEntryMaybe<T[K]> };

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
        for (const resolve of this.listenQueueResolvers) resolve();
        this.listenQueueResolvers.length = 0;
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
        return COMMIT_VERSIONSTAMP_KEY;
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

    async getMany<T extends readonly unknown[]>(
        keys: readonly [...{ [K in keyof T]: KvKey }],
        options?: { consistency?: Deno.KvConsistencyLevel }
    ): Promise<{ [K in keyof T]: Deno.KvEntryMaybe<T[K]> }> {
        this.checkClosed();
        if (keys.length > 10) {
            throw new TypeError('Too many ranges (max 10)');
        }
        
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
        
        return results as KvEntryTuple<T>;
    }

    set(key: KvKey, value: unknown, options?: KvSetOptions): Promise<{ ok: true; versionstamp: string }> {
        this.checkClosed();
        validateKey(key, { allowCommitVersionstamp: true });
        validateValue(value);
        
        validateExpireIn(options?.expireIn);

        const versionstamp = generateVersionstamp();
        const finalKey = resolveCommitVersionstampKey(key, versionstamp);
        validateKey(finalKey);
        const rawKey = serializeKey(finalKey);
        const serializedValue = serializeValue(value);
        this.db.set(rawKey, serializedValue, options?.expireIn, versionstamp);
        
        this.notifyWatchers(finalKey);
        
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
        
        return new AtomicOperation(this.db, {
            notify: (key) => this.notifyWatchers(key),
            deliverQueue: (entry, rawQueueKey) => this.scheduleQueueDelivery(entry, rawQueueKey),
        });
    }

    enqueue(data: unknown, options?: KvQueueOptions): Promise<Deno.KvCommitResult> {
        this.checkClosed();
        validateValue(data);
        
        const prepared = prepareQueueEntry(data, options);
        const rawQueueKey = serializeKey(prepared.key);
        const versionstamp = this.db.set(rawQueueKey, serializeValue(prepared.entry), prepared.delay + 86400000);
        
        if (prepared.delay === 0) this.scheduleQueueDelivery(prepared.entry, rawQueueKey);
        
        return Promise.resolve({ ok: true, versionstamp });
    }

    listenQueue(handler: (value: unknown) => Promise<void> | void): Promise<void> {
        if (this._closed) {
            throw new Error('Queue already closed');
        }

        this.queueHandlers.push(handler);

        return new Promise<void>((resolve) => {
            this.listenQueueResolvers.push(resolve);
        });
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
                const rawKeys = keys.map(key => serializeKey(key));
                const keyIds = rawKeys.map(rawKey => rawKeyToCursor(rawKey));

                subscription = {
                    keys,
                    rawKeys,
                    keyIds,
                    controller: controller as ReadableStreamDefaultController<KvEntryMaybe<unknown>[]>,
                    lastValues,
                };

                self.watchSubscriptions.add(subscription);
                
                const initialValues = keys.map((key, index) => {
                    const rawKey = rawKeys[index];
                    const keyId = keyIds[index];
                    if (!rawKey || !keyId) {
                        return { key, value: null, versionstamp: null };
                    }
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
                }) as KvEntryTuple<T>;
                
                try {
                    controller.enqueue(initialValues);
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

    private scheduleQueueDelivery(entry: KvQueueEntry, rawQueueKey?: RawKey): void {
        queueMicrotask(() => {
            const deliveryKey = `${entry.id}:${entry.retryCount}`;
            if (this.pendingDeliveries.has(deliveryKey)) return;
            const promise = this.deliverMessage(entry, rawQueueKey)
                .finally(() => {
                    this.pendingDeliveries.delete(deliveryKey);
                });
            this.pendingDeliveries.set(deliveryKey, promise);
        });
    }

    private async deliverMessage(entry: KvQueueEntry, rawQueueKey?: RawKey): Promise<void> {
        if (this._closed || this.queueHandlers.length === 0) return;
        
        for (const handler of this.queueHandlers) {
            try {
                await handler(entry.data);
                if (rawQueueKey) {
                    this.db.delete(rawQueueKey);
                }
                return;
            } catch (err) {
                console.error('Queue handler error:', err);
                const backoffSchedule = entry.backoffSchedule ?? DEFAULT_QUEUE_BACKOFF;
                const nextRetry = entry.retryCount + 1;

                if (nextRetry <= backoffSchedule.length) {
                    const delay = backoffSchedule[nextRetry - 1] ?? DEFAULT_QUEUE_BACKOFF[0];
                    if (delay === undefined) return;
                    const newEntry: KvQueueEntry = {
                        ...entry,
                        retryCount: nextRetry,
                        scheduledAt: Date.now() + delay,
                    };
                    
                    const queueKey: KvKey = [KV_QUEUE_PREFIX, newEntry.scheduledAt, entry.id];
                    this.db.set(serializeKey(queueKey), serializeValue(newEntry), delay + 86400000);
                } else if (entry.undeliveredKeys && entry.undeliveredKeys.length > 0) {
                    for (const key of entry.undeliveredKeys) {
                        try {
                            await this.set(key, entry.data);
                        } catch {
                            // Ignore
                        }
                    }
                }
                if (rawQueueKey) this.db.delete(rawQueueKey);
                return;
            }
        }
    }

    private async processDelayedQueue(): Promise<void> {
        if (this._closed) return;
        
        const now = Date.now();
        const prefix: KvKey = [KV_QUEUE_PREFIX];
        const endPrefix: KvKey = [KV_QUEUE_PREFIX, now + 1];
        
        const iterator = createListIterator<KvQueueEntry>(this.db, {
            prefix,
            end: endPrefix,
        });
        
        try {
            for await (const entry of iterator) {
                const queueEntry = entry.value;
                if (queueEntry.scheduledAt <= now) {
                    const deliveryKey = `${queueEntry.id}:${queueEntry.retryCount}`;
                    if (!this.pendingDeliveries.has(deliveryKey)) {
                        const rawQueueKey = serializeKey(entry.key as KvKey);
                        const promise = this.deliverMessage(queueEntry, rawQueueKey)
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
        const changedEntry = this.db.get(rawChangedKey);
        const changedVersionstamp = changedEntry?.versionstamp ?? null;
        
        for (const sub of this.watchSubscriptions) {
            try {
                const keyIndex = sub.keyIds.indexOf(changedKeyId);
                if (keyIndex === -1) continue;
                const lastValue = sub.lastValues.get(changedKeyId);

                if (lastValue && lastValue.versionstamp === changedVersionstamp) {
                    continue;
                }
                
                const values = sub.keys.map((key, index) => {
                    const rawKey = index === keyIndex ? rawChangedKey : sub.rawKeys[index];
                    const keyId = sub.keyIds[index];
                    if (!rawKey || !keyId) {
                        return { key, value: null, versionstamp: null };
                    }
                    const e = index === keyIndex ? changedEntry : null;
                    
                    if (e) {
                        const v = deserializeValue(e.value);
                        sub.lastValues.set(keyId, { versionstamp: e.versionstamp, value: v });
                        return { key, value: v, versionstamp: e.versionstamp };
                    }
                    if (index === keyIndex) {
                        sub.lastValues.set(keyId, { versionstamp: null, value: null });
                        return { key, value: null, versionstamp: null };
                    }
                    const cached = sub.lastValues.get(keyId);
                    if (cached) {
                        return { key, value: cached.value, versionstamp: cached.versionstamp };
                    }
                    const current = this.db.get(rawKey);
                    if (current) {
                        const v = deserializeValue(current.value);
                        sub.lastValues.set(keyId, { versionstamp: current.versionstamp, value: v });
                        return { key, value: v, versionstamp: current.versionstamp };
                    }
                    sub.lastValues.set(keyId, { versionstamp: null, value: null });
                    return { key, value: null, versionstamp: null };
                });
                
                sub.controller.enqueue(values);
            } catch {
                // Controller might be closed
            }
        }
    }
}

export * from './types';
