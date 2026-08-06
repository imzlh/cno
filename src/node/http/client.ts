/**
 * Node.js http module - client implementation
 */

import {
    applyRequestCommonOptions,
    type ClientHooks,
    type ClientRequestOptions,
    type ClientRequestState,
    abortRequest,
    cleanupRequest,
    connectPlainTransport,
    connectRequest,
    connectRequestWithAgent,
    destroyRequest,
    emitRequestClose,
    endRequest,
    expectsContinue,
    initClientRequestState,
    mergeUrlOptions,
    normalizeRequestOptions,
    releaseRequestTransport,
    setRequestTimeout,
    startContinueHandshake,
    writeRequest,
    formatClientRequestHeader,
} from '../_internal/http-client';
import {
    anyClientChannelActive,
    instrumentClientRequest,
    onClientRequestCreated,
    onClientRequestStart,
} from '../diagnostics_channel/builtins';
import { EventEmitter } from '../events';
import { Socket } from '../net';
import { IncomingMessageImpl, OutgoingMessageImpl, validateRequestMethod, validateRequestPath } from './server';

export { METHODS } from './constants';

export interface ClientRequestArgs extends ClientRequestOptions {
    _defaultAgent?: Agent;
    agent?: Agent | boolean;
    createConnection?: (options: ClientRequestArgs, oncreate: (err: Error | null, socket: Socket) => void) => Socket | null;
    defaultPort?: number | string;
    family?: number;
    insecureHTTPParser?: boolean;
    localAddress?: string;
    localPort?: number;
    maxHeaderSize?: number;
    uniqueHeaders?: Array<string | string[]>;
    joinDuplicateHeaders?: boolean;
}

export interface ClientRequest extends OutgoingMessageImpl {
    agent: Agent | boolean;
    aborted: boolean;
    host: string;
    protocol: string;
    reusedSocket: boolean;
    maxHeadersCount: number | null;
    method: string;
    path: string;
    abort(): void;
    onSocket(socket: Socket): void;
    setTimeout(timeout: number, callback?: () => void): this;
    setNoDelay(noDelay?: boolean): void;
    setSocketKeepAlive(enable?: boolean, initialDelay?: number): void;
    getRawHeaderNames(): string[];
    destroy(error?: Error): this;
}

