// `engine.promiseHook()` is single-slot; this chains consumers (async_hooks,
// v8.promiseHooks) so they cannot clobber each other.

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

function installDispatcher(): void {
    if (dispatcher) return;
    const existing: unknown = engine.promiseHook();
    previousHook = typeof existing === 'function' ? (existing as NativeHook) : null;
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
        for (const cb of callbacks) {
            try {
                cb(state, promise, parent);
            } catch {
                // A consumer hook must not break other consumers
            }
        }
    };
    engine.promiseHook(dispatcher);
    // The hook is replaced rather than chained, so tell async_hooks to wrap the
    // dispatcher again (its continuation hook).
    const rebind = Reflect.get(globalThis, '__cnoOnPromiseHookThisInstalled');
    if (typeof rebind === 'function') Reflect.apply(rebind, globalThis, []);
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
