import { Buffer } from 'node:buffer';
import { arrayBufferBackedBytes, bytesToArrayBuffer, sanitizeSurrogates } from '../utils/bytes';
import { normalizeTlsOptions, type BunTlsConfig } from './tls';

const engine = import.meta.use('engine');
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const arrayBufferIsView = ArrayBuffer.isView;
const emptyBytes = new Uint8Array(0);

type BinaryType = 'arraybuffer' | 'buffer' | 'uint8array';

export type BunSocketData = string | ArrayBufferView | ArrayBufferLike;

export interface BunSocketHandler {
    /**
     * Handlers run detached: an awaited write inside an async handler can
     * observe an already-closed socket, like Bun's fire-and-forget events.
     */
    open?(socket: BunSocket): void | Promise<void>;
    /** Called after the socket closes; receives the close error when one caused it. */
    close?(socket: BunSocket, error?: Error): void | Promise<void>;
    /** Called when a handler throws or the connection fails mid-stream. */
    error?(socket: BunSocket, error: Error): void | Promise<void>;
    /** Called for each chunk from the peer, converted per `binaryType`. */
    data?(socket: BunSocket, data: ArrayBuffer | Buffer | Uint8Array<ArrayBuffer>): void | Promise<void>;
    /**
     * Called when the pending write queue empties. This runtime has no
     * kernel-level backpressure signal, so every batch completion reports
     * here rather than only after real socket-buffer saturation.
     */
    drain?(socket: BunSocket): void | Promise<void>;
    /** Called when the peer shuts down its write side (TCP FIN). */
    end?(socket: BunSocket): void | Promise<void>;
    /**
     * Called when connection establishment fails. Bun.connect always rejects
     * afterwards; with this handler installed the rejection is expected to be
     * awaited or caught by the caller.
     */
    connectError?(socket: BunSocket, error: Error): void | Promise<void>;
    handshake?(socket: BunSocket, success: boolean, authorizationError: Error | null): void | Promise<void>;
    /** Chunk type passed to data(); defaults to "buffer". */
    binaryType?: BinaryType;
}

export interface BunSocket {
    /** The per-instance context from the options object. */
    data: unknown;
    readonly remoteFamily: 'IPv4' | 'IPv6' | undefined;
    readonly remoteAddress: string | undefined;
    readonly remotePort: number | undefined;
    readonly localFamily: 'IPv4' | 'IPv6' | undefined;
    readonly localAddress: string | undefined;
    readonly localPort: number | undefined;
    /** -2 shutdown, -1 closed/detached, 0 pending, 1 established. */
    readonly readyState: -2 | -1 | 0 | 1 | 2;
    readonly listener?: BunSocketListener;
    readonly authorized: boolean;
    readonly alpnProtocol: string | false;
    getAuthorizationError(): Error | null;
    write(data: BunSocketData, byteOffset?: number, byteLength?: number): number;
    end(data?: BunSocketData, byteOffset?: number, byteLength?: number): number;
    /** Flushes are implicit in this runtime; retained for call compatibility. */
    flush(): void;
    /**
     * Write-side FIN by default. `shutdown(true)` (stop receiving) terminates
     * the whole connection in this runtime: the host read-cancel closes the
     * pipe in both directions. Documented Bun deviation.
     */
    shutdown(halfClose?: boolean): void;
    terminate(): void;
    reload(options: { socket: BunSocketHandler }): void;
    ref(): void;
    unref(): void;
    [Symbol.dispose](): void;
}

export interface BunSocketListener {
    readonly port: number | undefined;
    readonly hostname: string | undefined;
    readonly unix: string | undefined;
    data: unknown;
    /** Closes the listener; live connections drain unless told not to. */
    stop(closeActiveConnections?: boolean): void;
    /** Replaces handlers for connections accepted after the call. */
    reload(options: { socket: BunSocketHandler }): void;
    ref(): void;
    unref(): void;
    [Symbol.dispose](): void;
}

