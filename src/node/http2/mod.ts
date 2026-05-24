/**
 * Node.js http2 module
 * Built on nghttp2 (via @cnojs/http/ext-h2) + TLSSocket
 *
 * Implements the Node.js http2 API:
 *   - connect(authority, options) → ClientHttp2Session
 *   - createServer(options, onRequest) → Http2Server (cleartext, h2c)
 *   - createSecureServer(options, onRequest) → Http2SecureServer (TLS + ALPN)
 *   - Http2Session / Http2Stream events
 *   - constants object
 */

import { EventEmitter } from '../events';
import { Duplex } from '../stream';
import { Socket as NetSocket } from '../net';
import { TLSSocket, SecureContext, TlsServerOptions } from '../tls';
import type CModuleExternalHTTP2 from '@cnojs/http/ext-h2';

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const ssl = import.meta.use('ssl');
const engine = import.meta.use('engine');
const nghttp2 = import.meta.use('@cnojs/http/ext-h2') as unknown as typeof CModuleExternalHTTP2;
import { dnsCache } from '@cnojs/http/dns-cache';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type NgSession = InstanceType<typeof nghttp2.Session>;
type NgHeader = CModuleExternalHTTP2.Header;

// ============================================================================
// Constants — mirror Node.js http2.constants
// ============================================================================

export const constants = {
    // HTTP/2 pseudo-headers
    HTTP2_HEADER_AUTHORITY: ':authority',
    HTTP2_HEADER_METHOD: ':method',
    HTTP2_HEADER_PATH: ':path',
    HTTP2_HEADER_PROTOCOL: ':protocol',
    HTTP2_HEADER_SCHEME: ':scheme',
    HTTP2_HEADER_STATUS: ':status',

    // Common headers
    HTTP2_HEADER_CONTENT_LENGTH: 'content-length',
    HTTP2_HEADER_CONTENT_TYPE: 'content-type',
    HTTP2_HEADER_DATE: 'date',
    HTTP2_HEADER_HOST: 'host',

    // Error codes
    NGHTTP2_NO_ERROR: nghttp2.constants.NO_ERROR,
    NGHTTP2_PROTOCOL_ERROR: nghttp2.constants.PROTOCOL_ERROR,
    NGHTTP2_INTERNAL_ERROR: nghttp2.constants.INTERNAL_ERROR,
    NGHTTP2_FLOW_CONTROL_ERROR: nghttp2.constants.FLOW_CONTROL_ERROR,
    NGHTTP2_SETTINGS_TIMEOUT: nghttp2.constants.SETTINGS_TIMEOUT,
    NGHTTP2_STREAM_CLOSED: nghttp2.constants.STREAM_CLOSED,
    NGHTTP2_FRAME_SIZE_ERROR: nghttp2.constants.FRAME_SIZE_ERROR,
    NGHTTP2_REFUSED_STREAM: nghttp2.constants.REFUSED_STREAM,
    NGHTTP2_CANCEL: nghttp2.constants.CANCEL,
    NGHTTP2_COMPRESSION_ERROR: nghttp2.constants.COMPRESSION_ERROR,
    NGHTTP2_CONNECT_ERROR: nghttp2.constants.CONNECT_ERROR,
    NGHTTP2_ENHANCE_YOUR_CALM: nghttp2.constants.ENHANCE_YOUR_CALM,
    NGHTTP2_INADEQUATE_SECURITY: nghttp2.constants.INADEQUATE_SECURITY,
    NGHTTP2_HTTP_1_1_REQUIRED: nghttp2.constants.HTTP_1_1_REQUIRED,

    // Status codes
    HTTP_STATUS_OK: 200,
    HTTP_STATUS_NO_CONTENT: 204,
    HTTP_STATUS_FOUND: 302,
    HTTP_STATUS_NOT_MODIFIED: 304,
    HTTP_STATUS_BAD_REQUEST: 400,
    HTTP_STATUS_UNAUTHORIZED: 401,
    HTTP_STATUS_FORBIDDEN: 403,
    HTTP_STATUS_NOT_FOUND: 404,
    HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
    HTTP_STATUS_BAD_GATEWAY: 502,
    HTTP_STATUS_SERVICE_UNAVAILABLE: 503,
} as const;

// ============================================================================
// Headers type
// ============================================================================

export type IncomingHttpHeaders = Record<string, string | string[] | undefined>;
export type OutgoingHttpHeaders = Record<string, string | number | string[] | undefined>;

function headersToNg(headers: OutgoingHttpHeaders): NgHeader[] {
    const out: NgHeader[] = [];
    for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        const name = k.toLowerCase();
        if (Array.isArray(v)) {
            for (const val of v) out.push([name, String(val)]);
        } else {
            out.push([name, String(v)]);
        }
    }
    return out;
}

