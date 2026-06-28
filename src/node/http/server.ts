const http = import.meta.use('http');
const text = import.meta.use('text');
const engine = import.meta.use('engine');
const dns = import.meta.use('dns');
const os = import.meta.use('os');

import { Readable, Writable } from '../stream';
import { Socket, Server as NetServer, AddressInfo } from '../net';
import type { HttpRequest, HttpResponse } from '@cnojs/http/server';
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
import type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener } from './types';
import { IOpaque } from '../_internal/inject';
export type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders, IncomingMessage, OutgoingMessage, ServerResponse, ListenOptions, Server, RequestListener } from './types';
const { createServer: createHttpServer } = (http as any).__cno as IOpaque;
const debugNodeHttp = true;

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

    override push(chunk: any, encoding?: BufferEncoding): boolean {
        if (chunk !== null && chunk !== undefined && typeof chunk !== 'string' && this.readableEncoding) {
            chunk = engine.decodeString(chunk as Uint8Array);
        }
        return super.push(chunk, encoding);
    }

    // Push-based stream: data arrives externally, no pull needed
    override _read(_size: number): void {}

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

    protected _requireHeadersNotSent(): void {
        if (this.headersSent) throw new Error('Cannot modify headers after they are sent to the client');
    }

    setHeader(name: string, value: number | string | readonly string[]): this {
        this._requireHeadersNotSent();
        const key = name.toLowerCase();
        this._headerNames.set(key, name);
        this._headers[key] = value as OutgoingHttpHeader;
        return this;
    }

    setHeaders(headers: Headers | Map<string, number | string | readonly string[]>): this {
        this._requireHeadersNotSent();
        for (const [key, value] of headers) {
            this.setHeader(key, value);
        }
        return this;
    }

    appendHeader(name: string, value: string | readonly string[]): this {
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
        this._requireHeadersNotSent();
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

    private _ended: boolean = false;
    private _bodyLength: number = 0;

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
    }

    // Interim (1xx) responses require writing to the socket before the final
    // response. ServerResponseImpl no longer owns the socket — the core
    // @cnojs/http HttpResponse has no interim-write API yet — so these are
    // no-ops. Vite/Connect do not use them. TODO: add an interim-write path to
    // the core HttpResponse and route these through the adapter if needed.
    writeProcessingContinue(): void {}

    writeEarlyHints(_hints: Record<string, string | string[]>, callback?: () => void): void {
        callback?.();
    }

    protected _sendHeaders(): void {
        if (this.headersSent) return;
        // State-only. All socket I/O flows through NodeResponseAdapter ->
        // coreResponse (@cnojs/http), which is rebound onto this instance in
        // ServerImpl.listen() before the request handler runs. This base impl
        // exists only so any pre-override call keeps Node-facing state coherent.
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

        // State-only. NodeResponseAdapter rebinds write() per request and owns
        // all socket I/O via coreResponse (@cnojs/http). This base impl exists
        // only for pre-override calls and must never touch the socket.
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        callback?.();
        return true;
    }

    end(chunk?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
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
    }
}

class NodeResponseAdapter {
    private readonly response: ServerResponseImpl;
    private readonly coreResponse: HttpResponse;
    private readonly serveHook: ReturnType<typeof getNodeServeHook>;
    private readonly requestId: string;
    private readonly requestUrl: string;
    private queue: Promise<void> = Promise.resolve();
    private headWritten = false;

    constructor(
        response: ServerResponseImpl,
        coreResponse: HttpResponse,
        serveHook: ReturnType<typeof getNodeServeHook>,
        requestId: string,
        requestUrl: string,
    ) {
        this.response = response;
        this.coreResponse = coreResponse;
        this.serveHook = serveHook;
        this.requestId = requestId;
        this.requestUrl = requestUrl;
    }

    private enqueue<T>(op: () => Promise<T>): Promise<T> {
        const next = this.queue.then(op, op);
        this.queue = next.then(() => undefined, () => undefined);
        return next;
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

        if (this.headWritten) return this.response;

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
            .catch((err) => this.response.emit('error', err));

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
        if (!this.response.headersSent) {
            this.response.chunkedEncoding = true;
            this.response.setHeader('Transfer-Encoding', 'chunked');
            this.writeHead(this.response.statusCode, this.response.statusMessage);
        }

        try {
            const data = toUint8Array(chunk, engine.encodeString);
            this.enqueue(async () => {
                try { this.serveHook?.onData?.({ requestId: this.requestId, timestamp: nodeTs(), data }); } catch {}
                await this.coreResponse.write(data as Uint8Array);
            }).then(() => callback?.(), (err) => {
                this.response.emit('error', err);
                callback?.(err);
            });
        } catch (err) {
            this.response.emit('error', err);
            callback?.(err as Error);
        }

        return true;
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
            this.response.setHeader('Content-Length', '0');
            this.writeHead(this.response.statusCode, this.response.statusMessage);
        } else if (chunk !== undefined && !this.response.headersSent) {
            const data = toUint8Array(chunk, engine.encodeString);
            this.response.setHeader('Content-Length', String(data.byteLength));
            this.writeHead(this.response.statusCode, this.response.statusMessage);
            chunk = data;
        }

        this.enqueue(async () => {
            if (chunk !== undefined) {
                const data = chunk instanceof Uint8Array ? chunk : toUint8Array(chunk, engine.encodeString);
                try { this.serveHook?.onData?.({ requestId: this.requestId, timestamp: nodeTs(), data }); } catch {}
                await this.coreResponse.end(data as Uint8Array);
            } else {
                await this.coreResponse.end();
            }
        }).then(() => {
            this.response.finished = true;
            this.response.writableFinished = true;
            try { this.serveHook?.onFinished?.({ requestId: this.requestId, timestamp: nodeTs(), success: true }); } catch {}
            this.response.emit('finish');
            callback?.();
        }, (err) => {
            this.response.emit('error', err);
            callback?.();
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
                        incoming.push(null);
                        incoming.complete = true;
                    } catch (err) {
                        incoming.aborted = true;
                        incoming.destroy(err as Error);
                    }
                })().catch(() => {});
            } else {
                incoming.push(null);
                incoming.complete = true;
            }

            const response = new ServerResponseImpl();
            response.req = incoming;
            // NOTE: do NOT call response.setTcp(rawTcp) here. All response bytes
            // must flow through the adapter -> coreResponse (@cnojs/http), which
            // owns the socket. Giving ServerResponseImpl the raw TCP handle too
            // creates two independent writers for one socket, which interleaves
            // header/body/terminator writes and hangs the client mid-response.
            if (nodeSocket) response.assignSocket(nodeSocket);
            const adapter = new NodeResponseAdapter(response, res, serveHook, requestId, requestUrl);
            const responseDone = new Promise<void>((resolve, reject) => {
                response.once('finish', () => resolve());
                response.once('error', (err) => reject(err));
            });
            if (debugNodeHttp) {
                console.log(`[node-http] request ${req.method} ${req.url}`);
                response.once('finish', () => console.log(`[node-http] finish ${req.method} ${req.url} ${response.statusCode}`));
                response.once('error', (err) => console.log(`[node-http] error ${req.method} ${req.url} ${String((err as Error)?.message ?? err)}`));
            }
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
                if (debugNodeHttp) console.log(`[node-http] handler returned ${req.method} ${req.url}`);
                if (!response.writableFinished) {
                    await responseDone;
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

