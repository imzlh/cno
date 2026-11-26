import { Buffer } from 'node:buffer';
import { arrayBufferBackedBytes } from '../utils/bytes';

export type BunWebSocketData = string | BufferSource | Blob;
export type BunWebSocketBinaryType = 'nodebuffer' | 'arraybuffer' | 'uint8array' | 'blob';

export interface BunServerWebSocket<T = unknown> {
    data: T;
    binaryType: BunWebSocketBinaryType;
    readonly readyState: 1 | 3;
    readonly subscriptions: string[];
    send(data: BunWebSocketData, compress?: boolean): number;
    sendText(data: string, compress?: boolean): number;
    sendBinary(data: BufferSource | Blob, compress?: boolean): number;
    publish(topic: string, data: BunWebSocketData, compress?: boolean): number;
    publishText(topic: string, data: string, compress?: boolean): number;
    publishBinary(topic: string, data: BufferSource | Blob, compress?: boolean): number;
    subscribe(topic: string): boolean;
    unsubscribe(topic: string): boolean;
    isSubscribed(topic: string): boolean;
    cork<R>(callback: (socket: BunServerWebSocket<T>) => R): R;
    getBufferedAmount(): number;
    close(code?: number, reason?: string): void;
}

export interface BunWebSocketHandler<T = unknown> {
    data?: T;
    open?(socket: BunServerWebSocket<T>): void | Promise<void>;
    message?(socket: BunServerWebSocket<T>, message: string | Buffer | ArrayBuffer | Uint8Array | Blob): void | Promise<void>;
    close?(socket: BunServerWebSocket<T>, code: number, reason: string): void | Promise<void>;
    error?(error: Error, socket: BunServerWebSocket<T>): void | Promise<void>;
    publishToSelf?: boolean;
}

export interface BunWebSocketUpgradeOptions<T = unknown> {
    data?: T;
    headers?: HeadersInit;
}

export type HostWebSocketUpgrade = (
    request: Request,
    options?: { protocol?: string },
) => { response: Response; socket: WebSocket };

interface MessagePayload {
    value: BunWebSocketData;
    length: number;
}

const supportedHandlers = new Set(['data', 'open', 'message', 'close', 'error', 'publishToSelf']);
const binaryTypes = new Set<BunWebSocketBinaryType>(['nodebuffer', 'arraybuffer', 'uint8array', 'blob']);
const isView = ArrayBuffer.isView;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const blobLength = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;

export function parseWebSocketHandler<T>(value: unknown): BunWebSocketHandler<T> | undefined {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Bun.serve: websocket must be a handlers object.');
    }
    const handlers: BunWebSocketHandler<T> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !supportedHandlers.has(key)) {
            throw new TypeError(`Bun.serve: unsupported websocket option "${String(key)}".`);
        }
        const handler = Reflect.get(value, key);
        if (key === 'publishToSelf' && handler !== undefined && typeof handler !== 'boolean') {
            throw new TypeError('Bun.serve: websocket.publishToSelf must be a boolean.');
        }
        if (key !== 'data' && key !== 'publishToSelf' && handler !== undefined && typeof handler !== 'function') {
            throw new TypeError(`Bun.serve: websocket.${key} must be a function.`);
        }
        Reflect.set(handlers, key, handler);
    }
    if (handlers.open === undefined && handlers.message === undefined) {
        throw new TypeError('Bun.serve: websocket requires an open or message handler.');
    }
    return handlers;
}

function messagePayload(data: BunWebSocketData): MessagePayload {
    if (typeof data === 'string') return { value: data, length: Buffer.byteLength(data) };
    if (isView(data)) {
        let bytes: Uint8Array;
        try {
            bytes = new Uint8Array(Reflect.apply(typedArrayBuffer, data, []),
                Reflect.apply(typedArrayOffset, data, []), Reflect.apply(typedArrayLength, data, []));
        } catch {
            bytes = new Uint8Array(Reflect.apply(dataViewBuffer, data, []),
                Reflect.apply(dataViewOffset, data, []), Reflect.apply(dataViewLength, data, []));
        }
        return { value: arrayBufferBackedBytes(bytes), length: bytes.byteLength };
    }
    try {
        return { value: data, length: Reflect.apply(arrayBufferLength, data, []) as number };
    } catch {
        try {
            return { value: data, length: Reflect.apply(blobLength, data, []) as number };
        } catch {
            throw new TypeError('WebSocket data must be a string, ArrayBuffer, ArrayBufferView or Blob.');
        }
    }
}

function validateTopic(topic: string): void {
    if (typeof topic !== 'string' || topic.length === 0) {
        throw new TypeError('WebSocket topic must be a non-empty string.');
    }
}

class WebSocketConnection<T> implements BunServerWebSocket<T> {
    readonly topics = new Set<string>();
    #binaryType: BunWebSocketBinaryType = 'nodebuffer';
    #closing = false;

