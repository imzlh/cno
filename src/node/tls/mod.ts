/**
 * Node.js tls module
 * Built on CModuleSSL (OpenSSL) + Duplex stream for TLS/SSL
 * TLSSocket is a full Duplex, accepts any underlying Duplex stream
 */

import { EventEmitter } from '../events';
import { Duplex } from '../stream';
import { Socket as NetSocket, Server as NetServer } from '../net';
import type { ListenOptions as NetListenOptions } from '../net';

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const ssl = import.meta.use('ssl');
const engine = import.meta.use('engine');
const dns = import.meta.use('dns');

// Types

type TlsPemValue = string | Buffer;
type TlsKeyObject = { pem?: TlsPemValue; key?: TlsPemValue; passphrase?: string };
type TlsCertObject = { pem?: TlsPemValue; cert?: TlsPemValue };
type LookupOptions = { family: 4 | 6 };
type LookupCallback = (err: Error | null, address: string, family: number) => void;
type PromiseLikeResult = { then?: unknown; catch?: (onRejected: (err: unknown) => void) => unknown };
type SslPipeSessionAccess = CModuleSSL.Pipe & {
    sessionTicket?: ArrayBuffer | ArrayBufferView;
    session?: ArrayBuffer | ArrayBufferView;
    renegotiate?: () => void;
    setSession?: (session: Uint8Array) => void;
};
type ReadableStateOwner = Duplex & {
    _readableState?: { flowing?: boolean };
    resume?: () => unknown;
};
type InternalSocketHandle = {
    _parentWrap?: object;
    close?: () => void;
    getpeername?: (out: Record<string, unknown>) => void;
};
type ServerListenArgs =
    | [port?: number, hostname?: string, backlog?: number, listeningListener?: () => void]
    | [port?: number, hostname?: string, listeningListener?: () => void]
    | [port?: number, backlog?: number, listeningListener?: () => void]
    | [path: string, backlog?: number, listeningListener?: () => void]
    | [options: NetListenOptions, listeningListener?: () => void]
    | [handle: unknown, backlog?: number, listeningListener?: () => void];
export type TlsKeyInput = TlsPemValue | TlsKeyObject;
export type TlsCertInput = TlsPemValue | TlsCertObject;

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export interface TlsOptions {
    ca?: TlsCertInput | TlsCertInput[];
    cert?: TlsCertInput | TlsCertInput[];
    ciphers?: string;
    clientCertEngine?: string;
    crl?: string | string[];
    dhparam?: string;
    ecdhCurve?: string;
    honorCipherOrder?: boolean;
    key?: TlsKeyInput | TlsKeyInput[];
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

type InternalSecureContextOptions = SecureContextOptions & Pick<CModuleSSL.ContextOptions, 'mode' | 'verify' | 'verifyHostname'>;

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
    lookup?: (hostname: string, options: LookupOptions, callback: LookupCallback) => void;
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
    subject?: Record<string, string>;
    issuer?: Record<string, string>;
    subjectAltName?: string;
    serialNumber?: string;
    validFrom?: string;
    validTo?: string;
    fingerprint?: string;
    fingerprint256?: string;
    raw?: Buffer;
}

let defaultCACertificates: string[] = [];

function pemValueToString(value: TlsPemValue | undefined): string | undefined {
    if (value === undefined) return undefined;
    return typeof value === 'string' ? value : value.toString();
}

function keyInputToString(input: TlsKeyInput): string | undefined {
    if (typeof input === 'string' || input instanceof Buffer) return pemValueToString(input);
    return pemValueToString(input.pem ?? input.key);
}

function certInputToString(input: TlsCertInput): string | undefined {
    if (typeof input === 'string' || input instanceof Buffer) return pemValueToString(input);
    return pemValueToString(input.pem ?? input.cert);
}

function isPromiseLikeResult(value: unknown): value is PromiseLikeResult {
    return !!value && typeof value === 'object' && 'then' in value;
}

function isSocketAddressStream(stream: Duplex | CModuleStreams.Stream): stream is CModuleStreams.TCP {
    return 'sockname' in stream;
}

function isGenericDuplexStream(stream: Duplex | CModuleStreams.Stream): boolean {
    if (stream instanceof NetSocket || isSocketAddressStream(stream)) return false;
    return typeof Reflect.get(stream, 'on') === 'function'
        && typeof Reflect.get(stream, 'write') === 'function';
}

function callStreamMethodQuietly(stream: CModuleStreams.Stream, method: 'ref' | 'unref'): void {
    try {
        const fn = Reflect.get(stream, method);
        if (typeof fn === 'function') Reflect.apply(fn, stream, []);
    } catch {
        // Best-effort lifetime hint for native streams.
    }
}

