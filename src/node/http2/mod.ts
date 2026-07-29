/**
 * node:http2 — real HTTP/2 via @cnojs/http h2 adapter (nghttp2 Session).
 * Cleartext prior-knowledge (h2c) and TLS+ALPN h2 when the socket is already TLS.
 */

const engine = import.meta.use('engine');

import { EventEmitter } from '../events';
import { Duplex, Readable, Writable } from '../stream';
import { Buffer } from '../buffer';
import { Socket, Server as NetServer, connect as netConnect } from '../net';
import * as tls from '../tls';
import type { TLSSocket } from '../tls';
import { H2Connection, type H2Stream as ProtocolH2Stream } from '@cnojs/http/h2';
import { TcpSocket } from '@cnojs/http/socket';
import { h2Available } from '@cnojs/http/h2-native';
import type { H2Header } from '@cnojs/http/h2-native';

export const constants = {
    NGHTTP2_NO_ERROR: 0,
    NGHTTP2_PROTOCOL_ERROR: 1,
    NGHTTP2_INTERNAL_ERROR: 2,
    NGHTTP2_FLOW_CONTROL_ERROR: 3,
    NGHTTP2_SETTINGS_TIMEOUT: 4,
    NGHTTP2_STREAM_CLOSED: 5,
    NGHTTP2_FRAME_SIZE_ERROR: 6,
    NGHTTP2_REFUSED_STREAM: 7,
    NGHTTP2_CANCEL: 8,
    NGHTTP2_COMPRESSION_ERROR: 9,
    NGHTTP2_CONNECT_ERROR: 10,
    NGHTTP2_ENHANCE_YOUR_CALM: 11,
    NGHTTP2_INADEQUATE_SECURITY: 12,
    NGHTTP2_HTTP_1_1_REQUIRED: 13,

    NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
    NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
    NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
    NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
    NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
    NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,

    HTTP2_HEADER_STATUS: ':status',
    HTTP2_HEADER_METHOD: ':method',
    HTTP2_HEADER_AUTHORITY: ':authority',
    HTTP2_HEADER_SCHEME: ':scheme',
    HTTP2_HEADER_PATH: ':path',
    HTTP2_HEADER_CONTENT_TYPE: 'content-type',
    HTTP2_HEADER_CONTENT_LENGTH: 'content-length',

    HTTP2_METHOD_GET: 'GET',
    HTTP2_METHOD_POST: 'POST',

    HTTP_STATUS_OK: 200,
    HTTP_STATUS_NOT_FOUND: 404,

    DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
    DEFAULT_SETTINGS_ENABLE_PUSH: 1,
    DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,

    NGHTTP2_SESSION_SERVER: 0,
    NGHTTP2_SESSION_CLIENT: 1,

    NGHTTP2_STREAM_STATE_IDLE: 1,
    NGHTTP2_STREAM_STATE_OPEN: 2,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
    NGHTTP2_STREAM_STATE_CLOSED: 7,

    NGHTTP2_FLAG_NONE: 0,
    NGHTTP2_FLAG_END_STREAM: 1,
    NGHTTP2_FLAG_END_HEADERS: 4,
    NGHTTP2_FLAG_ACK: 1,
    NGHTTP2_FLAG_PADDED: 8,
    NGHTTP2_FLAG_PRIORITY: 32,
};

function ensureH2(): void {
    if (!h2Available()) {
        throw new Error(
            'HTTP/2 is not available in this build (compile with -DCNO_EMBED_EXT_H2=ON)',
        );
    }
}

function headerObject(pairs: H2Header[]): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [n, v] of pairs) {
        const key = n.toLowerCase();
        const prev = out[key];
        if (prev === undefined) out[key] = v;
        else if (Array.isArray(prev)) prev.push(v);
        else out[key] = [prev, v];
    }
    return out;
}

function toHeaderPairs(headers: Record<string, unknown>): H2Header[] {
    const pairs: H2Header[] = [];
    for (const [k, v] of Object.entries(headers)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            for (const item of v) pairs.push([k, String(item)]);
        } else {
            pairs.push([k, String(v)]);
        }
    }
    return pairs;
}

