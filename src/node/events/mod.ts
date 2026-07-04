/**
 * Node.js events module
 * EventEmitter pattern implementation
 */

const console = import.meta.use('console');

type EventMap<T> = Record<keyof T, any[]>;
type EventName = string | symbol;
type Listener<T extends EventMap<T>, E extends EventName> = (...args: any[]) => void;
type ListenerEntry = { listener: Function; once: boolean };

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

function createAbortError(reason?: any): any {
    if (reason !== undefined) return reason;
    if (typeof globalThis.DOMException === 'function') {
        return new globalThis.DOMException('The operation was aborted', 'AbortError');
    }
    return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export interface EventEmitter<T extends EventMap<T> = any> {
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
    emit<E extends EventName>(eventName: E, ...args: any[]): boolean;
    eventNames(): EventName[];
    listeners<E extends EventName>(eventName: E): any[];
    rawListeners<E extends EventName>(eventName: E): any[];
    listenerCount<E extends EventName>(eventName: E, listener?: Function): number;
    getMaxListeners(): number;
    setMaxListeners(n: number): this;
}

export interface EventEmitterConstructor {
    new <T extends EventMap<T> = any>(options?: EventEmitterOptions): EventEmitter<T>;
    <T extends EventMap<T> = any>(options?: EventEmitterOptions): EventEmitter<T>;
    prototype: EventEmitter<any>;
    defaultMaxListeners: number;
    captureRejectionSymbol: symbol;
    errorMonitor: symbol;
    usingDomains: boolean;
    getEventListeners(emitter: EventEmitter | EventTarget, name: EventName): Function[];
    getMaxListeners(emitter: EventEmitter | EventTarget): number;
    setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void;
    listenerCount(emitter: EventEmitter, eventName: EventName): number;
    on(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): AsyncIterableIterator<any>;
    once(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): Promise<any[]>;
}

function ensureEventEmitterState(self: any): asserts self is EventEmitter<any> {
    if (!(self._events instanceof Map)) self._events = new Map();
    if (typeof self._maxListeners !== 'number' || Number.isNaN(self._maxListeners)) self._maxListeners = EventEmitter.defaultMaxListeners;
    if (typeof self._captureRejections !== 'boolean') self._captureRejections = false;
}

function initEventEmitter(self: any, options?: EventEmitterOptions): void {
    ensureEventEmitterState(self);
    if (options?.captureRejections) {
        self._captureRejections = true;
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

export const EventEmitter: EventEmitterConstructor = function EventEmitter(this: any, options?: EventEmitterOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(EventEmitter.prototype);
    initEventEmitter(target, options);
    return target;
} as EventEmitterConstructor;

EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');
EventEmitter.errorMonitor = Symbol('events.errorMonitor');
EventEmitter.usingDomains = false;
EventEmitter.defaultMaxListeners = 10;

EventEmitter.prototype.ensureState = function ensureState(): void {
    ensureEventEmitterState(this);
};

EventEmitter.prototype.addListener = function addListener(eventName: EventName, listener: Function): EventEmitter {
    return this.on(eventName, listener as Listener<any, EventName>);
};

EventEmitter.prototype.on = function on(eventName: EventName, listener: Function): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    let listeners = this._events.get(eventName);
    if (!listeners) {
        listeners = [];
        this._events.set(eventName, listeners);
    }

    listeners.push({ listener, once: false });

    if (eventName !== 'newListener') {
        this.emit('newListener', eventName, listener);
    }

    if (listeners.length > this._maxListeners && this._maxListeners !== 0) {
        console.warn(
            `Possible EventEmitter memory leak detected. ${listeners.length} ${String(eventName)} listeners added. Use emitter.setMaxListeners() to increase limit`
        );
    }

    return this;
};

EventEmitter.prototype.once = function once(eventName: EventName, listener: Function): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    let listeners = this._events.get(eventName);
    if (!listeners) {
        listeners = [];
        this._events.set(eventName, listeners);
    }

    listeners.push({ listener, once: true });

    if (eventName !== 'newListener') {
        this.emit('newListener', eventName, listener);
    }

    return this;
};

EventEmitter.prototype.prependListener = function prependListener(eventName: EventName, listener: Function): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    let listeners = this._events.get(eventName);
    if (!listeners) {
        listeners = [];
        this._events.set(eventName, listeners);
    }

    listeners.unshift({ listener, once: false });
    return this;
};

EventEmitter.prototype.prependOnceListener = function prependOnceListener(eventName: EventName, listener: Function): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    let listeners = this._events.get(eventName);
    if (!listeners) {
        listeners = [];
        this._events.set(eventName, listeners);
    }

    listeners.unshift({ listener, once: true });
    return this;
};

EventEmitter.prototype.removeListener = function removeListener(eventName: EventName, listener: Function): EventEmitter {
    this.ensureState();
    if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function');
    }

    const listeners = this._events.get(eventName);
    if (!listeners) return this;

    const index = listeners.findIndex((entry) => entry.listener === listener);
    if (index !== -1) {
        listeners.splice(index, 1);
        if (listeners.length === 0) {
            this._events.delete(eventName);
        }
        this.emit('removeListener', eventName, listener);
    }

    return this;
};

