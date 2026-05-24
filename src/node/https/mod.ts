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

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const httpParser = import.meta.use('http');
const timers = import.meta.use('timers');
import { dnsCache } from '@cnojs/http/dns-cache';

// ============================================================================
// HTTPS Server
// ============================================================================

export interface HttpsServerOptions extends TlsServerOptions {
    allowHalfOpen?: boolean;
    requestCert?: boolean;
    rejectUnauthorized?: boolean;
}

export class Server extends EventEmitter {
    #tlsServer: TlsServer;
    #requestListener: ((req: IncomingMessageImpl, res: ServerResponseImpl) => void) | null = null;

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

            const incoming = new IncomingMessageImpl(null);
            incoming.socket = tlsSocket as any;

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
                incoming.push(new Uint8Array(buf as ArrayBuffer).slice(off, off + len));
            };
            parser.onMessageComplete = () => {
                incoming.push(null);
                incoming.complete = true;
                if (this.#requestListener) {
                    this.#requestListener(incoming, response);
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

    setTimeout(msecs: number, callback?: () => void): this {
        return this;
    }
}

export function createServer(options?: HttpsServerOptions, requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server;
export function createServer(requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server;
export function createServer(optionsOrListener?: HttpsServerOptions | ((req: IncomingMessageImpl, res: ServerResponseImpl) => void), requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void): Server {
    return new Server(optionsOrListener as any, requestListener);
}

// ============================================================================
// HTTPS Agent
// ============================================================================

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
        const tcp = new streams.TCP(family);

        const tlsSocket = new TLSSocket(tcp, {
            isServer: false,
            rejectUnauthorized: (options as any).rejectUnauthorized ?? true,
            secureContext,
            servername: (options as any).servername ?? host,
        });

        tcp.connect({ ip: host, port }).then(() => {
            tlsSocket.on('secureConnect', () => callback(null, tlsSocket));
        }).catch((err: Error) => {
            callback(err, tlsSocket);
        });

        return tlsSocket;
    }
}

export const globalAgent = new Agent();

// ============================================================================
// HTTPS Client Request
// ============================================================================

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
            this._options.signal.addEventListener('abort', () => this.abort());
        }
    }

    private async _doRequest(): Promise<void> {
        const port = typeof this._options.port === 'string'
            ? parseInt(this._options.port)
            : this._options.port || 443;

        try {
            const isIPv6 = this.host.includes(':');
            const addrs = await dnsCache.resolve(this.host, { family: isIPv6 ? 10 : 0 });
            if (!addrs?.length) throw new Error(`DNS resolution failed for ${this.host}`);
            const addr = addrs.find((a: any) => a.family === (isIPv6 ? 10 : 4)) || addrs[0];

            const family = addr.family === 10 ? os.AF_INET6 : os.AF_INET;
            this._tcp = new streams.TCP(family);
            await this._tcp.connect({ ip: addr.ip, port });
            this._tcp.setNoDelay(true);

            if (this._aborted) {
                this._cleanup();
                return;
            }

            const secureContext = new SecureContext({
                ca: this._options.ca as any,
                cert: this._options.cert as any,
                key: this._options.key as any,
                ciphers: this._options.ciphers,
            });

            this._tlsSocket = new TLSSocket(this._tcp, {
                isServer: false,
                rejectUnauthorized: this._options.rejectUnauthorized ?? true,
                secureContext,
                servername: this._options.servername ?? this.host,
            });

            this.socket = this._tlsSocket as any;
            this.emit('socket', this._tlsSocket);

            await new Promise<void>((resolve, reject) => {
                this._tlsSocket!.on('secureConnect', resolve);
                this._tlsSocket!.on('error', reject);
                setTimeout(() => reject(new Error('TLS handshake timeout')), 10000);
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

            this._tlsSocket.write(engine.encodeString(requestLine));
            this.headersSent = true;

            for (const chunk of this._requestBody) {
                this._tlsSocket.write(chunk);
            }
            this._bodySent = true;

            this._readResponse();
        } catch (err) {
            this.emit('error', err);
        }
    }

    private _readResponse(): void {
        if (!this._tlsSocket) return;

        const parser = new httpParser.Parser(httpParser.RESPONSE);
        const res = new IncomingMessageImpl(null);
        (res as any).socket = this._tlsSocket;
        let currentHeaderField = '';

        const decode = (buf: any, off: number, len: number) =>
            engine.decodeString(new Uint8Array(buf as ArrayBuffer).slice(off, off + len));

        parser.onStatus = (buf: any, off: number, len: number) => {
            res.statusMessage = decode(buf, off, len);
        };
        parser.onHeaderField = (buf: any, off: number, len: number) => {
            currentHeaderField = decode(buf, off, len).toLowerCase();
        };
        parser.onHeaderValue = (buf: any, off: number, len: number) => {
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
            res.statusCode = parser.state.status;
            res.httpVersion = `${parser.state.httpMajor}.${parser.state.httpMinor}`;
            res.httpVersionMajor = parser.state.httpMajor;
            res.httpVersionMinor = parser.state.httpMinor;

            this.emit('response', res);
            if (this._callback) this._callback(res);
        };
        parser.onBody = (buf: any, off: number, len: number) => {
            res.push(new Uint8Array(buf as ArrayBuffer).slice(off, off + len));
        };
        parser.onMessageComplete = () => {
            res.push(null);
            res.complete = true;
        };

        this._tlsSocket.on('data', (chunk: Uint8Array) => {
            const ab = chunk.buffer instanceof SharedArrayBuffer
                ? new Uint8Array(chunk).buffer
                : chunk.buffer;
            const result = parser.execute(ab.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
            if (result.errno !== 0) {
                this._cleanup();
            }
        });

        this._tlsSocket.on('end', () => {
            this._cleanup();
        });

        this._tlsSocket.on('error', (err: Error) => {
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

// ============================================================================
// Re-exports from tls
// ============================================================================

export {
    TLSSocket,
    SecureContext,
    createSecureContext,
    PeerCertificate,
    getCiphers,
};

// ============================================================================
// Default export
// ============================================================================

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
