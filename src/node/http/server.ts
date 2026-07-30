const http = import.meta.use('http');
const text = import.meta.use('text');
const engine = import.meta.use('engine');
const dns = import.meta.use('dns');
const os = import.meta.use('os');

import { Readable, Writable } from '../stream';
import { Socket, Server as NetServer, AddressInfo, type HttpOwnedTransport } from '../net';
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
import { viewToUint8Array } from '../_internal/buffer';
import { ServerResponseAdapter, type ResponseAdapterServeHook } from '../_internal/server-response-adapter';
import { dispatchServerRequest } from '../_internal/server-request-runtime';
import { pumpIncomingRequestBody } from '../_internal/server-request-stream';
import { emitNodeServerUpgrade } from '../_internal/server-upgrade';
import type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener, MessageSocket } from './types';
import { IOpaque } from '../_internal/inject';
import { STATUS_CODES } from './constants';
export type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener } from './types';
type NativeHttpModule = typeof http & { __cno: IOpaque };

const { createServer: createHttpServer } = (http as NativeHttpModule).__cno;

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export interface ServerSocketLike {
    setTimeout?(msecs: number, callback?: () => void): unknown;
    once(event: 'close', listener: () => void): unknown;
}

function normalizeListenHost(host: string): string {
    if (!host || host === '*') return '0.0.0.0';
    if (host === 'localhost') {
        try {
            const resolved = dns.resolveSync?.(host, { family: os.AF_UNSPEC }) ?? [];
            if (resolved.length > 0 && typeof resolved[0]?.ip === 'string') {
                return resolved[0].ip;
            }
        } catch {}
        return '127.0.0.1';
    }
    return host;
}

