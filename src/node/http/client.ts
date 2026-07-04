/**
 * Node.js http module - client implementation
 */

const engine = import.meta.use('engine');
const dns = import.meta.use('dns');
const streams = import.meta.use('streams');
const timers = import.meta.use('timers');
const http = import.meta.use('http');
const os = import.meta.use('os');

import { concatChunks } from '../_internal/buffer';
import {
    buildNodeUrl,
    captureNodeNetworkCallFrames,
    getNodeFetchHook,
    nextNodeRequestId,
    nodeTs,
    normalizeHeaderRecord,
    setupResponseParser,
} from '../_internal/network-debug';
import { normalizeErrnoError } from '../_internal/errno';
import { Socket } from '../net';
import { IncomingMessageImpl, OutgoingHttpHeaders, OutgoingMessageImpl } from './server';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export { METHODS } from './constants';

export interface ClientRequestArgs {
    _defaultAgent?: Agent;
    agent?: Agent | boolean;
    auth?: string | null;
    createConnection?: (options: ClientRequestArgs, oncreate: (err: Error | null, socket: Socket) => void) => Socket | null;
    defaultPort?: number | string;
    family?: number;
    headers?: OutgoingHttpHeaders | readonly string[];
    host?: string | null;
    hostname?: string | null;
    insecureHTTPParser?: boolean;
    localAddress?: string;
    localPort?: number;
    lookup?: (hostname: string, options: any, callback: (err: Error | null, address: string, family: number) => void) => void;
    maxHeaderSize?: number;
    method?: string;
    path?: string | null;
    port?: number | string | null;
    protocol?: string | null;
    setDefaultHeaders?: boolean;
    setHost?: boolean;
    signal?: AbortSignal;
    socketPath?: string;
    timeout?: number;
    uniqueHeaders?: Array<string | string[]>;
    joinDuplicateHeaders?: boolean;
}

export interface ClientRequest extends OutgoingMessageImpl {
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

export interface ClientRequestImpl extends ClientRequest {
    _tcp: CModuleStreams.TCP | null;
    _options: ClientRequestArgs;
    _callback: ((res: IncomingMessageImpl) => void) | null;
    _aborted: boolean;
    _timeoutId: any;
    _requestBody: Uint8Array[];
    _bodySent: boolean;
    _socketAssigned: boolean;
    _response: IncomingMessageImpl | null;
    _requestId: string;
    _requestCallFrames: ReturnType<typeof captureNodeNetworkCallFrames>;
    _abortHandler: (() => void) | null;
    _streamedBeforeEnd: boolean;
    _sendChain: Promise<void>;
    _chunkedEncoding: boolean;
    _headerFlushStarted: boolean;
    _connectPromise: Promise<void> | null;
    _streamErrored: boolean;
    _markRequestFinished(): void;
    _doRequest(): Promise<void>;
    _readResponse(): void;
    _cleanup(): void;
    _connect(): Promise<void>;
    _sendRequestLine(postData?: Uint8Array): Promise<void>;
    _streamChunk(data: Uint8Array): Promise<void>;
    _finishStreaming(): Promise<void>;
}

export interface ClientRequestImplConstructor {
    new (url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void): ClientRequestImpl;
    (url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void): ClientRequestImpl;
    prototype: ClientRequestImpl;
}

function splitHostPort(host: string | null | undefined): { hostname?: string; port?: string } {
    if (!host) return {};
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        if (end !== -1) {
            const hostname = host.slice(1, end);
            const rest = host.slice(end + 1);
            return rest.startsWith(':') ? { hostname, port: rest.slice(1) } : { hostname };
        }
    }
    const firstColon = host.indexOf(':');
    if (firstColon !== -1 && firstColon === host.lastIndexOf(':')) {
        return { hostname: host.slice(0, firstColon), port: host.slice(firstColon + 1) };
    }
    return { hostname: host };
}

function normalizeRequestOptions(options: ClientRequestArgs): ClientRequestArgs {
    if (options.hostname || !options.host) return options;
    const parsed = splitHostPort(options.host);
    return {
        ...options,
        hostname: parsed.hostname ?? options.host,
        port: options.port ?? parsed.port,
    };
}