function ngToIncoming(headers: NgHeader[]): IncomingHttpHeaders {
    const out: IncomingHttpHeaders = {};
    for (const [name, value] of headers) {
        const existing = out[name];
        if (existing === undefined) {
            out[name] = value;
        } else if (Array.isArray(existing)) {
            existing.push(value);
        } else {
            out[name] = [existing, value];
        }
    }
    return out;
}

// ============================================================================
// Http2Stream — Duplex stream over an HTTP/2 stream
// ============================================================================

export interface StreamPriorityOptions {
    weight?: number;
    parent?: number;
    exclusive?: boolean;
    silent?: boolean;
}

export class Http2Stream extends Duplex {
    readonly id: number;
    readonly session: Http2Session;
    aborted: boolean = false;
    closed: boolean = false;
    destroyed: boolean = false;
    pending: boolean = false;
    rstCode: number = constants.NGHTTP2_NO_ERROR;
    sentHeaders?: OutgoingHttpHeaders;
    sentInfoHeaders?: OutgoingHttpHeaders[];
    sentTrailers?: OutgoingHttpHeaders;

    // End-stream flag: track when we have sent / received END_STREAM
    private _endStreamSent: boolean = false;
    private _endStreamReceived: boolean = false;
    private _pendingWrites: Array<{ chunk: Uint8Array; cb?: (err?: Error) => void }> = [];

    constructor(session: Http2Session, streamId: number) {
        super({ allowHalfOpen: true });
        this.session = session;
        this.id = streamId;
    }

    /** Internal: receive DATA from peer */
    _receiveData(chunk: Uint8Array, endStream: boolean): void {
        if (chunk.length > 0) this.push(chunk);
        if (endStream) {
            this._endStreamReceived = true;
            this.push(null);
        }
    }

    /** Internal: peer sent trailers */
    _receiveTrailers(headers: NgHeader[]): void {
        this.emit('trailers', ngToIncoming(headers), 0);
        this._endStreamReceived = true;
        this.push(null);
    }

    /** Internal: stream closed by nghttp2 */
    _onClose(errorCode: number): void {
        this.rstCode = errorCode;
        if (errorCode !== constants.NGHTTP2_NO_ERROR) {
            this.aborted = true;
            this.emit('aborted');
        }
        this.closed = true;
        this.emit('close');
    }

    _read(_size: number): void {
        // Reads are pushed by the session via _receiveData
    }

    _write(chunk: any, _encoding: string, callback: (err?: Error) => void): void {
        if (this.destroyed || this._endStreamSent) {
            callback(new Error('Stream closed'));
            return;
        }
        const data: Uint8Array = typeof chunk === 'string'
            ? engine.encodeString(chunk)
            : chunk instanceof Uint8Array ? chunk : new globalThis.Uint8Array(chunk);
        try {
            this.session._sendData(this.id, data, false);
            callback();
        } catch (err) {
            callback(err as Error);
        }
    }

    _final(callback: (err?: Error) => void): void {
        if (this._endStreamSent || this.destroyed) {
            callback();
            return;
        }
        try {
            this.session._sendData(this.id, new globalThis.Uint8Array(0), true);
            this._endStreamSent = true;
            callback();
        } catch (err) {
            callback(err as Error);
        }
    }

    /** Close the stream with optional error code */
    close(code: number = constants.NGHTTP2_NO_ERROR, callback?: () => void): void {
        if (this.closed) {
            callback?.();
            return;
        }
        this.session._resetStream(this.id, code);
        this.closed = true;
        if (callback) this.once('close', callback);
    }

    /** Send trailers (must be called after headers, before end) */
    sendTrailers(headers: OutgoingHttpHeaders): void {
        if (this._endStreamSent) throw new Error('Cannot send trailers after end');
        this.session._sendTrailers(this.id, headersToNg(headers));
        this.sentTrailers = headers;
        this._endStreamSent = true;
    }

    /** Set higher priority for this stream */
    priority(_options: StreamPriorityOptions): void {
        // nghttp2 priority API not exposed in our binding; no-op
    }

    setTimeout(msecs: number, callback?: () => void): this {
        if (callback) this.once('timeout', callback);
        if (msecs > 0) {
            setTimeout(() => this.emit('timeout'), msecs);
        }
        return this;
    }

    destroy(error?: Error): this {
        if (this.destroyed) return this;
        this.destroyed = true;
        if (!this.closed) {
            try { this.session._resetStream(this.id, constants.NGHTTP2_CANCEL); } catch {}
        }
        super.destroy(error);
        return this;
    }
}

// ============================================================================
// ClientHttp2Stream — extends Http2Stream with client-specific methods
// ============================================================================

export class ClientHttp2Stream extends Http2Stream {
    /** Internal: peer sent response headers */
    _receiveHeaders(headers: NgHeader[]): void {
        const incoming = ngToIncoming(headers);
        const flags = 0;
        this.emit('response', incoming, flags);
    }

