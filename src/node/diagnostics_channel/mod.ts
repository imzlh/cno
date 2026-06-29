type MessageHandler = (message: unknown, channelName: string) => void;

export class Channel {
    readonly name: string;
    private _subscribers: MessageHandler[];

    constructor(name: string) {
        this.name = name;
        this._subscribers = [];
    }

    subscribe(onMessage: MessageHandler): { unsubscribe: () => void } {
        this._subscribers.push(onMessage);
        return {
            unsubscribe: () => this._unsubscribe(onMessage),
        };
    }

    unsubscribe(onMessage: MessageHandler): void {
        this._unsubscribe(onMessage);
    }

    private _unsubscribe(onMessage: MessageHandler): void {
        this._subscribers = this._subscribers.filter(fn => fn !== onMessage);
    }

    publish(message: unknown): void {
        for (const fn of this._subscribers) {
            try {
                fn(message, this.name);
            } catch {
                /* swallow errors to prevent one subscriber from breaking others */
            }
        }
    }

    hasSubscribers(): boolean {
        return this._subscribers.length > 0;
    }
}

const _channels = new Map<string, Channel>();

export function channel(name: string): Channel {
    let ch = _channels.get(name);
    if (!ch) {
        ch = new Channel(name);
        _channels.set(name, ch);
    }
    return ch;
}

export function hasSubscribers(name: string): boolean {
    const ch = _channels.get(name);
    return ch ? ch.hasSubscribers() : false;
}

export function subscribe(
    name: string,
    onMessage: MessageHandler
): { unsubscribe: () => void } {
    return channel(name).subscribe(onMessage);
}

export function unsubscribe(name: string, onMessage: MessageHandler): void {
    _channels.get(name)?.unsubscribe(onMessage);
}

export function tracingChannel(name: string): {
    start: Channel;
    end: Channel;
    asyncStart: Channel;
    asyncEnd: Channel;
    error: Channel;
} {
    return {
        start: channel(`tracing:${name}:start`),
        end: channel(`tracing:${name}:end`),
        asyncStart: channel(`tracing:${name}:asyncStart`),
        asyncEnd: channel(`tracing:${name}:asyncEnd`),
        error: channel(`tracing:${name}:error`),
    };
}