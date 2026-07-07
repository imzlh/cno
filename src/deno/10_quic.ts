import type nativeQuicModule from "@cnojs/quic";
import { bytesToArrayBuffer } from "../utils/bytes";

const nativeQuic: typeof nativeQuicModule = import.meta.use("@cnojs/quic");

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

class QuicSendStream extends WritableStream<Uint8Array> {
    readonly id: bigint;
    sendOrder = 0;

    constructor(conn: CModuleExternalQuic.Connection, id: number) {
        let closed = false;
        super({
            write(chunk) {
                conn.sendStream(id, bytesToArrayBuffer(chunk), false);
            },
            close() {
                if (!closed) {
                    closed = true;
                    conn.sendStream(id, new ArrayBuffer(0), true);
                }
            },
            abort() {
                conn.resetStream(id, 0);
            },
        });
        this.id = BigInt(id);
    }
}

class QuicReceiveStream extends ReadableStream<Uint8Array<ArrayBuffer>> {
    readonly id: bigint;
    controller?: ReadableStreamDefaultController<Uint8Array>;

    constructor(id: number) {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        super({
            start(c) {
                controller = c;
            },
        });
        this.id = BigInt(id);
        this.controller = controller;
    }

    push(chunk: Uint8Array<ArrayBuffer>, fin: boolean) {
        if (chunk.byteLength !== 0) this.controller?.enqueue(chunk);
        if (fin) this.controller?.close();
    }
}

type QuicStreamEntry = {
    readable: QuicReceiveStream;
    writable?: QuicSendStream;
    incomingQueued?: boolean;
};

class QuicConnImpl implements Deno.QuicConn {
    readonly endpoint: QuicEndpointImpl;
    readonly remoteAddr: Deno.NetAddr;
    readonly protocol?: string;
    readonly serverName?: string;
    readonly maxDatagramSize = 1200;
    readonly incomingBidirectionalStreams: ReadableStream<Deno.QuicBidirectionalStream>;
    readonly incomingUnidirectionalStreams: ReadableStream<Deno.QuicReceiveStream>;
    readonly handshake: Promise<void>;
    readonly closed: Promise<Deno.QuicCloseInfo>;

