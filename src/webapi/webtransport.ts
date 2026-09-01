/** WebTransport-compatible streams backed by the native QUIC extension. */
import { requireQuic } from '../quic-native';
import { toOwnedBytes } from '../utils/bytes';
import { systemCaCerts } from '../utils/ca-certs';
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
    onClosed?: () => void;
};

function finishSendState(state: SendStreamState): boolean {
    if (state.closed) return false;
    state.closed = true;
    const onClosed = state.onClosed;
    state.onClosed = undefined;
    onClosed?.();
    return true;
}

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
                if (!finishSendState(state)) return;
                conn.sendStream(streamId, new Uint8Array(0), true);
            },
            abort(reason) {
                if (!finishSendState(state)) return;
                conn.resetStream(streamId, streamErrorCode(reason));
            },
        });
        this.id = streamId;
        this.sendOrder = options.sendOrder ?? 0;
        this.sendGroup = options.sendGroup;
        this.#state = state;
    }

    _stop(errorCode: number): void {
        if (!finishSendState(this.#state)) return;
        this.#state.controller?.error(new WebTransportError('Peer stopped the stream', {
            source: 'stream',
            streamErrorCode: errorCode,
        }));
    }

    _connectionClosed(reason: string): void {
        if (!finishSendState(this.#state)) return;
        this.#state.controller?.error(new WebTransportError(reason || 'WebTransport session closed'));
    }

    /** Internal hook used by the owning session to release its stream map. */
    _setCloseCallback(callback: () => void): void {
        if (this.#state.closed) callback();
        else this.#state.onClosed = callback;
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
    onClosed?: () => void;
};

function finishReceiveState(state: ReceiveStreamState): boolean {
    if (state.closed) return false;
    state.closed = true;
    const onClosed = state.onClosed;
    state.onClosed = undefined;
    onClosed?.();
    return true;
}

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
                if (!finishReceiveState(state)) return;
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
        if (!finishReceiveState(this.#state)) return;
        this.#state.controller?.close();
    }

    _reset(errorCode: number): void {
        if (!finishReceiveState(this.#state)) return;
        this.#state.controller?.error(new WebTransportError('Peer reset the stream', {
            source: 'stream',
            streamErrorCode: errorCode,
        }));
    }

    _connectionClosed(reason: string): void {
        if (!finishReceiveState(this.#state)) return;
        this.#state.controller?.error(new WebTransportError(reason || 'WebTransport session closed'));
    }

    /** Internal hook used by the owning session to release its stream map. */
    _setCloseCallback(callback: () => void): void {
        if (this.#state.closed) callback();
        else this.#state.onClosed = callback;
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
    #conn: CModuleExternalQuic.Connection;
    #closed = false;
    #readableClosed = false;
    #readController?: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    #writeController?: WritableStreamDefaultController;
    #onDatagram: CModuleExternalQuic.Callback<[NativeChunk]> | null = null;

    constructor(conn: CModuleExternalQuic.Connection, maxDatagramSize = DEFAULT_MAX_DATAGRAM_SIZE) {
        this.#conn = conn;
        this.maxDatagramSize = maxDatagramSize;
        this.readable = new ReadableStream({
            start: (controller) => this.#readController = controller,
            cancel: () => {
                this.#readableClosed = true;
                this.#detachDatagramCallback();
                this.#readController = undefined;
            },
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
        this.#onDatagram = (chunk: NativeChunk) => {
            if (this.#closed || this.#readableClosed || this.incomingMaxAge === 0) return;
            if ((this.#readController?.desiredSize ?? 0) <= 0) return;
            this.#readController?.enqueue(nativeChunkBytes(chunk));
        };
        conn.ondatagram = this.#onDatagram;
    }

    _close(reason = ''): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#readableClosed = true;
        this.#detachDatagramCallback();
        this.#readController?.close();
        this.#writeController?.error(new WebTransportError(reason || 'WebTransport session closed'));
        this.#readController = undefined;
        this.#writeController = undefined;
    }

    #detachDatagramCallback(): void {
        try {
            if (this.#conn.ondatagram === this.#onDatagram) this.#conn.ondatagram = null;
        } catch { /* native connection may already be disposed */ }
        this.#onDatagram = null;
    }
}

type IncomingStreamKind = 'unidirectional' | 'bidirectional';

class IncomingStreamController {
    readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;
    readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
    #conn: CModuleExternalQuic.Connection;
    #receivers = new Map<number, WebTransportReceiveStream>();
    #senders = new Map<number, WebTransportSendStream>();
    #incomingUnidirectional = new Set<number>();
    #incomingBidirectional = new Set<number>();
    #uniController?: ReadableStreamDefaultController<WebTransportReceiveStream>;
    #bidiController?: ReadableStreamDefaultController<WebTransportBidirectionalStream>;
    #uniOpen = true;
    #bidiOpen = true;
    #closed = false;
    #onstream: CModuleExternalQuic.Callback<[number, boolean]> | null = null;
    #ondata: CModuleExternalQuic.Callback<[number, NativeChunk, boolean]> | null = null;
    #onstreamreset: CModuleExternalQuic.Callback<[number, number]> | null = null;
    #onstreamstop: CModuleExternalQuic.Callback<[number, number]> | null = null;

    constructor(conn: CModuleExternalQuic.Connection) {
        this.#conn = conn;
        this.incomingUnidirectionalStreams = new ReadableStream<WebTransportReceiveStream>({
            start: (controller) => this.#uniController = controller,
            cancel: () => this.#cancelIncomingStreams('unidirectional'),
        });
        this.incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
            start: (controller) => this.#bidiController = controller,
            cancel: () => this.#cancelIncomingStreams('bidirectional'),
        });

        this.#onstream = (streamId: number, bidirectional: boolean) => {
            if (this.#closed) return;
            if (this.#receivers.has(streamId)) return;
            const receive = new WebTransportReceiveStream(conn, streamId);
            const kind: IncomingStreamKind = bidirectional ? 'bidirectional' : 'unidirectional';
            this.#trackReceive(streamId, receive, kind);
            if (bidirectional) {
                const send = new WebTransportSendStream(conn, streamId);
                this.#trackSend(streamId, send, true);
                if (this.#bidiOpen) {
                    try {
                        this.#bidiController?.enqueue(new WebTransportBidirectionalStream(receive, send));
                    } catch (error) {
                        this.#terminateIncomingStream(streamId, kind, 'Incoming stream queue was closed');
                        throw error;
                    }
                } else {
                    this.#terminateIncomingStream(streamId, kind, 'Incoming stream source was canceled');
                }
            } else if (this.#uniOpen) {
                try {
                    this.#uniController?.enqueue(receive);
                } catch (error) {
                    this.#terminateIncomingStream(streamId, kind, 'Incoming stream queue was closed');
                    throw error;
                }
            } else {
                this.#terminateIncomingStream(streamId, kind, 'Incoming stream source was canceled');
            }
        };
        this.#ondata = (streamId: number, chunk: NativeChunk, fin: boolean) => {
            if (this.#closed) return;
            let receive = this.#receivers.get(streamId);
            if (!receive) {
                receive = new WebTransportReceiveStream(conn, streamId);
                const bidirectional = (streamId & 2) === 0;
                const kind: IncomingStreamKind = bidirectional ? 'bidirectional' : 'unidirectional';
                this.#trackReceive(streamId, receive, kind);
                if (bidirectional) {
                    const send = new WebTransportSendStream(conn, streamId);
                    this.#trackSend(streamId, send, true);
                    if (this.#bidiOpen) {
                        try {
                            this.#bidiController?.enqueue(new WebTransportBidirectionalStream(receive, send));
                        } catch (error) {
                            this.#terminateIncomingStream(streamId, kind, 'Incoming stream queue was closed');
                            throw error;
                        }
                    } else {
                        this.#terminateIncomingStream(streamId, kind, 'Incoming stream source was canceled');
                        return;
                    }
                } else if (this.#uniOpen) {
                    try {
                        this.#uniController?.enqueue(receive);
                    } catch (error) {
                        this.#terminateIncomingStream(streamId, kind, 'Incoming stream queue was closed');
                        throw error;
                    }
                } else {
                    this.#terminateIncomingStream(streamId, kind, 'Incoming stream source was canceled');
                    return;
                }
            }
            receive._push(chunk);
            if (fin) {
                receive._close();
                this.#receivers.delete(streamId);
            }
        };
        this.#onstreamreset = (streamId: number, errorCode: number) => {
            if (this.#closed) return;
            this.#receivers.get(streamId)?._reset(errorCode);
            this.#receivers.delete(streamId);
            this.#forgetIncomingStream(streamId);
        };
        this.#onstreamstop = (streamId: number, errorCode: number) => {
            if (this.#closed) return;
            this.#senders.get(streamId)?._stop(errorCode);
            this.#senders.delete(streamId);
            this.#forgetIncomingStream(streamId);
        };
        conn.onstream = this.#onstream;
        conn.ondata = this.#ondata;
        conn.onstreamreset = this.#onstreamreset;
        conn.onstreamstop = this.#onstreamstop;
    }

    registerBidirectional(
        streamId: number,
        receive: WebTransportReceiveStream,
        send: WebTransportSendStream,
    ): void {
        if (this.#closed) {
            receive._connectionClosed('WebTransport session is closed');
            send._connectionClosed('WebTransport session is closed');
            return;
        }
        this.#trackReceive(streamId, receive);
        this.#trackSend(streamId, send);
    }

    registerSend(streamId: number, send: WebTransportSendStream): void {
        if (this.#closed) {
            send._connectionClosed('WebTransport session is closed');
            return;
        }
        this.#trackSend(streamId, send);
    }

    close(reason = ''): void {
        if (this.#closed) return;
        this.#closed = true;
        try { this.#conn.onstream = null; } catch { /* native connection may already be disposed */ }
        try { this.#conn.ondata = null; } catch { /* native connection may already be disposed */ }
        try { this.#conn.onstreamreset = null; } catch { /* native connection may already be disposed */ }
        try { this.#conn.onstreamstop = null; } catch { /* native connection may already be disposed */ }
        this.#onstream = null;
        this.#ondata = null;
        this.#onstreamreset = null;
        this.#onstreamstop = null;
        for (const receive of Array.from(this.#receivers.values())) receive._connectionClosed(reason);
        for (const send of Array.from(this.#senders.values())) send._connectionClosed(reason);
        this.#receivers.clear();
        this.#senders.clear();
        this.#incomingUnidirectional.clear();
        this.#incomingBidirectional.clear();
        if (this.#uniOpen) this.#uniController?.close();
        if (this.#bidiOpen) this.#bidiController?.close();
        this.#uniOpen = false;
        this.#bidiOpen = false;
        this.#uniController = undefined;
        this.#bidiController = undefined;
    }

    #trackReceive(
        streamId: number,
        receive: WebTransportReceiveStream,
        kind?: IncomingStreamKind,
    ): void {
        this.#receivers.set(streamId, receive);
        if (kind === 'unidirectional') this.#incomingUnidirectional.add(streamId);
        if (kind === 'bidirectional') this.#incomingBidirectional.add(streamId);
        receive._setCloseCallback(() => {
            if (this.#receivers.get(streamId) === receive) this.#receivers.delete(streamId);
            this.#forgetIncomingStream(streamId);
        });
    }

    #trackSend(streamId: number, send: WebTransportSendStream, incoming = false): void {
        this.#senders.set(streamId, send);
        if (incoming) this.#incomingBidirectional.add(streamId);
        send._setCloseCallback(() => {
            if (this.#senders.get(streamId) === send) this.#senders.delete(streamId);
            this.#forgetIncomingStream(streamId);
        });
    }

    #forgetIncomingStream(streamId: number): void {
        if (this.#receivers.has(streamId) || this.#senders.has(streamId)) return;
        this.#incomingUnidirectional.delete(streamId);
        this.#incomingBidirectional.delete(streamId);
    }

    #cancelIncomingStreams(kind: IncomingStreamKind): void {
        if (kind === 'unidirectional') {
            if (!this.#uniOpen) return;
            this.#uniOpen = false;
            this.#uniController = undefined;
        } else {
            if (!this.#bidiOpen) return;
            this.#bidiOpen = false;
            this.#bidiController = undefined;
        }
        const streams = kind === 'unidirectional'
            ? this.#incomingUnidirectional
            : this.#incomingBidirectional;
        for (const streamId of Array.from(streams)) {
            this.#terminateIncomingStream(streamId, kind, 'Incoming stream source was canceled');
        }
        streams.clear();
    }

    #terminateIncomingStream(streamId: number, kind: IncomingStreamKind, reason: string): void {
        if (kind === 'unidirectional') this.#incomingUnidirectional.delete(streamId);
        else this.#incomingBidirectional.delete(streamId);

        const receive = this.#receivers.get(streamId);
        if (receive) {
            this.#receivers.delete(streamId);
            try { this.#conn.stopSending(streamId, 0); } catch { /* connection may already be closed */ }
            receive._connectionClosed(reason);
        }

        if (kind === 'bidirectional') {
            const send = this.#senders.get(streamId);
            if (send) {
                this.#senders.delete(streamId);
                try { this.#conn.resetStream(streamId, 0); } catch { /* connection may already be closed */ }
                send._connectionClosed(reason);
            }
        }
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
    #onError: ((message: string) => void) | null = null;
    #onConnected: (() => void) | null = null;
    #onClose: ((closeCode: number, reason: string) => void) | null = null;

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
        const socket = new nativeQuic.Socket({
            host: '0.0.0.0',
            port: 0,
            isServer: false,
            alpn: WEBTRANSPORT_ALPN,
            verifyPeer: true,
            // OpenSSL's default verify paths are empty on Windows — pass the OS store.
            caCerts: systemCaCerts(),
        });
        this.#socket = socket;
        try {
            this.#connection = socket.connect(target.hostname, Number(target.port) || 443, target.hostname);
            this.#streams = new IncomingStreamController(this.#connection);
            this.datagrams = new WebTransportDatagramDuplexStream(this.#connection);
            this.incomingUnidirectionalStreams = this.#streams.incomingUnidirectionalStreams;
            this.incomingBidirectionalStreams = this.#streams.incomingBidirectionalStreams;

            this.#onError = (message: string) => this.#fail(message);
            this.#onConnected = () => {
                if (this.#state !== 'connecting') return;
                this.#state = 'connected';
                this.#readyResult.resolve();
            };
            this.#onClose = (closeCode: number, reason: string) => {
                if (this.#state === 'closed') return;
                const connecting = this.#state === 'connecting';
                this.#state = 'closed';
                this.#streams.close(reason);
                this.datagrams._close(reason);
                this.#detachConnectionCallbacks();
                if (connecting) this.#readyResult.reject(new WebTransportError(reason || 'Connection closed during handshake'));
                this.#drainingResult.resolve();
                this.#closedResult.resolve({ closeCode, reason });
                this.#socket.close();
            };
            socket.onerror = this.#onError;
            this.#connection.onerror = this.#onError;
            this.#connection.onconnected = this.#onConnected;
            this.#connection.onclose = this.#onClose;
        } catch (error) {
            try { socket.onerror = null; } catch { /* socket may already be disposed */ }
            try { socket.close(); } catch { /* preserve the construction error */ }
            throw error;
        }
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
        this.#detachConnectionCallbacks();
        if (connecting) this.#readyResult.reject(error);
        this.#drainingResult.resolve();
        this.#closedResult.reject(error);
        this.#socket.close();
    }

    #detachConnectionCallbacks(): void {
        try { this.#socket.onerror = null; } catch { /* native socket may already be disposed */ }
        try { this.#connection.onerror = null; } catch { /* native connection may already be disposed */ }
        try { this.#connection.onconnected = null; } catch { /* native connection may already be disposed */ }
        try { this.#connection.onclose = null; } catch { /* native connection may already be disposed */ }
        this.#onError = null;
        this.#onConnected = null;
        this.#onClose = null;
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
    #onConnected: (() => void) | null = null;
    #onError: ((message: string) => void) | null = null;
    #onClose: ((closeCode: number, reason: string) => void) | null = null;

    constructor(conn: CModuleExternalQuic.Connection) {
        this.#conn = conn;
        this.ready = this.#readyResult.promise;
        this.closed = this.#closedResult.promise;
        this.#streams = new IncomingStreamController(conn);
        this.datagrams = new WebTransportDatagramDuplexStream(conn);
        this.incomingUnidirectionalStreams = this.#streams.incomingUnidirectionalStreams;
        this.incomingBidirectionalStreams = this.#streams.incomingBidirectionalStreams;
        this.#onConnected = () => {
            if (this.#state !== 'connecting') return;
            this.#state = 'connected';
            this.#readyResult.resolve();
        };
        this.#onError = (message: string) => this._terminate({ closeCode: 0, reason: message }, true);
        this.#onClose = (closeCode: number, reason: string) => this._terminate({ closeCode, reason });
        conn.onconnected = this.#onConnected;
        conn.onerror = this.#onError;
        conn.onclose = this.#onClose;
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
        this.#detachConnectionCallbacks();
        // A native error callback does not imply that quicly has begun its
        // closing handshake.  Release the connection explicitly; the callback
        // has been detached above so a synchronous native close cannot recurse.
        try { this.#conn.close(info.closeCode, info.reason); } catch { /* already disposed */ }
        if (connecting) this.#readyResult.reject(new WebTransportError(info.reason || 'Connection closed during handshake'));
        if (failed) this.#closedResult.reject(new WebTransportError(info.reason || 'WebTransport connection failed'));
        else this.#closedResult.resolve(info);
    }

    #detachConnectionCallbacks(): void {
        try { this.#conn.onconnected = null; } catch { /* native connection may already be disposed */ }
        try { this.#conn.onerror = null; } catch { /* native connection may already be disposed */ }
        try { this.#conn.onclose = null; } catch { /* native connection may already be disposed */ }
        this.#onConnected = null;
        this.#onError = null;
        this.#onClose = null;
    }
}

export class WebTransportServer {
    #socket: CModuleExternalQuic.Socket;
    #onSession: ((session: WebTransportSession) => void) | null = null;
    #onError: ((message: string) => void) | null = null;
    #sessions = new Set<WebTransportSession>();
    #pending: WebTransportSession[] = [];
    #closed = false;

    constructor(options: { host?: string; port?: number; cert: string; key: string; alpn?: string }) {
        const nativeQuic = requireQuic();
        const socket = new nativeQuic.Socket({
            host: options.host ?? '0.0.0.0',
            port: options.port ?? 4433,
            isServer: true,
            cert: options.cert,
            key: options.key,
            alpn: options.alpn ?? WEBTRANSPORT_ALPN,
        });
        this.#socket = socket;
        try {
            this.#onError = (message: string) => {
                this.#shutdown(message || 'WebTransport server failed', true);
            };
            socket.onerror = this.#onError;
            socket.onconnection = (conn: CModuleExternalQuic.Connection) => {
                if (this.#closed) {
                    try { conn.close(0, 'WebTransport server closed'); } catch { /* socket teardown owns the connection */ }
                    return;
                }
                let session: WebTransportSession;
                try {
                    session = new WebTransportSession(conn);
                } catch (error) {
                    try { conn.close(0, 'Failed to initialize WebTransport session'); } catch { /* preserve construction error */ }
                    throw error;
                }
                this.#sessions.add(session);
                // Use both settlement branches: finally() creates a rejected
                // derived promise when a session fails, which otherwise becomes an
                // unhandled rejection and retains the session callback chain.
                session.closed.then(
                    () => this.#removeSession(session),
                    () => this.#removeSession(session),
                );
                if (this.#onSession) this.#onSession(session);
                else this.#pending.push(session);
            };
        } catch (error) {
            try { socket.onerror = null; } catch { /* socket may already be disposed */ }
            try { socket.onconnection = null; } catch { /* socket may already be disposed */ }
            try { socket.close(); } catch { /* preserve the construction error */ }
            throw error;
        }
    }

    #removeSession(session: WebTransportSession): void {
        this.#sessions.delete(session);
        const index = this.#pending.indexOf(session);
        if (index >= 0) this.#pending.splice(index, 1);
    }

    onsession(handler: (session: WebTransportSession) => void): void {
        this.#onSession = handler;
        for (const session of this.#pending.splice(0)) handler(session);
    }

    close(): void {
        this.#shutdown('WebTransport server closed', false);
    }

    #shutdown(reason: string, failed: boolean): void {
        if (this.#closed) return;
        this.#closed = true;
        try { this.#socket.onerror = null; } catch { /* native socket may already be disposed */ }
        try { this.#socket.onconnection = null; } catch { /* native socket may already be disposed */ }
        this.#onError = null;
        this.#onSession = null;
        for (const session of this.#sessions) {
            session._terminate({ closeCode: 0, reason }, failed);
        }
        this.#sessions.clear();
        this.#pending.length = 0;
        try { this.#socket.close(); } catch { /* close is best-effort after a native failure */ }
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
