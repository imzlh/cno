/**
 * Shared promise hook dispatcher for async_hooks and v8.promiseHooks.
 *
 * The native `engine.promiseHook()` is a single-slot replacement hook.
 * This module provides a cooperative chain-of-responsibility pattern so
 * multiple consumers (async_hooks, v8.promiseHooks, potential future CDP)
 * can register callbacks without clobbering each other.
 */

const engine = import.meta.use('engine');

export type PromiseHookCallback = (
    state: PromiseState,
    promise: Promise<unknown>,
    parent?: Promise<unknown>
) => void;

export enum PromiseState {
    CONSTRUCT = 0,
    BEFORE_THEN = 1,
    AFTER_THEN = 2,
    FULFILLED = 3,
}

type NativeHook = (
    state: number,
    promise: Promise<unknown>,
    parent?: Promise<unknown>
) => void;

const callbacks = new Set<PromiseHookCallback>();
let dispatcher: NativeHook | null = null;
let previousHook: NativeHook | null = null;

function readNativeHook(): NativeHook | null {
    const existing: unknown = engine.promiseHook();
    return typeof existing === 'function' ? (existing as NativeHook) : null;
}

function invokeCallbacks(state: number, promise: Promise<unknown>, parent?: Promise<unknown>): void {
    for (const cb of callbacks) {
        try {
            cb(state, promise, parent);
        } catch {
            // A consumer hook must not break other consumers
        }
    }
}

function installDispatcher(): void {
    if (dispatcher) return;
    previousHook = readNativeHook();
    dispatcher = (state: number, promise: Promise<unknown>, parent?: Promise<unknown>) => {
        // Chain to the previous hook first (if any foreign code installed one)
        if (previousHook) {
            try {
                previousHook(state, promise, parent);
            } catch {
                // Foreign hook must not break ours
            }
        }
        // Then dispatch to all registered consumers
        invokeCallbacks(state, promise, parent);
    };
    engine.promiseHook(dispatcher);
}

function uninstallDispatcher(): void {
    if (!dispatcher) return;
    if (callbacks.size > 0) return; // Still have active consumers
    dispatcher = null;
    // Restore the previous hook (if any)
    engine.promiseHook(previousHook ?? (() => {}));
    previousHook = null;
}

/**
 * Register a promise hook callback.
 * @returns A function to unregister this callback
 */
export function addPromiseHook(callback: PromiseHookCallback): () => void {
    if (typeof callback !== 'function') {
        throw new TypeError('Promise hook callback must be a function');
    }
    installDispatcher();
    callbacks.add(callback);
    let removed = false;
    return () => {
        if (removed) return;
        removed = true;
        callbacks.delete(callback);
        uninstallDispatcher();
    };
}
