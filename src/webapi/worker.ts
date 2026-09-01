import { EventTarget, MessageEvent, ErrorEvent, DOMException } from "./events";
import {
    decodeStructuredCloneFromPipe,
    encodeStructuredCloneForPipe,
    getTransferList,
    structuredCloneWithTransfer,
} from "../node/_internal/structured-clone";
import {
    MessagePort,
    addMessagePortDisentangleListener,
    closedSymbol,
    enqueueMessagePortMessage,
    isMessagePort,
    moveMessagePort,
} from "./messaging";
import {
    detachWorkerBroadcastPipe,
    handleBroadcastDelivery,
    handleWorkerBroadcastControl,
} from './broadcast-channel';
import { resolveObjectURLBytes } from './url';

const worker = import.meta.use('worker');
const crypto = import.meta.use('crypto');
const os = import.meta.use('os');
const timers = import.meta.use('timers');
const error = import.meta.use('error');

const PORT_PLACEHOLDER = '__cno_transferred_message_port__';
type LocalPortEndpoint = {
    port: MessagePort;
    pipe: CModuleWorker.MessagePipe;
    listener: EventListener;
    nativeClose: () => void;
    removeDisentangleListener: () => void;
};
type RemotePortEndpoint = {
    port: MessagePort;
    pipe: CModuleWorker.MessagePipe;
    nativeClose: () => void;
    removeDisentangleListener: () => void;
};

// A transferred port is backed by a native MessagePipe. Keep the pipe in the
// registry entry so worker shutdown can release every closure and queued port
// belonging to that worker instead of retaining them in process-global maps.
const localPortEndpoints = new Map<string, LocalPortEndpoint>();
const remotePorts = new Map<string, RemotePortEndpoint>();

type PipeRefState = {
    message: boolean;
    ports: number;
    refed: boolean;
};

// A worker control pipe can be kept alive by either global `message`
// listeners or transferred MessagePort endpoints. Track both reasons so
// removing one kind of listener cannot accidentally unref the other.
const pipeRefStates = new Map<CModuleWorker.MessagePipe, PipeRefState>();

function pipeRefState(pipe: CModuleWorker.MessagePipe): PipeRefState {
    let state = pipeRefStates.get(pipe);
    if (!state) {
        // Native MessagePipe handles start ref'ed.
        state = { message: false, ports: 0, refed: true };
        pipeRefStates.set(pipe, state);
    }
    return state;
}

function refreshPipeRef(pipe: CModuleWorker.MessagePipe, state = pipeRefState(pipe)): void {
    const shouldRef = state.message || state.ports > 0;
    if (state.refed === shouldRef) return;
    state.refed = shouldRef;
    try {
        if (shouldRef) pipe.ref();
        else pipe.unref();
    } catch {
        // The native handle may already be closing during runtime teardown.
    }
}

function setMessagePipeRef(pipe: CModuleWorker.MessagePipe, refed: boolean): void {
    const state = pipeRefState(pipe);
    state.message = refed;
    refreshPipeRef(pipe, state);
}

function retainPortPipe(pipe: CModuleWorker.MessagePipe): void {
    const state = pipeRefState(pipe);
    state.ports++;
    refreshPipeRef(pipe, state);
}

function releasePortPipe(pipe: CModuleWorker.MessagePipe): void {
    const state = pipeRefStates.get(pipe);
    if (!state) return;
    if (state.ports > 0) state.ports--;
    refreshPipeRef(pipe, state);
}

function disposePipeRefState(pipe: CModuleWorker.MessagePipe): void {
    pipeRefStates.delete(pipe);
}
type PortPlaceholder = { [PORT_PLACEHOLDER]: string };
type MessagePipePayload = { data: unknown; transfer?: { ports?: string[] } };
type RecordLike = Record<PropertyKey, unknown>;
type WorkerMessageHandler = NonNullable<globalThis.Worker['onmessage']>;
type WorkerMessageErrorHandler = NonNullable<globalThis.Worker['onmessageerror']>;
type WorkerErrorHandler = NonNullable<globalThis.Worker['onerror']>;

