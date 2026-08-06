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
const fs = import.meta.use('fs');
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

// The C layer hands back either an ArrayBuffer or a view into a larger one.
// `Buffer.from(view)` treats a view as array-like and copies *elements*, dropping
// byteOffset/byteLength — a session/ticket that is a window into a bigger buffer
// would silently decode as the wrong bytes. Copy the exact window instead.
function bufferFromRaw(raw: ArrayBuffer | ArrayBufferView): Buffer {
    return ArrayBuffer.isView(raw)
        ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
        : Buffer.from(raw);
}
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

/**
 * OpenSSL X509_V_ERR_* → the `code` string Node puts on the error it emits and
 * on `socket.authorizationError`. Callers branch on these (a proxy that retries
 * only on CERT_HAS_EXPIRED, a pinning check that tolerates
 * DEPTH_ZERO_SELF_SIGNED_CERT), so a bare OpenSSL string with `code: undefined`
 * makes every failure indistinguishable.
 */
const X509_ERR_CODES: Record<number, string> = {
    2: 'UNABLE_TO_GET_ISSUER_CERT',
    3: 'UNABLE_TO_GET_CRL',
    4: 'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
    5: 'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
    6: 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
    7: 'CERT_SIGNATURE_FAILURE',
    8: 'CRL_SIGNATURE_FAILURE',
    9: 'CERT_NOT_YET_VALID',
    10: 'CERT_HAS_EXPIRED',
    11: 'CRL_NOT_YET_VALID',
    12: 'CRL_HAS_EXPIRED',
    13: 'ERROR_IN_CERT_NOT_BEFORE_FIELD',
    14: 'ERROR_IN_CERT_NOT_AFTER_FIELD',
    15: 'ERROR_IN_CRL_LAST_UPDATE_FIELD',
    16: 'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
    17: 'OUT_OF_MEM',
    18: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    19: 'SELF_SIGNED_CERT_IN_CHAIN',
    20: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    21: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    22: 'CERT_CHAIN_TOO_LONG',
    23: 'CERT_REVOKED',
    24: 'INVALID_CA',
    25: 'PATH_LENGTH_EXCEEDED',
    26: 'INVALID_PURPOSE',
    27: 'CERT_UNTRUSTED',
    28: 'CERT_REJECTED',
    29: 'SUBJECT_ISSUER_MISMATCH',
    30: 'AKID_SKID_MISMATCH',
    31: 'AKID_ISSUER_SERIAL_MISMATCH',
    32: 'KEYUSAGE_NO_CERTSIGN',
    50: 'APPLICATION_VERIFICATION',
    // 62/63/64 are the name-check failures. Only 62 was mapped, so an IP-SAN
    // mismatch (64) produced an Error with NO `code` at all, and a caller
    // branching on err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' silently missed
    // it. Node reports ERR_TLS_CERT_ALTNAME_INVALID for all three. OBSERVED
    // against Node v24.18.0: case A3 of the hostname matrix.
    62: 'ERR_TLS_CERT_ALTNAME_INVALID',
    63: 'ERR_TLS_CERT_ALTNAME_INVALID',
    64: 'ERR_TLS_CERT_ALTNAME_INVALID',
    68: 'EE_KEY_TOO_SMALL',
    69: 'CA_KEY_TOO_SMALL',
    70: 'CA_MD_TOO_WEAK',
};

type CodedError = Error & { code?: string; reason?: string; host?: string; cert?: PeerCertificate };

/** Attach a Node-shaped `code` (and `reason`) to a verification failure. */
function codedVerifyError(message: string, verifyCode?: number): CodedError {
    const err = new Error(message) as CodedError;
    const mapped = verifyCode === undefined ? undefined : X509_ERR_CODES[verifyCode];
    if (mapped) {
        err.code = mapped;
        err.reason = message;
    }
    return err;
}

/**
 * Build Node's ERR_TLS_CERT_ALTNAME_INVALID for a name-check failure.
 *
 * OpenSSL reports only "hostname mismatch" / "IP address mismatch" and aborts
 * the handshake itself when SSL_set1_host is armed, so the terse text was all a
 * caller ever saw and `host`/`cert` were absent. Node names the host and lists
 * the cert's altnames. Rebuild that when the peer cert is reachable; otherwise
 * keep OpenSSL's text but still attach what we have.
 *
 * X509 codes: 62 hostname, 63 email, 64 IP address mismatch.
 */