    /** Internal: peer sent push promise */
    _receivePushPromise(_promisedStreamId: number, _headers: NgHeader[]): void {
        // Push promise not implemented in this binding
    }
}

// ============================================================================
// ServerHttp2Stream — extends Http2Stream with server-specific methods
// ============================================================================

export class ServerHttp2Stream extends Http2Stream {
    private _headersSent: boolean = false;

    /** Initial request headers from the client */
    requestHeaders: IncomingHttpHeaders = {};

    /** Send response headers */
    respond(headers?: OutgoingHttpHeaders, options?: { endStream?: boolean; waitForTrailers?: boolean }): void {
        if (this._headersSent) throw new Error('Headers already sent');
        const merged: OutgoingHttpHeaders = { ':status': 200, ...headers };
        if (!(':status' in merged) && !('status' in merged)) merged[':status'] = 200;

        const ngHeaders = headersToNg(merged);
        const endStream = options?.endStream === true;
        this.session._respond(this.id, ngHeaders, endStream);
        this._headersSent = true;
        this.sentHeaders = merged;
        if (endStream) {
            (this as any)._endStreamSent = true;
        }
    }

    /** Send response with file-like source (simplified: just respond + write) */
    respondWithFD(_fd: number, _headers?: OutgoingHttpHeaders, _options?: any): void {
        throw new Error('respondWithFD not implemented');
    }

    respondWithFile(_path: string, _headers?: OutgoingHttpHeaders, _options?: any): void {
        throw new Error('respondWithFile not implemented');
    }

    /** Push promise (server initiates a stream to push) */
    pushStream(
        _headers: OutgoingHttpHeaders,
        _options: any,
        _callback: (err: Error | null, pushStream: ServerHttp2Stream, headers: OutgoingHttpHeaders) => void,
    ): void {
        throw new Error('pushStream not implemented');
    }

    /** Send informational (1xx) headers */
    additionalHeaders(headers: OutgoingHttpHeaders): void {
        const ngHeaders = headersToNg(headers);
        this.session._respond(this.id, ngHeaders, false);
        if (!this.sentInfoHeaders) this.sentInfoHeaders = [];
        this.sentInfoHeaders.push(headers);
    }
}

// ============================================================================
// Http2Session — wraps nghttp2.Session, attaches to a Duplex (TLSSocket / TCP)
// ============================================================================

export interface Http2SessionOptions {
    maxDeflateDynamicTableSize?: number;
    maxSessionMemory?: number;
    maxHeaderListPairs?: number;
    maxOutstandingPings?: number;
    maxSendHeaderBlockLength?: number;
    paddingStrategy?: number;
    peerMaxConcurrentStreams?: number;
    settings?: SettingsOptions;
}

export interface SettingsOptions {
    headerTableSize?: number;
    enablePush?: boolean;
    initialWindowSize?: number;
    maxFrameSize?: number;
    maxConcurrentStreams?: number;
    maxHeaderListSize?: number;
}

export abstract class Http2Session extends EventEmitter {
    protected _ngSession: NgSession;
    protected _socket: Duplex;
    protected _streams: Map<number, Http2Stream> = new Map();
    protected _closed: boolean = false;
    protected _destroyed: boolean = false;
    readonly type: 'client' | 'server';
    readonly alpnProtocol: string;
    readonly encrypted: boolean;

    constructor(isServer: boolean, socket: Duplex, options?: Http2SessionOptions) {
        super();
        this.type = isServer ? 'server' : 'client';
        this._socket = socket;
        this.encrypted = socket instanceof TLSSocket;
        this.alpnProtocol = (socket instanceof TLSSocket && socket.alpnProtocol) || 'h2c';

        const settings: CModuleExternalHTTP2.Settings = {
            headerTableSize: options?.settings?.headerTableSize,
            enablePush: options?.settings?.enablePush ?? !isServer,
            initialWindowSize: options?.settings?.initialWindowSize,
            maxFrameSize: options?.settings?.maxFrameSize,
            maxConcurrentStreams: options?.settings?.maxConcurrentStreams,
            maxHeaderListSize: options?.settings?.maxHeaderListSize,
        };

        this._ngSession = new nghttp2.Session(isServer, settings);
        this._wireCallbacks();
        this._wireSocket();

        // Send connection preface + initial SETTINGS
        this._ngSession.submitSettings(settings);
    }