    constructor(
        private readonly owner: BunWebSocketServer<T>,
        private readonly socket: WebSocket,
        public data: T,
        signal: AbortSignal,
    ) {
        const abort = () => this.close();
        const removeAbort = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => {
            removeAbort();
            owner.dispatch('open', this);
        };
        socket.onmessage = event => {
            const input = event.data as string | ArrayBuffer;
            let message: string | Buffer | ArrayBuffer | Uint8Array | Blob = input;
            if (typeof input !== 'string') {
                if (this.#binaryType === 'nodebuffer') message = Buffer.from(input);
                else if (this.#binaryType === 'uint8array') message = new Uint8Array(input);
                else if (this.#binaryType === 'blob') message = new Blob([input]);
            }
            owner.dispatch('message', this, message);
        };
        socket.onclose = event => {
            removeAbort();
            this.#closing = true;
            owner.detach(this);
            owner.dispatch('close', this, event.code, event.reason);
        };
    }

    get binaryType(): BunWebSocketBinaryType {
        return this.#binaryType;
    }

    set binaryType(value: BunWebSocketBinaryType) {
        if (!binaryTypes.has(value)) throw new TypeError('Invalid WebSocket binaryType.');
        this.#binaryType = value;
    }

    get readyState(): 1 | 3 {
        return !this.#closing && this.socket.readyState === WebSocket.OPEN ? 1 : 3;
    }

    get subscriptions(): string[] {
        return Array.from(this.topics);
    }

    send(data: BunWebSocketData, _compress?: boolean): number {
        if (this.readyState !== 1) return 0;
        return this.sendPayload(messagePayload(data));
    }

    sendPayload(payload: MessagePayload): number {
        if (this.readyState !== 1) return 0;
        this.socket.send(payload.value);
        return payload.length;
    }

    sendText(data: string, compress?: boolean): number {
        if (typeof data !== 'string') throw new TypeError('WebSocket.sendText requires a string.');
        return this.send(data, compress);
    }

    sendBinary(data: BufferSource | Blob, compress?: boolean): number {
        if (typeof data === 'string') throw new TypeError('WebSocket.sendBinary requires binary data.');
        return this.send(data, compress);
    }

    publish(topic: string, data: BunWebSocketData, _compress?: boolean): number {
        if (this.readyState !== 1) return 0;
        return this.owner.publish(topic, data, this);
    }

    publishText(topic: string, data: string, compress?: boolean): number {
        if (typeof data !== 'string') throw new TypeError('WebSocket.publishText requires a string.');
        return this.publish(topic, data, compress);
    }

    publishBinary(topic: string, data: BufferSource | Blob, compress?: boolean): number {
        if (typeof data === 'string') throw new TypeError('WebSocket.publishBinary requires binary data.');
        return this.publish(topic, data, compress);
    }

    subscribe(topic: string): boolean {
        validateTopic(topic);
        return this.readyState === 1 && this.owner.subscribe(this, topic);
    }

    unsubscribe(topic: string): boolean {
        validateTopic(topic);
        return this.readyState === 1 && this.owner.unsubscribe(this, topic);
    }

    isSubscribed(topic: string): boolean {
        validateTopic(topic);
        return this.readyState === 1 && this.topics.has(topic);
    }

    cork<R>(callback: (socket: BunServerWebSocket<T>) => R): R {
        return callback(this);
    }

    getBufferedAmount(): number {
        return this.socket.bufferedAmount;
    }

    close(code?: number, reason?: string): void {
        this.socket.close(code, reason);
        this.#closing = true;
        this.owner.unsubscribeAll(this);
    }
}

export class BunWebSocketServer<T = unknown> {
    readonly #requests = new WeakMap<Request, { response?: Response }>();
    readonly #sockets = new Set<WebSocketConnection<T>>();
    readonly #topics = new Map<string, Set<WebSocketConnection<T>>>();
    #stopped = false;
    #stopPromise: Promise<void> | undefined;
    #resolveStop: (() => void) | undefined;

    constructor(private handlers: BunWebSocketHandler<T>, private readonly upgradeRequest: HostWebSocketUpgrade) {}

    get pendingWebSockets(): number {
        return this.#sockets.size;
    }

    async handleRequest(
        request: Request,
        dispatch: () => Response | void | Promise<Response | void>,
        reportError: (error: unknown) => unknown,
    ): Promise<Response> {
        const state: { response?: Response } = {};
        this.#requests.set(request, state);
        try {
            const result = await dispatch();
            if (state.response) return state.response;
            if (!(result instanceof Response)) throw new TypeError('Bun.serve: handler must return a Response or upgrade the request.');
            return result;
        } catch (error) {
            if (!state.response) throw error;
            try {
                const reported = reportError(error);
                if (reported && typeof (reported as PromiseLike<unknown>).then === 'function') {
                    void Promise.resolve(reported).catch(failure => {
                        queueMicrotask(() => { throw failure; });
                    });
                }
            } catch (failure) {
                queueMicrotask(() => { throw failure; });
            }
            return state.response;
        } finally {
            this.#requests.delete(request);
        }
    }

    upgrade(request: Request, options?: BunWebSocketUpgradeOptions<T>): boolean {
        const state = this.#requests.get(request);
        if (!state || state.response || this.#stopped || request.signal.aborted) return false;
        if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
            || !request.headers.get('connection')?.toLowerCase().split(',').some(value => value.trim() === 'upgrade')
            || !request.headers.get('sec-websocket-key')) return false;
        if (options !== undefined && (options === null || typeof options !== 'object')) {
            throw new TypeError('Bun.serve: upgrade options must be an object.');
        }
        const data = options?.data as T;
        const headers = new Headers(options?.headers);
        const protocol = headers.get('sec-websocket-protocol') ?? undefined;
        if (state.response || this.#stopped || request.signal.aborted) return false;
        const upgraded = this.upgradeRequest(request, { protocol });
        for (const [name, value] of headers) {
            if (name !== 'upgrade' && name !== 'connection' && name !== 'sec-websocket-accept' && name !== 'sec-websocket-protocol') {
                upgraded.response.headers.set(name, value);
            }
        }
        const connection = new WebSocketConnection(this, upgraded.socket, data, request.signal);
        this.#sockets.add(connection);
        state.response = upgraded.response;
        return true;
    }

    publish(topic: string, data: BunWebSocketData, source?: WebSocketConnection<T>): number {
        validateTopic(topic);
        const payload = messagePayload(data);
        const subscribers = this.#topics.get(topic);
        if (!subscribers) return 0;
        let sent = false;
        for (const socket of subscribers) {
            if (socket !== source || this.handlers.publishToSelf) {
                if (socket.sendPayload(payload) > 0) sent = true;
            }
        }
        return sent ? payload.length : 0;
    }

    subscriberCount(topic: string): number {
        if (typeof topic !== 'string') throw new TypeError('Bun.serve: subscriberCount requires a topic string.');
        return this.#topics.get(topic)?.size ?? 0;
    }

    subscribe(socket: WebSocketConnection<T>, topic: string): boolean {
        let subscribers = this.#topics.get(topic);
        if (!subscribers) this.#topics.set(topic, subscribers = new Set());
        subscribers.add(socket);
        socket.topics.add(topic);
        return true;
    }

    unsubscribe(socket: WebSocketConnection<T>, topic: string): boolean {
        const subscribers = this.#topics.get(topic);
        if (!subscribers?.delete(socket)) return false;
        if (subscribers.size === 0) this.#topics.delete(topic);
        socket.topics.delete(topic);
        return true;
    }

    unsubscribeAll(socket: WebSocketConnection<T>): void {
        for (const topic of socket.topics) this.unsubscribe(socket, topic);
    }

    dispatch(event: 'open' | 'message' | 'close', socket: WebSocketConnection<T>, ...args: unknown[]): void {
        const handler = this.handlers[event];
        if (!handler) return;
        try {
            const result = Reflect.apply(handler, this.handlers, [socket, ...args]);
            if (result && typeof (result as PromiseLike<void>).then === 'function') {
                void Promise.resolve(result).catch(error => this.report(error, socket));
            }
        } catch (error) {
            this.report(error, socket);
        }
    }

    report(value: unknown, socket: WebSocketConnection<T>): void {
        const error = value instanceof Error ? value : new Error(String(value), { cause: value });
        const handler = this.handlers.error;
        if (handler) {
            try {
                const result = handler(error, socket);
                if (result && typeof (result as PromiseLike<void>).then === 'function') {
                    void Promise.resolve(result).catch(failure => {
                        queueMicrotask(() => { throw failure; });
                    });
                }
            } catch (failure) {
                queueMicrotask(() => { throw failure; });
            }
        } else {
            queueMicrotask(() => { throw error; });
        }
    }

    detach(socket: WebSocketConnection<T>): void {
        this.unsubscribeAll(socket);
        this.#sockets.delete(socket);
        if (this.#sockets.size === 0) {
            this.#resolveStop?.();
            this.#resolveStop = undefined;
        }
    }

    reload(handlers: BunWebSocketHandler<T>): void {
        this.handlers = handlers;
    }

    stop(): Promise<void> {
        this.#stopped = true;
        for (const socket of this.#sockets) socket.close();
        if (!this.#stopPromise) {
            this.#stopPromise = this.#sockets.size === 0 ? Promise.resolve() : new Promise(resolve => {
                this.#resolveStop = resolve;
            });
        }
        return this.#stopPromise;
    }
}
