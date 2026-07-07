/**
 * WebTransport API polyfill
 * Based on CModuleExternalQuic (quicly + picotls)
 * @see https://www.w3.org/TR/webtransport/
 */

import quic from '@cnojs/quic'

// ---------------------------------------------------------------------------
// WebTransportReady / WebTransportCloseInfo
// ---------------------------------------------------------------------------

export interface WebTransportCloseInfo {
    closeCode: number;
    reason: string;
}

export interface WebTransportHash {
    algorithm: string;
    value: BufferSource;
}

export interface WebTransportOptions {
    allowPooling?: boolean;
    requireUnreliable?: boolean;
    ordered?: boolean;
    serverCertificateHashes?: WebTransportHash[];
}

// ---------------------------------------------------------------------------
// WebTransportSendStream (WritableStream-like)
// ---------------------------------------------------------------------------

export class WebTransportSendStream {
    private _conn: CModuleExternalQuic.Connection;
    private _streamId: number;
    private _closed = false;

    constructor(conn: CModuleExternalQuic.Connection, streamId: number) {
        this._conn = conn;
        this._streamId = streamId;
    }

    get id(): number { return this._streamId; }

    write(chunk: Uint8Array | ArrayBuffer): void {
        if (this._closed) throw new TypeError('Stream is closed');
        this._conn.sendStream(this._streamId, chunk);
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        this._conn.sendStream(this._streamId, new Uint8Array(0), true);
    }

    abort(errorCode: number = 0): void {
        this._closed = true;
        this._conn.resetStream(this._streamId, errorCode);
    }

    getStats(): { bytesWritten: number; bytesSent: number; bytesAcknowledged: number } {
        return { bytesWritten: 0, bytesSent: 0, bytesAcknowledged: 0 };
    }

    get ready(): Promise<void> { return Promise.resolve(); }
    get closed(): Promise<WebTransportCloseInfo> { return Promise.resolve({ closeCode: 0, reason: '' }); }
    get writer(): WritableStreamDefaultWriter<Uint8Array> {
        const self = this;
        const ws = new WritableStream({
            write(chunk: BufferSource) {
                const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                self.write(data);
            },
            close() { self.close(); },
            abort() { self.abort(); },
        });
        return ws.getWriter();
    }
}

// ---------------------------------------------------------------------------
// WebTransportReceiveStream (ReadableStream-like)
// ---------------------------------------------------------------------------

export class WebTransportReceiveStream {
    private _queue: Uint8Array[] = [];
    private _closed = false;
    private _closeInfo: WebTransportCloseInfo = { closeCode: 0, reason: '' };
    private _onData: ((chunk: Uint8Array) => void) | null = null;
    private _onClose: (() => void) | null = null;

    _push(chunk: Uint8Array): void {
        if (this._closed) return;
        if (this._onData) {
            this._onData(chunk);
        } else {
            this._queue.push(chunk);
        }
    }

    _close(closeInfo?: WebTransportCloseInfo): void {
        this._closed = true;
        if (closeInfo) this._closeInfo = closeInfo;
        this._onClose?.();
    }

    read(): Promise<{ done: false; value: Uint8Array } | { done: true; value: undefined }> {
        if (this._queue.length > 0) {
            const value = this._queue.shift();
            if (value !== undefined) return Promise.resolve({ done: false, value });
        }
        if (this._closed) {
            return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
            this._onData = (chunk) => {
                this._onData = null;
                resolve({ done: false, value: chunk });
            };
            this._onClose = () => {
                this._onData = null;
                this._onClose = null;
                resolve({ done: true, value: undefined });
            };
        });
    }

    getStats(): { bytesReceived: number } {
        return { bytesReceived: 0 };
    }

    get ready(): Promise<void> { return Promise.resolve(); }
    get closed(): Promise<WebTransportCloseInfo> { return Promise.resolve(this._closeInfo); }
    get reader(): ReadableStreamDefaultReader<Uint8Array> {
        const self = this;
        const rs = new ReadableStream({
            pull(controller) {
                return self.read().then((result) => {
                    if (result.done) controller.close();
                    else controller.enqueue(result.value);
                });
            },
        });
        return rs.getReader();
    }
}

