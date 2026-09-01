import { EventEmitter } from '../events';
import { PassThrough } from '../stream';
import {
    dataCloneError,
    decodeStructuredCloneFromPipe,
    encodeStructuredCloneForPipe,
    errorConstructorByName,
    getTransferList,
    structuredCloneWithTransfer,
} from '../_internal/structured-clone';

const wk = import.meta.use('worker');
const osmod = import.meta.use('os');
const error = import.meta.use('error');

const INTERNAL_KEYS = new Set([
    '__cts_entry',
    '__cts_role',
    '__cts_runtime_config',
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
const pipeRefedSymbol = Symbol('pipeRefed');
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

// Native teardown synchronously joins every worker. Do not wait at exit for a
// stopped or unref'd worker until pipe EOF proves it can be reaped.
const abandonedWorkers = new Set<Worker>();
let exitHookInstalled = false;
let forcingExit = false;

// Bypass native teardown when it would block on an abandoned worker.
function installExitHook(): void {
    if (exitHookInstalled) return;
    const host = processExitHost();
    if (!host) return;
    exitHookInstalled = true;
    host.on('exit', (code?: unknown) => {
        if (forcingExit) return;
        if (abandonedWorkers.size === 0) return;
        forcingExit = true;
        // Preserve the code the runtime already decided on; this must not
        // change the observable status, only skip a join that cannot return.
        osmod.exit(typeof code === 'number' ? code : 0);
    });
}

function markAbandoned(worker: Worker): void {
    abandonedWorkers.add(worker);
    installExitHook();
}

let nextThreadId = 1;

function createReadyToken(threadId: number): string {
    return `${threadId}:${Date.now()}:${Math.random()}`;
}

// Worker os.args omits the parent's CLI flags, so forward the resolved config.
function currentRuntimeConfig(): unknown {
    try {
        return Reflect.get(globalThis, '__cno_worker_runtime_config');
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return value !== null && typeof value === 'object';
}

/** A byte cap of 0 means "unlimited" in cts (TIER_MEM_LIMIT.high), so compare as +Infinity. */
function capAsComparable(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return Infinity;
    return value === 0 ? Infinity : value;
}

/** Node's resourceLimits are MEGABYTES; cts config caps are BYTES. */
function mbToBytes(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.floor(value) * 1024 * 1024;
}

// Apply per-worker MB limits as byte caps without widening the parent config.
function runtimeConfigWithResourceLimits(config: unknown, limits: Record<string, number>): unknown {
    const memBytes = mbToBytes(limits.maxOldGenerationSizeMb);
    const stackBytes = mbToBytes(limits.stackSizeMb);
    if (memBytes === undefined && stackBytes === undefined) return config;
    const base: Record<PropertyKey, unknown> = isRecord(config) ? { ...config } : {};
    if (memBytes !== undefined) {
        base.memoryLimit = Math.min(capAsComparable(base.memoryLimit), memBytes);
    }
    if (stackBytes !== undefined) {
        base.maxStackSize = Math.min(capAsComparable(base.maxStackSize), stackBytes);
    }
    return base;
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
    // Rebuild with the concrete constructor so `instanceof TypeError` etc. still
    // holds after the error crossed the thread boundary as a plain JSON payload.
    const name = typeof payload.name === 'string' ? payload.name : '';
    const error = new (errorConstructorByName(name))(message);
    if (name) error.name = name;
    if (typeof payload.stack === 'string') error.stack = payload.stack;
    return error;
}

function isPipeEof(err: unknown): boolean {
    return err instanceof Error && Reflect.get(err, 'code') === error.errno.EOF;
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

// Native thread pipes cannot serialize MessagePort; reject before cloning detaches transfers.
function assertNoPortsAcrossThreads(value: unknown, transferList?: readonly unknown[]): void {
    for (const item of getTransferList(transferList)) {
        if (isMessagePort(item)) {
            throw dataCloneError('MessagePort cannot be transferred to another thread in this runtime');
        }
    }

    const seen = new Set<object>();
    const stack: unknown[] = [value];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') continue;
        if (seen.has(current)) continue;
        seen.add(current);
        if (isMessagePort(current)) {
            throw dataCloneError('MessagePort cannot be transferred to another thread in this runtime');
        }
        if (current instanceof Map) {
            for (const [key, item] of current) {
                stack.push(key);
                stack.push(item);
            }
            continue;
        }
        if (current instanceof Set) {
            for (const item of current) stack.push(item);
            continue;
        }
        if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) continue;
        for (const key of Object.keys(current)) stack.push(Reflect.get(current, key));
    }
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

        // Preserve messages already captured by a drain when its handler closes the port.
        const queue = port[messageQueueSymbol];
        while (queue.length > 0) {
            const item = queue.shift();
            if (item !== undefined) emitMessage(port, item);
        }
    });
}

