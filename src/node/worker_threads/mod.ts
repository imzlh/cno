/**
 * Node.js worker_threads module
 * Based on CModuleWorker implementation
 */

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
const error = import.meta.use('error');
const osmod = import.meta.use('os');

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

/**
 * Workers the process must not wait for at exit: either terminate() was asked
 * for and the join is still pending (the thread is wedged and will never reach
 * the stop async), or the user unref'd the worker, which in Node means "do not
 * hold the process open for this".
 *
 * This exists because the native teardown is unconditional. TJS_FreeRuntime
 * (circu.js/src/vm.c:492-506) walks every entry of qrt->workers and calls
 * tjs__worker_stop_and_join(), whose uv_thread_join (mod_worker.c:671) runs on
 * the main thread. A wedged worker never leaves that list — the only unlink is
 * list_del() in tjs_worker_finalizer (mod_worker.c:754), which is GC-driven and
 * cannot run while w->self_obj still self-references the wrapper, and that
 * reference is only dropped by worker_release_self() AFTER a successful join.
 * So the join is reached, blocks forever, and the process hangs after all JS
 * has finished (OBSERVED: "REACHED END" prints, then rc=124 at 8s).
 */
const abandonedWorkers = new Set<Worker>();
let exitHookInstalled = false;
let forcingExit = false;

/**
 * The 'exit' event is dispatched from the natural-drain path in TJS_Run
 * (vm.c tjs__lifecycle_drain) BEFORE cli.c:82 calls TJS_FreeRuntime, so a
 * listener here still runs ahead of the blocking join. os.exit() is C exit()
 * (mod_os.c:89), which never returns to TJS_Run and therefore never reaches the
 * join at all — MEASURED as the only escape: with the forced exit rc=0 in
 * 776ms, with an otherwise identical listener that does not force it rc=124.
 */
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

/**
 * The parent's resolved runtime config, published on globalThis by `cno run`.
 * A worker re-derives its config from os.args, which does NOT carry the parent's
 * CLI flags, so without forwarding this a worker silently reverts to defaults:
 * OBSERVED `--no-oxc -C mycond` giving the worker enableOxc:true and no
 * conditions, and `--memory-limit` not applying at all. The webapi Worker
 * already forwards it (cno/src/webapi/worker.ts:261); this is the node path.
 */
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

/**
 * Fold a Worker's `resourceLimits` into the runtime config the worker actually
 * builds its JSRuntime from.
 *
 * `resourceLimits` used to be pure bookkeeping: it round-tripped to
 * `worker_threads.resourceLimits` for reporting and nothing consumed it.
 * OBSERVED (2026-08-03, file-based worker, cno/src/node polyfill path): with
 * `maxOldGenerationSizeMb: 8`, a worker retained 400_000 objects and exited 0,
 * while node v24.18 reported "Worker terminated due to reaching memory limit:
 * JS heap out of memory" and exited 1. Same class as --memory-limit allowing 4GB.
 *
 * Units: Node's keys (maxOldGenerationSizeMb, stackSizeMb) are MEGABYTES; cts's
 * memoryLimit/maxStackSize are BYTES (cts/src/config.ts TIER_MEM_LIMIT uses
 * 32 * 1024 * 1024, and parseSize returns bytes). Hence mbToBytes.
 *
 * Precedence is `min`, not "fill only when absent": createConfig always resolves
 * memoryLimit from the memory tier (cts/src/config.ts:353), so the parent's
 * published config is never actually unset and a fill-if-absent rule would leave
 * resourceLimits dead exactly as before. Taking the tighter of the two keeps an
 * explicit parent --memory-limit authoritative while letting a per-worker limit
 * bite, and can never WIDEN a cap the parent asked for.
 *
 * Semantics differ from V8's (old-generation heap vs a total allocation cap), the
 * same approximation already documented for --max-old-space-size in
 * src/commands/flags-config.ts. Capping near the requested value beats ignoring it.
 *
 * NOTE: this cannot help an `eval:` worker. src/main.ts:209-210 calls runEval()
 * without runFile()'s `config` argument, so an eval worker inherits no config at
 * all (see the KNOWN GAP test in tests/cts/resource-limits.test.ts). That file is
 * baked and needs a rebuild.
 */
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