EventEmitter.prototype.off = function off(eventName: EventName, listener: Function): EventEmitter {
    return this.removeListener(eventName, listener as Listener<any, EventName>);
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

EventEmitter.prototype.emit = function emit(eventName: EventName, ...args: any[]): boolean {
    this.ensureState();
    const listeners = this._events.get(eventName);
    if (!listeners || listeners.length === 0) {
        if (eventName === 'error') {
            const err = args[0];
            if (err instanceof Error) throw err;
            throw new Error('Unhandled error.');
        }
        return false;
    }

    const toCall = [...listeners];

    for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].once) {
            listeners.splice(i, 1);
        }
    }

    if (listeners.length === 0) {
        this._events.delete(eventName);
    }

    for (const { listener } of toCall) {
        try {
            const result = listener.apply(this, args);
            if (this._captureRejections && result instanceof Promise) {
                result.catch((err) => {
                    this.emit(EventEmitter.captureRejectionSymbol, err, eventName, ...args);
                });
            }
        } catch (err) {
            if (eventName === 'error') throw err;
            if (this._emittingError) throw err;
            this._emittingError = true;
            try {
                this.emit('error', err);
            } finally {
                this._emittingError = false;
            }
        }
    }

    return true;
};

EventEmitter.prototype.eventNames = function eventNames(): EventName[] {
    this.ensureState();
    return Array.from(this._events.keys());
};

EventEmitter.prototype.listeners = function listeners(eventName: EventName): any[] {
    this.ensureState();
    const listeners = this._events.get(eventName);
    return listeners ? listeners.map((entry) => entry.listener) : [];
};

EventEmitter.prototype.rawListeners = function rawListeners(eventName: EventName): any[] {
    return this.listeners(eventName);
};

EventEmitter.prototype.listenerCount = function listenerCount(eventName: EventName, listener?: Function): number {
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

EventEmitter.getEventListeners = function getEventListeners(emitter: EventEmitter | EventTarget, name: EventName): Function[] {
    if (emitter instanceof EventEmitter) {
        return emitter.listeners(name);
    }
    return [];
};

EventEmitter.getMaxListeners = function getMaxListeners(emitter: EventEmitter | EventTarget): number {
    if (emitter instanceof EventEmitter) {
        return emitter.getMaxListeners();
    }
    return 10;
};

EventEmitter.setMaxListeners = function setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void {
    for (const target of eventTargets) {
        if (target instanceof EventEmitter) {
            target.setMaxListeners(n);
        }
    }
};

EventEmitter.listenerCount = function listenerCount(emitter: EventEmitter, eventName: EventName): number {
    return emitter.listenerCount(eventName);
};

EventEmitter.on = function on(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): AsyncIterableIterator<any> {
    const signal = options?.signal;
    const queue: any[][] = [];
    const waiters: Array<{ resolve: (value: IteratorResult<any>) => void; reject: (reason?: any) => void }> = [];
    let finished = false;
    let error: any;

    const cleanup = () => {
        emitter.off(eventName, onEvent);
        if (eventName !== 'error') emitter.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
    };

    const finish = (err?: any) => {
        if (finished) return;
        finished = true;
        error = err;
        cleanup();

        while (waiters.length > 0) {
            const waiter = waiters.shift()!;
            if (err !== undefined) waiter.reject(err);
            else waiter.resolve({ done: true, value: undefined });
        }
    };

    const onEvent = (...args: any[]) => {
        if (finished) return;
        const waiter = waiters.shift();
        if (waiter) {
            waiter.resolve({ done: false, value: args });
            return;
        }
        queue.push(args);
    };

    const onError = (err: any) => {
        finish(err);
    };

    const onAbort = () => {
        finish(createAbortError(signal?.reason));
    };

    if (signal?.aborted) {
        finish(createAbortError(signal.reason));
    } else {
        emitter.on(eventName, onEvent);
        if (eventName !== 'error') emitter.on('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
    }

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next() {
            if (queue.length > 0) {
                return { done: false, value: queue.shift()! };
            }
            if (error !== undefined) {
                throw error;
            }
            if (finished) {
                return { done: true, value: undefined };
            }
            return new Promise((resolve, reject) => {
                waiters.push({ resolve, reject });
            });
        },
        async return() {
            finish();
            return { done: true, value: undefined };
        },
        async throw(err?: any) {
            finish(err);
            throw err;
        },
    } as AsyncIterableIterator<any>;
};

EventEmitter.once = function once(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const signal = options?.signal;

        if (signal?.aborted) {
            reject(createAbortError(signal.reason));
            return;
        }

        const onEvent = (...args: any[]) => {
            cleanup();
            resolve(args);
        };

        const onError = (err: any) => {
            cleanup();
            reject(err);
        };

        const onAbort = () => {
            cleanup();
            reject(createAbortError(signal!.reason));
        };

        const cleanup = () => {
            emitter.off(eventName, onEvent);
            if (eventName !== 'error') emitter.off('error', onError);
            signal?.removeEventListener('abort', onAbort);
        };

        emitter.once(eventName, onEvent);
        if (eventName !== 'error') emitter.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
};

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
    this: any,
    options?: EventEmitterAsyncResourceOptions
) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(EventEmitterAsyncResource.prototype);
    EventEmitter.call(target, options);
    return target;
} as EventEmitterAsyncResourceConstructor;

Object.setPrototypeOf(EventEmitterAsyncResource, EventEmitter);
EventEmitterAsyncResource.prototype = Object.create(EventEmitter.prototype);

EventEmitterAsyncResource.prototype.emit = function emit(eventName: EventName, ...args: any[]): boolean {
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

export function getEventListeners(emitter: EventEmitter | EventTarget, name: EventName): Function[] {
    return getEventListenersImpl(emitter, name);
}

export function once(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): Promise<any[]> {
    return onceImpl(emitter, eventName, options);
}

export function on(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): AsyncIterableIterator<any> {
    return onImpl(emitter, eventName, options);
}

export function setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void {
    setMaxListenersImpl(n, ...eventTargets);
}

export function addAbortListener(signal: AbortSignal, listener: () => void): { remove(): void } {
    signal.addEventListener('abort', listener, { once: true });
    return { remove: () => signal.removeEventListener('abort', listener) };
}
