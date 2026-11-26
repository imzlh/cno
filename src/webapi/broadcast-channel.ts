import { DOMException, Event, EventTarget, MessageEvent } from './events';
import {
    createBroadcastChannelBridge,
    detachWorkerBroadcastPipe,
    handleBroadcastDelivery,
    handleWorkerBroadcastControl,
    type BroadcastChannelBridge,
} from '../utils/worker-broadcast-channel';

export { detachWorkerBroadcastPipe, handleBroadcastDelivery, handleWorkerBroadcastControl };

type BroadcastChannelHandler = (this: BroadcastChannel, ev: globalThis.MessageEvent<unknown>) => unknown;

export class BroadcastChannelImpl extends EventTarget implements BroadcastChannel {
    readonly name: string;
    readonly id: string;
    #closed = false;
    #bridge: BroadcastChannelBridge;

    constructor(name: string) {
        super();
        this.name = String(name);
        this.#bridge = createBroadcastChannelBridge(
            this.name,
            data => this.dispatchBroadcastMessage(data),
            () => this.closeFromBridge(),
        );
        this.id = this.#bridge.id;
    }

    get closed(): boolean {
        return this.#closed;
    }

    postMessage(data: unknown): void {
        if (this.#closed) throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
        this.#bridge.post(structuredClone(data));
    }

    close(): void {
        this.#bridge.close();
    }

    private closeFromBridge(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.dispatchEvent(new Event('close', { bubbles: false, cancelable: false }));
    }

    dispatchBroadcastMessage(data: unknown): void {
        queueMicrotask(() => {
            if (this.#closed) return;
            this.dispatchEvent(new MessageEvent('message', {
                data,
                bubbles: false,
                cancelable: false,
            }, true));
        });
    }

    addEventListener(type: string, handler: EventListener | EventListenerObject | null, options?: AddEventListenerOptions): void {
        super.addEventListener(type, handler, options);
    }

    removeEventListener(type: string, handler: EventListener | EventListenerObject | null, options?: EventListenerOptions): void {
        super.removeEventListener(type, handler, options);
    }

    #onmessage: BroadcastChannelHandler | null = null;
    #onmessageListener: EventListener | null = null;
    get onmessage(): BroadcastChannelHandler | null {
        return this.#onmessage;
    }
    set onmessage(handler: BroadcastChannelHandler | null) {
        if (this.#onmessageListener) {
            this.removeEventListener('message', this.#onmessageListener);
            this.#onmessageListener = null;
        }
        this.#onmessage = typeof handler === 'function' ? handler : null;
        if (this.#onmessage) {
            this.#onmessageListener = event => {
                if (event instanceof MessageEvent) this.#onmessage?.call(this, event);
            };
            this.addEventListener('message', this.#onmessageListener);
        }
    }

    #onmessageerror: BroadcastChannelHandler | null = null;
    #onmessageerrorListener: EventListener | null = null;
    get onmessageerror(): BroadcastChannelHandler | null {
        return this.#onmessageerror;
    }
    set onmessageerror(handler: BroadcastChannelHandler | null) {
        if (this.#onmessageerrorListener) {
            this.removeEventListener('messageerror', this.#onmessageerrorListener);
            this.#onmessageerrorListener = null;
        }
        this.#onmessageerror = typeof handler === 'function' ? handler : null;
        if (this.#onmessageerror) {
            this.#onmessageerrorListener = event => {
                if (event instanceof MessageEvent) this.#onmessageerror?.call(this, event);
            };
            this.addEventListener('messageerror', this.#onmessageerrorListener);
        }
    }

    ref(): this {
        this.#bridge.ref();
        return this;
    }

    unref(): this {
        this.#bridge.unref();
        return this;
    }
}

globalThis.BroadcastChannel = BroadcastChannelImpl;