export interface BunTcpSocketListener extends BunSocketListener {
    readonly port: number;
    readonly hostname: string;
    readonly unix: undefined;
}

export interface BunUnixSocketListener extends BunSocketListener {
    readonly unix: string;
    readonly port: undefined;
    readonly hostname: undefined;
}

interface BunSocketOptions {
    socket: BunSocketHandler;
    data?: unknown;
    allowHalfOpen?: boolean;
    tls?: boolean | import('bun').TLSOptions;
}

export interface BunTcpSocketOptions extends BunSocketOptions {
    hostname: string;
    port: number;
    unix?: undefined;
}

export interface BunUnixSocketOptions extends BunSocketOptions {
    unix: string;
    hostname?: string;
    port?: number;
}

export type BunConnectOptions = BunTcpSocketOptions | BunUnixSocketOptions;
export type BunListenOptions = BunTcpSocketOptions | BunUnixSocketOptions;

type HostEndpoint =
    | { transport: 'tcp'; hostname: string; port: number }
    | { transport: 'unix'; path: string };

interface HostAddr {
    hostname?: string;
    port?: number;
    transport?: string;
}

interface HostConn {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly remoteAddr?: HostAddr;
    readonly localAddr?: HostAddr;
    close(): void | Promise<void>;
    closeWrite(): Promise<void>;
    ref(): void;
    unref(): void;
}

interface HostTlsConn extends HostConn {
    handshake(): Promise<{ alpnProtocol?: string | null }>;
}

interface HostListener {
    readonly addr?: HostAddr;
    [Symbol.asyncIterator](): AsyncIterableIterator<HostConn>;
    close(): void;
    ref(): void;
    unref(): void;
}

interface HostDeno {
    connect(options: HostEndpoint): Promise<HostConn>;
    connectTls(options: { hostname: string; port: number } & BunTlsConfig): Promise<HostTlsConn>;
    listen(options: HostEndpoint): HostListener;
}

const CONNECT_OPTIONS = ['hostname', 'port', 'unix', 'socket', 'data', 'allowHalfOpen'] as const;
const UNSUPPORTED_OPTION_DETAILS: Record<string, string> = {
    tls: 'TLS is not supported by this adapter.',
    fd: 'file descriptors are not supported by this adapter.',
    reusePort: 'socket reuse options are not supported by this adapter.',
    exclusive: 'exclusive-bind options are not supported by this adapter.',
    ipv6Only: 'ipv6Only is not supported by this adapter.',
};

function hostRuntime(): HostDeno {
    const runtime = (globalThis as unknown as { Deno?: Partial<HostDeno> }).Deno;
    if (!runtime || typeof runtime.connect !== 'function' || typeof runtime.listen !== 'function') {
        throw new Error('Bun.connect/listen require the host Deno net primitives.');
    }
    return runtime as HostDeno;
}

function asError(value: unknown): Error {
    if (value instanceof Error) return value;
    return new Error(typeof value === 'string' ? value : 'socket error', { cause: value });
}

function addressOf(addr: HostAddr | undefined, transport = addr?.transport): { family: 'IPv4' | 'IPv6'; address: string; port: number } | undefined {
    if (transport === 'unix') return undefined;
    const address = typeof addr?.hostname === 'string' && addr.hostname.length > 0 ? addr.hostname : '';
    return {
        family: address.includes(':') ? 'IPv6' : 'IPv4',
        address,
        port: typeof addr?.port === 'number' ? addr.port : 0,
    };
}

