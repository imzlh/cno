/**
 * Node.js worker_threads module
 * Based on CModuleWorker implementation
 */

import { EventEmitter } from '../events';

const wk = import.meta.use('worker');
const engine = import.meta.use('engine');

const INTERNAL_KEYS = new Set([
    '__cts_entry',
    '__cts_role',
    '__node_workerData',
    '__node_threadId',
    '__node_threadName',
    '__node_envData',
    '__node_resourceLimits',
    'name',
]);
const otherPortSymbol = Symbol('otherPort');
const startedSymbol = Symbol('started');
const closedSymbol = Symbol('closed');
const messageQueueSymbol = Symbol('messageQueue');
const dispatchQueuedSymbol = Symbol('dispatchQueued');
const refedSymbol = Symbol('refed');
const onMessageSymbol = Symbol('onmessage');
const onMessageErrorSymbol = Symbol('onmessageerror');

type QueuedMessage = { data: any; ports: MessagePort[] };

const untransferableObjects = new WeakSet<object>();
const uncloneableObjects = new WeakSet<object>();
const workerRegistry = new Map<number, Worker>();

let nextThreadId = 1;

function cloneMessage<T>(value: T): T {
    return engine.deserialize(engine.serialize(value));
}

function toDataCloneError(message: string): Error {
    return new globalThis.DOMException(message, 'DataCloneError');
}

function validateCloneable(value: any): void {
    if (!value || typeof value !== 'object') return;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    if (uncloneableObjects.has(value)) {
        throw toDataCloneError('Object cannot be cloned');
    }
}

function validateTransferList(transferList?: readonly any[]): void {
    for (const item of transferList ?? []) {
        if (item && typeof item === 'object' && untransferableObjects.has(item)) {
            throw toDataCloneError('Object cannot be transferred');
        }
    }
}

function createPortEvent(type: string, data: any, ports?: MessagePort[]): { type: string; data: any; ports?: MessagePort[] } {
    const event: Record<string, any> = {};
    Object.defineProperties(event, {
        type: { value: type, enumerable: false, configurable: true, writable: true },
        data: { value: data, enumerable: false, configurable: true, writable: true },
        ports: { value: ports, enumerable: false, configurable: true, writable: true },
    });
    return event as { type: string; data: any; ports?: MessagePort[] };
}

function emitMessage(port: MessagePort, item: QueuedMessage): void {
    if ((port as any)[closedSymbol]) return;
    const event = createPortEvent('message', item.data, item.ports);
    port.emit('message', item.data);
    port.onmessage?.call(port, event);
}

function schedulePortDispatch(port: MessagePort): void {
    if (!(port as any)[startedSymbol] || (port as any)[dispatchQueuedSymbol]) return;
    (port as any)[dispatchQueuedSymbol] = true;
    queueMicrotask(() => {
        (port as any)[dispatchQueuedSymbol] = false;
        if (!(port as any)[startedSymbol] || (port as any)[closedSymbol]) return;

        const queue = (port as any)[messageQueueSymbol] as QueuedMessage[];
        while (queue.length > 0 && !(port as any)[closedSymbol]) {
            emitMessage(port, queue.shift()!);
        }
    });
}

function enqueuePortMessage(port: MessagePort, item: QueuedMessage): void {
    if ((port as any)[closedSymbol]) return;
    ((port as any)[messageQueueSymbol] as QueuedMessage[]).push(item);
    schedulePortDispatch(port);
}

function wrapMessagePipe(pipe: CModuleWorker.MessagePipe): MessagePort {
    const port = new MessagePort();
    (port as any).__pipe = pipe;

    pipe.onmessage = (data: any) => {
        enqueuePortMessage(port, { data, ports: [] });
    };
    pipe.onmessageerror = (err: any) => {
        queueMicrotask(() => {
            if ((port as any)[closedSymbol]) return;
            const event = createPortEvent('messageerror', err);
            port.emit('messageerror', err);
            port.onmessageerror?.call(port, event as any);
        });
    };

    return port;
}

function normalizeWorkerData(value: any): any {
    if (value && typeof value === 'object' && '__node_workerData' in value) {
        return value.__node_workerData;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value).filter(([key]) => !INTERNAL_KEYS.has(key));
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }
    return value;
}

