import { requireQuic } from "../quic-native";
import { bytesToArrayBuffer, toOwnedBytes } from "../utils/bytes";
import { withSystemCaCerts } from "../utils/ca-certs";

const DEFAULT_ALPN = "cno-quic";

function closeQuicSocketQuietly(socket: CModuleExternalQuic.Socket): void {
    try {
        socket.close();
    } catch {
        // Closing an already-failed QUIC socket is best-effort.
    }
}

function firstAlpn(protocols?: string[]): string {
    if (!protocols || protocols.length === 0) return DEFAULT_ALPN;
    return protocols[0];
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
};

class QuicSendStream extends WritableStream<Uint8Array<ArrayBufferLike>> {
    readonly id: bigint;
    sendOrder = 0;
    #state: SendStreamState;

    constructor(conn: CModuleExternalQuic.Connection, id: number, sendOrder = 0) {
        const state: SendStreamState = { closed: false };
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
                    conn.sendStream(id, new ArrayBuffer(0), true);
                }
            },
            abort(reason) {
                if (state.closed) return;
                state.closed = true;
                conn.resetStream(id, streamErrorCode(reason));
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
    }

    connectionClosed(reason: string): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#state.controller?.error(new Error(reason || "QUIC connection closed"));
    }
}

class QuicReceiveStream extends ReadableStream<Uint8Array<ArrayBuffer>> {
    readonly id: bigint;
    #controller?: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    #state: { closed: boolean };

    constructor(conn: CModuleExternalQuic.Connection, id: number) {
        let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
        const state = { closed: false };
        super({
            start(c) {
                controller = c;
            },
            cancel(reason) {
                state.closed = true;
                conn.stopSending(id, streamErrorCode(reason));
            },
        });
        this.id = BigInt(id);
        this.#controller = controller;
        this.#state = state;
    }

    push(chunk: Uint8Array<ArrayBufferLike>, fin: boolean) {
        if (this.#state.closed) return;
        const owned = toOwnedBytes(chunk);
        if (owned.byteLength !== 0) this.#controller?.enqueue(owned);
        if (fin) {
            this.#state.closed = true;
            this.#controller?.close();
        }
    }

    reset(errorCode: number): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#controller?.error(new Error(`QUIC stream reset (${errorCode})`));
    }

    connectionClosed(reason: string): void {
        if (this.#state.closed) return;
        this.#state.closed = true;
        this.#controller?.error(new Error(reason || "QUIC connection closed"));
    }
}

type QuicStreamEntry = {
    readable?: QuicReceiveStream;
    writable?: QuicSendStream;
    incomingQueued?: boolean;
};

class QuicConnImpl implements Deno.QuicConn {
    readonly endpoint: QuicEndpointImpl;
    readonly remoteAddr: Deno.NetAddr;
    readonly protocol: string | undefined;
    readonly serverName: string | undefined;
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

    constructor(endpoint: QuicEndpointImpl, conn: CModuleExternalQuic.Connection, remoteAddr: Deno.NetAddr, protocol?: string) {
        this.endpoint = endpoint;
        this.#conn = conn;
        this.remoteAddr = remoteAddr;
        this.protocol = protocol;
        const handshake = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<Deno.QuicCloseInfo>();
        this.handshake = handshake.promise;
        this.closed = closed.promise;
        this.#handshakeResolve = handshake.resolve;
        this.#handshakeReject = handshake.reject;
        this.#closedResolve = closed.resolve;
        this.incomingBidirectionalStreams = new ReadableStream({
            start: (controller) => this.#bidiController = controller,
        });
        this.incomingUnidirectionalStreams = new ReadableStream({
            start: (controller) => this.#uniController = controller,
        });
        endpoint.register(this);
        this.#bind();
    }

