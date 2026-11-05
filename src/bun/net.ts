/**
 * TCP subset of Bun.connect and Bun.listen over the host Deno net primitives.
 * Unix sockets, TLS, and socket-sharing options are rejected explicitly; the
 * per-connection Socket keeps Bun's callback contract for the events and
 * methods listed below.
 */

import { Buffer } from 'node:buffer';
import { arrayBufferBackedBytes, bytesToArrayBuffer, sanitizeSurrogates } from '../utils/bytes';

const engine = import.meta.use('engine');

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
    /** Chunk type passed to data(); defaults to "buffer". */
    binaryType?: BinaryType;
}

export interface BunSocket {
    /** The per-instance context from the options object. */
    data: unknown;
    readonly remoteFamily: 'IPv4' | 'IPv6';
    readonly remoteAddress: string;
    readonly remotePort: number;
    readonly localFamily: 'IPv4' | 'IPv6';
    readonly localAddress: string;
    readonly localPort: number;
    /** -2 shutdown, 0 closed, 1 established; detach (-1) has no TCP meaning here. */
    readonly readyState: -2 | -1 | 0 | 1 | 2;
    readonly listener?: BunTcpSocketListener;
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
    setBinaryType(type: BinaryType): void;
    ref(): void;
    unref(): void;
}

export interface BunTcpSocketListener {
    readonly port: number;
    readonly hostname: string;
    readonly data: unknown;
    /** Closes the listener; live connections drain unless told not to. */
    stop(closeActiveConnections?: boolean): void;
    /** Replaces handlers for connections accepted after the call. */
    reload(options: { socket: BunSocketHandler }): void;
    ref(): void;
    unref(): void;
}

export interface BunConnectOptions {
    hostname: string;
    port: number;
    socket: BunSocketHandler;
    /** Per-instance context exposed as socket.data. */
    data?: unknown;
    /** Keep the socket open after the peer closes its write side. */
    allowHalfOpen?: boolean;
}

export interface BunListenOptions {
    hostname: string;
    port: number;
    socket: BunSocketHandler;
    /** Per-instance context exposed as socket.data on accepted sockets. */
    data?: unknown;
    /** Keep the socket open after the peer closes its write side. */
    allowHalfOpen?: boolean;
}

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
    close(): void;
    closeWrite(): Promise<void>;
    ref(): void;
    unref(): void;
}

interface HostListener {
    readonly addr?: HostAddr;
    [Symbol.asyncIterator](): AsyncIterableIterator<HostConn>;
    close(): void;
    ref(): void;
    unref(): void;
}

interface HostDeno {
    connect(options: { hostname?: string; port?: number; transport?: string }): Promise<HostConn>;
    listen(options: { hostname?: string; port?: number; transport?: string }): HostListener;
}

