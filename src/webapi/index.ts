import { fromError, PromiseRejectionEvent, EventTarget } from './events';
import { installWebApiEventReceiver } from './event-mux-bootstrap';
import { defineLazy } from '../utils/lazy-accessor';

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
 * EV_BEFORE_UNLOAD, read from the runtime enum (fallback 4): the hand-maintained
 * `types/engine.d.ts` enum stops at LOAD and drifts from the binary.
 */
const EV_BEFORE_UNLOAD: number = (() => {
    const v = (EventType as unknown as Record<string, unknown>)?.BEFORE_UNLOAD;
    return typeof v === 'number' ? v : 4;
})();

/**
 * `isWorker` is defined by the runtime (vm.c:407). `tjs__lifecycle_drain` already
 * skips workers, but worker teardown reaches EV_EXIT through uv__stop instead, so
 * the EXIT arm below repeats the exclusion.
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
        const event = new Event('beforeunload', { cancelable: true });
        // Listener throws propagate so native teardown fails consistently.
        globalEvent.dispatchEvent(event);
        return event.defaultPrevented;
    }

    let event;
    switch (eventName) {
        case EventType.EXIT:
            if (!inWorker()) globalEvent.dispatchEvent(new Event('unload'));
            event = new Event('exit');
            break;
        case EventType.JOB_EXCEPTION:
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
        // Only user cancellation suppresses diagnostics.
        ctx.handled = true;
    }

    // Native return polarity per event is the multiplexer's decision.
    return undefined;
}

await installWebApiEventReceiver(bridgeEvent, () => {
    // Standalone embeddings own the raw single-slot receiver.
    onEvent((eventName: number, eventData: unknown) => {
        const ctx: BridgeCtx = { handled: false, dispatched: false };
        const ret = bridgeEvent(eventName, eventData, ctx);
        if (eventName === EV_BEFORE_UNLOAD) return ret === true;
        return eventName === EventType.JOB_EXCEPTION;
    });
});

// worker
await import('./worker');

// headers
const { Headers } = await import('./headers');
Reflect.set(globalThis, 'Headers', Headers);

// fetch & xhr polyfill (CNO secondary wrapping layer)
await import('./fetch');

// sse(EventSource) polyfill (CNO secondary wrapping layer), lazily evaluated: the
// same reason as the WebSocket client above.
void defineLazy(globalThis as unknown as Record<string, unknown>, [
    { name: 'EventSource', kind: 'ctor' },
], () => import('./sse').then(() => new Map<string, unknown>([
    ['EventSource', Reflect.get(globalThis, 'EventSource')],
])));

// websocket (CNO secondary wrapping layer): the client stack (frames, handshake,
// WebSocketStream) is ~55 KB of bytecode that only a program constructing a
// WebSocket reaches, so the module is not evaluated at boot. The accessors keep
// `typeof WebSocket === 'function'` true and start the load on the first read.
void defineLazy(globalThis as unknown as Record<string, unknown>, [
    { name: 'WebSocket', kind: 'ctor' },
    { name: 'WebSocketStream', kind: 'ctor' },
], () => import('./websocket').then(() => new Map<string, unknown>([
    ['WebSocket', Reflect.get(globalThis, 'WebSocket')],
    ['WebSocketStream', Reflect.get(globalThis, 'WebSocketStream')],
])));

// crypto
await import('./crypto');

// performance
await import('./performance');

// wasm
if (import.meta.use('wasm')) await import('./wasm');

// storage
await import('./storage');

// BroadcastChannel
await import('./broadcast-channel');

// cache
await import('./cache');

// Intl (partial support)
// Always loaded, and still after the globals above: its Date/Number/BigInt re-points
// must land before user code, and node/vm boots user code in the same tick as this
// module resolves, so a lazy typeof/Reflect probe would lose. The deferral lives
// inside intl.ts instead.
await import('./intl');

// webtransport (QUIC) — loads always; native gate fails closed in ctor
await import('./webtransport');
