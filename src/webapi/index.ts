import { fromError, PromiseRejectionEvent, EventTarget } from './events';

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

// bridge cjs event
onEvent((eventName, eventData) => {
    let event;
    switch (eventName) {
        case EventType.EXIT:
            // Process exit: fire unload then exit (Deno order approximates).
            globalEvent.dispatchEvent(new Event('unload'));
            event = new Event('exit');
            break;
        case EventType.JOB_EXCEPTION:
            event = fromError(eventData);
            event.preventDefault(); // prevent default error event
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
            return true;
    }
    globalEvent.dispatchEvent(event);
    if (event.defaultPrevented) return true;
    return false;
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

// temporal
// const { Temporal } = await import('temporal-polyfill');
// globalThis.Temporal = Temporal;
