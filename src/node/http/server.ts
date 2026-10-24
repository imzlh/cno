const http = import.meta.use('http');
const text = import.meta.use('text');
const engine = import.meta.use('engine');

import { Readable, Writable } from '../stream';
import { createWriteAfterEndError } from '../stream/_shared';
import { Socket, Server as NetServer, AddressInfo, type HttpOwnedTransport } from '../net';
import { normalizeTcpHost } from '../net/_shared';
import { closeQuietly } from '../_internal/close';
import type { HttpRequest, HttpResponse, Server as HttpServer } from '@cnojs/http/server';
import {
    buildNodeServerUrl,
    captureNodeNetworkCallFrames,
    getNodeServeHook,
    headerEntriesToRecord,
    nextNodeRequestId,
    nodeTs,
    normalizeHeaderRecord,
    toUint8Array,
} from '../_internal/network-debug';
import { isTransportDisconnectError, normalizeErrnoError } from '../_internal/errno';
import { arrayBufferBackedBytes, viewToUint8Array } from '../_internal/buffer';
import {
    createHeadersSentError,
    isBodyForbiddenStatus,
    ServerResponseAdapter,
    type ResponseAdapterServeHook,
} from '../_internal/server-response-adapter';
import { dispatchServerRequest } from '../_internal/server-request-runtime';
import {
    appendIncomingHeader,
    pumpIncomingRequestBody,
} from '../_internal/server-request-stream';
import { emitNodeServerUpgrade } from '../_internal/server-upgrade';
import {
    onNetServerSocket,
    onServerRequestStart,
    onServerResponseCreated,
    onServerResponseFinish,
} from '../diagnostics_channel/builtins';
import type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener, MessageSocket } from './types';
import { IOpaque } from '../_internal/inject';
import { flattenPrototype } from '../_internal/prototype';
import { STATUS_CODES } from './constants';
export type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener } from './types';
type NativeHttpModule = typeof http & { __cno: IOpaque };

const { createServer: createHttpServer } = (http as NativeHttpModule).__cno;

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export interface ServerSocketLike {
    setTimeout?(msecs: number, callback?: () => void): unknown;
    once(event: 'close', listener: () => void): unknown;
    off?(event: 'close', listener: () => void): unknown;
    removeListener?(event: 'close', listener: () => void): unknown;
}

function toBodyChunkBytes(chunk: unknown, encodeString: (value: string) => Uint8Array): Uint8Array {
    if (typeof chunk === 'string') return encodeString(chunk);
    if (chunk instanceof Uint8Array) return chunk as Uint8Array;
    if (ArrayBuffer.isView(chunk)) return viewToUint8Array(chunk);
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    throw new TypeError('The "chunk" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer');
}

function normalizeEndArgs(
    chunk: unknown,
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void
): { chunk: unknown; callback?: () => void } {
    if (typeof chunk === 'function') {
        // @ts-ignore - Function cast
        return { chunk: undefined, callback: chunk };
    }
    if (typeof encodingOrCb === 'function') {
        return { chunk, callback: encodingOrCb };
    }
    if (typeof cb === 'function') {
        return { chunk, callback: cb };
    }
    return { chunk };
}

function createAttachedSocketQuietly(
    tcp: CModuleStreams.TCP | undefined,
    owned?: HttpOwnedTransport,
): Socket | null {
    if (!tcp) return null;
    try {
        return createAttachedSocket(tcp, owned);
    } catch {
        return null;
    }
}

/**
 * When `owned` is set HTTP core owns all I/O and the Socket is address/destroy
 * metadata only (no dual-write on the TCP); otherwise destroy may close the handle.
 */
export function createAttachedSocket(
    tcp: CModuleStreams.TCP,
    owned?: HttpOwnedTransport,
): Socket {
    if (owned) return Socket.fromHttpOwned(tcp, owned);

    // Without `owned` (clientError display) the socket is metadata only; it must
    // not keep the TCP reachable for stream I/O, matching fromHttpOwned.
    return Socket.fromHttpOwned(tcp, { close: () => {
        closeQuietly(tcp);
    } });
}

export function createServerRequestObjects(
    socket: MessageSocket | null,
    timeout?: number,
    timeoutCallback?: () => void,
): { incoming: IncomingMessageImpl; response: ServerResponseImpl } {
    const incoming = new IncomingMessageImpl(null);
    incoming.socket = socket;
    if (timeout !== undefined) incoming.setTimeout(timeout, timeoutCallback);

    const response = new ServerResponseImpl();
    response.req = incoming;
    if (socket) response.assignSocket(socket);

    return { incoming, response };
}

export function applyCoreServerRequest(incoming: IncomingMessageImpl, request: Pick<HttpRequest, 'method' | 'url' | 'httpVersion' | 'headers'>): void {
    incoming.method = request.method;
    incoming.url = request.url;
    incoming.httpVersion = request.httpVersion;
    const [major = 1, minor = 1] = request.httpVersion.split('.').map(Number);
    incoming.httpVersionMajor = major;
    incoming.httpVersionMinor = minor;
    for (const [key, value] of request.headers) appendIncomingHeader(incoming, key, value);
}

// Re-export from shared constants (single source of truth)
export { STATUS_CODES, METHODS } from './constants';

