// MessagePorts do not cross threads here: the native thread pipe carries only
// structured-clone bytes, so a port in workerData or in a transfer list is
// rejected with dataCloneError ("MessagePort cannot be transferred to another
// thread in this runtime"). Tools that hand a channel to a worker (esbuild's
// service channel, tinypool) fail on this; a fix has to travel a port handle
// beside the payload rather than inside it, and every consumer of the pipe has
// to learn the new envelope at once.
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
import {
    handleBroadcastDelivery,
    handleWorkerBroadcastControl,
    detachWorkerBroadcastPipe,
} from '../../utils/worker-broadcast-channel';
import { createPipeRefLease, type PipeRefLease } from '../../utils/worker-pipe-ref';

const wk = import.meta.use('worker');
const osmod = import.meta.use('os');
const error = import.meta.use('error');
const engine = import.meta.use('engine');
const timers = import.meta.use('timers');

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
const WORKER_JOIN_GRACE_MS = 250;
const otherPortSymbol = Symbol('otherPort');
const startedSymbol = Symbol('started');
const closedSymbol = Symbol('closed');
const messageQueueSymbol = Symbol('messageQueue');
const dispatchQueuedSymbol = Symbol('dispatchQueued');
const dispatchingSymbol = Symbol('dispatching');
const refedSymbol = Symbol('refed');
const pipeRefLeaseSymbol = Symbol('pipeRefLease');
const messagePipeRefLeaseSymbol = Symbol('messagePipeRefLease');
const onMessageSymbol = Symbol('onmessage');
const onMessageErrorSymbol = Symbol('onmessageerror');

type QueuedMessage = { data: unknown; ports: MessagePort[] };
type MessagePortEvent = { type: string; data: unknown; ports?: MessagePort[] };
type MessagePortEventHandler = (this: MessagePort, ev: MessagePortEvent) => unknown;
type MessagePortErrorEvent = { type: string; data: unknown };
type MessagePortErrorHandler = (this: MessagePort, ev: MessagePortErrorEvent) => unknown;
// Keep this local widening until older generated worker.d.ts files catch up
// with the native transfer-list overload.
type NativeMessagePipe = CModuleWorker.MessagePipe & {
    postMessage(data: unknown, transferList?: unknown[]): void;
};
type NativeWorkerConstructor = new (userData: unknown, transferList?: unknown[]) => CModuleWorker.Worker;
type WorkerStdio = PassThrough & NodeJS.ReadableStream;
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
    // Resolved config published by the CLI on its `cno.runtime` channel.
    return import.meta.use('evbus').get('cno.runtime', 'workerRuntimeConfig');
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return value !== null && typeof value === 'object';
}

function asWorkerStdio(stream: PassThrough): WorkerStdio {
    return stream as unknown as WorkerStdio;
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

// Native thread pipes own serialization and transfer commit. Keep the JS-side
// checks that are specific to this MessagePort implementation, but never clone
// or detach here: a native serialization failure must leave the transfer list
// untouched.
function assertNoPortsAcrossThreads(value: unknown, transferList?: readonly unknown[]): unknown[] {
    const transfers = Array.from(getTransferList(transferList));
    const transferSeen = new Set<object>();
    for (const item of transfers) {
        if (!item || typeof item !== 'object') {
            throw dataCloneError('Value not transferable');
        }
        if (engine.isProxy(item)) {
            throw dataCloneError('Proxy objects cannot be transferred');
        }
        if (transferSeen.has(item)) {
            throw dataCloneError('Transfer list contains duplicate object');
        }
        transferSeen.add(item);
        if (untransferableObjects.has(item)) {
            throw dataCloneError('Object cannot be transferred');
        }
        if (isMessagePort(item)) {
            throw dataCloneError('MessagePort cannot be transferred to another thread in this runtime');
        }
        if (!engine.isArrayBuffer(item)) {
            throw dataCloneError('Value not transferable');
        }
    }

    const seen = new Set<object>();
    const stack: unknown[] = [value];
    while (stack.length > 0) {
        const current = stack.pop();
        if (typeof current === 'function' || typeof current === 'symbol') {
            throw dataCloneError('Object cannot be cloned');
        }
        if (!current || typeof current !== 'object') continue;
        if (seen.has(current)) continue;
        if (engine.isProxy(current)) {
            throw dataCloneError('Proxy objects cannot be cloned');
        }
        seen.add(current);
        if (uncloneableObjects.has(current)) {
            throw dataCloneError('Object cannot be cloned');
        }
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
    return transfers;
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
        if (!port[startedSymbol]) return;

        port[dispatchingSymbol] = true;
        const queue = port[messageQueueSymbol];
        try {
            // Keep draining messages added reentrantly by a listener. close()
            // only discards a queue before this drain has started.
            while (queue.length > 0) {
                const item = queue.shift();
                if (item !== undefined) emitMessage(port, item);
            }
        } finally {
            port[dispatchingSymbol] = false;
            if (queue.length > 0) schedulePortDispatch(port);
        }
    });
}

