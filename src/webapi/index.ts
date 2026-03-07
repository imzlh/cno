import { fromError, CustomEvent, PromiseRejectionEvent, EventTarget } from './events';

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

// console with format support
await import('./console');

// basic
await import('./basic');

// URL polyfill
await import('./url');

// URLPattern polyfill
// @ts-ignore
await import('urlpattern-polyfill');

// web streams polyfill
await import('./streams');
// @ts-ignore
// const stream = await import('web-streams-polyfill');
// for (const key in stream) {
//     if (key === 'default') continue;
//     // @ts-ignore
//     Reflect.set(globalThis, key, stream[key]);
// }


// blob
// @ts-ignore
const { Blob, File, FileReader } = await import('blob-polyfill');
Reflect.set(globalThis, 'Blob', Blob);
Reflect.set(globalThis, 'File', File);
Reflect.set(globalThis, 'FileReader', FileReader);

// formdata
const { FormData } = await import('formdata-polyfill/esm.min');
Reflect.set(globalThis, 'FormData', FormData);

// abort-signal polyfill
await import('./abort');

// global event
const globalEvent = new EventTarget();
Reflect.set(globalThis, 'addEventListener', globalEvent.addEventListener.bind(globalEvent));
Reflect.set(globalThis,'removeEventListener', globalEvent.removeEventListener.bind(globalEvent));
Reflect.set(globalThis, 'dispatchEvent', globalEvent.dispatchEvent.bind(globalEvent));

// brigde cjs event
onEvent((eventName, eventData) => {
    let event;
    switch (eventName) {
        case EventType.EXIT:
            event = new Event('exit');
            break;
        case EventType.JOB_EXCEPTION:
            event = fromError(eventData[0]);
            console.log(eventName, eventData);
            event.preventDefault(); // prevent default error event
            break;
        case EventType.UNHANDLED_REJECTION:
            event = new PromiseRejectionEvent('unhandledrejection', {
                promise: eventData[0],
                reason: eventData[1]
            })
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

// headers
const { Headers } = await import('headers-polyfill');
Reflect.set(globalThis, 'Headers', Headers);

// fetch & xhr polyfill
await import('../module/http/fetch');

// sse(EventSource) polyfill
await import('../module/http/sse');

// websocket
await import('../module/http/websocket');

// crypto
await import('./crypto');

// performance
await import('./performance');

// wasm
await import('./wasm');

// storage
await import('./storage');

// Intl (partial support)
await import('./intl');

// temporal
// const { Temporal } = await import('temporal-polyfill');
// globalThis.Temporal = Temporal;