function isRecord(value: unknown): value is RecordLike {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function currentRuntimeConfig(): unknown {
    try {
        return Reflect.get(globalThis, '__cno_worker_runtime_config');
    } catch {
        return undefined;
    }
}

function workerEntrySpecifier(specifier: string | URL): string {
    const raw = specifier.toString();
    try {
        const url = new URL(raw);
        if (url.protocol !== 'blob:') return raw;
        const payload = resolveObjectURLBytes(url);
        if (!payload) return raw;
        const mime = payload.type || 'application/javascript';
        return `data:${mime};base64,${crypto.base64Encode(payload.bytes)}`;
    } catch {
        return raw;
    }
}

function isPromiseRejectionEvent(value: Event): value is PromiseRejectionEvent {
    return isRecord(value) && 'reason' in value && typeof value.preventDefault === 'function';
}

function isClosedPort(port: MessagePort): boolean {
    return port[closedSymbol];
}

function isPipeEof(value: unknown): boolean {
    return isRecord(value) && Reflect.get(value, 'code') === error.errno.EOF;
}

function generateId(): string {
    const bytes = new Uint8Array(8);
    crypto.randomFill(bytes);
    return crypto.hexEncode(bytes) + Date.now().toString(36);
}

function isPortPlaceholder(value: unknown): value is PortPlaceholder {
    return isRecord(value)
        && typeof value[PORT_PLACEHOLDER] === 'string'
        && Object.keys(value).length === 1;
}

function createRemotePort(id: string, pipe: CModuleWorker.MessagePipe): MessagePort {
    const existing = remotePorts.get(id);
    if (existing) return existing.port;

    const port = new MessagePort();
    const close = port.close.bind(port);
    const endpoint: RemotePortEndpoint = {
        port,
        pipe,
        nativeClose: close,
        removeDisentangleListener: () => {},
    };
    port.postMessage = (message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
        if (isClosedPort(port)) {
            throw new DOMException('MessagePort is closed', 'InvalidStateError');
        }
        const encoded = encodeMessageForPipe(message, transferOrOptions, pipe);
        pipe.postMessage({ __cno_port_message: { id, ...encoded } });
    };
    port.close = () => {
        if (isClosedPort(port)) return;
        closeRemotePortEndpoint(id, endpoint, true);
    };
    remotePorts.set(id, endpoint);
    retainPortPipe(pipe);
    endpoint.removeDisentangleListener = addMessagePortDisentangleListener(port, () => {
        // Disentanglement also occurs when the endpoint is transferred again;
        // that path must not signal a peer-side close.
        closeRemotePortEndpoint(id, endpoint, false);
    });
    return port;
}

function revivePortPlaceholders(value: unknown, pipe: CModuleWorker.MessagePipe, seen = new Map<object, unknown>()): unknown {
    if (!value || typeof value !== 'object') return value;
    if (isPortPlaceholder(value)) return createRemotePort(value[PORT_PLACEHOLDER], pipe);
    if (seen.has(value)) return seen.get(value);
    seen.set(value, value);

    if (value instanceof Map) {
        const entries = Array.from(value.entries());
        value.clear();
        for (const [key, item] of entries) {
            value.set(revivePortPlaceholders(key, pipe, seen), revivePortPlaceholders(item, pipe, seen));
        }
        return value;
    }
    if (value instanceof Set) {
        const entries = Array.from(value.values());
        value.clear();
        for (const item of entries) value.add(revivePortPlaceholders(item, pipe, seen));
        return value;
    }
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.writable) continue;
        (value as RecordLike)[key] = revivePortPlaceholders(descriptor.value, pipe, seen);
    }
    return value;
}

