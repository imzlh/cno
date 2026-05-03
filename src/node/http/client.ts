/**
 * Node.js http 模块 - 客户端实现
 */

const engine = import.meta.use('engine');
const streams = import.meta.use('streams');
const timers = import.meta.use('timers');
const http = import.meta.use('http');

import { Socket } from '../net';
import { dnsCache } from '../../module/http/dns-cache';
import { OutgoingMessageImpl, IncomingMessageImpl, OutgoingHttpHeaders, IncomingHttpHeaders } from './server';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export const METHODS = [
    'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD',
    'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL',
    'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH',
    'PURGE', 'PUT', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE',
    'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
] as const;

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

export class ClientRequestImpl extends OutgoingMessageImpl implements ClientRequest {
    aborted: boolean = false;
    host: string = 'localhost';
    protocol: string = 'http:';
    reusedSocket: boolean = false;
    maxHeadersCount: number = 2000;
    method: string = 'GET';
    path: string = '/';

    private _tcp: CModuleStreams.TCP | null = null;
    private _options: ClientRequestArgs;
    private _callback: ((res: IncomingMessageImpl) => void) | null = null;
    private _aborted: boolean = false;
    private _timeoutId: any = null;
    private _requestBody: Uint8Array[] = [];
    private _bodySent: boolean = false;
    private _socketAssigned: boolean = false;
    private _response: IncomingMessageImpl | null = null;
    private _pendingData: Uint8Array | null = null;

    constructor(url: string | URL | ClientRequestArgs, cb?: (res: IncomingMessageImpl) => void) {
        super();

        if (typeof url === 'string') {
            const parsed = new URL(url);
            this._options = {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                auth: parsed.username || parsed.password ? `${parsed.username}:${parsed.password}` : undefined,
            };
        } else if (url instanceof URL) {
            this._options = {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                auth: url.username || url.password ? `${url.username}:${url.password}` : undefined,
            };
        } else {
            this._options = url;
        }

        this._callback = cb || null;
        this.method = this._options.method?.toUpperCase() || 'GET';
        this.path = this._options.path || '/';
        this.host = this._options.hostname || this._options.host || 'localhost';
        this.protocol = this._options.protocol || 'http:';

        if (this._options.headers) {
            if (Array.isArray(this._options.headers)) {
                for (let i = 0; i < this._options.headers.length; i += 2) {
                    this.setHeader(this._options.headers[i], this._options.headers[i + 1]);
                }
            } else {
                for (const [key, value] of Object.entries(this._options.headers)) {
                    if (value !== undefined) this.setHeader(key, value);
                }
            }
        }

        if (this._options.timeout) {
            this.setTimeout(this._options.timeout);
        }

        if (this._options.signal) {
            this._options.signal.addEventListener('abort', () => this.abort());
        }
    }

    private async _doRequest(): Promise<void> {
        const port = typeof this._options.port === 'string'
            ? parseInt(this._options.port)
            : this._options.port || (this.protocol === 'https:' ? 443 : 80);

        try {
            const isIPv6 = this.host.includes(':');
            const addrs = await dnsCache.resolve(this.host, { family: isIPv6 ? 10 : 0 });
            if (!addrs?.length) throw new Error(`DNS resolution failed for ${this.host}`);
            const addr = addrs.find((a: any) => a.family === (isIPv6 ? 10 : 4)) || addrs[0];

            this._tcp = new streams.TCP(addr.family === 10 ? 10 : 2);
            await this._tcp.connect({ ip: addr.ip, port });
            this._tcp.setNoDelay(true);

            if (this._aborted) {
                this._cleanup();
                return;
            }

            const socket = new Socket();
            (socket as any)._tcp = this._tcp;
            this.socket = socket;
            this._socketAssigned = true;
            this.emit('socket', socket);

            if (!this.hasHeader('host')) {
                this.setHeader('Host', port === 80 || port === 443 ? this.host : `${this.host}:${port}`);
            }

            if (this._options.auth && !this.hasHeader('authorization')) {
                this.setHeader('Authorization', `Basic ${btoa(this._options.auth)}`);
            }

            if (!this.hasHeader('user-agent')) {
                this.setHeader('User-Agent', 'Node.js/http');
            }

            if (!this.hasHeader('connection')) {
                this.setHeader('Connection', 'close');
            }

            const bodyLength = this._requestBody.reduce((sum, chunk) => sum + chunk.length, 0);
            if (bodyLength > 0 && !this.hasHeader('content-length')) {
                this.setHeader('Content-Length', bodyLength);
            }

            let requestLine = `${this.method} ${this.path} HTTP/1.1\r\n`;
            requestLine += this._formatHeaders();
            requestLine += '\r\n';

            await this._tcp.write(engine.encodeString(requestLine));
            this.headersSent = true;

            for (const chunk of this._requestBody) {
                await this._tcp.write(chunk);
            }
            this._bodySent = true;

            this._readResponse();
        } catch (err) {
            this.emit('error', err);
        }
    }

