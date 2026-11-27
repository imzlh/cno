import { requireQuic } from "../utils/quic-native";
import { bytesToArrayBuffer, toOwnedBytes } from "../utils/bytes";
import { withSystemCaCerts } from "../utils/ca-certs";
import { closeStreamQuietly } from "./utils/pipe-streams";

const DEFAULT_ALPN = "cno-quic";

// Receive-side backpressure mirrors real Deno: quinn bounds its datagram
// receive buffer and quic listeners never surface an unbounded accept backlog.
const MAX_QUEUED_DATAGRAMS = 1024;
const MAX_QUEUED_INCOMING = 1024;

function alpnProtocols(protocols?: string[]): string[] {
    return protocols?.length ? protocols.slice() : [DEFAULT_ALPN];
}

function nativeTransport(options: Deno.QuicTransportOptions): CModuleExternalQuic.TransportParams {
    const transport: CModuleExternalQuic.TransportParams = {};
    if (options.maxConcurrentBidirectionalStreams !== undefined) {
        transport.maxStreamsBidi = options.maxConcurrentBidirectionalStreams;
    }
    if (options.maxConcurrentUnidirectionalStreams !== undefined) {
        transport.maxStreamsUni = options.maxConcurrentUnidirectionalStreams;
    }
    if (options.maxIdleTimeout !== undefined) transport.idleTimeoutMs = options.maxIdleTimeout;
    if (options.congestionControl === "throughput") transport.cc = "cubic";
    if (options.congestionControl === "low-latency") transport.cc = "pico";
    return transport;
}

function streamErrorCode(reason: unknown): number {
    if (typeof reason === "number" && Number.isInteger(reason) && reason >= 0) return reason >>> 0;
    if (reason && typeof reason === "object") {
        const code = Reflect.get(reason, "closeCode");
        if (typeof code === "number" && Number.isInteger(code) && code >= 0) return code >>> 0;
    }
    return 0;
}

type SendStreamState = {
    closed: boolean;
    controller?: WritableStreamDefaultController;
    onClosed: () => void;
};

class QuicSendStream extends WritableStream<Uint8Array<ArrayBufferLike>> {
    readonly id: bigint;
    sendOrder = 0;
    #state: SendStreamState;

    constructor(conn: CModuleExternalQuic.Connection, id: number, onClosed: () => void, sendOrder = 0) {
        const state: SendStreamState = { closed: false, onClosed };
        super({
            start(controller) {
                state.controller = controller;
            },
            write(chunk) {
                conn.sendStream(id, bytesToArrayBuffer(chunk), false);
            },
            close() {
                if (!state.closed) {
                    state.closed = true;
                    try {
                        conn.sendStream(id, new ArrayBuffer(0), true);
                    } finally {
                        state.onClosed();
                    }
                }
            },
            abort(reason) {
                if (state.closed) return;
                state.closed = true;
                try {
                    conn.resetStream(id, streamErrorCode(reason));
                } finally {
                    state.onClosed();
                }
            },
        });
        this.id = BigInt(id);
        this.sendOrder = sendOrder;
        this.#state = state;
    }

    stop(errorCode: number): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#state.controller?.error(new Error(`QUIC stream stopped (${errorCode})`));
        this.#state.onClosed();
    }

    connectionClosed(reason: string): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#state.controller?.error(new Error(reason || "QUIC connection closed"));
        this.#state.onClosed();
    }
}

class QuicReceiveStream extends ReadableStream<Uint8Array<ArrayBuffer>> {
    readonly id: bigint;
    #controller?: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    #state: { closed: boolean };
    #onClosed: () => void;

    constructor(conn: CModuleExternalQuic.Connection, id: number, onClosed: () => void) {
        let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
        const state = { closed: false };
        super({
            start(c) {
                controller = c;
            },
            cancel(reason) {
                if (state.closed) return;
                state.closed = true;
                try {
                    conn.stopSending(id, streamErrorCode(reason));
                } finally {
                    onClosed();
                }
            },
        });
        this.id = BigInt(id);
        this.#controller = controller;
        this.#state = state;
        this.#onClosed = onClosed;
    }

    push(chunk: Uint8Array<ArrayBufferLike>, fin: boolean) {
        if (this.#state.closed) return;
        const owned = toOwnedBytes(chunk);
        if (owned.byteLength !== 0) this.#controller?.enqueue(owned);
        if (fin) {
            this.#state.closed = true;
            this.#controller?.close();
            this.#onClosed();
        }
    }

    reset(errorCode: number): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#controller?.error(new Error(`QUIC stream reset (${errorCode})`));
        this.#onClosed();
    }

