const engine = import.meta.use('engine');
const http = import.meta.use('http');
const text = import.meta.use('text');

import { Readable, Writable } from '../stream';
import { Socket, Server as NetServer, AddressInfo } from '../net';
import type { HttpRequest, HttpResponse } from '@cnojs/http/server';
import { IOpaque } from '../_internal/inject';
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
import { STATUS_CODES, METHODS } from './constants';
import type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener } from './types';
export type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener } from './types';
const { createServer: createHttpServer } = (http as any).__cno as IOpaque;

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

// Re-export from shared constants (single source of truth)
export { STATUS_CODES, METHODS } from './constants';

export class IncomingMessageImpl extends Readable implements IncomingMessage {
    socket: Socket | null;
    httpVersion: string = '1.1';
    httpVersionMajor: number = 1;
    httpVersionMinor: number = 1;
    complete: boolean = false;
    headers: IncomingHttpHeaders = {};
    headersDistinct: NodeJS.Dict<string[]> = {};
    rawHeaders: string[] = [];
    trailers: NodeJS.Dict<string> = {};
    trailersDistinct: NodeJS.Dict<string[]> = {};
    rawTrailers: string[] = [];
    aborted: boolean = false;
    method?: string;
    url?: string;
    statusCode?: number;
    statusMessage?: string;

    constructor(socket: Socket | null) {
        super();
        this.socket = socket;
    }

    get connection(): Socket | null {
        return this.socket;
    }

    setTimeout(msecs: number, callback?: () => void): this {
        this.socket?.setTimeout(msecs, callback);
        return this;
    }

    destroy(error?: Error): this {
        this.aborted = true;
        super.destroy(error);
        return this;
    }
}

export class OutgoingMessageImpl extends Writable implements OutgoingMessage {
    socket: Socket | null = null;
    writableEnded: boolean = false;
    writableFinished: boolean = false;
    headersSent: boolean = false;
    sendDate: boolean = true;
    finished: boolean = false;
    chunkedEncoding: boolean = false;
    shouldKeepAlive: boolean = false;
    useChunkedEncodingByDefault: boolean = true;

    protected _headers: OutgoingHttpHeaders = {};
    protected _headerNames: Map<string, string> = new Map();
    protected _trailers: OutgoingHttpHeaders = {};
    protected _rawHeaderNames: string[] = [];

    get connection(): Socket | null {
        return this.socket;
    }

    setTimeout(msecs: number, callback?: () => void): this {
        if (this.socket) this.socket.setTimeout(msecs, callback);
        else if (callback) this.once('socket', () => this.socket?.setTimeout(msecs, callback));
        return this;
    }

    setHeader(name: string, value: number | string | readonly string[]): this {
        if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
        const key = name.toLowerCase();
        this._headerNames.set(key, name);
        this._headers[key] = value as OutgoingHttpHeader;
        return this;
    }

    setHeaders(headers: Headers | Map<string, number | string | readonly string[]>): this {
        if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
        for (const [key, value] of headers) {
            this.setHeader(key, value);
        }
        return this;
    }

    appendHeader(name: string, value: string | readonly string[]): this {
        if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
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
    }

    getHeader(name: string): number | string | string[] | undefined {
        return this._headers[name.toLowerCase()];
    }

    getHeaders(): OutgoingHttpHeaders {
        return { ...this._headers };
    }

    getHeaderNames(): string[] {
        return Object.keys(this._headers);
    }

    getRawHeaderNames(): string[] {
        return [...this._rawHeaderNames];
    }

    hasHeader(name: string): boolean {
        return this._headers[name.toLowerCase()] !== undefined;
    }

    removeHeader(name: string): void {
        if (this.headersSent) throw new Error('Cannot remove headers after they are sent to the client');
        const key = name.toLowerCase();
        delete this._headers[key];
        this._headerNames.delete(key);
    }

