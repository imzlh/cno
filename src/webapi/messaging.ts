import { DOMException, EventTarget, MessageEvent } from './events';
import { getTransferList, structuredCloneWithTransfer } from '../node/_internal/structured-clone';

const otherPortSymbol = Symbol('otherPort');
const startedSymbol = Symbol('started');
export const closedSymbol = Symbol('closed');
const messageQueueSymbol = Symbol('messageQueue');
const dispatchQueuedSymbol = Symbol('dispatchQueued');
const onMessageSymbol = Symbol('onmessage');
const onMessageErrorSymbol = Symbol('onmessageerror');

type QueuedMessage = { data: unknown; ports: MessagePort[] };
type PortMessageHandler = (this: globalThis.MessagePort, ev: globalThis.MessageEvent) => unknown;

export function isMessagePort(value: unknown): value is MessagePort {
    return value instanceof MessagePort;
}

function createTransferredPort(port: MessagePort): MessagePort {
    const clone = new MessagePort();
    clone[otherPortSymbol] = port[otherPortSymbol];
    clone[startedSymbol] = port[startedSymbol];
    clone[messageQueueSymbol] = port[messageQueueSymbol];
    return clone;
}

function commitTransferredPort(port: MessagePort, clone: MessagePort): void {
    const otherPort = port[otherPortSymbol];
    clone[otherPortSymbol] = otherPort;
    if (otherPort?.[otherPortSymbol] === port) {
        otherPort[otherPortSymbol] = clone;
    }
    port[otherPortSymbol] = null;
    port[closedSymbol] = true;
    port[messageQueueSymbol] = [];
}

export const messagePortTransferHooks = {
    isPort: isMessagePort,
    createPortClone: createTransferredPort,
    commitPortTransfer: commitTransferredPort,
    isUntransferable: (item: object) => isMessagePort(item) && item[closedSymbol],
};

function cloneForMessage(
    message: unknown,
    transferOrOptions?: Transferable[] | StructuredSerializeOptions,
): QueuedMessage {
    const portClones = new Map<MessagePort, MessagePort>();
    const data = structuredCloneWithTransfer(message, transferOrOptions, {
        ...messagePortTransferHooks,
        createPortClone(port) {
            const clone = createTransferredPort(port);
            portClones.set(port, clone);
            return clone;
        },
    });
    const ports = getTransferList(transferOrOptions)
        .filter(isMessagePort)
        .map((port) => portClones.get(port) ?? port);
    return { data, ports };
}

function dispatchMessage(port: MessagePort, message: QueuedMessage): void {
    if (port[closedSymbol]) return;
    const event = new MessageEvent('message', {
        data: message.data,
        ports: message.ports,
    }, true);
    port.dispatchEvent(event);
    if (port.onmessage) Reflect.apply(port.onmessage, port, [event]);
}

function schedulePortDispatch(port: MessagePort): void {
    if (!port[startedSymbol] || port[dispatchQueuedSymbol]) return;
    port[dispatchQueuedSymbol] = true;
    queueMicrotask(() => {
        port[dispatchQueuedSymbol] = false;
        if (!port[startedSymbol] || port[closedSymbol]) return;
        while (port[messageQueueSymbol].length > 0 && !port[closedSymbol]) {
            const message = port[messageQueueSymbol].shift();
            if (!message) break;
            dispatchMessage(port, message);
        }
    });
}

function enqueuePortMessage(port: MessagePort, message: QueuedMessage): void {
    if (port[closedSymbol]) return;
    port[messageQueueSymbol].push(message);
    schedulePortDispatch(port);
}

export function moveMessagePort(port: MessagePort): MessagePort {
    const clone = createTransferredPort(port);
    commitTransferredPort(port, clone);
    return clone;
}

export function enqueueMessagePortMessage(port: MessagePort, data: unknown, ports: MessagePort[] = []): void {
    enqueuePortMessage(port, { data, ports });
}

export class MessagePort extends EventTarget implements globalThis.MessagePort {
    [onMessageSymbol]: PortMessageHandler | null = null;
    [onMessageErrorSymbol]: PortMessageHandler | null = null;

    [otherPortSymbol]: MessagePort | null = null;
    [startedSymbol] = false;
    [closedSymbol] = false;
    [messageQueueSymbol]: QueuedMessage[] = [];
    [dispatchQueuedSymbol] = false;

    constructor() {
        super();
    }

    get onmessage(): PortMessageHandler | null {
        return this[onMessageSymbol];
    }

    set onmessage(handler: PortMessageHandler | null) {
        this[onMessageSymbol] = typeof handler === 'function' ? handler : null;
        if (this[onMessageSymbol] && !this[startedSymbol]) this.start();
    }

    get onmessageerror(): PortMessageHandler | null {
        return this[onMessageErrorSymbol];
    }

    set onmessageerror(handler: PortMessageHandler | null) {
        this[onMessageErrorSymbol] = typeof handler === 'function' ? handler : null;
    }

    postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
        if (this[closedSymbol]) {
            throw new DOMException('MessagePort is closed', 'InvalidStateError');
        }

        if (!this[otherPortSymbol]) {
            return;
        }

        const otherPort = this[otherPortSymbol];
        enqueuePortMessage(otherPort, cloneForMessage(message, transferOrOptions));
    }

    start(): void {
        if (this[startedSymbol]) return;
        this[startedSymbol] = true;
        schedulePortDispatch(this);
    }

    close(): void {
        this[closedSymbol] = true;
        this[otherPortSymbol] = null;
        this[messageQueueSymbol] = [];
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
        super.addEventListener(type, listener, options);
        if (type === 'message' && !this[startedSymbol]) {
            this.start();
        }
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
        super.removeEventListener(type, listener, options);
    }

    get [Symbol.toStringTag](): string {
        return 'MessagePort';
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
