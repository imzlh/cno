import { assert } from '../utils/assert';

const { onEvent } = import.meta.use('engine');

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
    },
    console: {
        value: import.meta.use('console'),
        writable: false,
        enumerable: true,
        configurable: false
    },
    exports: {
        value: {},
        writable: true,
        enumerable: true,
        configurable: false
    },
    module: {
        value: {
            exports: {}
        },
        writable: true,
        enumerable: true,
        configurable: false
    }
});

// basic
await import('./basic');

// URL polyfill
// @ts-ignore
const { URL, URLSearchParams } = require('whatwg-url');
Reflect.set(globalThis, 'URL', URL);
Reflect.set(globalThis, 'URLSearchParams', URLSearchParams);

// URLPattern polyfill
// @ts-ignore
await import('urlpattern-polyfill');

// web streams polyfill
// @ts-ignore
const stream =  await import('web-streams-polyfill');
for (const key in stream) {
    if (key === 'default') continue;
    // @ts-ignore
    Reflect.set(globalThis, key, stream[key]);
}

// fetch
// @ts-ignore
await import('whatwg-fetch');
assert(globalThis.fetch)

// abort-signal polyfill
// @ts-ignore
await import('abortcontroller-polyfill');

// event
// @ts-ignore
await import('event-target-polyfill');
// @ts-ignore
await import('custom-event-polyfill');
// global event
const globalEvent = new EventTarget();
globalEvent.addEventListener = globalEvent.addEventListener.bind(globalEvent);
globalEvent.removeEventListener = globalEvent.removeEventListener.bind(globalEvent);
globalEvent.dispatchEvent = globalEvent.dispatchEvent.bind(globalEvent);
// brigde cjs event
onEvent((eventName, eventData) => {
    let event;
    switch (eventName) {
        case 'exit':
            event = new Event('exit');
            break;
        default:
            event = new Event(eventName);
            break;
    }
    globalEvent.dispatchEvent(event);
    if(event.defaultPrevented) return true;
    return false;
});

// crypto
await import('./crypto');

// performance
await import('./performance');

// wasm
await import('./wasm');

// websocket
await import('./ws');

// storage
await import('./storage');