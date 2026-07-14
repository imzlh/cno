/**
 * Node.js worker_threads module
 * Based on CModuleWorker implementation
 */

import { EventEmitter } from '../events';
import { PassThrough } from '../stream';
import {
    decodeStructuredCloneFromPipe,
    encodeStructuredCloneForPipe,
    getTransferList,
    structuredCloneWithTransfer,
} from '../_internal/structured-clone';

const wk = import.meta.use('worker');
const error = import.meta.use('error');

const INTERNAL_KEYS = new Set([
    '__cts_entry',
    '__cts_role',
    '__node_workerData',
    '__node_threadId',
    '__node_threadName',
    '__node_envData',
    '__node_resourceLimits',
    '__node_readyToken',
    'name',
]);
const NODE_WORKER_READY = '__cno_node_worker_ready__';
const NODE_WORKER_EXIT = '__cno_node_worker_exit__';
const NODE_WORKER_ERROR = '__cno_node_worker_error__';
const otherPortSymbol = Symbol('otherPort');
const startedSymbol = Symbol('started');
const closedSymbol = Symbol('closed');
const messageQueueSymbol = Symbol('messageQueue');
const dispatchQueuedSymbol = Symbol('dispatchQueued');
const refedSymbol = Symbol('refed');
const onMessageSymbol = Symbol('onmessage');
const onMessageErrorSymbol = Symbol('onmessageerror');

type QueuedMessage = { data: unknown; ports: MessagePort[] };
type MessagePortEvent = { type: string; data: unknown; ports?: MessagePort[] };
type MessagePortEventHandler = (this: MessagePort, ev: MessagePortEvent) => unknown;
type MessagePortErrorEvent = { type: string; data: unknown };
type MessagePortErrorHandler = (this: MessagePort, ev: MessagePortErrorEvent) => unknown;
type MessagePipeWithRef = CModuleWorker.MessagePipe & { ref?: () => void; unref?: () => void };
type RawWorkerData = {
    __node_workerData?: unknown;
    __node_threadId?: unknown;
    __node_threadName?: unknown;
    __node_envData?: unknown;
    __node_resourceLimits?: unknown;
    __node_readyToken?: unknown;
};
type EnvDataEntry = readonly [unknown, unknown];
type WorkerErrorPayload = { name?: unknown; message?: unknown; stack?: unknown };

const untransferableObjects = new WeakSet<object>();
const uncloneableObjects = new WeakSet<object>();
const workerRegistry = new Map<number, Worker>();

let nextThreadId = 1;

function createReadyToken(threadId: number): string {
    return `${threadId}:${Date.now()}:${Math.random()}`;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return value !== null && typeof value === 'object';
}

function isEnvDataEntry(value: unknown): value is EnvDataEntry {
    return Array.isArray(value) && value.length >= 2;
}

function isWorkerReadyMessage(value: unknown, readyToken: string): boolean {
    return !!value
        && typeof value === 'object'
        && Reflect.get(value, NODE_WORKER_READY) === readyToken;
}

function isWorkerExitMessage(value: unknown): value is Record<typeof NODE_WORKER_EXIT, { code?: unknown }> {
    return !!value
        && typeof value === 'object'
        && NODE_WORKER_EXIT in value;
}

function isWorkerErrorMessage(value: unknown): value is Record<typeof NODE_WORKER_ERROR, WorkerErrorPayload> {
    return !!value
        && typeof value === 'object'
        && NODE_WORKER_ERROR in value;
}

function errorFromWorkerPayload(payload: WorkerErrorPayload): Error {
    const message = typeof payload.message === 'string' ? payload.message : 'Worker error';
    const error = new Error(message);
    if (typeof payload.name === 'string') error.name = payload.name;
    if (typeof payload.stack === 'string') error.stack = payload.stack;
    return error;
}

function isPipeEof(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return Reflect.get(err, 'code') === error.errno.EOF;
}

function isMessagePort(value: unknown): value is MessagePort {
    return value instanceof MessagePort;
}