function shutdownSslPipeQuietly(pipe: CModuleSSL.Pipe): void {
    try {
        pipe.shutdown();
    } catch {
        // destroy() must continue cleaning up the underlying stream.
    }
}

function closeNativeStreamQuietly(stream: CModuleStreams.Stream): void {
    try {
        stream.close();
    } catch {
        // destroy() is best-effort once the TLS socket is already closing.
    }
}

class JSStreamSocketWrapper extends Duplex {
    _stream: Duplex | null;
    _handle: InternalSocketHandle;
    encrypted = false;

    constructor(stream?: Duplex) {
        super({ allowHalfOpen: false });
        this._stream = stream ?? null;
        this._handle = {
            close() {},
            getpeername(out: Record<string, unknown>) {
                out.family = undefined;
                out.address = undefined;
                out.port = undefined;
            },
        };

        if (stream) {
            stream.on('data', (chunk: unknown) => this.push(chunk));
            stream.on('end', () => this.push(null));
            stream.on('error', (error: Error) => this.emit('error', error));
            stream.on('close', () => this.emit('close'));
        }
    }

    _read(_size: number): void {
        this._stream?.resume?.();
    }

    _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this._stream) {
            callback();
            return;
        }
        this._stream.write(chunk, encoding, callback);
    }

    _final(callback: (error?: Error | null) => void): void {
        if (!this._stream) {
            callback();
            return;
        }
        this._stream.end(callback);
    }

    destroy(error?: Error): this {
        this._stream?.destroy(error);
        return super.destroy(error);
    }
}

// SecureContext

export class SecureContext {
    #context: CModuleSSL.Context;

    constructor(options?: InternalSecureContextOptions) {
        const opts: CModuleSSL.ContextOptions = {};

        if (options?.mode) opts.mode = options.mode;
        if (options?.key) {
            const k = Array.isArray(options.key) ? options.key[0] : options.key;
            opts.key = keyInputToString(k);
        }
        if (options?.cert) {
            const c = Array.isArray(options.cert) ? options.cert[0] : options.cert;
            opts.cert = certInputToString(c);
        }
        if (options?.ca) {
            const ca = Array.isArray(options.ca) ? options.ca : [options.ca];
            opts.ca = ca.map(c => certInputToString(c)).filter(value => value !== undefined).join('\n');
        } else if (defaultCACertificates.length > 0) {
            opts.ca = defaultCACertificates.join('\n');
        }
        if (options?.ciphers) opts.ciphers = options.ciphers;
        if (options?.minVersion) opts.minVersion = options.minVersion;
        if (options?.maxVersion) opts.maxVersion = options.maxVersion;
        if (options?.dhparam) opts.dhparam = options.dhparam;
        if (options?.ecdhCurve) opts.ecdhCurve = options.ecdhCurve;
        if (options?.verify !== undefined) opts.verify = options.verify;
        if (options?.verifyHostname !== undefined) opts.verifyHostname = options.verifyHostname;

        this.#context = new ssl.Context(opts);
    }

    get context(): CModuleSSL.Context { return this.#context; }
}

export function createSecureContext(options?: SecureContextOptions): SecureContext {
    return new SecureContext(options);
}

// Shared prototype helper (duplicated locally, same pattern as
// events/mod.ts and stream/mod.ts). MUST skip keys the target already
// defines as its own — overwriting an own override with the parent's
// version here previously caused a production hang (headers sent, body
// write silently dropped because a subclass override of a stream method
// got clobbered).
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

// TLSSocket — Full Duplex stream

interface TLSSocketOptions extends TlsOptions {
    isServer?: boolean;
    rejectUnauthorized?: boolean;
    requestCert?: boolean;
    secureContext?: SecureContext;
    servername?: string;
    ALPNProtocols?: string[] | Buffer[] | Buffer;
    enableTrace?: boolean;
    start?: boolean;
}

export interface TLSSocket extends Duplex {
    bytesRead: number;
    bytesWritten: number;
    authorized: boolean;
    authorizationError: Error | null;
    encrypted: boolean;
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
    readyState: 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed';
    alpnProtocol?: string | null;
    protocol?: string;
    tlsVersion?: string;

    readonly _tlsOptions: { isServer: boolean; servername: string };
    readonly _secureContext: SecureContext;
    servername: string;
    readonly negotiatedProtocol: string | null;
    readonly renegotiationError: Error | null;

    _underlying: Duplex | CModuleStreams.Stream | null;
    _sslPipe: CModuleSSL.Pipe | null;
    _secureContextStore: SecureContext;
    _handshakeComplete: boolean;
    _isServer: boolean;
    _servername: string;
    _destroyed: boolean;
    _connecting: boolean;
    _rejectUnauthorized: boolean;
    _writeQueue: Uint8Array[];
    _handle: InternalSocketHandle;

    _initTls(): void;
    _flushOutput(): void;
    _feedEncrypted(data: Uint8Array): void;
    _drainWriteQueue(): void;

