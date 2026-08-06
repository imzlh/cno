type MessageHandler = (message: unknown, channelName: ChannelName) => void;
type TraceHandlers = Partial<Record<'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error', MessageHandler>>;
type ChannelName = string | symbol;

function isChannelName(name: unknown): name is ChannelName {
    return typeof name === 'string' || typeof name === 'symbol';
}

/** Node stamps ERR_INVALID_ARG_TYPE on all of these; callers branch on .code. */
function invalidArgType(message: string): TypeError {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

function assertChannelName(name: unknown): asserts name is ChannelName {
    if (!isChannelName(name)) {
        throw invalidArgType('The "channel" argument must be one of type string or symbol');
    }
}

function assertMessageHandler(onMessage: unknown): asserts onMessage is MessageHandler {
    if (typeof onMessage !== 'function') {
        throw invalidArgType('The "subscription" argument must be of type function');
    }
}

type StoreLike = { run<T>(store: unknown, fn: (...args: unknown[]) => T, ...args: unknown[]): T };
type StoreBinding = { store: StoreLike; transform: (message: unknown) => unknown };

export class Channel {
    readonly name: ChannelName;
    private _subscribers: MessageHandler[];
    private _stores: StoreBinding[];

    constructor(name: ChannelName) {
        this.name = name;
        this._subscribers = [];
        this._stores = [];
    }

    subscribe(onMessage: MessageHandler): void {
        assertMessageHandler(onMessage);
        this._subscribers.push(onMessage);
    }

    unsubscribe(onMessage: MessageHandler): boolean {
        return this._unsubscribe(onMessage);
    }

    private _unsubscribe(onMessage: MessageHandler): boolean {
        const index = this._subscribers.indexOf(onMessage);
        if (index === -1) return false;
        this._subscribers.splice(index, 1);
        return true;
    }

    publish(message: unknown): void {
        for (const fn of this._subscribers) {
            try {
                fn(message, this.name);
            } catch (error) {
                queueMicrotask(() => { throw error; });
            }
        }
    }

    /** Binds an AsyncLocalStorage whose store is set from each published message. */
    bindStore(store: StoreLike, transform?: (message: unknown) => unknown): void {
        if (!store || typeof store.run !== 'function') {
            throw invalidArgType('The "store" argument must be an AsyncLocalStorage instance');
        }
        if (transform !== undefined && typeof transform !== 'function') {
            throw invalidArgType('The "transform" argument must be of type function');
        }
        this._stores.push({ store, transform: transform ?? ((message: unknown) => message) });
    }

    unbindStore(store: StoreLike): boolean {
        const index = this._stores.findIndex((binding) => binding.store === store);
        if (index === -1) return false;
        this._stores.splice(index, 1);
        return true;
    }

    /** Runs `fn` inside every bound store; the publish happens inside them too. */
    runStores<T>(message: unknown, fn: (...args: unknown[]) => T, thisArg?: unknown, ...args: unknown[]): T {
        if (typeof fn !== 'function') {
            throw invalidArgType('The "fn" argument must be of type function');
        }
        // publish() must run *inside* the innermost bound store, as Node does —
        // a subscriber calling als.getStore() otherwise sees undefined.
        let run = (): T => {
            this.publish(message);
            return Reflect.apply(fn, thisArg, args) as T;
        };
        for (const { store, transform } of this._stores) {
            const next = run;
            run = () => store.run(transform(message), next);
        }
        return run();
    }

    get hasSubscribers(): boolean {
        return this._subscribers.length > 0;
    }
}

const _channels = new Map<ChannelName, Channel>();

export function channel(name: ChannelName): Channel {
    assertChannelName(name);
    let ch = _channels.get(name);
    if (!ch) {
        ch = new Channel(name);
        _channels.set(name, ch);
    }
    return ch;
}

export function hasSubscribers(name: ChannelName): boolean {
    if (!isChannelName(name)) return false;
    const ch = _channels.get(name);
    return ch ? ch.hasSubscribers : false;
}

export function subscribe(
    name: ChannelName,
    onMessage: MessageHandler
): void {
    channel(name).subscribe(onMessage);
}

export function unsubscribe(name: ChannelName, onMessage: MessageHandler): boolean {
    assertChannelName(name);
    return _channels.get(name)?.unsubscribe(onMessage) ?? false;
}

type TracingChannel = {
    hasSubscribers: boolean;
    start: Channel;
    end: Channel;
    asyncStart: Channel;
    asyncEnd: Channel;
    error: Channel;
    subscribe(handlers: TraceHandlers): void;
    unsubscribe(handlers: TraceHandlers): boolean;
    traceSync<T>(fn: (...args: unknown[]) => T, context?: Record<string, unknown>, thisArg?: unknown, ...args: unknown[]): T;
    tracePromise<T>(fn: (...args: unknown[]) => T | PromiseLike<T>, context?: Record<string, unknown>, thisArg?: unknown, ...args: unknown[]): Promise<T>;
    traceCallback<T>(fn: (...args: unknown[]) => T, position?: number, context?: Record<string, unknown>, thisArg?: unknown, ...args: unknown[]): T;
};

type TracingChannelSubscribers = Partial<Record<typeof traceEvents[number], Channel>>;

const traceEvents = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'] as const;

/** Node accepts either a name prefix or an object of ready-made channels. */
function resolveTraceChannels(nameOrChannels: string | TracingChannelSubscribers): Record<string, Channel> {
    if (typeof nameOrChannels === 'string') {
        const out: Record<string, Channel> = {};
        for (const event of traceEvents) out[event] = channel(`tracing:${nameOrChannels}:${event}`);
        return out;
    }
    if (!nameOrChannels || typeof nameOrChannels !== 'object') {
        throw invalidArgType('The "nameOrChannels" argument must be of type string or object');
    }
    const out: Record<string, Channel> = {};
    for (const event of traceEvents) {
        const provided = nameOrChannels[event];
        if (provided instanceof Channel) out[event] = provided;
        else if (provided === undefined) out[event] = channel(Symbol(`tracing:${event}`));
        else throw invalidArgType(`The "nameOrChannels.${event}" property must be an instance of Channel`);
    }
    return out;
}

export function tracingChannel(nameOrChannels: string | TracingChannelSubscribers): TracingChannel {
    const resolved = resolveTraceChannels(nameOrChannels);
    const traceHasSubscribers = (): boolean =>
        trace.start.hasSubscribers
        || trace.end.hasSubscribers
        || trace.asyncStart.hasSubscribers
        || trace.asyncEnd.hasSubscribers
        || trace.error.hasSubscribers;

    const trace = {
        start: resolved.start as Channel,
        end: resolved.end as Channel,
        asyncStart: resolved.asyncStart as Channel,
        asyncEnd: resolved.asyncEnd as Channel,
        error: resolved.error as Channel,
        subscribe(handlers: TraceHandlers): void {
            for (const event of traceEvents) {
                const handler = handlers[event];
                if (handler) trace[event].subscribe(handler);
            }
        },
        unsubscribe(handlers: TraceHandlers): boolean {
            let done = true;
            for (const event of traceEvents) {
                const handler = handlers[event];
                if (handler && !trace[event].unsubscribe(handler)) done = false;
            }
            return done;
        },
        traceSync<T>(fn: (...args: unknown[]) => T, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): T {
            if (!traceHasSubscribers()) return fn.apply(thisArg, args);
            trace.start.publish(context);
            try {
                const result = fn.apply(thisArg, args);
                context.result = result;
                return result;
            } catch (error) {
                context.error = error;
                trace.error.publish(context);
                throw error;
            } finally {
                trace.end.publish(context);
            }
        },
        tracePromise<T>(fn: (...args: unknown[]) => T | PromiseLike<T>, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): Promise<T> {
            // Node returns fn()'s own value untouched when nothing is subscribed.
            if (!traceHasSubscribers()) return fn.apply(thisArg, args) as Promise<T>;
            trace.start.publish(context);
            let promise: Promise<T>;
            try {
                promise = Promise.resolve(fn.apply(thisArg, args));
            } catch (error) {
                context.error = error;
                trace.error.publish(context);
                throw error;
            } finally {
                trace.end.publish(context);
            }
            return promise.then(
                (result) => {
                    context.result = result;
                    trace.asyncStart.publish(context);
                    trace.asyncEnd.publish(context);
                    return result;
                },
                (error) => {
                    context.error = error;
                    trace.error.publish(context);
                    trace.asyncStart.publish(context);
                    trace.asyncEnd.publish(context);
                    throw error;
                },
            );
        },
        traceCallback<T>(fn: (...args: unknown[]) => T, position = -1, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): T {
            if (!traceHasSubscribers()) return fn.apply(thisArg, args);
            const index = position < 0 ? args.length + position : position;
            const callback = args[index];
            if (typeof callback !== 'function') {
                throw invalidArgType('The "callback" argument must be of type function');
            }
            args.splice(index, 1, function(this: unknown, error: unknown, result: unknown, ...rest: unknown[]) {
                if (error) {
                    context.error = error;
                    trace.error.publish(context);
                } else {
                    context.result = result;
                }
                trace.asyncStart.publish(context);
                try {
                    return callback.call(this, error, result, ...rest);
                } finally {
                    trace.asyncEnd.publish(context);
                }
            });
            trace.start.publish(context);
            try {
                return fn.apply(thisArg, args);
            } catch (error) {
                context.error = error;
                trace.error.publish(context);
                throw error;
            } finally {
                trace.end.publish(context);
            }
        },
    };
    return Object.defineProperty(trace, 'hasSubscribers', {
        get: traceHasSubscribers,
        enumerable: true,
        configurable: true,
    }) as TracingChannel;
}