function mergeUrlOptions(url: string | URL, options?: ClientRequestArgs): ClientRequestArgs {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return normalizeRequestOptions({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        auth: parsed.username || parsed.password ? `${parsed.username}:${parsed.password}` : undefined,
        ...(options || {}),
    });
}

function shouldSendZeroContentLength(method: string): boolean {
    return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

function encodeRequestChunk(chunk: any, encoding?: BufferEncoding): Uint8Array {
    if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8');
    if (chunk instanceof Uint8Array) return chunk;
    if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
    }
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    return Buffer.from(String(chunk ?? ''), encoding || 'utf8');
}

async function lookupRequestHost(options: ClientRequestArgs, hostname: string, isIPv6: boolean): Promise<{ ip: string; family: number }> {
    if (options.lookup) {
        return await new Promise((resolve, reject) => {
            options.lookup!(hostname, { family: isIPv6 ? 6 : 4 }, (err, address, family) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ ip: address, family });
            });
        });
    }

    const addrs = await dns.resolve(hostname, { family: isIPv6 ? os.AF_INET6 : os.AF_INET });
    if (!addrs?.length) throw new Error(`DNS resolution failed for ${hostname}`);
    return addrs.find((a: any) => a.family === (isIPv6 ? os.AF_INET6 : os.AF_INET)) || addrs[0];
}

function initClientRequest(self: any, url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void): void {
    OutgoingMessageImpl.call(self);
    self.aborted = false;
    self.host = 'localhost';
    self.protocol = 'http:';
    self.reusedSocket = false;
    self.maxHeadersCount = 2000;
    self.method = 'GET';
    self.path = '/';

    self._tcp = null;
    self._callback = null;
    self._aborted = false;
    self._timeoutId = null;
    self._requestBody = [];
    self._bodySent = false;
    self._socketAssigned = false;
    self._response = null;
    self._requestId = '';
    self._requestCallFrames = captureNodeNetworkCallFrames();
    self._abortHandler = null;
    self._streamedBeforeEnd = false;
    self._sendChain = Promise.resolve();
    self._chunkedEncoding = false;
    self._headerFlushStarted = false;
    self._connectPromise = null;
    self._streamErrored = false;

    if (typeof url === 'string' || url instanceof URL) {
        self._options = mergeUrlOptions(url);
    } else {
        self._options = normalizeRequestOptions(url);
    }

    self._callback = cb || null;
    self.method = self._options.method?.toUpperCase() || 'GET';
    self.path = self._options.path || '/';
    self.host = self._options.hostname || self._options.host || 'localhost';
    self.protocol = self._options.protocol || 'http:';

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

    if (self._options.timeout) {
        self.setTimeout(self._options.timeout);
    }

    if (self._options.signal) {
        self._abortHandler = () => self.abort();
        self._options.signal.addEventListener('abort', self._abortHandler, { once: true });
    }
}

export const ClientRequestImpl: ClientRequestImplConstructor = function ClientRequestImpl(this: any, url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(ClientRequestImpl.prototype);
    initClientRequest(target, url, cb);
    return target;
} as ClientRequestImplConstructor;

Object.setPrototypeOf(ClientRequestImpl, OutgoingMessageImpl);
ClientRequestImpl.prototype = Object.create(OutgoingMessageImpl.prototype);

