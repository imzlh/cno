/**
 * Node.js https module
 * Reuses http server/client architecture with TLS (TLSSocket) wrapping
 */

import { EventEmitter } from '../events';
import { flattenPrototype } from '../_internal/prototype';
import {
    TLSSocket,
    Server as TlsServer,
    SecureContext,
    connect as connectSecureSocket,
    createSecureContext,
    getCiphers,
} from '../tls';
import type { TlsOptions, TlsServerOptions, PeerCertificate } from '../tls';
import {
    applyRequestCommonOptions,
    type AgentLike,
    type ClientHooks,
    type ClientRequestState,
    abortRequest,
    cleanupRequest,
    connectRequest,
    connectRequestWithAgent,
    connectSecureTransport,
    destroyRequest,
    emitRequestClose,
    endRequest,
    initClientRequestState,
    mergeUrlOptions,
    normalizeClientRequestArgs,
    normalizeRequestOptions,
    releaseRequestTransport,
    setRequestTimeout,
    writeRequest,
    formatClientRequestHeader,
} from '../_internal/http-client';
import {
    createServerRequestObjects,
    IncomingMessageImpl,
    OutgoingMessageImpl,
    ServerResponseImpl,
    METHODS as HTTP_METHODS,
    STATUS_CODES,
    validateRequestMethod,
    validateRequestPath,
} from '../http/server';
import { Agent as HttpAgent } from '../http/client';
import type { AgentOptions, ClientRequestArgs } from '../http/client';
import type { Socket } from '../net';
import type { ListenOptions as NetListenOptions } from '../net';
import {
    getNodeServeHook,
    nodeTs,
} from '../_internal/network-debug';
import { ServerResponseAdapter } from '../_internal/server-response-adapter';
import { isTransportDisconnectError, normalizeErrnoError } from '../_internal/errno';
import { arrayBufferBackedBytes } from '../_internal/buffer';
import { dispatchServerRequest } from '../_internal/server-request-runtime';
import { createServerRequestParser, type ParsedServerRequest } from '../_internal/server-request-parser';
import {
    anyClientChannelActive,
    instrumentClientRequest,
    onClientRequestCreated,
    onClientRequestStart,
    onServerRequestStart,
    onServerResponseCreated,
    onServerResponseFinish,
} from '../diagnostics_channel/builtins';
import {
    encodeResponseHead,
    encodeChunkedFrame,
    encodeChunkedTrailer,
    shouldCloseAfterResponse,
} from '@cnojs/http/h1-frame';