    #bind() {
        this.#conn.onconnected = () => {
            if (!this.#handshakeDone) {
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
            else this.#datagrams.push(chunk);
        };
        this.#conn.onstream = (id: number, bidirectional: boolean) => {
            const entry = this.#ensureStream(id, bidirectional);
            this.#queueIncomingStream(entry, bidirectional);
        };
        this.#conn.ondata = (id: number, data: Uint8Array<ArrayBufferLike>, fin: boolean) => {
            const existed = this.#streams.has(id);
            const bidirectional = (id & 2) === 0;
            const entry = this.#ensureStream(id, bidirectional);
            if (!existed) this.#queueIncomingStream(entry, bidirectional);
            entry.readable?.push(data, fin);
            if (fin && !entry.writable) this.#streams.delete(id);
        };
        this.#conn.onstreamreset = (id: number, errorCode: number) => {
            this.#streams.get(id)?.readable?.reset(errorCode);
            this.#streams.delete(id);
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

    #ensureStream(id: number, bidirectional: boolean): QuicStreamEntry {
        let entry = this.#streams.get(id);
        if (!entry) {
            entry = { readable: new QuicReceiveStream(this.#conn, id) };
            this.#streams.set(id, entry);
        }
        if (bidirectional && !entry.writable) entry.writable = new QuicSendStream(this.#conn, id);
        return entry;
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
        const send = new QuicSendStream(this.#conn, id, options.sendOrder);
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

    constructor(conn: QuicConnImpl) {
        this.#conn = conn;
        this.localIp = conn.endpoint.addr.hostname;
        this.remoteAddr = conn.remoteAddr;
    }

    accept(options: Deno.QuicAcceptOptions<true>): Deno.QuicConn;
    accept(options?: Deno.QuicAcceptOptions<false>): Promise<Deno.QuicConn>;
    accept(options?: Deno.QuicAcceptOptions<boolean>): Deno.QuicConn | Promise<Deno.QuicConn> {
        return options?.zeroRtt ? this.#conn : Promise.resolve(this.#conn);
    }

    refuse(): void {
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
            const conn = new QuicConnImpl(
                endpoint,
                nativeConn,
                { transport: "udp", hostname: "0.0.0.0", port: 0 },
                endpoint.alpn,
            );
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
    }

    async *[Symbol.asyncIterator](): AsyncIterableIterator<Deno.QuicIncoming> {
        while (!this.#stopped) yield await this.incoming();
    }
}

class QuicEndpointImpl implements Deno.QuicEndpoint {
    readonly addr: Deno.NetAddr;
    socket?: CModuleExternalQuic.Socket;
    alpn = DEFAULT_ALPN;
    /** Native sockets bake in role/ALPN/trust at construction — reuse must match. */
    role?: "client" | "server";
    #connections = new Set<QuicConnImpl>();
    #closed = false;

    constructor(options: Deno.QuicEndpointOptions = {}) {
        this.addr = {
            transport: "udp",
            hostname: options.hostname ?? "0.0.0.0",
            port: options.port ?? 0,
        };
    }

    listen(options: Deno.QuicListenOptions): Deno.QuicListener {
        if (this.#closed) throw new Error("QUIC endpoint closed");
        if (this.socket) throw new Error("QUIC endpoint is already in use");
        this.alpn = firstAlpn(options.alpnProtocols);
        const nativeQuic = requireQuic();
        this.socket = new nativeQuic.Socket({
            isServer: true,
            host: this.addr.hostname,
            port: this.addr.port,
            cert: options.cert,
            key: options.key,
            alpn: this.alpn,
            transport: nativeTransport(options),
        });
        this.socket.onerror = (message: string) => this.fail(message);
        this.role = "server";
        return new QuicListenerImpl(this, this.socket);
    }

    close(info: Deno.QuicCloseInfo = { closeCode: 0, reason: "" }): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const conn of [...this.#connections]) conn.endpointClosed(info);
        if (this.socket) {
            closeQuicSocketQuietly(this.socket);
            this.socket = undefined;
        }
    }

    register(conn: QuicConnImpl): void {
        if (this.#closed) throw new Error("QUIC endpoint closed");
        this.#connections.add(conn);
    }

    unregister(conn: QuicConnImpl): void {
        this.#connections.delete(conn);
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
    if (options.endpoint === undefined) endpoint = new QuicEndpointImpl();
    else if (options.endpoint instanceof QuicEndpointImpl) endpoint = options.endpoint;
    else throw new TypeError("endpoint must be a Deno.QuicEndpoint created by this runtime");
    endpoint.ensureOpen();
    const nativeQuic = requireQuic();
    const alpn = firstAlpn(options.alpnProtocols);
    // A native Socket bakes in its role, ALPN and trust store at construction.
    // A server socket has no verify_certificate at all, so reusing one for a
    // client handshake would skip chain *and* signature verification entirely.
    if (endpoint.socket && endpoint.role !== "client") {
        throw new Error("QUIC endpoint is already in use as a server; use a separate endpoint to connect");
    }
    if (endpoint.socket && endpoint.alpn !== alpn) {
        throw new Error(
            `QUIC endpoint is already connected with ALPN ${JSON.stringify(endpoint.alpn)}; ` +
            `reuse cannot renegotiate to ${JSON.stringify(alpn)}`,
        );
    }
    if (endpoint.socket && options.caCerts?.length) {
        throw new Error("QUIC endpoint is already connected; caCerts cannot be changed on reuse");
    }
    if (!endpoint.socket) {
        endpoint.alpn = alpn;
        endpoint.socket = new nativeQuic.Socket({
            host: endpoint.addr.hostname,
            port: endpoint.addr.port,
            alpn: endpoint.alpn,
            transport: nativeTransport(options),
            verifyPeer: true,
            // OpenSSL's default verify paths are empty on Windows — merge the OS store.
            caCerts: withSystemCaCerts(options.caCerts),
        });
        endpoint.role = "client";
        endpoint.socket.onerror = (message: string) => endpoint.fail(message);
    }
    const nativeConn = endpoint.socket.connect(
        options.hostname,
        options.port,
        options.serverName ?? options.hostname,
    );
    const conn = new QuicConnImpl(
        endpoint,
        nativeConn,
        { transport: "udp", hostname: options.hostname, port: options.port },
        endpoint.alpn,
    );
    return conn.handshake.then(() => conn);
}

Object.assign(Deno, {
    QuicEndpoint: QuicEndpointImpl,
    connectQuic,
});