    #conn: CModuleExternalQuic.Connection;
    #handshakeResolve: () => void;
    #closedResolve: (info: Deno.QuicCloseInfo) => void;
    #datagrams: Uint8Array<ArrayBuffer>[] = [];
    #datagramWaiters: ((data: Uint8Array<ArrayBuffer>) => void)[] = [];
    #streams = new Map<number, QuicStreamEntry>();
    #bidiController?: ReadableStreamDefaultController<Deno.QuicBidirectionalStream>;
    #uniController?: ReadableStreamDefaultController<Deno.QuicReceiveStream>;
    #handshakeDone = false;

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
        this.#closedResolve = closed.resolve;
        this.incomingBidirectionalStreams = new ReadableStream({
            start: (controller) => this.#bidiController = controller,
        });
        this.incomingUnidirectionalStreams = new ReadableStream({
            start: (controller) => this.#uniController = controller,
        });
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
            this.#closedResolve({ closeCode, reason });
        };
        this.#conn.ondatagram = (data: ArrayBuffer) => {
            const chunk = new Uint8Array(data);
            const waiter = this.#datagramWaiters.shift();
            if (waiter) waiter(chunk);
            else this.#datagrams.push(chunk);
        };
        this.#conn.onstream = (id: number, bidirectional: boolean) => {
            const entry = this.#ensureStream(id, bidirectional);
            this.#queueIncomingStream(entry, bidirectional);
        };
        this.#conn.ondata = (id: number, data: ArrayBuffer, fin: boolean) => {
            const existed = this.#streams.has(id);
            const entry = this.#ensureStream(id, true);
            if (!existed) this.#queueIncomingStream(entry, true);
            entry.readable.push(new Uint8Array(data), fin);
        };
    }

    #ensureStream(id: number, bidirectional: boolean): QuicStreamEntry {
        let entry = this.#streams.get(id);
        if (!entry) {
            entry = { readable: new QuicReceiveStream(id) };
            this.#streams.set(id, entry);
        }
        if (bidirectional && !entry.writable) entry.writable = new QuicSendStream(this.#conn, id);
        return entry;
    }

    #queueIncomingStream(entry: QuicStreamEntry, bidirectional: boolean) {
        if (entry.incomingQueued) return;
        entry.incomingQueued = true;
        if (bidirectional) {
            const writable = entry.writable;
            if (!writable) throw new Error("QUIC bidirectional stream is missing writable side");
            this.#bidiController?.enqueue({
                readable: entry.readable,
                writable,
            });
        } else {
            this.#uniController?.enqueue(entry.readable);
        }
    }

    close(info?: Deno.QuicCloseInfo): void {
        this.#conn.close(info?.closeCode ?? 0, info?.reason ?? "");
    }

    async createBidirectionalStream(): Promise<Deno.QuicBidirectionalStream> {
        const id = this.#conn.openStream(true);
        const entry = this.#ensureStream(id, true);
        const writable = entry.writable;
        if (!writable) throw new Error("QUIC bidirectional stream is missing writable side");
        return { readable: entry.readable, writable };
    }

    async createUnidirectionalStream(): Promise<Deno.QuicSendStream> {
        const id = this.#conn.openStream(false);
        return new QuicSendStream(this.#conn, id) as Deno.QuicSendStream;
    }

    async sendDatagram(data: Uint8Array): Promise<void> {
        this.#conn.sendDatagram(bytesToArrayBuffer(data));
    }

    async readDatagram(): Promise<Uint8Array<ArrayBuffer>> {
        const datagram = this.#datagrams.shift();
        if (datagram) return datagram;
        return await new Promise((resolve) => this.#datagramWaiters.push(resolve));
    }
}

class QuicIncomingImpl implements Deno.QuicIncoming {
    readonly localIp = "0.0.0.0";
    readonly remoteAddressValidated = true;
    readonly remoteAddr: Deno.NetAddr;
    #conn: QuicConnImpl;

    constructor(conn: QuicConnImpl) {
        this.#conn = conn;
        this.remoteAddr = conn.remoteAddr;
    }

    accept<ZRTT extends boolean>(): ZRTT extends true ? Deno.QuicConn : Promise<Deno.QuicConn> {
        return Promise.resolve(this.#conn) as ZRTT extends true ? Deno.QuicConn : Promise<Deno.QuicConn>;
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

    constructor(endpoint: QuicEndpointImpl, socket: CModuleExternalQuic.Socket) {
        this.endpoint = endpoint;
        socket.onconnection = (nativeConn: CModuleExternalQuic.Connection) => {
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
        this.#stopped = true;
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

    constructor(options: Deno.QuicEndpointOptions = {}) {
        this.addr = {
            transport: "udp",
            hostname: options.hostname ?? "0.0.0.0",
            port: options.port ?? 0,
        };
    }

    listen(options: Deno.QuicListenOptions): Deno.QuicListener {
        this.alpn = firstAlpn(options.alpnProtocols);
        this.socket = new nativeQuic.Socket({
            isServer: true,
            host: this.addr.hostname,
            port: this.addr.port,
            cert: options.cert,
            key: options.key,
            alpn: this.alpn,
        });
        return new QuicListenerImpl(this, this.socket);
    }

    close(): void {
        if (this.socket) {
            closeQuicSocketQuietly(this.socket);
            this.socket = undefined;
        }
    }
}

function connectQuic(options: Deno.ConnectQuicOptions<boolean>): Promise<Deno.QuicConn> {
    const endpoint = options.endpoint as QuicEndpointImpl | undefined ?? new QuicEndpointImpl();
    endpoint.alpn = firstAlpn(options.alpnProtocols);
    endpoint.socket ??= new nativeQuic.Socket({
        host: endpoint.addr.hostname,
        port: endpoint.addr.port,
        alpn: endpoint.alpn,
    });
    const nativeConn = endpoint.socket.connect(options.hostname, options.port);
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
