/** WebTransport-compatible streams backed by the native QUIC extension. */
import { requireQuic } from '../quic-native';
import { toOwnedBytes } from '../utils/bytes';
import { DOMException } from './events';

const WEBTRANSPORT_ALPN = 'webtransport';
const DEFAULT_MAX_DATAGRAM_SIZE = 1200;

type NativeChunk = Uint8Array<ArrayBufferLike> | ArrayBuffer;

function nativeChunkBytes(chunk: NativeChunk): Uint8Array<ArrayBuffer> {
    return chunk instanceof ArrayBuffer ? new Uint8Array(chunk.slice(0)) : toOwnedBytes(chunk);
}

function bufferSourceBytes(source: ArrayBuffer | ArrayBufferView<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
    if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
    return toOwnedBytes(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
}

function streamErrorCode(reason: unknown): number {
    if (typeof reason === 'number' && Number.isInteger(reason) && reason >= 0) return reason >>> 0;
    if (reason && typeof reason === 'object') {
        const value = Reflect.get(reason, 'streamErrorCode') ?? Reflect.get(reason, 'closeCode');
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value >>> 0;
    }
    return 0;
}

function normalizeCloseInfo(info: WebTransportCloseInfo = {}): Required<WebTransportCloseInfo> {
    const closeCode = info.closeCode ?? 0;
    const reason = info.reason ?? '';
    if (!Number.isInteger(closeCode) || closeCode < 0 || closeCode > 0xffffffff) {
        throw new RangeError('closeCode must be an unsigned 32-bit integer');
    }
    if (typeof reason !== 'string') throw new TypeError('reason must be a string');
    return { closeCode, reason };
}

export interface WebTransportCloseInfo {
    closeCode?: number;
    reason?: string;
}

export interface WebTransportHash {
    algorithm?: string;
    value?: BufferSource;
}

export interface WebTransportOptions {
    allowPooling?: boolean;
    congestionControl?: 'default' | 'low-latency' | 'throughput';
    requireUnreliable?: boolean;
    serverCertificateHashes?: WebTransportHash[];
}

export interface WebTransportSendStreamOptions {
    sendGroup?: WebTransportSendGroup;
    sendOrder?: number;
    waitUntilAvailable?: boolean;
}

export interface WebTransportErrorOptions {
    source?: 'stream' | 'session';
    streamErrorCode?: number | null;
}

export class WebTransportError extends DOMException {
    readonly source: 'stream' | 'session';
    readonly streamErrorCode: number | null;

    constructor(message = '', options: WebTransportErrorOptions = {}) {
        super(message, 'WebTransportError');
        Object.setPrototypeOf(this, new.target.prototype);
        this.source = options.source ?? 'session';
        this.streamErrorCode = options.streamErrorCode ?? null;
    }
}

export class WebTransportSendGroup {
    async getStats(): Promise<{ bytesWritten: number; bytesSent: number; bytesAcknowledged: number }> {
        return { bytesWritten: 0, bytesSent: 0, bytesAcknowledged: 0 };
    }
}

type SendStreamState = {
    closed: boolean;
    bytesWritten: number;
    controller?: WritableStreamDefaultController;
};

export class WebTransportSendStream extends WritableStream<Uint8Array<ArrayBufferLike>> {
    readonly id: number;
    sendOrder: number;
    sendGroup?: WebTransportSendGroup;
    #state: SendStreamState;

    constructor(
        conn: CModuleExternalQuic.Connection,
        streamId: number,
        options: WebTransportSendStreamOptions = {},
    ) {
        const state: SendStreamState = { closed: false, bytesWritten: 0 };
        super({
            start(controller) {
                state.controller = controller;
            },
            write(chunk) {
                if (!(chunk instanceof Uint8Array)) throw new TypeError('WebTransport streams accept Uint8Array chunks');
                if (state.closed) throw new TypeError('Stream is closed');
                conn.sendStream(streamId, chunk, false);
                state.bytesWritten += chunk.byteLength;
            },
            close() {
                if (state.closed) return;
                state.closed = true;
                conn.sendStream(streamId, new Uint8Array(0), true);
            },
            abort(reason) {
                if (state.closed) return;
                state.closed = true;
                conn.resetStream(streamId, streamErrorCode(reason));
            },
        });
        this.id = streamId;
        this.sendOrder = options.sendOrder ?? 0;
        this.sendGroup = options.sendGroup;
        this.#state = state;
    }

    _stop(errorCode: number): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#state.controller?.error(new WebTransportError('Peer stopped the stream', {
            source: 'stream',
            streamErrorCode: errorCode,
        }));
    }

    _connectionClosed(reason: string): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#state.controller?.error(new WebTransportError(reason || 'WebTransport session closed'));
    }

    async getStats(): Promise<{ bytesWritten: number; bytesSent: number; bytesAcknowledged: number }> {
        return {
            bytesWritten: this.#state.bytesWritten,
            bytesSent: this.#state.bytesWritten,
            bytesAcknowledged: 0,
        };
    }
}