// Resolves DNS + opens the TCP socket + sets default headers. Body/request
// line are sent separately so callers can pick atomic vs. streaming framing.
ClientRequestImpl.prototype._connect = function _connect(this: ClientRequestImpl): Promise<void> {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = (async () => {
        this._requestId = this._requestId || nextNodeRequestId(this.protocol === 'https:' ? 'https-fetch' : 'http-fetch');

        if (this.protocol === 'https:') {
            throw new Error("Protocol \"https:\" not supported by node:http client. Use node:https instead.");
        }

        const port = typeof this._options.port === 'string'
            ? parseInt(this._options.port)
            : this._options.port || (this.protocol === 'https:' ? 443 : 80);

        // Bracketed (`[::1]`) or bare IPv6 literals have >1 colon; a `host:port`
        // string has exactly one. Strip brackets before resolving.
        const bracketed = this.host.startsWith('[') && this.host.endsWith(']');
        const resolveHost = bracketed ? this.host.slice(1, -1) : this.host;
        const isIPv6 = bracketed || (resolveHost.match(/:/g)?.length ?? 0) > 1;
        const addr = await lookupRequestHost(this._options, resolveHost, isIPv6);
        const family = addr.family === 6 || addr.family === os.AF_INET6 ? os.AF_INET6 : os.AF_INET;

        this._tcp = new streams.TCP(family);
        await this._tcp.connect({ ip: addr.ip, port });
        this._tcp.setNoDelay(true);

        if (this._aborted) {
            this._cleanup();
            throw new Error('Request aborted');
        }

        const socket = new Socket();
        (socket as any)._tcp = this._tcp;
        this.socket = socket;
        this._socketAssigned = true;
        this.emit('socket', this.socket);

        const setDefaultHeaders = this._options.setDefaultHeaders !== false;
        const setHost = this._options.setHost !== false;

        if (setHost && !this.hasHeader('host')) {
            this.setHeader('Host', port === 80 || port === 443 ? this.host : `${this.host}:${port}`);
        }
        if (this._options.auth && !this.hasHeader('authorization')) {
            this.setHeader('Authorization', `Basic ${btoa(this._options.auth)}`);
        }
        if (setDefaultHeaders && !this.hasHeader('user-agent')) {
            this.setHeader('User-Agent', 'Node.js/http');
        }
        if (setDefaultHeaders && !this.hasHeader('accept-encoding')) {
            this.setHeader('Accept-Encoding', 'identity');
        }
        if (setDefaultHeaders && !this.hasHeader('connection')) {
            this.setHeader('Connection', 'close');
        }
    })();
    return this._connectPromise;
};

ClientRequestImpl.prototype._sendRequestLine = async function _sendRequestLine(this: ClientRequestImpl, postData?: Uint8Array): Promise<void> {
    const tcp = this._tcp;
    if (!tcp) return;
    const fetchHook = getNodeFetchHook();

    let requestLine = `${this.method} ${this.path} HTTP/1.1\r\n`;
    requestLine += this._formatHeaders();
    requestLine += '\r\n';

    try {
        fetchHook?.onRequest?.({
            requestId: this._requestId,
            timestamp: nodeTs(),
            url: buildNodeUrl(this.protocol, this.host, this.path),
            method: this.method,
            headers: normalizeHeaderRecord(this.getHeaders()),
            postData: postData ?? undefined,
            callFrames: this._requestCallFrames,
            resourceType: 'Fetch',
        });
    } catch {}

    await tcp.write(engine.encodeString(requestLine));
    this.headersSent = true;
};

ClientRequestImpl.prototype._markRequestFinished = function _markRequestFinished(this: ClientRequestImpl): void {
    if (this.writableFinished) return;
    this.writableEnded = true;
    this.writableFinished = true;
    this.finished = true;
    this.emit('finish');
};

ClientRequestImpl.prototype._doRequest = async function _doRequest(this: ClientRequestImpl): Promise<void> {
    const fetchHook = getNodeFetchHook();
    try {
        await this._connect();
        if (!this._tcp) return; // aborted mid-connect; _connect() already cleaned up

        const requestBody = concatChunks(this._requestBody);
        const bodyLength = this._requestBody.reduce((sum, chunk) => sum + chunk.length, 0);

        // Respect an already-declared Transfer-Encoding (e.g. headers copied
        // verbatim by a proxy) instead of also stamping a conflicting Content-Length.
        if (this.hasHeader('transfer-encoding') && String(this.getHeader('transfer-encoding')).toLowerCase().includes('chunked')) {
            await this._sendRequestLine(requestBody);
            const writeTarget = this._tcp;
            if (bodyLength > 0) {
                await writeTarget.write(engine.encodeString(bodyLength.toString(16) + '\r\n'));
                await writeTarget.write(requestBody);
                await writeTarget.write(engine.encodeString('\r\n'));
            }
            await writeTarget.write(engine.encodeString('0\r\n\r\n'));
            this._bodySent = true;
            this._markRequestFinished();
            this._readResponse();
            return;
        }

        if (
            !this.hasHeader('content-length') &&
            !this.hasHeader('transfer-encoding') &&
            (bodyLength > 0 || shouldSendZeroContentLength(this.method))
        ) {
            this.setHeader('Content-Length', bodyLength);
        }

        await this._sendRequestLine(requestBody);
        const writeTarget = this._tcp;
        for (const chunk of this._requestBody) {
            await writeTarget.write(chunk);
        }
        this._bodySent = true;
        this._markRequestFinished();

        this._readResponse();
    } catch (err) {
        const normalized = normalizeErrnoError(err);
        try {
            fetchHook?.onFinished?.({
                requestId: this._requestId,
                timestamp: nodeTs(),
                success: false,
                errorText: String(normalized.message ?? normalized),
            });
        } catch {}
        if (!this._aborted) this.emit('error', normalized);
    }
};