function bindLocalPortEndpoint(id: string, port: MessagePort, pipe: CModuleWorker.MessagePipe): void {
    const listener: EventListener = (event: Event) => {
        // The endpoint may have been torn down while a queued message was
        // being delivered. Avoid writing through a stale pipe in that case.
        const endpoint = localPortEndpoints.get(id);
        if (!endpoint || endpoint.port !== port || endpoint.pipe !== pipe || isClosedPort(port)) return;
        const messageEvent = event as MessageEvent;
        const encoded = encodeMessageForPipe(messageEvent.data, messageEvent.ports, pipe);
        pipe.postMessage({ __cno_port_message: { id, ...encoded } });
    };
    const previous = localPortEndpoints.get(id);
    if (previous) closeLocalPortEndpoint(id, previous, false);
    const endpoint: LocalPortEndpoint = {
        port,
        pipe,
        listener,
        nativeClose: port.close.bind(port),
        removeDisentangleListener: () => {},
    };
    // Publish the endpoint before installing the lifecycle hook: registering a
    // hook on an already-closed port invokes it synchronously.
    localPortEndpoints.set(id, endpoint);
    retainPortPipe(pipe);
    port.close = () => {
        if (isClosedPort(port)) return;
        closeLocalPortEndpoint(id, endpoint, true);
    };
    port.addEventListener('message', listener);
    endpoint.removeDisentangleListener = addMessagePortDisentangleListener(port, () => {
        // A transfer also disentangles the old endpoint. The new clone owns
        // the route, so only an explicit close should notify the peer.
        closeLocalPortEndpoint(id, endpoint, false);
    });
}

function closeLocalPortEndpoint(id: string, endpoint: LocalPortEndpoint, notifyPeer: boolean): void {
    if (localPortEndpoints.get(id) !== endpoint) return;
    localPortEndpoints.delete(id);
    endpoint.port.removeEventListener('message', endpoint.listener);
    endpoint.removeDisentangleListener();
    if (!isClosedPort(endpoint.port)) endpoint.nativeClose();
    if (notifyPeer) {
        try { endpoint.pipe.postMessage({ __cno_port_close: { id } }); } catch { /* pipe teardown already owns cleanup */ }
    }
    releasePortPipe(endpoint.pipe);
}

function closeRemotePortEndpoint(id: string, endpoint: RemotePortEndpoint, notifyPeer: boolean): void {
    if (remotePorts.get(id) !== endpoint) return;
    remotePorts.delete(id);
    endpoint.removeDisentangleListener();
    if (!isClosedPort(endpoint.port)) endpoint.nativeClose();
    if (notifyPeer) {
        try { endpoint.pipe.postMessage({ __cno_port_close: { id } }); } catch { /* pipe teardown already owns cleanup */ }
    }
    releasePortPipe(endpoint.pipe);
}

/** Release all transferred ports and their listeners associated with a pipe. */
function detachWorkerPortPipe(pipe: CModuleWorker.MessagePipe): void {
    for (const [id, endpoint] of localPortEndpoints) {
        if (endpoint.pipe === pipe) closeLocalPortEndpoint(id, endpoint, false);
    }
    for (const [id, endpoint] of remotePorts) {
        if (endpoint.pipe === pipe) closeRemotePortEndpoint(id, endpoint, false);
    }
    disposePipeRefState(pipe);
}

function encodeMessageForPipe(
    message: unknown,
    transferOrOptions: Transferable[] | StructuredSerializeOptions | undefined,
    pipe: CModuleWorker.MessagePipe,
): MessagePipePayload {
    const portIds = new Map<MessagePort, string>();
    const getPortId = (port: MessagePort) => {
        let id = portIds.get(port);
        if (!id) {
            id = generateId();
            portIds.set(port, id);
        }
        return id;
    };
    const data = structuredCloneWithTransfer<unknown, MessagePort, PortPlaceholder>(message, transferOrOptions, {
        isPort: isMessagePort,
        createPortClone(port) {
            return { [PORT_PLACEHOLDER]: getPortId(port) };
        },
        commitPortTransfer(port, clone) {
            bindLocalPortEndpoint(clone[PORT_PLACEHOLDER], moveMessagePort(port), pipe);
        },
        isUntransferable: (item) => isMessagePort(item) && isClosedPort(item),
    });
    const encodedData = encodeStructuredCloneForPipe(data);
    const ports = getTransferList(transferOrOptions)
        .filter(isMessagePort)
        .map(getPortId);
    return ports.length > 0 ? { data: encodedData, transfer: { ports } } : { data: encodedData };
}