const CONNECT_OPTIONS = ['hostname', 'port', 'socket', 'data', 'allowHalfOpen'] as const;
const UNSUPPORTED_OPTION_DETAILS: Record<string, string> = {
    tls: 'TLS is not part of the TCP subset.',
    unix: 'Unix sockets are not part of the TCP subset.',
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

function addressOf(addr: HostAddr | undefined): { family: 'IPv4' | 'IPv6'; address: string; port: number } {
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
        if (name === 'tls' && record[key] === false) continue; // Bun treats false as "no TLS"
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

/** Applies write() byteOffset/byteLength and converts strings to UTF-8 bytes. */
function writeBytes(data: BunSocketData, byteOffset?: number, byteLength?: number): Uint8Array<ArrayBuffer> {
    if (typeof data === 'string') {
        // Bun ignores byteOffset/byteLength for strings.
        return arrayBufferBackedBytes(engine.encodeString(sanitizeSurrogates(data)));
    }
    let bytes: Uint8Array;
    if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
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
    data: unknown;
    boundListener: BunTcpSocketListener | undefined;
    private conn: HostConn | undefined;
    private handlers: BunSocketHandler;
    private binaryType: BinaryType;
    private readonly allowHalfOpen: boolean;
    private writeEnded = false;
    private writeClosed = false;
    private readCancelled = false;
    private closed = false;
    private closeWhenDrained = false;
    private pendingWrites = 0;
    private writeWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
    private readonly activeSockets: Set<BunSocketImpl> | undefined;

    constructor(params: {
        handlers: BunSocketHandler;
        data: unknown;
        allowHalfOpen: boolean;
        conn?: HostConn;
        listener?: BunTcpSocketListener;
        activeSockets?: Set<BunSocketImpl>;
    }) {
        this.conn = params.conn;
        this.handlers = params.handlers;
        this.data = params.data;
        this.allowHalfOpen = params.allowHalfOpen;
        this.boundListener = params.listener;
        this.activeSockets = params.activeSockets;
        this.binaryType = params.handlers.binaryType ?? 'buffer';
    }

    get remoteFamily(): 'IPv4' | 'IPv6' {
        return addressOf(this.conn?.remoteAddr).family;
    }

    get remoteAddress(): string {
        return addressOf(this.conn?.remoteAddr).address;
    }

    get remotePort(): number {
        return addressOf(this.conn?.remoteAddr).port;
    }

    get localFamily(): 'IPv4' | 'IPv6' {
        return addressOf(this.conn?.localAddr).family;
    }

    get localAddress(): string {
        return addressOf(this.conn?.localAddr).address;
    }

    get localPort(): number {
        return addressOf(this.conn?.localAddr).port;
    }

    get readyState(): -2 | -1 | 0 | 1 | 2 {
        if (this.closed) return 0;
        if (this.writeEnded || this.readCancelled) return -2;
        return this.conn ? 1 : 0;
    }

    write(data: BunSocketData, byteOffset?: number, byteLength?: number): number {
        if (!this.conn || this.closed || this.writeEnded) return -1;
        const bytes = writeBytes(data, byteOffset, byteLength);
        this.pendingWrites++;
        try {
            this.writer().write(bytes).then(
                () => {
                    this.pendingWrites--;
                    if (this.pendingWrites === 0) {
                        if (this.closeWhenDrained) this.finishClose();
                        else if (this.writeEnded) this.closeWriteSideWhenDrained();
                        else this.invoke('drain');
                    }
                },
                error => {
                    // A failed write must not wedge a deferred close.
                    this.pendingWrites--;
                    this.fail(asError(error));
                },
            );
        } catch (error) {
            // A synchronously throwing host stream must not wedge the counter.
            this.pendingWrites--;
            this.fail(asError(error));
        }
        return bytes.byteLength;
    }

    end(data?: BunSocketData, byteOffset?: number, byteLength?: number): number {
        if (!this.conn || this.closed || this.writeEnded) return -1;
        const written = data === undefined ? 0 : this.write(data, byteOffset, byteLength);
        this.writeEnded = true;
        this.closeWriteSideWhenDrained();
        return written;
    }

    flush(): void {
        // Writes flow through the stream writer immediately; nothing to flush.
    }

    shutdown(halfClose?: boolean): void {
        if (halfClose === true) {
            // The host read-cancel closes the whole pipe, so stopping the read
            // side terminates the connection here; a documented Bun deviation.
            // The close event still fires, matching Bun's close contract.
            if (!this.conn || this.readCancelled || this.closed) return;
            this.readCancelled = true;
            this.markClosed();
            this.invoke('close');
            void this.conn.readable.cancel().catch(() => {});
            this.teardown();
            return;
        }
        if (!this.conn || this.writeEnded || this.closed) return;
        this.writeEnded = true;
        this.closeWriteSideWhenDrained();
    }

    terminate(): void {
        if (this.closed) return;
        this.readCancelled = true;
        this.markClosed();
        this.invoke('close');
        void this.conn?.readable.cancel().catch(() => {});
        this.teardown();
    }

    setBinaryType(type: BinaryType): void {
        if (type !== 'arraybuffer' && type !== 'buffer' && type !== 'uint8array') {
            throw new TypeError('Bun.connect: binaryType must be "arraybuffer", "buffer", or "uint8array"');
        }
        this.binaryType = type;
    }

    ref(): void {
        if (!this.closed) this.conn?.ref();
    }

    unref(): void {
        if (!this.closed) this.conn?.unref();
    }

    [Symbol.dispose](): void {
        // Bun's `using` disposal is a graceful end, not an abrupt close.
        this.end();
    }

    /** Installs the conn and starts the read pump; called once per socket. */
    attach(conn: HostConn): void {
        this.conn = conn;
        this.activeSockets?.add(this);
        void this.readLoop();
    }

    private writer(): WritableStreamDefaultWriter<Uint8Array> {
        if (!this.writeWriter) this.writeWriter = this.conn!.writable.getWriter();
        return this.writeWriter;
    }

    /**
     * Sends FIN once buffered writes settle. The stream writer's close()
     * closes the whole pipe in both directions, so the write half-close goes
     * through the conn's shutdown instead.
     */
    private closeWriteSideWhenDrained(): void {
        if (!this.conn || this.writeClosed || this.closed || this.pendingWrites > 0) return;
        this.writeClosed = true;
        void this.conn.closeWrite().catch(error => {
            // A half-close that fails leaves the connection unusable.
            if (!this.closed) this.fail(asError(error));
        });
    }

    private async readLoop(): Promise<void> {
        const conn = this.conn;
        if (!conn) return;
        try {
            for await (const chunk of conn.readable) {
                if (this.closed) return;
                this.invoke('data', convertChunk(chunk, this.binaryType));
            }
            // A local cancel (shutdown(true)/terminate) ends the loop too; the
            // end event is reserved for the peer's FIN.
            if (this.closed || this.readCancelled) return;
            this.invoke('end');
            if (!this.allowHalfOpen) this.closeAfterStream();
        } catch (error) {
            if (this.closed) return;
            this.fail(asError(error));
        }
    }

    private fail(error: Error): void {
        if (this.closed) return;
        this.markClosed();
        this.invoke('error', error);
        this.invoke('close', error);
        this.teardown();
    }

    private closeAfterStream(): void {
        if (this.closed) return;
        // Pending writes still drain on the graceful read-EOF close; only
        // failure paths abort them.
        if (this.pendingWrites > 0) {
            this.closeWhenDrained = true;
            return;
        }
        this.finishClose();
    }

    private finishClose(): void {
        if (this.closed) return;
        this.markClosed();
        this.invoke('close');
        this.teardown();
    }

    /** Event handlers observe the closed state; teardown follows delivery. */
    private markClosed(): void {
        this.closed = true;
        this.writeEnded = true;
    }

    private teardown(): void {
        // Discard queued writes and release the writer lock with the pipe.
        void this.writeWriter?.abort().catch(() => {});
        try {
            this.conn?.close();
        } catch {
            // The host may have already torn the conn down with the streams.
        }
        this.activeSockets?.delete(this);
    }

    /** Dispatches host events from connect/listen without exposing it on BunSocket. */
    invoke(event: string, ...args: unknown[]): void {
        // error/connectError failures are themselves fatal: the handler got
        // its event, so routing the failure back would loop.
        const loud = event === 'error' || event === 'connectError';
        let handler: ((socket: BunSocket, ...handlerArgs: unknown[]) => unknown) | undefined;
        try {
            handler = Reflect.get(this.handlers, event) as
                | ((socket: BunSocket, ...handlerArgs: unknown[]) => unknown)
                | undefined;
        } catch (error) {
            // A hostile handlers object must not escape the socket's routing.
            if (loud) queueMicrotask(() => {
                throw error;
            });
            else this.routeHandlerError(asError(error));
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
            else this.routeHandlerError(asError(error));
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
                result.then(() => {}, error => this.routeHandlerError(asError(error)));
            }
        }
    }

    private routeHandlerError(error: Error): void {
        if (this.closed) {
            // The close path already ran; a late handler failure is fatal.
            queueMicrotask(() => {
                throw error;
            });
            return;
        }
        // A handler error always ends the connection; the error event reports it.
        this.fail(error);
    }
}

// Bun's Socket exposes `listener` as an optional field; a prototype getter
// keeps client sockets from carrying the property as an own enumerable member.
Object.defineProperty(BunSocketImpl.prototype, 'listener', {
    get(this: BunSocketImpl) {
        return this.boundListener;
    },
    configurable: true,
    enumerable: false,
});

/** Connects a TCP client socket (Bun.connect, TCP-only subset). */
export async function connect(options: BunConnectOptions): Promise<BunSocket> {
    const parsed = parseSocketOptions(options, 'Bun.connect');
    const hostname = parseHostname(options?.hostname, 'Bun.connect: hostname');
    const port = parsePort(options?.port, 'Bun.connect: port');
    const runtime = hostRuntime();

    const socket = new BunSocketImpl({
        handlers: parsed.handlers,
        data: parsed.data,
        allowHalfOpen: parsed.allowHalfOpen,
    });

    let conn: HostConn;
    try {
        conn = await runtime.connect({ hostname, port });
    } catch (error) {
        const normalized = asError(error);
        socket.invoke('connectError', normalized);
        throw normalized;
    }
    socket.attach(conn);
    socket.invoke('open');
    return socket;
}

/** Listens for TCP connections (Bun.listen, TCP-only subset). */
export function listen(options: BunListenOptions): BunTcpSocketListener {
    const parsed = parseSocketOptions(options, 'Bun.listen');
    const hostname = parseHostname(options?.hostname, 'Bun.listen: hostname');
    const port = parsePort(options?.port, 'Bun.listen: port');
    const runtime = hostRuntime();

    const activeSockets = new Set<BunSocketImpl>();
    const hostListener = runtime.listen({ hostname, port });
    const boundAddress = addressOf(hostListener.addr);
    let currentHandlers = parsed.handlers;
    let listenerClosed = false;

    const listenerHandle: BunTcpSocketListener = {
        get port(): number {
            return boundAddress.port;
        },
        get hostname(): string {
            return boundAddress.address || hostname;
        },
        get data(): unknown {
            return parsed.data;
        },
        stop(closeActiveConnections?: boolean): void {
            if (closeActiveConnections !== undefined && typeof closeActiveConnections !== 'boolean') {
                throw new TypeError('Bun.listen: stop() expects a boolean when an argument is provided');
            }
            listenerClosed = true;
            hostListener.close();
            if (closeActiveConnections === true) {
                for (const socket of activeSockets) socket.terminate();
            }
        },
        reload(reloadOptions: { socket: BunSocketHandler }): void {
            if (reloadOptions === null || typeof reloadOptions !== 'object') {
                throw new TypeError('Bun.listen: reload requires a socket handlers object');
            }
            for (const key of Reflect.ownKeys(reloadOptions)) {
                if (key !== 'socket') {
                    throw new TypeError(`Bun.listen: reload unsupported option "${String(key)}"`);
                }
            }
            const handlers = (reloadOptions as { socket?: unknown }).socket;
            if (handlers === null || typeof handlers !== 'object') {
                throw new TypeError('Bun.listen: reload requires a socket handlers object');
            }
            const binaryType = (handlers as BunSocketHandler).binaryType;
            if (binaryType !== undefined && binaryType !== 'arraybuffer' && binaryType !== 'buffer' && binaryType !== 'uint8array') {
                throw new TypeError('Bun.listen: reload socket.binaryType must be "arraybuffer", "buffer", or "uint8array"');
            }
            currentHandlers = handlers as BunSocketHandler;
        },
        ref(): void {
            hostListener.ref();
        },
        unref(): void {
            hostListener.unref();
        },
    };

    // Accepted sockets capture the handlers current at accept time, so
    // reload() only affects connections accepted after the call.
    void (async () => {
        try {
            for await (const conn of hostListener) {
                const socket = new BunSocketImpl({
                    conn,
                    handlers: currentHandlers,
                    data: parsed.data,
                    allowHalfOpen: parsed.allowHalfOpen,
                    listener: listenerHandle,
                    activeSockets,
                });
                socket.attach(conn);
                socket.invoke('open');
            }
        } catch (error) {
            if (!listenerClosed) {
                // An accept error ends the host iterator and the listener with
                // it; surface the failure instead of dying silently.
                queueMicrotask(() => {
                    throw error;
                });
            }
        }
    })();

    return listenerHandle;
}
