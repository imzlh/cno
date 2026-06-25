/**
 * Node.js async_hooks module
 * Based on engine.promiseHook (QuickJS native promise tracking)
 */

const engine = import.meta.use('engine');

export type AsyncId = number;
export type TriggerAsyncId = number;

export interface HookCallbacks {
    init?(asyncId: AsyncId, type: string, triggerAsyncId: TriggerAsyncId, resource: object): void;
    before?(asyncId: AsyncId): void;
    after?(asyncId: AsyncId): void;
    destroy?(asyncId: AsyncId): void;
    promiseResolve?(asyncId: AsyncId): void;
}

// Async ID tracking
let _nextId = 1;
const _promiseIds = new WeakMap<object, AsyncId>();
const _promiseParents = new WeakMap<object, AsyncId>();
let _currentId: AsyncId = 1; // main context

// Registered hooks
const _hooks: HookCallbacks[] = [];
let _hookEnabled = false;

function getId(promise: object): AsyncId {
    let id = _promiseIds.get(promise);
    if (id === undefined) {
        id = _nextId++;
        _promiseIds.set(promise, id);
    }
    return id;
}

// Native promise hook — set once, dispatches to all registered hooks
function _onPromise(state: any, promise: any, parent?: any) {
    if (!_hookEnabled) return;
    const id = getId(promise);

    switch (state) {
        case engine.PromiseState.CONSTRUCT: {
            const parentId = parent ? getId(parent) : _currentId;
            _promiseParents.set(promise, parentId);
            for (const h of _hooks) {
                h.init?.(id, 'PROMISE', parentId, promise);
            }
            break;
        }
        case engine.PromiseState.BEFORE_THEN: {
            const prev = _currentId;
            _currentId = id;
            for (const h of _hooks) h.before?.(id);
            _currentId = prev;
            break;
        }
        case engine.PromiseState.AFTER_THEN: {
            for (const h of _hooks) h.after?.(id);
            break;
        }
        case engine.PromiseState.FULFILLED: {
            for (const h of _hooks) {
                h.destroy?.(id);
                h.promiseResolve?.(id);
            }
            break;
        }
    }
}

function _syncHook(): void {
    if (_hooks.length > 0 && !_hookEnabled) {
        _hookEnabled = true;
        engine.promiseHook(_onPromise);
    } else if (_hooks.length === 0 && _hookEnabled) {
        _hookEnabled = false;
        engine.promiseHook(() => {});
    }
}

export function createHook(callbacks: HookCallbacks): { enable(): void; disable(): void } {
    return {
        enable() {
            if (!_hooks.includes(callbacks)) _hooks.push(callbacks);
            _syncHook();
        },
        disable() {
            const idx = _hooks.indexOf(callbacks);
            if (idx !== -1) _hooks.splice(idx, 1);
            _syncHook();
        },
    };
}

export function executionAsyncId(): AsyncId { return _currentId; }
export function triggerAsyncId(): TriggerAsyncId { return _promiseParents.get(globalThis as any) ?? 0; }

export const asyncWrapProviders: Record<string, number> & (() => Record<string, number>) = Object.assign(
    () => ({ PROMISE: 0 }),
    { PROMISE: 0 } as Record<string, number>
);

export function newAsyncId(): AsyncId { return _nextId++; }

export class AsyncLocalStorage<T = unknown> {
    private _store: T | undefined;
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

    destroy(): void {
        this._store = undefined;
        AsyncLocalStorage._instances.delete(this);
    }

    static snapshot<T extends (...args: any[]) => any>(fn?: T, options?: { __proto__: null }): (...args: Parameters<T>) => ReturnType<T> {
        const snapshot = new Map<AsyncLocalStorage<any>, any>();
        for (const als of AsyncLocalStorage._instances) {
            snapshot.set(als, als._store);
        }
        return ((...args: Parameters<T>) => {
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
