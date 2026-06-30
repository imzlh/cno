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
    TlsServerOptions,
    PeerCertificate,
    getCiphers,
} from '../tls';
import {
    IncomingMessageImpl,
    OutgoingMessageImpl,
    ServerResponseImpl,
    IncomingHttpHeaders,
    METHODS as HTTP_METHODS,
} from '../http/server';
import { ClientRequestArgs, Agent as HttpAgent } from '../http/client';
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

export class Server extends EventEmitter {
    #tlsServer: TlsServer;
    #requestListener: ((req: IncomingMessageImpl, res: ServerResponseImpl) => void) | null = null;
    #requestSerial = 0;
    #timeout = 0;
    #timeoutCallback: ((socket: TLSSocket) => void) | null = null;

    constructor(options?: HttpsServerOptions, requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void);
    constructor(requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void);
    constructor(optionsOrListener?: HttpsServerOptions | ((req: IncomingMessageImpl, res: ServerResponseImpl) => void), requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void) {
        super();

        let options: HttpsServerOptions = {};
        if (typeof optionsOrListener === 'function') {
            this.#requestListener = optionsOrListener;
        } else if (optionsOrListener) {
            options = optionsOrListener;
            if (requestListener) this.#requestListener = requestListener;
        }

        this.#tlsServer = new TlsServer(options, (tlsSocket: TLSSocket) => {
            if (!this.#requestListener) return;
            const serveHook = getNodeServeHook();
            const requestBodyChunks: Uint8Array[] = [];

            const incoming = new IncomingMessageImpl(null);
            incoming.socket = tlsSocket as any;
            incoming.setTimeout(this.#timeout, this.#timeoutCallback ? () => this.#timeoutCallback!(tlsSocket) : undefined);

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

                if (this.#requestListener) {
                    try {
                        this.#requestListener(incoming, response);
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

        this.#tlsServer.on('listening', () => this.emit('listening'));
        this.#tlsServer.on('close', () => this.emit('close'));
        this.#tlsServer.on('error', (err: Error) => this.emit('error', err));
        this.#tlsServer.on('tlsClientError', (err: Error, socket: TLSSocket) => this.emit('tlsClientError', err, socket));
    }

    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this;
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    listen(port?: number, backlog?: number, listeningListener?: () => void): this;
    listen(path: string, backlog?: number, listeningListener?: () => void): this;
    listen(options: any, listeningListener?: () => void): this;
    listen(...args: any[]): this {
        (this.#tlsServer.listen as any)(...args);
        return this;
    }

    close(callback?: (err?: Error) => void): this {
        this.#tlsServer.close(callback);
        return this;
    }

    address(): { address: string; family: string; port: number } | string | null {
        return this.#tlsServer.address();
    }

    get listening(): boolean { return this.#tlsServer.listening; }

    ref(): this { this.#tlsServer.ref(); return this; }
    unref(): this { this.#tlsServer.unref(); return this; }

    setTimeout(msecs: number, callback?: (socket: TLSSocket) => void): this {
        this.#timeout = msecs;
        this.#timeoutCallback = callback ?? null;
        return this;
    }
}

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

class HttpsClientRequest extends OutgoingMessageImpl {
    aborted: boolean = false;
    host: string = 'localhost';
    protocol: string = 'https:';
    method: string = 'GET';
    path: string = '/';

    private _tlsSocket: TLSSocket | null = null;
    private _options: RequestOptions;
    private _callback: ((res: IncomingMessageImpl) => void) | null = null;
    private _aborted: boolean = false;
    private _timeoutId: any = null;
    private _requestBody: Uint8Array[] = [];
    private _bodySent: boolean = false;
    private _tcp: any = null;
    private _requestId: string = '';
    private _requestCallFrames = captureNodeNetworkCallFrames();

    constructor(url: string | URL | RequestOptions, cb?: (res: IncomingMessageImpl) => void) {
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
            this._options.signal.addEventListener('abort', () => this.abort(), { once: true });
        }
    }

    private async _doRequest(): Promise<void> {
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
    }

    private _readResponse(): void {
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

        this._tlsSocket.on('data', (chunk: Uint8Array) => {
            const ab = chunk.buffer instanceof SharedArrayBuffer
                ? new Uint8Array(chunk).buffer
                : chunk.buffer;
            const result = parser.execute(ab.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
            if (result.errno !== 0) {
                finish(false, 'HTTP parse error');
                this._cleanup();
            }
        });

        this._tlsSocket.on('end', () => {
            this._cleanup();
        });

        this._tlsSocket.on('error', (err: Error) => {
            if (!this._aborted) this.emit('error', err);
            finish(false, err.message);
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

    setTimeout(timeout: number, callback?: () => void): this {
        if (this._timeoutId) timers.clearTimeout(this._timeoutId);
        this._timeoutId = timers.setTimeout(() => {
            this.emit('timeout');
            this.destroy(new Error('Timeout'));
        }, timeout);
        if (callback) this.once('timeout', callback);
        return this;
    }

    private _cleanup(): void {
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
    }
}

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
    PeerCertificate,
    getCiphers,
};

// Default export

export default {
    Agent,
    globalAgent,
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