// Function constructors, not classes, so `http.IncomingMessage.call(this)` plus `util.inherits()` works.
export interface IncomingMessageImpl extends IncomingMessage {}

export interface IncomingMessageImplConstructor {
    new (socket: MessageSocket | null): IncomingMessageImpl;
    (socket: MessageSocket | null): IncomingMessageImpl;
    prototype: IncomingMessageImpl;
}

function initIncomingMessage(self: IncomingMessageImpl, socket: MessageSocket | null): void {
    Readable.call(self);
    self.socket = socket;
    self.httpVersion = '1.1';
    self.httpVersionMajor = 1;
    self.httpVersionMinor = 1;
    self.complete = false;
    self.headers = {};
    self.headersDistinct = {};
    self.rawHeaders = [];
    self.trailers = {};
    self.trailersDistinct = {};
    self.rawTrailers = [];
    self.aborted = false;
}

export const IncomingMessageImpl: IncomingMessageImplConstructor = function IncomingMessageImpl(this: IncomingMessageImpl | undefined, socket: MessageSocket | null) {
    const target: IncomingMessageImpl = this ?? Object.create(IncomingMessageImpl.prototype);
    initIncomingMessage(target, socket);
    return target;
} as IncomingMessageImplConstructor;

Object.setPrototypeOf(IncomingMessageImpl, Readable);
IncomingMessageImpl.prototype = Object.create(Readable.prototype);

IncomingMessageImpl.prototype.push = function push(this: IncomingMessageImpl, chunk: unknown, encoding?: BufferEncoding): boolean {
    if (chunk !== null && chunk !== undefined && typeof chunk !== 'string' && this.readableEncoding) {
        chunk = engine.decodeString(toUint8Array(chunk, engine.encodeString));
    }
    return Readable.prototype.push.call(this, chunk, encoding);
};

// Push-based stream: data arrives externally, no pull needed
IncomingMessageImpl.prototype._read = function _read(this: IncomingMessageImpl, _size: number): void {};

Object.defineProperty(IncomingMessageImpl.prototype, 'connection', {
    get(this: IncomingMessageImpl): MessageSocket | null {
        return this.socket;
    },
    configurable: true,
});

IncomingMessageImpl.prototype.setTimeout = function setTimeout(this: IncomingMessageImpl, msecs: number, callback?: () => void): IncomingMessageImpl {
    this.socket?.setTimeout(msecs, callback);
    return this;
};

IncomingMessageImpl.prototype.destroy = function destroy(this: IncomingMessageImpl, error?: Error): IncomingMessageImpl {
    // 'aborted' only for an incomplete message, and never if already aborted: the client
    // truncation path calls destroy(err) after announcing it (docs/node-internals.md#http-aborted).
    if (!this.complete && !this.aborted) {
        this.aborted = true;
        this.emit('aborted');
    }
    Readable.prototype.destroy.call(this, error);
    return this;
};

Object.defineProperty(IncomingMessageImpl.prototype, 'constructor', {
    value: IncomingMessageImpl,
    writable: true,
    configurable: true,
});

flattenPrototype(IncomingMessageImpl.prototype);

export interface OutgoingMessageImpl extends OutgoingMessage {
    _headers: OutgoingHttpHeaders;
    _headerNames: Map<string, string>;
    _trailers: OutgoingHttpHeaders;
    _rawHeaderNames: string[];
    getRawHeaderNames(): string[];
    _requireHeadersNotSent(): void;
    _formatHeaders(): string;
    _sendHeaders(): void;
    /** Legacy Node internals. Widely used by middleware; see the accessor below. */
    _header: string | null;
    _implicitHeader(): void;
}

export interface OutgoingMessageImplConstructor {
    new (): OutgoingMessageImpl;
    (): OutgoingMessageImpl;
    prototype: OutgoingMessageImpl;
}

function initOutgoingMessage(self: OutgoingMessageImpl): void {
    Writable.call(self);
    self.socket = null;
    self.writableEnded = false;
    self.writableFinished = false;
    self.headersSent = false;
    self.sendDate = true;
    self.finished = false;
    self.chunkedEncoding = false;
    // Node OutgoingMessage defaults shouldKeepAlive true (client flips off without keepAlive).
    self.shouldKeepAlive = true;
    self.useChunkedEncodingByDefault = true;

    self._headers = {};
    self._headerNames = new Map();
    self._trailers = {};
    self._rawHeaderNames = [];
}

export const OutgoingMessageImpl: OutgoingMessageImplConstructor = function OutgoingMessageImpl(this: OutgoingMessageImpl | undefined) {
    const target: OutgoingMessageImpl = this ?? Object.create(OutgoingMessageImpl.prototype);
    initOutgoingMessage(target);
    return target;
} as OutgoingMessageImplConstructor;

Object.setPrototypeOf(OutgoingMessageImpl, Writable);
OutgoingMessageImpl.prototype = Object.create(Writable.prototype);

Object.defineProperty(OutgoingMessageImpl.prototype, 'connection', {
    get(this: OutgoingMessageImpl): MessageSocket | null {
        return this.socket;
    },
    configurable: true,
});

OutgoingMessageImpl.prototype.setTimeout = function setTimeout(this: OutgoingMessageImpl, msecs: number, callback?: () => void): OutgoingMessageImpl {
    if (this.socket) this.socket.setTimeout(msecs, callback);
    else if (callback) this.once('socket', () => this.socket?.setTimeout(msecs, callback));
    return this;
};