    addTrailers(headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void {
        if (Array.isArray(headers)) {
            for (const [key, value] of headers) {
                this._trailers[key.toLowerCase()] = value;
            }
        } else {
            for (const [key, value] of Object.entries(headers)) {
                if (value !== undefined) this._trailers[key.toLowerCase()] = value;
            }
        }
    }

    flushHeaders(): void {
        if (!this.headersSent) this._sendHeaders();
    }

    protected _formatHeaders(): string {
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
    }

    protected _sendHeaders(): void {
        this.headersSent = true;
    }
}

export class ServerResponseImpl extends OutgoingMessageImpl implements ServerResponse {
    statusCode: number = 200;
    statusMessage: string = 'OK';
    strictContentLength: boolean = false;
    req: IncomingMessage | null = null;

    private _tcp: CModuleStreams.TCP | null = null;
    private _ended: boolean = false;
    private _bodyLength: number = 0;

    setTcp(tcp: CModuleStreams.TCP): void {
        this._tcp = tcp;
    }

    assignSocket(socket: Socket): void {
        this.socket = socket;
        socket.on('close', () => {
            this.socket = null;
        });
    }

    detachSocket(socket: Socket): void {
        this.socket = null;
    }

    writeHead(statusCode: number, statusMessageOrHeaders?: string | OutgoingHttpHeaders | readonly string[], headers?: OutgoingHttpHeaders | readonly string[]): this {
        if (this.headersSent) throw new Error('Cannot write headers after they are sent to the client');

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
    }

    writeProcessingContinue(): void {
        if (this._tcp && !this.headersSent) {
            const version = this.req?.httpVersion || '1.1';
            this._tcp.write(engine.encodeString(`HTTP/${version} 100 Continue\r\n\r\n`));
        }
    }

    writeEarlyHints(hints: Record<string, string | string[]>, callback?: () => void): void {
        if (this._tcp && !this.headersSent) {
            const version = this.req?.httpVersion || '1.1';
            let message = `HTTP/${version} 103 Early Hints\r\n`;
            for (const [key, value] of Object.entries(hints)) {
                if (Array.isArray(value)) {
                    for (const v of value) message += `${key}: ${v}\r\n`;
                } else {
                    message += `${key}: ${value}\r\n`;
                }
            }
            message += '\r\n';
            this._tcp.write(engine.encodeString(message)).then(() => callback?.());
        }
    }

    protected _sendHeaders(): void {
        if (this.headersSent || !this._tcp) return;

        const version = (this as any).req?.httpVersion || '1.1';
        let headerStr = `HTTP/${version} ${this.statusCode} ${this.statusMessage}\r\n`;
        headerStr += this._formatHeaders();
        headerStr += '\r\n';

        this._tcp.write(engine.encodeString(headerStr));
        super._sendHeaders();
    }