    /** Wire nghttp2 callbacks to session/stream events */
    private _wireCallbacks(): void {
        const sess = this._ngSession;
        const self = this;

        sess.onsend = (chunk: globalThis.Uint8Array<ArrayBufferLike>) => {
            try { self._socket.write(chunk as Uint8Array); }
            catch (err) { self.emit('error', err); }
        };

        sess.onstream = (streamId: number, headers: NgHeader[], _flags: number) => {
            const hasStatus = headers.some(h => h[0] === ':status');
            const existing = self._streams.get(streamId);

            if (hasStatus) {
                // Client mode: response headers arrived
                if (existing instanceof ClientHttp2Stream) {
                    existing._receiveHeaders(headers);
                }
            } else {
                // Server mode: new request stream
                if (self.type === 'server') {
                    const stream = new ServerHttp2Stream(self, streamId);
                    stream.requestHeaders = ngToIncoming(headers);
                    self._streams.set(streamId, stream);
                    self._ngSession.setStreamUserData(streamId, stream);
                    self.emit('stream', stream, stream.requestHeaders, 0, headers.map(h => h[0]));
                }
            }
        };

        sess.onheaders = (streamId: number, headers: NgHeader[], _flags: number) => {
            const stream = self._streams.get(streamId);
            if (stream) stream._receiveTrailers(headers);
        };

        sess.ondata = (streamId: number, chunk: globalThis.Uint8Array<ArrayBufferLike>, endStream: boolean) => {
            const stream = self._streams.get(streamId);
            if (stream) stream._receiveData(chunk as Uint8Array, endStream);
        };

        sess.onstreamclose = (streamId: number, errorCode: number) => {
            const stream = self._streams.get(streamId);
            if (stream) {
                stream._onClose(errorCode);
                self._streams.delete(streamId);
            }
        };

        sess.ongoaway = (errorCode: number, lastStreamId: number, opaqueData: globalThis.Uint8Array<ArrayBufferLike> | null) => {
            self.emit('goaway', errorCode, lastStreamId, opaqueData);
        };

        sess.onsettings = (isAck: boolean) => {
            if (!isAck) self.emit('remoteSettings', self.remoteSettings);
            else self.emit('localSettings', self.localSettings);
        };

        sess.onping = (isAck: boolean, payload: globalThis.Uint8Array<ArrayBufferLike>) => {
            if (isAck) self.emit('ping.ack', payload);
            else self.emit('ping', payload);
        };

        sess.onerror = (code: number, message: string) => {
            const err = new Error(`HTTP/2 error ${code}: ${message}`);
            (err as any).code = code;
            self.emit('error', err);
        };
    }

    /** Wire Duplex socket to feed received bytes into nghttp2 */
    private _wireSocket(): void {
        this._socket.on('data', (chunk: any) => {
            const data: Uint8Array = chunk instanceof Uint8Array
                ? chunk as Uint8Array
                : new globalThis.Uint8Array(chunk);
            try { this._ngSession.receive(data); }
            catch (err) { this.emit('error', err); }
        });
        this._socket.on('end', () => this._handleSocketEnd());
        this._socket.on('error', (err: Error) => this.emit('error', err));
        this._socket.on('close', () => this._handleSocketEnd());
    }

    private _handleSocketEnd(): void {
        if (this._destroyed) return;
        for (const stream of this._streams.values()) {
            stream._onClose(constants.NGHTTP2_NO_ERROR);
        }
        this._streams.clear();
        this._closed = true;
        this.emit('close');
    }

    get localSettings(): Required<SettingsOptions> {
        return this._ngSession.getSessionInfo().localSettings;
    }

    get remoteSettings(): Required<SettingsOptions> {
        return this._ngSession.getSessionInfo().remoteSettings;
    }

    get socket(): Duplex { return this._socket; }
    get state(): { effectiveLocalWindowSize: number; effectiveRecvDataLength: number; nextStreamID: number; localWindowSize: number; lastProcStreamID: number; remoteWindowSize: number } {
        const info = this._ngSession.getSessionInfo();
        return {
            effectiveLocalWindowSize: info.localWindowSize,
            effectiveRecvDataLength: 0,
            nextStreamID: info.nextStreamId,
            localWindowSize: info.localWindowSize,
            lastProcStreamID: info.lastProcStreamId,
            remoteWindowSize: info.remoteWindowSize,
        };
    }

    /** Send PING */
    ping(payload?: Uint8Array, callback?: (err: Error | null, duration: number, payload: Uint8Array) => void): boolean {
        const start = Date.now();
        try {
            this._ngSession.submitPing(payload);
            if (callback) {
                this.once('ping.ack', (p: Uint8Array) => callback(null, Date.now() - start, p));
            }
            return true;
        } catch (err) {
            if (callback) callback(err as Error, 0, payload ?? new globalThis.Uint8Array(8));
            return false;
        }
    }

    /** Update local settings */
    settings(newSettings: SettingsOptions, callback?: (err: Error | null, settings: SettingsOptions) => void): void {
        try {
            this._ngSession.submitSettings(newSettings);
            if (callback) this.once('localSettings', (s: SettingsOptions) => callback(null, s));
        } catch (err) {
            if (callback) callback(err as Error, newSettings);
        }
    }

    /** Send GOAWAY and begin graceful close */
    goaway(code: number = constants.NGHTTP2_NO_ERROR, _lastStreamID?: number, opaqueData?: Uint8Array): void {
        try { this._ngSession.goaway(code, opaqueData); } catch {}
    }