OutgoingMessageImpl.prototype._requireHeadersNotSent = function _requireHeadersNotSent(this: OutgoingMessageImpl): void {
    if (this.headersSent) throw createHeadersSentError('Cannot set headers after they are sent to the client');
};

OutgoingMessageImpl.prototype.setHeader = function setHeader(this: OutgoingMessageImpl, name: string, value: OutgoingHttpHeader): OutgoingMessageImpl {
    this._requireHeadersNotSent();
    validateHeaderName(name);
    const key = name.toLowerCase();
    this._headerNames.set(key, name);
    if (Array.isArray(value)) {
        for (const v of value) validateHeaderValue(name, String(v));
    } else {
        validateHeaderValue(name, String(value));
    }
    this._headers[key] = value as OutgoingHttpHeader;
    return this;
};

OutgoingMessageImpl.prototype.setHeaders = function setHeaders(this: OutgoingMessageImpl, headers: Headers | Map<string, OutgoingHttpHeader>): OutgoingMessageImpl {
    this._requireHeadersNotSent();
    for (const [key, value] of headers) {
        this.setHeader(key, value);
    }
    return this;
};

OutgoingMessageImpl.prototype.appendHeader = function appendHeader(this: OutgoingMessageImpl, name: string, value: string | readonly string[]): OutgoingMessageImpl {
    this._requireHeadersNotSent();
    validateHeaderName(name);
    const vals = Array.isArray(value) ? value : [value];
    for (const v of vals) validateHeaderValue(name, String(v));
    const key = name.toLowerCase();
    const existing = this._headers[key];
    if (existing === undefined) {
        this._headerNames.set(key, name);
        this._headers[key] = Array.isArray(value) ? value : [value];
    } else if (Array.isArray(existing)) {
        this._headers[key] = [...existing, ...(Array.isArray(value) ? value : [value])];
    } else {
        this._headers[key] = [existing, ...(Array.isArray(value) ? value : [value])];
    }
    return this;
};

OutgoingMessageImpl.prototype.getHeader = function getHeader(this: OutgoingMessageImpl, name: string): OutgoingHttpHeader | undefined {
    return this._headers[name.toLowerCase()];
};

OutgoingMessageImpl.prototype.getHeaders = function getHeaders(this: OutgoingMessageImpl): OutgoingHttpHeaders {
    return { ...this._headers };
};

OutgoingMessageImpl.prototype.getHeaderNames = function getHeaderNames(this: OutgoingMessageImpl): string[] {
    return Object.keys(this._headers);
};

OutgoingMessageImpl.prototype.getRawHeaderNames = function getRawHeaderNames(this: OutgoingMessageImpl): string[] {
    return [...this._headerNames.values()];
};

OutgoingMessageImpl.prototype.hasHeader = function hasHeader(this: OutgoingMessageImpl, name: string): boolean {
    return this._headers[name.toLowerCase()] !== undefined;
};

OutgoingMessageImpl.prototype.removeHeader = function removeHeader(this: OutgoingMessageImpl, name: string): void {
    this._requireHeadersNotSent();
    const key = name.toLowerCase();
    delete this._headers[key];
    this._headerNames.delete(key);
};

OutgoingMessageImpl.prototype.addTrailers = function addTrailers(this: OutgoingMessageImpl, headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void {
    if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
            this._trailers[key.toLowerCase()] = value;
        }
    } else {
        for (const [key, value] of Object.entries(headers)) {
            if (value !== undefined) this._trailers[key.toLowerCase()] = value;
        }
    }
};

OutgoingMessageImpl.prototype.flushHeaders = function flushHeaders(this: OutgoingMessageImpl): void {
    if (!this.headersSent) this._sendHeaders();
};

// Legacy internals middleware calls directly (`if (!this._header) this._implicitHeader()`).
OutgoingMessageImpl.prototype._implicitHeader = function _implicitHeader(this: OutgoingMessageImpl): void {
    this.flushHeaders();
};

Object.defineProperty(OutgoingMessageImpl.prototype, '_header', {
    configurable: true,
    enumerable: false,
    get(this: OutgoingMessageImpl): string | null {
        // Node exposes the serialized head; callers only test truthiness, but
        // return the real bytes so anything that inspects it sees the head.
        if (!this.headersSent) return null;
        // statusCode/statusMessage belong to the ServerResponse subclass; a bare
        // OutgoingMessage has no status line, so fall back to headers only.
        const self = this as OutgoingMessageImpl & { statusCode?: number; statusMessage?: string };
        const status = typeof self.statusCode === 'number'
            ? `HTTP/1.1 ${self.statusCode} ${self.statusMessage || ''}\r\n`
            : '';
        return `${status}${this._formatHeaders()}\r\n`;
    },
    set(this: OutgoingMessageImpl, _value: string | null): void {
        // Accept and ignore `res._header = null`: the head is derived from live state, and
        // throwing would break third-party middleware.
    },
});

OutgoingMessageImpl.prototype._formatHeaders = function _formatHeaders(this: OutgoingMessageImpl): string {
    let result = '';
    for (const [key, value] of Object.entries(this._headers)) {
        const name = this._headerNames.get(key) || key;
        if (Array.isArray(value)) {
            for (const v of value) result += `${name}: ${v}\r\n`;
        } else {
            result += `${name}: ${value}\r\n`;
        }
    }
    return result;
};