function parseSocketOptions(options: unknown, label: string): {
    handlers: BunSocketHandler;
    data: unknown;
    allowHalfOpen: boolean;
} {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError(`${label}: options must be an object`);
    }
    const record = options as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(record)) {
        const name = String(key);
        if (name === 'tls' && (label === 'Bun.connect' || record[key] === false)) continue;
        if (CONNECT_OPTIONS.includes(name as typeof CONNECT_OPTIONS[number])) continue;
        const detail = UNSUPPORTED_OPTION_DETAILS[name];
        throw new TypeError(detail ? `${label}: unsupported option "${name}". ${detail}` : `${label}: unsupported option "${name}"`);
    }

    const handlers = record.socket;
    if (handlers === null || typeof handlers !== 'object' || Array.isArray(handlers)) {
        throw new TypeError(`${label}: socket must be an object with handlers`);
    }
    const binaryType = (handlers as BunSocketHandler).binaryType;
    if (binaryType !== undefined && binaryType !== 'arraybuffer' && binaryType !== 'buffer' && binaryType !== 'uint8array') {
        throw new TypeError(`${label}: socket.binaryType must be "arraybuffer", "buffer", or "uint8array"`);
    }
    const allowHalfOpen = record.allowHalfOpen ?? false;
    if (typeof allowHalfOpen !== 'boolean') throw new TypeError(`${label}: allowHalfOpen must be a boolean`);
    return { handlers: handlers as BunSocketHandler, data: record.data, allowHalfOpen };
}

function parseReloadHandlers(options: unknown, label: string): BunSocketHandler {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError(`${label}: reload requires a socket handlers object`);
    }
    // Bun reads only `socket`: extra keys do not trigger ownKeys/descriptor traps.
    const handlers = (options as { socket?: unknown }).socket;
    if (handlers === null || typeof handlers !== 'object' || Array.isArray(handlers)) {
        throw new TypeError(`${label}: reload requires a socket handlers object`);
    }
    const binaryType = (handlers as BunSocketHandler).binaryType;
    if (binaryType !== undefined && binaryType !== 'arraybuffer' && binaryType !== 'buffer' && binaryType !== 'uint8array') {
        throw new TypeError(`${label}: reload socket.binaryType must be "arraybuffer", "buffer", or "uint8array"`);
    }
    return handlers as BunSocketHandler;
}

function parsePort(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 65535) {
        throw new RangeError(`${label} must be an integer from 0 through 65535`);
    }
    return value;
}

function parseHostname(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function parseEndpoint(options: BunConnectOptions | BunListenOptions, label: string): HostEndpoint {
    if (options.unix !== undefined) {
        if (typeof options.unix !== 'string' || options.unix.length === 0) {
            throw new TypeError(`${label}: unix must be a non-empty string`);
        }
        if (options.unix.includes('\0')) {
            throw new TypeError(`${label}: abstract Unix sockets and NUL-containing paths are unsupported`);
        }
        return { transport: 'unix', path: options.unix };
    }
    return {
        transport: 'tcp',
        hostname: parseHostname(options.hostname, `${label}: hostname`),
        port: parsePort(options.port, `${label}: port`),
    };
}

function viewBytes(data: ArrayBufferView): Uint8Array<ArrayBufferLike> {
    try {
        const buffer = Reflect.apply(typedArrayBuffer, data, []);
        const byteOffset = Reflect.apply(typedArrayByteOffset, data, []);
        const byteLength = Reflect.apply(typedArrayByteLength, data, []);
        return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
    } catch {
        try {
            const buffer = Reflect.apply(dataViewBuffer, data, []);
            const byteOffset = Reflect.apply(dataViewByteOffset, data, []);
            const byteLength = Reflect.apply(dataViewByteLength, data, []);
            return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
        } catch {
            // Bun accepts detached views as empty writes.
            return emptyBytes;
        }
    }
}

/** Applies write() byteOffset/byteLength and converts strings to UTF-8 bytes. */
function writeBytes(data: BunSocketData, byteOffset?: number, byteLength?: number): Uint8Array<ArrayBuffer> {
    if (typeof data === 'string') {
        // Bun ignores byteOffset/byteLength for strings.
        return arrayBufferBackedBytes(engine.encodeString(sanitizeSurrogates(data)));
    }
    let bytes: Uint8Array;
    if (arrayBufferIsView(data)) {
        bytes = viewBytes(data);
    } else if (engine.isArrayBuffer(data)) {
        bytes = new Uint8Array(data);
    } else {
        throw new TypeError('Bun.connect: socket data must be a string, ArrayBuffer, or view');
    }
    const start = byteOffset === undefined ? 0 : byteOffset;
    const end = byteLength === undefined ? bytes.byteLength : start + byteLength;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > bytes.byteLength) {
        throw new RangeError('byteOffset/byteLength are out of bounds for the given data');
    }
    return arrayBufferBackedBytes(bytes.subarray(start, end));
}

