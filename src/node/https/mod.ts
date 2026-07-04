/**
 * Node.js https module
 * Reuses http server/client architecture with TLS (TLSSocket) wrapping
 */

import { EventEmitter } from '../events';
import { Duplex } from '../stream';
import {
    TLSSocket,
    Server as TlsServer,
    SecureContext,
    createSecureContext,
    getCiphers,
} from '../tls';
import type { TlsServerOptions, PeerCertificate } from '../tls';
import {
    IncomingMessageImpl,
    OutgoingMessageImpl,
    ServerResponseImpl,
    METHODS as HTTP_METHODS,
    STATUS_CODES,
} from '../http/server';
import type { IncomingHttpHeaders } from '../http/server';
import { Agent as HttpAgent } from '../http/client';
import type { ClientRequestArgs } from '../http/client';
import {
    buildNodeServerUrl,
    buildNodeUrl,
    captureNodeNetworkCallFrames,
    getNodeFetchHook,
    getNodeServeHook,
    headerEntriesToRecord,
    nextNodeRequestId,
    nodeTs,
    normalizeHeaderRecord,
    setupResponseParser,
    toUint8Array,
} from '../_internal/network-debug';
import { concatChunks } from '../_internal/buffer';
import { normalizeErrnoError } from '../_internal/errno';

const streams = import.meta.use('streams');
const dns = import.meta.use('dns');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const httpParser = import.meta.use('http');
const timers = import.meta.use('timers');
const ssl = import.meta.use('ssl');
const asfs = import.meta.use('asyncfs');
const windows = import.meta.use('win32');
const fs = import.meta.use('fs');

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

// ---------------------------------------------------------------------------
// System CA discovery (mirrors http/src/connection.ts findSystemCaPath)
// ---------------------------------------------------------------------------

let _sysCaCache: string | null | undefined = undefined;

async function getSystemCa(): Promise<string | null> {
    if (_sysCaCache !== undefined) return _sysCaCache;
    const sysname = os.uname().sysname;
    const candidates: string[] = sysname === 'Linux' ? [
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/pki/tls/certs/ca-bundle.crt',
        '/etc/pki/tls/cert.pem',
        '/etc/ssl/cert.pem',
    ] : sysname === 'Darwin' ? [
        '/etc/ssl/cert.pem',
        '/opt/homebrew/etc/openssl@3/cert.pem',
        '/usr/local/etc/openssl@3/cert.pem',
    ] : sysname === 'FreeBSD' ? [
        '/usr/local/share/certs/ca-root-nss.crt',
        '/etc/ssl/cert.pem',
    ] : [];

    for (const p of candidates) {
        try { if ((await asfs.stat(p)).isFile) { _sysCaCache = p; return p; } } catch {}
    }

    if (sysname === 'Windows_NT') {
        const tmpDir = (os as any).tmpDir || 'C:\\Windows\\Temp';
        const tmp = tmpDir + '\\cno-ca-bundle.pem';
        try {
            const certs = windows!.exportCerts();
            if (certs?.length) {
                await fs.writeFile(tmp, engine.encodeString(certs.join('\n')));
                _sysCaCache = tmp; return tmp;
            }
        } catch {}
    }

    _sysCaCache = null; return null;
}

// HTTPS Server

export interface HttpsServerOptions extends TlsServerOptions {
    allowHalfOpen?: boolean;
    requestCert?: boolean;
    rejectUnauthorized?: boolean;
}

export interface Server extends EventEmitter {
    _tlsServer: TlsServer;
    _requestListener: ((req: IncomingMessageImpl, res: ServerResponseImpl) => void) | null;
    _requestSerial: number;
    _timeout: number;
    _timeoutCallback: ((socket: TLSSocket) => void) | null;

    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this;
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    listen(port?: number, backlog?: number, listeningListener?: () => void): this;
    listen(path: string, backlog?: number, listeningListener?: () => void): this;
    listen(options: any, listeningListener?: () => void): this;

    close(callback?: (err?: Error) => void): this;
    address(): { address: string; family: string; port: number } | string | null;
    readonly listening: boolean;
    ref(): this;
    unref(): this;
    setTimeout(msecs: number, callback?: (socket: TLSSocket) => void): this;
}