export function isBodyForbiddenStatus(statusCode: number): boolean {
    return (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304;
}

export function createHeadersSentError(message = 'Cannot write headers after they are sent to the client'): Error & { code: string } {
    return Object.assign(new Error(message), {
        code: 'ERR_HTTP_HEADERS_SENT',
    });
}

export function createWriteAfterEndError(): Error & { code: string } {
    return Object.assign(new Error('write after end'), {
        code: 'ERR_STREAM_WRITE_AFTER_END',
    });
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
 * Node view of a connection. When `owned` is set, HTTP core owns all I/O —
 * the Socket is address/destroy metadata only (no dual-write on the TCP).
 * Without `owned` (e.g. clientError display), destroy may close the handle.
 */
export function createAttachedSocket(
    tcp: CModuleStreams.TCP,
    owned?: HttpOwnedTransport,
): Socket {
    if (owned) return Socket.fromHttpOwned(tcp, owned);

    const socket = new Socket();
    const localInfo = tcp.sockname;
    const remoteInfo = tcp.peername;

    socket._tcp = tcp;
    socket.readyState = 'open';
    socket.localAddress = localInfo.ip;
    socket.localPort = localInfo.port;
    socket.remoteAddress = remoteInfo.ip;
    socket.remotePort = remoteInfo.port;
    socket.remoteFamily = `IPv${remoteInfo.family}`;

    return socket;
}

export function applyIncomingRequestLine(incoming: IncomingMessageImpl, method: string, url: string, httpVersion: string): void {
    incoming.method = method;
    incoming.url = url;
    incoming.httpVersion = httpVersion;
    const [major, minor] = httpVersion.split('.').map(Number);
    incoming.httpVersionMajor = major;
    incoming.httpVersionMinor = minor;
}

export function appendIncomingHeader(incoming: IncomingMessageImpl, key: string, value: string): void {
    const lowerKey = key.toLowerCase();
    incoming.headers[lowerKey as keyof IncomingHttpHeaders] = value;
    incoming.rawHeaders.push(key, value);
    if (!incoming.headersDistinct[lowerKey]) {
        incoming.headersDistinct[lowerKey] = [];
    }
    incoming.headersDistinct[lowerKey]?.push(value);
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
    applyIncomingRequestLine(incoming, request.method, request.url, request.httpVersion);
    for (const [key, value] of request.headers) appendIncomingHeader(incoming, key, value);
}

// Re-export from shared constants (single source of truth)
export { STATUS_CODES, METHODS } from './constants';

// Old-style function-constructor + prototype pattern (mirrors Readable/Writable
// in ../stream/mod.ts and EventEmitter in ../events/mod.ts). Real Node.js core
// implements IncomingMessage/OutgoingMessage/ServerResponse/ClientRequest as
// function constructors too, so mock/test-double libraries and middleware can
// do `http.IncomingMessage.call(this)` + `util.inherits()` instead of
// `class X extends http.IncomingMessage` (which ES6 class constructors reject
// when invoked as a plain function).
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
    this.aborted = true;
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

OutgoingMessageImpl.prototype.setHeader = function setHeader(this: OutgoingMessageImpl, name: string, value: number | string | readonly string[]): OutgoingMessageImpl {
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

OutgoingMessageImpl.prototype.setHeaders = function setHeaders(this: OutgoingMessageImpl, headers: Headers | Map<string, number | string | readonly string[]>): OutgoingMessageImpl {
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
    this.socket = socket as MessageSocket;
    socket.once('close', () => {
        this.socket = null;
    });
};

ServerResponseImpl.prototype.detachSocket = function detachSocket(this: ServerResponseImpl, socket: ServerSocketLike): void {
    this.socket = null;
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

// Interim (1xx) responses require writing to the socket before the final
// response. ServerResponseImpl no longer owns the socket — the core
// @cnojs/http HttpResponse has no interim-write API yet — so these are
// no-ops. Vite/Connect do not use them; a future HttpResponse adapter can
// route interim writes through the core response if that support is added.
ServerResponseImpl.prototype.writeProcessingContinue = function writeProcessingContinue(this: ServerResponseImpl): void {};

ServerResponseImpl.prototype.writeEarlyHints = function writeEarlyHints(this: ServerResponseImpl, _hints: Record<string, string | string[]>, callback?: () => void): void {
    callback?.();
};

ServerResponseImpl.prototype._sendHeaders = function _sendHeaders(this: ServerResponseImpl): void {
    if (this.headersSent) return;
    // State-only. All socket I/O flows through NodeResponseAdapter ->
    // coreResponse (@cnojs/http), which is rebound onto this instance in
    // ServerImpl.listen() before the request handler runs. This base impl
    // exists only so any pre-override call keeps Node-facing state coherent.
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

    // State-only. NodeResponseAdapter rebinds write() per request and owns
    // all socket I/O via coreResponse (@cnojs/http). This base impl exists
    // only for pre-override calls and must never touch the socket.
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

    // State-only. NodeResponseAdapter rebinds end() per request and owns all
    // socket I/O via coreResponse (@cnojs/http). This base impl exists only
    // for pre-override calls and must never touch the socket.
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
        suppressBody = false,
    ) {
        super(response, {
            closeSource: response.socket,
            normalizeError: normalizeErrnoError,
            writeHead: (res, headers) => coreResponse.writeHead(res.statusCode, res.statusMessage, headers),
            writeBody: async (_res, data) => {
                await coreResponse.write(data);
            },
            finish: async () => {
                await coreResponse.end();
            },
            abort: () => {
                try { coreResponse.close(); } catch { /* already closed */ }
            },
        }, serveHook as ResponseAdapterServeHook | null, {
            isBodyForbiddenStatus,
            createHeadersSentError,
            createWriteAfterEndError,
        }, requestId, requestUrl, suppressBody);
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
    backlog?: number;
    listener?: () => void;
}

function normalizeServerListenArgs(
    arg1?: number | ListenOptions | string,
    arg2?: string | number | (() => void),
    arg3?: number | (() => void),
    arg4?: () => void,
): NormalizedServerListenArgs {
    let port: number | undefined;
    let host = '0.0.0.0';
    let backlog: number | undefined;
    let listener: (() => void) | undefined;

    if (typeof arg1 === 'object') {
        const opts = arg1 as ListenOptions;
        port = opts.port;
        host = opts.host ?? host;
        backlog = opts.backlog;
        listener = arg2 as (() => void) | undefined;
        return { port, host, backlog, listener };
    }

    port = typeof arg1 === 'number' ? arg1 : parseInt(arg1 ?? '0');
    if (typeof arg2 === 'function') {
        listener = arg2;
    } else if (typeof arg2 === 'string') {
        host = arg2;
        if (typeof arg3 === 'function') {
            listener = arg3;
        } else if (typeof arg3 === 'number') {
            backlog = arg3;
            if (typeof arg4 === 'function') listener = arg4;
        }
    } else if (typeof arg2 === 'number') {
        backlog = arg2;
        if (typeof arg3 === 'function') listener = arg3;
    }

    return { port, host, backlog, listener };
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
    /** One Node facade per native TCP (keep-alive reuses it). */
    private _httpSocketByTcp = new WeakMap<object, Socket>();

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
            socket.destroy();
        }
        this._httpConnections.clear();
    }

    closeIdleConnections(): void {
        // Core does not expose idle-only sockets yet. Do not stop the listener:
        // Node's closeIdleConnections() never closes the server itself.
    }

    private trackHttpSocket(socket: Socket): void {
        if (this._httpConnections.has(socket)) return;
        this._httpConnections.add(socket);
        socket.once('close', () => {
            this._httpConnections.delete(socket);
        });
    }

    /**
     * Facade for a core-owned TCP. Reused across keep-alive requests on the
     * same handle; destroy closes the HTTP connection via the current res.
     */
    private socketForCoreRequest(tcp: CModuleStreams.TCP, res: HttpResponse): Socket {
        const closeOwned = () => {
            try { res.close(); } catch { /* already closed */ }
        };
        const existing = this._httpSocketByTcp.get(tcp);
        if (existing && !existing.destroyed) {
            existing._httpOwned = { close: closeOwned };
            return existing;
        }
        const socket = createAttachedSocket(tcp, { close: closeOwned });
        this._httpSocketByTcp.set(tcp, socket);
        this.trackHttpSocket(socket);
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
        const { incoming, response } = createServerRequestObjects(nodeSocket);
        applyCoreServerRequest(incoming, req);
        if (incoming.method === 'CONNECT') {
            if (this.listenerCount('connect') <= 0) {
                res.close();
                return;
            }
            try {
                const connectSocket = Socket.fromUpgradeHandle(res.upgrade());
                this.emit('connect', incoming, connectSocket, new Uint8Array(0));
            } catch (err) {
                this.emit('error', err);
            }
            return;
        }
        if (emitNodeServerUpgrade(this, res, incoming)) return;

        pumpIncomingRequestBody(
            incoming,
            typeof req.body === 'function'
                ? async () => {
                    const chunk = await req.body!();
                    return chunk === null ? null : viewToUint8Array(chunk);
                }
                : null,
        );

        const adapter = new NodeResponseAdapter(response, res, serveHook, requestId, requestUrl, incoming.method === 'HEAD');
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
    }

    private _handleNativeRequestError(err: Error, tcpSock: { socket?: unknown } | undefined): void {
        if (isTransportDisconnectError(err)) return;
        // H1 marks parse faults with this prefix (structured kind pending).
        // clientError is the Node-compatible surface for bad request lines.
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
        });
    }

    listen(arg1?: number | ListenOptions | string, arg2?: string | number | (() => void), arg3?: number | (() => void), arg4?: () => void): this {
        // Capture call frames HERE — the user's code is on the stack.
        const listenEntryCallFrames = captureNodeNetworkCallFrames();
        const { port, host: rawHost, listener } = normalizeServerListenArgs(arg1, arg2, arg3, arg4);
        const host = normalizeListenHost(rawHost);

        const handler = async (req: HttpRequest, res: HttpResponse) => {
            await this._handleNativeRequest(req, res, host, listenEntryCallFrames);
        };

        this._httpServer = this._createNativeServer(host, port, handler);
        this._httpServer.onRequestError = (err: Error, tcpSock) => this._handleNativeRequestError(err, tcpSock);
        this._httpServer.listen(); 
        this._listening = true;
        this.listening = true;
        this._httpServer.acceptLoop().catch((err: unknown) => {
            if (this._listening) this.emit('error', err);
        });
        queueMicrotask(() => {
            if (!this._listening) return;
            this.emit('listening');
            listener?.();
        });

        return this;
    }

    close(callback?: (err?: Error) => void): this {
        if (!this._listening) {
            callback?.(new Error('Server is not running'));
            return this;
        }

        this._httpServer?.close();
        super.close(callback);
        this.listening = false;
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

export function validateHeaderName(name: string): void {
    if (!/^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/.test(name)) {
        throw new TypeError(`Header name "${name}" contains invalid characters`);
    }
}

export function validateHeaderValue(name: string, value: string): void {
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
        throw new TypeError(`Invalid character in header content ["${name}"]`);
    }
}
