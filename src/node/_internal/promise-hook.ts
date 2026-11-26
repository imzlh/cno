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

interface Dispatcher {
    callbacks: Set<{ callback: PromiseHookCallback }>;
    hook: NativeHook;
    previous: NativeHook | undefined;
}

let dispatcher: Dispatcher | undefined;

function installDispatcher(): Dispatcher {
    if (dispatcher) return dispatcher;
    // Foreign wrappers can retain this hook after removal, so each installation
    // owns its registrations while keeping its previous hook chain intact.
    const callbacks = new Set<{ callback: PromiseHookCallback }>();
    const previous = engine.promiseHook();
    const hook: NativeHook = (state, promise, parent) => {
        const currentCallbacks = [...callbacks];
        // Chain to the previous hook first (if any foreign code installed one)
        if (previous) {
            try {
                previous(state, promise, parent);
            } catch {
                // Foreign hook must not break ours
            }
        }
        // Then dispatch to all registered consumers
        for (const { callback } of currentCallbacks) {
            try {
                callback(state, promise, parent);
            } catch {
                // A consumer hook must not break other consumers
            }
        }
    };
    const installed = { callbacks, hook, previous };
    dispatcher = installed;
    engine.promiseHook(hook);
    return installed;
}

function uninstallDispatcher(installed: Dispatcher): void {
    if (dispatcher !== installed || installed.callbacks.size > 0) return;
    // Restore the previous hook (if any)
    if (engine.promiseHook() === installed.hook) engine.promiseHook(installed.previous);
    dispatcher = undefined;
}

/**
 * Register a promise hook callback.
 * @returns A function to unregister this callback
 */
export function addPromiseHook(callback: PromiseHookCallback): () => void {
    if (typeof callback !== 'function') {
        throw new TypeError('Promise hook callback must be a function');
    }
    const installed = installDispatcher();
    const registration = { callback };
    installed.callbacks.add(registration);
    let removed = false;
    return () => {
        if (removed) return;
        removed = true;
        installed.callbacks.delete(registration);
        uninstallDispatcher(installed);
    };
}