/** Steal TCP from a Node Socket so nghttp2 owns the read loop (no dual onread). */
function takeTcpForH2(socket: Socket): TcpSocket {
    const tcp = socket._tcp;
    if (!tcp) throw new Error('socket has no TCP handle');
    // Same ownership model as node:http ServerImpl.socketForCoreRequest:
    // Node facade keeps addresses; wire I/O is exclusive to the protocol layer.
    socket._httpOwned = {
        close: () => {
            try {
                tcp.close();
            } catch {
                /* already closed */
            }
        },
    };
    try {
        tcp.stopRead();
    } catch {
        /* not reading */
    }
    Reflect.set(tcp, 'onread', null);
    Reflect.set(socket, '_tcpReadStarted', false);
    const transport = new TcpSocket(tcp);
    transport.close = () => socket.destroy();
    return transport;
}

/**
 * Steal a completed TLSSocket into TcpSocket for H2.
 * Detaches Node duplex pumps so only nghttp2 + TcpSocket own cipher/plain I/O.
 */
function takeTlsForH2(tlsSocket: TLSSocket): TcpSocket {
    const underlying = tlsSocket._underlying;
    const sslPipe = tlsSocket._sslPipe;
    if (!underlying || !sslPipe) {
        throw new Error('TLS socket is not ready for HTTP/2');
    }
    try {
        if (underlying instanceof Socket) {
            try {
                underlying.pause();
            } catch {
                /* */
            }
            const tcp = underlying._tcp;
            if (!tcp) throw new Error('TLS underlying has no TCP handle');
            try {
                tcp.stopRead();
            } catch {
                /* */
            }
            Reflect.set(tcp, 'onread', null);
            Reflect.set(underlying, '_tcpReadStarted', false);
            underlying._httpOwned = {
                close: () => {
                    try {
                        tcp.close();
                    } catch {
                        /* */
                    }
                },
            };
            const transport = new TcpSocket(tcp);
            transport.sslPipe = sslPipe;
            tlsSocket._sslPipe = null;
            tlsSocket._underlying = null;
            const destroyTlsSocket = tlsSocket.destroy.bind(tlsSocket);
            let closing = false;
            tlsSocket.destroy = (error?: Error) => {
                if (closing) return tlsSocket;
                closing = true;
                try {
                    underlying.destroy(error);
                } finally {
                    destroyTlsSocket(error);
                }
                return tlsSocket;
            };
            transport.close = () => { tlsSocket.destroy(); };
            return transport;
        }
        // Raw CModuleStreams.Stream under TLS
        const stream = underlying as CModuleStreams.Stream;
        try {
            stream.stopRead();
        } catch {
            /* */
        }
        Reflect.set(stream, 'onread', null);
        const transport = new TcpSocket(stream);
        transport.sslPipe = sslPipe;
        tlsSocket._sslPipe = null;
        tlsSocket._underlying = null;
        const destroyTlsSocket = tlsSocket.destroy.bind(tlsSocket);
        let closing = false;
        tlsSocket.destroy = (error?: Error) => {
            if (closing) return tlsSocket;
            closing = true;
            try {
                stream.close();
            } finally {
                destroyTlsSocket(error);
            }
            return tlsSocket;
        };
        transport.close = () => { tlsSocket.destroy(); };
        return transport;
    } catch (e) {
        throw e;
    }
}

function isTlsSocket(socket: unknown): socket is TLSSocket {
    return !!socket && typeof socket === 'object'
        && Reflect.get(socket, 'encrypted') === true
        && Reflect.get(socket, '_sslPipe') != null;
}

/* ── Client stream ────────────────────────────────────────────── */

class ClientHttp2Stream extends Duplex {
    readonly id: number;
    private readonly h2Stream: ProtocolH2Stream;
    private bodyPumpStarted = false;

    constructor(h2Stream: ProtocolH2Stream) {
        super({ allowHalfOpen: true });
        this.h2Stream = h2Stream;
        this.id = h2Stream.id;
        h2Stream.whenError(error => this.destroy(error));
        h2Stream.whenHeaders((headers, ended) => {
            this.emit('response', headerObject(headers), 0);
            void this.pumpBody();
            if (ended) {
                this.push(null);
            }
        });
    }

    private async pumpBody(): Promise<void> {
        if (this.bodyPumpStarted) return;
        this.bodyPumpStarted = true;
        try {
            for await (const chunk of this.h2Stream.bodyChunks()) {
                if (!this.push(Buffer.from(chunk))) {
                    // backpressure ignored for minimal surface
                }
            }
            this.push(null);
        } catch (e) {
            this.destroy(e instanceof Error ? e : new Error(String(e)));
        }
    }

