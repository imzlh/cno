const http = import.meta.use('http');
const text = import.meta.use('text');
const engine = import.meta.use('engine');
const dns = import.meta.use('dns');
const os = import.meta.use('os');

import { Readable, Writable } from '../stream';
import { Socket, Server as NetServer, AddressInfo } from '../net';
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
import { normalizeErrnoError } from '../_internal/errno';
import type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener } from './types';
import { IOpaque } from '../_internal/inject';
export type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener } from './types';
const { createServer: createHttpServer } = (http as any).__cno as IOpaque;

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

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

function isBodyForbiddenStatus(statusCode: number): boolean {
    return (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304;
}

function createHeadersSentError(message = 'Cannot write headers after they are sent to the client'): Error & { code: string } {
    return Object.assign(new Error(message), {
        code: 'ERR_HTTP_HEADERS_SENT',
    });
}

function createWriteAfterEndError(): Error & { code: string } {
    return Object.assign(new Error('write after end'), {
        code: 'ERR_STREAM_WRITE_AFTER_END',
    });
}

function createAttachedSocket(tcp: CModuleStreams.TCP): Socket {
    const socket = new Socket();
    const localInfo = tcp.sockname;
    const remoteInfo = tcp.peername;

    (socket as any)._tcp = tcp;
    socket.readyState = 'open';
    socket.localAddress = localInfo.ip;
    socket.localPort = localInfo.port;
    socket.remoteAddress = remoteInfo.ip;
    socket.remotePort = remoteInfo.port;
    socket.remoteFamily = `IPv${remoteInfo.family}`;

    return socket;
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
    new (socket: Socket | null): IncomingMessageImpl;
    (socket: Socket | null): IncomingMessageImpl;
    prototype: IncomingMessageImpl;
}

function initIncomingMessage(self: any, socket: Socket | null): void {
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

export const IncomingMessageImpl: IncomingMessageImplConstructor = function IncomingMessageImpl(this: any, socket: Socket | null) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(IncomingMessageImpl.prototype);
    initIncomingMessage(target, socket);
    return target;
} as IncomingMessageImplConstructor;

Object.setPrototypeOf(IncomingMessageImpl, Readable);
IncomingMessageImpl.prototype = Object.create(Readable.prototype);

IncomingMessageImpl.prototype.push = function push(this: IncomingMessageImpl, chunk: any, encoding?: BufferEncoding): boolean {
    if (chunk !== null && chunk !== undefined && typeof chunk !== 'string' && this.readableEncoding) {
        chunk = engine.decodeString(chunk as Uint8Array);
    }
    return Readable.prototype.push.call(this, chunk, encoding);
};

// Push-based stream: data arrives externally, no pull needed
IncomingMessageImpl.prototype._read = function _read(this: IncomingMessageImpl, _size: number): void {};

Object.defineProperty(IncomingMessageImpl.prototype, 'connection', {
    get(this: IncomingMessageImpl): Socket | null {
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

function initOutgoingMessage(self: any): void {
    Writable.call(self);
    self.socket = null;
    self.writableEnded = false;
    self.writableFinished = false;
    self.headersSent = false;
    self.sendDate = true;
    self.finished = false;
    self.chunkedEncoding = false;
    self.shouldKeepAlive = false;
    self.useChunkedEncodingByDefault = true;

    self._headers = {};
    self._headerNames = new Map();
    self._trailers = {};
    self._rawHeaderNames = [];
}

export const OutgoingMessageImpl: OutgoingMessageImplConstructor = function OutgoingMessageImpl(this: any) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(OutgoingMessageImpl.prototype);
    initOutgoingMessage(target);
    return target;
} as OutgoingMessageImplConstructor;

Object.setPrototypeOf(OutgoingMessageImpl, Writable);
OutgoingMessageImpl.prototype = Object.create(Writable.prototype);

Object.defineProperty(OutgoingMessageImpl.prototype, 'connection', {
    get(this: OutgoingMessageImpl): Socket | null {
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
    const key = name.toLowerCase();
    this._headerNames.set(key, name);
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
    const key = name.toLowerCase();
    const existing = this._headers[key];
    if (existing === undefined) {
        this._headerNames.set(key, name);
        this._headers[key] = Array.isArray(value) ? value : [value];
    } else if (Array.isArray(existing)) {
        this._headers[key] = [...existing, ...(Array.isArray(value) ? value : [value])];
    } else {
        this._headers[key] = [existing as string, ...(Array.isArray(value) ? value : [value])];
    }
    return this;
};

OutgoingMessageImpl.prototype.getHeader = function getHeader(this: OutgoingMessageImpl, name: string): number | string | string[] | undefined {
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
    assignSocket(socket: Socket): void;
    detachSocket(socket: Socket): void;
}

export interface ServerResponseImplConstructor {
    new (): ServerResponseImpl;
    (): ServerResponseImpl;
    prototype: ServerResponseImpl;
}

function initServerResponse(self: any): void {
    OutgoingMessageImpl.call(self);
    self.statusCode = 200;
    self.statusMessage = 'OK';
    self.strictContentLength = false;
    self.req = null;

    self._ended = false;
    self._bodyLength = 0;
}

export const ServerResponseImpl: ServerResponseImplConstructor = function ServerResponseImpl(this: any) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(ServerResponseImpl.prototype);
    initServerResponse(target);
    return target;
} as ServerResponseImplConstructor;

Object.setPrototypeOf(ServerResponseImpl, OutgoingMessageImpl);
ServerResponseImpl.prototype = Object.create(OutgoingMessageImpl.prototype);

ServerResponseImpl.prototype.assignSocket = function assignSocket(this: ServerResponseImpl, socket: Socket): void {
    this.socket = socket;
    socket.once('close', () => {
        this.socket = null;
    });
};

ServerResponseImpl.prototype.detachSocket = function detachSocket(this: ServerResponseImpl, socket: Socket): void {
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
        this.statusMessage = statusMessageOrHeaders;
    } else if (statusMessageOrHeaders !== undefined) {
        headers = statusMessageOrHeaders;
    }

    if (headers) {
        if (Array.isArray(headers)) {
            for (let i = 0; i < headers.length; i += 2) {
                this.setHeader(headers[i], headers[i + 1]);
            }
        } else {
            for (const [key, value] of Object.entries(headers)) {
                if (value !== undefined) this.setHeader(key, value);
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
// no-ops. Vite/Connect do not use them. TODO: add an interim-write path to
// the core HttpResponse and route these through the adapter if needed.
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
    chunk: any,
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
    const encoder = new text!.Encoder(encoding);
    const data = typeof chunk === 'string' ? encoder.encode(chunk) : chunk as Uint8Array;
    this._bodyLength += data.length;

    // State-only. NodeResponseAdapter rebinds write() per request and owns
    // all socket I/O via coreResponse (@cnojs/http). This base impl exists
    // only for pre-override calls and must never touch the socket.
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    callback?.();
    return true;
};

ServerResponseImpl.prototype.end = function end(this: ServerResponseImpl, chunk?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): ServerResponseImpl {
    let callback: (() => void) | undefined;
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    else if (typeof encodingOrCb === 'function') { callback = encodingOrCb; }
    else if (typeof cb === 'function') { callback = cb; }

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

class NodeResponseAdapter {
    private readonly response: ServerResponseImpl;
    private readonly coreResponse: HttpResponse;
    private readonly serveHook: ReturnType<typeof getNodeServeHook>;
    private readonly requestId: string;
    private readonly requestUrl: string;
    private queue: Promise<void> = Promise.resolve();
    private headWritten = false;
    private closed = false;
    private failed = false;
    private finished = false;
    private pendingBytes = 0;
    private needDrain = false;
    private suppressBody: boolean;

    constructor(
        response: ServerResponseImpl,
        coreResponse: HttpResponse,
        serveHook: ReturnType<typeof getNodeServeHook>,
        requestId: string,
        requestUrl: string,
        suppressBody = false,
    ) {
        this.response = response;
        this.coreResponse = coreResponse;
        this.serveHook = serveHook;
        this.requestId = requestId;
        this.requestUrl = requestUrl;
        this.suppressBody = suppressBody;
        this.response.socket?.once('close', () => {
            this.closed = true;
            if (!this.finished && !this.failed) {
                this.fail(Object.assign(new Error('socket closed before response finished'), {
                    code: 'ECONNRESET',
                    syscall: 'write',
                }));
            }
        });
    }

    private enqueue<T>(op: () => Promise<T>): Promise<T> {
        const next = this.queue.then(async () => {
            if (this.closed || this.failed) {
                throw Object.assign(new Error('socket closed before response write completed'), {
                    code: 'ECONNRESET',
                    syscall: 'write',
                });
            }
            return op();
        }, async () => {
            if (this.closed || this.failed) {
                throw Object.assign(new Error('socket closed before response write completed'), {
                    code: 'ECONNRESET',
                    syscall: 'write',
                });
            }
            return op();
        });
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }

    private shouldSuppressBody(): boolean {
        return this.suppressBody || isBodyForbiddenStatus(this.response.statusCode);
    }

    private fail(err: unknown, callback?: (err?: Error | null) => void): void {
        const error = normalizeErrnoError(err);
        if (this.failed) {
            callback?.(error);
            return;
        }
        this.closed = true;
        this.failed = true;
        if (!this.response.writableEnded) {
            this.response.writableEnded = true;
        }
        this.response.emit('close');
        try {
            this.serveHook?.onFinished?.({
                requestId: this.requestId,
                timestamp: nodeTs(),
                success: false,
                errorText: String(error.message ?? error),
            });
        } catch {}
        this.response.emit('error', error);
        callback?.(error);
    }

    private collectHeaders(): Array<[string, string]> {
        const allHeaders: Array<[string, string]> = [];

        for (const [key, value] of Object.entries(this.response.getHeaders())) {
            if (Array.isArray(value)) {
                for (const item of value) allHeaders.push([key, String(item)]);
            } else {
                allHeaders.push([key, String(value)]);
            }
        }

        return allHeaders;
    }

    writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | OutgoingHttpHeaders | readonly string[],
        headers?: OutgoingHttpHeaders | readonly string[],
    ): ServerResponseImpl {
        if (this.headWritten || this.response.headersSent) {
            throw createHeadersSentError();
        }

        this.response.statusCode = statusCode;
        if (typeof statusMessageOrHeaders === 'string') {
            this.response.statusMessage = statusMessageOrHeaders;
        }

        if (typeof statusMessageOrHeaders === 'object' && statusMessageOrHeaders !== null) {
            if (Array.isArray(statusMessageOrHeaders)) {
                for (let i = 0; i < statusMessageOrHeaders.length; i += 2) {
                    this.response.setHeader(String(statusMessageOrHeaders[i]), String(statusMessageOrHeaders[i + 1]));
                }
            } else {
                for (const [key, value] of Object.entries(statusMessageOrHeaders)) {
                    if (value !== undefined) this.response.setHeader(key, value);
                }
            }
        } else if (headers) {
            if (Array.isArray(headers)) {
                for (let i = 0; i < headers.length; i += 2) {
                    this.response.setHeader(String(headers[i]), String(headers[i + 1]));
                }
            } else {
                for (const [key, value] of Object.entries(headers)) {
                    if (value !== undefined) this.response.setHeader(key, value);
                }
            }
        }

        if (!this.response.hasHeader('date') && this.response.sendDate) {
            this.response.setHeader('Date', new Date().toUTCString());
        }

        if (
            !this.shouldSuppressBody() &&
            !this.response.hasHeader('content-length') &&
            !this.response.hasHeader('transfer-encoding')
        ) {
            this.response.chunkedEncoding = true;
            this.response.setHeader('Transfer-Encoding', 'chunked');
        }

        const outHeaders = this.collectHeaders();
        this.response.headersSent = true;
        this.headWritten = true;

        try {
            this.serveHook?.onResponse?.({
                requestId: this.requestId,
                timestamp: nodeTs(),
                url: this.requestUrl,
                status: this.response.statusCode,
                statusText: this.response.statusMessage,
                headers: normalizeHeaderRecord(this.response.getHeaders()),
            });
        } catch {}

        this.enqueue(() => this.coreResponse.writeHead(this.response.statusCode, this.response.statusMessage, outHeaders))
            .catch((err) => this.fail(err));

        return this.response;
    }

    flushHeaders(): void {
        if (this.response.headersSent) return;
        if (
            !isBodyForbiddenStatus(this.response.statusCode) &&
            !this.response.hasHeader('content-length') &&
            !this.response.hasHeader('transfer-encoding')
        ) {
            this.response.chunkedEncoding = true;
            this.response.setHeader('Transfer-Encoding', 'chunked');
        }
        this.writeHead(this.response.statusCode, this.response.statusMessage);
    }

    write(chunk: any, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean {
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
        if (this.response.writableEnded) {
            const err = createWriteAfterEndError();
            callback?.(err);
            queueMicrotask(() => this.response.emit('error', err));
            return false;
        }
        if (!this.response.headersSent) {
            if (
                !this.shouldSuppressBody() &&
                !this.response.hasHeader('content-length') &&
                !this.response.hasHeader('transfer-encoding')
            ) {
                this.response.chunkedEncoding = true;
                this.response.setHeader('Transfer-Encoding', 'chunked');
            }
            this.writeHead(this.response.statusCode, this.response.statusMessage);
        }

        try {
            const encodeString = encoding ? (value: string) => new text!.Encoder(encoding).encode(value) : engine.encodeString;
            const data = toUint8Array(chunk, encodeString);
            if (this.shouldSuppressBody()) {
                callback?.();
                return true;
            }
            this.pendingBytes += data.byteLength;
            this.enqueue(async () => {
                try { this.serveHook?.onData?.({ requestId: this.requestId, timestamp: nodeTs(), data }); } catch {}
                await this.coreResponse.write(data as Uint8Array);
            }).then(() => { this.settleWrite(data.byteLength); callback?.(); }, (err) => {
                this.settleWrite(data.byteLength);
                this.fail(err, callback);
            });
        } catch (err) {
            this.fail(err, callback);
        }

        // Mirrors Writable's highWaterMark contract: once queued bytes catch
        // up (settleWrite), a pipe() source paused on this return value needs
        // an actual 'drain' — see needDrain/settleWrite.
        const ok = this.pendingBytes < this.response.writableHighWaterMark;
        if (!ok) this.needDrain = true;
        return ok;
    }

    private settleWrite(byteLength: number): void {
        this.pendingBytes -= byteLength;
        if (this.needDrain && this.pendingBytes <= 0) {
            this.needDrain = false;
            this.response.emit('drain');
        }
    }

    end(chunk?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): ServerResponseImpl {
        let callback: (() => void) | undefined;
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = undefined;
        } else if (typeof encodingOrCb === 'function') {
            callback = encodingOrCb;
        } else {
            callback = cb;
        }

        if (this.response.writableEnded) {
            callback?.();
            return this.response;
        }

        this.response.writableEnded = true;

        if (chunk === undefined && !this.response.headersSent) {
            if (
                !this.shouldSuppressBody() &&
                !this.response.hasHeader('content-length') &&
                !this.response.hasHeader('transfer-encoding')
            ) {
                this.response.setHeader('Content-Length', '0');
            }
            this.writeHead(this.response.statusCode, this.response.statusMessage);
        } else if (chunk !== undefined && !this.response.headersSent) {
            const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
            const encodeString = encoding ? (value: string) => new text!.Encoder(encoding).encode(value) : engine.encodeString;
            const data = toUint8Array(chunk, encodeString);
            if (
                !this.shouldSuppressBody() &&
                !this.response.hasHeader('content-length') &&
                !this.response.hasHeader('transfer-encoding')
            ) {
                this.response.setHeader('Content-Length', String(data.byteLength));
            }
            this.writeHead(this.response.statusCode, this.response.statusMessage);
            chunk = data;
        }

        this.enqueue(async () => {
            if (chunk !== undefined && !this.shouldSuppressBody()) {
                const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
                const encodeString = encoding ? (value: string) => new text!.Encoder(encoding).encode(value) : engine.encodeString;
                const data = chunk instanceof Uint8Array ? chunk : toUint8Array(chunk, encodeString);
                try { this.serveHook?.onData?.({ requestId: this.requestId, timestamp: nodeTs(), data }); } catch {}
                await this.coreResponse.end(data as Uint8Array);
            } else {
                await this.coreResponse.end();
            }
        }).then(() => {
            this.finished = true;
            this.response.finished = true;
            this.response.writableFinished = true;
            try { this.serveHook?.onFinished?.({ requestId: this.requestId, timestamp: nodeTs(), success: true }); } catch {}
            this.response.emit('finish');
            callback?.();
        }, (err) => {
            this.fail(err, callback as ((err?: Error | null) => void) | undefined);
        });

        return this.response;
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

    constructor(options: ServerOptions | RequestListener, requestListener?: RequestListener) {
        super();
        if (typeof options === 'function') {
            this._requestListener = options;
            this._options = {};
        } else {
            this._options = options || {};
            this._requestListener = requestListener!;
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
        for (const socket of this._httpConnections) {
            socket.destroy();
        }
        this._httpConnections.clear();
        this._httpServer?.close();
    }

    closeIdleConnections(): void {
        // Native server manages connections internally; close idle via native API
        this._httpServer?.close();
    }

    listen(arg1?: number | ListenOptions | string, arg2?: string | number | (() => void), arg3?: number | (() => void), arg4?: () => void): this {
        // Capture call frames HERE — the user's code is on the stack.
        const listenEntryCallFrames = captureNodeNetworkCallFrames();
        let port: number | undefined;
        let host = '0.0.0.0';
        let backlog: number | undefined;
        let listener: (() => void) | undefined;

        if (typeof arg1 === 'object') {
            const opts = arg1 as ListenOptions;
            port = opts.port;
            host = opts.host ?? '0.0.0.0';
            backlog = opts.backlog;
            listener = arg2 as (() => void) | undefined;
        } else {
            port = typeof arg1 == 'number' ? arg1 : parseInt(arg1 ?? '0');
            if (typeof arg2 === 'function') listener = arg2;
            else if (typeof arg2 === 'string') {
                host = arg2;
                if (typeof arg3 === 'function') listener = arg3;
                else if (typeof arg3 === 'number') {
                    backlog = arg3;
                    if (typeof arg4 === 'function') listener = arg4;
                }
            } else if (typeof arg2 === 'number') {
                backlog = arg2;
                if (typeof arg3 === 'function') listener = arg3;
            }
        }

        const handler = async (req: HttpRequest, res: HttpResponse) => {
            const serveHook = getNodeServeHook();
            const requestId = nextNodeRequestId('node-serve');
            const requestStartTime = nodeTs();
            const requestCallFrames = listenEntryCallFrames ?? captureNodeNetworkCallFrames();
            const requestHeaders = headerEntriesToRecord(req.headers);
            const requestUrl = buildNodeServerUrl('http:', req.url, requestHeaders, host);
            const rawTcp = ((req as any).__cnoTcp ?? (res as any).__cnoTcp) as CModuleStreams.TCP | undefined;
            const nodeSocket = rawTcp ? createAttachedSocket(rawTcp) : null;
            const incoming = new IncomingMessageImpl(nodeSocket);
            incoming.method = req.method;
            incoming.url = req.url;
            incoming.httpVersion = req.httpVersion;
            const [major, minor] = req.httpVersion.split('.').map(Number);
            incoming.httpVersionMajor = major;
            incoming.httpVersionMinor = minor;

            for (const [key, value] of req.headers) {
                const lowerKey = key.toLowerCase();
                incoming.headers[lowerKey as keyof IncomingHttpHeaders] = value;
                incoming.rawHeaders.push(key, value);
                if (!incoming.headersDistinct[lowerKey]) {
                    incoming.headersDistinct[lowerKey] = [];
                }
                incoming.headersDistinct[lowerKey]!.push(value);
            }

            // WebSocket / protocol upgrade. If the request carries Connection:
            // upgrade + an Upgrade header and the server has an 'upgrade'
            // listener, hand the raw socket off via the core upgrade() handle
            // and emit Node's 'upgrade' event. The core handle replays any bytes
            // the HTTP parser already buffered, so the first WS frames survive.
            const connectionHeader = String(incoming.headers['connection'] ?? '').toLowerCase();
            const isUpgrade = connectionHeader.split(',').some(t => t.trim() === 'upgrade')
                && incoming.headers['upgrade'] !== undefined;
            if (isUpgrade && this.listenerCount('upgrade') > 0) {
                try {
                    const handle = (res as any).upgrade();
                    const upgradeSocket = Socket.fromUpgradeHandle(handle);
                    // Node passes any already-buffered post-header bytes as `head`.
                    // The core handle replays them through the read pump, so we
                    // pass an empty head to avoid double-delivery.
                    this.emit('upgrade', incoming, upgradeSocket, new Uint8Array(0));
                } catch (err) {
                    this.emit('error', err);
                }
                return;
            }

            const requestBody = req.body;
            if (typeof requestBody === 'function') {
                (async () => {
                    try {
                        while (true) {
                            const chunk = await requestBody();
                            if (chunk === null) break;
                            incoming.push(chunk);
                        }
                        incoming.complete = true;
                        incoming.push(null);
                    } catch (err) {
                        incoming.aborted = true;
                        incoming.destroy(err as Error);
                    }
                })().catch(() => {});
            } else {
                incoming.complete = true;
                incoming.push(null);
            }

            const response = new ServerResponseImpl();
            response.req = incoming;
            // NOTE: do NOT call response.setTcp(rawTcp) here. All response bytes
            // must flow through the adapter -> coreResponse (@cnojs/http), which
            // owns the socket. Giving ServerResponseImpl the raw TCP handle too
            // creates two independent writers for one socket, which interleaves
            // header/body/terminator writes and hangs the client mid-response.
            if (nodeSocket) response.assignSocket(nodeSocket);
            const adapter = new NodeResponseAdapter(response, res, serveHook, requestId, requestUrl, incoming.method === 'HEAD');
            let responseDoneError: unknown;
            const responseDone = new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    response.off('finish', onFinish);
                    response.off('error', onError);
                };
                const onFinish = () => {
                    cleanup();
                    resolve();
                };
                const onError = (err: any) => {
                    if (err?.code === 'ERR_STREAM_WRITE_AFTER_END' && response.writableEnded) {
                        return;
                    }
                    cleanup();
                    reject(err);
                };
                response.on('finish', onFinish);
                response.on('error', onError);
            });
            const responseDoneObserved = responseDone.catch((err) => {
                responseDoneError = err;
            });
            try {
                serveHook?.onRequest?.({
                    requestId,
                    timestamp: requestStartTime,
                    url: requestUrl,
                    method: req.method,
                    headers: requestHeaders,
                    postData: req.body instanceof Uint8Array ? req.body : undefined,
                    callFrames: requestCallFrames,
                });
            } catch {}
            response.writeHead = adapter.writeHead.bind(adapter) as any;
            response.flushHeaders = adapter.flushHeaders.bind(adapter) as any;
            response.write = adapter.write.bind(adapter) as any;
            response.end = adapter.end.bind(adapter) as any;

            try {
                await this._requestListener(incoming, response);
                if (!response.writableFinished) {
                    await responseDoneObserved;
                    if (responseDoneError !== undefined) throw responseDoneError;
                }
            } catch (err) {
                try { serveHook?.onFinished?.({ requestId, timestamp: nodeTs(), success: false, errorText: String((err as Error)?.message ?? err) }); } catch {}
                // Send 500 if response wasn't already sent
                if (!response.headersSent) {
                    try { response.writeHead(500); } catch {}
                    try { response.end(); } catch {}
                }
                this.emit('error', err);
            }
        };

        host = normalizeListenHost(host);

        const createNativeServer = (hostname: string) => createHttpServer(handler, {
            port: port ?? 0,
            hostname,
            keepAliveTimeout: this.keepAliveTimeout,
            maxRequestsPerConnection: this.maxRequestsPerSocket || 100,
            requestTimeout: this.requestTimeout,
        });

        this._httpServer = createNativeServer(host);
        this._httpServer.onRequestError = (err: Error, tcpSock) => {
            const message = String((err as any)?.message ?? err);
            if (/^Parse error:/.test(message)) {
                let clientSocket: Socket | null = null;
                try { if (tcpSock?.socket) clientSocket = createAttachedSocket(tcpSock.socket); } catch {}
                this.emit('clientError', err, clientSocket);
                return;
            }
            this.emit('error', err);
        };
        this._httpServer.listen(); 
        this._listening = true;
        this.listening = true;
        this._httpServer.acceptLoop().catch((err: unknown) => {
            if (this._listening) this.emit('error', err);
        });
        this.emit('listening');
        listener?.();

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
    if (/[^\t\u0020-\u007E\u0080-\u00FF]/.test(value)) {
        throw new TypeError(`Invalid character in header content ["${name}"]`);
    }
}
