/**
 * Node.js events module
 * EventEmitter pattern implementation
 */

const console = import.meta.use('console');

type EventArgs = unknown[];
type EventMap<T> = Record<keyof T, EventArgs>;
type DefaultEventMap = Record<EventName, EventArgs>;
type EventName = string | symbol;
type AnyListener = { bivarianceHack(...args: EventArgs): unknown }['bivarianceHack'];
type Listener<T extends EventMap<T>, E extends EventName> = AnyListener;
type ListenerEntry = { listener: AnyListener; once: boolean; wrapped?: AnyListener };
type EventListenerValue = AnyListener | EventListenerObject;
type PromiseLikeResult = { then(onFulfilled?: unknown, onRejected?: (err: unknown) => void): unknown };
type CaptureRejectionEmitter = EventEmitter & Record<symbol, unknown>;
type EventEmitterState = {
    _events?: Map<EventName, ListenerEntry[]>;
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

function arrayShift<T>(array: T[]): T | undefined {
    if (array.length === 0) return undefined;
    const first = array[0];
    arrayRemoveAt(array, 0);
    return first;
}

function isPromiseLikeResult(value: unknown): value is PromiseLikeResult {
    return !!value && typeof value === 'object' && typeof Reflect.get(value, 'then') === 'function';
}

export interface EventEmitterOptions {
    captureRejections?: boolean;
}

export interface StaticEventEmitterOptions {
    signal?: AbortSignal;
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

export interface EventEmitter<T extends EventMap<T> = DefaultEventMap> {
    _events: Map<EventName, ListenerEntry[]>;
    _maxListeners: number;
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
    getEventListeners(emitter: EventEmitter | EventTarget, name: EventName): EventListenerValue[];
    getMaxListeners(emitter: EventEmitter | EventTarget): number;
    setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void;
    listenerCount(emitter: EventEmitter, eventName: EventName, listener?: AnyListener): number;
    on(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterOptions): AsyncIterableIterator<EventArgs>;
    once(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterOptions): Promise<EventArgs>;
}

function ensureEventEmitterState(self: unknown): asserts self is EventEmitter {
    const state = self as EventEmitterState;
    if (!(state._events instanceof Map)) state._events = new Map();
    if (typeof state._maxListeners !== 'number' || Number.isNaN(state._maxListeners)) state._maxListeners = EventEmitter.defaultMaxListeners;
    if (typeof state._captureRejections !== 'boolean') state._captureRejections = false;
}

function initEventEmitter(self: unknown, options?: EventEmitterOptions): void {
    ensureEventEmitterState(self);
    self._captureRejections = options?.captureRejections ?? EventEmitter.captureRejections;
}

function hasMetaListener(self: EventEmitter, eventName: 'newListener' | 'removeListener'): boolean {
    return (self._events.get(eventName)?.length ?? 0) > 0;
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

function flattenPrototype(target: object): void {
    const parent = Object.getPrototypeOf(target);
    if (!parent || parent === Object.prototype) return;

    for (const key of Object.getOwnPropertyNames(parent)) {
        if (key === 'constructor' || Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }

    for (const key of Object.getOwnPropertySymbols(parent)) {
        if (Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
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
EventEmitter.defaultMaxListeners = 10;
EventEmitter.captureRejections = false;

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
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    emitNewListener(this, eventName, listener);

    let listeners = this._events.get(eventName);
    if (!listeners) {
        listeners = [];
        this._events.set(eventName, listeners);
    }

    arrayAppend(listeners, { listener, once: false });

    if (listeners.length > this._maxListeners && this._maxListeners !== 0) {
        console.warn(
            `Possible EventEmitter memory leak detected. ${listeners.length} ${String(eventName)} listeners added. Use emitter.setMaxListeners() to increase limit`
        );
    }

    return this;
};

EventEmitter.prototype.once = function once(eventName: EventName, listener: AnyListener): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    emitNewListener(this, eventName, listener);

    let listeners = this._events.get(eventName);
    if (!listeners) {
        listeners = [];
        this._events.set(eventName, listeners);
    }

    const wrapped = function wrappedOnceListener(this: unknown, ...args: EventArgs): unknown {
        return listener.apply(this, args);
    };
    Object.defineProperty(wrapped, 'listener', {
        value: listener,
        enumerable: false,
        configurable: true,
        writable: false,
    });

    arrayAppend(listeners, { listener, once: true, wrapped });

    return this;
};

EventEmitter.prototype.prependListener = function prependListener(eventName: EventName, listener: AnyListener): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    emitNewListener(this, eventName, listener);

    let listeners = this._events.get(eventName);
    if (!listeners) {
        listeners = [];
        this._events.set(eventName, listeners);
    }

    arrayPrepend(listeners, { listener, once: false });
    return this;
};

EventEmitter.prototype.prependOnceListener = function prependOnceListener(eventName: EventName, listener: AnyListener): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    emitNewListener(this, eventName, listener);

    let listeners = this._events.get(eventName);
    if (!listeners) {
        listeners = [];
        this._events.set(eventName, listeners);
    }

    const wrapped = function wrappedOnceListener(this: unknown, ...args: EventArgs): unknown {
        return listener.apply(this, args);
    };
    Object.defineProperty(wrapped, 'listener', {
        value: listener,
        enumerable: false,
        configurable: true,
        writable: false,
    });

    arrayPrepend(listeners, { listener, once: true, wrapped });
    return this;
};

EventEmitter.prototype.removeListener = function removeListener(eventName: EventName, listener: AnyListener): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    const listeners = this._events.get(eventName);
    if (!listeners) return this;

    const index = listeners.findIndex((entry) => entry.listener === listener || entry.wrapped === listener);
    if (index !== -1) {
        arrayRemoveAt(listeners, index);
        if (listeners.length === 0) {
            this._events.delete(eventName);
        }
        emitRemoveListener(this, eventName, listener);
    }

    return this;
};

EventEmitter.prototype.off = function off(eventName: EventName, listener: AnyListener): EventEmitter {
    return this.removeListener(eventName, listener);
};

EventEmitter.prototype.removeAllListeners = function removeAllListeners(eventName?: EventName): EventEmitter {
    this.ensureState();
    if (eventName === undefined) {
        this._events.clear();
    } else {
        this._events.delete(eventName);
    }
    return this;
};

function emitEntries(self: EventEmitter, eventName: EventName, args: EventArgs): boolean {
    const listeners = self._events.get(eventName);
    if (!listeners || listeners.length === 0) return false;

    const toCall = [...listeners];

    for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].once) {
            arrayRemoveAt(listeners, i);
        }
    }

    if (listeners.length === 0) {
        self._events.delete(eventName);
    }

    for (const { listener } of toCall) {
        try {
            const result = listener.apply(self, args);
            if (self._captureRejections && isPromiseLikeResult(result)) {
                result.then(undefined, (err) => {
                    const handler = (self as CaptureRejectionEmitter)[EventEmitter.captureRejectionSymbol];
                    if (typeof handler === 'function') {
                        handler.call(self, err, eventName, ...args);
                    } else if (eventName !== 'error') {
                        self.emit('error', err);
                    }
                });
            }
        } catch (err) {
            if (eventName === 'error') throw err;
            if (self._emittingError) throw err;
            self._emittingError = true;
            try {
                self.emit('error', err);
            } finally {
                self._emittingError = false;
            }
        }
    }

    return true;
}