function nameFailureError(
    verifyCode: number | undefined,
    rawMessage: string,
    servername: string | undefined,
    cert: PeerCertificate | undefined,
): CodedError {
    const isNameFailure = verifyCode === 62 || verifyCode === 63 || verifyCode === 64;
    const hasCert = !!cert && Object.keys(cert).length > 0;
    if (isNameFailure && servername && hasCert) {
        const detailed = checkServerIdentity(servername, cert!) as CodedError | undefined;
        if (detailed) {
            detailed.cert = cert;
            return detailed;
        }
    }
    const err = codedVerifyError(rawMessage, verifyCode);
    if (isNameFailure) {
        err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
        if (!err.reason) err.reason = rawMessage;
        if (servername) err.host = servername;
        if (hasCert) err.cert = cert;
    }
    return err;
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

type InternalSecureContextOptions = SecureContextOptions & Pick<CModuleSSL.ContextOptions, 'mode' | 'verify' | 'verifyHostname'> & {
    alpn?: string[];
};

export interface SecureContextOptions extends TlsOptions {
    ALPNProtocols?: string[] | Buffer[] | Buffer;
}

function normalizeAlpnProtocols(value: string[] | Buffer[] | Buffer | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    // Node wire format Buffer: length-prefixed protocol list
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof (value as { length?: unknown }).length === 'number'
        && typeof (value as { subarray?: unknown }).subarray === 'function') {
        const buf = value as Buffer;
        const out: string[] = [];
        let i = 0;
        while (i < buf.length) {
            const len = buf[i]!;
            i++;
            if (i + len > buf.length) break;
            out.push(engine.decodeString(buf.subarray(i, i + len)));
            i += len;
        }
        return out.length > 0 ? out : undefined;
    }
    if (!Array.isArray(value)) return undefined;
    const list: string[] = [];
    for (const v of value) {
        if (typeof v === 'string') {
            if (v.length > 0) list.push(v);
        } else if (v && typeof (v as { byteLength?: unknown }).byteLength === 'number') {
            const s = engine.decodeString(v as Uint8Array);
            if (s.length > 0) list.push(s);
        }
    }
    return list.length > 0 ? list : undefined;
}

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
    /** Node's spelling: typed, comma-separated ("DNS:a, IP Address:1.2.3.4"). */
    subjectaltname?: string;
    /** Alias of `subjectaltname`, kept for existing callers of this module. */
    subjectAltName?: string;
    serialNumber?: string;
    /** Node's spelling. */
    valid_from?: string;
    /** Node's spelling. */
    valid_to?: string;
    /** Aliases of valid_from / valid_to. */
    validFrom?: string;
    validTo?: string;
    /**
     * Node reports the SHA-1 digest here. The C layer computes only SHA-256 and
     * does not expose the raw DER, so this is left unset rather than filled with
     * a SHA-256 value that a pin comparison would silently reject.
     */
    fingerprint?: string;
    fingerprint256?: string;
    raw?: Buffer;
}

let defaultCACertificates: string[] = [];
/** null = not probed yet; [] = probed, nothing found. */
let systemCACertificates: string[] | null = null;
let defaultCAOverridden = false;

/**
 * Load the platform trust store, once, synchronously.
 *
 * SecureContext construction is synchronous, so this cannot await. On Windows
 * we read the OS cert stores directly; elsewhere we read the conventional
 * OpenSSL bundle paths. Without this, `verify: true` relies solely on
 * OpenSSL's compiled-in default verify paths, which on Windows point at
 * directories that do not exist — so verification failed closed against
 * every public server (see AGENT.md "TLS trust store").
 */