    /** Close session — sends GOAWAY then closes socket */
    close(callback?: () => void): void {
        if (this._closed) { callback?.(); return; }
        this._closed = true;
        try { this._ngSession.goaway(constants.NGHTTP2_NO_ERROR); } catch {}
        if (callback) this.once('close', callback);
        // Allow streams to drain naturally; socket close happens when nghttp2 finishes
        queueMicrotask(() => {
            try { this._socket.end(); } catch {}
        });
    }

    /** Immediate destroy */
    destroy(error?: Error, _code?: number): void {
        if (this._destroyed) return;
        this._destroyed = true;
        this._closed = true;
        try { this._ngSession.destroy(); } catch {}
        try { this._socket.destroy(); } catch {}
        if (error) this.emit('error', error);
        this.emit('close');
    }

    get destroyed(): boolean { return this._destroyed; }
    get closed(): boolean { return this._closed; }
    get connecting(): boolean { return false; }

    setTimeout(msecs: number, callback?: () => void): this {
        if (callback) this.once('timeout', callback);
        if (msecs > 0) setTimeout(() => this.emit('timeout'), msecs);
        return this;
    }

    // ── Internal helpers for streams ───────────────────────────────────────

    _sendData(streamId: number, data: Uint8Array, endStream: boolean): void {
        this._ngSession.sendData(streamId, data, endStream);
    }

    _resetStream(streamId: number, code: number): void {
        this._ngSession.resetStream(streamId, code);
    }

    _sendTrailers(streamId: number, headers: NgHeader[]): void {
        this._ngSession.sendTrailers(streamId, headers);
    }

    _respond(streamId: number, headers: NgHeader[], endStream: boolean): void {
        this._ngSession.respond(streamId, headers, endStream);
    }
}

// ============================================================================
// ClientHttp2Session
// ============================================================================

export interface ClientSessionRequestOptions {
    endStream?: boolean;
    exclusive?: boolean;
    parent?: number;
    weight?: number;
    waitForTrailers?: boolean;
    signal?: AbortSignal;
}

export class ClientHttp2Session extends Http2Session {
    constructor(socket: Duplex, options?: Http2SessionOptions) {
        super(false, socket, options);
    }

    /**
     * Open a new request stream.
     * @param headers HTTP/2 pseudo-headers + regular headers
     */
    request(headers: OutgoingHttpHeaders, options?: ClientSessionRequestOptions): ClientHttp2Stream {
        if (this._closed || this._destroyed) {
            throw new Error('Session is closed');
        }

        // Default pseudo-headers
        const finalHeaders: OutgoingHttpHeaders = { ...headers };
        if (!finalHeaders[':method']) finalHeaders[':method'] = 'GET';
        if (!finalHeaders[':scheme']) finalHeaders[':scheme'] = this.encrypted ? 'https' : 'http';
        if (!finalHeaders[':path']) finalHeaders[':path'] = '/';

        const endStream = options?.endStream !== false &&
            (finalHeaders[':method'] === 'GET' || finalHeaders[':method'] === 'HEAD' || finalHeaders[':method'] === 'DELETE');

        const ngHeaders = headersToNg(finalHeaders);
        const streamId = this._ngSession.request(ngHeaders, endStream);
        const stream = new ClientHttp2Stream(this, streamId);
        if (endStream) (stream as any)._endStreamSent = true;
        this._streams.set(streamId, stream);
        this._ngSession.setStreamUserData(streamId, stream);

        if (options?.signal) {
            options.signal.addEventListener('abort', () => stream.close(constants.NGHTTP2_CANCEL));
        }

        return stream;
    }
}

// ============================================================================
// ServerHttp2Session
// ============================================================================

export class ServerHttp2Session extends Http2Session {
    constructor(socket: Duplex, options?: Http2SessionOptions) {
        super(true, socket, options);
    }

    altsvc(_alt: string, _originOrStream: number | string): void {
        // ALTSVC not exposed in binding
    }

    origin(..._origins: string[]): void {
        // ORIGIN frame not exposed in binding
    }
}

// ============================================================================
// connect() — client API
// ============================================================================

export interface ClientSessionOptions extends Http2SessionOptions {
    createConnection?: (authority: URL, option: ClientSessionOptions) => Duplex;
    rejectUnauthorized?: boolean;
    ca?: string | string[];
    cert?: string | string[];
    key?: string | string[];
    servername?: string;
    ALPNProtocols?: string[];
    protocol?: 'http:' | 'https:';
}

/**
 * Connect to an HTTP/2 server.
 *
 * @param authority - URL string or URL object (https://host:port)
 * @param options - Session options including TLS config
 * @param listener - Called once on 'connect'
 */