OutgoingMessageImpl.prototype._sendHeaders = function _sendHeaders(this: OutgoingMessageImpl): void {
    this.headersSent = true;
};

Object.defineProperty(OutgoingMessageImpl.prototype, 'constructor', {
    value: OutgoingMessageImpl,
    writable: true,
    configurable: true,
});

flattenPrototype(OutgoingMessageImpl.prototype);

export interface ServerResponseImpl extends OutgoingMessageImpl, ServerResponse {
    req: IncomingMessage | null;
    _ended: boolean;
    _bodyLength: number;
    _socketCloseListener: (() => void) | null;
    assignSocket(socket: ServerSocketLike): void;
    detachSocket(socket: ServerSocketLike): void;
}

export interface ServerResponseImplConstructor {
    new (): ServerResponseImpl;
    (): ServerResponseImpl;
    prototype: ServerResponseImpl;
}

function initServerResponse(self: ServerResponseImpl): void {
    OutgoingMessageImpl.call(self);
    self.statusCode = 200;
    // Node starts with undefined; empty means "fill from STATUS_CODES on send".
    self.statusMessage = '';
    self.strictContentLength = false;
    self.req = null;

    self._ended = false;
    self._bodyLength = 0;
    self._socketCloseListener = null;
}

function statusMessageFor(code: number, explicit?: string): string {
    if (explicit) return explicit;
    return STATUS_CODES[code] ?? 'unknown';
}

export const ServerResponseImpl: ServerResponseImplConstructor = function ServerResponseImpl(this: ServerResponseImpl | undefined) {
    const target: ServerResponseImpl = this ?? Object.create(ServerResponseImpl.prototype);
    initServerResponse(target);
    return target;
} as ServerResponseImplConstructor;

Object.setPrototypeOf(ServerResponseImpl, OutgoingMessageImpl);
ServerResponseImpl.prototype = Object.create(OutgoingMessageImpl.prototype);

ServerResponseImpl.prototype.assignSocket = function assignSocket(this: ServerResponseImpl, socket: ServerSocketLike): void {
    if (this.socket) this.detachSocket(this.socket as ServerSocketLike);
    this.socket = socket as MessageSocket;
    const onClose = () => {
        if (this.socket === socket) this.socket = null;
        this._socketCloseListener = null;
    };
    this._socketCloseListener = onClose;
    socket.once('close', onClose);
};

ServerResponseImpl.prototype.detachSocket = function detachSocket(this: ServerResponseImpl, socket: ServerSocketLike): void {
    const listener = this._socketCloseListener;
    if (listener && socket) {
        try {
            if (typeof socket.off === 'function') socket.off('close', listener);
            else socket.removeListener?.('close', listener);
        } catch {
            // The socket may already be tearing down.
        }
    }
    if (this.socket === socket) this.socket = null;
    this._socketCloseListener = null;
};

ServerResponseImpl.prototype.writeHead = function writeHead(
    this: ServerResponseImpl,
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders | readonly string[],
    headers?: OutgoingHttpHeaders | readonly string[]
): ServerResponseImpl {
    this._requireHeadersNotSent();

    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === 'string') {
        if (/[\r\n]/.test(statusMessageOrHeaders)) throw new TypeError('statusMessage must not contain CR/LF');
        this.statusMessage = statusMessageOrHeaders || statusMessageFor(statusCode);
    } else {
        this.statusMessage = statusMessageFor(statusCode, this.statusMessage);
        if (statusMessageOrHeaders !== undefined) headers = statusMessageOrHeaders;
    }

    if (headers) {
        if (Array.isArray(headers)) {
            for (let i = 0; i < headers.length; i += 2) {
                this.setHeader(headers[i], headers[i + 1]);
            }
        } else {
            for (const [key, value] of Object.entries(headers)) {
                if (value === undefined) continue;
                if (typeof value === 'string' || typeof value === 'number') {
                    this.setHeader(key, value);
                } else {
                    this.setHeader(key, value.map(String));
                }
            }
        }
    }

    if (!this.hasHeader('date') && this.sendDate) {
        this.setHeader('Date', new Date().toUTCString());
    }

    this._sendHeaders();
    return this;
};

// No-ops: interim writes need the socket, and @cnojs/http has no interim-write API.
ServerResponseImpl.prototype.writeProcessingContinue = function writeProcessingContinue(this: ServerResponseImpl): void {};

ServerResponseImpl.prototype.writeEarlyHints = function writeEarlyHints(this: ServerResponseImpl, _hints: Record<string, string | string[]>, callback?: () => void): void {
    callback?.();
};

ServerResponseImpl.prototype._sendHeaders = function _sendHeaders(this: ServerResponseImpl): void {
    if (this.headersSent) return;
    // State-only; socket I/O belongs to NodeResponseAdapter -> coreResponse (@cnojs/http).
    OutgoingMessageImpl.prototype._sendHeaders.call(this);
};