// ---------------------------------------------------------------------------
// WebTransportBidirectionalStream
// ---------------------------------------------------------------------------

export class WebTransportBidirectionalStream {
    readonly readable: WebTransportReceiveStream;
    readonly writable: WebTransportSendStream;

    constructor(readable: WebTransportReceiveStream, writable: WebTransportSendStream) {
        this.readable = readable;
        this.writable = writable;
    }
}

// ---------------------------------------------------------------------------
// WebTransportDatagramDuplexStream
// ---------------------------------------------------------------------------

export class WebTransportDatagramDuplexStream {
    private _conn: CModuleExternalQuic.Connection;
    private _incomingQueue: Uint8Array[] = [];
    private _onIncoming: ((chunk: Uint8Array) => void) | null = null;

    constructor(conn: CModuleExternalQuic.Connection) {
        this._conn = conn;
        conn.ondatagram = (chunk: Uint8Array) => {
            if (this._onIncoming) {
                this._onIncoming(chunk);
            } else {
                this._incomingQueue.push(chunk);
            }
        };
    }

    get maxDatagramSize(): number { return 1200; }

    writable: WritableStream = new WritableStream({
        write: (chunk: BufferSource) => {
            const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            this._conn.sendDatagram(data);
        },
    });

    readable: ReadableStream = new ReadableStream({
        pull: (controller) => {
            if (this._incomingQueue.length > 0) {
                controller.enqueue(this._incomingQueue.shift());
                return;
            }
            return new Promise<void>((resolve) => {
                this._onIncoming = (chunk: Uint8Array) => {
                    this._onIncoming = null;
                    controller.enqueue(chunk);
                    resolve();
                };
            });
        },
    });
}

// ---------------------------------------------------------------------------
// Incoming stream controllers
// ---------------------------------------------------------------------------

class IncomingStreamController {
    private _uniStreams: WebTransportReceiveStream[] = [];
    private _bidiStreams: WebTransportBidirectionalStream[] = [];
    private _onUni: ((stream: WebTransportReceiveStream) => void) | null = null;
    private _onBidi: ((stream: WebTransportBidirectionalStream) => void) | null = null;
    private _conn: CModuleExternalQuic.Connection;

    constructor(conn: CModuleExternalQuic.Connection) {
        this._conn = conn;
        conn.onstream = (streamId: number, bidirectional: boolean) => {
            if (bidirectional) {
                const recv = new WebTransportReceiveStream();
                const send = new WebTransportSendStream(conn, streamId);
                const bidi = new WebTransportBidirectionalStream(recv, send);
                if (this._onBidi) {
                    this._onBidi(bidi);
                } else {
                    this._bidiStreams.push(bidi);
                }
            } else {
                const recv = new WebTransportReceiveStream();
                if (this._onUni) {
                    this._onUni(recv);
                } else {
                    this._uniStreams.push(recv);
                }
            }
        };

        conn.ondata = (streamId: number, chunk: Uint8Array, fin: boolean) => {
            // route data to the appropriate receive stream
        };
    }

    get incomingUnidirectionalStreams(): ReadableStream<WebTransportReceiveStream> {
        const self = this;
        return new ReadableStream({
            pull(controller) {
                if (self._uniStreams.length > 0) {
                    controller.enqueue(self._uniStreams.shift());
                    return;
                }
                return new Promise<void>((resolve) => {
                    self._onUni = (stream) => {
                        self._onUni = null;
                        controller.enqueue(stream);
                        resolve();
                    };
                });
            },
        });
    }

    get incomingBidirectionalStreams(): ReadableStream<WebTransportBidirectionalStream> {
        const self = this;
        return new ReadableStream({
            pull(controller) {
                if (self._bidiStreams.length > 0) {
                    controller.enqueue(self._bidiStreams.shift());
                    return;
                }
                return new Promise<void>((resolve) => {
                    self._onBidi = (stream) => {
                        self._onBidi = null;
                        controller.enqueue(stream);
                        resolve();
                    };
                });
            },
        });
    }
}

// ---------------------------------------------------------------------------
// WebTransport
// ---------------------------------------------------------------------------