export function connect(
    authority: string | URL,
    options?: ClientSessionOptions,
    listener?: (session: ClientHttp2Session, socket: Duplex) => void,
): ClientHttp2Session {
    const url = typeof authority === 'string' ? new URL(authority) : authority;
    const isSecure = url.protocol === 'https:' || (options?.protocol === 'https:');
    const port = url.port ? parseInt(url.port) : (isSecure ? 443 : 80);
    const host = url.hostname;

    // Allow caller to provide their own connection
    if (options?.createConnection) {
        const socket = options.createConnection(url, options);
        const session = new ClientHttp2Session(socket, options);
        if (listener) session.once('connect', () => listener(session, socket));
        queueMicrotask(() => session.emit('connect', session, socket));
        return session;
    }

    // Build TCP + (optional) TLS
    // We return the session synchronously; connection setup runs in background
    const socketHolder: { socket: Duplex | null } = { socket: null };

    // Create a deferred socket wrapper that becomes a real Duplex once connected
    // For simplicity, use a TLSSocket (always wraps a TCP underneath) for https,
    // or a NetSocket for http.
    let actualSocket: Duplex;

    if (isSecure) {
        const tcp = new streams.TCP(host.includes(':') ? os.AF_INET6 : os.AF_INET);
        const secureContext = new SecureContext({
            ca: options?.ca,
            cert: options?.cert,
            key: options?.key,
        });
        const tlsSocket = new TLSSocket(tcp, {
            isServer: false,
            rejectUnauthorized: options?.rejectUnauthorized ?? true,
            secureContext,
            servername: options?.servername ?? host,
            ALPNProtocols: options?.ALPNProtocols ?? ['h2'],
        });
        actualSocket = tlsSocket;
        socketHolder.socket = tlsSocket;

        // Resolve DNS then connect
        (async () => {
            try {
                const isIPv6 = host.includes(':');
                const addrs = await dnsCache.resolve(host, { family: isIPv6 ? 10 : 0 });
                if (!addrs?.length) throw new Error(`DNS resolution failed for ${host}`);
                const addr = addrs.find((a: any) => a.family === (isIPv6 ? 10 : 4)) || addrs[0];
                await tcp.connect({ ip: addr.ip, port });
                tcp.setNoDelay(true);
            } catch (err) {
                tlsSocket.emit('error', err);
            }
        })();
    } else {
        const sock = new NetSocket();
        actualSocket = sock;
        socketHolder.socket = sock;
        sock.connect(port, host);
    }

    const session = new ClientHttp2Session(actualSocket, options);

    const fireConnect = () => {
        if (listener) listener(session, actualSocket);
        session.emit('connect', session, actualSocket);
    };

    if (isSecure) {
        (actualSocket as TLSSocket).once('secureConnect', fireConnect);
    } else {
        (actualSocket as NetSocket).once('connect', fireConnect);
    }

    return session;
}

// ============================================================================
// Server — Http2Server (cleartext h2c) and Http2SecureServer (TLS + ALPN)
// ============================================================================

export interface ServerOptions extends Http2SessionOptions {
    maxSessionMemory?: number;
    allowHTTP1?: boolean;
}

export interface SecureServerOptions extends ServerOptions, TlsServerOptions {
    allowHTTP1?: boolean;
}

type RequestListener = (request: Http2ServerRequest, response: Http2ServerResponse) => void;

/**
 * HTTP/2 cleartext server (h2c) — TCP only, no TLS.
 * Use createSecureServer for production (TLS + ALPN required by browsers).
 */
export class Http2Server extends EventEmitter {
    protected _tcpServer: CModuleStreams.TCP | null = null;
    protected _options: ServerOptions;
    protected _sessions: Set<ServerHttp2Session> = new Set();
    listening: boolean = false;

    constructor(options?: ServerOptions, onRequest?: RequestListener) {
        super();
        this._options = options ?? {};
        if (onRequest) this.on('request', onRequest);
    }

    listen(port?: number, hostname?: string, backlog?: number, callback?: () => void): this;
    listen(port?: number, callback?: () => void): this;
    listen(...args: any[]): this {
        let port = 0;
        let hostname = '0.0.0.0';
        let callback: (() => void) | undefined;
        for (const arg of args) {
            if (typeof arg === 'number') port = arg;
            else if (typeof arg === 'string') hostname = arg;
            else if (typeof arg === 'function') callback = arg;
        }

        const tcp = new streams.TCP();
        tcp.bind({ ip: hostname, port });
        tcp.listen(128);
        this._tcpServer = tcp;
        this.listening = true;

        tcp.onconnection = (err: any, client: any) => {
            if (err) { this.emit('error', err); return; }
            this._handleClient(client as CModuleStreams.TCP);
        };

        queueMicrotask(() => {
            this.emit('listening');
            callback?.();
        });
        return this;
    }