ServerResponseImpl.prototype.write = function write(
    this: ServerResponseImpl,
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
): boolean {
    if (this._ended) {
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        const err = createWriteAfterEndError();
        callback?.(err);
        queueMicrotask(() => this.emit('error', err));
        return false;
    }

    if (!this.headersSent) {
        if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
            this.chunkedEncoding = true;
            this.setHeader('Transfer-Encoding', 'chunked');
        }
        this._sendHeaders();
    }

    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    if (!text) throw new Error('Text module is not available');
    const encoder = new text.Encoder(encoding);
    const data = toBodyChunkBytes(chunk, value => encoder.encode(value));
    this._bodyLength += data.length;

    // State-only; NodeResponseAdapter rebinds this per request and must never touch the socket.
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    callback?.();
    return true;
};

ServerResponseImpl.prototype.end = function end(this: ServerResponseImpl, chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): ServerResponseImpl {
    const normalized = normalizeEndArgs(chunk, encodingOrCb, cb);
    const callback = normalized.callback;
    chunk = normalized.chunk;

    if (this._ended) {
        callback?.();
        return this;
    }

    // State-only; NodeResponseAdapter rebinds this per request and must never touch the socket.
    this._ended = true;
    this.writableEnded = true;
    this.finished = true;
    this.writableFinished = true;
    this.emit('finish');
    callback?.();
    return this;
};

Object.defineProperty(ServerResponseImpl.prototype, 'constructor', {
    value: ServerResponseImpl,
    writable: true,
    configurable: true,
});

flattenPrototype(ServerResponseImpl.prototype);

class NodeResponseAdapter extends ServerResponseAdapter<ServerResponseImpl> {
    constructor(
        response: ServerResponseImpl,
        coreResponse: HttpResponse,
        serveHook: ReturnType<typeof getNodeServeHook>,
        requestId: string,
        requestUrl: string,
        suppressBody: boolean,
    ) {
        super(response, {
            closeSource: response.socket,
            normalizeError: normalizeErrnoError,
            writeHead: (res, headers) => coreResponse.writeHead(res.statusCode, res.statusMessage, headers),
            writeInformational: (_res, status, statusText, headers) => coreResponse.writeHead(status, statusText, headers),
            writeBody: async (_res, data) => {
                await coreResponse.write(arrayBufferBackedBytes(toUint8Array(data, engine.encodeString)));
            },
            finish: async () => {
                await coreResponse.end();
                if (response.socket) {
                    response.detachSocket(response.socket as ServerSocketLike);
                }
            },
            abort: () => {
                closeQuietly(coreResponse);
            },
        }, serveHook as ResponseAdapterServeHook | null, requestId, requestUrl, suppressBody);
    }

    // Dispatch through the instance property so middleware wrappers (on-headers) run.
    // bindServerResponseAdapter points it back here, so inPublicWriteHead stops the recursion.
    private inPublicWriteHead = false;

    override writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | OutgoingHttpHeaders | readonly string[],
        headers?: OutgoingHttpHeaders | readonly string[],
    ): ServerResponseImpl {
        if (!this.inPublicWriteHead && typeof this.response.writeHead === 'function') {
            // Re-dispatch through the instance property so any wrapper runs. When
            // nothing is patched this is bindServerResponseAdapter's bound copy of
            // this same method, which re-enters once and falls through to super.
            this.inPublicWriteHead = true;
            try {
                return this.response.writeHead(statusCode, statusMessageOrHeaders as never, headers as never);
            } finally {
                this.inPublicWriteHead = false;
            }
        }
        return super.writeHead(statusCode, statusMessageOrHeaders, headers);
    }
}

export interface ServerOptions {
    IncomingMessage?: typeof IncomingMessageImpl;
    ServerResponse?: typeof ServerResponseImpl;
    requestTimeout?: number;
    headersTimeout?: number;
    keepAliveTimeout?: number;
    keepAliveTimeoutBuffer?: number;
    maxRequestsPerSocket?: number;
    connectionsCheckingInterval?: number;
    highWaterMark?: number;
    insecureHTTPParser?: boolean;
    maxHeaderSize?: number;
    noDelay?: boolean;
    requireHostHeader?: boolean;
    keepAlive?: boolean;
    keepAliveInitialDelay?: number;
    uniqueHeaders?: Array<string | string[]>;
    joinDuplicateHeaders?: boolean;
    rejectNonStandardBodyWrites?: boolean;
    optimizeEmptyRequests?: boolean;
}

interface NormalizedServerListenArgs {
    port?: number;
    host: string;
    listener?: () => void;
}

function normalizeServerListenArgs(
    arg1?: number | ListenOptions | string,
    arg2?: string | number | (() => void),
    arg3?: number | (() => void),
    arg4?: () => void,
): NormalizedServerListenArgs {
    if (typeof arg1 === 'object') {
        return {
            port: arg1.port,
            host: arg1.host ?? '0.0.0.0',
            listener: typeof arg2 === 'function' ? arg2 : undefined,
        };
    }

    const port = typeof arg1 === 'number' ? arg1 : parseInt(arg1 ?? '0');
    const host = typeof arg2 === 'string' ? arg2 : '0.0.0.0';
    const listener = [arg4, arg3, arg2].find(
        (arg): arg is () => void => typeof arg === 'function',
    );
    return { port, host, listener };
}

export class ServerImpl extends NetServer implements Server {
    maxHeadersCount: number | null = null;
    maxRequestsPerSocket: number | null = null;
    timeout: number = 0;
    headersTimeout: number = 60000;
    keepAliveTimeout: number = 5000;
    keepAliveTimeoutBuffer: number = 1000;
    requestTimeout: number = 300000;
    listening: boolean = false;

