type NativeQueueCallback = (...args: unknown[]) => unknown;

export interface NativeQueueResourceOptions {
    repeat?: boolean;
    refreshable?: boolean;
    resource?: object;
    nativeId?: number;
    clearNative?: (id: number) => void;
    onCancel?: () => void;
    onStart?: (resource: NativeQueueResource) => void;
}

export interface NativeQueueResource {
    readonly type: string;
    readonly destroyed: boolean;
    invoke(thisArg: unknown, args: readonly unknown[]): unknown;
    bind(id: number, owner?: object): void;
    refresh(): boolean;
    destroy(): void;
    cancel(): void;
}

export interface NativeQueueAsyncContext {
    init?(): void;
    invoke(callback: NativeQueueCallback, thisArg: unknown, args: readonly unknown[]): unknown;
    destroy(): void;
    release(): void;
}

export interface NativeNextTickEntry {
    callback: (...args: unknown[]) => void;
    args: unknown[];
}

export interface NativeNextTickState {
    queue: NativeNextTickEntry[];
    scheduled: boolean;
    draining: boolean;
    nativeInstalled: boolean;
}

type NativeQueueContextFactory = (type: string, resource: object) => NativeQueueAsyncContext;

interface NativeQueueRuntimeState {
    resources: Map<number, NativeQueueResource>;
    resourcesByHandle?: WeakMap<object, NativeQueueResource>;
    completedResources?: Map<number, WeakRef<NativeQueueResource>>;
    contextFactories?: Set<WeakRef<NativeQueueContextFactory>>;
    /** State written by an older bundle before factories became additive. */
    contextFactory?: NativeQueueContextFactory;
    nextTick?: NativeNextTickState;
}

const evbus = import.meta.use('evbus');
const timers = import.meta.use('timers');
const RUNTIME_NAMESPACE = 'cno.runtime';
const RUNTIME_KEY = 'nativeQueueResources';

function getRuntimeState(): NativeQueueRuntimeState {
    const existing = evbus.get<NativeQueueRuntimeState>(RUNTIME_NAMESPACE, RUNTIME_KEY);
    if (existing !== undefined) return existing;

    const state: NativeQueueRuntimeState = { resources: new Map() };
    evbus.set(RUNTIME_NAMESPACE, RUNTIME_KEY, state);
    return state;
}

const runtimeState = getRuntimeState();
const resourcesByHandle = runtimeState.resourcesByHandle ??= new WeakMap<object, NativeQueueResource>();
const completedResources = runtimeState.completedResources ??= new Map<number, WeakRef<NativeQueueResource>>();
const contextFactoryFinalizer = new FinalizationRegistry<WeakRef<NativeQueueContextFactory>>(
    ref => runtimeState.contextFactories?.delete(ref),
);
const completedResourceFinalizer = new FinalizationRegistry<{ id: number; ref: WeakRef<NativeQueueResource> }>(
    ({ id, ref }) => {
        if (completedResources.get(id) === ref) completedResources.delete(id);
    },
);

export function _registerNativeQueueContextFactory(factory: NativeQueueContextFactory): () => void {
    const factories = runtimeState.contextFactories ??= new Set();
    if (runtimeState.contextFactory) {
        const previous = runtimeState.contextFactory;
        const ref = new WeakRef(previous);
        factories.add(ref);
        contextFactoryFinalizer.register(previous, ref, ref);
        runtimeState.contextFactory = undefined;
    }
    for (const ref of factories) {
        if (ref.deref() === factory) return () => {};
    }
    const ref = new WeakRef(factory);
    factories.add(ref);
    contextFactoryFinalizer.register(factory, ref, ref);
    return () => {
        contextFactoryFinalizer.unregister(ref);
        factories.delete(ref);
    };
}