    getPeerCertificate(detailed?: boolean): PeerCertificate;
    getCertificate(): PeerCertificate | null;
    getSharedSigalgs(): string[];
    getCipher(): { name: string; version: string; standardName?: string } | undefined;
    getTLSTicket(): Buffer | undefined;
    enableTrace(): void;
    setMaxSendFragment(size: number): boolean;
    setMaxRecvFragment(size: number): boolean;
    renegotiate(options?: unknown): boolean;
    getSession(): Buffer | null;
    setSession(session: Buffer | string): void;
    getPeerFinished(): Buffer | null;
    getFinished(): Buffer | null;
    address(): { address: string; family: string; port: number } | {};
    setTimeout(timeout: number, callback?: () => void): this;
    setNoDelay(noDelay?: boolean): this;
    setKeepAlive(enable?: boolean, initialDelay?: number): this;
    ref(): this;
    unref(): this;
    destroy(error?: Error): this;
    push(chunk: unknown, encoding?: BufferEncoding): boolean;
}

export interface TLSSocketConstructor {
    new (socket: Duplex | CModuleStreams.Stream, options?: TLSSocketOptions): TLSSocket;
    (socket: Duplex | CModuleStreams.Stream, options?: TLSSocketOptions): TLSSocket;
    prototype: TLSSocket;
}

function initTLSSocket(self: TLSSocket, socket: Duplex | CModuleStreams.Stream, options?: TLSSocketOptions): void {
    Duplex.call(self, { allowHalfOpen: false });

    self._underlying = null;
    self._sslPipe = null;
    self._handshakeComplete = false;
    self._destroyed = false;
    self._connecting = false;
    // Queue plaintext writes before handshake completes
    self._writeQueue = [];

    self.bytesRead = 0;
    self.bytesWritten = 0;
    self.authorized = false;
    self.authorizationError = null;
    self.encrypted = true;
    self.readyState = 'closed';
    self._handle = {
        _parentWrap: new JSStreamSocketWrapper(),
        close() {},
    };

    self._isServer = options?.isServer ?? false;
    self._rejectUnauthorized = options?.rejectUnauthorized ?? true;
    self._servername = options?.servername ?? '';
    const contextOptions: InternalSecureContextOptions = {
        ...options,
        mode: self._isServer ? 'server' : 'client',
        verify: !self._isServer && self._rejectUnauthorized,
        verifyHostname: !self._isServer && !!self._servername,
    };
    self._secureContextStore = options?.secureContext ?? new SecureContext(contextOptions);

    self._underlying = socket;

    // Copy address info from NetSocket if available
    if (socket instanceof NetSocket) {
        self.localAddress = socket.localAddress;
        self.localPort = socket.localPort;
        self.remoteAddress = socket.remoteAddress;
        self.remotePort = socket.remotePort;
        self.remoteFamily = socket.remoteFamily;
    }

    self.readyState = 'open';
    const shouldStart = options?.start ?? !(socket instanceof Duplex && !(socket instanceof NetSocket));
    if (shouldStart) self._initTls();
}

export const TLSSocket: TLSSocketConstructor = function TLSSocket(this: TLSSocket | undefined, socket: Duplex | CModuleStreams.Stream, options?: TLSSocketOptions) {
    const target: TLSSocket = this ?? Object.create(TLSSocket.prototype);
    initTLSSocket(target, socket, options);
    return target;
} as TLSSocketConstructor;

Object.setPrototypeOf(TLSSocket, Duplex);
TLSSocket.prototype = Object.create(Duplex.prototype);

TLSSocket.prototype._initTls = function _initTls(this: TLSSocket): void {
    const pipeOpts: CModuleSSL.PipeOptions = {};
    if (this._servername && !this._isServer) {
        pipeOpts.servername = this._servername;
    }

    this._sslPipe = new ssl.Pipe(this._secureContextStore.context, pipeOpts);
    this._connecting = true;
    this.readyState = 'opening';

    // Kick off handshake
    this._sslPipe.handshake();
    this._flushOutput();

    // Wire up the underlying stream
    if (this._underlying instanceof Duplex) {
        this._underlying.on('data', (chunk: Uint8Array | ArrayBuffer) => {
            this._feedEncrypted(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        });
        this._underlying.on('end', () => {
            this.push(null);
        });
        this._underlying.on('error', (err: Error) => {
            this.emit('error', err);
        });
        this._underlying.on('close', () => {
            if (!this._destroyed) this.destroy();
        });
        queueMicrotask(() => {
            if (!this._destroyed && this._underlying instanceof Duplex) {
                this._underlying.resume?.();
            }
        });
    } else {
        // CModuleStreams.Stream — use onread callback
        const stream = this._underlying as CModuleStreams.Stream;
        stream.onread = (result, error) => {
            if (error) {
                this.emit('error', error);
                return;
            }
            if (result === null) {
                this.push(null);
                return;
            }
            if (result) this._feedEncrypted(result);
        };
        stream.startRead();
    }
};

/** Send any pending encrypted output from SSL pipe to the wire */
TLSSocket.prototype._flushOutput = function _flushOutput(this: TLSSocket): void {
    if (!this._sslPipe) return;
    const out = this._sslPipe.getOutput();
    if (!out) return;

    const data = new Uint8Array(out);
    try {
        const result = this._underlying instanceof Duplex
            ? this._underlying.write(data)
            : (this._underlying as CModuleStreams.Stream).write(data);
        if (isPromiseLikeResult(result) && typeof result.catch === 'function') {
            result.catch((err) => this.destroy(err instanceof Error ? err : new Error(String(err))));
        }
    } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
    }
};

/** Feed encrypted data from the wire into SSL pipe, push decrypted plaintext */
TLSSocket.prototype._feedEncrypted = function _feedEncrypted(this: TLSSocket, data: Uint8Array): void {
    if (!this._sslPipe) return;

    this._sslPipe.feed(data);

    if (!this._handshakeComplete) {
        // Drive handshake: flush output, then check if complete.
        // We limit iterations to avoid an infinite loop when the handshake
        // needs more network data (multi-round-trip). After flushing, we
        // break and wait for the next _feedEncrypted call with new data.
        let iterations = 0;
        const MAX_HANDSHAKE_ITERATIONS = 16;
        while (this._sslPipe && !this._sslPipe.handshake()) {
            this._flushOutput();
            if (++iterations >= MAX_HANDSHAKE_ITERATIONS) break;
        }
        this._flushOutput();

        if (this._sslPipe?.handshakeComplete) {
            this._handshakeComplete = true;
            this._connecting = false;
            this.readyState = 'open';

            const verify = this._sslPipe.verifyResult;
            this.authorized = verify.ok;
            if (!verify.ok) {
                this.authorizationError = new Error(verify.error ?? `Certificate verification failed: ${verify.code}`);
            }

            const cipher = this._sslPipe.cipher;
            if (cipher) {
                this.protocol = cipher.name;
                this.tlsVersion = cipher.version;
            }
            this.alpnProtocol = this._sslPipe.alpnProtocol;

            this.emit('secureConnect');

            // Read any plaintext that arrived with the final handshake flight
            for (;;) {
                const pipe = this._sslPipe;
                if (!pipe) break;
                const plaintext = pipe.read();
                if (!plaintext) break;
                this.bytesRead += plaintext.byteLength;
                this.push(new Uint8Array(plaintext));
            }

            // Flush queued writes now that TLS is ready
            this._drainWriteQueue();
        }
        return;
    }

    // Normal: decrypt and push all available plaintext
    for (;;) {
        const pipe = this._sslPipe;
        if (!pipe) break;
        const plaintext = pipe.read();
        if (!plaintext) break;
        this.bytesRead += plaintext.byteLength;
        this.push(new Uint8Array(plaintext));
    }
};

/** Send any writes that were queued before handshake completed */
TLSSocket.prototype._drainWriteQueue = function _drainWriteQueue(this: TLSSocket): void {
    const pipe = this._sslPipe;
    if (!pipe) return;
    while (this._writeQueue.length > 0) {
        const data = this._writeQueue.shift();
        if (data === undefined) continue;
        pipe.write(data);
        this._flushOutput();
        this.bytesWritten += data.length;
    }
};

Object.defineProperty(TLSSocket.prototype, '_tlsOptions', {
    get(this: TLSSocket) { return { isServer: this._isServer, servername: this._servername }; },
    configurable: true,
});

Object.defineProperty(TLSSocket.prototype, '_secureContext', {
    get(this: TLSSocket) { return this._secureContextStore; },
    configurable: true,
});

Object.defineProperty(TLSSocket.prototype, 'servername', {
    get(this: TLSSocket) { return this._servername; },
    set(this: TLSSocket, name: string) { this._servername = name; },
    configurable: true,
});

Object.defineProperty(TLSSocket.prototype, 'negotiatedProtocol', {
    get(this: TLSSocket) { return this.alpnProtocol ?? null; },
    configurable: true,
});

Object.defineProperty(TLSSocket.prototype, 'renegotiationError', {
    get(this: TLSSocket) { return null; },
    configurable: true,
});

TLSSocket.prototype.getPeerCertificate = function getPeerCertificate(this: TLSSocket, detailed?: boolean): PeerCertificate {
    if (!this._sslPipe) return {};
    const cert = this._sslPipe.certificate;
    if (!cert) return {};

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
};

TLSSocket.prototype.getCertificate = function getCertificate(this: TLSSocket): PeerCertificate | null { return this.getPeerCertificate(); };

TLSSocket.prototype.getSharedSigalgs = function getSharedSigalgs(this: TLSSocket): string[] {
    // C layer doesn't expose sigalgs; return empty
    return [];
};

TLSSocket.prototype.getCipher = function getCipher(this: TLSSocket): { name: string; version: string; standardName?: string } | undefined {
    const cipher = this._sslPipe?.cipher;
    if (!cipher) return undefined;
    return { name: cipher.name, version: cipher.version, standardName: cipher.name };
};

TLSSocket.prototype.getTLSTicket = function getTLSTicket(this: TLSSocket): Buffer | undefined {
    if (!this._sslPipe) return undefined;
    try {
        const ticket = (this._sslPipe as SslPipeSessionAccess).sessionTicket;
        return ticket ? Buffer.from(ticket) : undefined;
    } catch { return undefined; }
};

TLSSocket.prototype.enableTrace = function enableTrace(this: TLSSocket): void {
    // TLS trace requires C layer support; no-op for now
};

TLSSocket.prototype.setMaxSendFragment = function setMaxSendFragment(this: TLSSocket, size: number): boolean {
    // SSL_CTX_set_max_send_fragment requires C layer support
    return false;
};

TLSSocket.prototype.setMaxRecvFragment = function setMaxRecvFragment(this: TLSSocket, size: number): boolean {
    return false;
};

TLSSocket.prototype.renegotiate = function renegotiate(this: TLSSocket, _options?: unknown): boolean {
    if (!this._sslPipe) return false;
    try {
        (this._sslPipe as SslPipeSessionAccess).renegotiate?.();
        return true;
    } catch { return false; }
};

TLSSocket.prototype.getSession = function getSession(this: TLSSocket): Buffer | null {
    if (!this._sslPipe) return null;
    try {
        const sess = (this._sslPipe as SslPipeSessionAccess).session;
        return sess ? Buffer.from(sess) : null;
    } catch { return null; }
};

TLSSocket.prototype.setSession = function setSession(this: TLSSocket, session: Buffer | string): void {
    if (!this._sslPipe) return;
    try {
        (this._sslPipe as SslPipeSessionAccess).setSession?.(session instanceof Buffer ? session : Buffer.from(session));
    } catch { /* best-effort */ }
};

TLSSocket.prototype.getPeerFinished = function getPeerFinished(this: TLSSocket): Buffer | null { return null; };
TLSSocket.prototype.getFinished = function getFinished(this: TLSSocket): Buffer | null { return null; };

TLSSocket.prototype.address = function address(this: TLSSocket): { address: string; family: string; port: number } | {} {
    const s = this._underlying;
    if (s instanceof NetSocket) return s.address();
    if (s && isSocketAddressStream(s)) {
        try {
            const info = s.sockname;
            return { address: info.ip, family: `IPv${info.family}`, port: info.port };
        } catch {}
    }
    return {};
};

TLSSocket.prototype.setTimeout = function setTimeout(this: TLSSocket, timeout: number, callback?: () => void): TLSSocket {
    if (this._underlying instanceof NetSocket) {
        this._underlying.setTimeout(timeout, callback);
    } else if (callback) {
        this.once('timeout', callback);
    }
    return this;
};

TLSSocket.prototype.setNoDelay = function setNoDelay(this: TLSSocket, noDelay?: boolean): TLSSocket {
    if (this._underlying instanceof NetSocket) {
        this._underlying.setNoDelay(noDelay);
    }
    return this;
};

TLSSocket.prototype.setKeepAlive = function setKeepAlive(this: TLSSocket, enable?: boolean, initialDelay?: number): TLSSocket {
    if (this._underlying instanceof NetSocket) {
        this._underlying.setKeepAlive(enable, initialDelay);
    }
    return this;
};

TLSSocket.prototype.ref = function ref(this: TLSSocket): TLSSocket {
    if (this._underlying instanceof NetSocket) {
        this._underlying.ref();
    } else if (this._underlying && 'ref' in this._underlying) {
        callStreamMethodQuietly(this._underlying as CModuleStreams.Stream, 'ref');
    }
    return this;
};

TLSSocket.prototype.unref = function unref(this: TLSSocket): TLSSocket {
    if (this._underlying instanceof NetSocket) {
        this._underlying.unref();
    } else if (this._underlying && 'unref' in this._underlying) {
        callStreamMethodQuietly(this._underlying as CModuleStreams.Stream, 'unref');
    }
    return this;
};

/** Read is driven by underlying stream on('data') / onread → _feedEncrypted → push */
TLSSocket.prototype._read = function _read(this: TLSSocket, size: number): void {
    if (this._underlying instanceof Duplex) {
        // Ensure the underlying stream is in flowing mode
        const state = (this._underlying as ReadableStateOwner)._readableState;
        if (state && !state.flowing) {
            (this._underlying as ReadableStateOwner).resume?.();
        }
    }
};

TLSSocket.prototype._write = function _write(this: TLSSocket, chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this._sslPipe) {
        callback(new Error('SSL pipe not initialized'));
        return;
    }

