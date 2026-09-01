import { fromError, PromiseRejectionEvent, EventTarget } from './events';
import { installWebApiEventReceiver } from './event-mux-bootstrap';

const { onEvent, EventType } = import.meta.use('engine');

// basic polyfills
Object.defineProperties(globalThis, {
    global: {
        value: globalThis,
        writable: true,
        enumerable: true,
        configurable: false
    },
    self: {
        value: globalThis,
        writable: false,
        enumerable: true,
        configurable: false,
    },
    // Deno main thread: globalThis.window is undefined (not an alias of globalThis).
    window: {
        value: undefined,
        writable: true,
        enumerable: true,
        configurable: true,
    },
    name: {
        value: '',
        writable: true,
        enumerable: true,
        configurable: true,
    },
});

await Promise.all([
    import('./console'),
    import('./basic'),
    import('./events'),
]);

await Promise.all([
    import('./streams'),
    import('./url'),
    import('./location'),
    import('./formdata'),
    import('./urlpattern'),
]);

await Promise.all([
    import('./file-reader'),
    import('./image-data'),
]);

// navigator
await import('./navigator');

// abort-signal polyfill
await import('./abort');

// messaging (MessageChannel, MessagePort)
await import('./messaging');

// global event
const globalEvent = new EventTarget();
Reflect.set(globalThis, 'addEventListener', globalEvent.addEventListener.bind(globalEvent));
Reflect.set(globalThis,'removeEventListener', globalEvent.removeEventListener.bind(globalEvent));
Reflect.set(globalThis, 'dispatchEvent', globalEvent.dispatchEvent.bind(globalEvent));

// onload / onunload property bridges (specs/test/load_unload, specs/run/_078_unload)
function defineGlobalHandler(prop: string, type: string): void {
    let handler: ((ev: globalThis.Event) => void) | null = null;
    const wrapper = (ev: globalThis.Event) => { if (handler) handler.call(globalThis, ev); };
    Object.defineProperty(globalThis, prop, {
        get() { return handler; },
        set(fn: unknown) {
            // @ts-ignore - event
            if (handler) globalEvent.removeEventListener(type, wrapper);
            handler = typeof fn === 'function' ? fn as (ev: Event) => void : null;
            // @ts-ignore - event
            if (handler) globalEvent.addEventListener(type, wrapper);
        },
        enumerable: true,
        configurable: true,
    });
}
defineGlobalHandler('onload', 'load');
defineGlobalHandler('onunload', 'unload');
defineGlobalHandler('onbeforeunload', 'beforeunload');

// Web lifecycle events share the CTS event multiplexer when available.
type BridgeCtx = { handled: boolean; dispatched: boolean };

/**
 * EV_BEFORE_UNLOAD (circu.js/src/private.h:172, exposed at mod_engine.c:1281).
 *
 * Read from the runtime enum rather than written as `EventType.BEFORE_UNLOAD`:
 * the hand-maintained `types/engine.d.ts` enum still stops at LOAD, and it is
 * duplicated across four submodules. Taking the live value (with the C constant
 * as fallback) cannot drift from the binary the way the declaration has.
 */
const EV_BEFORE_UNLOAD: number = (() => {
    const v = (EventType as unknown as Record<string, unknown>)?.BEFORE_UNLOAD;
    return typeof v === 'number' ? v : 4;
})();

/**
 * Is this runtime a worker? `vm.c:407` defines the global for exactly this kind
 * of check. Deno fires neither 'beforeunload' nor 'unload' inside a worker
 * (OBSERVED), and `tjs__lifecycle_drain` already returns early for is_worker —
 * but worker teardown reaches EV_EXIT by a different route (uv__stop), so the
 * EXIT arm below has to make the same exclusion itself.
 */
function inWorker(): boolean {
    return Reflect.get(globalThis, 'isWorker') === true;
}

function bridgeEvent(
    eventName: number,
    eventData: unknown,
    ctx: BridgeCtx,
): boolean | undefined {
    // beforeunload returns its cancellation decision directly to the native loop.
    if (eventName === EV_BEFORE_UNLOAD) {
        // beforeunload is cancelable; unload is not.
        const event = new Event('beforeunload', { cancelable: true });

        // Listener throws propagate so native teardown fails consistently.
        globalEvent.dispatchEvent(event);

        // Native teardown cancels only on explicit true from preventDefault().
        return event.defaultPrevented;
    }

    let event;
    switch (eventName) {
        case EventType.EXIT:
            // Workers do not receive the process unload lifecycle.
            if (!inWorker()) globalEvent.dispatchEvent(new Event('unload'));
            event = new Event('exit');
            break;
        case EventType.JOB_EXCEPTION:
            // Only listener cancellation marks a job exception handled.
            event = fromError(eventData);
            break;
        case EventType.UNHANDLED_REJECTION: {
            const [promise, reason] = eventData as CModuleEngine.GlobalEvents[CModuleEngine.EventType.UNHANDLED_REJECTION];
            event = new PromiseRejectionEvent('unhandledrejection', {
                promise,
                reason,
                cancelable: true,
            }, true)
            break;
        }
        case EventType.LOAD:
            event = new Event('load');
            break;
        default:
            return undefined;
    }
    globalEvent.dispatchEvent(event);
    ctx.dispatched = true;

    if (event.defaultPrevented) {
        // Suppress diagnostics only when user code cancelled the default action.
        ctx.handled = true;
    }

    // Event-specific native return polarity is owned by the multiplexer.
    return undefined;
}

await installWebApiEventReceiver(bridgeEvent, () => {
    // Standalone embeddings own the raw single-slot receiver.
    onEvent((eventName: number, eventData: unknown) => {
        const ctx: BridgeCtx = { handled: false, dispatched: false };
        const ret = bridgeEvent(eventName, eventData, ctx);
        // Carry beforeunload cancellation through the standalone receiver.
        if (eventName === EV_BEFORE_UNLOAD) return ret === true;
        // Preserve the legacy contract in this path: rejections must not abort.
        return eventName === EventType.JOB_EXCEPTION ? true : false;
    });
});

// worker
await import('./worker');

// headers
const { Headers } = await import('./headers');
Reflect.set(globalThis, 'Headers', Headers);

// fetch & xhr polyfill (CNO secondary wrapping layer)
await import('./fetch');

// sse(EventSource) polyfill (CNO secondary wrapping layer)
await import('./sse');

// websocket (CNO secondary wrapping layer)
await import('./websocket');

// crypto
await import('./crypto');

// performance
await import('./performance');

// wasm
await import('./wasm');

// storage
await import('./storage');

// BroadcastChannel
await import('./broadcast-channel');

// CacheStorage / Cache API
await import('./cache');

// Scheduling API (scheduler.postTask)
const { scheduler } = await import('./scheduler');
Reflect.set(globalThis, 'scheduler', scheduler);

// Intl (partial support)
await import('./intl');

// webtransport (QUIC) — loads always; native gate fails closed in ctor
await import('./webtransport');