    connectionClosed(reason: string): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#controller?.error(new Error(reason || "QUIC connection closed"));
        this.#onClosed();
    }
}

type QuicStreamEntry = {
    readable?: QuicReceiveStream;
    writable?: QuicSendStream;
    incomingQueued?: boolean;
    readableClosed?: boolean;
    writableClosed?: boolean;
};

class QuicConnImpl implements Deno.QuicConn {
    readonly endpoint: QuicEndpointImpl;
    readonly remoteAddr: Deno.NetAddr;
    readonly maxDatagramSize = 1200;
    readonly incomingBidirectionalStreams: ReadableStream<Deno.QuicBidirectionalStream>;
    readonly incomingUnidirectionalStreams: ReadableStream<Deno.QuicReceiveStream>;
    readonly handshake: Promise<void>;
    readonly closed: Promise<Deno.QuicCloseInfo>;

    #conn: CModuleExternalQuic.Connection;
    #handshakeResolve: () => void;
    #handshakeReject: (reason?: unknown) => void;
    #closedResolve: (info: Deno.QuicCloseInfo) => void;
    #datagrams: Uint8Array<ArrayBuffer>[] = [];
    #datagramWaiters: PromiseWithResolvers<Uint8Array<ArrayBuffer>>[] = [];
    #streams = new Map<number, QuicStreamEntry>();
    #bidiController?: ReadableStreamDefaultController<Deno.QuicBidirectionalStream>;
    #uniController?: ReadableStreamDefaultController<Deno.QuicReceiveStream>;
    #handshakeDone = false;
    #closedDone = false;
    #protocol: string | undefined;
    #serverName: string | undefined;