// Streaming path: used once write() has been called at least once, so bytes
// go to the socket as they arrive instead of buffering the whole body.
ClientRequestImpl.prototype._streamChunk = async function _streamChunk(this: ClientRequestImpl, data: Uint8Array): Promise<void> {
    if (this._streamErrored) return;
    if (!this._headerFlushStarted) {
        this._headerFlushStarted = true;
        // Length isn't known upfront here; chunked unless the caller already
        // declared a fixed Content-Length (e.g. proxying headers verbatim).
        this._chunkedEncoding = !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding');
        if (this._chunkedEncoding && !this.hasHeader('transfer-encoding')) {
            this.setHeader('Transfer-Encoding', 'chunked');
        }
        await this._connect();
        if (!this._tcp) return;
        await this._sendRequestLine();
    }

    const tcp = this._tcp;
    if (!tcp) return;
    if (this._chunkedEncoding) {
        await tcp.write(engine.encodeString(data.byteLength.toString(16) + '\r\n'));
        await tcp.write(data);
        await tcp.write(engine.encodeString('\r\n'));
    } else {
        await tcp.write(data);
    }
};

ClientRequestImpl.prototype._finishStreaming = async function _finishStreaming(this: ClientRequestImpl): Promise<void> {
    if (!this._headerFlushStarted) {
        this._headerFlushStarted = true;
        this._chunkedEncoding = !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding');
        if (this._chunkedEncoding && !this.hasHeader('transfer-encoding')) {
            this.setHeader('Transfer-Encoding', 'chunked');
        }
        await this._connect();
        if (!this._tcp) return;
        await this._sendRequestLine();
    }
    const tcp = this._tcp;
    if (tcp && this._chunkedEncoding) {
        await tcp.write(engine.encodeString('0\r\n\r\n'));
    }
    this._bodySent = true;
    this._markRequestFinished();
    this._readResponse();
};

ClientRequestImpl.prototype._readResponse = function _readResponse(this: ClientRequestImpl): void {
    if (!this._tcp) return;

    const res = new IncomingMessageImpl(this.socket!);
    this._response = res;
    const { parser, finish } = setupResponseParser({
        requestId: this._requestId,
        protocol: this.protocol, host: this.host, path: this.path,
        res, getHeaders: () => this.getHeaders(),
        onResponse: (_res) => { this.emit('response', _res); if (this._callback) this._callback(_res); },
        onComplete: () => this._cleanup(),
        skipBody: this.method === 'HEAD',
    });

    const tcp = this._tcp;
    const buffer = new Uint8Array(65536);
    let pending: Uint8Array | null = null;
    let failed = false;
    const failResponse = (message: string, error?: Error) => {
        if (failed) return;
        failed = true;
        const normalized = normalizeErrnoError(error ?? Object.assign(new Error(message), { code: 'ECONNRESET' }), 'read');
        if (!res.complete) {
            res.aborted = true;
            try { res.emit('aborted'); } catch {}
            res.destroy(normalized);
        }
        if (!this._aborted) this.emit('error', normalized);
        finish(false, String(normalized.message ?? normalized));
        this._cleanup();
    };
    const readLoop = async () => {
        while (!this._aborted && tcp) {
            const n = await tcp.read(buffer);
            if (n === null || n === 0) {
                if (!res.complete) {
                    failResponse('socket hang up');
                    return;
                }
                this._cleanup();
                return;
            }
            let toParse: Uint8Array;
            if (pending) {
                const combined = new Uint8Array(pending.byteLength + n);
                combined.set(pending);
                combined.set(buffer.subarray(0, n), pending.byteLength);
                pending = null;
                toParse = combined;
            } else {
                toParse = buffer.subarray(0, n);
            }
            const result = parser.execute(toParse.buffer.slice(toParse.byteOffset, toParse.byteOffset + toParse.byteLength));
            if (result.errno !== 0) {
                failResponse('HTTP parse error');
                return;
            }
            const consumed = (result as any).consumed as number | undefined;
            if (consumed !== undefined && consumed < toParse.byteLength) {
                pending = new Uint8Array(toParse.subarray(consumed));
            }
            // onMessageComplete already ran _cleanup() (closed this._tcp) above;
            // stop instead of read()ing the now-closed local `tcp` again.
            if (res.complete) return;
        }
    };
    readLoop().catch((err) => {
        failResponse(String((err as Error)?.message ?? err), normalizeErrnoError(err));
    });
};