export class WebTransport {
    private _url: URL;
    private _socket: CModuleExternalQuic.Socket;
    private _connection: CModuleExternalQuic.Connection | null = null;
    private _streamCtrl: IncomingStreamController | null = null;
    private _datagrams: WebTransportDatagramDuplexStream | null = null;
    private _readyResolve: ((value: void) => void) | null = null;
    private _readyReject: ((reason: unknown) => void) | null = null;
    private _closedResolve: ((value: WebTransportCloseInfo) => void) | null = null;
    private _drainingResolve: ((value: void) => void) | null = null;
    private _state: 'connecting' | 'connected' | 'draining' | 'closed' = 'connecting';

    readonly ready: Promise<void>;
    readonly closed: Promise<WebTransportCloseInfo>;
    readonly draining: Promise<void>;

    constructor(url: string | URL, options?: WebTransportOptions) {
        this._url = url instanceof URL ? url : new URL(url);
        const host = this._url.hostname;
        const port = parseInt(this._url.port) || 443;
        const alpn = this._url.protocol === 'webtransport:' ? 'webtransport' : undefined;

        this._socket = new quic.Socket({
            host,
            port,
            isServer: false,
            alpn,
        });

        this.ready = new Promise<void>((resolve, reject) => {
            this._readyResolve = resolve;
            this._readyReject = reject;
        });

        this.closed = new Promise<WebTransportCloseInfo>((resolve) => {
            this._closedResolve = resolve;
        });

        this.draining = new Promise<void>((resolve) => {
            this._drainingResolve = resolve;
        });

        this._socket.onerror = (msg: string) => {
            if (this._state === 'connecting') {
                this._readyReject?.(new Error(msg));
            }
        };

        const conn = this._socket.connect(host, port);
        this._connection = conn;

        conn.onconnected = () => {
            this._state = 'connected';
            this._streamCtrl = new IncomingStreamController(conn);
            this._datagrams = new WebTransportDatagramDuplexStream(conn);
            this._readyResolve?.();
        };

        conn.onclose = (errorCode: number, reason: string) => {
            const wasDraining = this._state === 'draining';
            this._state = 'closed';
            this._closedResolve?.({ closeCode: errorCode, reason });
            if (wasDraining) {
                this._drainingResolve?.();
            }
        };

        conn.onerror = (msg: string) => {
            if (this._state === 'connecting') {
                this._readyReject?.(new Error(msg));
            }
        };
    }

    get datagrams(): WebTransportDatagramDuplexStream {
        if (!this._datagrams) throw new TypeError('WebTransport is not ready');
        return this._datagrams;
    }

    get incomingUnidirectionalStreams(): ReadableStream<WebTransportReceiveStream> {
        if (!this._streamCtrl) throw new TypeError('WebTransport is not ready');
        return this._streamCtrl.incomingUnidirectionalStreams;
    }

    get incomingBidirectionalStreams(): ReadableStream<WebTransportBidirectionalStream> {
        if (!this._streamCtrl) throw new TypeError('WebTransport is not ready');
        return this._streamCtrl.incomingBidirectionalStreams;
    }

    createUnidirectionalStream(): WebTransportSendStream {
        if (!this._connection) throw new TypeError('WebTransport is not connected');
        const streamId = this._connection.openStream(false);
        return new WebTransportSendStream(this._connection, streamId);
    }

    async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
        if (!this._connection) throw new TypeError('WebTransport is not connected');
        const streamId = this._connection.openStream(true);
        const recv = new WebTransportReceiveStream();
        const send = new WebTransportSendStream(this._connection, streamId);
        return new WebTransportBidirectionalStream(recv, send);
    }

    close(closeCode: number = 0, reason: string = ''): void {
        if (this._state === 'closed' || this._state === 'draining') return;
        this._state = 'draining';
        this._connection?.close(closeCode, reason);
        this._drainingResolve?.();
    }

    getStats(): { timestamp: number; bytesSent: number; bytesReceived: number; rttVariance: number; rttMin: number; rttSmoothed: number; datagramsSent: number; datagramsReceived: number; datagramsLost: number } {
        const stats = this._connection?.getStats();
        return {
            timestamp: Date.now(),
            bytesSent: stats?.bytesSent ?? 0,
            bytesReceived: stats?.bytesReceived ?? 0,
            rttVariance: 0,
            rttMin: stats?.rttMin ?? 0,
            rttSmoothed: stats?.rttSmoothed ?? 0,
            datagramsSent: 0,
            datagramsReceived: 0,
            datagramsLost: 0,
        };
    }
}

