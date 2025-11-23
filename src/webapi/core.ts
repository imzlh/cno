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

// URL polyfill
// @ts-ignore
await import('url-polyfill');

// web streams polyfill
// @ts-ignore
await import('web-streams-polyfill');

// fetch
// @ts-ignore
await import('whatwg-fetch');

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