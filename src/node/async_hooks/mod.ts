/**
 * Node.js async_hooks module
 * Async context tracking using the native engine.promiseHook for promises,
 * with JS-level wrappers for timers and microtasks.
 */

import { addPromiseHook, PromiseState } from '../_internal/promise-hook';

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
type TimerHandle = unknown;
type AnyCallable = (...args: unknown[]) => unknown;

interface AsyncState {
    id: AsyncId;
    type: string;
    triggerId: TriggerAsyncId;
    resource: object;
    stores: StoreMap;
}

let _nextId = 2;
let _currentId: AsyncId = 1;
let _currentTriggerId: TriggerAsyncId = 0;
let _currentStores: StoreMap = new Map();
let _currentResource: object = {};
let _timersPatchInstalled = false;

const _hooks: HookCallbacks[] = [];
const _promiseStates = new WeakMap<Promise<unknown>, AsyncState>();
const _handleStates = new Map<TimerHandle, AsyncState>();
let _promiseHookStop: (() => void) | null = null;

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
    };
    emitInit(state);
    return state;
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
    _currentStores = new Map(state.stores);
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

function wrapCallback<T>(callback: T, state: AsyncState, finalize = false): T {
    if (!isCallable(callback)) return callback;
    const wrapped = function(this: unknown, ...args: unknown[]) {
        try {
            return runInState(state, callback, this, args);
        } finally {
            if (finalize) {
                emitPromiseResolve(state.id);
                emitDestroy(state.id);
            }
        }
    };
    return wrapped as T;
}

function installPromiseHook(): void {
    if (_promiseHookStop) return;
    _promiseHookStop = addPromiseHook((nativeState, promise, parent) => {
        switch (nativeState) {
            case PromiseState.CONSTRUCT: {
                const parentState = parent ? _promiseStates.get(parent) : undefined;
                const state = createState(
                    'PROMISE',
                    parentState?.id ?? _currentId,
                    promise,
                    parentState ? new Map(parentState.stores) : snapshotStores(),
                );
                _promiseStates.set(promise, state);
                break;
            }
            case PromiseState.BEFORE_THEN: {
                const state = _promiseStates.get(promise);
                if (state) {
                    const prevId = _currentId;
                    const prevTriggerId = _currentTriggerId;
                    const prevStores = _currentStores;
                    const prevResource = _currentResource;
                    _currentId = state.id;
                    _currentTriggerId = state.triggerId;
                    _currentStores = new Map(state.stores);
                    _currentResource = state.resource;
                    emitBefore(state.id);
                    // Restore will happen in AFTER_THEN
                    _currentId = prevId;
                    _currentTriggerId = prevTriggerId;
                    _currentStores = prevStores;
                    _currentResource = prevResource;
                }
                break;
            }
            case PromiseState.AFTER_THEN: {
                const state = _promiseStates.get(promise);
                if (state) {
                    emitAfter(state.id);
                }
                break;
            }
            case PromiseState.FULFILLED: {
                const state = _promiseStates.get(promise);
                if (state) {
                    emitPromiseResolve(state.id);
                    emitDestroy(state.id);
                    _promiseStates.delete(promise);
                }
                break;
            }
        }
    });
}

function uninstallPromiseHook(): void {
    if (!_promiseHookStop) return;
    if (_hooks.length > 0) return;
    _promiseHookStop();
    _promiseHookStop = null;
}