    const data = typeof chunk === 'string' ? engine.encodeString(chunk) :
        Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : chunk;

    // Queue writes until handshake completes
    if (!this._handshakeComplete) {
        this._writeQueue.push(data instanceof Uint8Array ? data : new Uint8Array(data));
        callback();
        return;
    }

    try {
        this._sslPipe.write(data);
        this._flushOutput();
        this.bytesWritten += data.length;
        callback();
    } catch (err) {
        callback(asError(err));
    }
};

TLSSocket.prototype._final = function _final(this: TLSSocket, callback: (error?: Error | null) => void): void {
    if (!this._sslPipe) {
        callback();
        return;
    }

    try {
        this._sslPipe.shutdown();
        this._flushOutput();
    } catch (err) {
        callback(asError(err));
        return;
    }

    if (this._underlying instanceof Duplex) {
        this._underlying.end(() => callback());
        return;
    }

    try {
        const shutdown = (this._underlying as CModuleStreams.Stream & { shutdown?: () => unknown })?.shutdown?.();
        Promise.resolve(shutdown).then(() => callback(), (err) => callback(asError(err)));
    } catch (err) {
        callback(asError(err));
    }
};

TLSSocket.prototype.destroy = function destroy(this: TLSSocket, error?: Error): TLSSocket {
    if (this._destroyed) return this;
    this._destroyed = true;
    // Sync parent Duplex destroyed state
    this.destroyed = true;
    this.readyState = 'closed';

    if (this._sslPipe) {
        shutdownSslPipeQuietly(this._sslPipe);
        this._sslPipe = null;
    }

    if (this._underlying instanceof Duplex) {
        this._underlying.destroy();
    } else if (this._underlying) {
        closeNativeStreamQuietly(this._underlying as CModuleStreams.Stream);
    }
    this._underlying = null;

    if (error) this.emit('error', error);
    this.emit('close');
    return this;
};