function writeTlsChunk(socket: TLSSocket, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.write(data, (err?: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function endTlsSocket(socket: TLSSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.end((err?: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function shouldCloseServerConnection(incoming: IncomingMessageImpl): boolean {
    const ver = `${incoming.httpVersionMajor}.${incoming.httpVersionMinor}`;
    return shouldCloseAfterResponse(ver, String(incoming.headers['connection'] ?? ''));
}

class TlsResponseAdapter extends ServerResponseAdapter<ServerResponseImpl> {
    constructor(
        response: ServerResponseImpl,
        socket: TLSSocket,
        serveHook: ReturnType<typeof getNodeServeHook>,
        requestId: string,
        requestUrl: string,
        suppressBody = false,
        closeAfterResponse = false,
        responseTurn: Promise<void> = Promise.resolve(),
        releaseResponseTurn?: () => void,
    ) {
        // Turn is released only from finish/abort — never from normalizeError
        // (normalize runs on every fault and must stay pure).
        let turnReleased = false;
        const releaseTurn = () => {
            if (turnReleased) return;
            turnReleased = true;
            releaseResponseTurn?.();
        };
        super(response, {
            closeSource: socket,
            writeHead: async (res, headers) => {
                await responseTurn;
                const ver = `${res.req?.httpVersionMajor ?? 1}.${res.req?.httpVersionMinor ?? 1}`;
                await writeTlsChunk(socket, encodeResponseHead(
                    ver,
                    res.statusCode,
                    res.statusMessage || 'OK',
                    headers,
                ));
            },
            writeInformational: async (res, status, statusText, headers) => {
                await responseTurn;
                const ver = `${res.req?.httpVersionMajor ?? 1}.${res.req?.httpVersionMinor ?? 1}`;
                await writeTlsChunk(socket, encodeResponseHead(ver, status, statusText, headers));
            },
            writeBody: async (res, data) => {
                await responseTurn;
                const bytes = arrayBufferBackedBytes(data);
                if (res.chunkedEncoding) {
                    await writeTlsChunk(socket, encodeChunkedFrame(bytes));
                    return;
                }
                await writeTlsChunk(socket, bytes);
            },
            finish: async (res) => {
                await responseTurn;
                try {
                    if (res.chunkedEncoding) {
                        await writeTlsChunk(socket, encodeChunkedTrailer());
                    }
                    if (closeAfterResponse) {
                        await endTlsSocket(socket);
                    }
                } finally {
                    if (res.socket) {
                        res.detachSocket(res.socket);
                    }
                    releaseTurn();
                }
            },
            abort: () => {
                releaseTurn();
                try { socket.destroy(); } catch { /* already closed */ }
            },
            normalizeError: normalizeErrnoError,
        }, serveHook, requestId, requestUrl, suppressBody);

        if (closeAfterResponse && !response.hasHeader('connection')) {
            response.setHeader('Connection', 'close');
        } else if (!closeAfterResponse) {
            if (!response.hasHeader('connection')) {
                response.setHeader('Connection', 'keep-alive');
            }
            // Match node:http Keep-Alive: timeout=<sec> (default 5s).
            if (!response.hasHeader('keep-alive')) {
                response.setHeader('Keep-Alive', 'timeout=5');
            }
        }
    }
}

// HTTPS Server

export interface HttpsServerOptions extends TlsServerOptions {
    allowHalfOpen?: boolean;
    requestCert?: boolean;
    rejectUnauthorized?: boolean;
}

type HttpsRequestListener = (req: IncomingMessageImpl, res: ServerResponseImpl) => void;
type ServerListenArgs =
    | [port?: number, hostname?: string, backlog?: number, listeningListener?: () => void]
    | [port?: number, hostname?: string, listeningListener?: () => void]
    | [port?: number, backlog?: number, listeningListener?: () => void]
    | [path: string, backlog?: number, listeningListener?: () => void]
    | [options: NetListenOptions, listeningListener?: () => void]
    | [handle: unknown, backlog?: number, listeningListener?: () => void];

export interface Server extends EventEmitter {
    _tlsServer: TlsServer;
    _requestListener: HttpsRequestListener | null;
    _timeout: number;
    _timeoutCallback: ((socket: TLSSocket) => void) | null;
    _httpsConnections: Set<HttpsConnectionState>;

    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this;
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    listen(port?: number, backlog?: number, listeningListener?: () => void): this;
    listen(path: string, backlog?: number, listeningListener?: () => void): this;
    listen(options: NetListenOptions, listeningListener?: () => void): this;
    listen(handle: unknown, backlog?: number, listeningListener?: () => void): this;

    close(callback?: (err?: Error) => void): this;
    closeAllConnections(): void;
    closeIdleConnections(): void;
    address(): { address: string; family: string; port: number } | string | null;
    readonly listening: boolean;
    ref(): this;
    unref(): this;
    setTimeout(msecs: number, callback?: (socket: TLSSocket) => void): this;
}

interface HttpsConnectionState {
    socket: TLSSocket;
    activeRequests: number;
    draining: boolean;
}

export interface ServerConstructor {
    new (options?: HttpsServerOptions, requestListener?: HttpsRequestListener): Server;
    new (requestListener?: HttpsRequestListener): Server;
    (options?: HttpsServerOptions, requestListener?: HttpsRequestListener): Server;
    (requestListener?: HttpsRequestListener): Server;
    prototype: Server;
}

function normalizeServerOptions(
    optionsOrListener?: HttpsServerOptions | HttpsRequestListener,
    requestListener?: HttpsRequestListener,
): { options: HttpsServerOptions; requestListener: HttpsRequestListener | null } {
    if (typeof optionsOrListener === 'function') {
        return { options: {}, requestListener: optionsOrListener };
    }
    return {
        options: optionsOrListener || {},
        requestListener: requestListener || null,
    };
}

function dispatchHttpsServerRequest(
    self: Server,
    tlsSocket: TLSSocket,
    incoming: IncomingMessageImpl,
    response: ServerResponseImpl,
    serveHook: ReturnType<typeof getNodeServeHook>,
    meta: ParsedServerRequest,
    responseTurn?: Promise<void>,
    releaseResponseTurn?: () => void,
): Promise<void> {
    const listener = self._requestListener;
    if (!listener) return Promise.resolve();

    const adapter = new TlsResponseAdapter(
        response,
        tlsSocket,
        serveHook,
        meta.requestId,
        meta.requestUrl,
        incoming.method === 'HEAD',
        shouldCloseServerConnection(incoming),
        responseTurn,
        releaseResponseTurn,
    );
    // dispatchServerRequest never rejects disconnects; only surface real faults.
    if (onServerRequestStart.hasSubscribers) {
        onServerRequestStart.publish({ request: incoming, response, socket: tlsSocket, server: self });
    }
    if (onServerResponseFinish.hasSubscribers) {
        response.once('finish', () => {
            onServerResponseFinish.publish({ request: incoming, response, socket: tlsSocket, server: self });
        });
    }
    return dispatchServerRequest({
        listener,
        incoming,
        response,
        adapter,
        serveHook,
        requestId: meta.requestId,
        timestamp: nodeTs(),
        url: meta.requestUrl,
        method: incoming.method || 'GET',
        headers: meta.requestHeaders,
        postData: meta.postData,
        callFrames: meta.requestCallFrames,
        onError: (err) => {
            if (isTransportDisconnectError(err)) return;
            self.emit('error', err);
        },
    });
}

function maybeCloseHttpsConnection(state: HttpsConnectionState): void {
    if (state.draining && state.activeRequests === 0) {
        try { state.socket.destroy(); } catch { /* already closed */ }
    }
}

function handleHttpsServerConnection(self: Server, tlsSocket: TLSSocket): void {
    if (!self._requestListener) return;

    const state: HttpsConnectionState = { socket: tlsSocket, activeRequests: 0, draining: false };
    self._httpsConnections.add(state);
    tlsSocket.once('close', () => self._httpsConnections.delete(state));

    const serveHook = getNodeServeHook();
    const responses = new WeakMap<IncomingMessageImpl, ServerResponseImpl>();
    let responseTurn = Promise.resolve();

    const parser = createServerRequestParser({
        createIncoming: () => {
            const timeoutCallback = self._timeoutCallback;
            const { incoming, response } = createServerRequestObjects(
                tlsSocket,
                self._timeout,
                timeoutCallback ? () => timeoutCallback(tlsSocket) : undefined,
            );
            responses.set(incoming, response);
            return incoming;
        },
        protocol: 'https:',
        requestIdPrefix: 'https-serve',
        onRequest: (incoming, meta) => {
            const response = responses.get(incoming);
            responses.delete(incoming);
            if (!response) return;

            const { promise: responseTurnDone, resolve: releaseResponseTurn } = Promise.withResolvers<void>();
            const currentResponseTurn = responseTurn;
            responseTurn = responseTurn.then(() => responseTurnDone, () => responseTurnDone);

            // Published here rather than in createIncoming(): the parser only
            // fills in method/url by the time onRequest fires, and Node's
            // payload carries a populated IncomingMessage.
            if (onServerResponseCreated.hasSubscribers) {
                onServerResponseCreated.publish({ request: incoming, response });
            }

            state.activeRequests++;
            void dispatchHttpsServerRequest(
                self, tlsSocket, incoming, response, serveHook, meta,
                currentResponseTurn, releaseResponseTurn,
            ).finally(() => {
                state.activeRequests--;
                maybeCloseHttpsConnection(state);
            });
        },
        onParseError: (err) => {
            self.emit('clientError', err, tlsSocket);
            tlsSocket.destroy(err);
        },
    });

    tlsSocket.on('data', (chunk: Uint8Array) => {
        parser.feed(arrayBufferBackedBytes(chunk));
    });
}

function initServer(
    self: Server,
    optionsOrListener?: HttpsServerOptions | HttpsRequestListener,
    requestListener?: HttpsRequestListener,
): void {
    EventEmitter.call(self);

    self._requestListener = null;
    self._timeout = 0;
    self._timeoutCallback = null;
    self._httpsConnections = new Set();

    const normalized = normalizeServerOptions(optionsOrListener, requestListener);
    const options = normalized.options;
    self._requestListener = normalized.requestListener;

    self._tlsServer = new TlsServer(options, (tlsSocket: TLSSocket) => {
        handleHttpsServerConnection(self, tlsSocket);
    });

    self._tlsServer.on('listening', () => self.emit('listening'));
    self._tlsServer.on('close', () => self.emit('close'));
    self._tlsServer.on('error', (err: Error) => self.emit('error', err));
    self._tlsServer.on('tlsClientError', (err: Error, socket: TLSSocket) => self.emit('tlsClientError', err, socket));
}

export const Server: ServerConstructor = function Server(
    this: Server | undefined,
    optionsOrListener?: HttpsServerOptions | HttpsRequestListener,
    requestListener?: HttpsRequestListener,
) {
    const target: Server = this ?? Object.create(Server.prototype);
    initServer(target, optionsOrListener, requestListener);
    return target;
} as ServerConstructor;

Object.setPrototypeOf(Server, EventEmitter);
Server.prototype = Object.create(EventEmitter.prototype);

Server.prototype.listen = function listen(this: Server, ...args: ServerListenArgs): Server {
    // Narrow the union tuple before forwarding so TypeScript can select a
    // concrete TLS server overload while preserving every supported form.
    const [first, ...rest] = args as [unknown, ...Array<string | number | (() => void)>];
    if (typeof first === 'number') this._tlsServer.listen(first, ...rest as []);
    else if (typeof first === 'string') this._tlsServer.listen(first, ...rest as []);
    else this._tlsServer.listen(first as NetListenOptions, ...rest as []);
    return this;
};

Server.prototype.close = function close(this: Server, callback?: (err?: Error) => void): Server {
    for (const state of this._httpsConnections) {
        state.draining = true;
        maybeCloseHttpsConnection(state);
    }
    // A TLS handshake that has not emitted `secureConnection` has no HTTP
    // state to drain; close it so server.close cannot wait indefinitely.
    for (const socket of this._tlsServer._connections) {
        if (![...this._httpsConnections].some(state => state.socket === socket)) {
            try { socket.destroy(); } catch { /* already closed */ }
        }
    }
    this._tlsServer.closeGracefully(callback);
    return this;
};

Server.prototype.closeAllConnections = function closeAllConnections(this: Server): void {
    for (const state of this._httpsConnections) {
        try { state.socket.destroy(); } catch { /* already closed */ }
    }
    this._httpsConnections.clear();
};

Server.prototype.closeIdleConnections = function closeIdleConnections(this: Server): void {
    for (const state of this._httpsConnections) {
        if (state.activeRequests === 0) {
            try { state.socket.destroy(); } catch { /* already closed */ }
        }
    }
};

Server.prototype.address = function address(this: Server): { address: string; family: string; port: number } | string | null {
    return this._tlsServer.address();
};

Object.defineProperty(Server.prototype, 'listening', {
    get(this: Server): boolean {
        return this._tlsServer.listening;
    },
    configurable: true,
});

Server.prototype.ref = function ref(this: Server): Server {
    this._tlsServer.ref();
    return this;
};

Server.prototype.unref = function unref(this: Server): Server {
    this._tlsServer.unref();
    return this;
};

Server.prototype.setTimeout = function setTimeout(this: Server, msecs: number, callback?: (socket: TLSSocket) => void): Server {
    this._timeout = msecs;
    this._timeoutCallback = callback ?? null;
    return this;
};

Object.defineProperty(Server.prototype, 'constructor', {
    value: Server,
    writable: true,
    configurable: true,
});

flattenPrototype(Server.prototype);

export function createServer(options?: HttpsServerOptions, requestListener?: HttpsRequestListener): Server;
export function createServer(requestListener?: HttpsRequestListener): Server;
export function createServer(optionsOrListener?: HttpsServerOptions | HttpsRequestListener, requestListener?: HttpsRequestListener): Server {
    // Narrow to one ServerConstructor overload — TS cannot pick one for a union
    // argument, though the constructor accepts both shapes at runtime.
    return typeof optionsOrListener === 'function'
        ? new Server(optionsOrListener)
        : new Server(optionsOrListener, requestListener);
}

// HTTPS Agent

interface HttpsRequestOptions extends ClientRequestArgs, AgentOptions {
    ca?: TlsOptions['ca'];
    cert?: TlsOptions['cert'];
    key?: TlsOptions['key'];
    rejectUnauthorized?: boolean;
    servername?: string;
    ciphers?: string;
}

export class Agent extends HttpAgent {
    defaultPort: number = 443;
    protocol: string = 'https:';

    constructor(options?: HttpsRequestOptions) {
        super(options);
        // HttpAgent's public pool implementation is reused, but its declared
        // connection factory is specialized to a plain Socket. Install the TLS
        // factory at the runtime extension point instead of narrowing an
        // inherited method, which is unsound under strict function variance.
        this.createConnection = this.createTlsConnection as HttpAgent['createConnection'];
    }

    private createTlsConnection(options: HttpsRequestOptions, callback: (err: Error | null, socket: TLSSocket | null) => void): TLSSocket | null {
        // Node merges the agent's constructor options under the per-request
        // ones. Reading only `options` meant every TLS setting passed to
        // `new https.Agent({...})` — ca, cert, key, rejectUnauthorized,
        // ciphers, servername — was silently dropped: an agent configured with
        // a private CA failed to verify, and one configured with
        // rejectUnauthorized:false still rejected.
        const agentOptions = (this as unknown as { options?: HttpsRequestOptions }).options ?? {};
        // Object spread copies keys whose value is `undefined`, so a per-request
        // option that is merely *present* and undefined erased the agent's value:
        // `{ ...{ca: PEM}, ...{ca: undefined} }` yields `{ca: undefined}`. Real
        // clients hit this constantly — `got` always sends a full option bag with
        // ca/cert/key/passphrase/pfx/minVersion present and undefined, so
        // `got(url, {agent: {https: new https.Agent({ca})}})` lost the CA and
        // failed with UNABLE_TO_GET_ISSUER_CERT_LOCALLY while Node succeeded.
        // Only defined values may override the agent's configuration.
        const merged: HttpsRequestOptions = { ...agentOptions };
        for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
            if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
        }
        const port = typeof merged.port === 'string' ? parseInt(merged.port) : merged.port || 443;
        const host = merged.hostname || merged.host || 'localhost';
        const rejectUnauthorized = merged.rejectUnauthorized ?? true;
        const servername = merged.servername ?? host;
        let done = false;

        const finish = (err: Error | null, socket: TLSSocket | null = null) => {
            if (done) return;
            done = true;
            callback(err, socket);
        };

        (async () => {
            // No getSystemCa() here: it returns a file PATH, and `ca` is PEM
            // text, so passing it made the SecureContext constructor throw and
            // every agent-backed https request (i.e. all keep-alive traffic)
            // failed. tls's SecureContext already falls back to the platform
            // trust store when `ca` is absent.
            const tlsSocket = connectSecureSocket({
                ...merged,
                // ClientRequestArgs permits null for Node HTTP option parity,
                // while the TLS connector accepts only a string or undefined.
                path: merged.path ?? undefined,
                port,
                host,
                servername,
                rejectUnauthorized,
                noDelay: true,
            });
            tlsSocket.once('secureConnect', () => finish(null, tlsSocket));
            tlsSocket.once('error', (err: Error) => finish(err));
        })().catch((err: Error) => finish(err));

        return null;
    }
}

// Match node:http globalAgent (keepAlive on, 5s free-socket idle).
export const globalAgent = new Agent({
    keepAlive: true,
    scheduling: 'lifo',
    timeout: 5000,
});

// HTTPS Client Request

export interface RequestOptions extends HttpsRequestOptions {}

interface HttpsClientRequest extends OutgoingMessageImpl, ClientRequestState<TLSSocket> {
    aborted: boolean;
    agent: HttpAgent | boolean;
    host: string;
    protocol: string;
    method: string;
    path: string;
    // Narrows both bases: OutgoingMessage allows any MessageSocket, the shared
    // client state is transport-generic; an https request is always TLS.
    socket: TLSSocket | null;
    onSocket(socket: TLSSocket): void;

    _tlsSocket: TLSSocket | null;
    _options: RequestOptions;
    _callback: ((res: IncomingMessageImpl) => void) | null;
    _aborted: boolean;
    _timeoutId: number | null;
    _requestBody: ClientRequestState<TLSSocket>['_requestBody'];
    _bodySent: boolean;
    _tcp: CModuleStreams.TCP | null;
    _response: IncomingMessageImpl | null;
    _requestId: string;
    _requestCallFrames: ClientRequestState<TLSSocket>['_requestCallFrames'];
    _abortHandler: (() => void) | null;
    _streamedBeforeEnd: boolean;
    _sendChain: Promise<void>;
    _chunkedEncoding: boolean;
    _headerFlushStarted: boolean;
    _header: string | null;
    outputData: Array<{ data: string }>;
    _connectPromise: Promise<void> | null;
    _streamErrored: boolean;
    _transport: TLSSocket | null;
    _transportCleanup: (() => void) | null;
    _userConnectionHeader: boolean;
    _connect(): Promise<void>;
    _implicitHeader(): void;
}

interface HttpsClientRequestConstructor {
    new (url: string | URL | RequestOptions, cb?: (res: IncomingMessageImpl) => void): HttpsClientRequest;
    (url: string | URL | RequestOptions, cb?: (res: IncomingMessageImpl) => void): HttpsClientRequest;
    prototype: HttpsClientRequest;
}

const HTTPS_CLIENT_HOOKS: ClientHooks<HttpsClientRequest> = {
    defaultPort: 443,
    // Node https client: Host only by default (no User-Agent).
    defaultUserAgent: '',
    requestIdPrefix: 'https-fetch',
    waitForSecureConnect: true,
    createIncomingMessage: (socket) => new IncomingMessageImpl(socket),
    connect: (request) => connectSecureTransport(request, 443),
    onTransportAssigned: (request, transport) => {
        request._tlsSocket = transport as TLSSocket;
        request._tcp = null;
    },
};

function initHttpsClientRequest(self: HttpsClientRequest, url: string | URL | RequestOptions, cb?: (res: IncomingMessageImpl) => void): void {
    OutgoingMessageImpl.call(self);
    initClientRequestState(self, cb);

    self._tlsSocket = null;
    self._tcp = null;
    self._options = typeof url === 'string' || url instanceof URL
        ? mergeUrlOptions<RequestOptions>(url)
        : normalizeRequestOptions(url);

    if (self._options.method !== undefined) validateRequestMethod(self._options.method);
    self.method = self._options.method?.toUpperCase() || 'GET';
    self.path = self._options.path || '/';
    validateRequestPath(self.path);
    self.host = self._options.hostname || self._options.host || 'localhost';
    self.protocol = 'https:';
    self.agent = self._options.agent ?? globalAgent;

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
    const agentKeepAlive = !!(
        self.agent &&
        typeof self.agent === 'object' &&
        self.agent.options?.keepAlive
    );
    self.shouldKeepAlive = agentKeepAlive;

    // Node's https.request returns a plain http.ClientRequest, so the same four
    // http.client.* channels apply to https unchanged.
    if (anyClientChannelActive()) {
        instrumentClientRequest(self);
        if (onClientRequestCreated.hasSubscribers) {
            onClientRequestCreated.publish({ request: self });
        }
    }
}

const HttpsClientRequest: HttpsClientRequestConstructor = function HttpsClientRequest(
    this: HttpsClientRequest | undefined,
    url: string | URL | RequestOptions,
    cb?: (res: IncomingMessageImpl) => void
) {
    const target: HttpsClientRequest = this ?? Object.create(HttpsClientRequest.prototype);
    initHttpsClientRequest(target, url, cb);
    return target;
} as HttpsClientRequestConstructor;

Object.setPrototypeOf(HttpsClientRequest, OutgoingMessageImpl);
HttpsClientRequest.prototype = Object.create(OutgoingMessageImpl.prototype);

HttpsClientRequest.prototype._connect = function _connect(this: HttpsClientRequest): Promise<void> {
    if (this.agent && typeof this.agent === 'object' && typeof this.agent.addRequest === 'function') {
        return connectRequestWithAgent(this, HTTPS_CLIENT_HOOKS, this.agent as unknown as AgentLike<HttpsClientRequest>);
    }
    return connectRequest(this, HTTPS_CLIENT_HOOKS);
};

HttpsClientRequest.prototype.onSocket = function onSocket(this: HttpsClientRequest, socket: TLSSocket): void {
    this.socket = socket;
    this._transport = socket;
    this._tlsSocket = socket;
    this._tcp = null;
    this.emit('socket', socket);
};

HttpsClientRequest.prototype._implicitHeader = function _implicitHeader(this: HttpsClientRequest): void {
    this._header = formatClientRequestHeader(this);
};

HttpsClientRequest.prototype.write = function write(this: HttpsClientRequest, chunk: unknown, encodingOrCb?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void): boolean {
    return writeRequest(this, chunk, encodingOrCb, cb, HTTPS_CLIENT_HOOKS);
};

HttpsClientRequest.prototype.end = function end(this: HttpsClientRequest, chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): HttpsClientRequest {
    if (!this.writableEnded && onClientRequestStart.hasSubscribers) {
        onClientRequestStart.publish({ request: this });
    }
    return endRequest(this, chunk, encodingOrCb, cb, HTTPS_CLIENT_HOOKS) as HttpsClientRequest;
};

HttpsClientRequest.prototype.abort = function abort(this: HttpsClientRequest): void {
    abortRequest(this);
};

HttpsClientRequest.prototype.destroy = function destroy(this: HttpsClientRequest, error?: Error): HttpsClientRequest {
    return destroyRequest(this, error) as HttpsClientRequest;
};

HttpsClientRequest.prototype.setTimeout = function setTimeout(this: HttpsClientRequest, timeout: number, callback?: () => void): HttpsClientRequest {
    return setRequestTimeout(this, timeout, callback) as HttpsClientRequest;
};

HttpsClientRequest.prototype._cleanup = function _cleanup(this: HttpsClientRequest): void {
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
        agent.freeSocket(transport as unknown as Socket, { ...this._options, host: this.host });
        this._tlsSocket = null;
        this._tcp = null;
        queueMicrotask(() => emitRequestClose(this));
        return;
    }

    cleanupRequest(this);
    this._tlsSocket = null;
    this._tcp = null;
};

Object.defineProperty(HttpsClientRequest.prototype, 'constructor', {
    value: HttpsClientRequest,
    writable: true,
    configurable: true,
});

flattenPrototype(HttpsClientRequest.prototype);

export function request(url: string | URL, options: RequestOptions, callback?: (res: IncomingMessageImpl) => void): HttpsClientRequest;
export function request(options: RequestOptions | string | URL, callback?: (res: IncomingMessageImpl) => void): HttpsClientRequest;
export function request(
    urlOrOptions: RequestOptions | string | URL,
    optionsOrCallback?: RequestOptions | ((res: IncomingMessageImpl) => void),
    callback?: (res: IncomingMessageImpl) => void,
): HttpsClientRequest {
    const args = normalizeClientRequestArgs<RequestOptions, IncomingMessageImpl>(
        urlOrOptions,
        optionsOrCallback,
        callback,
    );
    return new HttpsClientRequest(...args);
}

export function get(url: string | URL, options: RequestOptions, callback?: (res: IncomingMessageImpl) => void): HttpsClientRequest;
export function get(options: RequestOptions | string | URL, callback?: (res: IncomingMessageImpl) => void): HttpsClientRequest;
export function get(
    urlOrOptions: RequestOptions | string | URL,
    optionsOrCallback?: RequestOptions | ((res: IncomingMessageImpl) => void),
    callback?: (res: IncomingMessageImpl) => void,
): HttpsClientRequest {
    const req = (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) && optionsOrCallback && typeof optionsOrCallback === 'object'
        ? request(urlOrOptions, optionsOrCallback, callback)
        : request(urlOrOptions, optionsOrCallback as ((res: IncomingMessageImpl) => void) | undefined);
    req.end();
    return req;
}

// Re-exports from tls

export {
    TLSSocket,
    SecureContext,
    createSecureContext,
    getCiphers,
};
export type { PeerCertificate, TlsServerOptions };
export const METHODS = HTTP_METHODS;
export { STATUS_CODES };

// Default export

export default {
    Agent,
    globalAgent,
    METHODS,
    STATUS_CODES,
    Server,
    createServer,
    request,
    get,
    getAgent: () => globalAgent,
    TLSSocket,
    SecureContext,
    createSecureContext,
    getCiphers,
};
