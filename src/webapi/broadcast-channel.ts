import { DOMException, EventTarget, MessageEvent } from './events';

class BroadcastChannelImpl extends EventTarget implements BroadcastChannel {
    readonly name: string;
    #closed = false;

    constructor(name: string) {
        super();
        this.name = String(name);
    }

    get closed(): boolean {
        return this.#closed;
    }

    postMessage(data: any): void {
        if (this.#closed) {
            throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
        }

        const event = new MessageEvent('message', {
            data: structuredClone(data),
            bubbles: false,
            cancelable: false
        }, true);

        this.dispatchEvent(event);
    }

    close(): void {
        if (!this.#closed) {
            this.#closed = true;
            this.dispatchEvent(new Event('close', { bubbles: false, cancelable: false }));
        }
    }

    addEventListener(type: string, handler: any, options?: AddEventListenerOptions): void {
        super.addEventListener(type, handler, options);
    }

    removeEventListener(type: string, handler: any, options?: EventListenerOptions): void {
        super.removeEventListener(type, handler, options);
    }

    #onmessage: any;
    get onmessage(): any {
        return this.#onmessage;
    }
    set onmessage(handler: any) {
        if (this.#onmessage) {
            this.removeEventListener('message', this.#onmessage);
        }
        if (handler) {
            this.addEventListener('message', handler);
        } else {
            this.removeEventListener('message', handler);
        }
        this.#onmessage = handler;
    }

    #onmessageerror: any;
    get onmessageerror(): any {
        return this.#onmessageerror;
    }
    set onmessageerror(handler: any) {
        if (this.#onmessageerror) {
            this.removeEventListener('messageerror', this.#onmessageerror);
        }
        if (handler) {
            this.addEventListener('messageerror', handler);
        } else {
            this.addEventListener('messageerror', handler);
        }
        this.#onmessageerror = handler;
    }

    ref(): this {
        return this;
    }

    unref(): this {
        this.close();
        return this;
    }
}

globalThis.BroadcastChannel = BroadcastChannelImpl;