function convertChunk(chunk: Uint8Array, binaryType: BinaryType): ArrayBuffer | Buffer | Uint8Array<ArrayBuffer> {
    switch (binaryType) {
        case 'arraybuffer':
            return bytesToArrayBuffer(chunk);
        case 'uint8array':
            return arrayBufferBackedBytes(chunk);
        case 'buffer':
            return Buffer.from(chunk);
    }
}

class BunSocketImpl implements BunSocket {
    #data: unknown;
    #boundListener: BunSocketListener | undefined;
    #conn: HostConn | undefined;
    #handlers: BunSocketHandler;
    #binaryType: BinaryType;
    readonly #transport: HostEndpoint['transport'];
    readonly #allowHalfOpen: boolean;
    #writeEnded = false;
    #writeClosed = false;
    #readCancelled = false;
    #closed = false;
    #closeWhenDrained = false;
    #pendingWrites = 0;
    #writeWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
    #tls = false;
    #authorized = false;
    #alpnProtocol: string | false = false;
    #authorizationError: Error | null = null;
    #teardownStarted = false;
    readonly #activeSockets: Set<BunSocketImpl> | undefined;

    constructor(params: {
        handlers: BunSocketHandler;
        data: unknown;
        allowHalfOpen: boolean;
        transport: HostEndpoint['transport'];
        conn?: HostConn;
        listener?: BunSocketListener;
        activeSockets?: Set<BunSocketImpl>;
    }) {
        this.#conn = params.conn;
        this.#handlers = params.handlers;
        this.#data = params.data;
        this.#allowHalfOpen = params.allowHalfOpen;
        this.#transport = params.transport;
        this.#boundListener = params.listener;
        this.#activeSockets = params.activeSockets;
        this.#binaryType = params.handlers.binaryType ?? 'buffer';
    }

    static attach(socket: BunSocketImpl, conn: HostConn, tls = false): void {
        socket.#attach(conn, tls);
    }

    static invoke(socket: BunSocketImpl, event: string, ...args: unknown[]): void {
        socket.#invoke(event, ...args);
    }

    static dispose(socket: BunSocketImpl): void {
        void socket.#conn;
        socket.end();
    }

    get data(): unknown {
        return this.#data;
    }

    set data(value: unknown) {
        this.#data = value;
    }