    private _httpServer: HttpServer | null = null;
    private _options: ServerOptions;
    private _requestListener: RequestListener;
    private _httpConnections: Set<Socket> = new Set();
    private _httpActiveSockets: Set<Socket> = new Set();
    private _httpUpgradedSockets: Set<Socket> = new Set();
    /** One Node facade per native TCP (keep-alive reuses it). */
    private _httpSocketByTcp = new WeakMap<object, Socket>();
    private _httpClosePromise: Promise<void> | null = null;
    private _httpCloseCallbacks: Array<(err?: Error) => void> = [];
    private _httpDeferredClose: (() => void) | null = null;

    constructor(options: ServerOptions | RequestListener, requestListener?: RequestListener) {
        super();
        if (typeof options === 'function') {
            this._requestListener = options;
            this._options = {};
        } else {
            this._options = options || {};
            this._requestListener = requestListener ?? (() => {});
        }
        if (this._options.requestTimeout !== undefined) this.requestTimeout = this._options.requestTimeout;
        if (this._options.headersTimeout !== undefined) this.headersTimeout = this._options.headersTimeout;
        if (this._options.keepAliveTimeout !== undefined) this.keepAliveTimeout = this._options.keepAliveTimeout;
        if (this._options.maxRequestsPerSocket !== undefined) this.maxRequestsPerSocket = this._options.maxRequestsPerSocket;
    }

    setTimeout(msecs?: number, callback?: (socket: Socket) => void): this {
        if (msecs !== undefined) this.timeout = msecs;
        if (callback) this.on('timeout', callback);
        return this;
    }

    getTimeout(): number {
        return this.timeout;
    }

    closeAllConnections(): void {
        for (const socket of [...this._httpConnections]) {
            if (this._httpUpgradedSockets.has(socket)) continue;
            socket.destroy();
        }
        this._httpActiveSockets.clear();
        if (this._httpDeferredClose) this._httpDeferredClose();
    }

    closeIdleConnections(): void {
        // Keep the listener open; only sockets with no active HTTP handler are idle.
        for (const socket of [...this._httpConnections]) {
            if (!this._httpUpgradedSockets.has(socket) && !this._httpActiveSockets.has(socket)) {
                socket.destroy();
            }
        }
    }

    private trackHttpSocket(socket: Socket): void {
        if (this._httpConnections.has(socket)) return;
        this._httpConnections.add(socket);
        socket.once('close', () => {
            this._httpConnections.delete(socket);
            this._httpUpgradedSockets.delete(socket);
            this.releaseActiveHttpSocket(socket);
        });
    }

    private markHttpSocketUpgraded(socket: Socket | null): void {
        if (socket) this._httpUpgradedSockets.add(socket);
    }

    private releaseActiveHttpSocket(socket: Socket | null): void {
        if (!socket) return;
        this._httpActiveSockets.delete(socket);
        if (this._httpDeferredClose && this._httpActiveSockets.size === 0) {
            this._httpDeferredClose();
        }
    }

    /** Facade for a core-owned TCP; reused across keep-alive requests on the same handle. */
    private socketForCoreRequest(tcp: CModuleStreams.TCP, res: HttpResponse): Socket {
        const existing = this._httpSocketByTcp.get(tcp);
        if (existing && !existing.destroyed) return existing;

        const owned: HttpOwnedTransport = {
            close: () => {
                closeQuietly(res);
            },
        };
        const socket = createAttachedSocket(tcp, owned);
        res.onTerminalClose?.(() => {
            if (socket._httpOwned !== owned) return;
            socket._httpOwned = null;
            socket.destroy();
        });
        this._httpSocketByTcp.set(tcp, socket);
        this.trackHttpSocket(socket);
        // Once per new connection (not per keep-alive request), standing in for net.Server's publish.
        if (onNetServerSocket.hasSubscribers) {
            onNetServerSocket.publish({ socket });
        }
        return socket;
    }

