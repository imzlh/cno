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

    constructor() {
        this._store = undefined;
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

    static snapshot<T>(): (...args: unknown[]) => T | undefined {
        return () => undefined;
    }
}