export class MessagePort extends EventEmitter {
    [onMessageSymbol]: ((this: MessagePort, ev: { type: string; data: any; ports?: MessagePort[] }) => any) | null = null;
    [onMessageErrorSymbol]: ((this: MessagePort, ev: { type: string; data: any }) => any) | null = null;
    [otherPortSymbol]: MessagePort | null = null;
    [startedSymbol] = false;
    [closedSymbol] = false;
    [messageQueueSymbol]: QueuedMessage[] = [];
    [dispatchQueuedSymbol] = false;
    [refedSymbol] = true;

    get onmessage(): ((this: MessagePort, ev: { type: string; data: any; ports?: MessagePort[] }) => any) | null {
        return this[onMessageSymbol];
    }

    set onmessage(handler: ((this: MessagePort, ev: { type: string; data: any; ports?: MessagePort[] }) => any) | null) {
        this[onMessageSymbol] = typeof handler === 'function' ? handler : null;
        if (this[onMessageSymbol] && !this[startedSymbol]) this.start();
    }

    get onmessageerror(): ((this: MessagePort, ev: { type: string; data: any }) => any) | null {
        return this[onMessageErrorSymbol];
    }

    set onmessageerror(handler: ((this: MessagePort, ev: { type: string; data: any }) => any) | null) {
        this[onMessageErrorSymbol] = typeof handler === 'function' ? handler : null;
    }

    postMessage(value: any, transferList?: any[]): void {
        validateCloneable(value);
        validateTransferList(transferList);

        const pipe = (this as any).__pipe as CModuleWorker.MessagePipe | undefined;
        if (pipe) {
            pipe.postMessage(value);
            return;
        }

        if (this[closedSymbol]) return;
        const otherPort = this[otherPortSymbol];
        if (!otherPort || otherPort[closedSymbol]) return;

        enqueuePortMessage(otherPort, {
            data: cloneMessage(value),
            ports: (transferList ?? []).filter((item): item is MessagePort => item instanceof MessagePort),
        });
    }

    close(): void {
        if (this[closedSymbol]) return;
        this[closedSymbol] = true;
        this[otherPortSymbol] = null;
        this[messageQueueSymbol] = [];
        this.emit('close', { type: 'close' });
    }

    hasRef(): boolean {
        return this[refedSymbol];
    }

    ref(): void {
        this[refedSymbol] = true;
        ((this as any).__pipe as any)?.ref?.();
    }

    unref(): void {
        this[refedSymbol] = false;
        ((this as any).__pipe as any)?.unref?.();
    }

    start(): void {
        if (this[startedSymbol]) return;
        this[startedSymbol] = true;
        schedulePortDispatch(this);
    }

    // @ts-expect-error - override narrows generic E to string
    on(event: string, listener: (...args: any[]) => void): this {
        super.on(event, listener as any);
        if (event === 'message' && !this[startedSymbol]) this.start();
        return this;
    }

    // @ts-expect-error - override narrows generic E to string
    once(event: string, listener: (...args: any[]) => void): this {
        super.once(event, listener as any);
        if (event === 'message' && !this[startedSymbol]) this.start();
        return this;
    }

    // @ts-expect-error - override narrows generic E to string
    off(event: string, listener: (...args: any[]) => void): this {
        super.off(event, listener as any);
        return this;
    }