function loadSystemCACertificates(): string[] {
    if (systemCACertificates !== null) return systemCACertificates;
    const collected: string[] = [];

    let sysname = '';
    try {
        sysname = os.uname().sysname;
    } catch {
        // uname unavailable — fall through to the POSIX bundle probe.
    }

    if (sysname === 'Windows_NT') {
        // ROOT = trusted roots, CA = intermediates. Both belong in the store.
        for (const store of ['ROOT', 'CA']) {
            try {
                const win32 = import.meta.use('win32');
                if (win32 === null) break;	// module absent: no point trying the second store
                const certs = win32.exportCerts(store);
                if (certs?.length) collected.push(...certs);
            } catch {
                // Store unreadable or win32 module absent.
            }
        }
    } else {
        const candidates = sysname === 'Darwin'
            ? ['/etc/ssl/cert.pem', '/opt/homebrew/etc/openssl@3/cert.pem', '/usr/local/etc/openssl@3/cert.pem']
            : sysname === 'FreeBSD'
                ? ['/usr/local/share/certs/ca-root-nss.crt', '/etc/ssl/cert.pem']
                : [
                    '/etc/ssl/certs/ca-certificates.crt',
                    '/etc/pki/tls/certs/ca-bundle.crt',
                    '/etc/pki/tls/cert.pem',
                    '/etc/ssl/cert.pem',
                ];
        for (const path of candidates) {
            try {
                const bytes = fs.readFile(path);
                const text = engine.decodeString(new Uint8Array(bytes));
                if (text.includes('BEGIN CERTIFICATE')) {
                    collected.push(text);
                    break;
                }
            } catch {
                // Missing path — try the next candidate.
            }
        }
    }

    systemCACertificates = collected;
    return collected;
}

/** CA PEMs to trust when the caller supplied no explicit `ca`. */
function effectiveDefaultCACertificates(): string[] {
    // An explicit setDefaultCACertificates() call replaces the system store,
    // matching Node, where it overrides the bundled roots.
    if (defaultCAOverridden) return defaultCACertificates;
    return loadSystemCACertificates();
}

/**
 * Split PEM text into individual certificate blocks.
 *
 * The Windows stores hand back one PEM per entry, but the POSIX bundle paths
 * are a single concatenated file, and `tls.rootCertificates` is specified as
 * one string per certificate.
 */
function splitPemCertificates(input: string): string[] {
    const blocks: string[] = [];
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    for (const match of input.match(re) ?? []) blocks.push(match);
    return blocks;
}

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
        } else {
            // effectiveDefaultCACertificates() falls back to the platform trust
            // store. Reading the bare `defaultCACertificates` here meant the
            // store was never consulted unless the caller had first called
            // setDefaultCACertificates(), so `verify: true` had no trust
            // anchors at all and failed closed against every public server.
            const defaults = effectiveDefaultCACertificates();
            if (defaults.length > 0) opts.ca = defaults.join('\n');
        }
        if (options?.ciphers) opts.ciphers = options.ciphers;
        if (options?.minVersion) opts.minVersion = options.minVersion;
        if (options?.maxVersion) opts.maxVersion = options.maxVersion;
        if (options?.dhparam) opts.dhparam = options.dhparam;
        if (options?.ecdhCurve) opts.ecdhCurve = options.ecdhCurve;
        if (options?.verify !== undefined) opts.verify = options.verify;
        if (options?.verifyHostname !== undefined) opts.verifyHostname = options.verifyHostname;
        const alpn = options?.alpn ?? normalizeAlpnProtocols(options?.ALPNProtocols);
        if (alpn) opts.alpn = alpn;

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
    checkServerIdentity?: (servername: string, cert: PeerCertificate) => Error | undefined;
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
    _requestCert: boolean;
    _checkServerIdentity?: (servername: string, cert: PeerCertificate) => Error | undefined;
    _writeQueue: Uint8Array[];
    _handle: InternalSocketHandle;

    _initTls(): void;
    _flushOutput(): void;
    _feedEncrypted(data: Uint8Array): void;
    _feedEncryptedSafely(data: Uint8Array): void;
    _drainWriteQueue(): void;
    _drainPlaintext(): void;
    _settleAuthorization(): Error | null;

    getPeerCertificate(detailed?: boolean): PeerCertificate;
    getCertificate(): PeerCertificate | null;
    getSharedSigalgs(): string[];
    getCipher(): { name: string; version: string; standardName?: string } | undefined;
    getProtocol(): string | null;
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
    self._requestCert = options?.requestCert ?? false;
    self._servername = options?.servername ?? '';
    self._checkServerIdentity = options?.checkServerIdentity;
    const contextOptions: InternalSecureContextOptions = {
        ...options,
        mode: self._isServer ? 'server' : 'client',
        // A server only asks for a client certificate when requestCert is set,
        // and the C layer's verify flag maps to
        // SSL_VERIFY_PEER|SSL_VERIFY_FAIL_IF_NO_PEER_CERT — which both sends the
        // CertificateRequest and fails the handshake on an anonymous client.
        // Passing it only for clients meant `requestCert` never reached OpenSSL:
        // the server sent no CertificateRequest, got no client certificate, and
        // then reported authorized:true because nothing had failed.
        verify: self._isServer
            ? (self._requestCert && self._rejectUnauthorized)
            : self._rejectUnauthorized,
        // A caller-supplied checkServerIdentity *replaces* the built-in name
        // check in Node, so it must be able to accept a name OpenSSL would
        // refuse. SSL_set1_host fails the handshake in the C layer before any JS
        // runs, so stand it down and let _settleAuthorization run the callback.
        // The chain is still verified; only the name decision moves to JS.
        verifyHostname: !self._isServer && !!self._servername && !options?.checkServerIdentity,
        alpn: normalizeAlpnProtocols(options?.ALPNProtocols),
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
            // This callback is driven by the stream (and, for a native stream,
            // by C). A throw escaping here becomes an uncaught fault that no
            // caller can intercept, so it is contained and reported on the
            // socket instead.
            this._feedEncryptedSafely(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
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
            if (result) this._feedEncryptedSafely(result);
        };
        stream.startRead();
    }
};