function installTimersPatches(): void {
    if (_timersPatchInstalled) return;
    _timersPatchInstalled = true;

    const queueMicrotaskFn = getGlobalFunction('queueMicrotask');
    if (queueMicrotaskFn) {
        const originalQueueMicrotask = queueMicrotaskFn.bind(globalThis);
        setGlobalFunction('queueMicrotask', function(callback: any): void {
            if (!isCallable(callback)) {
                originalQueueMicrotask(callback);
                return;
            }
            const state = createState('Microtask');
            originalQueueMicrotask(wrapCallback(callback as AnyCallable, state, true) as () => void);
        });
    }

    const setTimeoutFn = getGlobalFunction('setTimeout');
    if (setTimeoutFn) {
        const originalSetTimeout = setTimeoutFn.bind(globalThis);
        const clearTimeoutFn = getGlobalFunction('clearTimeout');
        const originalClearTimeout = clearTimeoutFn ? clearTimeoutFn.bind(globalThis) : null;

        setGlobalFunction('setTimeout', function(callback: unknown, delay?: any, ...args: unknown[]) {
            if (!isCallable(callback)) {
                return originalSetTimeout(callback as AnyCallable, delay, ...args);
            }
            const state = createState('Timeout');
            let handle: TimerHandle;
            const wrapped = function(this: unknown, ...innerArgs: unknown[]) {
                try {
                    return runInState(state, callback, this, innerArgs);
                } finally {
                    _handleStates.delete(handle);
                    emitDestroy(state.id);
                }
            };
            handle = originalSetTimeout(wrapped as AnyCallable, delay, ...args);
            _handleStates.set(handle, state);
            return handle;
        });

        if (originalClearTimeout) {
            setGlobalFunction('clearTimeout', function(handle: TimerHandle): void {
                const state = _handleStates.get(handle);
                if (state) {
                    _handleStates.delete(handle);
                    emitDestroy(state.id);
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
                return originalSetImmediate(callback as AnyCallable, ...args);
            }
            const state = createState('Immediate');
            let handle: TimerHandle;
            const wrapped = function(this: unknown, ...innerArgs: unknown[]) {
                try {
                    return runInState(state, callback, this, innerArgs);
                } finally {
                    _handleStates.delete(handle);
                    emitDestroy(state.id);
                }
            };
            handle = originalSetImmediate(wrapped as AnyCallable, ...args);
            _handleStates.set(handle, state);
            return handle;
        });
    }

    const setIntervalFn = getGlobalFunction('setInterval');
    if (setIntervalFn) {
        const originalSetInterval = setIntervalFn.bind(globalThis);
        const clearIntervalFn = getGlobalFunction('clearInterval');
        const originalClearInterval = clearIntervalFn ? clearIntervalFn.bind(globalThis) : null;

        setGlobalFunction('setInterval', function(callback: unknown, delay?: any, ...args: unknown[]) {
            if (!isCallable(callback)) {
                return originalSetInterval(callback as AnyCallable, delay, ...args);
            }
            const state = createState('Interval');
            const wrapped = function(this: unknown, ...innerArgs: unknown[]) {
                return runInState(state, callback, this, innerArgs);
            };
            const handle = originalSetInterval(wrapped as AnyCallable, delay, ...args);
            _handleStates.set(handle, state);
            return handle;
        });

        if (originalClearInterval) {
            setGlobalFunction('clearInterval', function(handle: TimerHandle): void {
                const state = _handleStates.get(handle);
                if (state) {
                    _handleStates.delete(handle);
                    emitDestroy(state.id);
                }
                originalClearInterval(handle);
            });
        }
    }
}

export function createHook(callbacks: HookCallbacks): AsyncHook {
    const hook: AsyncHook = {
        enable() {
            installPromiseHook();
            installTimersPatches();
            if (!_hooks.includes(callbacks)) _hooks.push(callbacks);
            return hook;
        },
        disable() {
            const idx = _hooks.indexOf(callbacks);
            if (idx !== -1) _hooks.splice(idx, 1);
            uninstallPromiseHook();
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
        emitDestroy(this._asyncState.id);
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
        _currentStores = new Map(_currentStores);
        _currentStores.set(this, store);
        try {
            return callback(...args);
        } finally {
            _currentStores = prevStores;
        }
    }

    exit<R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R {
        const prevStores = _currentStores;
        _currentStores = new Map(_currentStores);
        _currentStores.delete(this);
        try {
            return callback(...args);
        } finally {
            _currentStores = prevStores;
        }
    }

    getStore(): T | undefined {
        return _currentStores.get(this) as T | undefined;
    }

    enterWith(store: T): void {
        _currentStores = new Map(_currentStores);
        _currentStores.set(this, store);
    }

    disable(): void {
        _currentStores = new Map(_currentStores);
        _currentStores.delete(this);
    }

    destroy(): void {
        this.disable();
    }

    static snapshot<T extends (...args: unknown[]) => unknown>(fn?: T, _options?: { __proto__: null }): (...args: unknown[]) => unknown {
        const stores = snapshotStores();
        return (...args: unknown[]) => {
            const prevStores = _currentStores;
            _currentStores = new Map(stores);
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
            _currentStores = new Map(stores);
            try {
                return fn.apply(this, args);
            } finally {
                _currentStores = prevStores;
            }
        }) as T;
    }
}
