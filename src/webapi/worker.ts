import { EventTarget, MessageEvent, ErrorEvent, DOMException } from "./events";
import { MessagePort, closedSymbol } from "./messaging";

const worker = import.meta.use('worker');

const transferredPorts = new WeakMap<MessagePort, string>();
const portRegistry = new Map<string, MessagePort>();

function generateId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function serializeTransferables(transfer: Transferable[]): { ports: string[] } {
    const ports: string[] = [];

    for (const item of transfer) {
        if (item instanceof MessagePort) {
            const id = transferredPorts.get(item) ?? generateId();
            transferredPorts.set(item, id);
            portRegistry.set(id, item);
            (item as any)[closedSymbol] = true;
            ports.push(id);
        }
    }

    return { ports };
}

function deserializeTransferables(meta: { ports?: string[] }): MessagePort[] {
    const ports: MessagePort[] = [];

    if (meta.ports) {
        for (const id of meta.ports) {
            let port = portRegistry.get(id);
            if (!port) {
                port = new MessagePort();
                transferredPorts.set(port, id);
                portRegistry.set(id, port);
            }
            (port as any)[closedSymbol] = false;
            ports.push(port);
        }
    }

    return ports;
}

class Worker extends EventTarget implements globalThis.Worker {
    #worker: CModuleWorker.Worker;
    #terminated = false;
    #onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;
    #onmessageerror: ((this: Worker, ev: MessageEvent) => any) | null = null;
    #onerror: ((this: Worker, ev: ErrorEvent) => any) | null = null;

    constructor(specifier: string | URL, options?: WorkerOptions) {
        super();
        this.#worker = new worker.Worker({
            '__cts_entry': specifier.toString(),
            ...options
        });
        this.#setupMessagePipe();
    }

    #setupMessagePipe(): void {
        const p = this.#worker.messagePipe;
        
        p.onmessage = (rawData: any) => {
            if (this.#terminated) return;

            let data = rawData;
            let ports: MessagePort[] = [];

            if (typeof rawData === 'object' && rawData !== null) {
                if (rawData.__cno_role === 'error') {
                    const error = rawData.error ?? new Error(rawData.message ?? 'Unknown error');
                    const event = new ErrorEvent('error', {
                        message: error.message,
                        error,
                        filename: rawData.filename ?? '',
                        lineno: rawData.lineno ?? 0,
                        colno: rawData.colno ?? 0
                    }, true);
                    this.#onerror?.(event);
                    this.dispatchEvent(event);
                    return;
                }

                if (rawData.__cno_transfer) {
                    ports = deserializeTransferables(rawData.__cno_transfer);
                    data = rawData.__cno_data;
                }
            }

            const event = new MessageEvent('message', { data, ports: ports as any }, true);
            this.#onmessage?.(event);
            this.dispatchEvent(event);
        };

        p.onmessageerror = (e: any) => {
            if (this.#terminated) return;
            const event = new MessageEvent('messageerror', { data: e }, true);
            this.#onmessageerror?.(event);
            this.dispatchEvent(event);
        };
    }

    get onmessage() { return this.#onmessage!; }
    set onmessage(value: any) {
        this.#onmessage = value;
    }

    get onmessageerror() { return this.#onmessageerror; }
    set onmessageerror(value: any) {
        this.#onmessageerror = value;
    }

    get onerror() { return this.#onerror; }
    set onerror(value: any) {
        this.#onerror = value;
    }

    postMessage(message: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
        if (this.#terminated) {
            throw new DOMException('Worker is terminated', 'InvalidStateError');
        }

        let transfer: Transferable[] = [];
        if (Array.isArray(transferOrOptions)) {
            transfer = transferOrOptions;
        } else if (transferOrOptions?.transfer) {
            transfer = transferOrOptions.transfer;
        }

        const transferMeta = serializeTransferables(transfer);
        const ports = transferMeta.ports;

        if (ports.length > 0) {
            this.#worker.messagePipe.postMessage({
                __cno_data: message,
                __cno_transfer: { ports }
            });
        } else {
            this.#worker.messagePipe.postMessage(message);
        }
    }

    terminate(): void {
        if (this.#terminated) return;
        this.#terminated = true;
        return this.#worker.terminate();
    }

    addEventListener(type: string, listener: any, options?: boolean | AddEventListenerOptions): void {
        super.addEventListener(type, listener, options);
    }

    removeEventListener(type: string, listener: any, options?: boolean | EventListenerOptions): void {
        super.removeEventListener(type, listener, options);
    }
    
    get [Symbol.toStringTag]() {
        return 'Worker';
    }
}

if (worker.isWorker) {
    const pipe = worker.pipe!;

    Reflect.set(self, 'postMessage', (message: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
        let transfer: Transferable[] = [];
        if (Array.isArray(transferOrOptions)) {
            transfer = transferOrOptions;
        } else if (transferOrOptions?.transfer) {
            transfer = transferOrOptions.transfer;
        }

        const transferMeta = serializeTransferables(transfer);
        const ports = transferMeta.ports;

        if (ports.length > 0) {
            pipe.postMessage({
                __cno_data: message,
                __cno_transfer: { ports }
            });
        } else {
            pipe.postMessage(message);
        }
    });

    // Reflect.set(self, 'close', () => {
    //     pipe.close?.();
    // });

    const events = {
        onmessage: null as ((ev: MessageEvent) => any) | null,
        onmessageerror: null as ((ev: MessageEvent) => any) | null,
        onerror: null as ((ev: ErrorEvent) => any) | null
    };

    Object.defineProperty(self, 'onmessage', {
        get() { return events.onmessage; },
        set(value: ((ev: MessageEvent) => any) | null) { events.onmessage = value; }
    });

    Object.defineProperty(self, 'onmessageerror', {
        get() { return events.onmessageerror; },
        set(value: ((ev: MessageEvent) => any) | null) { events.onmessageerror = value; }
    });

    Object.defineProperty(self, 'onerror', {
        get() { return events.onerror; },
        set(value: ((ev: ErrorEvent) => any) | null) { events.onerror = value; }
    });

    pipe.onmessage = (rawData: any) => {
        let data = rawData;
        let ports: MessagePort[] = [];

        if (typeof rawData === 'object' && rawData !== null) {
            if (rawData.__cno_transfer) {
                ports = deserializeTransferables(rawData.__cno_transfer);
                data = rawData.__cno_data;
            }
        }

        const event = new MessageEvent('message', { data, ports: ports as any }, true);
        events.onmessage?.(event);
        self.dispatchEvent(event);
    };

    pipe.onmessageerror = (e: any) => {
        const event = new MessageEvent('messageerror', { data: e }, true);
        events.onmessageerror?.(event);
        self.dispatchEvent(event);
    };
}

Reflect.set(globalThis, 'Worker', Worker);