function createTransferredPort(port: MessagePort): MessagePort {
    const clone = new MessagePort();
    clone[otherPortSymbol] = port[otherPortSymbol];
    clone[startedSymbol] = port[startedSymbol];
    clone[messageQueueSymbol] = port[messageQueueSymbol];
    clone[refedSymbol] = port[refedSymbol];
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

function cloneForTransfer<T>(value: T, transferList?: readonly unknown[]): T {
    return structuredCloneWithTransfer(value, transferList, {
        isPort: isMessagePort,
        createPortClone: createTransferredPort,
        commitPortTransfer: commitTransferredPort,
        isUncloneable: (item) => uncloneableObjects.has(item),
        isUntransferable: (item) => untransferableObjects.has(item) || (isMessagePort(item) && item[closedSymbol]),
    });
}

function cloneForMessage<T>(value: T, transferList?: readonly unknown[]): QueuedMessage {
    const portClones = new Map<MessagePort, MessagePort>();
    const data = structuredCloneWithTransfer(value, transferList, {
        isPort: isMessagePort,
        createPortClone(port) {
            const clone = createTransferredPort(port);
            portClones.set(port, clone);
            return clone;
        },
        commitPortTransfer: commitTransferredPort,
        isUncloneable: (item) => uncloneableObjects.has(item),
        isUntransferable: (item) => untransferableObjects.has(item) || (isMessagePort(item) && item[closedSymbol]),
    });
    const ports = getTransferList(transferList)
        .filter(isMessagePort)
        .map((port) => portClones.get(port) ?? port);
    return { data, ports };
}

function createPortEvent(type: string, data: unknown, ports?: MessagePort[]): MessagePortEvent {
    const event: Record<string, unknown> = {};
    Object.defineProperties(event, {
        type: { value: type, enumerable: false, configurable: true, writable: true },
        data: { value: data, enumerable: false, configurable: true, writable: true },
        ports: { value: ports, enumerable: false, configurable: true, writable: true },
    });
    return event as MessagePortEvent;
}

function emitMessage(port: MessagePort, item: QueuedMessage): void {
    if (port[closedSymbol]) return;
    const event = createPortEvent('message', item.data, item.ports);
    port.emit('message', item.data);
    port.onmessage?.call(port, event);
}

function schedulePortDispatch(port: MessagePort): void {
    if (!port[startedSymbol] || port[dispatchQueuedSymbol]) return;
    port[dispatchQueuedSymbol] = true;
    queueMicrotask(() => {
        port[dispatchQueuedSymbol] = false;
        if (!port[startedSymbol] || port[closedSymbol]) return;

        const queue = port[messageQueueSymbol];
        while (queue.length > 0 && !port[closedSymbol]) {
            const item = queue.shift();
            if (item !== undefined) emitMessage(port, item);
        }
    });
}

function updatePipeRef(port: MessagePort): void {
    const pipe = port.__pipe as MessagePipeWithRef | undefined;
    if (!pipe) return;
    const hasMessageConsumer = port.listenerCount('message') > 0 || port[onMessageSymbol] !== null;
    if (hasMessageConsumer && !port[refedSymbol]) {
        port[refedSymbol] = true;
        pipe.ref?.();
    } else if (!hasMessageConsumer && port[refedSymbol]) {
        port[refedSymbol] = false;
        pipe.unref?.();
    }
}

function enqueuePortMessage(port: MessagePort, item: QueuedMessage): void {
    if (port[closedSymbol]) return;
    port[messageQueueSymbol].push(item);
    schedulePortDispatch(port);
}

function wrapMessagePipe(pipe: CModuleWorker.MessagePipe): MessagePort {
    const port = new MessagePort();
    port.__pipe = pipe;

    pipe.onmessage = (data: unknown) => {
        enqueuePortMessage(port, { data: decodeStructuredCloneFromPipe(data), ports: [] });
    };
    pipe.onmessageerror = (err: unknown) => {
        queueMicrotask(() => {
            if (port[closedSymbol]) return;
            const event = createPortEvent('messageerror', err);
            port.emit('messageerror', err);
            port.onmessageerror?.call(port, event);
        });
    };

    return port;
}

function normalizeWorkerData(value: unknown): unknown {
    if (value && typeof value === 'object' && '__node_workerData' in value) {
        return decodeStructuredCloneFromPipe(Reflect.get(value, '__node_workerData'));
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value).filter(([key]) => !INTERNAL_KEYS.has(key));
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }
    return value;
}

export class MessagePort extends EventEmitter {
    [onMessageSymbol]: MessagePortEventHandler | null = null;
    [onMessageErrorSymbol]: MessagePortErrorHandler | null = null;
    [otherPortSymbol]: MessagePort | null = null;
    [startedSymbol] = false;
    [closedSymbol] = false;
    [messageQueueSymbol]: QueuedMessage[] = [];
    [dispatchQueuedSymbol] = false;
    [refedSymbol] = true;
    __pipe?: CModuleWorker.MessagePipe;

    get onmessage(): MessagePortEventHandler | null {
        return this[onMessageSymbol];
    }