    // @ts-expect-error - override narrows generic E to string
    emit(event: string, ...args: any[]): boolean {
        return super.emit(event, ...args);
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

type WorkerOptions = {
    eval?: boolean;
    workerData?: any;
    transferList?: any[];
    resourceLimits?: Record<string, number>;
    stdin?: boolean;
    stdout?: boolean;
    stderr?: boolean;
    name?: string;
};

export class Worker extends EventEmitter {
    readonly threadId: number;
    readonly threadName: string | null;
    readonly resourceLimits: Record<string, number>;
    private _native: CModuleWorker.Worker;
    private _port: MessagePort;
    private _exited = false;
    private _refed = true;

    constructor(filename: string | URL, options?: WorkerOptions) {
        super();

        this.threadId = nextThreadId++;
        this.threadName = options?.name ?? null;
        this.resourceLimits = { ...(options?.resourceLimits ?? {}) };

        const entry = options?.eval
            ? `eval:${filename.toString()}`
            : filename.toString();

        this._native = new wk.Worker({
            __cts_entry: entry,
            __node_workerData: options?.workerData,
            __node_threadId: this.threadId,
            __node_threadName: this.threadName,
            __node_resourceLimits: this.resourceLimits,
            __node_envData: Array.from(envDataMap.entries()),
        });
        this._port = wrapMessagePipe(this._native.messagePipe);
        this._port.on('message', (data: any) => this.emit('message', data));
        this._port.on('messageerror', (err: any) => this.emit('messageerror', err));

        workerRegistry.set(this.threadId, this);
        queueMicrotask(() => {
            if (!this._exited) this.emit('online');
        });
    }

    postMessage(value: any, transferList?: any[]): void {
        if (this._exited) return;
        validateCloneable(value);
        validateTransferList(transferList);
        this._native.messagePipe.postMessage(value);
    }

    postMessageToThread(targetThreadId: number, value: any, transferList?: any[], timeout?: number): Promise<void> {
        return postMessageToThread(targetThreadId, value, transferList, timeout);
    }

    terminate(): Promise<number> {
        if (this._exited) return Promise.resolve(0);
        this._exited = true;
        workerRegistry.delete(this.threadId);

        const result = this._native.terminate();
        return Promise.resolve(result as any).then(() => {
            this.emit('exit', 0);
            return 0;
        });
    }

    ref(): void {
        this._refed = true;
        this._port.ref();
    }

    unref(): void {
        this._refed = false;
        this._port.unref();
    }

    hasRef(): boolean {
        return this._refed;
    }

    get stdin(): NodeJS.ReadableStream | null { return null; }
    get stdout(): NodeJS.ReadableStream | null { return null; }
    get stderr(): NodeJS.ReadableStream | null { return null; }
    get performance(): { eventLoopUtilization(): { idle: number; active: number; utilization: number } } {
        return { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) };
    }
}

const rawWorkerData = wk.workerData;

export const isInternalThread = false;
export const isMainThread = !wk.isWorker;
export const parentPort: MessagePort | null = wk.isWorker && wk.pipe ? wrapMessagePipe(wk.pipe) : null;
export const threadId = Number((rawWorkerData as any)?.__node_threadId ?? 0);
export const threadName = (rawWorkerData as any)?.__node_threadName ?? null;
export const workerData: unknown = normalizeWorkerData(rawWorkerData);
export const resourceLimits = ((rawWorkerData as any)?.__node_resourceLimits ?? {}) as Record<string, number>;

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');
export const BroadcastChannel = globalThis.BroadcastChannel;
export const structuredClone = globalThis.structuredClone;

const envDataMap = new Map<any, any>(
    Array.isArray((rawWorkerData as any)?.__node_envData) ? (rawWorkerData as any).__node_envData : [],
);

export function moveMessagePortToContext(port: MessagePort, _context: any): MessagePort {
    port.start();
    return port;
}

export function receiveMessageOnPort(port: MessagePort): { message: any } | undefined {
    const item = (port as any)[messageQueueSymbol].shift() as QueuedMessage | undefined;
    return item ? { message: item.data } : undefined;
}

export function getEnvironmentData(key: any): any {
    return envDataMap.get(key);
}

export function setEnvironmentData(key: any, value?: any): void {
    if (value === undefined) envDataMap.delete(key);
    else envDataMap.set(key, value);
}

export function markAsUntransferable(object: object): void {
    if (object && typeof object === 'object') untransferableObjects.add(object);
}

export function markAsUncloneable(object: object): void {
    if (object && typeof object === 'object') uncloneableObjects.add(object);
}

export function isMarkedAsUntransferable(object: object): boolean {
    return !!object && typeof object === 'object' && untransferableObjects.has(object);
}

export function postMessageToThread(
    targetThreadId: number,
    value: any,
    transferListOrTimeout?: any[] | number,
    maybeTimeout?: number,
): Promise<void> {
    const transferList = Array.isArray(transferListOrTimeout) ? transferListOrTimeout : undefined;
    const timeout = Array.isArray(transferListOrTimeout) ? maybeTimeout : transferListOrTimeout;

    if (targetThreadId === threadId) {
        return Promise.reject(new Error('Cannot send a message to the current thread'));
    }

    validateCloneable(value);
    validateTransferList(transferList);

    if (timeout !== undefined && timeout < 0) {
        return Promise.reject(new RangeError('timeout must be >= 0'));
    }

    if (targetThreadId === 0 && parentPort) {
        parentPort.postMessage(value, transferList);
        return Promise.resolve();
    }

    const target = workerRegistry.get(targetThreadId);
    if (!target) {
        return Promise.reject(new Error(`Worker thread ${targetThreadId} is not running`));
    }

    target.postMessage(value, transferList);
    return Promise.resolve();
}