function decodeMessageFromPipe(rawData: unknown, pipe: CModuleWorker.MessagePipe): { data: unknown; ports: MessagePort[] } {
    let data = rawData;
    if (isRecord(rawData) && rawData.__cno_transfer) {
        data = Reflect.get(rawData, '__cno_data');
    }
    const rawTransfer = isRecord(rawData) ? Reflect.get(rawData, '__cno_transfer') : undefined;
    const rawPorts = isRecord(rawTransfer) ? Reflect.get(rawTransfer, 'ports') : undefined;
    const portIds = Array.isArray(rawPorts) ? rawPorts.filter((id): id is string => typeof id === 'string') : [];
    const ports = portIds.map((id) => createRemotePort(id, pipe));
    return { data: decodeStructuredCloneFromPipe(revivePortPlaceholders(data, pipe)), ports };
}

function errorFromWorkerPayload(payload: unknown, fallbackMessage: string): Error {
    if (payload instanceof Error) return payload;
    const record = isRecord(payload) ? payload : {};
    const name = typeof record.name === 'string' ? record.name : 'Error';
    const message = typeof record.message === 'string' ? record.message : fallbackMessage;
    const ctor = name === 'TypeError' ? TypeError
        : name === 'RangeError' ? RangeError
        : name === 'ReferenceError' ? ReferenceError
        : name === 'SyntaxError' ? SyntaxError
        : Error;
    const error = new ctor(message);
    error.name = name;
    if (typeof record.stack === 'string') {
        Object.defineProperty(error, 'stack', {
            value: record.stack,
            configurable: true,
        });
    }
    return error;
}

function errorPayload(error: unknown, fallbackMessage: string): { name: string; message: string; stack?: string } {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: typeof error.stack === 'string' ? error.stack : undefined,
        };
    }
    return { name: 'Error', message: fallbackMessage };
}

function handlePortControlMessage(rawData: unknown, pipe: CModuleWorker.MessagePipe): boolean {
    if (!isRecord(rawData)) return false;

    const portMessage = rawData.__cno_port_message;
    if (isRecord(portMessage) && typeof portMessage.id === 'string') {
        const localCandidate = localPortEndpoints.get(portMessage.id);
        const localEndpoint = localCandidate?.pipe === pipe ? localCandidate : undefined;
        const remoteCandidate = remotePorts.get(portMessage.id);
        const remoteEndpoint = remoteCandidate?.pipe === pipe ? remoteCandidate : undefined;
        if (!localEndpoint && !remoteEndpoint) {
            const orphanIds = new Set<string>([portMessage.id]);
            const transfer = portMessage.transfer;
            const rawPorts = isRecord(transfer) ? transfer.ports : undefined;
            if (Array.isArray(rawPorts)) {
                for (const id of rawPorts) if (typeof id === 'string') orphanIds.add(id);
            }
            for (const id of orphanIds) {
                try { pipe.postMessage({ __cno_port_close: { id } }); } catch { break; }
            }
            return true;
        }
        const decoded = decodeMessageFromPipe(portMessage.transfer
            ? { __cno_data: portMessage.data, __cno_transfer: portMessage.transfer }
            : portMessage.data, pipe);
        if (localEndpoint) {
            localEndpoint.port.postMessage(decoded.data, decoded.ports);
        } else if (remoteEndpoint) {
            enqueueMessagePortMessage(remoteEndpoint.port, decoded.data, decoded.ports);
        }
        return true;
    }

    const portClose = rawData.__cno_port_close;
    if (isRecord(portClose) && typeof portClose.id === 'string') {
        const localEndpoint = localPortEndpoints.get(portClose.id);
        if (localEndpoint?.pipe === pipe) closeLocalPortEndpoint(portClose.id, localEndpoint, false);
        const remoteEndpoint = remotePorts.get(portClose.id);
        if (remoteEndpoint?.pipe === pipe) closeRemotePortEndpoint(portClose.id, remoteEndpoint, false);
        return true;
    }

    return false;
}