    set onmessage(handler: MessagePortEventHandler | null) {
        this[onMessageSymbol] = typeof handler === 'function' ? handler : null;
        if (this[onMessageSymbol] && !this[startedSymbol]) this.start();
        updatePipeRef(this);
    }

    get onmessageerror(): MessagePortErrorHandler | null {
        return this[onMessageErrorSymbol];
    }

    set onmessageerror(handler: MessagePortErrorHandler | null) {
        this[onMessageErrorSymbol] = typeof handler === 'function' ? handler : null;
    }

    postMessage(value: unknown, transferList?: unknown[]): boolean {
        const pipe = this.__pipe;
        if (pipe) {
            pipe.postMessage(encodeStructuredCloneForPipe(cloneForTransfer(value, transferList)));
            return true;
        }

        if (this[closedSymbol]) return true;
        const otherPort = this[otherPortSymbol];
        if (!otherPort || otherPort[closedSymbol]) return true;

        enqueuePortMessage(otherPort, cloneForMessage(value, transferList));
        return true;
    }

    close(): void {
        if (this[closedSymbol]) return;
        this[closedSymbol] = true;
        this[otherPortSymbol] = null;
        this[messageQueueSymbol] = [];
        this.unref();
        this.emit('close', { type: 'close' });
    }

    hasRef(): boolean {
        return this[refedSymbol];
    }

    ref(): void {
        this[refedSymbol] = true;
        (this.__pipe as MessagePipeWithRef | undefined)?.ref?.();
    }

    unref(): void {
        this[refedSymbol] = false;
        (this.__pipe as MessagePipeWithRef | undefined)?.unref?.();
    }

    start(): void {
        if (this[startedSymbol]) return;
        this[startedSymbol] = true;
        schedulePortDispatch(this);
    }

    on(event: string | symbol, listener: (...args: unknown[]) => void): this {
        super.on(event, listener);
        if (event === 'message' && !this[startedSymbol]) this.start();
        if (event === 'message') updatePipeRef(this);
        return this;
    }

    once(event: string | symbol, listener: (...args: unknown[]) => void): this {
        super.once(event, listener);
        if (event === 'message' && !this[startedSymbol]) this.start();
        if (event === 'message') updatePipeRef(this);
        return this;
    }

    off(event: string | symbol, listener: (...args: unknown[]) => void): this {
        super.off(event, listener);
        if (event === 'message') updatePipeRef(this);
        return this;
    }

    removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
        super.removeListener(event, listener);
        if (event === 'message') updatePipeRef(this);
        return this;
    }

    removeAllListeners(event?: string | symbol): this {
        super.removeAllListeners(event);
        if (event === undefined || event === 'message') updatePipeRef(this);
        return this;
    }

    emit(event: string | symbol, ...args: unknown[]): boolean {
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
    workerData?: unknown;
    transferList?: unknown[];
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
    private _ready = false;
    private _readyToken: string;
    private _outgoingQueue: unknown[] = [];
    private _stdout: PassThrough | null = null;
    private _stderr: PassThrough | null = null;

    constructor(filename: string | URL, options?: WorkerOptions) {
        super();

        this.threadId = nextThreadId++;
        this.threadName = options?.name ?? null;
        this.resourceLimits = { ...(options?.resourceLimits ?? {}) };
        this._readyToken = createReadyToken(this.threadId);

        const entry = options?.eval
            ? `eval:${filename.toString()}`
            : filename.toString();
        const workerData = encodeStructuredCloneForPipe(cloneForTransfer(options?.workerData, options?.transferList));

        this._native = new wk.Worker({
            __cts_entry: entry,
            __node_workerData: workerData,
            __node_threadId: this.threadId,
            __node_threadName: this.threadName,
            __node_resourceLimits: this.resourceLimits,
            __node_envData: Array.from(envDataMap.entries()),
            __node_readyToken: this._readyToken,
        });
        if (options?.stdout) this._stdout = new PassThrough();
        if (options?.stderr) this._stderr = new PassThrough();
        this._port = wrapMessagePipe(this._native.messagePipe);
        this._port.on('message', (data: unknown) => {
            if (isWorkerReadyMessage(data, this._readyToken)) {
                this._ready = true;
                this._flushOutgoingQueue();
                return;
            }
            if (isWorkerErrorMessage(data)) {
                this._finish(data[NODE_WORKER_ERROR], 1);
                return;
            }
            if (isWorkerExitMessage(data)) {
                const code = data[NODE_WORKER_EXIT]?.code;
                this._finish(undefined, typeof code === 'number' ? code : 0);
                return;
            }
            if (!this._exited) this.emit('message', data);
        });
        this._port.on('messageerror', (err: unknown) => {
            if (this._exited) return;
            if (isPipeEof(err)) {
                this._finish(undefined, 0);
                return;
            }
            this.emit('messageerror', err);
        });

        workerRegistry.set(this.threadId, this);
        queueMicrotask(() => {
            if (!this._exited) this.emit('online');
        });
    }

    postMessage(value: unknown, transferList?: unknown[]): void {
        if (this._exited) return;
        this._outgoingQueue.push(encodeStructuredCloneForPipe(cloneForTransfer(value, transferList)));
        this._flushOutgoingQueue();
    }

    private _flushOutgoingQueue(): void {
        if (!this._ready || this._exited) return;
        while (this._outgoingQueue.length > 0 && !this._exited) {
            this._native.messagePipe.postMessage(this._outgoingQueue.shift());
        }
    }

    private _finish(error: WorkerErrorPayload | undefined, code: number): void {
        if (this._exited) return;
        this._exited = true;
        workerRegistry.delete(this.threadId);
        this._outgoingQueue = [];
        this._port.close();
        if (error) this.emit('error', errorFromWorkerPayload(error));
        this.emit('exit', code);
    }

    postMessageToThread(targetThreadId: number, value: unknown, transferList?: unknown[], timeout?: number): Promise<void> {
        return postMessageToThread(targetThreadId, value, transferList, timeout);
    }

    terminate(): Promise<number> {
        if (this._exited) return Promise.resolve(0);
        this._exited = true;
        workerRegistry.delete(this.threadId);

        const result = this._native.terminate();
        return Promise.resolve(result).then(() => {
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
    get stdout(): NodeJS.ReadableStream | null { return this._stdout; }
    get stderr(): NodeJS.ReadableStream | null { return this._stderr; }
    get performance(): { eventLoopUtilization(): { idle: number; active: number; utilization: number } } {
        return { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) };
    }
}

const rawWorkerData: unknown = wk.workerData;
const rawWorkerRecord: RawWorkerData = isRecord(rawWorkerData) ? rawWorkerData : {};

function createParentPort(): MessagePort | null {
    if (!wk.isWorker || !wk.pipe) return null;
    const port = wrapMessagePipe(wk.pipe);
    port.unref();
    const readyToken = rawWorkerRecord.__node_readyToken;
    if (typeof readyToken === 'string') {
        wk.pipe.postMessage({ [NODE_WORKER_READY]: readyToken });
    }
    return port;
}

export const isInternalThread = false;
export const isMainThread = !wk.isWorker;
export const parentPort: MessagePort | null = createParentPort();
export const threadId = Number(rawWorkerRecord.__node_threadId ?? 0);
export const threadName = typeof rawWorkerRecord.__node_threadName === 'string' ? rawWorkerRecord.__node_threadName : null;
export const workerData: unknown = isMainThread ? null : normalizeWorkerData(rawWorkerData);
export const resourceLimits: Record<string, number> = {};
if (isRecord(rawWorkerRecord.__node_resourceLimits)) {
    for (const [key, value] of Object.entries(rawWorkerRecord.__node_resourceLimits)) {
        if (typeof value === 'number') resourceLimits[key] = value;
    }
}

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');
export const BroadcastChannel = globalThis.BroadcastChannel;
export const structuredClone = globalThis.structuredClone;

const envDataMap = new Map<unknown, unknown>(
    Array.isArray(rawWorkerRecord.__node_envData) ? rawWorkerRecord.__node_envData.filter(isEnvDataEntry) : [],
);

export function moveMessagePortToContext(port: MessagePort, _context: unknown): MessagePort {
    port.start();
    return port;
}

export function receiveMessageOnPort(port: MessagePort): { message: unknown } | undefined {
    const item = port[messageQueueSymbol].shift();
    return item ? { message: item.data } : undefined;
}

export function getEnvironmentData(key: unknown): unknown {
    return envDataMap.get(key);
}

export function setEnvironmentData(key: unknown, value?: unknown): void {
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
    value: unknown,
    transferListOrTimeout?: unknown[] | number,
    maybeTimeout?: number,
): Promise<void> {
    const transferList = Array.isArray(transferListOrTimeout) ? transferListOrTimeout : undefined;
    const timeout = Array.isArray(transferListOrTimeout) ? maybeTimeout : transferListOrTimeout;

    if (targetThreadId === threadId) {
        return Promise.reject(new Error('Cannot send a message to the current thread'));
    }

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