TLSSocket.prototype.push = function push(this: TLSSocket, chunk: unknown, encoding?: BufferEncoding): boolean {
    return Duplex.prototype.push.call(this, chunk, encoding);
};

Object.defineProperty(TLSSocket.prototype, 'constructor', {
    value: TLSSocket,
    writable: true,
    configurable: true,
});

flattenPrototype(TLSSocket.prototype);

// Server

export interface Server extends EventEmitter {
    maxConnections: number;
    connections: number;
    listening: boolean;

    _netServer: NetServer;
    _secureContext: SecureContext;
    _connections: Set<TLSSocket>;
    _listening: boolean;
    _allowHalfOpen: boolean;
    _requestCert: boolean;
    _rejectUnauthorized: boolean;

    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this;
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    listen(port?: number, backlog?: number, listeningListener?: () => void): this;
    listen(path: string, backlog?: number, listeningListener?: () => void): this;
    listen(options: NetListenOptions, listeningListener?: () => void): this;
    listen(handle: unknown, backlog?: number, listeningListener?: () => void): this;

    address(): { address: string; family: string; port: number } | string | null;
    getConnections(cb: (err: Error | null, count: number) => void): void;
    close(callback?: (err?: Error) => void): this;
    ref(): this;
    unref(): this;
}

export interface ServerConstructor {
    new (options?: TlsServerOptions, secureConnectionListener?: (socket: TLSSocket) => void): Server;
    new (secureConnectionListener?: (socket: TLSSocket) => void): Server;
    (options?: TlsServerOptions, secureConnectionListener?: (socket: TLSSocket) => void): Server;
    (secureConnectionListener?: (socket: TLSSocket) => void): Server;
    prototype: Server;
}

