/**
 * Node.js events module
 * EventEmitter pattern implementation
 */

const console = import.meta.use('console');

import { inspect } from '../util/inspect';
import { flattenPrototype } from '../_internal/prototype';

type EventArgs = unknown[];
type EventMap<T> = Record<keyof T, EventArgs>;
type DefaultEventMap = Record<EventName, EventArgs>;
type EventName = string | symbol;
type AnyListener = { bivarianceHack(...args: EventArgs): unknown }['bivarianceHack'];
type Listener<T extends EventMap<T>, E extends EventName> = AnyListener;
// Node stores a bare function for one listener and an array (carrying `.warned`)
// for two or more. Once-listeners are stored as a wrapper exposing `.listener`.
type OnceWrapper = AnyListener & { listener: AnyListener; fired?: boolean };
type ListenerList = AnyListener[] & { warned?: boolean };
type EventStore = Record<EventName, AnyListener | ListenerList>;
type EventListenerValue = AnyListener | EventListenerObject;
type PromiseLikeResult = { then(onFulfilled?: unknown, onRejected?: (err: unknown) => void): unknown };
type CaptureRejectionEmitter = EventEmitter & Record<symbol, unknown>;
type EventEmitterState = {
    _events?: EventStore;
    _eventsCount?: number;
    _maxListeners?: number;
    _captureRejections?: boolean;
};
type EventTargetPrototypeWithTracking = typeof EventTarget.prototype & {
    __cnoNodeEventsTracking?: true;
};

function arrayAppend<T>(array: T[], value: T): void {
    array[array.length] = value;
}

function arrayPrepend<T>(array: T[], value: T): void {
    array.length++;
    array.copyWithin(1, 0);
    array[0] = value;
}

function arrayRemoveAt<T>(array: T[], index: number): void {
    array.copyWithin(index, index + 1);
    array.length = Math.max(0, array.length - 1);
}

function arrayUnshift<T>(array: T[], value: T): void {
    arrayPrepend(array, value);
}

function createEventStore(): EventStore {
    // `{ __proto__: null }` is syntax, not a method call, so this keeps working
    // when userland deletes Object.create — which the `does not depend on
    // mutable Object helpers` guard deletes on purpose. The old `new Map()`
    // sidestepped that dependency for free; Object.create(null) would not.
    return { __proto__: null } as unknown as EventStore;
}

function arrayShift<T>(array: T[]): T | undefined {
    if (array.length === 0) return undefined;
    const first = array[0];
    arrayRemoveAt(array, 0);
    return first;
}

function isPromiseLikeResult(value: unknown): value is PromiseLikeResult {
    return !!value && typeof value === 'object' && typeof Reflect.get(value, 'then') === 'function';
}

function normalizeEventName(eventName: unknown): EventName {
    return typeof eventName === 'symbol' ? eventName : String(eventName);
}

function validateMaxListeners(value: unknown, name: string): asserts value is number {
    if (typeof value !== 'number') {
        throw Object.assign(new TypeError(`The "${name}" argument must be of type number.`), {
            code: 'ERR_INVALID_ARG_TYPE',
        });
    }
    if (value < 0 || Number.isNaN(value)) {
        throw Object.assign(new RangeError(`The value of "${name}" is out of range. It must be >= 0.`), {
            code: 'ERR_OUT_OF_RANGE',
        });
    }
}

function describeReceived(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'object' || type === 'function') {
        const ctor = Reflect.get(Object(value), 'constructor');
        const ctorName = typeof ctor === 'function' ? ctor.name : undefined;
        return `an instance of ${ctorName || 'Object'}`;
    }
    if (type === 'string') return `type string ('${String(value)}')`;
    if (type === 'bigint') return `type bigint (${String(value)}n)`;
    return `type ${type} (${String(value)})`;
}