function updatePipeRef(port: MessagePort): void {
    const pipe = port.__pipe as MessagePipeWithRef | undefined;
    if (!pipe) return;
    const hasMessageConsumer = port.listenerCount('message') > 0 || port[onMessageSymbol] !== null;
    if (hasMessageConsumer && !port[pipeRefedSymbol]) {
        port[pipeRefedSymbol] = true;
        pipe.ref?.();
    } else if (!hasMessageConsumer && port[pipeRefedSymbol]) {
        port[pipeRefedSymbol] = false;
        pipe.unref?.();
    }
}

function enqueuePortMessage(port: MessagePort, item: QueuedMessage): void {
    if (port[closedSymbol]) return;
    port[messageQueueSymbol].push(item);
    schedulePortDispatch(port);
}

/** Defer 'close' to the check phase, with a microtask fallback. */
function deferPortClose(port: MessagePort): void {
    const emitClose = () => port.emit('close', { type: 'close' });
    const immediate: unknown = Reflect.get(globalThis, 'setImmediate');
    if (typeof immediate === 'function') immediate(emitClose);
    else queueMicrotask(emitClose);
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
    // A port holds the loop only after start().
    [refedSymbol] = false;
    [pipeRefedSymbol] = true;
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
            assertNoPortsAcrossThreads(value, transferList);
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
        const otherPort = this[otherPortSymbol];
        this[otherPortSymbol] = null;
        this.unref();
        // Keep messages already being drained ahead of the deferred close event.
        deferPortClose(this);
        // Closing one end closes the entangled end too.
        if (otherPort && !otherPort[closedSymbol]) {
            if (otherPort[otherPortSymbol] === this) otherPort[otherPortSymbol] = null;
            otherPort.close();
        }
    }

    hasRef(): boolean {
        return this[refedSymbol];
    }

    ref(): void {
        this[refedSymbol] = true;
        this[pipeRefedSymbol] = true;
        (this.__pipe as MessagePipeWithRef | undefined)?.ref?.();
    }

    unref(): void {
        this[refedSymbol] = false;
        this[pipeRefedSymbol] = false;
        (this.__pipe as MessagePipeWithRef | undefined)?.unref?.();
    }

    start(): void {
        if (this[startedSymbol]) return;
        this[startedSymbol] = true;
        this[refedSymbol] = true;
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
    private _exitCode = 0;
    private _refed = true;
    private _ready = false;
    private _readyToken: string;
    private _outgoingQueue: unknown[] = [];
    private _stdout: PassThrough | null = null;
    private _stderr: PassThrough | null = null;
    // Wait for pipe EOF before synchronously joining the native worker.
    private _joinPending = false;

    constructor(filename: string | URL, options?: WorkerOptions) {
        super();

        this.threadId = nextThreadId++;
        this.threadName = options?.name ?? null;
        this.resourceLimits = { ...(options?.resourceLimits ?? {}) };
        this._readyToken = createReadyToken(this.threadId);

        const entry = options?.eval
            ? `eval:${filename.toString()}`
            : filename.toString();
        assertNoPortsAcrossThreads(options?.workerData, options?.transferList);
        const workerData = encodeStructuredCloneForPipe(cloneForTransfer(options?.workerData, options?.transferList));

        this._native = new wk.Worker({
            __cts_entry: entry,
            __cts_runtime_config: runtimeConfigWithResourceLimits(currentRuntimeConfig(), this.resourceLimits),
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
        this._native.messagePipe.onclose = () => {
            this._joinPending = true;
            this._reap();
            if (!this._exited) this._finish(undefined, 0);
        };
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
                this._joinPending = true;
                this._finish(undefined, typeof code === 'number' ? code : 0);
                return;
            }
            if (!this._exited) this.emit('message', data);
        });
        this._port.on('messageerror', (err: unknown) => {
            if (isPipeEof(err)) {
                this._joinPending = true;
                this._reap();
                if (!this._exited) this._finish(undefined, 1);
                return;
            }
            if (this._exited) return;
            this.emit('messageerror', err);
        });

        workerRegistry.set(this.threadId, this);
        queueMicrotask(() => {
            if (!this._exited) this.emit('online');
        });
    }

    postMessage(value: unknown, transferList?: unknown[]): void {
        if (this._exited) return;
        assertNoPortsAcrossThreads(value, transferList);
        this._outgoingQueue.push(encodeStructuredCloneForPipe(cloneForTransfer(value, transferList)));
        this._flushOutgoingQueue();
    }

    private _flushOutgoingQueue(): void {
        if (!this._ready || this._exited) return;
        while (this._outgoingQueue.length > 0 && !this._exited) {
            this._native.messagePipe.postMessage(this._outgoingQueue.shift());
        }
    }

    private _reap(): void {
        if (!this._joinPending) return;
        this._joinPending = false;
        this._native.terminate();
        abandonedWorkers.delete(this);
        this._native.messagePipe.onmessage = undefined;
        this._native.messagePipe.onmessageerror = undefined;
        this._native.messagePipe.onclose = undefined;
        this._port.close();
    }

    private _finish(error: WorkerErrorPayload | undefined, code: number): void {
        if (this._exited) return;
        this._exited = true;
        this._exitCode = code;
        workerRegistry.delete(this.threadId);
        this._outgoingQueue = [];
        if (this._joinPending) {
            // EOF drives the pending native join without keeping the loop alive.
            this._port.unref();
        } else {
            this._port.close();
        }
        this._closeStdio();
        if (error) this.emit('error', errorFromWorkerPayload(error));
        this.emit('exit', code);
    }

    private _closeStdio(): void {
        this._stdout?.end();
        this._stderr?.end();
    }

    postMessageToThread(targetThreadId: number, value: unknown, transferList?: unknown[], timeout?: number): Promise<void> {
        return postMessageToThread(targetThreadId, value, transferList, timeout);
    }

    terminate(): Promise<number> {
        // Node reports a terminated worker with exit code 1.
        if (this._exited) return Promise.resolve(this._exitCode);
        this._exited = true;
        this._exitCode = 1;
        workerRegistry.delete(this.threadId);
        this._outgoingQueue = [];

        // Native terminate() joins synchronously; request a stop and join after
        // EOF so an unresponsive worker cannot block the parent event loop.
        this._joinPending = true;
        this._native.stop();
        markAbandoned(this);
        // EOF can still drive _reap() without keeping the process open.
        this._port.unref();
        this._closeStdio();
        // Let immediately attached listeners observe 'exit'.
        return new Promise((resolve) => {
            queueMicrotask(() => {
                this.emit('exit', 1);
                resolve(1);
            });
        });
    }

    ref(): void {
        this._refed = true;
        this._port.ref();
        if (!this._joinPending) abandonedWorkers.delete(this);
    }

    unref(): void {
        this._refed = false;
        this._port.unref();
        // Native teardown would otherwise join an unref'd worker after the loop drains.
        if (!this._exited) markAbandoned(this);
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

type ProcessExitHost = { on(event: string, listener: (code?: unknown) => void): unknown };

function processExitHost(): ProcessExitHost | null {
    const candidate: unknown = Reflect.get(globalThis, 'process');
    if (!candidate || typeof candidate !== 'object') return null;
    const on: unknown = Reflect.get(candidate, 'on');
    if (typeof on !== 'function') return null;
    return candidate as ProcessExitHost;
}

function createParentPort(): MessagePort | null {
    if (!wk.isWorker || !wk.pipe) return null;
    const pipe = wk.pipe;
    const port = wrapMessagePipe(pipe);
    port.unref();
    const readyToken = rawWorkerRecord.__node_readyToken;
    if (typeof readyToken === 'string') {
        pipe.postMessage({ [NODE_WORKER_READY]: readyToken });
    }
    // Native pipe EOF carries no exit status. process/mod.ts installs the same
    // reporter for workers that do not import this module.
    const host = processExitHost();
    if (host) {
        host.on('exit', (code?: unknown) => {
            try {
                pipe.postMessage({ [NODE_WORKER_EXIT]: { code: typeof code === 'number' ? code : 0 } });
            } catch {
                // EOF is the fallback when the pipe is already closed.
            }
        });
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
