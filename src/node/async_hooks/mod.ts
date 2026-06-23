/**
 * Node.js async_hooks module (stub)
 * Tracking async resource lifecycle
 */

export type AsyncId = number;
export type TriggerAsyncId = number;

export interface HookCallbacks {
    init?(asyncId: AsyncId, type: string, triggerAsyncId: TriggerAsyncId, resource: object): void;
    before?(asyncId: AsyncId): void;
    after?(asyncId: AsyncId): void;
    destroy?(asyncId: AsyncId): void;
    promiseResolve?(asyncId: AsyncId): void;
}

let _nextId = 1;

export function createHook(callbacks: HookCallbacks): { enable(): void; disable(): void } {
    return {
        enable() {},
        disable() {},
    };
}

export function executionAsyncId(): AsyncId { return _nextId; }
export function triggerAsyncId(): TriggerAsyncId { return 0; }
export function asyncWrapProviders(): string[] { return []; }

export class AsyncLocalStorage<T = unknown> {
    private _store: T | undefined;
    // All active ALS instances for snapshot support
    private static _instances: Set<AsyncLocalStorage<any>> = new Set();

    constructor() {
        this._store = undefined;
        AsyncLocalStorage._instances.add(this);
    }

    run<R>(store: T, callback: () => R): R {
        const prev = this._store;
        this._store = store;
        try { return callback(); } finally { this._store = prev; }
    }

    exit<R>(callback: () => R): R {
        const prev = this._store;
        this._store = undefined;
        try { return callback(); } finally { this._store = prev; }
    }

    getStore(): T | undefined { return this._store; }

    enterWith(store: T): void { this._store = store; }

    disable(): void { this._store = undefined; }

    /**
     * Captures the current async context and returns a function that restores it.
     * This enables patterns like: setTimeout(AsyncLocalStorage.snapshot(fn), delay)
     */
    static snapshot<T extends (...args: any[]) => any>(fn?: T, options?: { __proto__: null }): (...args: Parameters<T>) => ReturnType<T> {
        // Capture current store values for all active ALS instances
        const snapshot = new Map<AsyncLocalStorage<any>, any>();
        for (const als of AsyncLocalStorage._instances) {
            snapshot.set(als, als._store);
        }
        return ((...args: Parameters<T>) => {
            // Restore all stores from the snapshot, run fn, then restore current stores
            const prevStores = new Map<AsyncLocalStorage<any>, any>();
            for (const [als, store] of snapshot) {
                prevStores.set(als, als._store);
                als._store = store;
            }
            try {
                return fn ? fn(...args) : undefined as any;
            } finally {
                for (const [als, store] of prevStores) {
                    als._store = store;
                }
            }
        }) as (...args: Parameters<T>) => ReturnType<T>;
    }
}
