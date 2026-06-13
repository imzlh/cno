import { DOMException, EventTarget, MessageEvent } from './events';

const engine = import.meta.use('engine');

const otherPortSymbol = Symbol('otherPort');
const startedSymbol = Symbol('started');
export const closedSymbol = Symbol('closed');
const messageQueueSymbol = Symbol('messageQueue');

export class MessagePort extends EventTarget {
    onmessage: ((this: MessagePort, ev: MessageEvent) => any) | null = null;
    onmessageerror: ((this: MessagePort, ev: MessageEvent) => any) | null = null;

    [otherPortSymbol]: MessagePort | null = null;
    [startedSymbol] = false;
    [closedSymbol] = false;
    [messageQueueSymbol]: any[] = [];

    constructor() {
        super();
    }

    postMessage(message: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
        if (this[closedSymbol]) {
            throw new DOMException('MessagePort is closed', 'InvalidStateError');
        }

        if (!this[otherPortSymbol]) {
            return;
        }

        let transferred: Transferable[] = [];
        if (Array.isArray(transferOrOptions)) {
            transferred = transferOrOptions;
        } else if (transferOrOptions?.transfer) {
            transferred = transferOrOptions.transfer;
        }

        for (const item of transferred) {
            if (item instanceof MessagePort) {
                (item as any)[closedSymbol] = true;
            }
        }

        const cloned = engine.deserialize(engine.serialize(message));
        const otherPort = this[otherPortSymbol];

        if (otherPort[startedSymbol]) {
            queueMicrotask(() => {
                if (otherPort && !otherPort[closedSymbol]) {
                    const event = new MessageEvent('message', { 
                        data: cloned, 
                        ports: transferred.filter(p => p instanceof MessagePort) as any
                    }, true);
                    otherPort.dispatchEvent(event);
                    otherPort.onmessage?.call(otherPort, event);
                }
            });
        } else {
            otherPort[messageQueueSymbol].push(cloned);
        }
    }

    start(): void {
        if (this[startedSymbol]) return;
        this[startedSymbol] = true;

        for (const message of this[messageQueueSymbol]) {
            const event = new MessageEvent('message', { data: message }, true);
            this.dispatchEvent(event);
            this.onmessage?.call(this, event);
        }
        this[messageQueueSymbol] = [];
    }

    close(): void {
        this[closedSymbol] = true;
        this[otherPortSymbol] = null;
        this[messageQueueSymbol] = [];
    }

    addEventListener(type: string, listener: any, options?: boolean | AddEventListenerOptions): void {
        super.addEventListener(type, listener, options);
        if (type === 'message' && !this[startedSymbol]) {
            this.start();
        }
    }

    removeEventListener(type: string, listener: any, options?: boolean | EventListenerOptions): void {
        super.removeEventListener(type, listener, options);
    }
}

export class MessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;

    constructor() {
        this.port1 = new MessagePort();
        this.port2 = new MessagePort();
        this.port1[otherPortSymbol] = this.port2;
        this.port2[otherPortSymbol] = this.port1;
    }
}

Reflect.set(globalThis, 'MessageChannel', MessageChannel);
Reflect.set(globalThis, 'MessagePort', MessagePort);