class Worker extends EventTarget implements globalThis.Worker {
    #worker: CModuleWorker.Worker;
    #terminated = false;
    #onmessage: WorkerMessageHandler | null = null;
    #onmessageerror: WorkerMessageErrorHandler | null = null;
    #onerror: WorkerErrorHandler | null = null;
    #onmessageListener: ((ev: Event) => void) | null = null;
    #onmessageerrorListener: ((ev: Event) => void) | null = null;
    #onerrorListener: ((ev: Event) => void) | null = null;
    #messageQueue: MessageEvent[] = [];
    #messageConsumerReady = false;

    constructor(specifier: string | URL, options?: WorkerOptions) {
        super();
        this.#worker = new worker.Worker({
            ...options,
            '__cts_entry': workerEntrySpecifier(specifier),
            '__cts_runtime_config': currentRuntimeConfig(),
        });
        this.#setupMessagePipe();
    }

    #setupMessagePipe(): void {
        const p = this.#worker.messagePipe;
        
        p.onmessage = (rawData: unknown) => {
            if (this.#terminated) return;
            if (handleWorkerBroadcastControl(p, rawData)) return;
            if (handlePortControlMessage(rawData, p)) return;

            if (isRecord(rawData)
                && ('__cno_node_worker_ready__' in rawData
                    || '__cno_node_worker_exit__' in rawData
                    || '__cno_node_worker_error__' in rawData)) return;

            if (isRecord(rawData)) {
                if (rawData.__cno_role === 'error') {
                    const fallbackMessage = typeof rawData.message === 'string' ? rawData.message : 'Unknown error';
                    const error = errorFromWorkerPayload(rawData.error, fallbackMessage);
                    const event = new ErrorEvent('error', {
                        message: error.message,
                        error,
                        filename: typeof rawData.filename === 'string' ? rawData.filename : '',
                        lineno: typeof rawData.lineno === 'number' ? rawData.lineno : 0,
                        colno: typeof rawData.colno === 'number' ? rawData.colno : 0,
                        cancelable: true,
                    }, true);
                    this.dispatchEvent(event);
                    return;
                }
            }

            const { data, ports } = decodeMessageFromPipe(rawData, p);
            this.#dispatchMessage(new MessageEvent('message', { data, ports }, true));
        };

        p.onmessageerror = (e: unknown) => {
            if (this.#terminated) return;
            if (isPipeEof(e)) {
                this.#terminated = true;
                this.#detachMessagePipe(p);
                this.#worker.terminate();
            }
            this.dispatchEvent(new MessageEvent('messageerror', { data: e }, true));
        };

        p.onclose = () => {
            if (this.#terminated) return;
            this.#terminated = true;
            this.#detachMessagePipe(p);
            this.#worker.terminate();
        };
    }

    get onmessage(): WorkerMessageHandler | null { return this.#onmessage; }
    set onmessage(value: WorkerMessageHandler | null) {
        if (this.#onmessageListener) {
            super.removeEventListener('message', this.#onmessageListener);
            this.#onmessageListener = null;
        }
        this.#onmessage = typeof value === 'function' ? value : null;
        if (this.#onmessage) {
            this.#onmessageListener = (event) => this.#onmessage?.call(this, event as globalThis.MessageEvent);
            super.addEventListener('message', this.#onmessageListener);
            this.#messageConsumerReady = true;
            this.#flushMessages();
        }
    }

    get onmessageerror(): WorkerMessageErrorHandler | null { return this.#onmessageerror; }
    set onmessageerror(value: WorkerMessageErrorHandler | null) {
        if (this.#onmessageerrorListener) {
            super.removeEventListener('messageerror', this.#onmessageerrorListener);
            this.#onmessageerrorListener = null;
        }
        this.#onmessageerror = typeof value === 'function' ? value : null;
        if (this.#onmessageerror) {
            this.#onmessageerrorListener = (event) => this.#onmessageerror?.call(this, event as globalThis.MessageEvent);
            super.addEventListener('messageerror', this.#onmessageerrorListener);
        }
    }

    get onerror(): WorkerErrorHandler | null { return this.#onerror; }
    set onerror(value: WorkerErrorHandler | null) {
        if (this.#onerrorListener) {
            super.removeEventListener('error', this.#onerrorListener);
            this.#onerrorListener = null;
        }
        this.#onerror = typeof value === 'function' ? value : null;
        if (this.#onerror) {
            this.#onerrorListener = (event) => this.#onerror?.call(this, event as globalThis.ErrorEvent);
            super.addEventListener('error', this.#onerrorListener);
        }
    }

    postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
        if (this.#terminated) {
            throw new DOMException('Worker is terminated', 'InvalidStateError');
        }

        const encoded = encodeMessageForPipe(message, transferOrOptions, this.#worker.messagePipe);
        if (encoded.transfer) {
            this.#worker.messagePipe.postMessage({
                __cno_data: encoded.data,
                __cno_transfer: encoded.transfer,
            });
        } else {
            this.#worker.messagePipe.postMessage(encoded.data);
        }
    }

    terminate(): void {
        if (this.#terminated) return;
        this.#terminated = true;
        this.#detachMessagePipe(this.#worker.messagePipe);
        return this.#worker.terminate();
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
        super.addEventListener(type, listener, options);
        if (type === 'message' && listener) {
            this.#messageConsumerReady = true;
            this.#flushMessages();
        }
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
        super.removeEventListener(type, listener, options);
    }
    
    get [Symbol.toStringTag]() {
        return 'Worker';
    }

    #dispatchMessage(event: MessageEvent): void {
        if (!this.#messageConsumerReady) {
            this.#messageQueue.push(event);
            return;
        }
        this.dispatchEvent(event);
    }

    #flushMessages(): void {
        while (!this.#terminated && this.#messageQueue.length > 0) {
            const event = this.#messageQueue.shift();
            if (event !== undefined) this.#dispatchMessage(event);
        }
    }

    #detachMessagePipe(pipe: CModuleWorker.MessagePipe): void {
        pipe.onmessage = undefined;
        pipe.onmessageerror = undefined;
        pipe.onclose = undefined;
        detachWorkerBroadcastPipe(pipe);
        detachWorkerPortPipe(pipe);
        this.#messageQueue.length = 0;
    }
}

if (worker.isWorker) {
    const pipe = worker.pipe;
    if (!pipe) throw new Error('worker pipe was not created');
    const workerData = isRecord(worker.workerData) ? worker.workerData : undefined;
    const workerNameValue = workerData?.name;
    const workerName = typeof workerNameValue === 'string' ? workerNameValue : '';

    Reflect.set(self, 'name', workerName);

    Reflect.set(self, 'postMessage', (message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
        const encoded = encodeMessageForPipe(message, transferOrOptions, pipe);
        if (encoded.transfer) {
            pipe.postMessage({
                __cno_data: encoded.data,
                __cno_transfer: encoded.transfer,
            });
        } else {
            pipe.postMessage(encoded.data);
        }
    });

    const events = {
        onmessage: null as ((ev: MessageEvent) => unknown) | null,
        onmessageerror: null as ((ev: MessageEvent) => unknown) | null,
        onerror: null as ((ev: ErrorEvent) => unknown) | null
    };
    const messageQueue: MessageEvent[] = [];
    // Keep this sticky: messages sent while no listener is registered are dropped,
    // not retained and replayed when a later listener is added.
    let messageConsumerReady = false;
    let messageFlushScheduled = false;
    let flushingMessages = false;
    type MessageListener = EventListenerOrEventListenerObject;
    type MessageListenerRecord = {
        listener: MessageListener;
        capture: boolean;
        once: boolean;
        wrapped: EventListener;
        signal?: AbortSignal;
        abortHandler?: () => void;
    };
    const messageListeners: MessageListenerRecord[] = [];
    const addEventListener = self.addEventListener.bind(self);
    const removeEventListener = self.removeEventListener.bind(self);
    const setPipeRef = (refed: boolean): void => {
        setMessagePipeRef(pipe, refed);
    };

    const captureOption = (options?: boolean | EventListenerOptions): boolean =>
        typeof options === 'boolean' ? options : !!options?.capture;
    const findMessageListener = (listener: MessageListener, capture: boolean): MessageListenerRecord | undefined =>
        messageListeners.find((entry) => entry.listener === listener && entry.capture === capture);
    const releaseMessageListener = (entry: MessageListenerRecord): void => {
        const index = messageListeners.indexOf(entry);
        if (index === -1) return;
        messageListeners.splice(index, 1);
        removeEventListener('message', entry.wrapped, entry.capture);
        entry.signal?.removeEventListener('abort', entry.abortHandler!);
        if (messageListeners.length === 0) setPipeRef(false);
    };
    const addMessageListener = (listener: MessageListener, options?: boolean | AddEventListenerOptions): void => {
        const capture = captureOption(options);
        const signal = typeof options === 'boolean' ? undefined : options?.signal;
        if (signal?.aborted || findMessageListener(listener, capture)) return;

        const entry = {} as MessageListenerRecord;
        entry.listener = listener;
        entry.capture = capture;
        entry.once = typeof options !== 'boolean' && !!options?.once;
        entry.signal = signal;
        entry.wrapped = (event: Event): void => {
            if (entry.once) releaseMessageListener(entry);
            if (typeof entry.listener === 'function') {
                entry.listener.call(self, event);
            } else {
                entry.listener.handleEvent?.call(entry.listener, event);
            }
        };
        messageListeners.push(entry);
        addEventListener('message', entry.wrapped, options);
        if (signal) {
            entry.abortHandler = () => releaseMessageListener(entry);
            signal.addEventListener('abort', entry.abortHandler, { once: true });
            if (signal.aborted) releaseMessageListener(entry);
        }
        if (messageListeners.includes(entry)) {
            setPipeRef(true);
            messageConsumerReady = true;
            scheduleMessageFlush();
        }
    };
    const removeMessageListener = (listener: MessageListener, options?: boolean | EventListenerOptions): boolean => {
        const entry = findMessageListener(listener, captureOption(options));
        if (!entry) return false;
        releaseMessageListener(entry);
        return true;
    };
    // The control pipe is an implementation detail. It must not keep a worker
    // alive until user code opts into receiving messages.
    setPipeRef(false);
    let messageListener: ((event: Event) => void) | null = null;
    let messageErrorListener: ((event: Event) => void) | null = null;
    let errorListener: ((event: Event) => void) | null = null;
    let workerClosing = false;

    const isWorkerCloseError = (value: unknown): boolean => {
        return (isRecord(value) && value.__cno_worker_close === true)
            || (value instanceof Error && value.name === 'WorkerCloseError' && value.message === 'Worker closed');
    };

    Reflect.set(self, 'close', () => {
        if (workerClosing) return;
        workerClosing = true;
        timers.setTimeout(() => os.exit(0), 10);
        const error = new Error('Worker closed');
        error.name = 'WorkerCloseError';
        Object.defineProperty(error, '__cno_worker_close', { value: true });
        throw error;
    });

    const dispatchMessage = (event: MessageEvent) => {
        // Keep frames received while a deferred queue flush is pending in
        // arrival order. A native pipe callback can run before the scheduled
        // microtask, so dispatching it directly would overtake older frames.
        if (!messageConsumerReady || (messageQueue.length > 0 && !flushingMessages)) {
            messageQueue.push(event);
            if (messageConsumerReady) scheduleMessageFlush();
            return;
        }
        self.dispatchEvent(event);
    };

    const flushMessages = () => {
        if (flushingMessages) return;
        flushingMessages = true;
        try {
            while (messageQueue.length > 0) {
                const event = messageQueue.shift();
                if (event !== undefined) self.dispatchEvent(event);
            }
        } finally {
            flushingMessages = false;
        }
    };

    // A message may already be queued when the entry module starts registering
    // listeners. Defer the flush until the current turn completes so a listener
    // can add/remove capture variants atomically before the queued event runs.
    const scheduleMessageFlush = (): void => {
        if (messageFlushScheduled || messageQueue.length === 0) return;
        messageFlushScheduled = true;
        queueMicrotask(() => {
            messageFlushScheduled = false;
            if (messageConsumerReady) flushMessages();
        });
    };

    Object.defineProperty(self, 'onmessage', {
        get() { return events.onmessage; },
        set(value: ((ev: MessageEvent) => unknown) | null) {
            if (messageListener) {
                removeMessageListener(messageListener);
                messageListener = null;
            }
            events.onmessage = typeof value === 'function' ? value : null;
            if (events.onmessage) {
                messageListener = (event) => events.onmessage?.(event as MessageEvent);
                addMessageListener(messageListener);
            }
        }
    });

    Object.defineProperty(self, 'onmessageerror', {
        get() { return events.onmessageerror; },
        set(value: ((ev: MessageEvent) => unknown) | null) {
            if (messageErrorListener) {
                removeEventListener('messageerror', messageErrorListener);
                messageErrorListener = null;
            }
            events.onmessageerror = typeof value === 'function' ? value : null;
            if (events.onmessageerror) {
                messageErrorListener = (event) => events.onmessageerror?.(event as MessageEvent);
                addEventListener('messageerror', messageErrorListener);
            }
        }
    });

    Object.defineProperty(self, 'onerror', {
        get() { return events.onerror; },
        set(value: ((ev: ErrorEvent) => unknown) | null) {
            if (errorListener) {
                removeEventListener('error', errorListener);
                errorListener = null;
            }
            events.onerror = typeof value === 'function' ? value : null;
            if (events.onerror) {
                errorListener = (event) => {
                    if (event instanceof ErrorEvent) events.onerror?.(event);
                };
                addEventListener('error', errorListener);
            }
        }
    });

    Reflect.set(self, 'addEventListener', (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ) => {
        if (!listener) return;
        if (type === 'message' && listener) {
            addMessageListener(listener, options);
            return;
        }
        addEventListener(type, listener, options);
    });

    Reflect.set(self, 'removeEventListener', (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ) => {
        if (!listener) return;
        if (type === 'message' && listener && removeMessageListener(listener, options)) return;
        removeEventListener(type, listener, options);
    });

    addEventListener('error', (event) => {
        if (!(event instanceof ErrorEvent) || !event.isTrusted) return;
        if (workerClosing || isWorkerCloseError(event.error)) {
            event.preventDefault();
            return;
        }
        pipe.postMessage({
            __cno_role: 'error',
            message: event.message,
            error: errorPayload(event.error, event.message),
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
        });
        event.preventDefault();
    });

    addEventListener('unhandledrejection', (event) => {
        if (!isPromiseRejectionEvent(event) || !event.isTrusted) return;
        const reason = event.reason;
        if (workerClosing || isWorkerCloseError(reason)) {
            event.preventDefault();
            return;
        }
        const error = reason instanceof Error ? reason : new Error(String(reason));
        pipe.postMessage({
            __cno_role: 'error',
            message: error.message,
            error: errorPayload(error, error.message),
            filename: '',
            lineno: 0,
            colno: 0,
        });
        event.preventDefault();
    });

    pipe.onmessage = (rawData: unknown) => {
        if (handleBroadcastDelivery(rawData)) return;
        if (handlePortControlMessage(rawData, pipe)) return;
        const { data, ports } = decodeMessageFromPipe(rawData, pipe);
        dispatchMessage(new MessageEvent('message', { data, ports }, true));
    };

    pipe.onmessageerror = (e: unknown) => {
        detachWorkerBroadcastPipe(pipe);
        detachWorkerPortPipe(pipe);
        const event = new MessageEvent('messageerror', { data: e }, true);
        self.dispatchEvent(event);
    };
}

Reflect.set(globalThis, 'Worker', Worker);
