/**
 * node:tls TLSSocket — the Duplex that owns the SSL pipe: handshake pumping,
 * the plaintext/ciphertext drains, and the authorization settlement.
 *
 * `TLSSocket` is a merged type+value name. The *shape* interface lives in
 * ./types; the empty `export interface TLSSocket extends TLSSocketShape {}`
 * below merges it with the constructor value, so the single
 * `export { TLSSocket }` in ./mod publishes both halves.
 */

import { Duplex } from '../stream';
import { Socket as NetSocket } from '../net';
import { JSStreamSocketWrapper, mergeSuppliedSecureContext } from './context';
import { asError, checkServerIdentity, codedVerifyError, nameFailureError } from './errors';
import {
    bufferFromRaw,
    callStreamMethodQuietly,
    closeNativeStreamQuietly,
    flattenPrototype,
    isPromiseLikeResult,
    isSocketAddressStream,
    normalizeAlpnProtocols,
    shutdownSslPipeQuietly,
} from './_shared';
import type {
    CodedError,
    InternalSecureContextOptions,
    PeerCertificate,
    ReadableStateOwner,
    SslPipeSessionAccess,
    TLSSocket as TLSSocketShape,
    TLSSocketConstructor,
    TLSSocketOptions,
} from './types';

const ssl = import.meta.use('ssl');
const engine = import.meta.use('engine');

export interface TLSSocket extends TLSSocketShape {}

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
    // A caller-supplied context is honoured through the same merge tls.connect
    // uses: reusing the object as-is would drop this connection's verify
    // decision (verify/verifyHostname live on the SSL_CTX and a context from
    // createSecureContext() carries neither), turning a missing-CA failure into
    // an unverified connection.
    self._secureContextStore = mergeSuppliedSecureContext(options?.secureContext, contextOptions);

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