    _read(): void {
        void this.pumpBody();
    }

    _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        try {
            const buf = typeof chunk === 'string'
                ? engine.encodeString(chunk)
                : chunk instanceof Uint8Array
                    ? chunk
                    : Buffer.from(String(chunk));
            this.h2Stream.sendData(buf, false);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    _final(cb: (e?: Error | null) => void): void {
        try {
            this.h2Stream.sendData(new Uint8Array(0), true);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    close(code?: number): void {
        this.h2Stream.abort(code ?? 0);
        this.destroy();
    }
}

/* ── Server stream (Node Http2Stream-ish) ─────────────────────── */

class ServerHttp2Stream extends Duplex {
    readonly id: number;
    private readonly h2Stream: ProtocolH2Stream;
    private responded = false;
    private bodyPumpStarted = false;

    constructor(h2Stream: ProtocolH2Stream) {
        super({ allowHalfOpen: true });
        this.h2Stream = h2Stream;
        this.id = h2Stream.id;
        h2Stream.whenError(error => this.destroy(error));
        void this.pumpBody();
    }

    private async pumpBody(): Promise<void> {
        if (this.bodyPumpStarted) return;
        this.bodyPumpStarted = true;
        try {
            for await (const chunk of this.h2Stream.bodyChunks()) {
                this.push(Buffer.from(chunk));
            }
            this.push(null);
        } catch (e) {
            this.destroy(e instanceof Error ? e : new Error(String(e)));
        }
    }

    _read(): void {
        void this.pumpBody();
    }

    _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        try {
            if (!this.responded) {
                this.respond({ ':status': 200 });
            }
            const buf = typeof chunk === 'string'
                ? engine.encodeString(chunk)
                : chunk instanceof Uint8Array
                    ? chunk
                    : Buffer.from(String(chunk));
            this.h2Stream.sendData(buf, false);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    _final(cb: (e?: Error | null) => void): void {
        try {
            if (!this.responded) {
                this.respond({ ':status': 200 }, { endStream: true });
            } else {
                this.h2Stream.sendData(new Uint8Array(0), true);
            }
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    respond(headers: Record<string, unknown>, options?: { endStream?: boolean }): void {
        this.respondPairs(toHeaderPairs(headers), options);
    }

    respondPairs(pairs: H2Header[], options?: { endStream?: boolean }): void {
        if (this.responded) throw new Error('HTTP/2 headers already sent');
        this.responded = true;
        if (!pairs.some(([n]) => n === ':status' || n === constants.HTTP2_HEADER_STATUS)) {
            pairs.unshift([':status', '200']);
        }
        this.h2Stream.respond(pairs, options?.endStream === true);
    }

    end(chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
        return Duplex.prototype.end.call(this, chunk, encodingOrCb, cb) as this;
    }

    close(code?: number): void {
        this.h2Stream.abort(code ?? 0);
        this.destroy();
    }
}

/** Node-compatible request view layered over the protocol stream. */
class Http2ServerRequest extends Readable {
    readonly stream: ServerHttp2Stream;
    readonly headers: Record<string, string | string[]>;
    readonly rawHeaders: string[];
    readonly method: string;
    readonly url: string;
    readonly httpVersion = '2.0';
    readonly httpVersionMajor = 2;
    readonly httpVersionMinor = 0;

    constructor(stream: ServerHttp2Stream, pairs: H2Header[]) {
        super();
        this.stream = stream;
        this.headers = headerObject(pairs);
        this.rawHeaders = [];
        for (const [name, value] of pairs) {
            if (name.startsWith(':')) continue;
            this.rawHeaders.push(name, value);
        }
        this.method = String(this.headers[':method'] ?? 'GET');
        this.url = String(this.headers[':path'] ?? '/');
        stream.on('data', chunk => this.push(chunk));
        stream.on('end', () => this.push(null));
        stream.on('error', error => this.destroy(error instanceof Error ? error : new Error(String(error))));
        stream.on('close', () => {
            if (!this.readableEnded) this.emit('aborted');
        });
    }

    _read(): void {
        // The protocol stream is push-driven by nghttp2 callbacks.
    }
}

/** Node-compatible response view layered over the protocol stream. */
class Http2ServerResponse extends Writable {
    readonly stream: ServerHttp2Stream;
    statusCode = 200;
    statusMessage = '';
    headersSent = false;
    finished = false;
    private headers = new Map<string, { name: string; values: string[] }>();

    constructor(stream: ServerHttp2Stream) {
        super();
        this.stream = stream;
    }

    setHeader(name: string, value: string | number | readonly string[]): this {
        if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
        const values = Array.isArray(value) ? value.map(String) : [String(value)];
        this.headers.set(name.toLowerCase(), { name, values });
        return this;
    }

    getHeader(name: string): string | string[] | undefined {
        const entry = this.headers.get(name.toLowerCase());
        if (!entry) return undefined;
        return entry.values.length === 1 ? entry.values[0] : [...entry.values];
    }

    removeHeader(name: string): void {
        if (this.headersSent) throw new Error('Cannot remove headers after they are sent to the client');
        this.headers.delete(name.toLowerCase());
    }

    writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | Record<string, unknown>,
        headers?: Record<string, unknown>,
    ): this {
        if (this.headersSent) throw new Error('Cannot write headers after they are sent to the client');
        this.statusCode = statusCode;
        if (typeof statusMessageOrHeaders === 'string') {
            this.statusMessage = statusMessageOrHeaders;
        } else if (statusMessageOrHeaders) {
            headers = statusMessageOrHeaders;
        }
        if (headers) {
            for (const [name, value] of Object.entries(headers)) {
                if (value === undefined || value === null) continue;
                this.setHeader(name, Array.isArray(value) ? value.map(String) : String(value));
            }
        }
        const pairs: H2Header[] = [[':status', String(statusCode)]];
        for (const { name, values } of this.headers.values()) {
            const lower = name.toLowerCase();
            if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive'
                || lower === 'proxy-connection' || lower === 'upgrade') continue;
            for (const value of values) pairs.push([name, value]);
        }
        this.stream.respondPairs(pairs, { endStream: false });
        this.headersSent = true;
        return this;
    }

    _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            if (!this.headersSent) this.writeHead(this.statusCode, this.statusMessage || undefined);
            this.stream.write(chunk, encoding, callback);
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    _final(callback: (error?: Error | null) => void): void {
        try {
            if (!this.headersSent) {
                this.writeHead(this.statusCode, this.statusMessage || undefined);
                this.stream.end(() => {
                    this.finished = true;
                    callback();
                });
                return;
            }
            this.stream.end(() => {
                this.finished = true;
                callback();
            });
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    destroy(error?: Error | null): this {
        try {
            this.stream.close();
        } catch {
            /* already closed */
        }
        return super.destroy(error) as this;
    }
}

/* ── Session base ─────────────────────────────────────────────── */

class Http2Session extends EventEmitter {
    protected conn: H2Connection | null = null;
    protected socket: Socket | null = null;
    closed = false;
    destroyed = false;
    type: number;
    alpnProtocol: string | false = 'h2';
    encrypted = false;
    remoteSettings: Record<string, number> = {};
    localSettings: Record<string, number> = {};
    pendingSettingsAck = false;

    constructor(type: number) {
        super();
        this.type = type;
    }

    close(cb?: () => void): void {
        if (this.closed) {
            if (cb) queueMicrotask(cb);
            return;
        }
        this.closed = true;
        this.conn?.close();
        this.conn = null;
        this.emit('close');
        if (cb) queueMicrotask(cb);
    }

    destroy(error?: Error): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.closed = true;
        this.conn?.destroy();
        this.conn = null;
        if (error) this.emit('error', error);
        this.emit('close');
    }

    ping(payload?: Buffer | Uint8Array, cb?: (err: Error | null, duration: number, payload: Buffer) => void): boolean {
        if (!this.conn) return false;
        const start = Date.now();
        this.conn.session.onping = (isAck, p) => {
            if (!isAck) return;
            cb?.(null, Date.now() - start, Buffer.from(p));
        };
        this.conn.session.ping(payload instanceof Uint8Array ? payload : undefined);
        return true;
    }

    goaway(code?: number): void {
        this.conn?.session.goaway(code ?? 0);
    }
}

/* ── Client session ───────────────────────────────────────────── */

class ClientHttp2Session extends Http2Session {
    private authority = 'localhost';

    constructor() {
        super(constants.NGHTTP2_SESSION_CLIENT);
    }

    setAuthority(value: string): void {
        this.authority = value;
    }

    attach(socket: Socket, secure: boolean): void {
        this.socket = socket;
        this.encrypted = secure;
        try {
            socket.pause();
        } catch {
            /* */
        }
        const transport = takeTcpForH2(socket);
        this.conn = new H2Connection(transport, false, secure);
        this.conn.on({
            onError: err => this.emit('error', err),
            onClose: () => this.close(),
        });
        queueMicrotask(() => this.emit('connect', this, socket));
    }

    attachTls(tlsSocket: TLSSocket): void {
        this.socket = tlsSocket as unknown as Socket;
        this.encrypted = true;
        const alpn = tlsSocket.alpnProtocol;
        if (alpn && alpn !== 'h2' && alpn !== 'h2c') {
            throw new Error(`http2.connect: negotiated ALPN '${alpn}', expected h2`);
        }
        const transport = takeTlsForH2(tlsSocket);
        this.conn = new H2Connection(transport, false, true);
        this.conn.on({
            onError: err => this.emit('error', err),
            onClose: () => this.close(),
        });
        queueMicrotask(() => this.emit('connect', this, tlsSocket));
    }

    request(
        headers: Record<string, unknown>,
        options?: { endStream?: boolean },
    ): ClientHttp2Stream {
        if (!this.conn) throw new Error('HTTP/2 session is not connected');
        const pairs = toHeaderPairs(headers);
        const method = pairs.find(([n]) => n === ':method')?.[1] ?? 'GET';
        if (!pairs.some(([n]) => n === ':method')) pairs.unshift([':method', method]);
        if (!pairs.some(([n]) => n === ':path')) pairs.push([':path', '/']);
        if (!pairs.some(([n]) => n === ':scheme')) {
            pairs.push([':scheme', this.encrypted ? 'https' : 'http']);
        }
        if (!pairs.some(([n]) => n === ':authority')) {
            pairs.push([':authority', this.authority]);
        }
        // GET/HEAD default endStream; POST needs endStream:false then write+end
        const end = options?.endStream ?? (method === 'GET' || method === 'HEAD');
        const h2s = this.conn.request(pairs, end);
        return new ClientHttp2Stream(h2s);
    }
}

/* ── Server ───────────────────────────────────────────────────── */

type StreamListener = (
    stream: ServerHttp2Stream,
    headers: Record<string, string | string[]>,
    flags: number,
) => void;

type RequestListener = (
    request: Http2ServerRequest,
    response: Http2ServerResponse,
) => void;

/** Bind nghttp2 session to an accepted transport; emit stream/session on `host`. */
function attachServerSession(
    host: EventEmitter,
    sessions: Set<Http2Session>,
    socket: Socket | TLSSocket,
    secure: boolean,
    requestListener: RequestListener | null,
    streamListener: StreamListener | null,
): void {
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
        return;
    }
    const conn = new H2Connection(transport, true, secure);
    const session = new Http2Session(constants.NGHTTP2_SESSION_SERVER);
    session['conn'] = conn;
    session['socket'] = socket as Socket;
    sessions.add(session);
    conn.on({
        onError: err => host.emit('sessionError', err, session),
        onClose: () => {
            sessions.delete(session);
            session.close();
        },
    });
    conn.onStreamOpen = stream => {
        stream.whenHeaders((hdrs, _ended) => {
            const obj = headerObject(hdrs);
            const serverStream = new ServerHttp2Stream(stream);
            host.emit('stream', serverStream, obj, 0, hdrs);
            if (streamListener) streamListener(serverStream, obj, 0);
            if (requestListener || host.listenerCount('request') > 0) {
                const request = new Http2ServerRequest(serverStream, hdrs);
                const response = new Http2ServerResponse(serverStream);
                host.emit('request', request, response);
                if (requestListener) Reflect.apply(requestListener, host, [request, response]);
            }
        });
    };
    host.emit('session', session);
}

class Http2Server extends NetServer {
    private streamListener: StreamListener | null = null;
    private requestListener: RequestListener | null = null;
    private sessions = new Set<Http2Session>();

    constructor(
        options?: Record<string, unknown> | StreamListener | RequestListener,
        onRequest?: StreamListener | RequestListener,
    ) {
        // pauseOnConnect: accept path must not start Node's TCP read before H2 attaches.
        super({ pauseOnConnect: true });
        ensureH2();
        if (typeof options === 'function') {
            this.requestListener = options as RequestListener;
        } else if (typeof onRequest === 'function') {
            this.requestListener = onRequest as RequestListener;
        }
        this.on('connection', (socket: Socket) => {
            attachServerSession(this, this.sessions, socket, false, this.requestListener, this.streamListener);
        });
    }

    close(cb?: (err?: Error) => void): this {
        for (const s of this.sessions) s.close();
        this.sessions.clear();
        return super.close(cb);
    }
}

/** TLS + ALPN h2 server (Node Http2SecureServer). */
class Http2SecureServer extends EventEmitter {
    private tlsServer: tls.Server;
    private sessions = new Set<Http2Session>();
    private streamListener: StreamListener | null = null;
    private requestListener: RequestListener | null = null;

    constructor(
        options: Record<string, unknown>,
        onRequest?: RequestListener | StreamListener,
    ) {
        super();
        ensureH2();
        if (!options['key'] || !options['cert']) {
            throw new Error('http2.createSecureServer requires key and cert');
        }
        if (typeof onRequest === 'function') {
            this.requestListener = onRequest as RequestListener;
        }

        const alpn = Array.isArray(options['ALPNProtocols'])
            ? (options['ALPNProtocols'] as string[])
            : ['h2'];
        this.tlsServer = tls.createServer({
            key: options['key'] as string | Buffer,
            cert: options['cert'] as string | Buffer,
            ca: options['ca'] as string | Buffer | undefined,
            rejectUnauthorized: options['rejectUnauthorized'] as boolean | undefined,
            ALPNProtocols: alpn,
        }, (tlsSocket: TLSSocket) => {
            const negotiated = tlsSocket.alpnProtocol;
            // Fail closed unless ALPN is h2 (or empty after broken peer — still try h2).
            if (negotiated && negotiated !== 'h2' && negotiated !== 'h2c') {
                tlsSocket.destroy();
                return;
            }
            attachServerSession(
                this,
                this.sessions,
                tlsSocket,
                true,
                this.requestListener,
                this.streamListener,
            );
        });
        this.tlsServer.on('error', (err: Error) => this.emit('error', err));
        this.tlsServer.on('listening', () => this.emit('listening'));
        this.tlsServer.on('close', () => this.emit('close'));
        this.tlsServer.on('tlsClientError', (err: Error, sock: TLSSocket) => {
            this.emit('tlsClientError', err, sock);
        });
    }

    listen(...args: unknown[]): this {
        (this.tlsServer.listen as (...a: unknown[]) => unknown)(...args);
        return this;
    }

    address(): ReturnType<tls.Server['address']> {
        return this.tlsServer.address();
    }

    close(cb?: (err?: Error) => void): this {
        for (const s of this.sessions) s.close();
        this.sessions.clear();
        this.tlsServer.close(cb);
        return this;
    }
}

export function createServer(
    options?: Record<string, unknown> | RequestListener | StreamListener,
    onRequest?: RequestListener | StreamListener,
): Http2Server {
    return new Http2Server(options, onRequest);
}

export function createSecureServer(
    options?: Record<string, unknown> | RequestListener,
    onRequest?: RequestListener,
): Http2SecureServer | Http2Server {
    ensureH2();
    let opts: Record<string, unknown> = {};
    let handler: RequestListener | StreamListener | undefined;
    if (typeof options === 'function') {
        handler = options;
    } else if (options) {
        opts = options;
        if (typeof onRequest === 'function') handler = onRequest;
    } else if (typeof onRequest === 'function') {
        handler = onRequest;
    }

    if (!('key' in opts) && !('cert' in opts)) {
        // No TLS material: same as cleartext createServer (Node allows this shape rarely).
        return createServer(opts, handler);
    }
    if (!opts['key'] || !opts['cert']) {
        throw new Error('http2.createSecureServer requires both key and cert');
    }
    return new Http2SecureServer(opts, handler);
}

export function connect(
    authority: string | URL,
    options?: Record<string, unknown> | ((session: ClientHttp2Session, socket: Socket) => void),
    listener?: (session: ClientHttp2Session, socket: Socket) => void,
): ClientHttp2Session {
    ensureH2();
    let opts: Record<string, unknown> = {};
    let cb = listener;
    if (typeof options === 'function') {
        cb = options;
        opts = {};
    } else if (options) {
        opts = options;
    }

    const url = typeof authority === 'string'
        ? new URL(authority.includes('://') ? authority : `http://${authority}`)
        : authority;
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    const host = url.hostname || 'localhost';
    const secure = url.protocol === 'https:' || opts['protocol'] === 'https:';

    const session = new ClientHttp2Session();
    if (cb) session.once('connect', cb as (session: ClientHttp2Session, socket: Socket) => void);

    session.setAuthority(port === 80 || port === 443 ? host : `${host}:${port}`);

    if (secure) {
        const createConnection = opts['createConnection'];
        if (typeof createConnection === 'function') {
            const sock = createConnection(opts, () => {}) as Socket | TLSSocket;
            const attach = () => {
                try {
                    if (isTlsSocket(sock)) session.attachTls(sock);
                    else session.attach(sock as Socket, true);
                } catch (e) {
                    session.emit('error', e);
                }
            };
            if (isTlsSocket(sock) && sock.alpnProtocol) {
                queueMicrotask(attach);
            } else {
                sock.once('secureConnect', attach);
                sock.once('connect', attach);
                if ((sock as Socket).readyState === 'open' && isTlsSocket(sock) && sock._handshakeComplete) {
                    queueMicrotask(attach);
                }
            }
            sock.on('error', err => session.emit('error', err));
            return session;
        }

        const tlsSocket = tls.connect({
            host,
            port,
            servername: (opts['servername'] as string) ?? host,
            rejectUnauthorized: (opts['rejectUnauthorized'] as boolean | undefined) ?? true,
            ca: opts['ca'] as string | Buffer | undefined,
            cert: opts['cert'] as string | Buffer | undefined,
            key: opts['key'] as string | Buffer | undefined,
            ALPNProtocols: (opts['ALPNProtocols'] as string[]) ?? ['h2'],
        }, () => {
            try {
                session.attachTls(tlsSocket);
            } catch (e) {
                session.emit('error', e);
            }
        });
        tlsSocket.on('error', err => session.emit('error', err));
        return session;
    }

    const socket = netConnect({ port, host }, () => {
        session.attach(socket, false);
    });
    socket.on('error', err => session.emit('error', err));
    return session;
}

export type { ClientHttp2Session, Http2Server, ClientHttp2Stream, ServerHttp2Stream };
export type { Http2SecureServer };

/** RFC 7540 SETTINGS identifiers (also nghttp2 / Node constants). */
const SETTINGS_HEADER_TABLE_SIZE = 0x1;
const SETTINGS_ENABLE_PUSH = 0x2;
const SETTINGS_MAX_CONCURRENT_STREAMS = 0x3;
const SETTINGS_INITIAL_WINDOW_SIZE = 0x4;
const SETTINGS_MAX_FRAME_SIZE = 0x5;
const SETTINGS_MAX_HEADER_LIST_SIZE = 0x6;
const SETTINGS_ENABLE_CONNECT_PROTOCOL = 0x8;

const SETTING_NAME_TO_ID: Record<string, number> = {
    headerTableSize: SETTINGS_HEADER_TABLE_SIZE,
    enablePush: SETTINGS_ENABLE_PUSH,
    maxConcurrentStreams: SETTINGS_MAX_CONCURRENT_STREAMS,
    initialWindowSize: SETTINGS_INITIAL_WINDOW_SIZE,
    maxFrameSize: SETTINGS_MAX_FRAME_SIZE,
    maxHeaderListSize: SETTINGS_MAX_HEADER_LIST_SIZE,
    maxHeaderSize: SETTINGS_MAX_HEADER_LIST_SIZE,
    enableConnectProtocol: SETTINGS_ENABLE_CONNECT_PROTOCOL,
};

const SETTING_ID_TO_NAME: Record<number, string> = {
    [SETTINGS_HEADER_TABLE_SIZE]: 'headerTableSize',
    [SETTINGS_ENABLE_PUSH]: 'enablePush',
    [SETTINGS_MAX_CONCURRENT_STREAMS]: 'maxConcurrentStreams',
    [SETTINGS_INITIAL_WINDOW_SIZE]: 'initialWindowSize',
    [SETTINGS_MAX_FRAME_SIZE]: 'maxFrameSize',
    [SETTINGS_MAX_HEADER_LIST_SIZE]: 'maxHeaderListSize',
    [SETTINGS_ENABLE_CONNECT_PROTOCOL]: 'enableConnectProtocol',
};

function settingsValueAsUint32(id: number, value: unknown): number {
    if (typeof value === 'boolean') {
        if (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL) {
            return value ? 1 : 0;
        }
        throw new TypeError(`Invalid value for setting id ${id}: ${String(value)}`);
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff || !Number.isInteger(n)) {
        throw new RangeError(`Invalid value for setting id ${id}: ${String(value)}`);
    }
    // Node rejects non-0/1 for enablePush
    if ((id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL) && n !== 0 && n !== 1) {
        throw new RangeError(`Invalid value for setting id ${id}: ${n}`);
    }
    if (id === SETTINGS_MAX_FRAME_SIZE && (n < 16384 || n > 16777215)) {
        throw new RangeError(`Invalid value for setting "maxFrameSize": ${n}`);
    }
    if (id === SETTINGS_INITIAL_WINDOW_SIZE && n > 0x7fffffff) {
        throw new RangeError(`Invalid value for setting "initialWindowSize": ${n}`);
    }
    return n >>> 0;
}

export function getDefaultSettings(): Record<string, number | boolean> {
    return {
        headerTableSize: constants.DEFAULT_SETTINGS_HEADER_TABLE_SIZE,
        enablePush: true,
        initialWindowSize: 65535,
        maxFrameSize: 16384,
        maxConcurrentStreams: 4294967295,
        maxHeaderSize: constants.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE,
        maxHeaderListSize: constants.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE,
        enableConnectProtocol: false,
    };
}

/**
 * Serialize HTTP/2 SETTINGS parameters to the SETTINGS frame payload
 * (sequence of 6-byte entries: 2-byte id BE + 4-byte value BE).
 * Matches Node.js `http2.getPackedSettings`.
 */
export function getPackedSettings(settings: Record<string, number | boolean>): Buffer {
    if (settings === null || typeof settings !== 'object') {
        throw new TypeError('The "settings" argument must be of type object');
    }
    const entries: Array<[number, number]> = [];
    for (const [name, raw] of Object.entries(settings)) {
        if (raw === undefined) continue;
        const id = SETTING_NAME_TO_ID[name];
        if (id === undefined) continue;
        entries.push([id, settingsValueAsUint32(id, raw)]);
    }
    // Stable order by identifier (Node sorts by id)
    entries.sort((a, b) => a[0] - b[0]);
    // maxHeaderSize aliases maxHeaderListSize — pack once
    const seen = new Set<number>();
    const unique: Array<[number, number]> = [];
    for (const e of entries) {
        if (seen.has(e[0])) continue;
        seen.add(e[0]);
        unique.push(e);
    }
    const out = Buffer.allocUnsafe(unique.length * 6);
    let off = 0;
    for (const [id, val] of unique) {
        out.writeUInt16BE(id, off);
        out.writeUInt32BE(val, off + 2);
        off += 6;
    }
    return out;
}

/**
 * Parse SETTINGS frame payload bytes into a settings object.
 * Unknown identifiers are ignored. Boolean settings become boolean.
 */
export function getUnpackedSettings(buf: Buffer | Uint8Array): Record<string, number | boolean> {
    if (buf == null || typeof (buf as { byteLength?: unknown }).byteLength !== 'number') {
        throw new TypeError('The "buf" argument must be an instance of Buffer or Uint8Array');
    }
    const u8 = buf instanceof Uint8Array
        ? buf
        : new Uint8Array(0);
    if (u8.byteLength % 6 !== 0) {
        throw new RangeError('The "buf" argument must be a multiple of 6 in length');
    }
    const view = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    const out: Record<string, number | boolean> = {};
    for (let i = 0; i < view.length; i += 6) {
        const id = view.readUInt16BE(i);
        const val = view.readUInt32BE(i + 2);
        const name = SETTING_ID_TO_NAME[id];
        if (!name) continue;
        if (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL) {
            out[name] = val !== 0;
        } else {
            out[name] = val;
        }
        if (id === SETTINGS_MAX_HEADER_LIST_SIZE) {
            out['maxHeaderSize'] = val;
            out['maxHeaderListSize'] = val;
        }
    }
    return out;
}
