/**
 * node:tls type definitions.
 *
 * Types only — no runtime code, no native modules, so importing this file
 * cannot affect module evaluation order. The `TLSSocket` / `Server` interfaces
 * here are the *shapes*; the merged type+value declarations that consumers see
 * as `tls.TLSSocket` / `tls.Server` live next to their implementations in
 * ./socket and ./server.
 *
 * The `import type { SecureContext } from './context'` below is the one edge
 * pointing back at an implementation file. `SecureContext` has a private field
 * (`#context`), so its type is nominal and cannot be restated structurally here.
 * Both directions of that edge are `import type`, so nothing is emitted and
 * there is no runtime cycle.
 */

import type { EventEmitter } from '../events';
import type { Duplex } from '../stream';
import type { Server as NetServer, ListenOptions as NetListenOptions } from '../net';
import type { SecureContext } from './context';

// Types

export type TlsPemValue = string | Buffer;
export type TlsKeyObject = { pem?: TlsPemValue; key?: TlsPemValue; passphrase?: string };
export type TlsCertObject = { pem?: TlsPemValue; cert?: TlsPemValue };
export type LookupOptions = { family: 4 | 6 };
export type LookupCallback = (err: Error | null, address: string, family: number) => void;
export type PromiseLikeResult = { then?: unknown; catch?: (onRejected: (err: unknown) => void) => unknown };
export type SslPipeSessionAccess = CModuleSSL.Pipe & {
    sessionTicket?: ArrayBuffer | ArrayBufferView;
    session?: ArrayBuffer | ArrayBufferView;
    renegotiate?: () => void;
    setSession?: (session: Uint8Array) => void;
};

export type ReadableStateOwner = Duplex & {
    _readableState?: { flowing?: boolean };
    resume?: () => unknown;
};
export type InternalSocketHandle = {
    _parentWrap?: object;
    close?: () => void;
    getpeername?: (out: Record<string, unknown>) => void;
};
export type ServerListenArgs =
    | [port?: number, hostname?: string, backlog?: number, listeningListener?: () => void]
    | [port?: number, hostname?: string, listeningListener?: () => void]
    | [port?: number, backlog?: number, listeningListener?: () => void]
    | [path: string, backlog?: number, listeningListener?: () => void]
    | [options: NetListenOptions, listeningListener?: () => void]
    | [handle: unknown, backlog?: number, listeningListener?: () => void];

export type TlsKeyInput = TlsPemValue | TlsKeyObject;
export type TlsCertInput = TlsPemValue | TlsCertObject;

export type CodedError = Error & { code?: string; reason?: string; host?: string; cert?: PeerCertificate };

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

export type InternalSecureContextOptions = SecureContextOptions & Pick<CModuleSSL.ContextOptions, 'mode' | 'verify' | 'verifyHostname'> & {
    alpn?: string[];
};

export interface SecureContextOptions extends TlsOptions {
    ALPNProtocols?: string[] | Buffer[] | Buffer;
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
    /**
     * A context from `tls.createSecureContext()`. Its material takes precedence
     * over the sibling top-level options, matching Node.
     */
    secureContext?: SecureContext;
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

// TLSSocket — Full Duplex stream

export interface TLSSocketOptions extends TlsOptions {
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
    closeGracefully(callback?: (err?: Error) => void): this;
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