export interface ServerConstructor {
    new (options?: HttpsServerOptions, requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server;
    new (requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server;
    (options?: HttpsServerOptions, requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server;
    (requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server;
    prototype: Server;
}

function initServer(
    self: any,
    optionsOrListener?: HttpsServerOptions | ((req: IncomingMessageImpl, res: ServerResponseImpl) => void),
    requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void
): void {
    EventEmitter.call(self);

    self._requestListener = null;
    self._requestSerial = 0;
    self._timeout = 0;
    self._timeoutCallback = null;

    let options: HttpsServerOptions = {};
    if (typeof optionsOrListener === 'function') {
        self._requestListener = optionsOrListener;
    } else if (optionsOrListener) {
        options = optionsOrListener;
        if (requestListener) self._requestListener = requestListener;
    }

    self._tlsServer = new TlsServer(options, (tlsSocket: TLSSocket) => {
        if (!self._requestListener) return;
        const serveHook = getNodeServeHook();
        const requestBodyChunks: Uint8Array[] = [];

        const incoming = new IncomingMessageImpl(null);
        incoming.socket = tlsSocket as any;
        incoming.setTimeout(self._timeout, self._timeoutCallback ? () => self._timeoutCallback!(tlsSocket) : undefined);

        const response = new ServerResponseImpl();
        response.req = incoming;

        const parser = new httpParser.Parser(httpParser.REQUEST);
        let currentHeaderField = '';

        const decode = (buf: any, off: number, len: number) =>
            engine.decodeString(new Uint8Array(buf as ArrayBuffer).slice(off, off + len));

        parser.onUrl = (buf: any, off: number, len: number) => {
            incoming.url = decode(buf, off, len);
        };
        parser.onHeaderField = (buf: any, off: number, len: number) => {
            currentHeaderField = decode(buf, off, len).toLowerCase();
        };
        parser.onHeaderValue = (buf: any, off: number, len: number) => {
            const value = decode(buf, off, len);
            incoming.headers[currentHeaderField as keyof IncomingHttpHeaders] = value as any;
            incoming.rawHeaders.push(currentHeaderField, value);
        };
        parser.onHeadersComplete = () => {
            incoming.httpVersion = `${parser.state.httpMajor}.${parser.state.httpMinor}`;
            incoming.httpVersionMajor = parser.state.httpMajor;
            incoming.httpVersionMinor = parser.state.httpMinor;
            incoming.method = HTTP_METHODS[parser.state.method] || 'GET';
        };
        parser.onBody = (buf: any, off: number, len: number) => {
            const chunk = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            requestBodyChunks.push(chunk);
            incoming.push(chunk);
        };
        parser.onMessageComplete = () => {
            incoming.push(null);
            incoming.complete = true;
            const requestId = nextNodeRequestId('https-serve');
            const requestHeaders = normalizeHeaderRecord(incoming.headers as Record<string, string | string[] | undefined>);
            const requestUrl = buildNodeServerUrl('https:', incoming.url, requestHeaders);
            const requestCallFrames = captureNodeNetworkCallFrames();
            let finished = false;
            const finish = (success: boolean, errorText?: string) => {
                if (finished) return;
                finished = true;
                try {
                    serveHook?.onFinished?.({ requestId, timestamp: nodeTs(), success, errorText });
                } catch {}
            };
            try {
                serveHook?.onRequest?.({
                    requestId,
                    timestamp: nodeTs(),
                    url: requestUrl,
                    method: incoming.method || 'GET',
                    headers: requestHeaders,
                    postData: concatChunks(requestBodyChunks),
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
                    finish(true);
                } catch {}
                return result;
            }) as any;

            if (self._requestListener) {
                try {
                    self._requestListener(incoming, response);
                } catch (err) {
                    finish(false, String((err as Error)?.message ?? err));
                    throw err;
                }
            }
        };

        tlsSocket.on('data', (chunk: Uint8Array) => {
            const ab = chunk.buffer instanceof SharedArrayBuffer
                ? new Uint8Array(chunk).buffer
                : chunk.buffer;
            const result = parser.execute(ab.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
            if (result.errno !== 0) {
                tlsSocket.destroy(new Error('HTTP parse error'));
            }
        });
    });

    self._tlsServer.on('listening', () => self.emit('listening'));
    self._tlsServer.on('close', () => self.emit('close'));
    self._tlsServer.on('error', (err: Error) => self.emit('error', err));
    self._tlsServer.on('tlsClientError', (err: Error, socket: TLSSocket) => self.emit('tlsClientError', err, socket));
}

export const Server: ServerConstructor = function Server(
    this: any,
    optionsOrListener?: HttpsServerOptions | ((req: IncomingMessageImpl, res: ServerResponseImpl) => void),
    requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void
) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Server.prototype);
    initServer(target, optionsOrListener, requestListener);
    return target;
} as ServerConstructor;

Object.setPrototypeOf(Server, EventEmitter);
Server.prototype = Object.create(EventEmitter.prototype);

Server.prototype.listen = function listen(this: Server, ...args: any[]): Server {
    (this._tlsServer.listen as any)(...args);
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

export function createServer(options?: HttpsServerOptions, requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server;
export function createServer(requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server;
export function createServer(optionsOrListener?: HttpsServerOptions | ((req: IncomingMessageImpl, res: ServerResponseImpl) => void), requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server {
    return new Server(optionsOrListener as any, requestListener);
}

// HTTPS Agent

export class Agent extends HttpAgent {
    defaultPort: number = 443;
    protocol: string = 'https:';

    createConnection(options: ClientRequestArgs, callback: (err: Error | null, socket: any) => void): any {
        const port = typeof options.port === 'string' ? parseInt(options.port) : options.port || 443;
        const host = options.hostname || options.host || 'localhost';

        const secureContext = new SecureContext({
            ca: (options as any).ca,
            cert: (options as any).cert,
            key: (options as any).key,
            ciphers: (options as any).ciphers,
        });

        const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;

        dns.resolve(host, { family }).then((addrs: any[]) => {
            if (!addrs?.length) throw new Error(`DNS resolution failed for ${host}`);
            const addr = addrs.find((a: any) => a.family === (family === os.AF_INET6 ? 6 : 4)) || addrs[0];
            const tcp = new streams.TCP(family);
            const tlsSocket = new TLSSocket(tcp, {
                isServer: false,
                rejectUnauthorized: (options as any).rejectUnauthorized ?? true,
                secureContext,
                servername: (options as any).servername ?? host,
            });
            tcp.connect({ ip: addr.ip, port }).then(() => {
                tlsSocket.on('secureConnect', () => callback(null, tlsSocket));
            }).catch((err: Error) => { callback(err, null); });
        }).catch((err: Error) => { callback(err, null); });

        return null;
    }
}

export const globalAgent = new Agent();

// HTTPS Client Request

export interface RequestOptions extends ClientRequestArgs {
    ca?: string | string[] | Buffer | Buffer[];
    cert?: string | string[] | Buffer | Buffer[];
    key?: string | string[] | Buffer | Buffer[] | { pem: string | Buffer; passphrase?: string }[];
    rejectUnauthorized?: boolean;
    servername?: string;
    ciphers?: string;
}

interface HttpsClientRequest extends OutgoingMessageImpl {
    aborted: boolean;
    host: string;
    protocol: string;
    method: string;
    path: string;

    _tlsSocket: TLSSocket | null;
    _options: RequestOptions;
    _callback: ((res: IncomingMessageImpl) => void) | null;
    _aborted: boolean;
    _timeoutId: any;
    _requestBody: Uint8Array[];
    _bodySent: boolean;
    _tcp: any;
    _requestId: string;
    _requestCallFrames: any;

    _doRequest(): Promise<void>;
    _readResponse(): void;
    write(chunk: any, encodingOrCb?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void): boolean;
    end(chunk?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this;
    abort(): void;
    destroy(error?: Error): this;
    setTimeout(timeout: number, callback?: () => void): this;
    _cleanup(): void;
}

interface HttpsClientRequestConstructor {
    new (url: string | URL | RequestOptions, cb?: (res: IncomingMessageImpl) => void): HttpsClientRequest;
    (url: string | URL | RequestOptions, cb?: (res: IncomingMessageImpl) => void): HttpsClientRequest;
    prototype: HttpsClientRequest;
}

function initHttpsClientRequest(self: any, url: string | URL | RequestOptions, cb?: (res: IncomingMessageImpl) => void): void {
    OutgoingMessageImpl.call(self);

    self.aborted = false;
    self.host = 'localhost';
    self.protocol = 'https:';
    self.method = 'GET';
    self.path = '/';

    self._tlsSocket = null;
    self._callback = null;
    self._aborted = false;
    self._timeoutId = null;
    self._requestBody = [];
    self._bodySent = false;
    self._tcp = null;
    self._requestId = '';
    self._requestCallFrames = captureNodeNetworkCallFrames();

    if (typeof url === 'string') {
        const parsed = new URL(url);
        self._options = {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            auth: parsed.username || parsed.password ? `${parsed.username}:${parsed.password}` : undefined,
        };
    } else if (url instanceof URL) {
        self._options = {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            auth: url.username || url.password ? `${url.username}:${url.password}` : undefined,
        };
    } else {
        self._options = url;
    }

    self._callback = cb || null;
    self.method = self._options.method?.toUpperCase() || 'GET';
    self.path = self._options.path || '/';
    self.host = self._options.hostname || self._options.host || 'localhost';

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
        self._options.signal.addEventListener('abort', () => self.abort(), { once: true });
    }
}

const HttpsClientRequest: HttpsClientRequestConstructor = function HttpsClientRequest(
    this: any,
    url: string | URL | RequestOptions,
    cb?: (res: IncomingMessageImpl) => void
) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(HttpsClientRequest.prototype);
    initHttpsClientRequest(target, url, cb);
    return target;
} as HttpsClientRequestConstructor;

Object.setPrototypeOf(HttpsClientRequest, OutgoingMessageImpl);
HttpsClientRequest.prototype = Object.create(OutgoingMessageImpl.prototype);

HttpsClientRequest.prototype._doRequest = async function _doRequest(this: HttpsClientRequest): Promise<void> {
    const fetchHook = getNodeFetchHook();
    this._requestId = this._requestId || nextNodeRequestId('https-fetch');
    const requestStartTime = nodeTs();
    const requestBody = concatChunks(this._requestBody);
    const port = typeof this._options.port === 'string'
        ? parseInt(this._options.port)
        : this._options.port || 443;

    try {
        const isIPv6 = this.host.includes(':');
        const addrs = await dns.resolve(this.host, { family: isIPv6 ? os.AF_INET6 : os.AF_INET });
        if (!addrs?.length) throw new Error(`DNS resolution failed for ${this.host}`);
        const addr = addrs.find((a: any) => a.family === (isIPv6 ? os.AF_INET6 : os.AF_INET)) || addrs[0];

        const family = addr.family === 6 ? os.AF_INET6 : os.AF_INET;
        this._tcp = new streams.TCP(family);
        await this._tcp.connect({ ip: addr.ip, port });
        this._tcp.setNoDelay(true);

        if (this._aborted) {
            this._cleanup();
            return;
        }

        const rejectUnauthorized = this._options.rejectUnauthorized ?? true;
        let caPath = this._options.ca as string | undefined;
        if (!caPath && rejectUnauthorized) {
            caPath = (await getSystemCa()) ?? undefined;
        }

        const secureContext = new SecureContext({
            ca: caPath,
            cert: this._options.cert as any,
            key: this._options.key as any,
            ciphers: this._options.ciphers,
        });

        this._tlsSocket = new TLSSocket(this._tcp, {
            isServer: false,
            rejectUnauthorized,
            secureContext,
            servername: this._options.servername ?? this.host,
        });

        this.socket = this._tlsSocket as any;
        this.emit('socket', this._tlsSocket);

        await new Promise<void>((resolve, reject) => {
            const timeout = timers.setTimeout(() => reject(new Error('TLS handshake timeout')), 10000);
            this._tlsSocket!.on('secureConnect', () => {
                timers.clearTimeout(timeout);
                if (rejectUnauthorized && !this._tlsSocket!.authorized) {
                    reject(this._tlsSocket!.authorizationError ?? new Error('Certificate verification failed'));
                } else {
                    resolve();
                }
            });
            this._tlsSocket!.on('error', (err) => { timers.clearTimeout(timeout); reject(err); });
        });

        if (!this.hasHeader('host')) {
            this.setHeader('Host', port === 443 ? this.host : `${this.host}:${port}`);
        }

        if (this._options.auth && !this.hasHeader('authorization')) {
            this.setHeader('Authorization', `Basic ${btoa(this._options.auth)}`);
        }

        if (!this.hasHeader('user-agent')) {
            this.setHeader('User-Agent', 'Node.js/https');
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

        try {
            fetchHook?.onRequest?.({
                requestId: this._requestId,
                timestamp: requestStartTime,
                url: buildNodeUrl(this.protocol, this.host, this.path),
                method: this.method,
                headers: normalizeHeaderRecord(this.getHeaders()),
                postData: requestBody ?? undefined,
                callFrames: this._requestCallFrames,
                resourceType: 'Fetch',
            });
        } catch {}

        this._tlsSocket.write(engine.encodeString(requestLine));
        this.headersSent = true;

        for (const chunk of this._requestBody) {
            this._tlsSocket.write(chunk);
        }
        this._bodySent = true;

        this._readResponse();
    } catch (err) {
        try {
            fetchHook?.onFinished?.({
                requestId: this._requestId,
                timestamp: nodeTs(),
                success: false,
                errorText: String((err as Error)?.message ?? err),
            });
        } catch {}
        this.emit('error', err);
    }
};

HttpsClientRequest.prototype._readResponse = function _readResponse(this: HttpsClientRequest): void {
    if (!this._tlsSocket) return;

    const res = new IncomingMessageImpl(null);
    (res as any).socket = this._tlsSocket;
    const { parser, finish } = setupResponseParser({
        requestId: this._requestId,
        protocol: this.protocol, host: this.host, path: this.path,
        res, getHeaders: () => this.getHeaders(),
        onResponse: (_res) => { this.emit('response', _res); if (this._callback) this._callback(_res); },
        onComplete: () => { this._cleanup(); },
    });
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

    this._tlsSocket.on('data', (chunk: Uint8Array) => {
        const ab = chunk.buffer instanceof SharedArrayBuffer
            ? new Uint8Array(chunk).buffer
            : chunk.buffer;
        const result = parser.execute(ab.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
        if (result.errno !== 0) {
            failResponse('HTTP parse error');
        }
    });

    this._tlsSocket.on('end', () => {
        if (!res.complete) {
            failResponse('socket hang up');
            return;
        }
        this._cleanup();
    });

    this._tlsSocket.on('error', (err: Error) => {
        failResponse(err.message, err);
    });
};

HttpsClientRequest.prototype.write = function write(this: HttpsClientRequest, chunk: any, encodingOrCb?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void): boolean {
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
};

HttpsClientRequest.prototype.end = function end(this: HttpsClientRequest, chunk?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): HttpsClientRequest {
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
};

HttpsClientRequest.prototype.abort = function abort(this: HttpsClientRequest): void {
    if (this._aborted) return;
    this._aborted = true;
    this.aborted = true;
    this.emit('abort');
    this.destroy();
};

HttpsClientRequest.prototype.destroy = function destroy(this: HttpsClientRequest, error?: Error): HttpsClientRequest {
    this._cleanup();
    if (error) this.emit('error', error);
    return this;
};

HttpsClientRequest.prototype.setTimeout = function setTimeout(this: HttpsClientRequest, timeout: number, callback?: () => void): HttpsClientRequest {
    if (this._timeoutId) timers.clearTimeout(this._timeoutId);
    this._timeoutId = timers.setTimeout(() => {
        this.emit('timeout');
        this.destroy(new Error('Timeout'));
    }, timeout);
    if (callback) this.once('timeout', callback);
    return this;
};

HttpsClientRequest.prototype._cleanup = function _cleanup(this: HttpsClientRequest): void {
    if (this._timeoutId) {
        timers.clearTimeout(this._timeoutId);
        this._timeoutId = null;
    }
    if (this._tlsSocket) {
        try { this._tlsSocket.destroy(); } catch {}
        this._tlsSocket = null;
    }
    if (this._tcp) {
        try { this._tcp.close(); } catch {}
        this._tcp = null;
    }
};

Object.defineProperty(HttpsClientRequest.prototype, 'constructor', {
    value: HttpsClientRequest,
    writable: true,
    configurable: true,
});

flattenPrototype(HttpsClientRequest.prototype);

export function request(options: RequestOptions | string | URL, callback?: (res: IncomingMessageImpl) => void): HttpsClientRequest {
    return new HttpsClientRequest(options, callback);
}

export function get(options: RequestOptions | string | URL, callback?: (res: IncomingMessageImpl) => void): HttpsClientRequest {
    const req = request(options, callback);
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
