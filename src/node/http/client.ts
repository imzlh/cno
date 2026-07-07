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
    endRequest,
    initClientRequestState,
    mergeUrlOptions,
    normalizeRequestOptions,
    releaseRequestTransport,
    setRequestTimeout,
    writeRequest,
} from '../_internal/http-client';
import { EventEmitter } from '../events';
import { Socket } from '../net';
import { IncomingMessageImpl, OutgoingMessageImpl } from './server';

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
    maxHeadersCount: number;
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
    defaultUserAgent: 'Node.js/http',
    defaultAcceptEncoding: 'identity',
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
    self.maxHeadersCount = 2000;
    self._tcp = null;
    self._socketAssigned = false;
    self._response = null;

    self._options = typeof url === 'string' || url instanceof URL
        ? mergeUrlOptions<ClientRequestArgs>(url)
        : normalizeRequestOptions(url);

    self.method = self._options.method?.toUpperCase() || 'GET';
    self.path = self._options.path || '/';
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
    if (
        !self._userConnectionHeader &&
        self.agent &&
        typeof self.agent === 'object' &&
        self.agent.options.keepAlive
    ) {
        self.setHeader('Connection', 'keep-alive');
    }
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
    this._header = `${this.method} ${this.path} HTTP/1.1\r\n${this._formatHeaders()}\r\n`;
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
    maxSockets?: number;
    maxTotalSockets?: number;
    maxFreeSockets?: number;
    scheduling?: 'lifo' | 'fifo';
    timeout?: number;
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

    constructor(options?: AgentOptions) {
        super();
        this.options = options || {};
        if (options?.maxSockets !== undefined) this.maxSockets = options.maxSockets;
        if (options?.maxFreeSockets !== undefined) this.maxFreeSockets = options.maxFreeSockets;
        if (options?.maxTotalSockets !== undefined) this.maxTotalSockets = options.maxTotalSockets;
    }

    createConnection(options: ClientRequestArgs, callback: (err: Error | null, socket: Socket) => void): Socket {
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
        let name = `${options.host || options.hostname || 'localhost'}:${options.port || this.defaultPort}:`;
        if (options.localAddress) name += `${options.localAddress}:`;
        return name;
    }

    addRequest(req: ClientRequestImpl, options: ClientRequestArgs): void {
        const name = this.getName(options);
        const sockets = getSocketList(this.sockets, name);
        const freeSockets = getSocketList(this.freeSockets, name);

        while (freeSockets.length > 0) {
            const socket = freeSockets.shift()!;
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

        if (sockets.length < this.maxSockets) {
            this.createSocket(req, options, (err, assignedSocket) => {
                if (err) req.emit('error', err);
                else if (assignedSocket) {
                    req.reusedSocket = false;
                    sockets.push(assignedSocket);
                    assignedSocket.once('close', () => this.removeSocket(assignedSocket, options));
                    assignedSocket.once('error', () => this.removeSocket(assignedSocket, options));
                    req.onSocket(assignedSocket);
                }
            });
        } else {
            getRequestList(this.requests, name).push(req);
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
        const next = queued?.shift();
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

        const freeSockets = getSocketList(this.freeSockets, name);
        if (freeSockets.length >= this.maxFreeSockets) {
            socket.destroy();
            deleteEmptyList(this.freeSockets, name);
            return;
        }

        this.keepSocketAlive(socket);
        socket.unref();
        freeSockets.push(socket);
    }

    removeSocket(socket: Socket, options: ClientRequestArgs): void {
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
        const queued = this.requests[name];
        if (queued?.length) {
            const next = queued.shift();
            deleteEmptyList(this.requests, name);
            if (next) this.addRequest(next, options);
        }
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
    }
}

export const globalAgent = new Agent();

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