function createQueueContext(type: string, resource: object): NativeQueueAsyncContext | undefined {
    const factories = runtimeState.contextFactories;
    if (!factories || factories.size === 0) return undefined;

    const contexts: NativeQueueAsyncContext[] = [];
    try {
        for (const ref of factories) {
            const factory = ref.deref();
            if (factory) contexts.push(factory(type, resource));
            else factories.delete(ref);
        }
    } catch (error) {
        // Preserve the factory's error while releasing contexts created before
        // a later bundle's factory failed.
        for (const current of contexts) {
            try { current.destroy(); } catch { /* preserve the original error */ }
            try { current.release(); } catch { /* preserve the original error */ }
        }
        throw error;
    }

    if (contexts.length === 0) return undefined;
    let nextInit = 0;
    let initDepth = 0;
    let destroyPending = false;
    let releasePending = false;
    const finishInit = (): void => {
        if (--initDepth !== 0) return;
        const destroy = destroyPending;
        const release = releasePending;
        destroyPending = false;
        releasePending = false;
        if (destroy && release) disposeContext(combined);
        else if (destroy) combined.destroy();
        else if (release) combined.release();
    };
    const combined: NativeQueueAsyncContext = {
        init() {
            initDepth++;
            try {
                while (nextInit < contexts.length) contexts[nextInit++].init?.();
            } catch (error) {
                try { finishInit(); } finally { throw error; }
            }
            finishInit();
        },
        invoke(callback, thisArg, args) {
            let invoke = (): unknown => Reflect.apply(callback, thisArg, args);
            for (let index = contexts.length - 1; index >= 0; index--) {
                const current = contexts[index];
                const next = invoke;
                invoke = () => current.invoke(next, undefined, []);
            }
            return invoke();
        },
        destroy() {
            if (initDepth !== 0) {
                destroyPending = true;
                return;
            }
            let failure: unknown;
            let failed = false;
            for (const current of contexts) {
                try {
                    current.destroy();
                } catch (error) {
                    if (!failed) {
                        failed = true;
                        failure = error;
                    }
                }
            }
            if (failed) throw failure;
        },
        release() {
            if (initDepth !== 0) {
                releasePending = true;
                return;
            }
            nextInit = contexts.length;
            let failure: unknown;
            let failed = false;
            for (const current of contexts) {
                try {
                    current.release();
                } catch (error) {
                    if (!failed) {
                        failed = true;
                        failure = error;
                    }
                }
            }
            if (failed) throw failure;
        },
    };
    return combined;
}

export function _getNativeNextTickState(): NativeNextTickState {
    if (runtimeState.nextTick) return runtimeState.nextTick;
    runtimeState.nextTick = {
        queue: [],
        scheduled: false,
        draining: false,
        nativeInstalled: false,
    };
    return runtimeState.nextTick;
}