ClientRequestImpl.prototype.write = function write(this: ClientRequestImpl, chunk: any, encodingOrCb?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void): boolean {
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    if (this.writableEnded || this._bodySent) {
        const err = Object.assign(new Error(this.writableEnded ? 'write after end' : 'Request body already sent'), {
            code: this.writableEnded ? 'ERR_STREAM_WRITE_AFTER_END' : 'ERR_HTTP_REQUEST_BODY_SENT',
        });
        callback?.(err);
        queueMicrotask(() => this.emit('error', err));
        return false;
    }

    const data = encodeRequestChunk(chunk, encoding);

    // Once write() is used at all, switch to true streaming (chunked-encoded
    // if length is unknown) instead of buffering the whole body until end().
    this._streamedBeforeEnd = true;
    this._sendChain = this._sendChain
        .then(() => this._streamChunk(data))
        .then(() => callback?.(), (err) => {
            if (!this._streamErrored && !this._aborted) {
                this._streamErrored = true;
                this.emit('error', normalizeErrnoError(err));
            }
            callback?.(normalizeErrnoError(err));
        });

    return true;
};

ClientRequestImpl.prototype.end = function end(this: ClientRequestImpl, chunk?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): ClientRequestImpl {
    let callback: (() => void) | undefined;
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    else if (typeof encodingOrCb === 'function') { callback = encodingOrCb; }
    else if (typeof cb === 'function') { callback = cb; }

    if (this.writableEnded) {
        callback?.();
        return this;
    }

    if (this._streamedBeforeEnd) {
        if (chunk !== undefined) {
            const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
            const data = encodeRequestChunk(chunk, encoding);
            this._sendChain = this._sendChain.then(() => this._streamChunk(data));
        }
        this.writableEnded = true;
        this._sendChain = this._sendChain.then(() => this._finishStreaming()).then(() => { this._markRequestFinished(); callback?.(); }, (err) => {
            if (!this._streamErrored && !this._aborted) {
                this._streamErrored = true;
                this.emit('error', normalizeErrnoError(err));
            }
            callback?.();
        });
        return this;
    }

    if (chunk !== undefined) {
        const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
        const data = encodeRequestChunk(chunk, encoding);
        this._requestBody.push(data);
    }

    this.writableEnded = true;
    this._doRequest().then(() => callback?.()).catch((err) => {
        if (!this._aborted) this.emit('error', normalizeErrnoError(err));
        callback?.();
    });

    return this;
};

ClientRequestImpl.prototype.abort = function abort(this: ClientRequestImpl): void {
    if (this._aborted) return;
    this._aborted = true;
    this.aborted = true;
    this.emit('abort');
    this.destroy();
};

ClientRequestImpl.prototype.destroy = function destroy(this: ClientRequestImpl, error?: Error): ClientRequestImpl {
    this._cleanup();
    if (error) this.emit('error', normalizeErrnoError(error));
    return this;
};

