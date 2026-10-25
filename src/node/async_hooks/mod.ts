/**
 * Node.js async_hooks module
 * Async context tracking using the native engine.promiseHook for promises,
 * with JS-level wrappers for timers and microtasks.
 */

import { addPromiseHook, PromiseState } from '../_internal/promise-hook';

const engine = import.meta.use('engine');

// The promise builtin reports every continuation it registers (a `.then`
// result) to the promise hook, but the hook itself cannot tell which promise a
// new continuation runs after. This hook is the innermost link of the
// dispatcher chain (see _internal/promise-hook) and only forwards the
// continuation events to `_onContinuation`; the dispatcher replaces the engine
// hook whenever it is (re)installed, so it asks async_hooks to wrap again.
const CONTINUATION = 4;
let continuationSink: ((result: Promise<unknown>, target: Promise<unknown>) => void) | null = null;
const publishedHook = Reflect.get(globalThis, '__cnoPromiseHook');
let installedHook: unknown = undefined;
let installedContinuations = 0;
const wrappedHook = (state: number, promise: Promise<unknown>, target?: Promise<unknown>, extra?: Promise<unknown>): void => {
    if (state === CONTINUATION) {
        installedContinuations++;
        if (continuationSink !== null && typeof extra === 'object' && extra !== null) continuationSink(promise, extra);
    } else {
        installedContinuations = 0;
    }
    if (typeof publishedHook === 'function') publishedHook(state, promise, target, extra);
};
function ensureContinuationHook(): void {
    const current = engine.promiseHook();
    if (installedContinuations === 0 || current !== wrappedHook) {
        installedContinuations = 0;
        installedHook = current;
        engine.promiseHook(wrappedHook);
    }
}
function onContinuation(result: Promise<unknown>, target: Promise<unknown>): void {
    ensureContinuationHook();
    if (continuationSink !== null) continuationSink(result, target);
}
Reflect.set(globalThis, '__cnoOnContinuation', onContinuation);
Reflect.set(globalThis, '__cnoOnPromiseHookThisInstalled', (): void => {
    installedHook = undefined;
    installedContinuations = 0;
});

/**
 * The chain a continuation captured when it was registered (see the
 * __cnoOnContinuation hook above). A continuation inherits from the promise it
 * runs after, which may have been created in another context; the engine does
 * not report that promise to the promise hook. An entry is dropped once the
 * inherited chain is settled, and anything left is collected with its promise.
 */
let _continuationStores = new WeakMap<Promise<unknown>, StoreChain>();

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

type TimerHandle = unknown;
type AnyCallable = (...args: unknown[]) => unknown;

interface AsyncState {
    id: AsyncId;
    type: string;
    triggerId: TriggerAsyncId;
    resource: object;
    stores: StoreChain;
}

interface TimerState {
    state: AsyncState;
    id: number;
    generation: number;
    refreshing: boolean;
}

let _nextId = 2;
let _currentId: AsyncId = 1;
let _currentTriggerId: TriggerAsyncId = 0;
let _currentStores = createStoreChain(null, null as unknown as AsyncLocalStorage<unknown>, undefined, false);
let _currentResource: object = {};
let _timersPatchInstalled = false;

const _hooks: HookCallbacks[] = [];
const _promiseStates = new WeakMap<Promise<unknown>, AsyncState>();
const _handleStates = new Map<number, TimerState>();
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

type StoreChain = {
    parent: StoreChain | null;
    depth: number;
    store: AsyncLocalStorage<unknown>;
    value: unknown;
    hasValue: boolean;
};

function createStoreChain(parent: StoreChain | null, store: AsyncLocalStorage<unknown>, value: unknown, hasValue: boolean): StoreChain {
    return { parent, depth: parent === null ? 0 : parent.depth + 1, store, value, hasValue };
}

/**
 * A captured state keeps its own immutable chain. Updating the current context
 * removes an older entry for that store, so repeated enterWith() calls do not
 * retain values that no captured context still needs.
 */
function lookupStore(chain: StoreChain, store: AsyncLocalStorage<unknown>): StoreChain | undefined {
    for (let node: StoreChain | null = chain; node !== null; node = node.parent) {
        if (node.store === store) return node;
    }
    return undefined;
}

function pushStore(chain: StoreChain, store: AsyncLocalStorage<unknown>, value: unknown, hasValue: boolean): StoreChain {
    const prefix: StoreChain[] = [];
    let previous: StoreChain | null = chain;
    while (previous !== null && previous.store !== store) {
        prefix.push(previous);
        previous = previous.parent;
    }
    if (previous === null) return hasValue ? createStoreChain(chain, store, value, true) : chain;

    // The root sentinel is never an AsyncLocalStorage, so this parent exists.
    let next = previous.parent!;
    for (let i = prefix.length - 1; i >= 0; i--) {
        const entry = prefix[i];
        next = createStoreChain(next, entry.store, entry.value, entry.hasValue);
    }
    return hasValue ? createStoreChain(next, store, value, true) : next;
}