    protected _handleClient(tcp: CModuleStreams.TCP): void {
        // Wrap TCP in a NetSocket so Http2Session can listen on Duplex events
        const sock = new NetSocket();
        (sock as any)._tcp = tcp;
        (sock as any)._readable = true;
        (sock as any)._writable = true;

        const session = new ServerHttp2Session(sock, this._options);
        this._sessions.add(session);

        session.on('close', () => this._sessions.delete(session));
        session.on('error', (err: Error) => this.emit('sessionError', err, session));
        session.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
            const req = new Http2ServerRequest(stream, headers);
            const res = new Http2ServerResponse(stream);
            this.emit('request', req, res);
        });

        this.emit('session', session);
    }

    close(callback?: (err?: Error) => void): this {
        if (!this.listening) { callback?.(); return this; }
        this.listening = false;
        try { this._tcpServer?.close(); } catch {}
        this._tcpServer = null;
        for (const s of this._sessions) s.close();
        this._sessions.clear();
        queueMicrotask(() => {
            this.emit('close');
            callback?.();
        });
        return this;
    }

    setTimeout(msecs: number, callback?: () => void): this {
        if (callback) this.once('timeout', callback);
        if (msecs > 0) setTimeout(() => this.emit('timeout'), msecs);
        return this;
    }

    address(): { address: string; family: string; port: number } | null {
        if (!this._tcpServer) return null;
        const info = this._tcpServer.sockname;
        return {
            address: info.ip,
            family: info.family === 6 ? 'IPv6' : 'IPv4',
            port: info.port,
        };
    }
}

/**
 * HTTP/2 secure server (TLS + ALPN h2).
 */
export class Http2SecureServer extends Http2Server {
    private _secureContext: SecureContext;
    declare _options: SecureServerOptions;

    constructor(options: SecureServerOptions, onRequest?: RequestListener) {
        super(options, onRequest);
        this._secureContext = new SecureContext(options);
    }

    protected _handleClient(tcp: CModuleStreams.TCP): void {
        const tlsSocket = new TLSSocket(tcp, {
            isServer: true,
            secureContext: this._secureContext,
            ALPNProtocols: this._options.allowHTTP1 ? ['h2', 'http/1.1'] : ['h2'],
            requestCert: false,
        });

        tlsSocket.once('secureConnect', () => {
            const proto = tlsSocket.alpnProtocol;
            if (proto && proto !== 'h2') {
                // ALPN selected http/1.1 — fall through (caller should hand off)
                this.emit('unknownProtocol', tlsSocket);
                return;
            }

            const session = new ServerHttp2Session(tlsSocket, this._options);
            this._sessions.add(session);

            session.on('close', () => this._sessions.delete(session));
            session.on('error', (err: Error) => this.emit('sessionError', err, session));
            session.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
                const req = new Http2ServerRequest(stream, headers);
                const res = new Http2ServerResponse(stream);
                this.emit('request', req, res);
            });

            this.emit('session', session);
        });

        tlsSocket.once('error', (err: Error) => this.emit('clientError', err, tlsSocket));
    }
}

// ============================================================================
// Compatibility API — Http2ServerRequest / Http2ServerResponse (Node.js shape)
// ============================================================================

export class Http2ServerRequest extends Duplex {
    readonly stream: ServerHttp2Stream;
    readonly headers: IncomingHttpHeaders;
    readonly httpVersion: string = '2.0';
    readonly httpVersionMajor: number = 2;
    readonly httpVersionMinor: number = 0;
    readonly method: string;
    readonly url: string;
    readonly scheme: string;
    readonly authority: string;
    readonly rawHeaders: string[];
    aborted: boolean = false;
    complete: boolean = false;

    constructor(stream: ServerHttp2Stream, headers: IncomingHttpHeaders) {
        super({ allowHalfOpen: true });
        this.stream = stream;
        this.headers = headers;
        this.method = String(headers[':method'] ?? 'GET');
        this.url = String(headers[':path'] ?? '/');
        this.scheme = String(headers[':scheme'] ?? 'https');
        this.authority = String(headers[':authority'] ?? '');

        this.rawHeaders = [];
        for (const [k, v] of Object.entries(headers)) {
            if (Array.isArray(v)) for (const x of v) this.rawHeaders.push(k, x);
            else if (v !== undefined) this.rawHeaders.push(k, String(v));
        }

        // Pipe stream body into this Readable
        stream.on('data', (chunk: any) => this.push(chunk));
        stream.on('end', () => { this.complete = true; this.push(null); });
        stream.on('aborted', () => { this.aborted = true; this.emit('aborted'); });
        stream.on('close', () => this.emit('close'));
        stream.on('error', (err: Error) => this.emit('error', err));
    }

    _read(_size: number): void {}
    _write(chunk: any, _enc: string, cb: (err?: Error) => void): void {
        this.stream.write(chunk, _enc as any, cb as any);
    }
    _final(cb: (err?: Error) => void): void { this.stream.end(); cb(); }

    setTimeout(msecs: number, cb?: () => void): this {
        this.stream.setTimeout(msecs, cb);
        return this;
    }
}