function validateListener(listener: unknown): asserts listener is AnyListener {
    if (typeof listener !== 'function') {
        throw Object.assign(
            new TypeError(`The "listener" argument must be of type function. Received ${describeReceived(listener)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
}

function emitProcessWarning(warning: Error): void {
    const proc = Reflect.get(globalThis, 'process');
    const emit = proc === null || proc === undefined ? undefined : Reflect.get(Object(proc), 'emitWarning');
    if (typeof emit === 'function') emit.call(proc, warning);
    else console.warn(warning.message);
}

export interface EventEmitterOptions {
    captureRejections?: boolean;
}

export interface StaticEventEmitterOptions {
    signal?: AbortSignal;
}

export interface StaticEventEmitterIteratorOptions extends StaticEventEmitterOptions {
    close?: Iterable<string>;
    highWaterMark?: number;
    lowWaterMark?: number;
}

export interface EventEmitterAsyncResourceOptions extends EventEmitterOptions {
    name?: string;
    triggerAsyncId?: number;
    requireManualDestroy?: boolean;
}

function createAbortError(reason?: unknown): Error & { code: string; cause?: unknown } {
    const err: Error & { code: string; cause?: unknown } = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
    });
    if (reason !== undefined) err.cause = reason;
    return err;
}

const MAX_WATERMARK = Number.MAX_SAFE_INTEGER;

// Mirrors Node's validateInteger(value, `options.${name}`, 1, MAX_SAFE_INTEGER).
function validateWatermark(value: unknown, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number') {
        throw Object.assign(
            new TypeError(`The "options.${name}" property must be of type number. Received ${describeReceived(value)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    if (!Number.isInteger(value)) {
        throw Object.assign(
            new RangeError(`The value of "options.${name}" is out of range. It must be an integer. Received ${value}`),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }
    if (value < 1 || value > MAX_WATERMARK) {
        throw Object.assign(
            new RangeError(`The value of "options.${name}" is out of range. It must be >= 1 && <= ${MAX_WATERMARK}. Received ${value}`),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }
    return value;
}

function invalidIteratorError(err: unknown): TypeError & { code: string } {
    return Object.assign(
        new TypeError(`The "EventEmitter.AsyncIterator" property must be an instance of Error. Received ${describeReceived(err)}`),
        { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

const kWatermarkData = Symbol.for('nodejs.watermarkData');

export interface EventEmitter<T extends EventMap<T> = DefaultEventMap> {
    _events: EventStore;
    _eventsCount: number;
    _maxListeners?: number;
    _captureRejections: boolean;
    _emittingError?: boolean;
    ensureState(): void;
    addListener<E extends EventName>(eventName: E, listener: Listener<T, E>): this;
    on<E extends EventName>(eventName: E, listener: Listener<T, E>): this;
    once<E extends EventName>(eventName: E, listener: Listener<T, E>): this;
    prependListener<E extends EventName>(eventName: E, listener: Listener<T, E>): this;
    prependOnceListener<E extends EventName>(eventName: E, listener: Listener<T, E>): this;
    removeListener<E extends EventName>(eventName: E, listener: Listener<T, E>): this;
    off<E extends EventName>(eventName: E, listener: Listener<T, E>): this;
    removeAllListeners(eventName?: EventName): this;
    emit<E extends EventName>(eventName: E, ...args: EventArgs): boolean;
    eventNames(): EventName[];
    listeners<E extends EventName>(eventName: E): AnyListener[];
    rawListeners<E extends EventName>(eventName: E): AnyListener[];
    listenerCount<E extends EventName>(eventName: E, listener?: AnyListener): number;
    getMaxListeners(): number;
    setMaxListeners(n: number): this;
}

export interface EventEmitterConstructor {
    new <T extends EventMap<T> = DefaultEventMap>(options?: EventEmitterOptions): EventEmitter<T>;
    <T extends EventMap<T> = DefaultEventMap>(options?: EventEmitterOptions): EventEmitter<T>;
    prototype: EventEmitter;
    defaultMaxListeners: number;
    captureRejections: boolean;
    captureRejectionSymbol: symbol;
    errorMonitor: symbol;
    usingDomains: boolean;
    init(this: EventEmitter, options?: EventEmitterOptions): void;
    getEventListeners(emitter: EventEmitter | EventTarget, name: EventName): EventListenerValue[];
    getMaxListeners(emitter: EventEmitter | EventTarget): number;
    setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void;
    listenerCount(emitter: EventEmitter, eventName: EventName, listener?: AnyListener): number;
    on(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterIteratorOptions): AsyncIterableIterator<EventArgs>;
    once(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterOptions): Promise<EventArgs>;
}

function ensureEventEmitterState(self: unknown): asserts self is EventEmitter {
    const state = self as EventEmitterState;
    const events = state._events;
    if (events === undefined || events === null || typeof events !== 'object') {
        state._events = createEventStore();
        state._eventsCount = 0;
    } else if (typeof state._eventsCount !== 'number') {
        state._eventsCount = Reflect.ownKeys(events).length;
    }
    if (typeof state._captureRejections !== 'boolean') state._captureRejections = false;
}

function initEventEmitter(self: unknown, options?: EventEmitterOptions): void {
    ensureEventEmitterState(self);
    self._captureRejections = options?.captureRejections ?? EventEmitter.captureRejections;
}

function hasMetaListener(self: EventEmitter, eventName: 'newListener' | 'removeListener'): boolean {
    return self._events[eventName] !== undefined;
}

function emitNewListener(self: EventEmitter, eventName: EventName, listener: AnyListener): void {
    if (eventName !== 'newListener' && hasMetaListener(self, 'newListener')) {
        self.emit('newListener', eventName, listener);
    }
}

function emitRemoveListener(self: EventEmitter, eventName: EventName, listener: AnyListener): void {
    if (hasMetaListener(self, 'removeListener')) {
        self.emit('removeListener', eventName, listener);
    }
}

function listenerCountOf(stored: AnyListener | ListenerList | undefined): number {
    if (stored === undefined) return 0;
    return typeof stored === 'function' ? 1 : stored.length;
}

function toListenerList(stored: AnyListener | ListenerList): ListenerList {
    return typeof stored === 'function' ? [stored] as ListenerList : stored;
}

// Node's onceWrapper removes itself before invoking, so `removeListener` fires
// ahead of the listener body and a re-entrant emit cannot double-fire it.
function createOnceWrapper(target: EventEmitter, type: EventName, listener: AnyListener): OnceWrapper {
    const state = { fired: false };
    const wrapped = function onceWrapper(this: unknown, ...args: EventArgs): unknown {
        if (state.fired) return undefined;
        state.fired = true;
        target.removeListener(type, wrapped as AnyListener);
        return listener.apply(target, args);
    } as OnceWrapper;
    Object.defineProperty(wrapped, 'listener', {
        value: listener,
        enumerable: false,
        configurable: true,
        writable: false,
    });
    Object.defineProperty(wrapped, 'fired', {
        get: () => state.fired,
        enumerable: false,
        configurable: true,
    });
    return wrapped;
}

// Shared body for on/once/prependListener/prependOnceListener.
function addListenerTo(self: EventEmitter, eventName: EventName, rawListener: AnyListener, once: boolean, prepend: boolean): EventEmitter {
    self.ensureState();
    eventName = normalizeEventName(eventName);
    validateListener(rawListener);

    emitNewListener(self, eventName, rawListener);

    const listener: AnyListener = once ? createOnceWrapper(self, eventName, rawListener) : rawListener;
    const events = self._events;
    const existing = events[eventName];

    if (existing === undefined) {
        events[eventName] = listener;
        self._eventsCount++;
        return self;
    }

    let list: ListenerList;
    if (typeof existing === 'function') {
        list = (prepend ? [listener, existing] : [existing, listener]) as ListenerList;
        events[eventName] = list;
    } else {
        list = existing;
        if (prepend) arrayUnshift(list, listener);
        else arrayAppend(list, listener);
    }

    warnIfListenerLimitExceeded(self, eventName, list);
    return self;
}

function warnIfListenerLimitExceeded(self: EventEmitter, eventName: EventName, list: ListenerList): void {
    const maxListeners = self.getMaxListeners();
    if (maxListeners <= 0 || list.length <= maxListeners || list.warned) return;
    list.warned = true;

    // Node reports this through process.emitWarning as a MaxListenersExceededWarning.
    const ctor = Reflect.get(Object(self), 'constructor');
    const emitterName = typeof ctor === 'function' && ctor.name ? ctor.name : 'EventEmitter';
    const warning: Error & { emitter?: unknown; type?: EventName; count?: number } = new Error(
        `Possible EventEmitter memory leak detected. ${list.length} ${String(eventName)} listeners added to [${emitterName}]. `
        + `MaxListeners is ${maxListeners}. Use emitter.setMaxListeners() to increase limit`
    );
    warning.name = 'MaxListenersExceededWarning';
    warning.emitter = self;
    warning.type = eventName;
    warning.count = list.length;
    emitProcessWarning(warning);
}

// Deletes an event key, resetting the whole store once the last one goes,
// exactly as Node does so `_events` never accumulates dead keys.
function deleteEventKey(self: EventEmitter, eventName: EventName): void {
    if (--self._eventsCount === 0) {
        self._events = createEventStore();
        self._eventsCount = 0;
    } else {
        delete self._events[eventName];
    }
}

export const EventEmitter: EventEmitterConstructor = function EventEmitter(this: EventEmitter | undefined, options?: EventEmitterOptions) {
    const target: EventEmitter = this ?? Object.create(EventEmitter.prototype);
    initEventEmitter(target, options);
    return target;
} as EventEmitterConstructor;

EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');
EventEmitter.errorMonitor = Symbol('events.errorMonitor');
EventEmitter.usingDomains = false;
EventEmitter.init = function init(this: EventEmitter, options?: EventEmitterOptions): void {
    initEventEmitter(this, options);
};

let defaultMaxListenersValue = 10;
let captureRejectionsValue = false;

Object.defineProperties(EventEmitter, {
    defaultMaxListeners: {
        get: () => defaultMaxListenersValue,
        set: (value: unknown) => {
            validateMaxListeners(value, 'defaultMaxListeners');
            defaultMaxListenersValue = value;
        },
        enumerable: true,
    },
    captureRejections: {
        get: () => captureRejectionsValue,
        set: (value: unknown) => {
            if (typeof value !== 'boolean') {
                throw Object.assign(new TypeError('The "EventEmitter.captureRejections" property must be of type boolean.'), {
                    code: 'ERR_INVALID_ARG_TYPE',
                });
            }
            captureRejectionsValue = value;
        },
        enumerable: true,
    },
});

type EventTargetListenerEntry = { listener: EventListenerOrEventListenerObject; capture: boolean };
const eventTargetListeners = new WeakMap<EventTarget, Map<EventName, EventTargetListenerEntry[]>>();
const eventTargetMaxListeners = new WeakMap<EventTarget, number>();

function isEventTarget(value: unknown): value is EventTarget {
    return typeof EventTarget === 'function' && value instanceof EventTarget;
}

function eventTargetBucket(target: EventTarget, name: EventName): EventTargetListenerEntry[] {
    let events = eventTargetListeners.get(target);
    if (!events) {
        events = new Map();
        eventTargetListeners.set(target, events);
    }
    let listeners = events.get(name);
    if (!listeners) {
        listeners = [];
        events.set(name, listeners);
    }
    return listeners;
}

function eventTargetReceiver(receiver: EventTarget | typeof globalThis | null | undefined): EventTarget | null {
    if (receiver === undefined || receiver === null || receiver === globalThis) return null;
    if (!isEventTarget(receiver)) throw new TypeError('Illegal invocation');
    return receiver;
}

function captureOption(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
    return typeof options === 'boolean' ? options : !!options?.capture;
}

function addStaticListener(emitter: EventEmitter | EventTarget, eventName: string, listener: AnyListener, once = false): void {
    if (isEventTarget(emitter)) {
        emitter.addEventListener(eventName, listener as EventListener, once ? { once: true } : undefined);
        return;
    }
    if (once) emitter.once(eventName, listener);
    else emitter.on(eventName, listener);
}

function removeStaticListener(emitter: EventEmitter | EventTarget, eventName: string, listener: AnyListener): void {
    if (isEventTarget(emitter)) {
        emitter.removeEventListener(eventName, listener as EventListener);
        return;
    }
    emitter.off(eventName, listener);
}

function removeTrackedEventTargetListener(
    target: EventTarget,
    name: EventName,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
): void {
    const listeners = eventTargetListeners.get(target)?.get(name);
    if (!listeners || !listener) return;
    const capture = captureOption(options);
    const index = listeners.findIndex((entry) => entry.listener === listener && entry.capture === capture);
    if (index !== -1) arrayRemoveAt(listeners, index);
}

function trackEventTargetListener(
    target: EventTarget,
    name: EventName,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
): void {
    if (!listener) return;
    const capture = captureOption(options);
    const bucket = eventTargetBucket(target, name);
    if (bucket.some((entry) => entry.listener === listener && entry.capture === capture)) return;
    arrayAppend(bucket, { listener, capture });
    const signal = typeof options === 'object' ? options?.signal : undefined;
    signal?.addEventListener('abort', () => {
        removeTrackedEventTargetListener(target, name, listener, capture);
    }, { once: true });
}

function patchEventTargetTracking(): void {
    const proto = typeof EventTarget === 'function' ? EventTarget.prototype as EventTargetPrototypeWithTracking : undefined;
    if (!proto || proto.__cnoNodeEventsTracking) return;

    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    Object.defineProperty(proto, '__cnoNodeEventsTracking', { value: true });
    const trackedAddEventListener = function addEventListener(
        this: EventTarget | typeof globalThis | null | undefined,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ): void {
        const target = eventTargetReceiver(this);
        if (!target) {
            if (!listener) return;
            return globalThis.addEventListener(type, listener, options);
        }
        trackEventTargetListener(target, type, listener, options);
        return add.call(target, type, listener, options);
    };
    const trackedRemoveEventListener = function removeEventListener(
        this: EventTarget | typeof globalThis | null | undefined,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ): void {
        const target = eventTargetReceiver(this);
        if (!target) {
            if (!listener) return;
            return globalThis.removeEventListener(type, listener, options);
        }
        removeTrackedEventTargetListener(target, type, listener, options);
        return remove.call(target, type, listener, options);
    };
    Object.defineProperty(proto, 'addEventListener', {
        value: trackedAddEventListener,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(proto, 'removeEventListener', {
        value: trackedRemoveEventListener,
        writable: true,
        configurable: true,
    });
}

patchEventTargetTracking();

Object.defineProperties(globalThis, {
    __cnoPatchEventTargetTracking: {
        value: patchEventTargetTracking,
        configurable: true,
    },
    __cnoTrackEventTargetListener: {
        value: trackEventTargetListener,
        configurable: true,
    },
    __cnoUntrackEventTargetListener: {
        value: removeTrackedEventTargetListener,
        configurable: true,
    },
});

EventEmitter.prototype.ensureState = function ensureState(): void {
    ensureEventEmitterState(this);
};

EventEmitter.prototype.addListener = function addListener(eventName: EventName, listener: AnyListener): EventEmitter {
    return this.on(eventName, listener);
};

EventEmitter.prototype.on = function on(eventName: EventName, listener: AnyListener): EventEmitter {
    return addListenerTo(this, eventName, listener, false, false);
};

EventEmitter.prototype.once = function once(eventName: EventName, listener: AnyListener): EventEmitter {
    return addListenerTo(this, eventName, listener, true, false);
};

EventEmitter.prototype.prependListener = function prependListener(eventName: EventName, listener: AnyListener): EventEmitter {
    return addListenerTo(this, eventName, listener, false, true);
};

EventEmitter.prototype.prependOnceListener = function prependOnceListener(eventName: EventName, listener: AnyListener): EventEmitter {
    return addListenerTo(this, eventName, listener, true, true);
};

EventEmitter.prototype.removeListener = function removeListener(eventName: EventName, listener: AnyListener): EventEmitter {
    this.ensureState();
    eventName = normalizeEventName(eventName);
    validateListener(listener);

    const events = this._events;
    const stored = events[eventName];
    if (stored === undefined) return this;

    if (stored === listener || (stored as OnceWrapper).listener === listener) {
        deleteEventKey(this, eventName);
        emitRemoveListener(this, eventName, listener);
        return this;
    }

    if (typeof stored === 'function') return this;

    let position = -1;
    let originalListener: AnyListener | undefined;
    for (let index = stored.length - 1; index >= 0; index--) {
        const candidate = stored[index];
        if (candidate === listener || (candidate as OnceWrapper).listener === listener) {
            originalListener = (candidate as OnceWrapper).listener;
            position = index;
            break;
        }
    }
    if (position < 0) return this;

    arrayRemoveAt(stored, position);
    // Node collapses a single-element list back to a bare function.
    if (stored.length === 1) events[eventName] = stored[0];
    emitRemoveListener(this, eventName, originalListener ?? listener);
    return this;
};

// Node aliases `off` to the SAME function object as `removeListener`
// (`EventEmitter.prototype.off === EventEmitter.prototype.removeListener` is
// true on v24.18), it does not delegate. The difference is load-bearing: a
// subclass that defines `removeListener(...) { return this.off(...) }` — the
// pattern minipass/tar use — recurses forever against a delegating wrapper.
// That surfaced as `Maximum call stack size exceeded` inside `off` and hung
// `tar.c` until the 60s test timeout.
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function removeAllListeners(this: EventEmitter, ...args: [EventName?]): EventEmitter {
    this.ensureState();
    const events = this._events;

    if (!hasMetaListener(this, 'removeListener')) {
        if (args.length === 0) {
            this._events = createEventStore();
            this._eventsCount = 0;
        } else {
            const normalizedName = normalizeEventName(args[0] as EventName);
            if (events[normalizedName] !== undefined) deleteEventKey(this, normalizedName);
        }
        return this;
    }

    if (args.length === 0) {
        for (const key of Reflect.ownKeys(events)) {
            if (key === 'removeListener') continue;
            this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = createEventStore();
        this._eventsCount = 0;
        return this;
    }

    const normalizedName = normalizeEventName(args[0] as EventName);
    const stored = this._events[normalizedName];
    if (stored === undefined) return this;
    if (typeof stored === 'function') {
        this.removeListener(normalizedName, stored);
    } else {
        for (let index = stored.length - 1; index >= 0; index--) {
            this.removeListener(normalizedName, stored[index]);
        }
    }
    return this;
};

function dispatchCaptureRejection(self: EventEmitter, eventName: EventName, args: EventArgs, result: unknown): void {
    if (!self._captureRejections || !isPromiseLikeResult(result)) return;
    result.then(undefined, (err) => {
        const handler = (self as CaptureRejectionEmitter)[EventEmitter.captureRejectionSymbol];
        if (typeof handler === 'function') {
            handler.call(self, err, eventName, ...args);
        } else if (eventName !== 'error') {
            self.emit('error', err);
        }
    });
}

function emitEntries(self: EventEmitter, eventName: EventName, args: EventArgs): boolean {
    const stored = self._events[eventName];
    if (stored === undefined) return false;

    if (typeof stored === 'function') {
        dispatchCaptureRejection(self, eventName, args, stored.apply(self, args));
        return true;
    }
    if (stored.length === 0) return false;

    // Clone: a listener may add or remove listeners during dispatch.
    const listeners = [...stored];
    for (const listener of listeners) {
        dispatchCaptureRejection(self, eventName, args, listener.apply(self, args));
    }
    return true;
}

EventEmitter.prototype.emit = function emit(eventName: EventName, ...args: EventArgs): boolean {
    this.ensureState();
    eventName = normalizeEventName(eventName);
    if (eventName === 'error') {
        emitEntries(this, EventEmitter.errorMonitor, args);
    }
    if (!emitEntries(this, eventName, args)) {
        if (eventName === 'error') {
            const err = args[0];
            if (err instanceof Error) throw err;
            // Node wraps non-Error payloads in ERR_UNHANDLED_ERROR and keeps the original in .context
            const wrapped: Error & { code: string; context?: unknown } = Object.assign(
                new Error(`Unhandled error. (${err === undefined ? 'undefined' : inspect(err)})`),
                { code: 'ERR_UNHANDLED_ERROR' },
            );
            wrapped.context = err;
            throw wrapped;
        }
        return false;
    }

    return true;
};

EventEmitter.prototype.eventNames = function eventNames(): EventName[] {
    this.ensureState();
    // Reflect.ownKeys, not Object.keys: symbol event names are valid and a
    // null-prototype store keeps them as ordinary own keys.
    return Reflect.ownKeys(this._events) as EventName[];
};

EventEmitter.prototype.listeners = function listeners(eventName: EventName): AnyListener[] {
    this.ensureState();
    eventName = normalizeEventName(eventName);
    const stored = this._events[eventName];
    if (stored === undefined) return [];
    // `listeners()` unwraps once-wrappers; `rawListeners()` does not.
    return toListenerList(stored).map((entry) => (entry as OnceWrapper).listener ?? entry);
};

EventEmitter.prototype.rawListeners = function rawListeners(eventName: EventName): AnyListener[] {
    this.ensureState();
    eventName = normalizeEventName(eventName);
    const stored = this._events[eventName];
    if (stored === undefined) return [];
    return toListenerList(stored).slice();
};

EventEmitter.prototype.listenerCount = function listenerCount(eventName: EventName, listener?: AnyListener): number {
    this.ensureState();
    eventName = normalizeEventName(eventName);
    const stored = this._events[eventName];
    if (stored === undefined) return 0;
    if (listener) {
        return toListenerList(stored).filter(
            (entry) => entry === listener || (entry as OnceWrapper).listener === listener,
        ).length;
    }
    return listenerCountOf(stored);
};

EventEmitter.prototype.getMaxListeners = function getMaxListeners(): number {
    this.ensureState();
    return this._maxListeners ?? EventEmitter.defaultMaxListeners;
};

EventEmitter.prototype.setMaxListeners = function setMaxListeners(n: number): EventEmitter {
    this.ensureState();
    validateMaxListeners(n, 'setMaxListeners');
    this._maxListeners = n;
    return this;
};

EventEmitter.getEventListeners = function getEventListeners(emitter: EventEmitter | EventTarget, name: EventName): EventListenerValue[] {
    if (emitter instanceof EventEmitter) {
        return emitter.listeners(name);
    }
    if (isEventTarget(emitter)) {
        return (eventTargetListeners.get(emitter)?.get(name) ?? []).map((entry) => entry.listener);
    }
    throw new TypeError('The "emitter" argument must be an instance of EventEmitter or EventTarget');
};

EventEmitter.getMaxListeners = function getMaxListeners(emitter: EventEmitter | EventTarget): number {
    if (emitter instanceof EventEmitter) {
        return emitter.getMaxListeners();
    }
    if (isEventTarget(emitter)) {
        if (typeof AbortSignal === 'function' && emitter instanceof AbortSignal) {
            return eventTargetMaxListeners.get(emitter) ?? 0;
        }
        return eventTargetMaxListeners.get(emitter) ?? EventEmitter.defaultMaxListeners;
    }
    throw new TypeError('The "emitter" argument must be an instance of EventEmitter or EventTarget');
};

EventEmitter.setMaxListeners = function setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void {
    validateMaxListeners(n, 'setMaxListeners');
    if (eventTargets.length === 0) {
        EventEmitter.defaultMaxListeners = n;
        return;
    }
    for (const target of eventTargets) {
        if (target instanceof EventEmitter) {
            target.setMaxListeners(n);
        } else if (isEventTarget(target)) {
            eventTargetMaxListeners.set(target, n);
        } else {
            throw new TypeError('The "eventTargets" argument must be an instance of EventEmitter or EventTarget');
        }
    }
};

EventEmitter.listenerCount = function listenerCount(emitter: EventEmitter, eventName: EventName, listener?: AnyListener): number {
    return emitter.listenerCount(eventName, listener);
};

EventEmitter.on = function on(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterIteratorOptions): AsyncIterableIterator<EventArgs> {
    const signal = options?.signal;
    const eventTarget = isEventTarget(emitter);
    const high = validateWatermark(options?.highWaterMark, 'highWaterMark', MAX_WATERMARK);
    const low = validateWatermark(options?.lowWaterMark, 'lowWaterMark', 1);
    const closeNames: string[] = [];
    if (options?.close !== undefined && options.close !== null) {
        // Node iterates options.close directly, so a bare string yields its chars.
        for (const name of options.close) arrayAppend(closeNames, name);
    }

    const queue: EventArgs[] = [];
    const waiters: Array<{ resolve: (value: IteratorResult<EventArgs>) => void; reject: (reason?: unknown) => void }> = [];
    let finished = false;
    let error: unknown;
    let paused = false;

    // Node applies backpressure by pausing the emitter itself; a plain
    // EventEmitter has no pause(), where upstream Node throws. Stay tolerant.
    const callFlowControl = (name: 'pause' | 'resume'): void => {
        const fn = Reflect.get(Object(emitter), name);
        if (typeof fn === 'function') fn.call(emitter);
    };

    const cleanup = () => {
        removeStaticListener(emitter, eventName, onEvent);
        if (!eventTarget && eventName !== 'error') removeStaticListener(emitter, 'error', onError);
        for (const name of closeNames) removeStaticListener(emitter, name, onClose);
        signal?.removeEventListener('abort', onAbort);
    };

    // `err === undefined` ends the iterator cleanly; a queued backlog is still
    // drained by next() before `done` is reported, matching Node.
    const finish = (err?: unknown) => {
        if (finished) return;
        finished = true;
        error = err;
        cleanup();

        while (waiters.length > 0) {
            const waiter = arrayShift(waiters);
            if (!waiter) break;
            if (err !== undefined) waiter.reject(err);
            else waiter.resolve({ done: true, value: undefined });
        }
    };

    const onEvent = (...args: EventArgs) => {
        if (finished) return;
        const waiter = arrayShift(waiters);
        if (waiter) {
            waiter.resolve({ done: false, value: args });
            return;
        }
        arrayAppend(queue, args);
        if (!paused && queue.length > high) {
            paused = true;
            callFlowControl('pause');
        }
    };

    const onError = (err: unknown) => {
        finish(err);
    };

    const onClose = () => {
        finish();
    };

    const onAbort = () => {
        finish(createAbortError(signal?.reason));
    };

    if (signal?.aborted) throw createAbortError(signal.reason);

    addStaticListener(emitter, eventName, onEvent);
    if (!eventTarget && eventName !== 'error') addStaticListener(emitter, 'error', onError);
    for (const name of closeNames) addStaticListener(emitter, name, onClose);
    signal?.addEventListener('abort', onAbort, { once: true });

    const iterator = {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next() {
            if (queue.length > 0) {
                const value = arrayShift(queue);
                if (paused && queue.length < low) {
                    paused = false;
                    callFlowControl('resume');
                }
                if (value) return { done: false, value };
            }
            if (error !== undefined) {
                const err = error;
                error = undefined;
                throw err;
            }
            if (finished) {
                return { done: true, value: undefined };
            }
            return new Promise((resolve, reject) => {
                arrayAppend(waiters, { resolve, reject });
            });
        },
        async return() {
            finish();
            return { done: true, value: undefined };
        },
        // Node's throw() is void: it records the error, which the next next() raises.
        throw(err?: unknown) {
            if (!err || !(err instanceof Error)) throw invalidIteratorError(err);
            finish(err);
        },
    };

    Object.defineProperty(iterator, kWatermarkData, {
        value: {
            get size() { return queue.length; },
            get low() { return low; },
            get high() { return high; },
            get isPaused() { return paused; },
        },
        enumerable: false,
        configurable: true,
    });

    return iterator as unknown as AsyncIterableIterator<EventArgs>;
};

EventEmitter.once = function once(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterOptions): Promise<EventArgs> {
    return new Promise((resolve, reject) => {
        const signal = options?.signal;
        const eventTarget = isEventTarget(emitter);

        if (signal?.aborted) {
            reject(createAbortError(signal.reason));
            return;
        }

        const onEvent = (...args: EventArgs) => {
            cleanup();
            resolve(args);
        };

        const onError = (err: unknown) => {
            cleanup();
            reject(err);
        };

        const onAbort = () => {
            cleanup();
            reject(createAbortError(signal?.reason));
        };

        const cleanup = () => {
            removeStaticListener(emitter, eventName, onEvent);
            if (!eventTarget && eventName !== 'error') removeStaticListener(emitter, 'error', onError);
            signal?.removeEventListener('abort', onAbort);
        };

        addStaticListener(emitter, eventName, onEvent, true);
        if (!eventTarget && eventName !== 'error') addStaticListener(emitter, 'error', onError, true);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
};

export const captureRejectionSymbol = EventEmitter.captureRejectionSymbol;
export const errorMonitor = EventEmitter.errorMonitor;
export const captureRejections = EventEmitter.captureRejections;
export const defaultMaxListeners = EventEmitter.defaultMaxListeners;
export const usingDomains = EventEmitter.usingDomains;
export const init = EventEmitter.init;
export const getMaxListeners = EventEmitter.getMaxListeners;
export const listenerCount = EventEmitter.listenerCount;

Object.defineProperty(EventEmitter.prototype, 'constructor', {
    value: EventEmitter,
    writable: true,
    configurable: true,
});

flattenPrototype(EventEmitter.prototype);

export interface EventEmitterAsyncResource extends EventEmitter {}

export interface EventEmitterAsyncResourceConstructor {
    new (options?: EventEmitterAsyncResourceOptions): EventEmitterAsyncResource;
    (options?: EventEmitterAsyncResourceOptions): EventEmitterAsyncResource;
    prototype: EventEmitterAsyncResource;
}

export const EventEmitterAsyncResource: EventEmitterAsyncResourceConstructor = function EventEmitterAsyncResource(
    this: EventEmitterAsyncResource | undefined,
    options?: EventEmitterAsyncResourceOptions
) {
    const target: EventEmitterAsyncResource = this ?? Object.create(EventEmitterAsyncResource.prototype);
    EventEmitter.call(target, options);
    return target;
} as EventEmitterAsyncResourceConstructor;

Object.setPrototypeOf(EventEmitterAsyncResource, EventEmitter);
EventEmitterAsyncResource.prototype = Object.create(EventEmitter.prototype);

EventEmitterAsyncResource.prototype.emit = function emit(eventName: EventName, ...args: EventArgs): boolean {
    return EventEmitter.prototype.emit.call(this, eventName, ...args);
};

Object.defineProperty(EventEmitterAsyncResource.prototype, 'constructor', {
    value: EventEmitterAsyncResource,
    writable: true,
    configurable: true,
});

flattenPrototype(EventEmitterAsyncResource.prototype);

const getEventListenersImpl = EventEmitter.getEventListeners;
const onceImpl = EventEmitter.once;
const onImpl = EventEmitter.on;
const setMaxListenersImpl = EventEmitter.setMaxListeners;

export function getEventListeners(emitter: EventEmitter | EventTarget, name: EventName): EventListenerValue[] {
    return getEventListenersImpl(emitter, name);
}

export function once(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterOptions): Promise<EventArgs> {
    return onceImpl(emitter, eventName, options);
}

export function on(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterIteratorOptions): AsyncIterableIterator<EventArgs> {
    return onImpl(emitter, eventName, options);
}

export function setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void {
    setMaxListenersImpl(n, ...eventTargets);
}

export function addAbortListener(signal: AbortSignal, listener: () => void): { remove(): void; [Symbol.dispose](): void } {
    let removed = false;
    const wrapped = () => {
        if (removed) return;
        removed = true;
        listener();
    };
    const remove = () => {
        removed = true;
        signal.removeEventListener('abort', wrapped);
    };

    if (signal.aborted) queueMicrotask(wrapped);
    else signal.addEventListener('abort', wrapped, { once: true });

    return { remove, [Symbol.dispose]: remove };
}