function flattenPrototype(target: object): void {
    const parent = Object.getPrototypeOf(target);
    if (!parent || parent === Object.prototype) return;

    for (const key of Object.getOwnPropertyNames(parent)) {
        if (key === 'constructor' || Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }

    for (const key of Object.getOwnPropertySymbols(parent)) {
        if (Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }
}

export interface ClientRequestImpl extends ClientRequest, ClientRequestState<Socket> {
    _tcp: CModuleStreams.TCP | null;
    _options: ClientRequestArgs;
    _callback: ((res: IncomingMessageImpl) => void) | null;
    _aborted: boolean;
    _timeoutId: number | null;
    _requestBody: Uint8Array[];
    _bodySent: boolean;
    _socketAssigned: boolean;
    _response: IncomingMessageImpl | null;
    _requestId: string;
    _requestCallFrames: ClientRequestState<Socket>['_requestCallFrames'];
    _abortHandler: (() => void) | null;
    _streamedBeforeEnd: boolean;
    _sendChain: Promise<void>;
    _chunkedEncoding: boolean;
    _headerFlushStarted: boolean;
    _header: string | null;
    outputData: Array<{ data: string }>;
    _connectPromise: Promise<void> | null;
    _streamErrored: boolean;
    _transport: Socket | null;
    _transportCleanup: (() => void) | null;
    _userConnectionHeader: boolean;
    _connect(): Promise<void>;
    _implicitHeader(): void;
}

export interface ClientRequestImplConstructor {
    new (url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void): ClientRequestImpl;
    (url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void): ClientRequestImpl;
    prototype: ClientRequestImpl;
}

const HTTP_CLIENT_HOOKS: ClientHooks<ClientRequestImpl> = {
    defaultPort: 80,
    // Node client sends Host only by default (no User-Agent / Accept-Encoding).
    defaultUserAgent: '',
    requestIdPrefix: 'http-fetch',
    connect: (request) => connectPlainTransport(request, 80),
    onTransportAssigned: (request, transport) => {
        request._tcp = (transport as Socket)._tcp ?? null;
    },
};

function initClientRequest(self: ClientRequestImpl, url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void): void {
    OutgoingMessageImpl.call(self);
    initClientRequestState(self, cb);

    self.reusedSocket = false;
    // Node ClientRequest.maxHeadersCount defaults to null (unlimited until set).
    self.maxHeadersCount = null;
    self._tcp = null;
    self._socketAssigned = false;
    self._response = null;

    self._options = typeof url === 'string' || url instanceof URL
        ? mergeUrlOptions<ClientRequestArgs>(url)
        : normalizeRequestOptions(url);

    // Validate the method as the caller wrote it: node reports the raw string in
    // the error message, not an upper-cased one.
    if (self._options.method !== undefined) validateRequestMethod(self._options.method);
    self.method = self._options.method?.toUpperCase() || 'GET';
    self.path = self._options.path || '/';
    validateRequestPath(self.path);
    self.host = self._options.hostname || self._options.host || 'localhost';
    self.protocol = self._options.protocol || 'http:';
    self.agent = self._options.agent ?? self._options._defaultAgent ?? globalAgent;

    if (self._options.headers) {
        if (Array.isArray(self._options.headers)) {
            for (let i = 0; i < self._options.headers.length; i += 2) {
                self.setHeader(self._options.headers[i], self._options.headers[i + 1]);
            }
        } else {
            for (const [key, value] of Object.entries(self._options.headers)) {
                if (value !== undefined) self.setHeader(key, value);
            }
        }
    }

    self._userConnectionHeader = self.hasHeader('connection');
    applyRequestCommonOptions(self);
    // Node: keepAlive agent → shouldKeepAlive true (Connection added at serialize).
    // agent:false / keepAlive off → shouldKeepAlive false.
    const agentKeepAlive = !!(
        self.agent &&
        typeof self.agent === 'object' &&
        self.agent.options.keepAlive
    );
    self.shouldKeepAlive = agentKeepAlive;

    // Node publishes http.client.request.created at the very end of the
    // ClientRequest constructor, and installs nothing when unsubscribed.
    if (anyClientChannelActive()) {
        instrumentClientRequest(self);
        if (onClientRequestCreated.hasSubscribers) {
            onClientRequestCreated.publish({ request: self });
        }
    }

    // Expect: 100-continue only works if the head reaches the server before the
    // body exists, so node flushes it here rather than at end().
    if (expectsContinue(self)) startContinueHandshake(self, HTTP_CLIENT_HOOKS);
}

export const ClientRequestImpl: ClientRequestImplConstructor = function ClientRequestImpl(this: ClientRequestImpl | undefined, url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void) {
    const target: ClientRequestImpl = this ?? Object.create(ClientRequestImpl.prototype);
    initClientRequest(target, url, cb);
    return target;
} as ClientRequestImplConstructor;

Object.setPrototypeOf(ClientRequestImpl, OutgoingMessageImpl);
ClientRequestImpl.prototype = Object.create(OutgoingMessageImpl.prototype);

ClientRequestImpl.prototype._connect = function _connect(this: ClientRequestImpl): Promise<void> {
    if (this.protocol === 'https:') {
        throw new Error('Protocol "https:" not supported by node:http client. Use node:https instead.');
    }
    if (this.agent && typeof this.agent === 'object' && typeof this.agent.addRequest === 'function') {
        return connectRequestWithAgent(this, HTTP_CLIENT_HOOKS, this.agent);
    }
    return connectRequest(this, HTTP_CLIENT_HOOKS);
};

ClientRequestImpl.prototype.write = function write(this: ClientRequestImpl, chunk: unknown, encodingOrCb?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void): boolean {
    return writeRequest(this, chunk, encodingOrCb, cb, HTTP_CLIENT_HOOKS);
};

ClientRequestImpl.prototype.end = function end(this: ClientRequestImpl, chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): ClientRequestImpl {
    // Node publishes http.client.request.start from ClientRequest._finish(),
    // which OutgoingMessage.end() reaches exactly once — a second end() returns
    // early. `writableEnded` is cno's equivalent guard (see endRequest).
    if (!this.writableEnded && onClientRequestStart.hasSubscribers) {
        onClientRequestStart.publish({ request: this });
    }
    return endRequest(this, chunk, encodingOrCb, cb, HTTP_CLIENT_HOOKS);
};

ClientRequestImpl.prototype.abort = function abort(this: ClientRequestImpl): void {
    abortRequest(this);
};

ClientRequestImpl.prototype.destroy = function destroy(this: ClientRequestImpl, error?: Error): ClientRequestImpl {
    return destroyRequest(this, error);
};

ClientRequestImpl.prototype._cleanup = function _cleanup(this: ClientRequestImpl): void {
    const transport = this._transport;
    const agent = this.agent;
    const canKeepAlive = !!transport
        && !this._aborted
        && this._response?.complete
        && agent
        && typeof agent === 'object'
        && agent.options.keepAlive
        && String(this._response.headers.connection ?? '').toLowerCase() !== 'close'
        && String(this.getHeader('connection') ?? '').toLowerCase() !== 'close';

    if (canKeepAlive) {
        releaseRequestTransport(this);
        agent.freeSocket(transport, this._options);
        this._tcp = null;
        // The keep-alive branch deliberately skips cleanupRequest (the socket is
        // being returned to the pool, not destroyed), so it has to emit the
        // request's terminal 'close' itself or a pooled request never closes.
        queueMicrotask(() => emitRequestClose(this));
        return;
    }

    cleanupRequest(this);
    this._tcp = null;
};

ClientRequestImpl.prototype.onSocket = function onSocket(this: ClientRequestImpl, socket: Socket): void {
    this.socket = socket;
    this._transport = socket;
    this._socketAssigned = true;
    this._tcp = socket._tcp ?? null;
    this.emit('socket', socket);
};

ClientRequestImpl.prototype._implicitHeader = function _implicitHeader(this: ClientRequestImpl): void {
    this._header = formatClientRequestHeader(this);
};

ClientRequestImpl.prototype.flushHeaders = function flushHeaders(this: ClientRequestImpl): void {
    // OutgoingMessage.flushHeaders() only set `headersSent`; on a client it has
    // to actually connect and put the head on the wire.
    startContinueHandshake(this, HTTP_CLIENT_HOOKS);
};

ClientRequestImpl.prototype.setNoDelay = function setNoDelay(this: ClientRequestImpl, noDelay?: boolean): void {
    this.socket?.setNoDelay(noDelay ?? true);
};

ClientRequestImpl.prototype.setSocketKeepAlive = function setSocketKeepAlive(this: ClientRequestImpl, enable?: boolean, initialDelay?: number): void {
    this.socket?.setKeepAlive(enable ?? true, initialDelay ?? 0);
};

ClientRequestImpl.prototype.setTimeout = function setTimeout(this: ClientRequestImpl, timeout: number, callback?: () => void): ClientRequestImpl {
    return setRequestTimeout(this, timeout, callback);
};

ClientRequestImpl.prototype.getRawHeaderNames = function getRawHeaderNames(this: ClientRequestImpl): string[] {
    return [...this._headerNames.values()];
};

Object.defineProperty(ClientRequestImpl.prototype, 'constructor', {
    value: ClientRequestImpl,
    writable: true,
    configurable: true,
});

flattenPrototype(ClientRequestImpl.prototype);

export interface AgentOptions {
    keepAlive?: boolean;
    keepAliveMsecs?: number;
    /** Free-socket idle timeout (ms). Node globalAgent defaults to 5000. */
    timeout?: number;
    /** freeSockets reuse order: lifo (Node default) or fifo. */
    scheduling?: 'lifo' | 'fifo';
    noDelay?: boolean;
    path?: string | null;
    maxSockets?: number;
    maxTotalSockets?: number;
    maxFreeSockets?: number;
}

type AgentSocketTable = Record<string, Socket[]>;
type AgentRequestTable = Record<string, ClientRequestImpl[]>;

function newAgentTable<T>(): Record<string, T[]> {
    return Object.create(null);
}

function getSocketList(table: AgentSocketTable, name: string): Socket[] {
    return table[name] ??= [];
}

function getRequestList(table: AgentRequestTable, name: string): ClientRequestImpl[] {
    return table[name] ??= [];
}

function deleteEmptyList<T>(table: Record<string, T[]>, name: string): void {
    if (table[name]?.length === 0) delete table[name];
}

function isReusableSocket(socket: Socket): boolean {
    return !socket._destroyed && socket.readyState === 'open';
}

/**
 * The options a request was queued under, stashed on the request itself so
 * `agent.requests` keeps Node's exact `name -> ClientRequest[]` shape (user code
 * and tests read it) while a cross-origin pump can still redispatch correctly.
 */
const QUEUED_AGENT_OPTIONS = Symbol('cno.agent.queuedOptions');

export class Agent extends EventEmitter {
    static defaultMaxSockets = Infinity;
    defaultPort: number = 80;
    protocol: string = 'http:';

    options: AgentOptions;
    maxFreeSockets: number = 256;
    maxTotalSockets: number = Infinity;
    maxSockets: number = Infinity;
    sockets: AgentSocketTable = newAgentTable<Socket>();
    freeSockets: AgentSocketTable = newAgentTable<Socket>();
    requests: AgentRequestTable = newAgentTable<ClientRequestImpl>();
    /**
     * Sockets counted across every origin, for maxTotalSockets. Node maintains
     * the same counter; without it maxTotalSockets was assigned and never read.
     */
    totalSocketCount: number = 0;
    private _freeTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
    /**
     * Slots reserved per origin between addRequest() and the connect callback.
     *
     * `sockets[name]` is only appended inside createSocket's async callback, so
     * during a synchronous burst of requests — the normal case for any client
     * that fires N requests in a loop — every one of them read length 0 and
     * sailed past the `< maxSockets` comparison. OBSERVED: maxSockets:2 with 8
     * burst requests reached 8 concurrent server-side, while node held 2 and
     * queued 6. Pacing the same 8 requests 150ms apart DID hold at 2, which is
     * what identified this as a counter-timing bug rather than a dead
     * comparison. Reserving synchronously here closes the window.
     */
    private _pendingByName: Record<string, number> = Object.create(null);
    /** Sockets already counted in totalSocketCount, so release cannot double-count. */
    private _counted = new WeakSet<Socket>();

    constructor(options?: AgentOptions) {
        super();
        // Node Agent merges options onto a null-prototype object; keepAlive stays off
        // unless the caller (or globalAgent) sets it.
        this.options = Object.assign(Object.create(null), options || {}) as AgentOptions;
        if (options?.maxSockets !== undefined) this.maxSockets = options.maxSockets;
        if (options?.maxFreeSockets !== undefined) this.maxFreeSockets = options.maxFreeSockets;
        if (options?.maxTotalSockets !== undefined) this.maxTotalSockets = options.maxTotalSockets;
    }

    // Returns `Socket | null` and may pass null to the callback: a subclass
    // (https.Agent) legitimately fails to produce a socket, and createSocket
    // below already guards on `!socket`. The interface at the top of this file
    // declares the same nullable contract.
    createConnection(options: ClientRequestArgs, callback: (err: Error | null, socket: Socket | null) => void): Socket | null {
        const socket = new Socket();
        const port = typeof options.port === 'string' ? parseInt(options.port) : options.port || this.defaultPort;
        const host = options.hostname || options.host || 'localhost';

        socket.connect(port, host, () => callback(null, socket)).on('error', (err) => callback(err, socket));
        return socket;
    }

    createSocket(req: ClientRequestImpl, options: ClientRequestArgs, callback: (err: Error | null, socket?: Socket) => void): void {
        let done = false;
        const oncreate = (err: Error | null, socket?: Socket | null) => {
            if (done) return;
            done = true;
            callback(err, socket);
        };
        const socket = this.createConnection(options, oncreate);
        if (!socket || done) return;
        if (socket.readyState === 'open' || !socket.connecting) {
            oncreate(null, socket);
            return;
        }
        socket.once('connect', () => oncreate(null, socket));
        socket.once('error', (err) => oncreate(err, socket));
    }

    getName(options: ClientRequestArgs): string {
        // Node's key is `host:port:localAddress:family` — the trailing segments
        // are only appended when set, and `family` is part of the key because a
        // v4 and a v6 connection to the same host:port are NOT interchangeable.
        // cno appended an unconditional trailing ':' after localAddress and
        // dropped `family` entirely, so (a) the key never matched node's and
        // (b) requests differing only by `family` shared one pool entry.
        // OBSERVED: node getName({host:'h',port:8080,family:6}) === "h:8080::6",
        // cno gave "h:8080:". Also node leaves the port segment EMPTY when no
        // port was supplied ("localhost::") rather than substituting
        // defaultPort, and does not fall back to `hostname`.
        let name = options.host || 'localhost';
        name += ':';
        if (options.port) name += options.port;
        name += ':';
        if (options.localAddress) name += options.localAddress;
        if (options.family === 4 || options.family === 6) name += `:${options.family}`;
        return name;
    }

    addRequest(req: ClientRequestImpl, options: ClientRequestArgs): void {
        const name = this.getName(options);
        const sockets = getSocketList(this.sockets, name);
        const freeSockets = getSocketList(this.freeSockets, name);
        const lifo = (this.options.scheduling ?? 'lifo') === 'lifo';

        while (freeSockets.length > 0) {
            const socket = lifo ? freeSockets.pop()! : freeSockets.shift()!;
            this._clearFreeTimer(socket);
            if (!isReusableSocket(socket)) {
                socket.destroy();
                continue;
            }
            sockets.push(socket);
            req.reusedSocket = true;
            this.reuseSocket(socket, req);
            req.onSocket(socket);
            deleteEmptyList(this.freeSockets, name);
            return;
        }
        deleteEmptyList(this.freeSockets, name);

        // Reserve synchronously: `sockets` grows only in the async callback
        // below, so the count must include slots already promised to earlier
        // requests in this same tick or the cap never binds for a burst.
        const pending = this._pendingByName[name] ?? 0;
        const activeForName = sockets.length + pending;
        const totalActive = this.totalSocketCount + this._totalPending();
        if (activeForName < this.maxSockets && totalActive < this.maxTotalSockets) {
            this._pendingByName[name] = pending + 1;
            let released = false;
            const releasePending = () => {
                if (released) return;
                released = true;
                const remaining = (this._pendingByName[name] ?? 1) - 1;
                if (remaining > 0) this._pendingByName[name] = remaining;
                else delete this._pendingByName[name];
            };
            this.createSocket(req, options, (err, assignedSocket) => {
                releasePending();
                if (err) {
                    // The reservation is gone; let a queued request take the slot.
                    this._pumpQueue(name, options);
                    req.emit('error', err);
                } else if (assignedSocket) {
                    req.reusedSocket = false;
                    sockets.push(assignedSocket);
                    this._countSocket(assignedSocket);
                    assignedSocket.once('close', () => this.removeSocket(assignedSocket, options));
                    assignedSocket.once('error', () => this.removeSocket(assignedSocket, options));
                    req.onSocket(assignedSocket);
                } else {
                    this._pumpQueue(name, options);
                }
            });
        } else {
            // Remember the exact options this request was queued under. The
            // caller passes a derived object (host/hostname filled in), so
            // recomputing getName() from req._options at pump time can land on a
            // different key. Stashed on the request to keep `agent.requests`
            // shaped exactly as Node's (name -> ClientRequest[]).
            Reflect.set(req, QUEUED_AGENT_OPTIONS, options);
            getRequestList(this.requests, name).push(req);
        }
    }

    /** Reserved-but-not-yet-connected slots across all origins. */
    private _totalPending(): number {
        let n = 0;
        for (const key of Object.keys(this._pendingByName)) n += this._pendingByName[key] ?? 0;
        return n;
    }

    private _countSocket(socket: Socket): void {
        if (this._counted.has(socket)) return;
        this._counted.add(socket);
        this.totalSocketCount++;
    }

    private _uncountSocket(socket: Socket): void {
        if (!this._counted.has(socket)) return;
        this._counted.delete(socket);
        if (this.totalSocketCount > 0) this.totalSocketCount--;
    }

    /**
     * Hand a freed slot to the next queued request for `name`, then — when a
     * finite maxTotalSockets is in play — to any other origin waiting on the
     * global budget. Without the second pass, a request queued for origin B
     * because the *total* cap was full is never retried when a socket on origin
     * A closes: its own origin's queue is empty, so nothing wakes it and the
     * caller hangs forever. OBSERVED before this pass: the maxTotalSockets=2
     * two-origin probe printed VERDICT HUNG.
     */
    private _pumpQueue(name: string, options: ClientRequestArgs): void {
        const queued = this.requests[name];
        if (queued?.length) {
            const next = queued.shift();
            deleteEmptyList(this.requests, name);
            if (next) {
                this.addRequest(next, (Reflect.get(next, QUEUED_AGENT_OPTIONS) as ClientRequestArgs | undefined) ?? options);
            }
        }
        if (this.maxTotalSockets === Infinity) return;
        for (const otherName of Object.keys(this.requests)) {
            if (otherName === name) continue;
            if (this.totalSocketCount + this._totalPending() >= this.maxTotalSockets) return;
            const list = this.requests[otherName];
            if (!list?.length) continue;
            const next = list.shift();
            deleteEmptyList(this.requests, otherName);
            const queuedOptions = next ? Reflect.get(next, QUEUED_AGENT_OPTIONS) as ClientRequestArgs | undefined : undefined;
            if (next && queuedOptions) this.addRequest(next, queuedOptions);
        }
    }

    keepSocketAlive(socket: Socket): void {
        socket.setKeepAlive(true, this.options.keepAliveMsecs ?? 1000);
    }

    reuseSocket(socket: Socket, request: ClientRequest): void {
        socket.ref();
    }

    freeSocket(socket: Socket, options: ClientRequestArgs): void {
        const name = this.getName(options);
        const sockets = this.sockets[name];
        if (sockets) {
            const index = sockets.indexOf(socket);
            if (index !== -1) sockets.splice(index, 1);
            deleteEmptyList(this.sockets, name);
        }

        const queued = this.requests[name];
        // Only take a queued request once it is certain it can be served. The
        // previous shape shifted unconditionally, so when the socket turned out
        // to be non-reusable the shifted request was dropped on the floor and
        // that caller waited forever; removeSocket's pump would then serve a
        // *different* request, hiding the loss under a partial success.
        const next = isReusableSocket(socket) ? queued?.shift() : undefined;
        deleteEmptyList(this.requests, name);
        if (next && isReusableSocket(socket)) {
            const active = getSocketList(this.sockets, name);
            active.push(socket);
            next.reusedSocket = true;
            this.reuseSocket(socket, next);
            next.onSocket(socket);
            return;
        }

        if (!this.options.keepAlive || !isReusableSocket(socket)) {
            socket.destroy();
            return;
        }

        // A finite total budget must not be held by an idle keep-alive socket
        // while a different origin is queued waiting for it: that origin's own
        // queue is empty, so nothing would ever wake it. Retiring the idle
        // socket releases the slot and its 'close' pumps the waiters.
        if (this.maxTotalSockets !== Infinity && this._hasQueuedOtherThan(name)) {
            socket.destroy();
            return;
        }

        const freeSockets = getSocketList(this.freeSockets, name);
        if (freeSockets.length >= this.maxFreeSockets) {
            socket.destroy();
            deleteEmptyList(this.freeSockets, name);
            return;
        }

        this.keepSocketAlive(socket);
        socket.unref();
        freeSockets.push(socket);
        this._armFreeTimer(socket, options);
        // Node emits 'free' when a socket returns to the pool; user code uses it
        // to observe pool churn. cno never emitted it (OBSERVED 0 vs node's 1).
        this.emit('free', socket, options);
    }

    /** True when some origin other than `name` has requests waiting. */
    private _hasQueuedOtherThan(name: string): boolean {
        for (const other of Object.keys(this.requests)) {
            if (other === name) continue;
            if ((this.requests[other]?.length ?? 0) > 0) return true;
        }
        return false;
    }

    private _clearFreeTimer(socket: Socket): void {
        const t = this._freeTimers.get(socket);
        if (t !== undefined) {
            clearTimeout(t);
            this._freeTimers.delete(socket);
        }
    }

    private _armFreeTimer(socket: Socket, options: ClientRequestArgs): void {
        this._clearFreeTimer(socket);
        const idle = this.options.timeout;
        if (idle === undefined || idle <= 0) return;
        const timer = setTimeout(() => {
            this._freeTimers.delete(socket);
            // Drop idle free socket (Node Agent free-socket timeout).
            const name = this.getName(options);
            const free = this.freeSockets[name];
            if (free) {
                const i = free.indexOf(socket);
                if (i !== -1) free.splice(i, 1);
                deleteEmptyList(this.freeSockets, name);
            }
            if (isReusableSocket(socket) || !socket._destroyed) socket.destroy();
        }, idle);
        // Idle free-socket timer must not keep the event loop alive.
        timer.unref?.();
        this._freeTimers.set(socket, timer);
    }

    removeSocket(socket: Socket, options: ClientRequestArgs): void {
        this._clearFreeTimer(socket);
        // The socket is gone for good (this is the 'close'/'error' path), so it
        // must stop counting against maxTotalSockets or the cap ratchets shut.
        this._uncountSocket(socket);
        const name = this.getName(options);
        const sockets = this.sockets[name];
        if (sockets) {
            const index = sockets.indexOf(socket);
            if (index !== -1) sockets.splice(index, 1);
            deleteEmptyList(this.sockets, name);
        }
        const freeSockets = this.freeSockets[name];
        if (freeSockets) {
            const index = freeSockets.indexOf(socket);
            if (index !== -1) freeSockets.splice(index, 1);
            deleteEmptyList(this.freeSockets, name);
        }
        this._pumpQueue(name, options);
    }

    destroy(): void {
        for (const sockets of Object.values(this.sockets)) {
            for (const socket of sockets) socket.destroy();
        }
        for (const sockets of Object.values(this.freeSockets)) {
            for (const socket of sockets) socket.destroy();
        }
        this.sockets = newAgentTable<Socket>();
        this.freeSockets = newAgentTable<Socket>();
        this.requests = newAgentTable<ClientRequestImpl>();
        this.totalSocketCount = 0;
        this._counted = new WeakSet<Socket>();
        this._pendingByName = Object.create(null);
    }
}

// Node 19+: globalAgent keepAlive defaults on; free sockets idle out after 5s.
export const globalAgent = new Agent({
    keepAlive: true,
    scheduling: 'lifo',
    timeout: 5000,
});

export function request(url: string | URL, options: ClientRequestArgs, callback?: (res: IncomingMessageImpl) => void): ClientRequestImpl;
export function request(options: ClientRequestArgs | string | URL, callback?: (res: IncomingMessageImpl) => void): ClientRequestImpl;
export function request(
    urlOrOptions: ClientRequestArgs | string | URL,
    optionsOrCallback?: ClientRequestArgs | ((res: IncomingMessageImpl) => void),
    callback?: (res: IncomingMessageImpl) => void,
): ClientRequestImpl {
    if ((typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) && optionsOrCallback && typeof optionsOrCallback === 'object') {
        return new ClientRequestImpl(mergeUrlOptions(urlOrOptions, optionsOrCallback), callback);
    }
    return new ClientRequestImpl(urlOrOptions, optionsOrCallback as ((res: IncomingMessageImpl) => void) | undefined);
}

export function get(url: string | URL, options: ClientRequestArgs, callback?: (res: IncomingMessageImpl) => void): ClientRequestImpl;
export function get(options: ClientRequestArgs | string | URL, callback?: (res: IncomingMessageImpl) => void): ClientRequestImpl;
export function get(
    urlOrOptions: ClientRequestArgs | string | URL,
    optionsOrCallback?: ClientRequestArgs | ((res: IncomingMessageImpl) => void),
    callback?: (res: IncomingMessageImpl) => void,
): ClientRequestImpl {
    const req = (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) && optionsOrCallback && typeof optionsOrCallback === 'object'
        ? request(urlOrOptions, optionsOrCallback, callback)
        : request(urlOrOptions, optionsOrCallback as ((res: IncomingMessageImpl) => void) | undefined);
    req.end();
    return req;
}
