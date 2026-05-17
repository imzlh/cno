/**
 * Node.js tls module
 * Built on CModuleSSL (OpenSSL) + Duplex stream for TLS/SSL
 * TLSSocket is a full Duplex, accepts any underlying Duplex stream
 */

import { EventEmitter } from '../events';
import { Duplex } from '../stream';
import { Socket as NetSocket, Server as NetServer } from '../net';

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const ssl = import.meta.use('ssl');

// ============================================================================
// Types
// ============================================================================

export interface TlsOptions {
    ca?: string | string[];
    cert?: string | string[];
    ciphers?: string;
    clientCertEngine?: string;
    crl?: string | string[];
    dhparam?: string;
    ecdhCurve?: string;
    honorCipherOrder?: boolean;
    key?: string | string[] | { pem: string | Buffer; passphrase?: string }[];
    maxVersion?: 'TLSv1.0' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
    minVersion?: 'TLSv1.0' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
    passphrase?: string;
    pfx?: string | Buffer | { buf: string | Buffer; passphrase?: string }[];
    secureOptions?: number;
    secureProtocol?: string;
    servername?: string;
    sessionIdContext?: string;
    sessionTimeout?: number;
}

export interface SecureContextOptions extends TlsOptions {}

export interface SecurePair {
    encrypted: TLSSocket;
    cleartext: TLSSocket;
}

export interface TlsConnectOptions extends TlsOptions {
    host?: string;
    port?: number;
    path?: string;
    socket?: Duplex;
    allowHalfOpen?: boolean;
    rejectUnauthorized?: boolean;
    ALPNProtocols?: string[] | Buffer[] | Buffer;
    checkServerIdentity?: (servername: string, cert: PeerCertificate) => Error | undefined;
    enableTrace?: boolean;
    isServer?: boolean;
    lookup?: (hostname: string, options: any, callback: any) => void;
    noDelay?: boolean;
    keepAlive?: boolean;
    keepAliveInitialDelay?: number;
    timeout?: number;
    signal?: AbortSignal;
}

export interface TlsServerOptions extends TlsOptions {
    allowHalfOpen?: boolean;
    pauseOnConnect?: boolean;
    ALPNProtocols?: string[] | Buffer[] | Buffer;
    enableTrace?: boolean;
    handshakeTimeout?: number;
    requestCert?: boolean;
    rejectUnauthorized?: boolean;
}

export interface PeerCertificate {
    subject: Record<string, string>;
    issuer: Record<string, string>;
    subjectAltName?: string;
    serialNumber: string;
    validFrom: string;
    validTo: string;
    fingerprint: string;
    fingerprint256: string;
    raw: Buffer;
}

// ============================================================================
// SecureContext
// ============================================================================

export class SecureContext {
    #context: CModuleSSL.Context;

    constructor(options?: SecureContextOptions) {
        const opts: CModuleSSL.ContextOptions = {};

        if (options?.key) {
            opts.key = typeof options.key === 'string' ? options.key :
                Array.isArray(options.key) ? (typeof options.key[0] === 'string' ? options.key[0] : options.key[0].pem as string) : undefined;
        }
        if (options?.cert) {
            opts.cert = typeof options.cert === 'string' ? options.cert :
                Array.isArray(options.cert) ? options.cert[0] : undefined;
        }
        if (options?.ca) {
            opts.ca = typeof options.ca === 'string' ? options.ca :
                Array.isArray(options.ca) ? options.ca[0] : undefined;
        }
        if (options?.ciphers) opts.ciphers = options.ciphers;
        if (options?.minVersion) opts.minVersion = options.minVersion;
        if (options?.maxVersion) opts.maxVersion = options.maxVersion;
        if (options?.dhparam) opts.dhparam = options.dhparam;
        if (options?.ecdhCurve) opts.ecdhCurve = options.ecdhCurve;

        this.#context = new ssl.Context(opts);
    }

    get context(): CModuleSSL.Context { return this.#context; }
}

export function createSecureContext(options?: SecureContextOptions): SecureContext {
    return new SecureContext(options);
}

// ============================================================================
// TLSSocket — Full Duplex stream
// ============================================================================

export class TLSSocket extends Duplex {
    #underlying: Duplex | CModuleStreams.Stream | null = null;
    #sslPipe: CModuleSSL.Pipe | null = null;
    #secureContext: SecureContext;
    #handshakeComplete: boolean = false;
    #isServer: boolean;
    #servername: string;
    #destroyed: boolean = false;
    #connecting: boolean = false;
    #rejectUnauthorized: boolean;
    // Queue plaintext writes before handshake completes
    #writeQueue: Uint8Array[] = [];

