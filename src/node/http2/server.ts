/**
 * node:http2 servers: attachServerSession, Http2Server (cleartext h2c),
 * Http2SecureServer (TLS+ALPN), their factories, and performServerHandshake.
 */

import { EventEmitter } from '../events';
import { Buffer } from '../buffer';
import { Socket, Server as NetServer } from '../net';
import * as tls from '../tls';
import type { TLSSocket } from '../tls';
import { H2Connection } from '@cnojs/http/h2';
import { TcpSocket } from '@cnojs/http/socket';
import { constants } from './constants';
import { ensureH2, h2Error, invalidArgType } from './errors';
import { headerObject } from './headers';
import { isTlsSocket, takeTcpForH2, takeTlsForH2 } from './transport';
import { ServerHttp2Stream } from './stream';
import { Http2ServerRequest, Http2ServerResponse } from './message';
import { Http2Session, normalizeSessionSettings } from './session';

function normalizeServerSettingsUpdate(settings: Record<string, unknown>): Record<string, unknown> {
    const update = normalizeSessionSettings(settings);
    const customSettings = settings['customSettings'];
    if (Object.hasOwn(settings, 'customSettings')
        && customSettings !== null
        && typeof customSettings === 'object'
        && Object.keys(customSettings).length === 0) {
        update.customSettings = {};
    }
    return update;
}

/* ── Server ───────────────────────────────────────────────────── */

export type StreamListener = (
    stream: ServerHttp2Stream,
    headers: Record<string, string | string[]>,
    flags: number,
) => void;

export type RequestListener = (
    request: Http2ServerRequest,
    response: Http2ServerResponse,
) => void;

/** Bind nghttp2 session to an accepted transport; emit stream/session on `host`. */
export function attachServerSession(
    host: EventEmitter,
    sessions: Set<Http2Session>,
    socket: Socket | TLSSocket,
    secure: boolean,
    settings?: Record<string, unknown>,
): Http2Session | null {
    const session = new Http2Session(constants.NGHTTP2_SESSION_SERVER, settings);
    let transport: TcpSocket;
    try {
        if (secure || isTlsSocket(socket)) {
            transport = takeTlsForH2(socket as TLSSocket);
            secure = true;
        } else {
            transport = takeTcpForH2(socket as Socket);
        }
    } catch (e) {
        host.emit('error', e);
        try {
            (socket as Socket).destroy?.();
        } catch {
            /* */
        }
        return null;
    }
    const conn = new H2Connection(transport, true, secure, session['initialSettings']);
    session['conn'] = conn;
    session['socket'] = socket as Socket;
    session['onTransportAttached'](
        secure,
        secure ? ((socket as TLSSocket).alpnProtocol || 'h2') : undefined,
    );
    sessions.add(session);
    session.on('error', err => host.emit('sessionError', err, session));
    session.once('close', () => { sessions.delete(session); });
    conn.on({
        onError: err => session.destroy(err),
        onClose: () => session.close(),
    });
    session.on('stream', (stream: ServerHttp2Stream, headers: Record<string, string | string[]>, flags: number, raw: string[]) => {
        host.emit('stream', stream, headers, flags, raw);
        if (host.listenerCount('request')) {
            host.emit('request', new Http2ServerRequest(stream, headers, undefined, raw), new Http2ServerResponse(stream));
        }
    });
    const acceptStream = conn.session.onstream;
    conn.session.onstream = (id, headers, flags) => {
        if (typeof acceptStream === 'function') acceptStream(id, headers, flags);
        const stream = conn.getStream(id);
        if (stream) session.emit('stream', new ServerHttp2Stream(stream, session), headerObject(headers), flags, headers.flat());
    };
    host.emit('session', session);
    return session;
}

export class Http2Server extends NetServer {
    private sessions = new Set<Http2Session>();
    private settings: Record<string, unknown> | undefined;

    constructor(
        options?: Record<string, unknown> | StreamListener | RequestListener,
        onRequest?: StreamListener | RequestListener,
    ) {
        // pauseOnConnect: accept path must not start Node's TCP read before H2
        // attaches. `checkH2` runs inside the super() argument list so the gate
        // is checked before a net.Server is constructed and thrown away.
        super(Http2Server.checkH2({ pauseOnConnect: true }));
        if (options && typeof options === 'object') {
            const settings = options['settings'] as Record<string, unknown> | undefined;
            if (settings !== undefined) {
                this.settings = normalizeSessionSettings(settings);
            }
        }
        const requestListener = (typeof options === 'function' ? options : onRequest) as RequestListener | undefined;
        if (requestListener) this.on('request', requestListener);
        this.on('connection', (socket: Socket) => {
            attachServerSession(this, this.sessions, socket, false, this.settings);
        });
    }

    private static checkH2<T>(value: T): T {
        ensureH2();
        return value;
    }

    updateSettings(settings: Record<string, unknown>): void {
        const update = normalizeServerSettingsUpdate(settings);
        this.settings = { ...this.settings, ...update };
    }

    close(cb?: (err?: Error) => void): this {
        for (const s of this.sessions) s.close();
        this.sessions.clear();
        return super.close(cb);
    }
}

/**
 * TLS + ALPN h2 server. Extends tls.Server for the TLS server surface, and is the
 * only class createSecureServer may return: never answer a secure request in
 * cleartext.
 */
export class Http2SecureServer extends tls.Server {
    private sessions = new Set<Http2Session>();
    private settings: Record<string, unknown> | undefined;
    /** Retained so setSecureContext can rebuild the underlying context. */
    private secureOptions: Record<string, unknown>;