export class Http2ServerResponse extends Duplex {
    readonly stream: ServerHttp2Stream;
    readonly req: Http2ServerRequest | null = null;
    statusCode: number = 200;
    statusMessage: string = '';
    sendDate: boolean = true;
    headersSent: boolean = false;
    finished: boolean = false;
    private _headers: OutgoingHttpHeaders = {};
    private _trailers: OutgoingHttpHeaders = {};

    constructor(stream: ServerHttp2Stream) {
        super({ allowHalfOpen: true });
        this.stream = stream;

        stream.on('close', () => this.emit('close'));
        stream.on('error', (err: Error) => this.emit('error', err));
    }

    setHeader(name: string, value: string | number | string[]): this {
        if (this.headersSent) throw new Error('Headers already sent');
        this._headers[name.toLowerCase()] = value;
        return this;
    }

    getHeader(name: string): string | number | string[] | undefined {
        return this._headers[name.toLowerCase()] as any;
    }

    getHeaderNames(): string[] { return Object.keys(this._headers); }
    getHeaders(): OutgoingHttpHeaders { return { ...this._headers }; }
    hasHeader(name: string): boolean { return name.toLowerCase() in this._headers; }
    removeHeader(name: string): void {
        if (this.headersSent) throw new Error('Headers already sent');
        delete this._headers[name.toLowerCase()];
    }

    writeHead(statusCode: number, statusMessageOrHeaders?: string | OutgoingHttpHeaders, headers?: OutgoingHttpHeaders): this {
        if (this.headersSent) throw new Error('Headers already sent');
        this.statusCode = statusCode;
        if (typeof statusMessageOrHeaders === 'string') {
            this.statusMessage = statusMessageOrHeaders;
        } else if (statusMessageOrHeaders) {
            headers = statusMessageOrHeaders;
        }
        if (headers) {
            for (const [k, v] of Object.entries(headers)) {
                if (v !== undefined) this._headers[k.toLowerCase()] = v;
            }
        }
        this._flushHeaders(false);
        return this;
    }

    private _flushHeaders(endStream: boolean): void {
        if (this.headersSent) return;
        const merged: OutgoingHttpHeaders = { ':status': this.statusCode };
        if (this.sendDate && !this._headers['date']) {
            merged.date = new Date().toUTCString();
        }
        Object.assign(merged, this._headers);
        this.stream.respond(merged, { endStream });
        this.headersSent = true;
    }

    write(chunk: any, encodingOrCb?: any, cb?: any): boolean {
        if (!this.headersSent) this._flushHeaders(false);
        return this.stream.write(chunk, encodingOrCb, cb);
    }

    end(chunk?: any, encodingOrCb?: any, cb?: any): this {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        else if (typeof encodingOrCb === 'function') { cb = encodingOrCb; encodingOrCb = undefined; }

        if (!this.headersSent && chunk === undefined) {
            this._flushHeaders(true);
            this.finished = true;
            cb?.();
            return this;
        }
        if (!this.headersSent) this._flushHeaders(false);
        if (chunk !== undefined) this.stream.write(chunk, encodingOrCb, () => {});
        this.stream.end();
        this.finished = true;
        cb?.();
        return this;
    }

    addTrailers(headers: OutgoingHttpHeaders): void {
        Object.assign(this._trailers, headers);
        this.stream.sendTrailers(this._trailers);
    }

    setTimeout(msecs: number, cb?: () => void): this {
        this.stream.setTimeout(msecs, cb);
        return this;
    }

    flushHeaders(): void {
        if (!this.headersSent) this._flushHeaders(false);
    }

    _read(_size: number): void {}
    _write(chunk: any, enc: string, cb: (err?: Error) => void): void {
        this.write(chunk, enc, cb);
    }
    _final(cb: (err?: Error) => void): void { this.end(undefined, undefined, cb); }

    writeContinue(): void {
        this.stream.additionalHeaders({ ':status': 100 });
    }
}

// ============================================================================
// Factory functions
// ============================================================================

export function createServer(onRequest?: RequestListener): Http2Server;
export function createServer(options: ServerOptions, onRequest?: RequestListener): Http2Server;
export function createServer(optionsOrListener?: ServerOptions | RequestListener, onRequest?: RequestListener): Http2Server {
    if (typeof optionsOrListener === 'function') {
        return new Http2Server(undefined, optionsOrListener);
    }
    return new Http2Server(optionsOrListener, onRequest);
}

export function createSecureServer(options: SecureServerOptions, onRequest?: RequestListener): Http2SecureServer {
    return new Http2SecureServer(options, onRequest);
}

// ============================================================================
// Default export
// ============================================================================

export default {
    constants,
    connect,
    createServer,
    createSecureServer,
    Http2Session,
    ClientHttp2Session,
    ServerHttp2Session,
    Http2Stream,
    ClientHttp2Stream,
    ServerHttp2Stream,
    Http2Server,
    Http2SecureServer,
    Http2ServerRequest,
    Http2ServerResponse,
};