/**
 * A MessagePort is a thread-local object graph, so it cannot be serialized onto
 * the native pipe that connects two real threads. Detect it before any cloning
 * happens so the caller gets a synchronous DataCloneError instead of an
 * "unsupported object class" rejection from deep inside the pipe encoder, and so
 * nothing in the transfer list has been detached yet.
 */
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

        // The queue is held by reference and close() no longer clears it, so a
        // drain already in progress when the handler calls close() finishes
        // delivering what had already arrived (matches Node).
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

/**
 * Emit 'close' on the check phase, matching Node's observed scheduling. Falls
 * back to a microtask if setImmediate is unavailable so the event is never lost.
 */
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
    // Node reports hasRef() === false for a fresh port; it only holds the loop
    // open once the port has been started.
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
        // Node defers the 'close' emit to the check phase (OBSERVED: it lands
        // after setImmediate and before a 0ms timer), which has two visible
        // consequences a synchronous emit gets wrong: messages already being
        // drained when the handler calls close() still arrive BEFORE 'close',
        // and a listener attached on the line after close() still fires.
        deferPortClose(this);
        // Closing one end closes the entangled end too, and Node fires 'close'
        // on both ports.
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
        // Starting a port makes it hold the loop open, as in Node.
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
    // The native thread has been asked to stop but not yet joined. The join is
    // deferred until pipe EOF proves the worker runtime is gone; see _reap().
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
        // Same guard postMessage() uses: a MessagePort is a thread-local object
        // graph, so it cannot cross to a real thread. Without this the port was
        // silently flattened into a plain object and the worker got something
        // whose .postMessage was not a function.
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
                // The worker announced its exit, so its EOF is imminent. Mark
                // the join as pending so that EOF reaps the thread instead of
                // leaving the handle and its socket until process teardown.
                this._joinPending = true;
                this._finish(undefined, typeof code === 'number' ? code : 0);
                return;
            }
            if (!this._exited) this.emit('message', data);
        });
        this._port.on('messageerror', (err: unknown) => {
            if (isPipeEof(err)) {
                // EOF means the worker runtime has torn its end of the
                // socketpair down, i.e. the thread is on its way out. That is
                // the only safe moment to join it, so reap first and only then
                // decide whether this is also the worker's exit notification.
                this._reap();
                if (!this._exited) this._finish(undefined, 0);
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

    /**
     * Join the native thread. Only safe once pipe EOF has proved the worker
     * runtime is torn down: the native terminate() is a stop-and-JOIN, and
     * joining a worker that is wedged (infinite loop, blocking Atomics.wait)
     * blocks the parent's event loop thread forever — the whole process hangs,
     * not just the returned promise.
     */
    private _reap(): void {
        if (!this._joinPending) return;
        this._joinPending = false;
        try {
            this._native.terminate();
        } catch {
            // Already reaped or never started; nothing left to join.
        }
        // The thread is genuinely joined now, so teardown can safely wait for
        // it and the exit hook must stop forcing an abrupt exit on its behalf.
        abandonedWorkers.delete(this);
        this._port.close();
    }

    private _finish(error: WorkerErrorPayload | undefined, code: number): void {
        if (this._exited) return;
        this._exited = true;
        this._exitCode = code;
        workerRegistry.delete(this.threadId);
        this._outgoingQueue = [];
        if (this._joinPending) {
            // Keep the pipe readable (but not holding the loop open) so the
            // pending EOF can still arrive and drive _reap().
            this._port.unref();
        } else {
            this._port.close();
        }
        this._closeStdio();
        if (error) this.emit('error', errorFromWorkerPayload(error));
        this.emit('exit', code);
    }

    /**
     * Without this, a consumer waiting for 'end' on worker.stdout/stderr hangs
     * forever once the worker is gone.
     */
    private _closeStdio(): void {
        this._stdout?.end();
        this._stderr?.end();
    }

    postMessageToThread(targetThreadId: number, value: unknown, transferList?: unknown[], timeout?: number): Promise<void> {
        return postMessageToThread(targetThreadId, value, transferList, timeout);
    }

    terminate(): Promise<number> {
        // Node resolves with the exit code the worker actually reports, and a
        // worker killed by terminate() exits with 1.
        if (this._exited) return Promise.resolve(this._exitCode);
        this._exited = true;
        this._exitCode = 1;
        workerRegistry.delete(this.threadId);
        this._outgoingQueue = [];

        // stop(), NOT the native terminate(): the latter is a stop-and-join and
        // uv_thread_join runs on the parent's event loop thread. A worker that
        // cannot reach the stop async — spinning in JS, parked in
        // Atomics.wait, blocked in a syscall — never exits, so the join never
        // returns and the entire parent process wedges (measured: no heartbeat,
        // terminate() never even returns to JS, SIGKILL required). Node kills
        // such a worker in ~15ms. Requesting the stop asynchronously keeps the
        // parent responsive; the thread is joined later by _reap() once pipe EOF
        // proves it is gone.
        this._joinPending = true;
        this._native.stop();
        // The thread may be wedged and thus unjoinable. Native teardown would
        // still try to join it, so record it as something the process must not
        // wait for; _reap() clears this once EOF proves the join is safe.
        markAbandoned(this);
        // Keep the pipe readable but off the loop's ref count so the pending EOF
        // can still drive _reap() without holding the process open.
        this._port.unref();
        this._closeStdio();
        // Defer, as the previous promise-chained implementation did, so a
        // listener attached on the line after terminate() still sees 'exit'.
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
        // Only a pending join can still make this worker unwaitable.
        if (!this._joinPending) abandonedWorkers.delete(this);
    }

    unref(): void {
        this._refed = false;
        this._port.unref();
        // Node: an unref'd worker does not keep the process alive. cno's loop
        // honours that (the loop drains), but native teardown still joins the
        // thread, so an unref'd worker that never finishes hangs the process
        // after all JS is done (OBSERVED rc=124 vs Node rc=0 in 413ms).
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
    // Nothing else reports the worker's exit status: the native layer's
    // terminate()/close() carry no exit code, so the parent would otherwise see
    // pipe EOF and report 0 for every worker. Report it from the thread itself.
    //
    // SCOPE, RE-MEASURED 2026-08-09 (this comment previously claimed the listener
    // "never actually fires" -- that was measured on 2026-08-02 and is now only
    // half true, so it is corrected here rather than left to mislead):
    //   - explicit process.exit(N): the listener DOES fire and the parent reports
    //     N. Verified for 42, 1 and 7 against node v24.18.0. The native exit
    //     dispatches EV_EXIT and node/process/mod.ts's ensureEventBridge() turns
    //     that into this 'exit' event.
    //   - natural drain after `process.exitCode = N`: still dead. The parent
    //     reports 0 where node reports N, because tjs__lifecycle_drain()
    //     (circu.js/src/vm.c:948-955) returns early for qrt->is_worker, so a
    //     worker receives no EV_EXIT on a natural drain at all. That one needs a
    //     C fix and a rebuild.
    //
    // This listener only exists once the WORKER has imported node:worker_threads,
    // which is why node/process/mod.ts installs an equivalent reporter of its own
    // (installWorkerExitReporter) -- a worker whose whole body is
    // `process.exit(42)` reported 0 before that was added. Both firing is
    // harmless: _finish() ignores every record after the first.
    const host = processExitHost();
    if (host) {
        host.on('exit', (code?: unknown) => {
            try {
                pipe.postMessage({ [NODE_WORKER_EXIT]: { code: typeof code === 'number' ? code : 0 } });
            } catch {
                // The pipe may already be torn down; the parent falls back to EOF.
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