type ReceiveStreamState = {
    closed: boolean;
    bytesReceived: number;
    controller?: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
};

export class WebTransportReceiveStream extends ReadableStream<Uint8Array<ArrayBuffer>> {
    readonly id: number;
    #state: ReceiveStreamState;

    constructor(conn?: CModuleExternalQuic.Connection, streamId = -1) {
        const state: ReceiveStreamState = { closed: false, bytesReceived: 0 };
        super({
            start(controller) {
                state.controller = controller;
            },
            cancel(reason) {
                if (state.closed) return;
                state.closed = true;
                if (conn && streamId >= 0) conn.stopSending(streamId, streamErrorCode(reason));
            },
        });
        this.id = streamId;
        this.#state = state;
    }

    _push(chunk: NativeChunk): void {
        if (this.#state.closed) return;
        const owned = nativeChunkBytes(chunk);
        this.#state.bytesReceived += owned.byteLength;
        if (owned.byteLength !== 0) this.#state.controller?.enqueue(owned);
    }

    _close(): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#state.controller?.close();
    }

    _reset(errorCode: number): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#state.controller?.error(new WebTransportError('Peer reset the stream', {
            source: 'stream',
            streamErrorCode: errorCode,
        }));
    }

    _connectionClosed(reason: string): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#state.controller?.error(new WebTransportError(reason || 'WebTransport session closed'));
    }

    async getStats(): Promise<{ bytesReceived: number; bytesRead: number }> {
        return { bytesReceived: this.#state.bytesReceived, bytesRead: this.#state.bytesReceived };
    }
}

export class WebTransportBidirectionalStream {
    readonly readable: WebTransportReceiveStream;
    readonly writable: WebTransportSendStream;

    constructor(readable: WebTransportReceiveStream, writable: WebTransportSendStream) {
        this.readable = readable;
        this.writable = writable;
    }
}

export class WebTransportDatagramDuplexStream {
    incomingHighWaterMark = 1;
    incomingMaxAge: number | null = null;
    outgoingHighWaterMark = 1;
    outgoingMaxAge: number | null = null;
    readonly maxDatagramSize: number;
    readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: WritableStream<Uint8Array<ArrayBufferLike>>;
    #closed = false;
    #readController?: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    #writeController?: WritableStreamDefaultController;

