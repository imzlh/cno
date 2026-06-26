/**
 * Node.js async_hooks module
 * Minimal JS-level async context tracking for promises and common timers.
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

interface AsyncState {
    id: AsyncId;
    type: string;
    triggerId: TriggerAsyncId;
    resource: object;
    stores: Map<AsyncLocalStorage<any>, any>;
    settled: boolean;
}

const g = globalThis as any;

let _nextId = 2;
let _currentId: AsyncId = 1;
let _currentTriggerId: TriggerAsyncId = 0;
let _currentStores = new Map<AsyncLocalStorage<any>, any>();
let _patched = false;
let _originalPromiseThen: Promise<any>['then'] | null = null;

const _hooks: HookCallbacks[] = [];
const _promiseStates = new WeakMap<object, AsyncState>();
const _handleStates = new Map<any, AsyncState>();

function emitInit(state: AsyncState): void {
    for (const hook of _hooks) {
        hook.init?.(state.id, state.type, state.triggerId, state.resource);
    }
}

function emitBefore(id: AsyncId): void {
    for (const hook of _hooks) {
        hook.before?.(id);
    }
}

function emitAfter(id: AsyncId): void {
    for (const hook of _hooks) {
        hook.after?.(id);
    }
}

function emitDestroy(id: AsyncId): void {
    for (const hook of _hooks) {
        hook.destroy?.(id);
    }
}

function emitPromiseResolve(id: AsyncId): void {
    for (const hook of _hooks) {
        hook.promiseResolve?.(id);
    }
}

function snapshotStores(): Map<AsyncLocalStorage<any>, any> {
    return new Map(_currentStores);
}

function createState(
    type: string,
    triggerId = _currentId,
    resource: object = {},
    stores = snapshotStores(),
): AsyncState {
    const state: AsyncState = {
        id: _nextId++,
        type,
        triggerId,
        resource,
        stores,
        settled: false,
    };
    emitInit(state);
    return state;
}

function settleState(state: AsyncState): void {
    if (state.settled) return;
    state.settled = true;
    if (state.type === 'PROMISE') {
        emitPromiseResolve(state.id);
    }
    emitDestroy(state.id);
}

function runInState<T>(state: AsyncState, callback: (...args: any[]) => T, thisArg: any, args: any[]): T {
    const prevId = _currentId;
    const prevTriggerId = _currentTriggerId;
    const prevStores = _currentStores;

    _currentId = state.id;
    _currentTriggerId = state.triggerId;
    _currentStores = snapshotStoresFrom(state.stores);
    emitBefore(state.id);

    try {
        return callback.apply(thisArg, args);
    } finally {
        emitAfter(state.id);
        _currentId = prevId;
        _currentTriggerId = prevTriggerId;
        _currentStores = prevStores;
    }
}

function snapshotStoresFrom(stores: Map<AsyncLocalStorage<any>, any>): Map<AsyncLocalStorage<any>, any> {
    return new Map(stores);
}

function wrapCallback<T extends Function>(callback: T | undefined, state: AsyncState, finalize = false): T | undefined {
    if (typeof callback !== 'function') return callback;
    const wrapped = function(this: any, ...args: any[]) {
        try {
            return runInState(state, callback as any, this, args);
        } finally {
            if (finalize) settleState(state);
        }
    };
    return wrapped as any as T;
}

function installAsyncPatches(): void {
    if (_patched) return;
    _patched = true;

    const originalThen = Promise.prototype.then;
    _originalPromiseThen = originalThen;
    Promise.prototype.then = function(this: Promise<any>, onFulfilled?: any, onRejected?: any): Promise<any> {
        const parentState = _promiseStates.get(this as object);
        const state = createState(
            'PROMISE',
            parentState?.id ?? _currentId,
            this as object,
            parentState ? snapshotStoresFrom(parentState.stores) : snapshotStores(),
        );
        const result = originalThen.call(
            this,
            wrapCallback(onFulfilled, state),
            wrapCallback(onRejected, state),
        );
        state.resource = result as object;
        _promiseStates.set(result as object, state);
        originalThen.call(
            result,
            (value: any) => {
                settleState(state);
                return value;
            },
            (error: any) => {
                settleState(state);
                throw error;
            },
        );
        return result;
    };

    if (typeof g.queueMicrotask === 'function') {
        const originalQueueMicrotask = g.queueMicrotask.bind(g);
        g.queueMicrotask = function(callback: Function): void {
            const state = createState('Microtask');
            originalQueueMicrotask(wrapCallback(callback, state, true));
        };
    }

    if (typeof g.setTimeout === 'function') {
        const originalSetTimeout = g.setTimeout.bind(g);
        const originalClearTimeout = typeof g.clearTimeout === 'function' ? g.clearTimeout.bind(g) : null;

        g.setTimeout = function(callback: any, delay?: number, ...args: any[]) {
            if (typeof callback !== 'function') {
                return originalSetTimeout(callback, delay, ...args);
            }
            const state = createState('Timeout');
            let handle: any;
            const wrapped = function(this: any, ...innerArgs: any[]) {
                try {
                    return runInState(state, callback, this, innerArgs);
                } finally {
                    _handleStates.delete(handle);
                    settleState(state);
                }
            };
            handle = originalSetTimeout(wrapped, delay, ...args);
            _handleStates.set(handle, state);
            return handle;
        };

        if (originalClearTimeout) {
            g.clearTimeout = function(handle: any): void {
                const state = _handleStates.get(handle);
                if (state) {
                    _handleStates.delete(handle);
                    settleState(state);
                }
                originalClearTimeout(handle);
            };
        }
    }

    if (typeof g.setImmediate === 'function') {
        const originalSetImmediate = g.setImmediate.bind(g);
        const originalClearImmediate = typeof g.clearImmediate === 'function' ? g.clearImmediate.bind(g) : null;

        g.setImmediate = function(callback: any, ...args: any[]) {
            if (typeof callback !== 'function') {
                return originalSetImmediate(callback, ...args);
            }
            const state = createState('Immediate');
            let handle: any;
            const wrapped = function(this: any, ...innerArgs: any[]) {
                try {
                    return runInState(state, callback, this, innerArgs);
                } finally {
                    _handleStates.delete(handle);
                    settleState(state);
                }
            };
            handle = originalSetImmediate(wrapped, ...args);
            _handleStates.set(handle, state);
            return handle;
        };

        if (originalClearImmediate) {
            g.clearImmediate = function(handle: any): void {
                const state = _handleStates.get(handle);
                if (state) {
                    _handleStates.delete(handle);
                    settleState(state);
                }
                originalClearImmediate(handle);
            };
        }
    }

    if (typeof g.setInterval === 'function') {
        const originalSetInterval = g.setInterval.bind(g);
        const originalClearInterval = typeof g.clearInterval === 'function' ? g.clearInterval.bind(g) : null;

        g.setInterval = function(callback: any, delay?: number, ...args: any[]) {
            if (typeof callback !== 'function') {
                return originalSetInterval(callback, delay, ...args);
            }
            const state = createState('Interval');
            const wrapped = function(this: any, ...innerArgs: any[]) {
                return runInState(state, callback, this, innerArgs);
            };
            const handle = originalSetInterval(wrapped, delay, ...args);
            _handleStates.set(handle, state);
            return handle;
        };

        if (originalClearInterval) {
            g.clearInterval = function(handle: any): void {
                const state = _handleStates.get(handle);
                if (state) {
                    _handleStates.delete(handle);
                    settleState(state);
                }
                originalClearInterval(handle);
            };
        }
    }
}

export function createHook(callbacks: HookCallbacks): { enable(): void; disable(): void } {
    return {
        enable() {
            installAsyncPatches();
            if (!_hooks.includes(callbacks)) _hooks.push(callbacks);
        },
        disable() {
            const idx = _hooks.indexOf(callbacks);
            if (idx !== -1) _hooks.splice(idx, 1);
        },
    };
}

export function executionAsyncId(): AsyncId { return _currentId; }
export function triggerAsyncId(): TriggerAsyncId { return _currentTriggerId; }

export const asyncWrapProviders: Record<string, number> & (() => Record<string, number>) = Object.assign(
    () => ({ PROMISE: 0, Timeout: 1, Immediate: 2, Interval: 3, Microtask: 4 }),
    { PROMISE: 0, Timeout: 1, Immediate: 2, Interval: 3, Microtask: 4 } as Record<string, number>
);

export function newAsyncId(): AsyncId { return _nextId++; }

export class AsyncLocalStorage<T = unknown> {
    run<R>(store: T, callback: () => R): R {
        const prevStores = _currentStores;
        _currentStores = snapshotStoresFrom(_currentStores);
        _currentStores.set(this, store);
        const result = callback();
        if (result && typeof (result as any).then === 'function' && _originalPromiseThen) {
            return this._handleAsyncResult(result, prevStores);
        }
        _currentStores = prevStores;
        return result;
    }

    exit<R>(callback: () => R): R {
        const prevStores = _currentStores;
        _currentStores = snapshotStoresFrom(_currentStores);
        _currentStores.delete(this);
        const result = callback();
        if (result && typeof (result as any).then === 'function' && _originalPromiseThen) {
            return this._handleAsyncResult(result, prevStores);
        }
        _currentStores = prevStores;
        return result;
    }

    private _handleAsyncResult(result: unknown, prevStores: Map<AsyncLocalStorage<any>, any>): any {
        const thenable: any = result;
        let resolveOuter!: (value: any) => void;
        let rejectOuter!: (reason: any) => void;
        const outer = new Promise<any>((resolve, reject) => {
            resolveOuter = resolve;
            rejectOuter = reject;
        });
        const outerState = createState('PROMISE', _currentId, outer, snapshotStoresFrom(prevStores));
        _promiseStates.set(outer, outerState);
        _originalPromiseThen!.call(
            thenable,
            (value: any) => {
                _currentStores = prevStores;
                settleState(outerState);
                resolveOuter(value);
            },
            (reason: any) => {
                _currentStores = prevStores;
                settleState(outerState);
                rejectOuter(reason);
            },
        );
        return outer;
    }

    getStore(): T | undefined {
        return _currentStores.get(this);
    }

    enterWith(store: T): void {
        _currentStores = snapshotStoresFrom(_currentStores);
        _currentStores.set(this, store);
    }

    disable(): void {
        _currentStores = snapshotStoresFrom(_currentStores);
        _currentStores.delete(this);
    }

    destroy(): void {
        this.disable();
    }

    static snapshot<T extends (...args: any[]) => any>(fn?: T, _options?: { __proto__: null }): (...args: Parameters<T>) => ReturnType<T> {
        const stores = snapshotStores();
        return ((...args: Parameters<T>) => {
            const prevStores = _currentStores;
            _currentStores = snapshotStoresFrom(stores);
            try {
                return fn ? fn(...args) : undefined as any;
            } finally {
                _currentStores = prevStores;
            }
        }) as (...args: Parameters<T>) => ReturnType<T>;
    }
}

installAsyncPatches();