/**
 * _feedEncrypted at a callback boundary.
 *
 * Both read pumps call in from outside JS control flow (a stream 'data' event,
 * or the native onread callback). Anything that escapes there surfaces as an
 * uncaught exception or an unhandled rejection that the application cannot
 * intercept, and the socket never settles — so faults are converted into an
 * 'error' on the socket, which is what Node does.
 */
TLSSocket.prototype._feedEncryptedSafely = function _feedEncryptedSafely(this: TLSSocket, data: Uint8Array): void {
    try {
        this._feedEncrypted(data);
    } catch (err) {
        if (this._destroyed) return;
        const error = asError(err);
        try { this.emit('error', error); } catch { /* no consumer; still tear down */ }
        try { this.destroy(); } catch { /* already tearing down */ }
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
        //
        // pipe.handshake() THROWS on a fatal handshake fault (e.g. OpenSSL
        // "certificate verify failed"). This runs inside the underlying
        // stream's onread/'data' callback, so an escaping throw becomes an
        // unhandled job exception and the socket never settles — the peer
        // hangs until its own timeout. Node instead emits 'error' on the
        // TLSSocket. Convert, emit, and tear down.
        let iterations = 0;
        const MAX_HANDSHAKE_ITERATIONS = 16;
        try {
            while (this._sslPipe && !this._sslPipe.handshake()) {
                this._flushOutput();
                if (++iterations >= MAX_HANDSHAKE_ITERATIONS) break;
            }
            this._flushOutput();
        } catch (err) {
            // Flush any alert OpenSSL queued (e.g. bad_certificate) so the
            // peer learns why, then surface the fault the Node way.
            try { this._flushOutput(); } catch { /* wire already gone */ }
            let error = asError(err);
            // The raw OpenSSL text carries no `code`, so every handshake fault
            // looked identical to a caller. When the fault was a certificate
            // rejection the verify result names the exact reason; use it to
            // produce Node's code (CERT_HAS_EXPIRED, DEPTH_ZERO_SELF_SIGNED_CERT,
            // ...) and Node's message.
            try {
                const verify = this._sslPipe?.verifyResult;
                if (verify && !verify.ok) {
                    let cert: PeerCertificate | undefined;
                    try { cert = this.getPeerCertificate(); } catch { /* not exposed on a failed handshake */ }
                    error = nameFailureError(
                        verify.code,
                        verify.error ?? String(error.message),
                        this._isServer ? undefined : this._servername,
                        cert,
                    );
                }
            } catch { /* keep the original error */ }
            this.authorized = false;
            if (!this.authorizationError) this.authorizationError = error;
            this.emit('error', error);
            this.destroy();
            return;
        }

        if (this._sslPipe?.handshakeComplete) {
            this._handshakeComplete = true;
            this._connecting = false;
            this.readyState = 'open';

            const cipher = this._sslPipe.cipher;
            if (cipher) {
                this.protocol = cipher.name;
                this.tlsVersion = cipher.version;
            }
            // Node reports `false` — not null — when no ALPN was negotiated.
            const negotiatedAlpn = this._sslPipe.alpnProtocol;
            this.alpnProtocol = (negotiatedAlpn ?? false) as string | null;

            // Decide authorized/authorizationError, and run the identity check,
            // BEFORE announcing the connection: a 'secureConnect' listener reads
            // socket.authorized to decide whether to trust the peer.
            const identityError = this._settleAuthorization();
            if (identityError && this._rejectUnauthorized) {
                this.emit('error', identityError);
                this.destroy();
                return;
            }

            this.emit('secureConnect');

            // Read any plaintext that arrived with the final handshake flight
            this._drainPlaintext();

            // Flush queued writes now that TLS is ready
            this._drainWriteQueue();
        }
        return;
    }

    // Normal: decrypt and push all available plaintext
    this._drainPlaintext();
};