    private async _handleNativeRequest(
        req: HttpRequest,
        res: HttpResponse,
        host: string,
        listenEntryCallFrames?: ReturnType<typeof captureNodeNetworkCallFrames>,
    ): Promise<void> {
        const serveHook = getNodeServeHook();
        const requestId = nextNodeRequestId('node-serve');
        const requestStartTime = nodeTs();
        const requestCallFrames = listenEntryCallFrames ?? captureNodeNetworkCallFrames();
        const requestHeaders = headerEntriesToRecord(req.headers);
        const requestUrl = buildNodeServerUrl('http:', req.url, requestHeaders, host);
        const rawTcp = Reflect.get(req, '__cnoTcp') ?? Reflect.get(res, '__cnoTcp');
        // Core owns wire I/O; Node socket is addresses + destroy → res.close only.
        const nodeSocket = typeof rawTcp === 'object' && rawTcp !== null
            ? this.socketForCoreRequest(rawTcp as CModuleStreams.TCP, res)
            : null;
        if (nodeSocket) this._httpActiveSockets.add(nodeSocket);
        const { incoming, response } = createServerRequestObjects(nodeSocket);
        applyCoreServerRequest(incoming, req);
        // After applyCoreServerRequest, or subscribers would see a blank request.
        if (onServerResponseCreated.hasSubscribers) {
            onServerResponseCreated.publish({ request: incoming, response });
        }
        if (incoming.method === 'CONNECT') {
            if (this.listenerCount('connect') <= 0) {
                res.close();
                this.releaseActiveHttpSocket(nodeSocket);
                return;
            }
            let connectSocket: Socket | null = null;
            try {
                connectSocket = Socket.fromUpgradeHandle(res.upgrade());
                this.markHttpSocketUpgraded(nodeSocket);
                this.emit('connect', incoming, connectSocket, new Uint8Array(0));
            } catch (err) {
            // Ownership moved to the Node socket once upgrade() succeeded.
            if (connectSocket && !connectSocket.destroyed) connectSocket.destroy();
                this.emit('error', err);
            }
            this.releaseActiveHttpSocket(nodeSocket);
            return;
        }
        const upgradeResult = emitNodeServerUpgrade(this, res, incoming);
        if (upgradeResult.handled) {
            if (upgradeResult.upgraded) this.markHttpSocketUpgraded(nodeSocket);
            this.releaseActiveHttpSocket(nodeSocket);
            return;
        }

        pumpIncomingRequestBody(
            incoming,
            typeof req.body === 'function'
                ? async () => {
                    const chunk = await req.body!();
                    return chunk === null ? null : viewToUint8Array(chunk);
                }
                : null,
        );
        response.once('finish', () => {
            // Drain an untouched request so keep-alive can advance when the handler never reads its upload.
            if (!incoming.readableDidRead && !incoming.destroyed) {
                incoming.removeAllListeners('data');
                incoming.resume();
            }
        });

        const adapter = new NodeResponseAdapter(response, res, serveHook, requestId, requestUrl, incoming.method === 'HEAD');

        // Both diagnostic-channel payloads carry the same four keys.
        if (onServerRequestStart.hasSubscribers) {
            onServerRequestStart.publish({ request: incoming, response, socket: nodeSocket, server: this });
        }
        if (onServerResponseFinish.hasSubscribers) {
            response.once('finish', () => {
                onServerResponseFinish.publish({ request: incoming, response, socket: nodeSocket, server: this });
            });
        }

        try {
            await dispatchServerRequest({
                listener: this._requestListener,
                incoming,
                response,
                adapter,
                serveHook,
                requestId,
                timestamp: requestStartTime,
                url: requestUrl,
                method: req.method,
                headers: requestHeaders,
                postData: undefined,
                callFrames: requestCallFrames,
                // Peer abort is not a server fault; never promote it to server 'error'.
                onError: (err) => {
                    if (isTransportDisconnectError(err)) return;
                    this.emit('error', err);
                },
            });
        } finally {
            this.releaseActiveHttpSocket(nodeSocket);
        }
    }

    private _handleNativeRequestError(err: Error, tcpSock: { socket?: unknown } | undefined): void {
        if (isTransportDisconnectError(err)) return;
        // Parse faults carry this H1 prefix and surface as clientError (the Node-compatible
        // surface for bad request lines), not as a server 'error'.
        const message = String(err.message ?? err);
        if (message.startsWith('Parse error:')) {
            const transport = tcpSock?.socket;
            const tcp = transport !== null
                && typeof transport === 'object'
                && 'setNoDelay' in transport
                && 'setKeepAlive' in transport
                ? transport as CModuleStreams.TCP
                : undefined;
            const clientSocket = createAttachedSocketQuietly(tcp);
            this.emit('clientError', err, clientSocket);
            return;
        }
        this.emit('error', err);
    }

    private _createNativeServer(hostname: string, port: number | undefined, handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): HttpServer {
        // These limits are enforced by the core only if forwarded here (docs/node-internals.md#http-core-limits).
        const configuredMaxConnections = (this as unknown as { maxConnections?: number }).maxConnections;
        return createHttpServer(handler, {
            port: port ?? 0,
            hostname,
            keepAliveTimeout: this.keepAliveTimeout,
            maxRequestsPerConnection: (
                this.maxRequestsPerSocket != null && this.maxRequestsPerSocket > 0
                    ? this.maxRequestsPerSocket
                    : Number.MAX_SAFE_INTEGER
            ),
            requestTimeout: this.requestTimeout,
            ...(typeof this._options.maxHeaderSize === 'number' && this._options.maxHeaderSize > 0
                ? { maxHeaderSize: this._options.maxHeaderSize }
                : {}),
            // Forward only an explicitly set value: Node does not enforce maxHeadersCount itself.
            ...(typeof this.maxHeadersCount === 'number' && this.maxHeadersCount > 0
                ? { maxHeadersCount: this.maxHeadersCount }
                : {}),
            ...(typeof configuredMaxConnections === 'number' && configuredMaxConnections > 0
                ? { maxConnections: configuredMaxConnections }
                : {}),
        });
    }

