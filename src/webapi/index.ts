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
const stream = await import('web-streams-polyfill');
for (const key in stream) {
    if (key === 'default') continue;
    // @ts-ignore
    Reflect.set(globalThis, key, stream[key]);
}

// blob and formdata polyfill
// @ts-ignore
await import('blob-polyfill');
// @ts-ignore
await import('formdata-polyfill');

// abort-signal polyfill
// @ts-ignore 欺骗abortcontroller-polyfill
globalThis.fetch = () => void 0;
// @ts-ignore
await import('abortcontroller-polyfill');

// event
// @ts-ignore
await import('event-target-polyfill');
class CustomEvent extends Event implements globalThis.CustomEvent {
    public readonly detail: any;
    constructor(type: string, eventInitDict?: CustomEventInit) {
        super(type, eventInitDict);
        this.detail = eventInitDict?.detail;
    }
}
Reflect.set(globalThis, 'CustomEvent', CustomEvent);

// global event
const globalEvent = new EventTarget();
globalThis.addEventListener = globalEvent.addEventListener.bind(globalEvent);
globalThis.removeEventListener = globalEvent.removeEventListener.bind(globalEvent);
globalThis.dispatchEvent = globalEvent.dispatchEvent.bind(globalEvent);
// brigde cjs event
onEvent((eventName, eventData) => {
    let event;
    switch (eventName) {
        case 'exit':
            event = new Event('exit');
            break;
        default:
            event = new CustomEvent(eventName, {
                detail: eventData
            });
            break;
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
const { Temporal } = await import('temporal-polyfill');
globalThis.Temporal = Temporal;