/**
 * Drain decrypted plaintext out of the SSL pipe.
 *
 * pipe.read() THROWS on a fatal record — a peer that rejects our certificate and
 * drops the connection produces "shutdown while in init" from SSL_read. This
 * runs inside the underlying stream's data callback, so an escaping throw became
 * an unhandled job exception: the process printed an uncaught error the caller
 * had no way to intercept, and the socket never settled.
 *
 * A peer teardown detected during a read is end-of-stream, not an application
 * fault — Node surfaces it as EOF. Emitting 'error' unconditionally would also
 * re-throw whenever the last listener had already detached (a finished
 * keep-alive request), which is how the leak survived the first fix. So report
 * it only when someone is listening, and otherwise close the readable side.
 */
TLSSocket.prototype._drainPlaintext = function _drainPlaintext(this: TLSSocket): void {
    try {
        for (;;) {
            const pipe = this._sslPipe;
            if (!pipe) break;
            const plaintext = pipe.read();
            if (!plaintext) break;
            this.bytesRead += plaintext.byteLength;
            this.push(new Uint8Array(plaintext));
        }
    } catch (err) {
        if (this._destroyed) return;
        const error = asError(err);
        let hasListener = false;
        try {
            const count = (this as unknown as { listenerCount?: (event: string) => number }).listenerCount;
            hasListener = typeof count === 'function' && count.call(this, 'error') > 0;
        } catch {
            hasListener = false;
        }
        if (hasListener) {
            // A listener may itself throw (or reject); this runs inside the
            // underlying stream's read callback, so letting that escape reaches
            // native code as an uncaught fault.
            try { this.emit('error', error); } catch { /* reported; keep tearing down */ }
        } else {
            // No consumer for the fault: treat it as EOF rather than turning it
            // into an uncaught exception.
            try { this.push(null); } catch { /* readable already ended */ }
        }
        try { this.destroy(); } catch { /* already tearing down */ }
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

/**
 * Decide `authorized` / `authorizationError`, and run the hostname identity
 * check. Returns the identity error, if any, so the caller can reject.
 *
 * Two holes this closes:
 *
 *  1. Server side. OpenSSL's verify result is X509_V_OK when verification never
 *     ran, so a server that asked for a client certificate and received none
 *     reported `authorized: true`. Authorized now requires a peer certificate
 *     to actually be present.
 *
 *  2. Client side with rejectUnauthorized:false. The C layer only calls
 *     SSL_set1_host when verifyHostname is set, so the name was never checked
 *     and a certificate issued for another host reported `authorized: true`.
 *     The name check now runs in JS whenever OpenSSL did not run it, so
 *     `authorized` reflects it. Node's contract is that rejectUnauthorized:false
 *     still connects but reports authorized:false with the reason.
 *
 *  3. checkServerIdentity was accepted as an option and never called. It now
 *     runs on every client handshake, and a returned Error rejects the
 *     connection when rejectUnauthorized is set.
 */
TLSSocket.prototype._settleAuthorization = function _settleAuthorization(this: TLSSocket): Error | null {
    const pipe = this._sslPipe;
    if (!pipe) return null;

    let verifyOk = false;
    let verifyCode: number | undefined;
    let verifyMessage: string | undefined;
    try {
        const verify = pipe.verifyResult;
        verifyOk = !!verify?.ok;
        verifyCode = verify?.code;
        verifyMessage = verify?.error;
    } catch {
        // Treat an unreadable verify result as unverified rather than trusted.
        verifyOk = false;
    }

    const peerCert = this.getPeerCertificate();
    const hasPeerCert = !!peerCert && Object.keys(peerCert).length > 0;

    if (!verifyOk) {
        this.authorized = false;
        this.authorizationError = nameFailureError(
            verifyCode,
            verifyMessage ?? `Certificate verification failed: ${verifyCode}`,
            this._isServer ? undefined : this._servername,
            hasPeerCert ? peerCert : undefined,
        );
        return null;
    }

    if (this._isServer) {
        // X509_V_OK with no certificate means nothing was verified.
        if (!hasPeerCert) {
            this.authorized = false;
            if (this._requestCert) {
                this.authorizationError = codedVerifyError('peer did not return a certificate');
            }
            return null;
        }
        this.authorized = true;
        this.authorizationError = null;
        return null;
    }

    // Client: the chain verified (or verification was skipped). The peer name
    // still has to match, and a caller-supplied checkServerIdentity gets the
    // final say — Node calls it on every client handshake.
    const expectedName = this._servername;
    const custom = this._checkServerIdentity;

    // Did OpenSSL already check the name? The C layer calls SSL_set1_host only
    // when the context has verifyHostname set, which tracks rejectUnauthorized.
    // When it did check, its result is authoritative AND more complete than
    // anything reproducible here: the C layer exposes only dNSName SANs
    // (mod_ssl.c, GEN_DNS branch), so iPAddress SANs are invisible to JS and a
    // second built-in check would wrongly reject a valid IP certificate.
    const opensslCheckedName = this._rejectUnauthorized && !!expectedName;

    if (custom && expectedName) {
        // Node calls a caller-supplied checkServerIdentity on every client
        // handshake, so it runs regardless of who else checked.
        let identityError: Error | undefined;
        try {
            identityError = custom(expectedName, peerCert) ?? undefined;
        } catch (err) {
            identityError = asError(err);
        }
        if (identityError) {
            const coded = identityError as CodedError;
            if (!coded.code) coded.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
            this.authorized = false;
            this.authorizationError = coded;
            return coded;
        }
    } else if (hasPeerCert && expectedName && !opensslCheckedName) {
        // rejectUnauthorized:false, so OpenSSL skipped the name check. Node
        // still reports authorized:false for a name mismatch, so run the check
        // here to keep that signal honest. An IP peer name is skipped because
        // iPAddress SANs are not visible from JS (see above) and the check
        // would produce a false mismatch.
        const isIpPeer = /^[0-9.]+$/.test(expectedName) || expectedName.includes(':');
        if (!isIpPeer) {
            const identityError = checkServerIdentity(expectedName, peerCert);
            if (identityError) {
                const coded = identityError as CodedError;
                if (!coded.code) coded.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
                this.authorized = false;
                this.authorizationError = coded;
                // rejectUnauthorized:false must still connect, so this is
                // reported but not returned as a rejection.
                return null;
            }
        }
    }
    this.authorized = true;
    this.authorizationError = null;
    return null;
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

    // The C layer hands back bare names. Node's `subjectaltname` is a
    // comma-separated list of *typed* entries ("DNS:a, IP Address:1.2.3.4"), and
    // checkServerIdentity parses those prefixes. Emitting bare names made the
    // SAN filter match nothing and silently fall back to the CN — so a
    // certificate whose SAN covered only another host could be accepted on its
    // CN alone.
    const rawNames = cert.subjectAltNames ?? [];
    const isIp = (v: string) => /^[0-9.]+$/.test(v) || v.includes(':');
    const typed = rawNames.map(n => (n.startsWith('DNS:') || n.startsWith('IP Address:') || n.startsWith('URI:') || n.startsWith('email:'))
        ? n
        : (isIp(n) ? `IP Address:${n}` : `DNS:${n}`));
    const subjectaltname = typed.length ? typed.join(', ') : undefined;

    const out: PeerCertificate = {
        subject: parseDN(cert.subject),
        issuer: parseDN(cert.issuer),
        // Node's key is lowercase `subjectaltname`. The camelCase spelling is
        // kept as an alias so existing callers of this module keep working.
        subjectaltname,
        subjectAltName: subjectaltname,
        serialNumber: cert.serialNumber,
        valid_from: cert.validFrom,
        valid_to: cert.validTo,
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        fingerprint256: cert.fingerprint256,
        raw: Buffer.from([]),
    };
    // Node's `fingerprint` is the SHA-1 digest. The C layer only computes
    // SHA-256 (mod_ssl.c tjs_ssl_pipe_get_peer_certificate) and does not expose
    // the raw DER, so SHA-1 cannot be derived here. Reporting the SHA-256 digest
    // under the `fingerprint` name would make a pin comparison silently
    // mismatch, so the field is omitted rather than filled with the wrong hash.
    return out;
};

TLSSocket.prototype.getProtocol = function getProtocol(this: TLSSocket): string | null {
    // Node returns the negotiated version, or null before the handshake.
    if (!this._handshakeComplete || !this._sslPipe) return null;
    try {
        const cipher = this._sslPipe.cipher;
        if (cipher?.version) return cipher.version;
        const version = this._sslPipe.version;
        return version ?? null;
    } catch { return null; }
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
        return ticket ? bufferFromRaw(ticket) : undefined;
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
        return sess ? bufferFromRaw(sess) : null;
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

    // Narrow to Uint8Array here rather than casting at each use: a non-string,
    // non-Buffer chunk from a user stream may be any ArrayBufferView, and both
    // _sslPipe.write and the bytesWritten tally need a concrete byte view.
    const data: Uint8Array = typeof chunk === 'string' ? engine.encodeString(chunk) :
        Buffer.isBuffer(chunk) ? new Uint8Array(chunk) :
        chunk instanceof Uint8Array ? chunk :
        ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) :
        new Uint8Array(chunk as ArrayBuffer);

    // Queue writes until handshake completes
    if (!this._handshakeComplete) {
        this._writeQueue.push(data);
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
        ALPNProtocols: options.ALPNProtocols,
        // Without this the server context ran with SSL_VERIFY_NONE, so
        // requestCert never produced a CertificateRequest and every anonymous
        // client was accepted (and reported authorized).
        verify: self._requestCert && self._rejectUnauthorized,
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
            ALPNProtocols: options.ALPNProtocols,
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
    // Narrow to a single net overload: TS cannot resolve a spread of a *union*
    // tuple, and the forms differ only in which trailing args are present.
    const [first, ...rest] = args as [unknown, ...Array<string | number | (() => void)>];
    if (typeof first === 'number') this._netServer.listen(first, ...rest as []);
    else if (typeof first === 'string') this._netServer.listen(first, ...rest as []);
    else this._netServer.listen(first as NetListenOptions, ...rest as []);
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
    // Narrow to one ServerConstructor overload — TS cannot pick one for a union
    // argument, though initServer accepts both shapes at runtime.
    return typeof optionsOrListener === 'function'
        ? new Server(optionsOrListener)
        : new Server(optionsOrListener, secureConnectionListener);
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
        // See initTLSSocket: a caller-supplied checkServerIdentity replaces the
        // built-in name check, so the C-layer SSL_set1_host check must not
        // pre-empt it by failing the handshake first.
        verifyHostname: (options.rejectUnauthorized ?? true)
            && !!(options.servername ?? host)
            && !options.checkServerIdentity,
        key: options.key,
        cert: options.cert,
        ca: options.ca,
        ciphers: options.ciphers,
        minVersion: options.minVersion,
        maxVersion: options.maxVersion,
        dhparam: options.dhparam,
        ecdhCurve: options.ecdhCurve,
        ALPNProtocols: options.ALPNProtocols,
    });

    // If an existing socket was provided, upgrade it
    if (options.socket) {
        const tlsSocket = new TLSSocket(options.socket, {
            isServer: false,
            rejectUnauthorized: options.rejectUnauthorized ?? true,
            secureContext,
            servername: options.servername ?? host,
            ALPNProtocols: options.ALPNProtocols,
            checkServerIdentity: options.checkServerIdentity,
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
        ALPNProtocols: options.ALPNProtocols,
        checkServerIdentity: options.checkServerIdentity,
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
/**
 * The platform trust anchors, one PEM per certificate.
 *
 * Node exposes its bundled Mozilla roots here; cno has no bundled set, so this
 * reports the platform store that `verify: true` actually uses. It was
 * previously a permanently empty array, which told callers no trust anchors
 * existed while the store held dozens.
 */
export const rootCertificates: string[] = (() => {
    try {
        const collected: string[] = [];
        for (const pem of loadSystemCACertificates()) collected.push(...splitPemCertificates(pem));
        return collected;
    } catch {
        // Never let trust-store probing break `import 'node:tls'`.
        return [];
    }
})();

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
    // Without this the override flag stayed false forever, so
    // effectiveDefaultCACertificates() would keep returning the system store
    // and silently ignore the caller's replacement set.
    defaultCAOverridden = true;
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

/**
 * Node's ERR_TLS_CERT_ALTNAME_INVALID carries `reason`, `host` and `cert`
 * alongside `code`, and the message is always the fixed prefix plus `reason`.
 * The exported checkServerIdentity returned a bare Error with none of those, so
 * a caller doing `err.code === 'ERR_TLS_CERT_ALTNAME_INVALID'` or reading
 * `err.host` got undefined. OBSERVED against Node v24.18.0.
 */
function altNameError(reason: string, host: string, cert?: PeerCertificate): CodedError {
    const err = new Error(`Hostname/IP does not match certificate's altnames: ${reason}`) as CodedError;
    err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
    err.reason = reason;
    err.host = host;
    if (cert) err.cert = cert;
    return err;
}

export function checkServerIdentity(servername: string, cert: PeerCertificate): Error | undefined {
    const cn = cert.subject?.CN ?? '';
    const sanText = cert.subjectaltname ?? cert.subjectAltName ?? '';
    const entries = sanText ? sanText.split(',').map(s => s.trim()).filter(Boolean) : [];
    const dnsNames: string[] = [];
    const ipNames: string[] = [];
    for (const entry of entries) {
        if (entry.startsWith('DNS:')) dnsNames.push(entry.slice(4));
        else if (entry.startsWith('IP Address:')) ipNames.push(entry.slice(11).trim());
        else if (entry.startsWith('IP:')) ipNames.push(entry.slice(3).trim());
    }

    const host = servername.toLowerCase();
    const looksLikeIp = /^[0-9.]+$/.test(servername) || servername.includes(':');

    // An IP peer name matches only an iPAddress SAN. Node never falls back to
    // the CN for an IP, and never matches a wildcard against one.
    if (looksLikeIp) {
        for (const ip of ipNames) {
            if (ip.toLowerCase() === host) return undefined;
        }
        return altNameError(
            `IP: ${servername} is not in the cert's list: ${ipNames.join(', ')}`,
            servername, cert,
        );
    }

    // Per RFC 6125 the CN is only consulted when there is no dNSName SAN at all.
    const names = dnsNames.length ? dnsNames : (cn ? [cn] : []);
    if (!names.length) return new Error('Cert has no name');

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
    return altNameError(
        `Host: ${servername}. is not in the cert's altnames: ${sanText || `CN=${cn}`}`,
        servername, cert,
    );
}