    listen(arg1?: number | ListenOptions | string, arg2?: string | number | (() => void), arg3?: number | (() => void), arg4?: () => void): this {
        // Capture call frames HERE — the user's code is on the stack.
        const listenEntryCallFrames = captureNodeNetworkCallFrames();
        const { port, host: rawHost, listener } = normalizeServerListenArgs(arg1, arg2, arg3, arg4);
        const host = normalizeTcpHost(rawHost);

        const handler = async (req: HttpRequest, res: HttpResponse) => {
            await this._handleNativeRequest(req, res, host, listenEntryCallFrames);
        };

        this._httpServer = this._createNativeServer(host, port, handler);
        this._httpServer.onRequestError = (err: Error, tcpSock) => this._handleNativeRequestError(err, tcpSock);
        this._httpServer.listen(); 
        this._listening = true;
        this.listening = true;
        this._httpServer.acceptLoop().catch((err: unknown) => {
            if (this._listening && !this._httpClosePromise) this.emit('error', err);
        });
        queueMicrotask(() => {
            if (!this._listening) return;
            this.emit('listening');
            listener?.();
        });

        return this;
    }

    close(callback?: (err?: Error) => void): this {
        if (callback) this._httpCloseCallbacks.push(callback);
        if (this._httpClosePromise) return this;
        if (!this._listening) {
            const error = Object.assign(new Error('Server is not running'), {
                code: 'ERR_SERVER_NOT_RUNNING',
            });
            if (callback) queueMicrotask(() => {
                const callbacks = this._httpCloseCallbacks.splice(0);
                for (const cb of callbacks) cb(error);
            });
            return this;
        }

        // Node flips `listening` false at once; the callback/event still wait for requests to drain.
        this.listening = false;
        const core = this._httpServer;
        const gracefulClose = core ? Reflect.get(core, 'closeGracefully') : null;
        const forceClose = core ? Reflect.get(core, 'shutdown') : null;
        const invoke = (method: unknown): Promise<void> => {
            if (typeof method !== 'function') return Promise.resolve();
            return Promise.resolve().then(() => method.call(core)).then(() => undefined);
        };
        if (typeof gracefulClose === 'function') {
            this._httpClosePromise = invoke(gracefulClose);
        } else if (typeof forceClose === 'function' && this._httpActiveSockets.size > 0) {
            // Only shutdown() exists: defer that destructive call until the active set drains.
            const listener = core ? Reflect.get(core, 'listener') : null;
            const stopAccepting = listener && Reflect.get(listener, 'close');
            if (typeof stopAccepting === 'function') {
                try { stopAccepting.call(listener); } catch { /* already closed */ }
            }
            this._httpClosePromise = new Promise<void>((resolve, reject) => {
                this._httpDeferredClose = () => {
                    this._httpDeferredClose = null;
                    invoke(forceClose).then(resolve, reject);
                };
            });
        } else {
            this._httpClosePromise = invoke(forceClose);
        }
        void this._httpClosePromise.then(() => {
            this._httpServer = null;
            this._listening = false;
            this.listening = false;
            const callbacks = this._httpCloseCallbacks.splice(0);
            this._httpClosePromise = null;
            // Never delegate to super.close(): that would run net.Server's close state machine again.
            this.emit('close');
            for (const cb of callbacks) cb();
        }, (err: unknown) => {
            this._httpClosePromise = null;
            const error = err instanceof Error ? err : new Error(String(err));
            const callbacks = this._httpCloseCallbacks.splice(0);
            this._listening = false;
            this.listening = false;
            for (const cb of callbacks) cb(error);
        });
        return this;
    }

    address(): AddressInfo | string | null {
        const addr = this._httpServer?.address();
        if (!addr) return super.address();
        if ('path' in addr) return addr.path;
        return { address: addr.ip, family: addr.ip.includes(':') ? 'IPv6' : 'IPv4', port: addr.port };
    }
}

export function createServer(options: ServerOptions | RequestListener, requestListener?: RequestListener): Server {
    return new ServerImpl(options, requestListener);
}

/** Carries Node's error `code`s so `err.code === 'ERR_INVALID_CHAR'` branching works. */
function httpValidationError(code: string, message: string): TypeError & { code: string } {
    return Object.assign(new TypeError(message), { code });
}

/** RFC 7230 token. */
const HTTP_TOKEN_RE = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
/** Node's INVALID_PATH_REGEX: anything outside 0x21-0xff, so SP and CR/LF included. */
const INVALID_REQUEST_PATH_RE = /[^!-ÿ]/;

export function validateHeaderName(name: string): void {
    if (typeof name !== 'string' || !HTTP_TOKEN_RE.test(name)) {
        throw httpValidationError('ERR_INVALID_HTTP_TOKEN', `Header name must be a valid HTTP token ["${name}"]`);
    }
}

export function validateHeaderValue(name: string, value: string): void {
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
        throw httpValidationError('ERR_INVALID_CHAR', `Invalid character in header content ["${name}"]`);
    }
}

/** Synchronous, before serialisation: a malformed request line lets peers split the method differently. */
export function validateRequestMethod(method: string): void {
    if (typeof method !== 'string' || !HTTP_TOKEN_RE.test(method)) {
        throw httpValidationError('ERR_INVALID_HTTP_TOKEN', `Method must be a valid HTTP token ["${method}"]`);
    }
}

/** Synchronous, as an issue is reported by http.request(): an async 'error' escapes a try/catch. */
export function validateRequestPath(path: string): void {
    if (typeof path === 'string' && INVALID_REQUEST_PATH_RE.test(path)) {
        throw httpValidationError('ERR_UNESCAPED_CHARACTERS', 'Request path contains unescaped characters');
    }
}
