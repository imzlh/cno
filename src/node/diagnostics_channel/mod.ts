type MessageHandler = (message: unknown, channelName: ChannelName) => void;
type TraceHandlers = Partial<Record<'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error', MessageHandler>>;
type ChannelName = string | symbol;

function isChannelName(name: unknown): name is ChannelName {
    return typeof name === 'string' || typeof name === 'symbol';
}

function assertChannelName(name: unknown): asserts name is ChannelName {
    if (!isChannelName(name)) {
        throw new TypeError('The "channel" argument must be one of type string or symbol');
    }
}

function assertMessageHandler(onMessage: unknown): asserts onMessage is MessageHandler {
    if (typeof onMessage !== 'function') {
        throw new TypeError('The "subscription" argument must be of type function');
    }
}

export class Channel {
    readonly name: ChannelName;
    private _subscribers: MessageHandler[];

    constructor(name: ChannelName) {
        this.name = name;
        this._subscribers = [];
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

const traceEvents = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'] as const;

export function tracingChannel(name: string): TracingChannel {
    if (typeof name !== 'string') {
        throw new TypeError('The "nameOrChannels" argument must be of type string');
    }
    const trace = {
        start: channel(`tracing:${name}:start`),
        end: channel(`tracing:${name}:end`),
        asyncStart: channel(`tracing:${name}:asyncStart`),
        asyncEnd: channel(`tracing:${name}:asyncEnd`),
        error: channel(`tracing:${name}:error`),
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
            if (!trace.hasSubscribers) return fn.apply(thisArg, args);
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
            if (!trace.hasSubscribers) return Promise.resolve(fn.apply(thisArg, args));
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
            if (!trace.hasSubscribers) return fn.apply(thisArg, args);
            const index = position < 0 ? args.length + position : position;
            const callback = args[index];
            if (typeof callback !== 'function') {
                throw new TypeError('The "callback" argument must be of type function');
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
        get() {
            return trace.start.hasSubscribers
                || trace.end.hasSubscribers
                || trace.asyncStart.hasSubscribers
                || trace.asyncEnd.hasSubscribers
                || trace.error.hasSubscribers;
        },
        enumerable: true,
        configurable: true,
    }) as TracingChannel;
}