function closePort(port: MessagePort, preserveQueuedMessages: boolean): void {
    if (port[closedSymbol]) return;
    port[closedSymbol] = true;
    const otherPort = port[otherPortSymbol];
    port[otherPortSymbol] = null;
    if (!preserveQueuedMessages && !port[dispatchingSymbol]) port[messageQueueSymbol].length = 0;
    const lease = port[pipeRefLeaseSymbol];
    const messageLease = port[messagePipeRefLeaseSymbol];
    try {
        port.unref();
    } finally {
        port[pipeRefLeaseSymbol] = undefined;
        port[messagePipeRefLeaseSymbol] = undefined;
        lease?.release();
        messageLease?.release();
    }
    deferPortClose(port);

    // A local channel loses both entangled endpoints when either side closes.
    // The EOF path has no entangled endpoint, so only that path can request
    // delivery of frames already decoded by the native pipe.
    if (otherPort && !otherPort[closedSymbol]) {
        if (otherPort[otherPortSymbol] === port) otherPort[otherPortSymbol] = null;
        closePort(otherPort, false);
    }
}

function closePortAfterEof(port: MessagePort): void {
    closePort(port, true);
}

function updatePipeRef(port: MessagePort): void {
    const lease = port[messagePipeRefLeaseSymbol];
    if (!lease) return;
    const hasMessageConsumer = port.listenerCount('message') > 0 || port[onMessageSymbol] !== null;
    if (hasMessageConsumer) lease.ref();
    else lease.unref();
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
    port[pipeRefLeaseSymbol] = createPipeRefLease(pipe);
    port[messagePipeRefLeaseSymbol] = createPipeRefLease(pipe, false);

    pipe.onmessage = (data: unknown) => {
        const decoded = decodeStructuredCloneFromPipe(data);
        if (handleBroadcastDelivery(decoded)) return;
        if (handleWorkerBroadcastControl(pipe, decoded)) return;
        enqueuePortMessage(port, { data: decoded, ports: [] });
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
    [dispatchingSymbol] = false;
    // A port holds the loop only after start().
    [refedSymbol] = false;
    [pipeRefLeaseSymbol]?: PipeRefLease;
    [messagePipeRefLeaseSymbol]?: PipeRefLease;
    __pipe?: NativeMessagePipe;

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
            const transfers = assertNoPortsAcrossThreads(value, transferList);
            if (this[closedSymbol]) {
                // No native write occurs after close, so perform the same
                // clone and transfer commit that the pipe would have done.
                structuredCloneWithTransfer(value, transfers);
                return true;
            }
            pipe.postMessage(encodeStructuredCloneForPipe(value), transfers);
            return true;
        }

        // Node still validates and performs transfers when a local port is
        // closed; only delivery is a no-op. Clone first so invalid payloads
        // throw and transfer-list entries are detached consistently.
        const message = cloneForMessage(value, transferList);
        if (this[closedSymbol]) return true;
        const otherPort = this[otherPortSymbol];
        if (!otherPort || otherPort[closedSymbol]) return true;

        enqueuePortMessage(otherPort, message);
        return true;
    }

    close(): void {
        closePort(this, false);
    }

    hasRef(): boolean {
        return this[refedSymbol];
    }

    ref(): void {
        this[refedSymbol] = true;
        this[pipeRefLeaseSymbol]?.ref();
    }

    unref(): void {
        this[refedSymbol] = false;
        this[pipeRefLeaseSymbol]?.unref();
        this[messagePipeRefLeaseSymbol]?.unref();
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
    private _refed = true;
    private _readyToken: string;
    private _stdout: WorkerStdio | null = null;
    private _stderr: WorkerStdio | null = null;
    // Wait for pipe EOF before synchronously joining the native worker.
    private _joinPending = false;
    private _joined = false;
    private _joinPromise: Promise<void> | null = null;
    private _resolveJoin: (() => void) | null = null;
    private _terminatePromise: Promise<number> | null = null;
    private _exitStatus: number | 'uncaughtException' | undefined;
    private _broadcastPipeDetached = false;

    private _detachBroadcastPipe(): void {
        if (this._broadcastPipeDetached) return;
        this._broadcastPipeDetached = true;
        try {
            detachWorkerBroadcastPipe(this._native.messagePipe);
        } catch {
            // BroadcastChannel close listeners must not prevent worker reaping.
        }
    }

    constructor(filename: string | URL, options?: WorkerOptions) {
        super();

        this.threadId = nextThreadId++;
        this.threadName = options?.name ?? null;
        this.resourceLimits = { ...(options?.resourceLimits ?? {}) };
        this._readyToken = createReadyToken(this.threadId);

        const entry = options?.eval
            ? `eval:${filename.toString()}`
            : filename.toString();
        const transfers = assertNoPortsAcrossThreads(options?.workerData, options?.transferList);
        const workerData = encodeStructuredCloneForPipe(options?.workerData);

        const NativeWorker = wk.Worker as NativeWorkerConstructor;
        this._native = new NativeWorker({
            __cts_entry: entry,
            __cts_runtime_config: runtimeConfigWithResourceLimits(currentRuntimeConfig(), this.resourceLimits),
            __node_workerData: workerData,
            __node_threadId: this.threadId,
            __node_threadName: this.threadName,
            __node_resourceLimits: this.resourceLimits,
            __node_envData: Array.from(envDataMap.entries()),
            __node_readyToken: this._readyToken,
        }, transfers);
        if (options?.stdout) this._stdout = asWorkerStdio(new PassThrough());
        if (options?.stderr) this._stderr = asWorkerStdio(new PassThrough());
        this._port = wrapMessagePipe(this._native.messagePipe);
        this._native.messagePipe.onclose = () => queueMicrotask(() => this._onPipeEof(0));
        this._port.on('message', (data: unknown) => {
            if (this._exited || this._exitStatus === 'uncaughtException') return;
            if (handleWorkerBroadcastControl(this._native.messagePipe, data)) return;
            if (isWorkerReadyMessage(data, this._readyToken)) {
                return;
            }
            if (isWorkerErrorMessage(data)) {
                this._exitStatus = 'uncaughtException';
                this._joinPending = true;
                this._native.stop();
                this.emit('error', errorFromWorkerPayload(data[NODE_WORKER_ERROR]));
                return;
            }
            if (isWorkerExitMessage(data)) {
                const code = data[NODE_WORKER_EXIT]?.code;
                this._joinPending = true;
                this._exitStatus = typeof code === 'number' ? code : 0;
                return;
            }
            this.emit('message', data);
        });
        this._port.on('messageerror', (err: unknown) => {
            if (isPipeEof(err)) {
                this._onPipeEof(1);
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
        const transfers = assertNoPortsAcrossThreads(value, transferList);
        // The native pipe exists from the constructor and buffers before the
        // worker installs its listener, so readiness must not gate user sends.
        (this._native.messagePipe as NativeMessagePipe)
            .postMessage(encodeStructuredCloneForPipe(value), transfers);
    }

    private _onPipeEof(defaultCode: number): void {
        if (this._joined) return;
        this._joinPending = false;
        this._detachBroadcastPipe();
        this._native.terminate();
        this._joined = true;
        abandonedWorkers.delete(this);
        this._native.messagePipe.onmessage = undefined;
        this._native.messagePipe.onmessageerror = undefined;
        this._native.messagePipe.onclose = undefined;
        closePortAfterEof(this._port);
        this._resolveJoin?.();
        this._resolveJoin = null;
        if (this._exited) return;
        this._exited = true;
        workerRegistry.delete(this.threadId);
        this._closeStdio();
        this.emit('exit', this._exitStatus === 'uncaughtException' ? 1 : this._exitStatus ?? defaultCode);
    }

    private _waitForJoin(): Promise<void> {
        if (this._joined) return Promise.resolve();
        if (!this._joinPromise) {
            this._joinPromise = new Promise((resolve) => {
                this._resolveJoin = resolve;
            });
        }
        return this._joinPromise;
    }

    private _waitForJoinWithGrace(): Promise<void> {
        if (this._joined) return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            let timer: number | undefined;
            const settle = () => {
                if (settled) return;
                settled = true;
                if (timer !== undefined) timers.clearTimeout(timer);
                if (!this._joined) {
                    // Keep the native join asynchronous only after the grace
                    // period. Until then the referenced pipe must stay alive
                    // long enough to observe EOF and reap a responsive worker.
                    this._port.unref();
                    markAbandoned(this);
                }
                resolve();
            };
            this._waitForJoin().then(settle, settle);
            timer = timers.setTimeout(settle, WORKER_JOIN_GRACE_MS);
        });
    }

    private _closeStdio(): void {
        this._stdout?.end();
        this._stderr?.end();
    }

    postMessageToThread(targetThreadId: number, value: unknown, transferList?: unknown[], timeout?: number): Promise<void> {
        return postMessageToThread(targetThreadId, value, transferList, timeout);
    }

    terminate(): Promise<number | undefined> {
        // Node reports a terminated worker with exit code 1.
        if (this._terminatePromise) return this._terminatePromise;
        if (this._exited) return Promise.resolve(undefined);
        let resolveTermination!: (code: number) => void;
        const termination = new Promise<number>(resolve => { resolveTermination = resolve; });
        this._terminatePromise = termination;
        this._exited = true;
        workerRegistry.delete(this.threadId);
        this._detachBroadcastPipe();

        // Native terminate() joins synchronously; request a stop and join after
        // EOF so an unresponsive worker cannot block the parent event loop.
        this._joinPending = true;
        this._native.stop();
        markAbandoned(this);
        // Keep the pipe referenced during the short join grace period. An
        // immediate unref can let the parent loop stop before EOF dispatches,
        // leaving an otherwise responsive native worker joinable.
        this._port.ref();
        this._closeStdio();
        // Start the join/grace path before user exit listeners run. An exit
        // listener may throw; that exception must still escape the microtask,
        // but it cannot strand the native worker or this termination promise.
        this._waitForJoinWithGrace().then(() => {
            this._terminatePromise = null;
            resolveTermination(1);
        });
        // Let immediately attached listeners observe 'exit'.
        queueMicrotask(() => {
            this.emit('exit', 1);
        });
        return termination;
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
        try {
            parentPort.postMessage(value, transferList);
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(error);
        }
    }

    const target = workerRegistry.get(targetThreadId);
    if (!target) {
        return Promise.reject(new Error(`Worker thread ${targetThreadId} is not running`));
    }

    try {
        target.postMessage(value, transferList);
        return Promise.resolve();
    } catch (error) {
        return Promise.reject(error);
    }
}