    get remoteFamily(): 'IPv4' | 'IPv6' | undefined {
        return addressOf(this.#conn?.remoteAddr, this.#transport)?.family;
    }

    get remoteAddress(): string | undefined {
        return addressOf(this.#conn?.remoteAddr, this.#transport)?.address;
    }

    get remotePort(): number | undefined {
        return addressOf(this.#conn?.remoteAddr, this.#transport)?.port;
    }

    get localFamily(): 'IPv4' | 'IPv6' | undefined {
        return addressOf(this.#conn?.localAddr, this.#transport)?.family;
    }

    get localAddress(): string | undefined {
        return addressOf(this.#conn?.localAddr, this.#transport)?.address;
    }

    get localPort(): number | undefined {
        return addressOf(this.#conn?.localAddr, this.#transport)?.port;
    }

    get readyState(): -2 | -1 | 0 | 1 | 2 {
        if (this.#closed) return -1;
        if (this.#writeEnded || this.#readCancelled) return -2;
        return this.#conn ? 1 : 0;
    }

    get listener(): BunSocketListener | undefined {
        return this.#boundListener;
    }

    get authorized(): boolean {
        return this.#authorized;
    }

    get alpnProtocol(): string | false {
        return this.#alpnProtocol;
    }

    getAuthorizationError(): Error | null {
        return this.#authorizationError;
    }

    get [Symbol.toStringTag](): string {
        return this.#tls ? 'TLSSocket' : 'TCPSocket';
    }

    write(data: BunSocketData, byteOffset?: number, byteLength?: number): number {
        if (!this.#conn || this.#closed || this.#writeEnded) return -1;
        const bytes = writeBytes(data, byteOffset, byteLength);
        this.#pendingWrites++;
        try {
            this.#writer().write(bytes).then(
                () => {
                    this.#pendingWrites--;
                    if (this.#pendingWrites === 0) {
                        if (this.#closeWhenDrained) this.#finishClose();
                        else if (this.#writeEnded) this.#closeWriteSideWhenDrained();
                        else this.#invoke('drain');
                    }
                },
                error => {
                    // A failed write must not wedge a deferred close.
                    this.#pendingWrites--;
                    this.#fail(asError(error));
                },
            );
        } catch (error) {
            // A synchronously throwing host stream must not wedge the counter.
            this.#pendingWrites--;
            this.#fail(asError(error));
        }
        return bytes.byteLength;
    }

    end(data?: BunSocketData, byteOffset?: number, byteLength?: number): number {
        if (!this.#conn || this.#closed || this.#writeEnded) return -1;
        const written = data === undefined ? 0 : this.write(data, byteOffset, byteLength);
        this.#writeEnded = true;
        this.#closeWriteSideWhenDrained();
        return written;
    }

    flush(): void {
        void this.#conn;
        // Writes flow through the stream writer immediately; nothing to flush.
    }

    shutdown(halfClose?: boolean): void {
        if (halfClose === true) {
            // The host read-cancel closes the whole pipe, so stopping the read
            // side terminates the connection here; a documented Bun deviation.
            // The close event still fires, matching Bun's close contract.
            if (!this.#conn || this.#readCancelled || this.#closed) return;
            this.#readCancelled = true;
            this.#markClosed();
            this.#invoke('close');
            void this.#conn.readable.cancel().catch(() => {});
            this.#teardown();
            return;
        }
        if (!this.#conn || this.#writeEnded || this.#closed) return;
        this.#writeEnded = true;
        this.#closeWriteSideWhenDrained();
    }

    terminate(): void {
        if (this.#closed) return;
        this.#readCancelled = true;
        this.#markClosed();
        this.#invoke('close');
        void this.#conn?.readable.cancel().catch(() => {});
        this.#teardown();
    }

    reload(options: { socket: BunSocketHandler }): void {
        const handlers = parseReloadHandlers(options, 'Bun.Socket');
        this.#handlers = handlers;
        this.#binaryType = handlers.binaryType ?? 'buffer';
    }

    ref(): void {
        if (!this.#closed) this.#conn?.ref();
    }

    unref(): void {
        if (!this.#closed) this.#conn?.unref();
    }

    [Symbol.dispose](_value?: unknown): void {
        BunSocketImpl.dispose(this);
    }

    #attach(conn: HostConn, tls: boolean): void {
        this.#conn = conn;
        this.#tls = tls;
        this.#activeSockets?.add(this);
        if (!tls) {
            void this.#readLoop();
            this.#invoke('open');
            return;
        }
        let hasHandshake: boolean;
        try {
            hasHandshake = typeof Reflect.get(this.#handlers, 'handshake') === 'function';
        } catch (error) {
            void (conn as HostTlsConn).handshake().catch(() => {});
            this.#fail(asError(error));
            return;
        }
        void (conn as HostTlsConn).handshake().then(info => {
            if (this.#closed) return;
            this.#authorized = true;
            this.#alpnProtocol = info.alpnProtocol || false;
            this.#invoke(hasHandshake ? 'handshake' : 'open', true, null);
            if (!this.#closed) void this.#readLoop();
        }, error => {
            if (this.#closed) return;
            this.#authorizationError = asError(error);
            this.#invoke(hasHandshake ? 'handshake' : 'open', false, this.#authorizationError);
            this.#finishClose();
        });
        if (hasHandshake) this.#invoke('open');
    }

    #writer(): WritableStreamDefaultWriter<Uint8Array> {
        if (!this.#writeWriter) this.#writeWriter = this.#conn!.writable.getWriter();
        return this.#writeWriter;
    }

    /**
     * Sends FIN once buffered writes settle. The stream writer's close()
     * closes the whole pipe in both directions, so the write half-close goes
     * through the conn's shutdown instead.
     */
    #closeWriteSideWhenDrained(): void {
        if (!this.#conn || this.#writeClosed || this.#closed || this.#pendingWrites > 0) return;
        this.#writeClosed = true;
        void this.#conn.closeWrite().catch(error => {
            // A half-close that fails leaves the connection unusable.
            if (!this.#closed) this.#fail(asError(error));
        });
    }

    async #readLoop(): Promise<void> {
        const conn = this.#conn;
        if (!conn) return;
        try {
            for await (const chunk of conn.readable) {
                if (this.#closed) return;
                this.#invoke('data', convertChunk(chunk, this.#binaryType));
            }
            // A local cancel (shutdown(true)/terminate) ends the loop too; the
            // end event is reserved for the peer's FIN.
            if (this.#closed || this.#readCancelled) return;
            this.#invoke('end');
            if (!this.#allowHalfOpen) this.#closeAfterStream();
        } catch (error) {
            if (this.#closed) return;
            this.#fail(asError(error));
        }
    }

    #fail(error: Error): void {
        if (this.#closed) return;
        this.#markClosed();
        this.#invoke('error', error);
        this.#invoke('close', error);
        this.#teardown();
    }

    #closeAfterStream(): void {
        if (this.#closed) return;
        // Pending writes still drain on the graceful read-EOF close; only
        // failure paths abort them.
        if (this.#pendingWrites > 0) {
            this.#closeWhenDrained = true;
            return;
        }
        this.#finishClose();
    }

    #finishClose(): void {
        if (this.#closed) return;
        this.#markClosed();
        this.#invoke('close');
        this.#teardown();
    }

    /** Event handlers observe the closed state; teardown follows delivery. */
    #markClosed(): void {
        this.#closed = true;
        this.#writeEnded = true;
    }

    #teardown(): void {
        if (this.#teardownStarted) return;
        this.#teardownStarted = true;
        // Discard queued writes and release the writer lock with the pipe.
        void this.#writeWriter?.abort().catch(() => {});
        try {
            const closing = this.#conn?.close();
            if (closing) void Promise.resolve(closing).catch(() => {});
        } catch {
            // The host may have already torn the conn down with the streams.
        }
        this.#activeSockets?.delete(this);
    }

    /** Dispatches host events from connect/listen without exposing it on BunSocket. */
    #invoke(event: string, ...args: unknown[]): void {
        // error/connectError failures are themselves fatal: the handler got
        // its event, so routing the failure back would loop.
        const loud = event === 'error' || event === 'connectError';
        let handler: ((socket: BunSocket, ...handlerArgs: unknown[]) => unknown) | undefined;
        try {
            handler = Reflect.get(this.#handlers, event) as
                | ((socket: BunSocket, ...handlerArgs: unknown[]) => unknown)
                | undefined;
        } catch (error) {
            // A hostile handlers object must not escape the socket's routing.
            if (loud) queueMicrotask(() => {
                throw error;
            });
            else this.#routeHandlerError(asError(error));
            return;
        }
        if (!handler) {
            if (event === 'error') {
                // Bun surfaces unhandled socket errors loudly; so do we.
                queueMicrotask(() => {
                    throw args[0];
                });
            }
            return;
        }
        let result: unknown;
        try {
            result = Reflect.apply(handler, undefined, [this, ...args]);
        } catch (error) {
            if (loud) queueMicrotask(() => {
                throw error;
            });
            else this.#routeHandlerError(asError(error));
            return;
        }
        if (result instanceof Promise) {
            if (loud) {
                result.then(() => {}, failure => {
                    queueMicrotask(() => {
                        throw asError(failure);
                    });
                });
            } else {
                result.then(() => {}, error => this.#routeHandlerError(asError(error)));
            }
        }
    }

    #routeHandlerError(error: Error): void {
        if (this.#closed) {
            // The close path already ran; a late handler failure is fatal.
            queueMicrotask(() => {
                throw error;
            });
            return;
        }
        // A handler error always ends the connection; the error event reports it.
        this.#fail(error);
    }
}

const socketPrototype = BunSocketImpl.prototype;
delete (socketPrototype as { constructor?: unknown }).constructor;
for (const key of [
    'data', 'remoteFamily', 'remoteAddress', 'remotePort', 'localFamily', 'localAddress', 'localPort',
    'authorized', 'alpnProtocol', 'getAuthorizationError',
    'readyState', 'listener', 'write', 'end', 'flush', 'shutdown', 'terminate', 'reload', 'ref', 'unref',
]) {
    const descriptor = Object.getOwnPropertyDescriptor(socketPrototype, key)!;
    Object.defineProperty(socketPrototype, key, { ...descriptor, configurable: false, enumerable: true });
}
Object.defineProperties(socketPrototype, {
    [Symbol.dispose]: {
        value: function dispose(this: BunSocketImpl, _value?: unknown): void {
            // Bun's `using` disposal is a graceful end, not an abrupt close.
            BunSocketImpl.dispose(this);
        },
        configurable: true,
        enumerable: false,
        writable: false,
    },
});

class BunSocketListenerImpl implements BunSocketListener {
    readonly #hostListener: HostListener;
    readonly #boundAddress: ReturnType<typeof addressOf>;
    readonly #endpoint: HostEndpoint;
    #data: unknown;
    readonly #allowHalfOpen: boolean;
    #handlers: BunSocketHandler;
    #closed = false;
    readonly #activeSockets = new Set<BunSocketImpl>();

    constructor(params: {
        hostListener: HostListener;
        endpoint: HostEndpoint;
        data: unknown;
        allowHalfOpen: boolean;
        handlers: BunSocketHandler;
    }) {
        this.#hostListener = params.hostListener;
        this.#boundAddress = addressOf(params.hostListener.addr);
        this.#endpoint = params.endpoint;
        this.#data = params.data;
        this.#allowHalfOpen = params.allowHalfOpen;
        this.#handlers = params.handlers;
        void this.#acceptConnections();
    }

    static dispose(listener: BunSocketListenerImpl): void {
        void listener.#hostListener;
        listener.stop();
    }

    get port(): number | undefined {
        return this.#endpoint.transport === 'tcp' ? this.#boundAddress?.port ?? this.#endpoint.port : undefined;
    }

    get hostname(): string | undefined {
        return this.#endpoint.transport === 'tcp' ? this.#boundAddress?.address || this.#endpoint.hostname : undefined;
    }

    get unix(): string | undefined {
        return this.#endpoint.transport === 'unix' ? this.#endpoint.path : undefined;
    }

    get data(): unknown {
        return this.#data;
    }

    set data(value: unknown) {
        this.#data = value;
    }

    stop(closeActiveConnections?: boolean): void {
        if (closeActiveConnections !== undefined && typeof closeActiveConnections !== 'boolean') {
            throw new TypeError('Bun.listen: stop() expects a boolean when an argument is provided');
        }
        if (!this.#closed) {
            this.#closed = true;
            this.#hostListener.close();
        }
        if (closeActiveConnections === true) {
            for (const socket of this.#activeSockets) socket.terminate();
        }
    }

    reload(options: { socket: BunSocketHandler }): void {
        this.#handlers = parseReloadHandlers(options, 'Bun.listen');
    }

    ref(): void {
        if (!this.#closed) this.#hostListener.ref();
    }

    unref(): void {
        if (!this.#closed) this.#hostListener.unref();
    }

    [Symbol.dispose](_value?: unknown): void {
        BunSocketListenerImpl.dispose(this);
    }

    async #acceptConnections(): Promise<void> {
        try {
            for await (const conn of this.#hostListener) {
                const socket = new BunSocketImpl({
                    conn,
                    handlers: this.#handlers,
                    data: this.#data,
                    allowHalfOpen: this.#allowHalfOpen,
                    transport: this.#endpoint.transport,
                    listener: this,
                    activeSockets: this.#activeSockets,
                });
                BunSocketImpl.attach(socket, conn);
            }
        } catch (error) {
            if (!this.#closed) {
                queueMicrotask(() => {
                    throw error;
                });
            }
        }
    }
}

const listenerPrototype = BunSocketListenerImpl.prototype;
delete (listenerPrototype as { constructor?: unknown }).constructor;
for (const key of ['port', 'hostname', 'unix', 'data', 'stop', 'reload', 'ref', 'unref']) {
    const descriptor = Object.getOwnPropertyDescriptor(listenerPrototype, key)!;
    Object.defineProperty(listenerPrototype, key, { ...descriptor, configurable: false, enumerable: true });
}
Object.defineProperties(listenerPrototype, {
    [Symbol.dispose]: {
        value: function dispose(this: BunSocketListenerImpl, _value?: unknown): void {
            BunSocketListenerImpl.dispose(this);
        },
        configurable: true,
        enumerable: false,
        writable: false,
    },
    [Symbol.toStringTag]: { value: 'Listener', configurable: true },
});

export async function connect(options: BunConnectOptions): Promise<BunSocket> {
    const parsed = parseSocketOptions(options, 'Bun.connect');
    const endpoint = parseEndpoint(options, 'Bun.connect');
    const tls = normalizeTlsOptions(options.tls, 'client');
    if (tls && endpoint.transport !== 'tcp') throw new TypeError('Bun.connect: TLS over Unix sockets is not supported');
    if (tls?.servername !== undefined && endpoint.transport === 'tcp') {
        const hostname = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (tls.servername.replace(/^\[|\]$/g, '').toLowerCase() !== hostname) {
            throw new TypeError('Bun.connect: TLS serverName must match hostname on this host');
        }
    }
    const runtime = hostRuntime();

    const socket = new BunSocketImpl({
        handlers: parsed.handlers,
        data: parsed.data,
        allowHalfOpen: parsed.allowHalfOpen,
        transport: endpoint.transport,
    });

    let conn: HostConn;
    try {
        if (tls && endpoint.transport === 'tcp') {
            if (typeof runtime.connectTls !== 'function') throw new Error('Bun.connect: the host does not provide TLS connections');
            if (tls.caCerts === undefined) {
                const { effectiveDefaultCACertificates } = await import('../node/tls/_shared');
                tls.caCerts = effectiveDefaultCACertificates();
            }
            conn = await runtime.connectTls({ ...tls, hostname: endpoint.hostname, port: endpoint.port });
        } else {
            conn = await runtime.connect(endpoint);
        }
    } catch (error) {
        const normalized = asError(error);
        BunSocketImpl.invoke(socket, 'connectError', normalized);
        throw normalized;
    }
    BunSocketImpl.attach(socket, conn, tls !== undefined);
    return socket;
}

export function listen(options: BunTcpSocketOptions): BunTcpSocketListener;
export function listen(options: BunUnixSocketOptions): BunUnixSocketListener;
export function listen(options: BunListenOptions): BunTcpSocketListener | BunUnixSocketListener;
export function listen(options: BunListenOptions): BunTcpSocketListener | BunUnixSocketListener {
    const parsed = parseSocketOptions(options, 'Bun.listen');
    const endpoint = parseEndpoint(options, 'Bun.listen');
    const runtime = hostRuntime();
    const hostListener = runtime.listen(endpoint);
    return new BunSocketListenerImpl({
        hostListener,
        endpoint,
        data: parsed.data,
        allowHalfOpen: parsed.allowHalfOpen,
        handlers: parsed.handlers,
    }) as BunTcpSocketListener | BunUnixSocketListener;
}
