/**
 * Node.js https module
 * Reuses http server/client architecture with TLS (TLSSocket) wrapping
 */

import { EventEmitter } from '../events';
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
    type ClientHooks,
    type ClientRequestState,
    abortRequest,
    cleanupRequest,
    connectRequest,
    connectRequestWithAgent,
    connectSecureTransport,
    destroyRequest,
    endRequest,
    initClientRequestState,
    mergeUrlOptions,
    normalizeRequestOptions,
    setRequestTimeout,
    writeRequest,
    formatClientRequestHeader,
} from '../_internal/http-client';
import {
    createServerRequestObjects,
    createHeadersSentError,
    createWriteAfterEndError,
    IncomingMessageImpl,
    isBodyForbiddenStatus,
    OutgoingMessageImpl,
    ServerResponseImpl,
    METHODS as HTTP_METHODS,
    STATUS_CODES,
    validateRequestMethod,
    validateRequestPath,
} from '../http/server';
import { Agent as HttpAgent } from '../http/client';
import type { ClientRequestArgs } from '../http/client';
import type { ListenOptions as NetListenOptions } from '../net';
import {
    getNodeServeHook,
    nodeTs,
} from '../_internal/network-debug';
import { ServerResponseAdapter } from '../_internal/server-response-adapter';
import { isTransportDisconnectError, normalizeErrnoError } from '../_internal/errno';
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
            writeBody: async (res, data) => {
                await responseTurn;
                if (res.chunkedEncoding) {
                    await writeTlsChunk(socket, encodeChunkedFrame(data));
                    return;
                }
                await writeTlsChunk(socket, data);
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
                    releaseTurn();
                }
            },
            abort: () => {
                releaseTurn();
                try { socket.destroy(); } catch { /* already closed */ }
            },
            normalizeError: (err) => normalizeErrnoError(err),
        }, serveHook, {
            isBodyForbiddenStatus,
            createHeadersSentError,
            createWriteAfterEndError,
        }, requestId, requestUrl, suppressBody);

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

    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this;
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    listen(port?: number, backlog?: number, listeningListener?: () => void): this;
    listen(path: string, backlog?: number, listeningListener?: () => void): this;
    listen(options: NetListenOptions, listeningListener?: () => void): this;
    listen(handle: unknown, backlog?: number, listeningListener?: () => void): this;

    close(callback?: (err?: Error) => void): this;
    address(): { address: string; family: string; port: number } | string | null;
    readonly listening: boolean;
    ref(): this;
    unref(): this;
    setTimeout(msecs: number, callback?: (socket: TLSSocket) => void): this;
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
    // runServerRequest never rejects disconnects; only surface real faults.
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

function handleHttpsServerConnection(self: Server, tlsSocket: TLSSocket): void {
    if (!self._requestListener) return;

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

            dispatchHttpsServerRequest(self, tlsSocket, incoming, response, serveHook, meta, currentResponseTurn, releaseResponseTurn);
        },
        onParseError: (err) => {
            self.emit('clientError', err, tlsSocket);
            tlsSocket.destroy(err);
        },
    });

    tlsSocket.on('data', (chunk: Uint8Array) => {
        parser.feed(chunk);
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
    this._tlsServer.listen(...args);
    return this;
};

Server.prototype.close = function close(this: Server, callback?: (err?: Error) => void): Server {
    this._tlsServer.close(callback);
    return this;
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

interface HttpsRequestOptions extends ClientRequestArgs {
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

    createConnection(options: HttpsRequestOptions, callback: (err: Error | null, socket: TLSSocket | null) => void): TLSSocket | null {
        // Node merges the agent's constructor options under the per-request
        // ones. Reading only `options` meant every TLS setting passed to
        // `new https.Agent({...})` — ca, cert, key, rejectUnauthorized,
        // ciphers, servername — was silently dropped: an agent configured with
        // a private CA failed to verify, and one configured with
        // rejectUnauthorized:false still rejected.
        const agentOptions = (this as unknown as { options?: HttpsRequestOptions }).options ?? {};
        const merged: HttpsRequestOptions = { ...agentOptions, ...options };
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
    agent: Agent | boolean;
    host: string;
    protocol: string;
    method: string;
    path: string;
    onSocket(socket: TLSSocket): void;

    _tlsSocket: TLSSocket | null;
    _options: RequestOptions;
    _callback: ((res: IncomingMessageImpl) => void) | null;
    _aborted: boolean;
    _timeoutId: number | null;
    _requestBody: Uint8Array[];
    _bodySent: boolean;
    _tcp: CModuleStreams.TCP | null;
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
        return connectRequestWithAgent(this, HTTPS_CLIENT_HOOKS, this.agent);
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
    if ((typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) && optionsOrCallback && typeof optionsOrCallback === 'object') {
        return new HttpsClientRequest(mergeUrlOptions<RequestOptions>(urlOrOptions, optionsOrCallback), callback);
    }
    return new HttpsClientRequest(urlOrOptions, optionsOrCallback as ((res: IncomingMessageImpl) => void) | undefined);
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
