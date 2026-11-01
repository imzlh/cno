export type RuntimeEventContext = {
    handled: boolean;
    dispatched: boolean;
    rejectionEmitted?: boolean;
};

export type RuntimeEventReceiver = (
    eventName: number,
    eventData: unknown,
    context: RuntimeEventContext,
) => boolean | undefined;

export type RuntimeEventFrame = {
    name: number;
    data: unknown;
    context: RuntimeEventContext;
};

export interface RuntimeEventBus {
    readonly RUNTIME_NAMESPACE: string;
    readonly RUNTIME_EVENT: string;
    on(
        namespace: string,
        event: string,
        listener: (frame: RuntimeEventFrame) => boolean | undefined,
        priority?: number,
    ): () => void;
}

export const PRIORITY_WEBAPI = 100;

const runtimeEventBus = import.meta.use('evbus') as RuntimeEventBus;
const LIFECYCLE_STATE_SLOT = Symbol.for('cno.runtime.lifecycle.v1');

type LifecycleState = {
    loadFired: boolean;
    unloadFired: boolean;
};

const fallbackLifecycleState: LifecycleState = { loadFired: false, unloadFired: false };
const INTERNAL_EVENT_LISTENER = Symbol.for('cno.internal.eventTargetListener');

function lifecycleState(): LifecycleState {
    const target = globalThis as unknown as Record<symbol, unknown>;
    const existing = target[LIFECYCLE_STATE_SLOT];
    if (existing && typeof existing === 'object') {
        const state = existing as Partial<LifecycleState>;
        if (typeof state.loadFired === 'boolean' && typeof state.unloadFired === 'boolean') {
            return state as LifecycleState;
        }
    }
    const state = fallbackLifecycleState;
    try {
        target[LIFECYCLE_STATE_SLOT] = state;
    } catch {
        // An exotic global can reject symbol properties; this copy still stays idempotent.
    }
    return state;
}

/** Track lifecycle events dispatched by another bundle without importing it. */
export function installLifecycleEventObserver(
    subscribe: (type: 'load' | 'unload', listener: () => void) => void,
): void {
    const onLoad = () => { lifecycleState().loadFired = true; };
    const onUnload = () => { lifecycleState().unloadFired = true; };
    Reflect.set(onLoad, INTERNAL_EVENT_LISTENER, true);
    Reflect.set(onUnload, INTERNAL_EVENT_LISTENER, true);
    subscribe('load', onLoad);
    subscribe('unload', onUnload);
}

/** Subscribe Web APIs directly to the runtime event stream. */
export function installWebApiEventReceiver(
    receiver: RuntimeEventReceiver,
    bus: RuntimeEventBus = runtimeEventBus,
): () => void {
    return bus.on(
        bus.RUNTIME_NAMESPACE,
        bus.RUNTIME_EVENT,
        ({ name, data, context }) => receiver(name, data, context),
        PRIORITY_WEBAPI,
    );
}

function dispatchLifecycleEvent(type: 'load' | 'unload'): boolean {
    try {
        globalThis.dispatchEvent(new Event(type));
        return true;
    } catch {
        return false;
    }
}

/** Fire the test harness load event once without depending on CTS. */
export function dispatchLoadEvent(): boolean {
    const state = lifecycleState();
    if (state.loadFired) return false;
    state.loadFired = true;
    return dispatchLifecycleEvent('load');
}

/** Claim this realm's unload event before either native exit or the test harness fires it. */
export function claimUnloadEvent(): boolean {
    const state = lifecycleState();
    if (Reflect.get(globalThis, 'isWorker') === true || state.unloadFired) return false;
    state.unloadFired = true;
    return true;
}

/** Fire the test harness unload event once without depending on CTS. */
export function dispatchUnloadEvent(): boolean {
    return claimUnloadEvent() && dispatchLifecycleEvent('unload');
}