    constructor(
        options: Record<string, unknown>,
        onRequest?: RequestListener | StreamListener,
    ) {
        const opts = options ?? {};
        const alpn = Array.isArray(opts['ALPNProtocols'])
            ? (opts['ALPNProtocols'] as string[])
            : ['h2'];
        // ensureH2 inside the super() arguments: no TLS listener is built when
        // the h2 gate is shut.
        super(Http2SecureServer.tlsOptions(opts, alpn));
        const { settings, ...secureOptions } = opts;
        this.secureOptions = secureOptions;
        if (settings !== undefined) this.settings = normalizeSessionSettings(settings as Record<string, unknown>);
        if (onRequest) this.on('request', onRequest as RequestListener);
        this.on('secureConnection', (tlsSocket: TLSSocket) => {
            const negotiated = tlsSocket.alpnProtocol;
            // Fail closed unless ALPN is h2 (or empty after a broken peer).
            if (negotiated && negotiated !== 'h2' && negotiated !== 'h2c') {
                tlsSocket.destroy();
                return;
            }
            attachServerSession(
                this,
                this.sessions,
                tlsSocket,
                true,
                this.settings,
            );
        });
    }

    private static tlsOptions(
        opts: Record<string, unknown>,
        alpn: string[],
    ): Record<string, unknown> {
        ensureH2();
        return {
            key: opts['key'] as string | Buffer | undefined,
            cert: opts['cert'] as string | Buffer | undefined,
            ca: opts['ca'] as string | Buffer | undefined,
            requestCert: opts['requestCert'] as boolean | undefined,
            rejectUnauthorized: opts['rejectUnauthorized'] as boolean | undefined,
            ciphers: opts['ciphers'] as string | undefined,
            minVersion: opts['minVersion'] as string | undefined,
            maxVersion: opts['maxVersion'] as string | undefined,
            allowHalfOpen: opts['allowHalfOpen'] as boolean | undefined,
            ALPNProtocols: alpn,
        };
    }

    /** Node's tls.Server method; absent before. Rebuilds the TLS context. */
    setSecureContext(options: Record<string, unknown>): void {
        if (options === null || typeof options !== 'object') {
            throw invalidArgType('options', 'of type object', options);
        }
        this.secureOptions = { ...this.secureOptions, ...options };
        const alpn = Array.isArray(this.secureOptions['ALPNProtocols'])
            ? (this.secureOptions['ALPNProtocols'] as string[])
            : ['h2'];
        const rebuilt = tls.createServer(
            Http2SecureServer.tlsOptions(this.secureOptions, alpn),
        ) as unknown as { _secureContext: unknown };
        (this as unknown as { _secureContext: unknown })._secureContext = rebuilt._secureContext;
    }

    /** Node accepts and validates these; the wire change needs the h2 build. */
    updateSettings(settings: Record<string, unknown>): void {
        const update = normalizeServerSettingsUpdate(settings);
        this.settings = { ...this.settings, ...update };
    }

    close(cb?: (err?: Error) => void): this {
        for (const s of this.sessions) s.close();
        this.sessions.clear();
        return super.close(cb) as this;
    }
}

export function createServer(
    options?: Record<string, unknown> | RequestListener | StreamListener,
    onRequest?: RequestListener | StreamListener,
): Http2Server {
    if (options !== undefined && options !== null
        && typeof options !== 'function' && typeof options !== 'object') {
        throw invalidArgType('options', 'of type object', options);
    }
    if (onRequest !== undefined && typeof onRequest !== 'function') {
        throw invalidArgType('onRequestHandler', 'of type function', onRequest);
    }
    return new Http2Server(options, onRequest);
}

export function createSecureServer(
    options?: Record<string, unknown>,
    onRequest?: RequestListener | StreamListener,
): Http2SecureServer {
    // Node: createSecureServer(fn) is ERR_INVALID_ARG_TYPE, not a handler.
    if (typeof options === 'function') {
        throw invalidArgType('options', 'of type object', options);
    }
    if (options !== undefined && options !== null && typeof options !== 'object') {
        throw invalidArgType('options', 'of type object', options);
    }
    if (onRequest !== undefined && typeof onRequest !== 'function') {
        throw invalidArgType('onRequestHandler', 'of type function', onRequest);
    }
    const opts: Record<string, unknown> = options ?? {};
    // A partial credential pair is a configuration mistake that would otherwise
    // surface as an opaque OpenSSL error at handshake time. Node lets OpenSSL
    // raise it; we raise the coherent, codeful error eagerly. Absent-or-
    // undefined-both is NOT an error (Node succeeds): the resulting TLS server
    // fails every handshake, which is the safe outcome.
    const hasKey = opts['key'] !== undefined && opts['key'] !== null;
    const hasCert = opts['cert'] !== undefined && opts['cert'] !== null;
    if (hasKey !== hasCert) {
        throw h2Error(
            'ERR_MISSING_ARGS',
            'http2.createSecureServer requires both key and cert, or neither',
        );
    }
    return new Http2SecureServer(opts, onRequest);
}

/**
 * Adopt an already-connected socket as a server-side HTTP/2 session.
 * Node's signature; the caller owns the socket's TLS handshake.
 */
export function performServerHandshake(
    socket: Socket | TLSSocket,
    options: Record<string, unknown> = {},
): Http2Session {
    ensureH2();
    const host = new EventEmitter();
    const sessions = new Set<Http2Session>();
    const session = attachServerSession(
        host,
        sessions,
        socket,
        Boolean(options['secure']) || isTlsSocket(socket),
        options['settings'] as Record<string, unknown> | undefined,
    );
    if (!session) throw h2Error('ERR_HTTP2_ERROR', 'HTTP/2 server handshake failed');
    return session;
}