EventEmitter.prototype.emit = function emit(eventName: EventName, ...args: EventArgs): boolean {
    this.ensureState();
    if (eventName === 'error') {
        emitEntries(this, EventEmitter.errorMonitor, args);
    }
    if (!emitEntries(this, eventName, args)) {
        if (eventName === 'error') {
            const err = args[0];
            if (err instanceof Error) throw err;
            throw new Error('Unhandled error.');
        }
        return false;
    }

    return true;
};

EventEmitter.prototype.eventNames = function eventNames(): EventName[] {
    this.ensureState();
    return Array.from(this._events.keys());
};

EventEmitter.prototype.listeners = function listeners(eventName: EventName): AnyListener[] {
    this.ensureState();
    const listeners = this._events.get(eventName);
    return listeners ? listeners.map((entry) => entry.listener) : [];
};

EventEmitter.prototype.rawListeners = function rawListeners(eventName: EventName): AnyListener[] {
    this.ensureState();
    const listeners = this._events.get(eventName);
    return listeners ? listeners.map((entry) => entry.wrapped ?? entry.listener) : [];
};

EventEmitter.prototype.listenerCount = function listenerCount(eventName: EventName, listener?: AnyListener): number {
    this.ensureState();
    const listeners = this._events.get(eventName);
    if (!listeners) return 0;
    if (listener) {
        return listeners.filter((entry) => entry.listener === listener).length;
    }
    return listeners.length;
};

EventEmitter.prototype.getMaxListeners = function getMaxListeners(): number {
    this.ensureState();
    return this._maxListeners;
};

EventEmitter.prototype.setMaxListeners = function setMaxListeners(n: number): EventEmitter {
    this.ensureState();
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
        throw new RangeError('The value of "n" is out of range. It must be a non-negative number.');
    }
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
        return eventTargetMaxListeners.get(emitter) ?? EventEmitter.defaultMaxListeners;
    }
    throw new TypeError('The "emitter" argument must be an instance of EventEmitter or EventTarget');
};

EventEmitter.setMaxListeners = function setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void {
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
        throw new RangeError('The value of "n" is out of range. It must be a non-negative number.');
    }
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

EventEmitter.on = function on(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterOptions): AsyncIterableIterator<EventArgs> {
    const signal = options?.signal;
    const eventTarget = isEventTarget(emitter);
    const queue: EventArgs[] = [];
    const waiters: Array<{ resolve: (value: IteratorResult<EventArgs>) => void; reject: (reason?: unknown) => void }> = [];
    let finished = false;
    let error: unknown;

    const cleanup = () => {
        removeStaticListener(emitter, eventName, onEvent);
        if (!eventTarget && eventName !== 'error') removeStaticListener(emitter, 'error', onError);
        signal?.removeEventListener('abort', onAbort);
    };

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
    };

    const onError = (err: unknown) => {
        finish(err);
    };

    const onAbort = () => {
        finish(createAbortError(signal?.reason));
    };

    if (signal?.aborted) throw createAbortError(signal.reason);

    addStaticListener(emitter, eventName, onEvent);
    if (!eventTarget && eventName !== 'error') addStaticListener(emitter, 'error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next() {
            if (queue.length > 0) {
                const value = arrayShift(queue);
                if (value) return { done: false, value };
            }
            if (error !== undefined) {
                throw error;
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
        async throw(err?: unknown) {
            finish(err);
            throw err;
        },
    } as AsyncIterableIterator<EventArgs>;
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

export function on(emitter: EventEmitter | EventTarget, eventName: string, options?: StaticEventEmitterOptions): AsyncIterableIterator<EventArgs> {
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