    constructor(conn: CModuleExternalQuic.Connection, maxDatagramSize = DEFAULT_MAX_DATAGRAM_SIZE) {
        this.maxDatagramSize = maxDatagramSize;
        this.readable = new ReadableStream({
            start: (controller) => this.#readController = controller,
        }, { highWaterMark: this.incomingHighWaterMark });
        this.writable = new WritableStream({
            start: (controller) => this.#writeController = controller,
            write: (chunk) => {
                if (this.#closed) throw new TypeError('WebTransport session is closed');
                if (!(chunk instanceof Uint8Array)) throw new TypeError('Datagrams must be Uint8Array values');
                const owned = bufferSourceBytes(chunk);
                if (owned.byteLength > this.maxDatagramSize) {
                    throw new RangeError(`Datagram exceeds maxDatagramSize (${this.maxDatagramSize})`);
                }
                conn.sendDatagram(owned);
            },
        }, { highWaterMark: this.outgoingHighWaterMark });
        conn.ondatagram = (chunk: NativeChunk) => {
            if (this.#closed || this.incomingMaxAge === 0) return;
            if ((this.#readController?.desiredSize ?? 0) <= 0) return;
            this.#readController?.enqueue(nativeChunkBytes(chunk));
        };
    }

    _close(reason = ''): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#readController?.close();
        this.#writeController?.error(new WebTransportError(reason || 'WebTransport session closed'));
    }
}

class IncomingStreamController {
    readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;
    readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
    #conn: CModuleExternalQuic.Connection;
    #receivers = new Map<number, WebTransportReceiveStream>();
    #senders = new Map<number, WebTransportSendStream>();
    #uniController?: ReadableStreamDefaultController<WebTransportReceiveStream>;
    #bidiController?: ReadableStreamDefaultController<WebTransportBidirectionalStream>;
    #uniOpen = true;
    #bidiOpen = true;

    constructor(conn: CModuleExternalQuic.Connection) {
        this.#conn = conn;
        this.incomingUnidirectionalStreams = new ReadableStream<WebTransportReceiveStream>({
            start: (controller) => this.#uniController = controller,
            cancel: () => { this.#uniOpen = false; },
        });
        this.incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
            start: (controller) => this.#bidiController = controller,
            cancel: () => { this.#bidiOpen = false; },
        });

        conn.onstream = (streamId: number, bidirectional: boolean) => {
            if (this.#receivers.has(streamId)) return;
            const receive = new WebTransportReceiveStream(conn, streamId);
            this.#receivers.set(streamId, receive);
            if (bidirectional) {
                const send = new WebTransportSendStream(conn, streamId);
                this.#senders.set(streamId, send);
                if (this.#bidiOpen) {
                    this.#bidiController?.enqueue(new WebTransportBidirectionalStream(receive, send));
                } else {
                    conn.stopSending(streamId, 0);
                    conn.resetStream(streamId, 0);
                }
            } else if (this.#uniOpen) {
                this.#uniController?.enqueue(receive);
            } else {
                conn.stopSending(streamId, 0);
            }
        };
        conn.ondata = (streamId: number, chunk: NativeChunk, fin: boolean) => {
            let receive = this.#receivers.get(streamId);
            if (!receive) {
                receive = new WebTransportReceiveStream(conn, streamId);
                this.#receivers.set(streamId, receive);
                if ((streamId & 2) === 0) {
                    const send = new WebTransportSendStream(conn, streamId);
                    this.#senders.set(streamId, send);
                    if (this.#bidiOpen) {
                        this.#bidiController?.enqueue(new WebTransportBidirectionalStream(receive, send));
                    }
                } else if (this.#uniOpen) {
                    this.#uniController?.enqueue(receive);
                }
            }
            receive._push(chunk);
            if (fin) {
                receive._close();
                this.#receivers.delete(streamId);
            }
        };
        conn.onstreamreset = (streamId: number, errorCode: number) => {
            this.#receivers.get(streamId)?._reset(errorCode);
            this.#receivers.delete(streamId);
        };
        conn.onstreamstop = (streamId: number, errorCode: number) => {
            this.#senders.get(streamId)?._stop(errorCode);
            this.#senders.delete(streamId);
        };
    }

    registerBidirectional(
        streamId: number,
        receive: WebTransportReceiveStream,
        send: WebTransportSendStream,
    ): void {
        this.#receivers.set(streamId, receive);
        this.#senders.set(streamId, send);
    }

    registerSend(streamId: number, send: WebTransportSendStream): void {
        this.#senders.set(streamId, send);
    }

    close(reason = ''): void {
        for (const receive of this.#receivers.values()) receive._connectionClosed(reason);
        for (const send of this.#senders.values()) send._connectionClosed(reason);
        this.#receivers.clear();
        this.#senders.clear();
        if (this.#uniOpen) this.#uniController?.close();
        if (this.#bidiOpen) this.#bidiController?.close();
        this.#uniOpen = false;
        this.#bidiOpen = false;
    }
}

type SessionState = 'connecting' | 'connected' | 'draining' | 'closed';

export class WebTransport {
    readonly ready: Promise<void>;
    readonly closed: Promise<WebTransportCloseInfo>;
    readonly draining: Promise<void>;
    readonly datagrams: WebTransportDatagramDuplexStream;
    readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;
    readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
    #socket: CModuleExternalQuic.Socket;
    #connection: CModuleExternalQuic.Connection;
    #streams: IncomingStreamController;
    #readyResult = Promise.withResolvers<void>();
    #closedResult = Promise.withResolvers<WebTransportCloseInfo>();
    #drainingResult = Promise.withResolvers<void>();
    #state: SessionState = 'connecting';

    constructor(url: string | URL, options: WebTransportOptions = {}) {
        const target = url instanceof URL ? new URL(url.href) : new URL(url);
        if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
            throw new DOMException('WebTransport requires an HTTPS URL without credentials or a fragment', 'SyntaxError');
        }
        if (options.serverCertificateHashes?.length) {
            throw new DOMException('serverCertificateHashes are not supported by this QUIC backend', 'NotSupportedError');
        }

        this.ready = this.#readyResult.promise;
        this.closed = this.#closedResult.promise;
        this.draining = this.#drainingResult.promise;
        const nativeQuic = requireQuic();
        this.#socket = new nativeQuic.Socket({
            host: '0.0.0.0',
            port: 0,
            isServer: false,
            alpn: WEBTRANSPORT_ALPN,
            verifyPeer: true,
        });
        this.#connection = this.#socket.connect(target.hostname, Number(target.port) || 443, target.hostname);
        this.#streams = new IncomingStreamController(this.#connection);
        this.datagrams = new WebTransportDatagramDuplexStream(this.#connection);
        this.incomingUnidirectionalStreams = this.#streams.incomingUnidirectionalStreams;
        this.incomingBidirectionalStreams = this.#streams.incomingBidirectionalStreams;

        this.#socket.onerror = (message: string) => this.#fail(message);
        this.#connection.onerror = (message: string) => this.#fail(message);
        this.#connection.onconnected = () => {
            if (this.#state !== 'connecting') return;
            this.#state = 'connected';
            this.#readyResult.resolve();
        };
        this.#connection.onclose = (closeCode: number, reason: string) => {
            const connecting = this.#state === 'connecting';
            this.#state = 'closed';
            this.#streams.close(reason);
            this.datagrams._close(reason);
            if (connecting) this.#readyResult.reject(new WebTransportError(reason || 'Connection closed during handshake'));
            this.#drainingResult.resolve();
            this.#closedResult.resolve({ closeCode, reason });
            this.#socket.close();
        };
    }

    async createUnidirectionalStream(
        options: WebTransportSendStreamOptions = {},
    ): Promise<WebTransportSendStream> {
        await this.ready;
        if (this.#state !== 'connected') throw new WebTransportError('WebTransport session is closed');
        const streamId = this.#connection.openStream(false);
        const send = new WebTransportSendStream(this.#connection, streamId, options);
        this.#streams.registerSend(streamId, send);
        return send;
    }

    async createBidirectionalStream(
        options: WebTransportSendStreamOptions = {},
    ): Promise<WebTransportBidirectionalStream> {
        await this.ready;
        if (this.#state !== 'connected') throw new WebTransportError('WebTransport session is closed');
        const streamId = this.#connection.openStream(true);
        const receive = new WebTransportReceiveStream(this.#connection, streamId);
        const send = new WebTransportSendStream(this.#connection, streamId, options);
        this.#streams.registerBidirectional(streamId, receive, send);
        return new WebTransportBidirectionalStream(receive, send);
    }

    createSendGroup(): WebTransportSendGroup {
        return new WebTransportSendGroup();
    }

    close(closeInfo: WebTransportCloseInfo = {}): void {
        if (this.#state === 'closed' || this.#state === 'draining') return;
        const { closeCode, reason } = normalizeCloseInfo(closeInfo);
        this.#state = 'draining';
        this.#drainingResult.resolve();
        this.#connection.close(closeCode, reason);
    }

    async getStats(): Promise<{
        timestamp: number;
        bytesSent: number;
        bytesReceived: number;
        rttVariance: number;
        rttMin: number;
        rttSmoothed: number;
        datagramsSent: number;
        datagramsReceived: number;
        datagramsLost: number;
    }> {
        const stats = this.#connection.getStats();
        return {
            timestamp: Date.now(),
            bytesSent: stats.bytesSent,
            bytesReceived: stats.bytesReceived,
            rttVariance: 0,
            rttMin: stats.rttMin,
            rttSmoothed: stats.rttSmoothed,
            datagramsSent: 0,
            datagramsReceived: 0,
            datagramsLost: 0,
        };
    }

    #fail(message: string): void {
        if (this.#state === 'closed') return;
        const error = new WebTransportError(message || 'WebTransport connection failed');
        const connecting = this.#state === 'connecting';
        this.#state = 'closed';
        this.#streams.close(error.message);
        this.datagrams._close(error.message);
        if (connecting) this.#readyResult.reject(error);
        this.#drainingResult.resolve();
        this.#closedResult.reject(error);
        this.#socket.close();
    }
}

export class WebTransportSession {
    readonly ready: Promise<void>;
    readonly closed: Promise<WebTransportCloseInfo>;
    readonly datagrams: WebTransportDatagramDuplexStream;
    readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;
    readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
    #conn: CModuleExternalQuic.Connection;
    #streams: IncomingStreamController;
    #readyResult = Promise.withResolvers<void>();
    #closedResult = Promise.withResolvers<WebTransportCloseInfo>();
    #state: SessionState = 'connecting';

    constructor(conn: CModuleExternalQuic.Connection) {
        this.#conn = conn;
        this.ready = this.#readyResult.promise;
        this.closed = this.#closedResult.promise;
        this.#streams = new IncomingStreamController(conn);
        this.datagrams = new WebTransportDatagramDuplexStream(conn);
        this.incomingUnidirectionalStreams = this.#streams.incomingUnidirectionalStreams;
        this.incomingBidirectionalStreams = this.#streams.incomingBidirectionalStreams;
        conn.onconnected = () => {
            if (this.#state !== 'connecting') return;
            this.#state = 'connected';
            this.#readyResult.resolve();
        };
        conn.onerror = (message: string) => this._terminate({ closeCode: 0, reason: message }, true);
        conn.onclose = (closeCode: number, reason: string) => this._terminate({ closeCode, reason });
    }

    async createUnidirectionalStream(
        options: WebTransportSendStreamOptions = {},
    ): Promise<WebTransportSendStream> {
        await this.ready;
        if (this.#state !== 'connected') throw new WebTransportError('WebTransport session is closed');
        const streamId = this.#conn.openStream(false);
        const send = new WebTransportSendStream(this.#conn, streamId, options);
        this.#streams.registerSend(streamId, send);
        return send;
    }

    async createBidirectionalStream(
        options: WebTransportSendStreamOptions = {},
    ): Promise<WebTransportBidirectionalStream> {
        await this.ready;
        if (this.#state !== 'connected') throw new WebTransportError('WebTransport session is closed');
        const streamId = this.#conn.openStream(true);
        const receive = new WebTransportReceiveStream(this.#conn, streamId);
        const send = new WebTransportSendStream(this.#conn, streamId, options);
        this.#streams.registerBidirectional(streamId, receive, send);
        return new WebTransportBidirectionalStream(receive, send);
    }

    createSendGroup(): WebTransportSendGroup {
        return new WebTransportSendGroup();
    }

    close(closeInfo: WebTransportCloseInfo = {}): void {
        if (this.#state === 'closed' || this.#state === 'draining') return;
        const { closeCode, reason } = normalizeCloseInfo(closeInfo);
        this.#state = 'draining';
        this.#conn.close(closeCode, reason);
    }

    _terminate(info: Required<WebTransportCloseInfo>, failed = false): void {
        if (this.#state === 'closed') return;
        const connecting = this.#state === 'connecting';
        this.#state = 'closed';
        this.#streams.close(info.reason);
        this.datagrams._close(info.reason);
        if (connecting) this.#readyResult.reject(new WebTransportError(info.reason || 'Connection closed during handshake'));
        if (failed) this.#closedResult.reject(new WebTransportError(info.reason || 'WebTransport connection failed'));
        else this.#closedResult.resolve(info);
    }
}

export class WebTransportServer {
    #socket: CModuleExternalQuic.Socket;
    #onSession: ((session: WebTransportSession) => void) | null = null;
    #sessions = new Set<WebTransportSession>();
    #pending: WebTransportSession[] = [];

    constructor(options: { host?: string; port?: number; cert: string; key: string; alpn?: string }) {
        const nativeQuic = requireQuic();
        this.#socket = new nativeQuic.Socket({
            host: options.host ?? '0.0.0.0',
            port: options.port ?? 4433,
            isServer: true,
            cert: options.cert,
            key: options.key,
            alpn: options.alpn ?? WEBTRANSPORT_ALPN,
        });
        this.#socket.onconnection = (conn: CModuleExternalQuic.Connection) => {
            const session = new WebTransportSession(conn);
            this.#sessions.add(session);
            session.closed.finally(() => this.#sessions.delete(session));
            if (this.#onSession) this.#onSession(session);
            else this.#pending.push(session);
        };
    }

    onsession(handler: (session: WebTransportSession) => void): void {
        this.#onSession = handler;
        for (const session of this.#pending.splice(0)) handler(session);
    }

    close(): void {
        this.#socket.onerror = null;
        this.#socket.onconnection = null;
        for (const session of this.#sessions) {
            session._terminate({ closeCode: 0, reason: 'WebTransport server closed' });
        }
        this.#sessions.clear();
        this.#pending.length = 0;
        this.#socket.close();
    }
}

Object.assign(globalThis, {
    WebTransport,
    WebTransportBidirectionalStream,
    WebTransportDatagramDuplexStream,
    WebTransportError,
    WebTransportReceiveStream,
    WebTransportSendGroup,
    WebTransportSendStream,
});