    bytesRead: number = 0;
    bytesWritten: number = 0;
    authorized: boolean = false;
    authorizationError: Error | null = null;
    encrypted: boolean = true;
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
    readyState: 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed' = 'closed';
    alpnProtocol?: string | null;
    protocol?: string;
    tlsVersion?: string;

    constructor(socket: Duplex | CModuleStreams.Stream, options?: {
        isServer?: boolean;
        rejectUnauthorized?: boolean;
        requestCert?: boolean;
        secureContext?: SecureContext;
        servername?: string;
        ALPNProtocols?: string[] | Buffer[] | Buffer;
        enableTrace?: boolean;
    }) {
        super({ allowHalfOpen: false });

        this.#isServer = options?.isServer ?? false;
        this.#rejectUnauthorized = options?.rejectUnauthorized ?? true;
        this.#servername = options?.servername ?? '';
        this.#secureContext = options?.secureContext ?? new SecureContext();

        this.#underlying = socket;

        // Copy address info from NetSocket if available
        if (socket instanceof NetSocket) {
            this.localAddress = socket.localAddress;
            this.localPort = socket.localPort;
            this.remoteAddress = socket.remoteAddress;
            this.remotePort = socket.remotePort;
            this.remoteFamily = socket.remoteFamily;
        }

        this.readyState = 'open';
        this.#initTls();
    }

    #initTls(): void {
        const pipeOpts: CModuleSSL.PipeOptions = {};
        if (this.#servername && !this.#isServer) {
            pipeOpts.servername = this.#servername;
        }

        this.#sslPipe = new ssl.Pipe(this.#secureContext.context, pipeOpts);
        this.#connecting = true;
        this.readyState = 'opening';

        // Kick off handshake
        this.#sslPipe.handshake();
        this.#flushOutput();