ClientRequestImpl.prototype._cleanup = function _cleanup(this: ClientRequestImpl): void {
    if (this._timeoutId) {
        timers.clearTimeout(this._timeoutId);
        this._timeoutId = null;
    }
    if (this._abortHandler && this._options.signal) {
        this._options.signal.removeEventListener('abort', this._abortHandler);
        this._abortHandler = null;
    }
    if (this._tcp) {
        try { this._tcp.close(); } catch {}
        this._tcp = null;
    }
};

ClientRequestImpl.prototype.onSocket = function onSocket(this: ClientRequestImpl, socket: Socket): void {
    this.socket = socket;
    this._socketAssigned = true;
    this.emit('socket', socket);
};

ClientRequestImpl.prototype.setNoDelay = function setNoDelay(this: ClientRequestImpl, noDelay?: boolean): void {
    this._tcp?.setNoDelay(noDelay ?? true);
};

ClientRequestImpl.prototype.setSocketKeepAlive = function setSocketKeepAlive(this: ClientRequestImpl, enable?: boolean, initialDelay?: number): void {
    this._tcp?.setKeepAlive(enable ?? true, initialDelay ?? 0);
};

ClientRequestImpl.prototype.setTimeout = function setTimeout(this: ClientRequestImpl, timeout: number, callback?: () => void): ClientRequestImpl {
    if (this._timeoutId) timers.clearTimeout(this._timeoutId);
    this._timeoutId = timers.setTimeout(() => {
        this.emit('timeout');
        this.destroy(new Error('Timeout'));
    }, timeout);
    if (callback) this.once('timeout', callback);
    return this;
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

export class Agent {
    static defaultMaxSockets = Infinity;
    defaultPort: number = 80;
    protocol: string = 'http:';

    options: AgentOptions;
    maxFreeSockets: number = 256;
    maxTotalSockets: number = Infinity;
    maxSockets: number = Infinity;
    sockets: Map<string, Socket[]> = new Map();
    freeSockets: Map<string, Socket[]> = new Map();
    requests: Map<string, ClientRequest[]> = new Map();

    constructor(options?: AgentOptions) {
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

    getName(options: ClientRequestArgs): string {
        let name = `${options.host || options.hostname || 'localhost'}:${options.port || this.defaultPort}`;
        if (options.localAddress) name += `:${options.localAddress}`;
        return name;
    }

    addRequest(req: ClientRequestImpl, options: ClientRequestArgs): void {
        const name = this.getName(options);
        let sockets = this.sockets.get(name);
        if (!sockets) {
            sockets = [];
            this.sockets.set(name, sockets);
        }

        if (sockets.length < this.maxSockets) {
            const socket = this.createConnection(options, (err, socket) => {
                if (err) req.emit('error', err);
                else req.onSocket(socket);
            });
            sockets.push(socket);
        } else {
            let requests = this.requests.get(name);
            if (!requests) {
                requests = [];
                this.requests.set(name, requests);
            }
            requests.push(req as any);
        }
    }

    keepSocketAlive(socket: Socket): void {
        socket.setKeepAlive(true, this.options.keepAliveMsecs ?? 1000);
    }

    reuseSocket(socket: Socket, request: ClientRequest): void {
        socket.ref();
    }

    removeSocket(socket: Socket, options: ClientRequestArgs): void {
        const name = this.getName(options);
        const sockets = this.sockets.get(name);
        if (sockets) {
            const index = sockets.indexOf(socket);
            if (index !== -1) sockets.splice(index, 1);
            if (sockets.length === 0) this.sockets.delete(name);
        }
        // Drain queued requests for this name
        const queued = this.requests.get(name);
        if (queued?.length) {
            const next = queued.shift()!;
            if (queued.length === 0) this.requests.delete(name);
            this.addRequest(next as any, options);
        }
    }

    destroy(): void {
        for (const sockets of this.sockets.values()) {
            for (const socket of sockets) socket.destroy();
        }
        for (const sockets of this.freeSockets.values()) {
            for (const socket of sockets) socket.destroy();
        }
        this.sockets.clear();
        this.freeSockets.clear();
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
    const req = request(urlOrOptions as any, optionsOrCallback as any, callback);
    req.end();
    return req;
}