function snapshotStores(): StoreChain {
    return _currentStores;
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
    _currentStores = state.stores;
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
    const callbackStores = state.stores;
    const wrapped = function(this: unknown, ...args: unknown[]) {
        // The task wrapper would otherwise only restore this chain when the
        // result settles. A callback that returns a promise leaves the
        // microtasks queued by its synchronous part running under the caller's
        // context instead of this one, so restore it first.
        const prevStores = _currentStores;
        _currentStores = callbackStores;
        try {
            return runInState(state, callback, this, args);
        } finally {
            _currentStores = prevStores;
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
    continuationSink = (result: Promise<unknown>, target: Promise<unknown>): void => {
        const captured = _continuationStores.get(target);
        if (captured !== undefined) {
            _continuationStores.delete(target);
            _continuationStores.set(result, captured);
            return;
        }
        const state = _promiseStates.get(target);
        if (state) _continuationStores.set(result, state.stores);
    };
    _promiseHookStop = addPromiseHook((nativeState, promise, parent) => {
        switch (nativeState) {
            case PromiseState.CONSTRUCT: {
                const parentState = parent ? _promiseStates.get(parent) : undefined;
                const captured = _continuationStores.get(promise);
                if (captured !== undefined) _continuationStores.delete(promise);
                const state = createState(
                    'PROMISE',
                    parentState?.id ?? _currentId,
                    promise,
                    captured ?? (parentState ? parentState.stores : snapshotStores()),
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
                    _currentStores = state.stores;
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
    continuationSink = null;
    _continuationStores = new WeakMap();
}

function destroyTimer(entry: TimerState): void {
    if (_handleStates.get(entry.id) !== entry) return;
    _handleStates.delete(entry.id);
    emitDestroy(entry.state.id);
}

function trackTimerRefresh(handle: TimerHandle, entry: TimerState): void {
    if (typeof handle !== 'object' || handle === null) return;
    const refresh = Reflect.get(handle, 'refresh');
    if (!isCallable(refresh)) return;
    Object.defineProperty(handle, 'refresh', {
        configurable: true,
        writable: true,
        value: function(this: unknown, ...args: unknown[]) {
            if (this !== handle) return Reflect.apply(refresh, this, args);
            const active = _handleStates.get(entry.id) === entry;
            entry.refreshing = true;
            try {
                const result = Reflect.apply(refresh, this, args);
                const id = Number(handle);
                if (id !== entry.id) {
                    if (active) _handleStates.delete(entry.id);
                    else entry.state = createState(entry.state.type, entry.state.triggerId,
                        entry.state.resource, entry.state.stores);
                    entry.id = id;
                    entry.generation++;
                    _handleStates.set(id, entry);
                }
                return result;
            } catch (error) {
                destroyTimer(entry);
                throw error;
            } finally {
                entry.refreshing = false;
            }
        },
    });
}

function installTimersPatches(): void {
    if (_timersPatchInstalled) return;
    _timersPatchInstalled = true;

    // All public cancellation paths eventually clear this native id, including
    // node:timers, numeric aliases and a handle's close()/Symbol.dispose().
    const timers = import.meta.use('timers');
    for (const name of ['clearTimeout', 'clearInterval'] as const) {
        const clear = timers[name];
        timers[name] = (id: number): void => {
            clear(id);
            const entry = typeof id === 'number' ? _handleStates.get(Math.trunc(id)) : undefined;
            if (entry && !entry.refreshing) destroyTimer(entry);
        };
    }

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

    const timerFunctions = [
        ['setTimeout', 'Timeout', false],
        ['setImmediate', 'Immediate', false],
        ['setInterval', 'Interval', true],
    ] as const;
    for (const [name, type, repeat] of timerFunctions) {
        const original = getGlobalFunction(name)?.bind(globalThis);
        if (!original) continue;
        setGlobalFunction(name, function(callback: unknown, ...args: unknown[]) {
            if (!isCallable(callback)) return original(callback, ...args);
            const entry: TimerState = {
                state: createState(type), id: 0, generation: 0, refreshing: false,
            };
            const wrapped = function(this: unknown, ...innerArgs: unknown[]) {
                const generation = entry.generation;
                try {
                    return runInState(entry.state, callback, this, innerArgs);
                } finally {
                    // A refresh inside the callback leaves another firing pending.
                    if (!repeat && generation === entry.generation) destroyTimer(entry);
                }
            };
            const handle = original(wrapped, ...args);
            entry.id = Number(handle);
            _handleStates.set(entry.id, entry);
            trackTimerRefresh(handle, entry);
            return handle;
        });
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
        _currentStores = pushStore(_currentStores, this, store, true);
        try {
            return callback(...args);
        } finally {
            _currentStores = prevStores;
        }
    }

    exit<R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R {
        const prevStores = _currentStores;
        _currentStores = pushStore(_currentStores, this, undefined, false);
        try {
            return callback(...args);
        } finally {
            _currentStores = prevStores;
        }
    }

    getStore(): T | undefined {
        const entry = lookupStore(_currentStores, this);
        return (entry && entry.hasValue ? entry.value : undefined) as T | undefined;
    }

    enterWith(store: T): void {
        _currentStores = pushStore(_currentStores, this, store, true);
    }

    disable(): void {
        _currentStores = pushStore(_currentStores, this, undefined, false);
    }

    destroy(): void {
        this.disable();
    }

    static snapshot<T extends (...args: unknown[]) => unknown>(fn?: T, _options?: { __proto__: null }): (...args: unknown[]) => unknown {
        const stores = snapshotStores();
        return (...args: unknown[]) => {
            const prevStores = _currentStores;
            _currentStores = stores;
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
            _currentStores = stores;
            try {
                return fn.apply(this, args);
            } finally {
                _currentStores = prevStores;
            }
        }) as T;
    }
}