    constructor(endpoint: QuicEndpointImpl, conn: CModuleExternalQuic.Connection) {
        this.endpoint = endpoint;
        this.#conn = conn;
        const peer = conn.peerAddress;
        if (!peer) throw new Error("QUIC connection has no peer address");
        this.remoteAddr = { transport: "udp", hostname: peer.ip, port: peer.port };
        const handshake = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<Deno.QuicCloseInfo>();
        this.handshake = handshake.promise;
        void this.handshake.catch(() => {});
        this.closed = closed.promise;
        this.#handshakeResolve = handshake.resolve;
        this.#handshakeReject = handshake.reject;
        this.#closedResolve = closed.resolve;
        this.incomingBidirectionalStreams = new ReadableStream({
            start: (controller) => this.#bidiController = controller,
            cancel: () => { this.#bidiController = undefined; },
        });
        this.incomingUnidirectionalStreams = new ReadableStream({
            start: (controller) => this.#uniController = controller,
            cancel: () => { this.#uniController = undefined; },
        });
        endpoint.register(this);
        this.#bind();
    }

    #bind() {
        this.#conn.onconnected = () => {
            if (!this.#handshakeDone && !this.#closedDone) {
                this.#protocol = this.#conn.protocol;
                this.#serverName = this.endpoint.role === "server" ? this.#conn.serverName : undefined;
                this.#handshakeDone = true;
                this.#handshakeResolve();
            }
        };
        this.#conn.onclose = (closeCode = 0, reason = "") => {
            this.#finishClose({ closeCode, reason });
        };
        this.#conn.ondatagram = (data: Uint8Array<ArrayBufferLike>) => {
            const chunk = toOwnedBytes(data);
            const waiter = this.#datagramWaiters.shift();
            if (waiter) waiter.resolve(chunk);
            else if (this.#datagrams.length >= MAX_QUEUED_DATAGRAMS) {
                // Datagrams are unreliable; real Deno (quinn) bounds the receive
                // buffer, so drop the oldest and keep the freshest data.
                this.#datagrams.shift();
                this.#datagrams.push(chunk);
            } else {
                this.#datagrams.push(chunk);
            }
        };
        this.#conn.onstream = (id: number, bidirectional: boolean) => {
            const entry = this.#ensureStream(id, bidirectional);
            this.#queueIncomingStream(entry, bidirectional);
        };
        this.#conn.ondata = (id: number, data: Uint8Array<ArrayBufferLike>, fin: boolean) => {
            this.#streams.get(id)?.readable?.push(data, fin);
        };
        this.#conn.onstreamreset = (id: number, errorCode: number) => {
            this.#streams.get(id)?.readable?.reset(errorCode);
        };
        this.#conn.onstreamstop = (id: number, errorCode: number) => {
            this.#streams.get(id)?.writable?.stop(errorCode);
        };
        this.#conn.onerror = (message: string) => {
            const error = new Error(message || "QUIC connection failed");
            if (!this.#handshakeDone) this.#handshakeReject(error);
            this.#finishClose({ closeCode: 0, reason: error.message });
        };
    }

    get protocol(): string | undefined {
        return this.#protocol;
    }

    get serverName(): string | undefined {
        return this.#serverName;
    }

    #ensureStream(id: number, bidirectional: boolean): QuicStreamEntry {
        let entry = this.#streams.get(id);
        if (!entry) {
            entry = {};
            this.#streams.set(id, entry);
            const receiving = entry;
            entry.readable = new QuicReceiveStream(this.#conn, id, () => {
                receiving.readableClosed = true;
                this.#releaseStream(id, receiving);
            });
        }
        if (bidirectional && !entry.writable) {
            const sending = entry;
            entry.writable = new QuicSendStream(this.#conn, id, () => {
                sending.writableClosed = true;
                this.#releaseStream(id, sending);
            });
        }
        return entry;
    }

    #releaseStream(id: number, entry: QuicStreamEntry): void {
        if ((!entry.readable || entry.readableClosed) && (!entry.writable || entry.writableClosed)) {
            this.#streams.delete(id);
        }
    }

    #queueIncomingStream(entry: QuicStreamEntry, bidirectional: boolean) {
        if (entry.incomingQueued) return;
        entry.incomingQueued = true;
        const readable = entry.readable;
        if (!readable) throw new Error("QUIC incoming stream is missing readable side");
        if (bidirectional) {
            const writable = entry.writable;
            if (!writable) throw new Error("QUIC bidirectional stream is missing writable side");
            this.#bidiController?.enqueue({
                readable,
                writable,
            });
        } else {
            this.#uniController?.enqueue(readable);
        }
    }

    close(info?: Deno.QuicCloseInfo): void {
        if (this.#closedDone) return;
        this.#conn.close(info?.closeCode ?? 0, info?.reason ?? "");
    }

    async createBidirectionalStream(options: Deno.QuicSendStreamOptions = {}): Promise<Deno.QuicBidirectionalStream> {
        if (this.#closedDone) throw new Error("QUIC connection closed");
        const id = this.#conn.openStream(true);
        const entry = this.#ensureStream(id, true);
        if (options.sendOrder !== undefined && entry.writable) entry.writable.sendOrder = options.sendOrder;
        const writable = entry.writable;
        if (!writable) throw new Error("QUIC bidirectional stream is missing writable side");
        const readable = entry.readable;
        if (!readable) throw new Error("QUIC bidirectional stream is missing readable side");
        return { readable, writable };
    }

    async createUnidirectionalStream(options: Deno.QuicSendStreamOptions = {}): Promise<Deno.QuicSendStream> {
        if (this.#closedDone) throw new Error("QUIC connection closed");
        const id = this.#conn.openStream(false);
        const send = new QuicSendStream(this.#conn, id, () => this.#streams.delete(id), options.sendOrder);
        this.#streams.set(id, { writable: send });
        return send;
    }

    async sendDatagram(data: Uint8Array): Promise<void> {
        if (this.#closedDone) throw new Error("QUIC connection closed");
        if (data.byteLength > this.maxDatagramSize) {
            throw new RangeError(`Datagram exceeds maxDatagramSize (${this.maxDatagramSize})`);
        }
        this.#conn.sendDatagram(bytesToArrayBuffer(data));
    }

    async readDatagram(): Promise<Uint8Array<ArrayBuffer>> {
        const datagram = this.#datagrams.shift();
        if (datagram) return datagram;
        if (this.#closedDone) throw new Error("QUIC connection closed");
        const waiter = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
        this.#datagramWaiters.push(waiter);
        return await waiter.promise;
    }

    endpointClosed(info: Deno.QuicCloseInfo): void {
        this.#finishClose(info);
    }

    #finishClose(info: Deno.QuicCloseInfo): void {
        if (this.#closedDone) return;
        this.#closedDone = true;
        if (!this.#handshakeDone) this.#handshakeReject(new Error(info.reason || "QUIC connection closed during handshake"));
        for (const waiter of this.#datagramWaiters) waiter.reject(new Error(info.reason || "QUIC connection closed"));
        this.#datagramWaiters.length = 0;
        this.#datagrams.length = 0;
        for (const entry of this.#streams.values()) {
            entry.readable?.connectionClosed(info.reason);
            entry.writable?.connectionClosed(info.reason);
        }
        this.#streams.clear();
        this.#bidiController?.close();
        this.#uniController?.close();
        this.endpoint.unregister(this);
        this.#closedResolve(info);
    }
}

class QuicIncomingImpl implements Deno.QuicIncoming {
    readonly localIp: string;
    readonly remoteAddressValidated = false;
    readonly remoteAddr: Deno.NetAddr;
    #conn: QuicConnImpl;
    #accepted = false;

    constructor(conn: QuicConnImpl) {
        this.#conn = conn;
        this.localIp = conn.endpoint.addr.hostname;
        this.remoteAddr = conn.remoteAddr;
    }

    accept(options: Deno.QuicAcceptOptions<true>): Deno.QuicConn;
    accept(options?: Deno.QuicAcceptOptions<false>): Promise<Deno.QuicConn>;
    accept(options?: Deno.QuicAcceptOptions<boolean>): Deno.QuicConn | Promise<Deno.QuicConn> {
        if (this.#accepted) throw new TypeError("QUIC incoming connection is already handled");
        this.#accepted = true;
        return options?.zeroRtt ? this.#conn : this.#conn.handshake.then(() => this.#conn);
    }

    refuse(): void {
        if (this.#accepted) throw new TypeError("QUIC incoming connection is already handled");
        this.#accepted = true;
        this.#conn.close({ closeCode: 0, reason: "refused" });
    }

    ignore(): void {
        this.refuse();
    }
}

class QuicListenerImpl implements Deno.QuicListener {
    readonly endpoint: QuicEndpointImpl;
    #incoming: QuicIncomingImpl[] = [];
    #waiters: PromiseWithResolvers<QuicIncomingImpl>[] = [];
    #stopped = false;
    #socket: CModuleExternalQuic.Socket;

    constructor(endpoint: QuicEndpointImpl, socket: CModuleExternalQuic.Socket) {
        this.endpoint = endpoint;
        this.#socket = socket;
        socket.onconnection = (nativeConn: CModuleExternalQuic.Connection) => {
            if (this.#stopped) {
                nativeConn.close(0, "listener stopped");
                return;
            }
            // Bound the accept backlog like real Deno (quinn); the newest native
            // conn is closed instead of queued so queued ones stay reachable.
            if (this.#waiters.length === 0 && this.#incoming.length >= MAX_QUEUED_INCOMING) {
                nativeConn.close(0, "accept backlog full");
                return;
            }
            const conn = new QuicConnImpl(endpoint, nativeConn);
            const incoming = new QuicIncomingImpl(conn);
            const waiter = this.#waiters.shift();
            if (waiter) waiter.resolve(incoming);
            else this.#incoming.push(incoming);
        };
    }

    incoming(): Promise<Deno.QuicIncoming> {
        if (this.#stopped) return Promise.reject(new Error("QUIC listener stopped"));
        const incoming = this.#incoming.shift();
        if (incoming) return Promise.resolve(incoming);
        const waiter = Promise.withResolvers<QuicIncomingImpl>();
        this.#waiters.push(waiter);
        return waiter.promise;
    }

    async accept(): Promise<Deno.QuicConn> {
        return await (await this.incoming()).accept();
    }

    stop(): void {
        if (this.#stopped) return;
        this.#stopped = true;
        this.#socket.onconnection = null;
        const err = new Error("QUIC listener stopped");
        for (const waiter of this.#waiters) waiter.reject(err);
        this.#waiters.length = 0;
        for (const incoming of this.#incoming) incoming.refuse();
        this.#incoming.length = 0;
    }

    async *[Symbol.asyncIterator](): AsyncIterableIterator<Deno.QuicIncoming> {
        while (!this.#stopped) {
            try {
                yield await this.incoming();
            } catch (error) {
                if (!this.#stopped) throw error;
            }
        }
    }
}

class QuicEndpointImpl implements Deno.QuicEndpoint {
    readonly addr: Deno.NetAddr;
    readonly bindHostname?: string;
    socket?: CModuleExternalQuic.Socket;
    alpnProtocols = [DEFAULT_ALPN];
    /** Native sockets bake in role/ALPN/trust at construction — reuse must match. */
    role?: "client" | "server";
    #connections = new Set<QuicConnImpl>();
    #closed = false;
    #listener?: QuicListenerImpl;
    #closeWhenUnused: boolean;

    constructor(options: Deno.QuicEndpointOptions = {}, closeWhenUnused = false) {
        this.#closeWhenUnused = closeWhenUnused;
        this.bindHostname = options.hostname;
        this.addr = {
            transport: "udp",
            hostname: options.hostname ?? "0.0.0.0",
            port: options.port ?? 0,
        };
    }

    listen(options: Deno.QuicListenOptions): Deno.QuicListener {
        if (this.#closed) throw new Error("QUIC endpoint closed");
        if (this.socket) throw new Error("QUIC endpoint is already in use");
        this.alpnProtocols = alpnProtocols(options.alpnProtocols);
        const nativeQuic = requireQuic();
        this.socket = new nativeQuic.Socket({
            isServer: true,
            host: this.addr.hostname,
            port: this.addr.port,
            cert: options.cert,
            key: options.key,
            alpnProtocols: this.alpnProtocols,
            transport: nativeTransport(options),
        });
        this.socket.onerror = (message: string) => this.fail(message);
        this.role = "server";
        this.updateAddress();
        return this.#listener = new QuicListenerImpl(this, this.socket);
    }

    close(info: Deno.QuicCloseInfo = { closeCode: 0, reason: "" }): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#listener?.stop();
        for (const conn of [...this.#connections]) conn.endpointClosed(info);
        if (this.socket) {
            closeStreamQuietly(this.socket);
            this.socket = undefined;
        }
    }

    register(conn: QuicConnImpl): void {
        if (this.#closed) throw new Error("QUIC endpoint closed");
        this.#connections.add(conn);
    }

    unregister(conn: QuicConnImpl): void {
        this.#connections.delete(conn);
        if (this.#closeWhenUnused && this.#connections.size === 0) {
            queueMicrotask(() => {
                if (this.#connections.size === 0) this.close();
            });
        }
    }

    updateAddress(): void {
        const local = this.socket?.localAddress;
        if (local) {
            this.addr.hostname = local.ip;
            this.addr.port = local.port;
        }
    }

    ensureOpen(): void {
        if (this.#closed) throw new Error("QUIC endpoint closed");
    }

    fail(message: string): void {
        this.close({ closeCode: 0, reason: message || "QUIC endpoint failed" });
    }
}

function connectQuic(options: Deno.ConnectQuicOptions<boolean>): Promise<Deno.QuicConn> {
    let endpoint: QuicEndpointImpl;
    if (options.endpoint === undefined) endpoint = new QuicEndpointImpl({}, true);
    else if (options.endpoint instanceof QuicEndpointImpl) endpoint = options.endpoint;
    else throw new TypeError("endpoint must be a Deno.QuicEndpoint created by this runtime");
    endpoint.ensureOpen();
    const nativeQuic = requireQuic();
    const protocols = alpnProtocols(options.alpnProtocols);
    // A native Socket bakes in its role, ALPN and trust store at construction.
    // A server socket has no verify_certificate at all, so reusing one for a
    // client handshake would skip chain *and* signature verification entirely.
    if (endpoint.socket && endpoint.role !== "client") {
        throw new Error("QUIC endpoint is already in use as a server; use a separate endpoint to connect");
    }
    if (endpoint.socket && (endpoint.alpnProtocols.length !== protocols.length ||
        endpoint.alpnProtocols.some((protocol, index) => protocol !== protocols[index]))) {
        throw new Error(
            `QUIC endpoint is already connected with ALPN ${JSON.stringify(endpoint.alpnProtocols)}; ` +
            `reuse cannot renegotiate to ${JSON.stringify(protocols)}`,
        );
    }
    if (endpoint.socket && options.caCerts?.length) {
        throw new Error("QUIC endpoint is already connected; caCerts cannot be changed on reuse");
    }
    if (!endpoint.socket) {
        endpoint.alpnProtocols = protocols;
        endpoint.socket = new nativeQuic.Socket({
            host: endpoint.bindHostname,
            port: endpoint.addr.port,
            alpnProtocols: endpoint.alpnProtocols,
            transport: nativeTransport(options),
            verifyPeer: true,
            // OpenSSL's default verify paths are empty on Windows — merge the OS store.
            caCerts: withSystemCaCerts(options.caCerts),
        });
        endpoint.role = "client";
        endpoint.socket.onerror = (message: string) => endpoint.fail(message);
    }
    try {
        const nativeConn = endpoint.socket.connect(
            options.hostname,
            options.port,
            options.serverName ?? options.hostname,
        );
        endpoint.updateAddress();
        const conn = new QuicConnImpl(endpoint, nativeConn);
        return conn.handshake.then(() => conn);
    } catch (error) {
        if (options.endpoint === undefined) endpoint.close();
        throw error;
    }
}

export { QuicEndpointImpl as QuicEndpoint, connectQuic };

Object.assign(Deno, {
    QuicEndpoint: QuicEndpointImpl,
    connectQuic,
});