// ---------------------------------------------------------------------------
// WebTransportError
// ---------------------------------------------------------------------------

export class WebTransportError extends Error {
    source: 'stream' | 'session';
    streamErrorCode?: number;

    constructor(message: string, source: 'stream' | 'session' = 'session', streamErrorCode?: number) {
        super(message);
        this.name = 'WebTransportError';
        this.source = source;
        this.streamErrorCode = streamErrorCode;
    }
}

// ---------------------------------------------------------------------------
// Server-side: WebTransportServer
// ---------------------------------------------------------------------------

export class WebTransportServer {
    private _socket: CModuleExternalQuic.Socket;
    private _onSession: ((session: WebTransportSession) => void) | null = null;

    constructor(opts: { host?: string; port?: number; cert: string; key: string; alpn?: string }) {
        this._socket = new quic.Socket({
            host: opts.host ?? '0.0.0.0',
            port: opts.port ?? 4433,
            isServer: true,
            cert: opts.cert,
            key: opts.key,
            alpn: opts.alpn ?? 'webtransport',
        });

        this._socket.onconnection = (conn: CModuleExternalQuic.Connection) => {
            const session = new WebTransportSession(conn);
            if (this._onSession) {
                this._onSession(session);
            }
        };
    }

    onsession(handler: (session: WebTransportSession) => void): void {
        this._onSession = handler;
    }

    close(): void {
        this._socket.onerror = null;
        this._socket.onconnection = null;
    }
}

// ---------------------------------------------------------------------------
// WebTransportSession (server-side connection wrapper)
// ---------------------------------------------------------------------------

export class WebTransportSession {
    private _conn: CModuleExternalQuic.Connection;
    private _streamCtrl: IncomingStreamController;
    private _datagrams: WebTransportDatagramDuplexStream;
    private _readyResolve: ((value: void) => void) | null = null;
    private _closedResolve: ((value: WebTransportCloseInfo) => void) | null = null;
    private _state: 'connecting' | 'connected' | 'draining' | 'closed' = 'connecting';

    readonly ready: Promise<void>;
    readonly closed: Promise<WebTransportCloseInfo>;

    constructor(conn: CModuleExternalQuic.Connection) {
        this._conn = conn;
        this._streamCtrl = new IncomingStreamController(conn);
        this._datagrams = new WebTransportDatagramDuplexStream(conn);

        this.ready = new Promise<void>((resolve) => {
            this._readyResolve = resolve;
        });

        this.closed = new Promise<WebTransportCloseInfo>((resolve) => {
            this._closedResolve = resolve;
        });

        conn.onconnected = () => {
            this._state = 'connected';
            this._streamCtrl = new IncomingStreamController(conn);
            this._datagrams = new WebTransportDatagramDuplexStream(conn);
            this._readyResolve?.();
        };

        conn.onclose = (errorCode: number, reason: string) => {
            this._state = 'closed';
            this._closedResolve?.({ closeCode: errorCode, reason });
        };
    }

    get datagrams(): WebTransportDatagramDuplexStream { return this._datagrams; }
    get incomingUnidirectionalStreams(): ReadableStream<WebTransportReceiveStream> { return this._streamCtrl.incomingUnidirectionalStreams; }
    get incomingBidirectionalStreams(): ReadableStream<WebTransportBidirectionalStream> { return this._streamCtrl.incomingBidirectionalStreams; }

    createUnidirectionalStream(): WebTransportSendStream {
        const streamId = this._conn.openStream(false);
        return new WebTransportSendStream(this._conn, streamId);
    }

    async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
        const streamId = this._conn.openStream(true);
        return new WebTransportBidirectionalStream(
            new WebTransportReceiveStream(),
            new WebTransportSendStream(this._conn, streamId),
        );
    }

    close(closeCode: number = 0, reason: string = ''): void {
        this._state = 'draining';
        this._conn.close(closeCode, reason);
    }
}

// ---------------------------------------------------------------------------
// Global registration
// ---------------------------------------------------------------------------

Reflect.set(globalThis, 'WebTransport', WebTransport);
