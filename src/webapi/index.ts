import { fromError, PromiseRejectionEvent, EventTarget } from './events';

const { onEvent, EventType } = import.meta.use('engine');

// basic polyfills
Object.defineProperties(globalThis, {
    global: {
        value: globalThis,
        writable: false,
        enumerable: true,
        configurable: false
    },
    self: {
        value: globalThis,
        writable: false,
        enumerable: true,
        configurable: false
    },
    window: {
        value: globalThis,
        writable: false,
        enumerable: true,
        configurable: false
    }
});

await Promise.all([
    import('./console'),
    import('./basic'),
    import('./events'),
]);

await Promise.all([
    import('./streams'),
    import('./url'),
    import('./formdata'),
    // @ts-ignore
    import('urlpattern-polyfill'),
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

// bridge cjs event
onEvent((eventName, eventData) => {
    let event;
    switch (eventName) {
        case EventType.EXIT:
            event = new Event('exit');
            break;
        case EventType.JOB_EXCEPTION:
            // @ts-ignore
            event = fromError(eventData);
            event.preventDefault(); // prevent default error event
            break;
        case EventType.UNHANDLED_REJECTION:
            event = new PromiseRejectionEvent('unhandledrejection', {
                // @ts-ignore
                promise: eventData[0],
                // @ts-ignore
                reason: eventData[1]
            }, true)
            break;
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
const { Headers } = await import('headers-polyfill');
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

// webtransport (QUIC)
await import('./webtransport');

// temporal
// const { Temporal } = await import('temporal-polyfill');
// globalThis.Temporal = Temporal;