    write(chunk: any, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean {
        if (this._ended) {
            const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
            callback?.(new Error('write after end'));
            return false;
        }

        if (!this.headersSent) {
            this.chunkedEncoding = true;
            this.setHeader('Transfer-Encoding', 'chunked');
            this._sendHeaders();
        }

        const encoder = new text!.Encoder(encodingOrCb as BufferEncoding);
        const data = typeof chunk === 'string' ? encoder.encode(chunk) : chunk as Uint8Array;
        this._bodyLength += data.length;

        if (this.chunkedEncoding && this._tcp) {
            const header = engine.encodeString(data.length.toString(16) + '\r\n');
            const trailer = engine.encodeString('\r\n');
            const frame = new Uint8Array(header.length + data.length + trailer.length);
            frame.set(header, 0);
            frame.set(data, header.length);
            frame.set(trailer, header.length + data.length);
            this._tcp.write(frame);
        } else if (this._tcp) {
            this._tcp.write(data);
        }

        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        callback?.();
        return true;
    }

    end(chunk?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
        let callback: (() => void) | undefined;
        if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
        else if (typeof encodingOrCb === 'function') { callback = encodingOrCb; }
        else if (typeof cb === 'function') { callback = cb; }

        const encoder = new text!.Encoder(encodingOrCb as BufferEncoding);

        if (this._ended) {
            callback?.();
            return this;
        }

        const doEnd = async () => {
            if (!this._tcp) return;
            try {
                if (chunk !== undefined) {
                    const data = typeof chunk === 'string' ? encoder.encode(chunk) : chunk as Uint8Array;
                    if (!this.headersSent) {
                        this.setHeader('Content-Length', data.length);
                        this._sendHeaders();
                        await this._tcp.write(data);
                    } else if (this.chunkedEncoding) {
                        await this._tcp.write(engine.encodeString(data.length.toString(16) + '\r\n'));
                        await this._tcp.write(data);
                        await this._tcp.write(engine.encodeString('\r\n'));
                    } else {
                        await this._tcp.write(data);
                    }
                } else if (!this.headersSent) {
                    this.setHeader('Content-Length', '0');
                    this._sendHeaders();
                }

                if (this.chunkedEncoding) {
                    await this._tcp.write(engine.encodeString('0\r\n\r\n'));
                }

                this._ended = true;
                this.writableEnded = true;
                this.finished = true;
                this.writableFinished = true;
                this.emit('finish');
                callback?.();
            } catch (err) {
                this.emit('error', err);
                callback?.();
            }
        };

        doEnd();
        return this;
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

    private _httpServer: any = null;
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
            const incoming = new IncomingMessageImpl(null);
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

            const requestBody = req.body;
            if (requestBody instanceof Uint8Array) {
                incoming.push(requestBody);
                incoming.push(null);
                incoming.complete = true;
            } else if (requestBody instanceof ReadableStream) {
                (async () => {
                    const reader = requestBody.getReader();
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            incoming.push(value);
                        }
                        incoming.push(null);
                        incoming.complete = true;
                    } catch (err) {
                        incoming.aborted = true;
                        incoming.destroy(err as Error);
                    } finally {
                        reader.releaseLock();
                    }
                })().catch(() => {});
            }

            const response = new ServerResponseImpl();
            response.req = incoming;
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

            const originalWrite = response.write.bind(response);
            response.write = ((chunk: any, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
                const result = originalWrite(chunk, encodingOrCb as any, cb as any);
                try {
                    const data = toUint8Array(chunk, engine.encodeString);
                    serveHook?.onData?.({ requestId, timestamp: nodeTs(), data });
                } catch {}
                return result;
            }) as any;

            let responseReported = false;
            const reportResponse = () => {
                if (responseReported) return;
                responseReported = true;
                serveHook?.onResponse?.({
                    requestId,
                    timestamp: nodeTs(),
                    url: requestUrl,
                    status: response.statusCode,
                    statusText: response.statusMessage,
                    headers: normalizeHeaderRecord(response.getHeaders()),
                });
            };

            const originalWriteHead = response.writeHead.bind(response);
            response.writeHead = ((...args: Parameters<typeof originalWriteHead>) => {
                const result = originalWriteHead(...args);
                try { reportResponse(); } catch {}
                return result;
            }) as typeof response.writeHead;

            const originalEnd = response.end.bind(response);
            response.end = ((...args: any[]) => {
                const result = originalEnd(...args);
                try {
                    reportResponse();
                    const chunk = args[0];
                    if (chunk !== undefined) {
                        const data = toUint8Array(chunk, engine.encodeString);
                        serveHook?.onData?.({ requestId, timestamp: nodeTs(), data });
                    }
                    serveHook?.onFinished?.({ requestId, timestamp: nodeTs(), success: true });
                } catch {}
                return result;
            }) as any;

            try {
                await this._requestListener(incoming, response);
            } catch (err) {
                try { serveHook?.onFinished?.({ requestId, timestamp: nodeTs(), success: false, errorText: String((err as Error)?.message ?? err) }); } catch {}
                this.emit('error', err);
            }
        };

        this._httpServer = createHttpServer(handler, {
            port: port ?? 0,
            hostname: host,
            keepAliveTimeout: this.keepAliveTimeout,
            maxRequestsPerConnection: this.maxRequestsPerSocket || 100,
            requestTimeout: this.requestTimeout,
        });

        this._httpServer.listen();
        this.listening = true;
        this.emit('listening');
        listener?.();

        this._httpServer.acceptLoop();

        return this;
    }

    close(callback?: (err?: Error) => void): this {
        this.listening = false;
        this._httpServer?.close();
        super.close(callback);
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

