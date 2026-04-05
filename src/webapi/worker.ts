import { EventTarget, MessageEvent } from "./events";

const worker = import.meta.use('worker');
const engine = import.meta.use('engine');

class Worker extends EventTarget implements globalThis.Worker {
    #worker: CModuleWorker.Worker;
    
    constructor(specifier: string | URL, options?: WorkerOptions) {
        super();
        this.#worker = new worker.Worker({
            '__cts_entry': specifier.toString(),
            ...options
        });
        const p = this.#worker.messagePipe;
        p.onmessage = d => {
            if (typeof d == 'object' && d.__cno_role == 'error') {
                this.#onerror?.(d);
                this.dispatchEvent(new MessageEvent('error', { data: d }));
                return;
            }
            this.#onmessage?.(d);
            this.dispatchEvent(new MessageEvent('message', { data: d }));
        }
        p.onmessageerror = e => {
            this.#onmessageerror?.(e);
            this.dispatchEvent(new MessageEvent('messageerror', { data: e }));
        }
    }

    #onmessage: any;
    set onmessage(value: any) {
        this.#onmessage = value;
    }
    get onmessage() {
        return this.#onmessage;
    }

    #onmessageerror: any;
    set onmessageerror(value: any) {
        this.#onmessageerror = value;
    }
    get onmessageerror() {
        return this.#onmessageerror;
    }

    #onerror: any;
    set onerror(value: any) {
        this.#onerror = value;
    }
    get onerror() {
        return this.#onerror;
    }

    private _transfer(obj: any) {
        throw new Error('Transferable is not implemented');
    }

    postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        let transfer: Transferable[] = [];
        transfer = Array.isArray(options) ? options : options?.transfer ?? [];
        transfer.forEach(e => this._transfer(e));
        this.#worker.messagePipe.postMessage(message);
    }

    terminate(): Promise<void> {
        return this.#worker.terminate();
    }

    addEventListener(type: string, listener: any, _options?: AddEventListenerOptions | boolean): void {
        this.addEventListener(type, listener);
    }

    removeEventListener(type: string, listener: any, _options?: AddEventListenerOptions | boolean): void {
        this.removeEventListener(type, listener);
    }
}

// bind worker events in Worker
if (worker.isWorker) {
    Reflect.set(self, 'postMessage', (msg: any) => worker.pipe?.postMessage(msg))
    const events = {
        onmessage: undefined as any,
        onmessageerror: undefined as any
    }
    Object.defineProperty(self, 'onmessage', {
        get() {
            return events.onmessage;
        },
        set(value: any) {
            events.onmessage = value;
        }
    })
    Object.defineProperty(self, 'onmessageerror', {
        get() {
            return events.onmessageerror;
        },
        set(value: any) {
            events.onmessageerror = value;
        }
    })
    worker.pipe!.onmessage = d => {
        events.onmessage?.(d);
        self.dispatchEvent(new MessageEvent('message', { data: d }));
    };
    worker.pipe!.onmessageerror = e => {
        events.onmessageerror?.(e);
        self.dispatchEvent(new MessageEvent('messageerror', { data: e }));
    };
}

Reflect.set(globalThis, 'Worker', Worker);