    private async _readResponse(): Promise<void> {
        if (!this._tcp) return;

        const parser = new http.Parser(http.RESPONSE);
        const res = new IncomingMessageImpl(this.socket!);
        this._response = res;
        let headersComplete = false;
        let currentHeaderField = '';

        const decode = (buf: any, off: number, len: number) =>
            engine.decodeString(new Uint8Array(buf as ArrayBuffer).slice(off, off + len));

        parser.onStatus = (buf, off, len) => {
            res.statusMessage = decode(buf, off, len);
        };

        parser.onHeaderField = (buf, off, len) => {
            currentHeaderField = decode(buf, off, len).toLowerCase();
        };

        parser.onHeaderValue = (buf, off, len) => {
            const value = decode(buf, off, len);
            const existing = res.headers[currentHeaderField as keyof IncomingHttpHeaders];
            if (existing) {
                if (Array.isArray(existing)) existing.push(value);
                else res.headers[currentHeaderField as keyof IncomingHttpHeaders] = [existing, value] as any;
            } else {
                res.headers[currentHeaderField as keyof IncomingHttpHeaders] = value as any;
            }
            res.rawHeaders.push(currentHeaderField, value);
            if (!res.headersDistinct[currentHeaderField]) {
                res.headersDistinct[currentHeaderField] = [];
            }
            res.headersDistinct[currentHeaderField]!.push(value);
        };

        parser.onHeadersComplete = () => {
            headersComplete = true;
            res.statusCode = parser.state.status;
            res.httpVersion = `${parser.state.httpMajor}.${parser.state.httpMinor}`;
            res.httpVersionMajor = parser.state.httpMajor;
            res.httpVersionMinor = parser.state.httpMinor;

            this.emit('response', res);
            if (this._callback) this._callback(res);
        };

        parser.onBody = (buf, off, len) => {
            const data = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            res.push(data);
        };

        parser.onMessageComplete = () => {
            res.push(null);
            res.complete = true;
        };

        const buffer = new Uint8Array(65536);

        const readLoop = async () => {
            while (!this._aborted) {
                let toParse: Uint8Array;

                if (this._pendingData) {
                    toParse = this._pendingData;
                    this._pendingData = null;

                    const n = await this._tcp!.read(buffer);
                    if (n === 0) {
                        this._cleanup();
                        return;
                    }
                    const combined = new Uint8Array(toParse.byteLength + n);
                    combined.set(toParse);
                    combined.set(buffer.subarray(0, n), toParse.byteLength);
                    toParse = combined;
                } else {
                    const n = await this._tcp!.read(buffer);
                    if (n === 0) {
                        this._cleanup();
                        return;
                    }
                    toParse = buffer.subarray(0, n);
                }

                const result = parser.execute(toParse.buffer.slice(toParse.byteOffset, toParse.byteOffset + toParse.byteLength));
                if (result.errno !== 0) {
                    this._cleanup();
                    return;
                }

                // @ts-ignore - remainder exists at runtime
                const remainder = result.remainder as number;
                if (remainder > 0) {
                    const parsedLength = toParse.byteLength - remainder;
                    this._pendingData = toParse.subarray(parsedLength);
                }
            }
        };

        readLoop().catch((err) => {
            if (!this._aborted) this.emit('error', err);
            this._cleanup();
        });
    }

    write(chunk: any, encodingOrCb?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void): boolean {
        if (this._bodySent) {
            const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
            callback?.(new Error('Request body already sent'));
            return false;
        }

        const data = typeof chunk === 'string' ? engine.encodeString(chunk) : chunk as Uint8Array;
        this._requestBody.push(data);

        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        callback?.();
        return true;
    }

    end(chunk?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
        let callback: (() => void) | undefined;
        if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
        else if (typeof encodingOrCb === 'function') { callback = encodingOrCb; }
        else if (typeof cb === 'function') { callback = cb; }

        if (chunk !== undefined) {
            const data = typeof chunk === 'string' ? engine.encodeString(chunk) : chunk as Uint8Array;
            this._requestBody.push(data);
        }

        this._doRequest().then(() => callback?.()).catch((err) => {
            this.emit('error', err);
            callback?.();
        });

        return this;
    }

    abort(): void {
        if (this._aborted) return;
        this._aborted = true;
        this.aborted = true;
        this.emit('abort');
        this.destroy();
    }

    destroy(error?: Error): this {
        this._cleanup();
        if (error) this.emit('error', error);
        return this;
    }

    private _cleanup(): void {
        if (this._timeoutId) {
            timers.clearTimeout(this._timeoutId);
            this._timeoutId = null;
        }
        this._pendingData = null;
        if (this._tcp) {
            try { this._tcp.close(); } catch {}
            this._tcp = null;
        }
    }

    onSocket(socket: Socket): void {
        this.socket = socket;
        this._socketAssigned = true;
        this.emit('socket', socket);
    }

    setNoDelay(noDelay?: boolean): void {
        this._tcp?.setNoDelay(noDelay ?? true);
    }

    setSocketKeepAlive(enable?: boolean, initialDelay?: number): void {
        this._tcp?.setKeepAlive(enable ?? true, initialDelay ?? 0);
    }

    setTimeout(timeout: number, callback?: () => void): this {
        if (this._timeoutId) timers.clearTimeout(this._timeoutId);
        this._timeoutId = timers.setTimeout(() => {
            this.emit('timeout');
            this.destroy(new Error('Timeout'));
        }, timeout);
        if (callback) this.once('timeout', callback);
        return this;
    }

    getRawHeaderNames(): string[] {
        return this._rawHeaderNames;
    }
}

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
        const port = typeof options.port === 'string' ? parseInt(options.port) : options.port || 80;
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
    }

    destroy(): void {
        for (const sockets of this.sockets.values()) {
            for (const socket of sockets) socket.destroy();
        }
        this.sockets.clear();
        this.freeSockets.clear();
    }
}

export const globalAgent = new Agent();

export function request(options: ClientRequestArgs | string | URL, callback?: (res: IncomingMessageImpl) => void): ClientRequestImpl {
    return new ClientRequestImpl(options, callback);
}

export function get(options: ClientRequestArgs | string | URL, callback?: (res: IncomingMessageImpl) => void): ClientRequestImpl {
    const req = request(options, callback);
    req.end();
    return req;
}