        // Wire up the underlying stream
        if (this.#underlying instanceof Duplex) {
            this.#underlying.on('data', (chunk: any) => {
                this.#feedEncrypted(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            });
            this.#underlying.on('end', () => {
                this.push(null);
                this.emit('end');
            });
            this.#underlying.on('error', (err: Error) => {
                this.emit('error', err);
            });
            this.#underlying.on('close', () => {
                if (!this.#destroyed) this.destroy();
            });
        } else {
            // CModuleStreams.Stream — use onread callback
            const stream = this.#underlying as CModuleStreams.Stream;
            stream.onread = (result: any, error: any) => {
                if (error) { this.emit('error', error); return; }
                if (result === null) { this.push(null); this.emit('end'); return; }
                this.#feedEncrypted(result as Uint8Array);
            };
            stream.startRead();
        }
    }

    /** Send any pending encrypted output from SSL pipe to the wire */
    #flushOutput(): void {
        if (!this.#sslPipe) return;
        const out = this.#sslPipe.getOutput();
        if (!out) return;

        const data = new Uint8Array(out as ArrayBuffer);
        if (this.#underlying instanceof Duplex) {
            this.#underlying.write(data);
        } else {
            (this.#underlying as CModuleStreams.Stream).write(data);
        }
    }

    /** Feed encrypted data from the wire into SSL pipe, push decrypted plaintext */
    #feedEncrypted(data: Uint8Array): void {
        if (!this.#sslPipe) return;

        this.#sslPipe.feed(data);

        if (!this.#handshakeComplete) {
            // Drive handshake to completion
            while (!this.#sslPipe.handshake()) {
                this.#flushOutput();
            }
            this.#flushOutput();

            if (this.#sslPipe.handshakeComplete) {
                this.#handshakeComplete = true;
                this.#connecting = false;
                this.readyState = 'open';

                const verify = this.#sslPipe.verifyResult();
                this.authorized = verify.ok;
                if (!verify.ok) {
                    this.authorizationError = new Error(verify.error ?? `Certificate verification failed: ${verify.code}`);
                }

                const cipher = this.#sslPipe.cipher();
                if (cipher) {
                    this.protocol = cipher.name;
                    this.tlsVersion = cipher.version;
                }
                this.alpnProtocol = this.#sslPipe.alpnProtocol();

                this.emit('secureConnect');

                // Read any plaintext that arrived with the final handshake flight
                for (;;) {
                    const plaintext = this.#sslPipe.read();
                    if (!plaintext) break;
                    this.bytesRead += plaintext.byteLength;
                    this.push(new Uint8Array(plaintext));
                }

                // Flush queued writes now that TLS is ready
                this.#drainWriteQueue();
            }
            return;
        }

        // Normal: decrypt and push all available plaintext
        for (;;) {
            const plaintext = this.#sslPipe.read();
            if (!plaintext) break;
            this.bytesRead += plaintext.byteLength;
            this.push(new Uint8Array(plaintext));
        }
    }

    /** Send any writes that were queued before handshake completed */
    #drainWriteQueue(): void {
        while (this.#writeQueue.length > 0) {
            const data = this.#writeQueue.shift()!;
            this.#sslPipe!.write(data);
            this.#flushOutput();
            this.bytesWritten += data.length;
        }
    }

    get _tlsOptions() { return { isServer: this.#isServer, servername: this.#servername }; }
    get _secureContext() { return this.#secureContext; }

    get servername(): string { return this.#servername; }
    set servername(name: string) { this.#servername = name; }

    get negotiatedProtocol(): string | null { return this.alpnProtocol ?? null; }
    get renegotiationError(): Error | null { return null; }

    getPeerCertificate(detailed?: boolean): PeerCertificate {
        if (!this.#sslPipe) return {} as PeerCertificate;
        const cert = this.#sslPipe.certificate;
        if (!cert) return {} as PeerCertificate;

        const parseDN = (dn: string): Record<string, string> => {
            const result: Record<string, string> = {};
            for (const part of dn.split('/')) {
                const eq = part.indexOf('=');
                if (eq > 0) result[part.slice(0, eq)] = part.slice(eq + 1);
            }
            return result;
        };

        return {
            subject: parseDN(cert.subject),
            issuer: parseDN(cert.issuer),
            subjectAltName: cert.subjectAltNames?.join(', '),
            serialNumber: cert.serialNumber,
            validFrom: cert.validFrom,
            validTo: cert.validTo,
            fingerprint: cert.fingerprint256,
            fingerprint256: cert.fingerprint256,
            raw: Buffer.from([]),
        };
    }

    getCertificate(): PeerCertificate | null { return this.getPeerCertificate(); }

    getSharedSigalgs(): string[] {
        // C layer doesn't expose sigalgs; return empty
        return [];
    }

    getTLSTicket(): Buffer | undefined {
        if (!this.#sslPipe) return undefined;
        try {
            const ticket = (this.#sslPipe as any).sessionTicket;
            return ticket ? Buffer.from(ticket) : undefined;
        } catch { return undefined; }
    }

    enableTrace(): void {
        // TLS trace requires C layer support; no-op for now
    }

    setMaxSendFragment(size: number): boolean {
        // SSL_CTX_set_max_send_fragment requires C layer support
        return false;
    }

    setMaxRecvFragment(size: number): boolean {
        return false;
    }

    renegotiate(_options?: any): boolean {
        if (!this.#sslPipe) return false;
        try {
            (this.#sslPipe as any).renegotiate?.();
            return true;
        } catch { return false; }
    }

    getSession(): Buffer | null {
        if (!this.#sslPipe) return null;
        try {
            const sess = (this.#sslPipe as any).session;
            return sess ? Buffer.from(sess) : null;
        } catch { return null; }
    }

    setSession(session: Buffer | string): void {
        if (!this.#sslPipe) return;
        try {
            (this.#sslPipe as any).setSession?.(session instanceof Buffer ? session : Buffer.from(session));
        } catch { /* best-effort */ }
    }

    getPeerFinished(): Buffer | null { return null; }
    getFinished(): Buffer | null { return null; }

    address(): { address: string; family: string; port: number } | {} {
        const s = this.#underlying;
        if (s instanceof NetSocket) return s.address();
        if (s && 'sockname' in s) {
            try {
                const info = (s as any).sockname;
                return { address: info.ip, family: `IPv${info.family}`, port: info.port };
            } catch {}
        }
        return {};
    }

    /** Read is driven by underlying stream on('data') / onread → #feedEncrypted → push */
    protected _read(size: number): void {
        if (this.#underlying instanceof Duplex) {
            // Ensure the underlying stream is in flowing mode
            const state = (this.#underlying as any)._readableState;
            if (state && !state.flowing) {
                (this.#underlying as any).resume();
            }
        }
    }

    protected _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this.#sslPipe) {
            callback(new Error('SSL pipe not initialized'));
            return;
        }

        const data = typeof chunk === 'string' ? new TextEncoder().encode(chunk) :
            Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : chunk;

        // Queue writes until handshake completes
        if (!this.#handshakeComplete) {
            this.#writeQueue.push(data instanceof Uint8Array ? data : new Uint8Array(data));
            callback();
            return;
        }

        try {
            this.#sslPipe.write(data);
            this.#flushOutput();
            this.bytesWritten += data.length;
            callback();
        } catch (err) {
            callback(err as Error);
        }
    }

    destroy(error?: Error): this {
        if (this.#destroyed) return this;
        this.#destroyed = true;
        this.readyState = 'closed';

        if (this.#sslPipe) {
            try { this.#sslPipe.shutdown(); } catch {}
            this.#sslPipe = null;
        }

        if (this.#underlying instanceof Duplex) {
            this.#underlying.destroy();
        } else if (this.#underlying) {
            try { (this.#underlying as CModuleStreams.Stream).close(); } catch {}
        }
        this.#underlying = null;

        if (error) this.emit('error', error);
        this.emit('close');
        return this;
    }

    push(chunk: any, encoding?: BufferEncoding): boolean {
        return (Duplex.prototype as any).push.call(this, chunk, encoding);
    }
}

// ============================================================================
// Server
// ============================================================================

export class Server extends EventEmitter {
    #netServer: NetServer;
    #secureContext: SecureContext;
    #connections: Set<TLSSocket> = new Set();
    #listening: boolean = false;
    #_allowHalfOpen: boolean = false;
    #requestCert: boolean = false;
    #rejectUnauthorized: boolean = true;

    maxConnections: number = 0;
    connections: number = 0;

    constructor(options?: TlsServerOptions, secureConnectionListener?: (socket: TLSSocket) => void);
    constructor(secureConnectionListener?: (socket: TLSSocket) => void);
    constructor(optionsOrListener?: TlsServerOptions | ((socket: TLSSocket) => void), secureConnectionListener?: (socket: TLSSocket) => void) {
        super();

        let options: TlsServerOptions = {};
        if (typeof optionsOrListener === 'function') {
            secureConnectionListener = optionsOrListener;
        } else if (optionsOrListener) {
            options = optionsOrListener;
        }

        this.#_allowHalfOpen = options.allowHalfOpen ?? false;
        this.#requestCert = options.requestCert ?? false;
        this.#rejectUnauthorized = options.rejectUnauthorized ?? true;

        this.#secureContext = new SecureContext({
            key: options.key,
            cert: options.cert,
            ca: options.ca,
            ciphers: options.ciphers,
            minVersion: options.minVersion,
            maxVersion: options.maxVersion,
            dhparam: options.dhparam,
            ecdhCurve: options.ecdhCurve,
        });

        if (secureConnectionListener) {
            this.on('secureConnection', secureConnectionListener);
        }

        this.#netServer = new NetServer({ allowHalfOpen: this.#_allowHalfOpen });
        this.#netServer.on('connection', (socket: NetSocket) => {
            const tcp = (socket as any)._tcp as CModuleStreams.TCP;
            if (!tcp) return;

            const tlsSocket = new TLSSocket(tcp, {
                isServer: true,
                rejectUnauthorized: this.#rejectUnauthorized,
                requestCert: this.#requestCert,
                secureContext: this.#secureContext,
            });

            this.#connections.add(tlsSocket);
            this.connections = this.#connections.size;

            tlsSocket.on('close', () => {
                this.#connections.delete(tlsSocket);
                this.connections = this.#connections.size;
            });

            tlsSocket.on('secureConnect', () => {
                this.emit('secureConnection', tlsSocket);
            });

            tlsSocket.on('error', (err) => {
                this.emit('tlsClientError', err, tlsSocket);
            });
        });

        this.#netServer.on('listening', () => {
            this.#listening = true;
            this.emit('listening');
        });

        this.#netServer.on('error', (err) => {
            this.emit('error', err);
        });

        this.#netServer.on('close', () => {
            this.#listening = false;
            this.emit('close');
        });
    }

    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this;
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    listen(port?: number, backlog?: number, listeningListener?: () => void): this;
    listen(path: string, backlog?: number, listeningListener?: () => void): this;
    listen(options: any, listeningListener?: () => void): this;
    listen(...args: any[]): this {
        (this.#netServer.listen as any)(...args);
        return this;
    }

    address(): { address: string; family: string; port: number } | string | null {
        return this.#netServer.address();
    }

    getConnections(cb: (err: Error | null, count: number) => void): void {
        cb(null, this.#connections.size);
    }

    close(callback?: (err?: Error) => void): this {
        for (const socket of this.#connections) {
            socket.destroy();
        }
        this.#connections.clear();
        this.connections = 0;

        this.#netServer.close(callback);
        return this;
    }

    ref(): this { this.#netServer.ref(); return this; }
    unref(): this { this.#netServer.unref(); return this; }

    get listening(): boolean { return this.#listening; }
    set listening(val: boolean) { this.#listening = val; }
}

// ============================================================================
// Factory functions
// ============================================================================

export function createServer(options?: TlsServerOptions, secureConnectionListener?: (socket: TLSSocket) => void): Server;
export function createServer(secureConnectionListener?: (socket: TLSSocket) => void): Server;
export function createServer(optionsOrListener?: TlsServerOptions | ((socket: TLSSocket) => void), secureConnectionListener?: (socket: TLSSocket) => void): Server {
    return new Server(optionsOrListener as any, secureConnectionListener);
}

export function connect(options: TlsConnectOptions): TLSSocket;
export function connect(port: number, host?: string, options?: TlsConnectOptions, secureConnectListener?: () => void): TLSSocket;
export function connect(port: number, options?: TlsConnectOptions, secureConnectListener?: () => void): TLSSocket;
export function connect(portOrOptions: number | TlsConnectOptions, hostOrOptions?: string | TlsConnectOptions, optionsOrCb?: TlsConnectOptions | (() => void), cb?: () => void): TLSSocket {
    let port: number | undefined;
    let host: string = 'localhost';
    let options: TlsConnectOptions = {};
    let secureConnectListener: (() => void) | undefined;

    if (typeof portOrOptions === 'object') {
        options = portOrOptions;
        port = options.port;
        host = options.host ?? 'localhost';
    } else {
        port = portOrOptions;
        if (typeof hostOrOptions === 'string') {
            host = hostOrOptions;
            if (typeof optionsOrCb === 'function') {
                secureConnectListener = optionsOrCb;
            } else if (optionsOrCb) {
                options = optionsOrCb;
                if (typeof cb === 'function') secureConnectListener = cb;
            }
        } else if (hostOrOptions) {
            if (typeof hostOrOptions === 'function') {
                secureConnectListener = hostOrOptions;
            } else {
                options = hostOrOptions;
                if (typeof optionsOrCb === 'function') secureConnectListener = optionsOrCb;
            }
        }
    }

    const secureContext = new SecureContext({
        key: options.key,
        cert: options.cert,
        ca: options.ca,
        ciphers: options.ciphers,
        minVersion: options.minVersion,
        maxVersion: options.maxVersion,
    });

    // If an existing socket was provided, upgrade it
    if (options.socket) {
        const tlsSocket = new TLSSocket(options.socket, {
            isServer: false,
            rejectUnauthorized: options.rejectUnauthorized ?? true,
            secureContext,
            servername: options.servername ?? host,
        });

        tlsSocket.on('secureConnect', () => {
            if (secureConnectListener) secureConnectListener();
        });

        return tlsSocket;
    }

    // Otherwise create a new TCP connection
    const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
    const tcp = new streams.TCP(family);

    const tlsSocket = new TLSSocket(tcp, {
        isServer: false,
        rejectUnauthorized: options.rejectUnauthorized ?? true,
        secureContext,
        servername: options.servername ?? host,
    });

    tcp.connect({ ip: host, port: port! }).then(() => {
        const localInfo = tcp.sockname;
        tlsSocket.localAddress = localInfo.ip;
        tlsSocket.localPort = localInfo.port;

        const remoteInfo = tcp.peername;
        tlsSocket.remoteAddress = remoteInfo.ip;
        tlsSocket.remotePort = remoteInfo.port;
        tlsSocket.remoteFamily = `IPv${remoteInfo.family}`;

        tlsSocket.on('secureConnect', () => {
            if (secureConnectListener) secureConnectListener();
        });
    }).catch((err) => {
        tlsSocket.emit('error', err);
        tlsSocket.destroy();
    });

    return tlsSocket;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_CIPHERS = ssl.ciphers.join(':');
export const DEFAULT_ECDH_CURVE = 'auto';
export const DEFAULT_MIN_VERSION = 'TLSv1.2';
export const DEFAULT_MAX_VERSION = 'TLSv1.3';
export const rootCertificates: string[] = [];

export function getCiphers(): string[] {
    return [...ssl.ciphers];
}

export function convertProtocols(protocols: string[] | Buffer[] | Buffer): Buffer[] {
    if (Array.isArray(protocols)) {
        return protocols.map(p => typeof p === 'string' ? Buffer.from(p) : p as Buffer);
    }
    return [protocols as Buffer];
}