export function _createNativeQueueResource(
    type: string,
    callback: NativeQueueCallback,
    options: NativeQueueResourceOptions = {},
): NativeQueueResource {
    const { repeat, refreshable, clearNative } = options;
    const resource = options.resource ?? {};
    let onCancel = options.onCancel;
    let onStart = options.onStart;
    let context: NativeQueueAsyncContext | undefined;
    let queuedCallback: NativeQueueCallback | undefined = callback;
    let phase: 'initializing' | 'starting' | 'active' | 'completed' | 'closed' = 'initializing';
    let generation = 0;
    let nativeId: number | undefined;
    let invocationDepth = 0;
    let completed: { id: number; ref: WeakRef<NativeQueueResource> } | undefined;

    const unbind = (): number | undefined => {
        const id = nativeId;
        nativeId = undefined;
        if (id === undefined || runtimeState.resources.get(id) !== handle) return undefined;
        runtimeState.resources.delete(id);
        return id;
    };

    const unschedule = (): void => {
        const id = unbind();
        if (id !== undefined) clearNative?.(id);
    };

    const bind = (id: number, owner?: object): void => {
        if (!Number.isFinite(id)) return;
        unbind();
        nativeId = Math.trunc(id);
        completedResources.delete(nativeId);
        runtimeState.resources.set(nativeId, handle);
        if (owner) resourcesByHandle.set(owner, handle);
    };

    const forgetCompleted = (): void => {
        if (!completed) return;
        const { id, ref } = completed;
        if (completedResources.get(id) === ref) completedResources.delete(id);
        completedResourceFinalizer.unregister(handle);
        completed = undefined;
    };

    const releaseContext = (): void => {
        const finished = context;
        context = undefined;
        disposeContext(finished);
    };

    const complete = (): void => {
        const id = unbind();
        if (refreshable) {
            phase = 'completed';
            if (id !== undefined) {
                const ref = new WeakRef(handle);
                completed = { id, ref };
                completedResources.set(id, ref);
                completedResourceFinalizer.register(handle, completed, handle);
            }
        } else {
            phase = 'closed';
            queuedCallback = undefined;
            onCancel = undefined;
            onStart = undefined;
        }
        releaseContext();
    };

    const close = (cancelled: boolean): void => {
        if (phase === 'closed') return;
        phase = 'closed';
        queuedCallback = undefined;
        const notify = cancelled ? onCancel : undefined;
        onCancel = undefined;
        onStart = undefined;
        forgetCompleted();
        try {
            unschedule();
        } finally {
            try {
                notify?.();
            } finally {
                if (invocationDepth === 0) releaseContext();
            }
        }
    };

    const initializeContext = (): void => {
        try {
            const nextContext = createQueueContext(type, resource);
            if (phase === 'initializing') {
                context = nextContext;
                phase = 'starting';
                onStart?.(handle);
                nextContext?.init?.();
                if (phase === 'starting') phase = 'active';
            } else {
                disposeContext(nextContext);
            }
        } catch (error) {
            try { close(true); } finally { throw error; }
        }
    };

    const handle: NativeQueueResource = {
        type,
        get destroyed() {
            return phase === 'completed' || phase === 'closed';
        },
        invoke(thisArg, args) {
            if (phase !== 'active' && phase !== 'starting') return undefined;
            if (phase === 'starting') phase = 'active';
            try {
                context?.init?.();
            } catch (error) {
                try { close(true); } finally { throw error; }
            }
            if (phase !== 'active' || !queuedCallback) return undefined;
            const callbackGeneration = generation;
            invocationDepth++;
            let result: unknown;
            let callbackError: unknown;
            let callbackFailed = false;
            try {
                result = context
                    ? context.invoke(queuedCallback, thisArg, args)
                    : Reflect.apply(queuedCallback, thisArg, args);
            } catch (error) {
                callbackFailed = true;
                callbackError = error;
            }
            try {
                invocationDepth--;
                if (invocationDepth === 0) {
                    if (!queuedCallback) releaseContext();
                    else if (!repeat && generation === callbackGeneration) complete();
                }
            } catch (cleanupError) {
                // A destroy/release hook is cleanup for the callback. Preserve
                // the callback's exception when both paths fail; a cleanup
                // failure remains observable when the callback itself succeeds.
                if (!callbackFailed) throw cleanupError;
            }
            if (callbackFailed) throw callbackError;
            return result;
        },
        bind(id, owner) {
            if (phase === 'active' || phase === 'starting') bind(id, owner);
        },
        refresh() {
            if (phase === 'completed') {
                forgetCompleted();
                phase = 'initializing';
                initializeContext();
            } else if (phase === 'active') {
                if (clearNative) unschedule();
                generation++;
                try {
                    onStart?.(handle);
                } catch (error) {
                    try { close(true); } finally { throw error; }
                }
            }
            return phase === 'active';
        },
        destroy() {
            close(false);
        },
        cancel() {
            close(true);
        },
    };

    if (options.resource) resourcesByHandle.set(options.resource, handle);
    if (options.nativeId !== undefined) bind(options.nativeId);
    initializeContext();
    return handle;
}

function disposeContext(context: NativeQueueAsyncContext | undefined): void {
    if (!context) return;
    let failure: unknown;
    let failed = false;
    try {
        context.destroy();
    } catch (error) {
        failed = true;
        failure = error;
    }
    try {
        context.release();
    } catch (error) {
        if (!failed) {
            failed = true;
            failure = error;
        }
    }
    if (failed) throw failure;
}

function findByOwner(owner: unknown): NativeQueueResource | undefined {
    if (typeof owner === 'object' && owner !== null) return resourcesByHandle.get(owner);
}

function findById(id: number): NativeQueueResource | undefined {
    const current = runtimeState.resources.get(id);
    if (current) return current;
    const completed = completedResources.get(id)?.deref();
    if (!completed) completedResources.delete(id);
    return completed;
}

export function _clearNativeQueueTimer(value: unknown, kind: 'Timeout' | 'Immediate' = 'Timeout'): void {
    let resource = findByOwner(value);
    if (!resource) {
        const id = Math.trunc(Number(value));
        if (!Number.isSafeInteger(id) || id <= 0) return;
        resource = findById(id);
        if (!resource) {
            if (kind === 'Immediate') timers.clearImmediate(id);
            else timers.clearTimeout(id);
            return;
        }
    }
    if (kind === 'Immediate' ? resource.type === 'Immediate' : resource.type === 'Timeout' || resource.type === 'Interval') {
        resource.cancel();
    }
}

export function _cancelNativeQueueResource(
    id: number,
    owner?: unknown,
    allowedTypes?: readonly string[],
): boolean {
    const resource = findByOwner(owner) ?? findById(Math.trunc(id));
    if (!resource || (allowedTypes && !allowedTypes.includes(resource.type))) return false;
    resource.cancel();
    return true;
}