function initServer(
    self: Server,
    optionsOrListener?: TlsServerOptions | ((socket: TLSSocket) => void),
    secureConnectionListener?: (socket: TLSSocket) => void
): void {
    EventEmitter.call(self);

    self._connections = new Set<TLSSocket>();
    self._listening = false;
    self._allowHalfOpen = false;
    self._requestCert = false;
    self._rejectUnauthorized = true;

    self.maxConnections = 0;
    self.connections = 0;

    let options: TlsServerOptions = {};
    if (typeof optionsOrListener === 'function') {
        secureConnectionListener = optionsOrListener;
    } else if (optionsOrListener) {
        options = optionsOrListener;
    }

    self._allowHalfOpen = options.allowHalfOpen ?? false;
    self._requestCert = options.requestCert ?? false;
    self._rejectUnauthorized = options.rejectUnauthorized ?? true;

    self._secureContext = new SecureContext({
        mode: 'server',
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
        self.on('secureConnection', secureConnectionListener);
    }

    // TLS owns the accepted socket's read pump. Pause the underlying TCP
    // socket at accept time so plaintext bytes are not consumed before
    // TLSSocket installs its handshake reader.
    self._netServer = new NetServer({ allowHalfOpen: self._allowHalfOpen, pauseOnConnect: true });
    self._netServer.on('connection', (socket: NetSocket) => {
        const tlsSocket = new TLSSocket(socket, {
            isServer: true,
            rejectUnauthorized: self._rejectUnauthorized,
            requestCert: self._requestCert,
            secureContext: self._secureContext,
        });
        queueMicrotask(() => {
            if (!tlsSocket.destroyed) socket.resume();
        });

        self._connections.add(tlsSocket);
        self.connections = self._connections.size;

        tlsSocket.on('close', () => {
            self._connections.delete(tlsSocket);
            self.connections = self._connections.size;
        });

        tlsSocket.on('secureConnect', () => {
            self.emit('secureConnection', tlsSocket);
        });

        tlsSocket.on('error', (err: Error) => {
            self.emit('tlsClientError', err, tlsSocket);
        });
    });

    self._netServer.on('listening', () => {
        self._listening = true;
        self.emit('listening');
    });

    self._netServer.on('error', (err: Error) => {
        self.emit('error', err);
    });

    self._netServer.on('close', () => {
        self._listening = false;
        self.emit('close');
    });
}

export const Server: ServerConstructor = function Server(
    this: Server | undefined,
    optionsOrListener?: TlsServerOptions | ((socket: TLSSocket) => void),
    secureConnectionListener?: (socket: TLSSocket) => void
) {
    const target: Server = this ?? Object.create(Server.prototype);
    initServer(target, optionsOrListener, secureConnectionListener);
    return target;
} as ServerConstructor;

Object.setPrototypeOf(Server, EventEmitter);
Server.prototype = Object.create(EventEmitter.prototype);

Server.prototype.listen = function listen(this: Server, ...args: ServerListenArgs): Server {
    this._netServer.listen(...args);
    return this;
};

Server.prototype.address = function address(this: Server): { address: string; family: string; port: number } | string | null {
    return this._netServer.address();
};

Server.prototype.getConnections = function getConnections(this: Server, cb: (err: Error | null, count: number) => void): void {
    cb(null, this._connections.size);
};

Server.prototype.close = function close(this: Server, callback?: (err?: Error) => void): Server {
    for (const socket of this._connections) {
        socket.destroy();
    }
    this._connections.clear();
    this.connections = 0;

    this._netServer.close(callback);
    return this;
};

Server.prototype.ref = function ref(this: Server): Server { this._netServer.ref(); return this; };
Server.prototype.unref = function unref(this: Server): Server { this._netServer.unref(); return this; };

Object.defineProperty(Server.prototype, 'listening', {
    get(this: Server) { return this._listening; },
    set(this: Server, val: boolean) { this._listening = val; },
    configurable: true,
});

Object.defineProperty(Server.prototype, 'constructor', {
    value: Server,
    writable: true,
    configurable: true,
});

flattenPrototype(Server.prototype);

// Factory functions

export function createServer(options?: TlsServerOptions, secureConnectionListener?: (socket: TLSSocket) => void): Server;
export function createServer(secureConnectionListener?: (socket: TLSSocket) => void): Server;
export function createServer(optionsOrListener?: TlsServerOptions | ((socket: TLSSocket) => void), secureConnectionListener?: (socket: TLSSocket) => void): Server {
    return new Server(optionsOrListener, secureConnectionListener);
}

export function connect(options: TlsConnectOptions, secureConnectListener?: () => void): TLSSocket;
export function connect(port: number, host?: string, options?: TlsConnectOptions, secureConnectListener?: () => void): TLSSocket;
export function connect(port: number, options?: TlsConnectOptions, secureConnectListener?: () => void): TLSSocket;
export function connect(
    portOrOptions: number | TlsConnectOptions,
    hostOrOptions?: string | TlsConnectOptions | (() => void),
    optionsOrCb?: TlsConnectOptions | (() => void),
    cb?: () => void
): TLSSocket {
    let port: number | undefined;
    let host: string = 'localhost';
    let options: TlsConnectOptions = {};
    let secureConnectListener: (() => void) | undefined;

    if (typeof portOrOptions === 'object') {
        options = portOrOptions;
        port = options.port;
        host = options.host ?? 'localhost';
        if (typeof hostOrOptions === 'function') {
            secureConnectListener = hostOrOptions;
        }
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
        mode: 'client',
        verify: options.rejectUnauthorized ?? true,
        verifyHostname: (options.rejectUnauthorized ?? true) && !!(options.servername ?? host),
        key: options.key,
        cert: options.cert,
        ca: options.ca,
        ciphers: options.ciphers,
        minVersion: options.minVersion,
        maxVersion: options.maxVersion,
        dhparam: options.dhparam,
        ecdhCurve: options.ecdhCurve,
    });

    // If an existing socket was provided, upgrade it
    if (options.socket) {
        const tlsSocket = new TLSSocket(options.socket, {
            isServer: false,
            rejectUnauthorized: options.rejectUnauthorized ?? true,
            secureContext,
            servername: options.servername ?? host,
            start: true,
        });

        tlsSocket.on('secureConnect', () => {
            if (secureConnectListener) secureConnectListener();
        });

        return tlsSocket;
    }

    // Otherwise create a new TCP connection
    if (port === undefined) throw new TypeError('tls.connect requires a port when socket is not provided');
    const connectPort = port;
    const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
    const tcp = new streams.TCP(family);

    const tlsSocket = new TLSSocket(tcp, {
        isServer: false,
        rejectUnauthorized: options.rejectUnauthorized ?? true,
        secureContext,
        servername: options.servername ?? host,
        start: false,
    });

    // Attach secureConnect listener BEFORE initiating connection to avoid race
    // condition where handshake completes before .then() callback runs.
    if (secureConnectListener) {
        tlsSocket.on('secureConnect', () => {
            secureConnectListener();
        });
    }

    const connectAndHandshake = async () => {
        try {
            const isIPv6 = host.includes(':');
            const lookupFamily = isIPv6 ? 6 : 4;
            let ip = host;
            if (options.lookup) {
                ip = await new Promise<string>((resolve, reject) => {
                    options.lookup!(host, { family: lookupFamily }, (err, address, _family) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve(address);
                    });
                });
            } else {
                const addrs = await dns.resolve(host, { family: isIPv6 ? os.AF_INET6 : os.AF_INET });
                const addr = addrs?.find((a: CModuleDNS.ResolvedAddress) => a.family === lookupFamily) || addrs?.[0];
                if (!addr) throw new Error(`DNS resolution failed for ${host}`);
                ip = addr.ip;
            }
            await tcp.connect({ ip, port: connectPort });
            const localInfo = tcp.sockname;
            tlsSocket.localAddress = localInfo.ip;
            tlsSocket.localPort = localInfo.port;
            const remoteInfo = tcp.peername;
            tlsSocket.remoteAddress = remoteInfo.ip;
            tlsSocket.remotePort = remoteInfo.port;
            tlsSocket.remoteFamily = `IPv${remoteInfo.family}`;
            tlsSocket._initTls();
        } catch (err) {
            tlsSocket.emit('error', err);
            tlsSocket.destroy();
        }
    };
    connectAndHandshake();

    return tlsSocket;
}

