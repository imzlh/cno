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

export interface AsyncHook {
    enable(): AsyncHook;
    disable(): AsyncHook;
}

export interface AsyncResourceOptions {
    triggerAsyncId?: AsyncId;
    requireManualDestroy?: boolean;
}

type StoreMap = Map<AsyncLocalStorage<unknown>, unknown>;
type Thenable<T = unknown> = {
    then(onFulfilled?: (value: T) => unknown, onRejected?: (reason: unknown) => unknown): unknown;
};
type TimerHandle = unknown;
type AnyCallable = (...args: unknown[]) => unknown;

interface AsyncState {
    id: AsyncId;
    type: string;
    triggerId: TriggerAsyncId;
    resource: object;
    stores: StoreMap;
    settled: boolean;
}

let _nextId = 2;
let _currentId: AsyncId = 1;
let _currentTriggerId: TriggerAsyncId = 0;
let _currentStores: StoreMap = new Map();
let _currentResource: object = {};
let _patched = false;
let _originalPromiseThen: Promise<unknown>['then'] | null = null;

const _hooks: HookCallbacks[] = [];
const _promiseStates = new WeakMap<Promise<unknown>, AsyncState>();
const _handleStates = new Map<TimerHandle, AsyncState>();

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

function snapshotStores(): StoreMap {
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

function isThenable(value: unknown): value is Thenable {
    return !!value && (typeof value === 'object' || typeof value === 'function')
        && typeof Reflect.get(value, 'then') === 'function';
}

function isCallable(value: unknown): value is AnyCallable {
    return typeof value === 'function';
}

function getGlobalFunction(name: string): AnyCallable | null {
    const value = Reflect.get(globalThis, name);
    return isCallable(value) ? value : null;
}

function setGlobalFunction(name: string, value: AnyCallable): void {
    Reflect.set(globalThis, name, value);
}

function runInState<T>(state: AsyncState, callback: AnyCallable, thisArg: unknown, args: readonly unknown[]): T {
    const prevId = _currentId;
    const prevTriggerId = _currentTriggerId;
    const prevStores = _currentStores;
    const prevResource = _currentResource;

    _currentId = state.id;
    _currentTriggerId = state.triggerId;
    _currentStores = snapshotStoresFrom(state.stores);
    _currentResource = state.resource;
    emitBefore(state.id);

    try {
        return Reflect.apply(callback, thisArg, args) as T;
    } finally {
        emitAfter(state.id);
        _currentId = prevId;
        _currentTriggerId = prevTriggerId;
        _currentStores = prevStores;
        _currentResource = prevResource;
    }
}

function snapshotStoresFrom(stores: StoreMap): StoreMap {
    return new Map(stores);
}

function wrapCallback<T>(callback: T, state: AsyncState, finalize = false): T {
    if (!isCallable(callback)) return callback;
    const wrapped = function(this: unknown, ...args: unknown[]) {
        try {
            return runInState(state, callback, this, args);
        } finally {
            if (finalize) settleState(state);
        }
    };
    return wrapped as T;
}

function installAsyncPatches(): void {
    if (_patched) return;
    _patched = true;

    const originalThen = Promise.prototype.then;
    _originalPromiseThen = originalThen;
    Promise.prototype.then = function(this: Promise<unknown>, onFulfilled?: unknown, onRejected?: unknown): Promise<unknown> {
        const parentState = _promiseStates.get(this);
        const state = createState(
            'PROMISE',
            parentState?.id ?? _currentId,
            this,
            parentState ? snapshotStoresFrom(parentState.stores) : snapshotStores(),
        );
        const result = originalThen.call(
            this,
            wrapCallback(onFulfilled, state),
            wrapCallback(onRejected, state),
        );
        state.resource = result;
        _promiseStates.set(result, state);
        originalThen.call(
            result,
            (value: unknown) => {
                settleState(state);
                return value;
            },
            (error: unknown) => {
                settleState(state);
                throw error;
            },
        );
        return result;
    };

    const queueMicrotaskFn = getGlobalFunction('queueMicrotask');
    if (queueMicrotaskFn) {
        const originalQueueMicrotask = queueMicrotaskFn.bind(globalThis);
        setGlobalFunction('queueMicrotask', function(callback: () => void): void {
            const state = createState('Microtask');
            originalQueueMicrotask(wrapCallback(callback, state, true));
        });
    }

    const setTimeoutFn = getGlobalFunction('setTimeout');
    if (setTimeoutFn) {
        const originalSetTimeout = setTimeoutFn.bind(globalThis);
        const clearTimeoutFn = getGlobalFunction('clearTimeout');
        const originalClearTimeout = clearTimeoutFn ? clearTimeoutFn.bind(globalThis) : null;

        setGlobalFunction('setTimeout', function(callback: unknown, delay?: number, ...args: unknown[]) {
            if (!isCallable(callback)) {
                return originalSetTimeout(callback, delay, ...args);
            }
            const state = createState('Timeout');
            let handle: TimerHandle;
            const wrapped = function(this: unknown, ...innerArgs: unknown[]) {
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
        });

        if (originalClearTimeout) {
            setGlobalFunction('clearTimeout', function(handle: TimerHandle): void {
                const state = _handleStates.get(handle);
                if (state) {
                    _handleStates.delete(handle);
                    settleState(state);
                }
                originalClearTimeout(handle);
            });
        }
    }

    const setImmediateFn = getGlobalFunction('setImmediate');
    if (setImmediateFn) {
        const originalSetImmediate = setImmediateFn.bind(globalThis);
        const clearImmediateFn = getGlobalFunction('clearImmediate');
        const originalClearImmediate = clearImmediateFn ? clearImmediateFn.bind(globalThis) : null;

        setGlobalFunction('setImmediate', function(callback: unknown, ...args: unknown[]) {
            if (!isCallable(callback)) {
                return originalSetImmediate(callback, ...args);
            }
            const state = createState('Immediate');
            let handle: TimerHandle;
            const wrapped = function(this: unknown, ...innerArgs: unknown[]) {
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
        });

        if (originalClearImmediate) {
            setGlobalFunction('clearImmediate', function(handle: TimerHandle): void {
                const state = _handleStates.get(handle);
                if (state) {
                    _handleStates.delete(handle);
                    settleState(state);
                }
                originalClearImmediate(handle);
            });
        }
    }

    const setIntervalFn = getGlobalFunction('setInterval');
    if (setIntervalFn) {
        const originalSetInterval = setIntervalFn.bind(globalThis);
        const clearIntervalFn = getGlobalFunction('clearInterval');
        const originalClearInterval = clearIntervalFn ? clearIntervalFn.bind(globalThis) : null;

        setGlobalFunction('setInterval', function(callback: unknown, delay?: number, ...args: unknown[]) {
            if (!isCallable(callback)) {
                return originalSetInterval(callback, delay, ...args);
            }
            const state = createState('Interval');
            const wrapped = function(this: unknown, ...innerArgs: unknown[]) {
                return runInState(state, callback, this, innerArgs);
            };
            const handle = originalSetInterval(wrapped, delay, ...args);
            _handleStates.set(handle, state);
            return handle;
        });

        if (originalClearInterval) {
            setGlobalFunction('clearInterval', function(handle: TimerHandle): void {
                const state = _handleStates.get(handle);
                if (state) {
                    _handleStates.delete(handle);
                    settleState(state);
                }
                originalClearInterval(handle);
            });
        }
    }
}

export function createHook(callbacks: HookCallbacks): AsyncHook {
    const hook: AsyncHook = {
        enable() {
            installAsyncPatches();
            if (!_hooks.includes(callbacks)) _hooks.push(callbacks);
            return hook;
        },
        disable() {
            const idx = _hooks.indexOf(callbacks);
            if (idx !== -1) _hooks.splice(idx, 1);
            return hook;
        },
    };
    return hook;
}

export function executionAsyncId(): AsyncId { return _currentId; }
export function triggerAsyncId(): TriggerAsyncId { return _currentTriggerId; }
export function executionAsyncResource(): object { return _currentResource; }

export const asyncWrapProviders: Record<string, number> = {
    PROMISE: 0,
    Timeout: 1,
    Immediate: 2,
    Interval: 3,
    Microtask: 4,
};

export function newAsyncId(): AsyncId { return _nextId++; }

export class AsyncResource {
    protected _asyncState: AsyncState;

    constructor(type: string, triggerAsyncId?: AsyncId | AsyncResourceOptions) {
        if (typeof type !== 'string') {
            throw Object.assign(
                new TypeError(`The "type" argument must be of type string. Received ${type === undefined ? 'undefined' : typeof type}`),
                { code: 'ERR_INVALID_ARG_TYPE' },
            );
        }
        // Node accepts either a numeric triggerAsyncId or an options object.
        const trigger = typeof triggerAsyncId === 'object' && triggerAsyncId !== null
            ? triggerAsyncId.triggerAsyncId
            : triggerAsyncId;
        this._asyncState = createState(type, trigger ?? _currentId, this);
    }

    static bind<T extends AnyCallable>(fn: T, type?: string, thisArg?: unknown): T {
        if (!isCallable(fn)) {
            throw new TypeError(`The "fn" argument must be of type function. Received type ${typeof fn}`);
        }
        return new AsyncResource(type ?? fn.name).bind(fn, thisArg);
    }

    runInAsyncScope<T>(callback: (...args: unknown[]) => T, thisArg?: unknown, ...args: unknown[]): T {
        return runInState(this._asyncState, callback, thisArg, args);
    }

    bind<T extends AnyCallable>(fn: T, thisArg?: unknown): T {
        if (!isCallable(fn)) {
            throw new TypeError(`The "fn" argument must be of type function. Received type ${typeof fn}`);
        }
        const resource = this;
        return function(this: unknown, ...args: unknown[]) {
            return resource.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args);
        } as T;
    }

    emitDestroy(): this {
        settleState(this._asyncState);
        return this;
    }

    asyncId(): AsyncId {
        return this._asyncState.id;
    }

    triggerAsyncId(): TriggerAsyncId {
        return this._asyncState.triggerId;
    }
}

export class AsyncLocalStorage<T = unknown> {
    run<R, A extends unknown[]>(store: T, callback: (...args: A) => R, ...args: A): R {
        const prevStores = _currentStores;
        _currentStores = snapshotStoresFrom(_currentStores);
        _currentStores.set(this, store);
        let result: R;
        try {
            result = callback(...args);
        } catch (error) {
            _currentStores = prevStores;
            throw error;
        }
        if (isThenable(result) && _originalPromiseThen) {
            return this._handleAsyncResult(result, prevStores) as R;
        }
        _currentStores = prevStores;
        return result;
    }

    exit<R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R {
        const prevStores = _currentStores;
        _currentStores = snapshotStoresFrom(_currentStores);
        _currentStores.delete(this);
        let result: R;
        try {
            result = callback(...args);
        } catch (error) {
            _currentStores = prevStores;
            throw error;
        }
        if (isThenable(result) && _originalPromiseThen) {
            return this._handleAsyncResult(result, prevStores) as R;
        }
        _currentStores = prevStores;
        return result;
    }

    private _handleAsyncResult(result: Thenable, prevStores: StoreMap): unknown {
        const { promise: outer, resolve: resolveOuter, reject: rejectOuter } = Promise.withResolvers<unknown>();
        const outerState = createState('PROMISE', _currentId, outer, snapshotStoresFrom(prevStores));
        _promiseStates.set(outer, outerState);
        const originalPromiseThen = _originalPromiseThen;
        if (!originalPromiseThen) return outer;
        originalPromiseThen.call(
            result,
            (value: unknown) => {
                _currentStores = prevStores;
                settleState(outerState);
                resolveOuter(value);
            },
            (reason: unknown) => {
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

    static snapshot(): <R, A extends unknown[]>(fn: (...args: A) => R, ...args: A) => R;
    static snapshot<T extends (...args: unknown[]) => unknown>(fn: T, _options?: { __proto__: null }): (...args: Parameters<T>) => ReturnType<T>;
    static snapshot<T extends (...args: unknown[]) => unknown>(fn?: T, _options?: { __proto__: null }): (...args: unknown[]) => unknown {
        const stores = snapshotStores();
        return (...args: unknown[]) => {
            const prevStores = _currentStores;
            _currentStores = snapshotStoresFrom(stores);
            try {
                if (fn) return fn(...args);
                const callback = args[0];
                return isCallable(callback) ? callback(...args.slice(1)) : undefined;
            } finally {
                _currentStores = prevStores;
            }
        };
    }

    static bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
        const stores = snapshotStores();
        return (function(this: unknown, ...args: Parameters<T>) {
            const prevStores = _currentStores;
            _currentStores = snapshotStoresFrom(stores);
            try {
                return fn.apply(this, args);
            } finally {
                _currentStores = prevStores;
            }
        }) as T;
    }
}

installAsyncPatches();