// Constants

export const DEFAULT_CIPHERS = ssl.ciphers.join(':');
export const DEFAULT_ECDH_CURVE = 'auto';
export const DEFAULT_MIN_VERSION = 'TLSv1.2';
export const DEFAULT_MAX_VERSION = 'TLSv1.3';
export const rootCertificates: string[] = [];

export function setDefaultCACertificates(certs: string[]): void {
    if (!Array.isArray(certs)) {
        throw new TypeError('The "certs" argument must be an array');
    }
    for (const cert of certs) {
        if (typeof cert !== 'string') {
            throw new TypeError('The "certs" array elements must be a string');
        }
    }
    defaultCACertificates = [...certs];
}

export function getCiphers(): string[] {
    return [...ssl.ciphers].map(cipher => String(cipher).toLowerCase());
}

export function convertProtocols(protocols: string[] | Buffer[] | Buffer): Buffer[] {
    if (Array.isArray(protocols)) {
        return protocols.map(p => typeof p === 'string' ? Buffer.from(p) : p as Buffer);
    }
    return [protocols as Buffer];
}

export function checkServerIdentity(servername: string, cert: PeerCertificate): Error | undefined {
    const cn = cert.subject?.CN ?? '';
    const sans: string[] = cert.subjectAltName
        ? cert.subjectAltName.split(', ')
              .filter((s: string) => s.startsWith('DNS:'))
              .map((s: string) => s.slice(4))
        : [];

    const names = sans.length ? sans : (cn ? [cn] : []);
    if (!names.length) return new Error('Cert has no name');

    const host = servername.toLowerCase();
    for (const name of names) {
        const pattern = name.toLowerCase();
        if (pattern === host) return undefined;
        if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(2);
            if (host.endsWith('.' + suffix) && !host.slice(0, host.length - suffix.length - 1).includes('.')) {
                return undefined;
            }
        }
    }
    return new Error(`Hostname/IP does not match certificate's altnames: Host: ${servername}. is not in the cert's altnames`);
}
