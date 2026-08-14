/**
 * node:net type definitions.
 *
 * Types only — no runtime code, no native modules, so importing this file
 * cannot affect module evaluation order. The `Socket` / `Server` interfaces
 * here are the *shapes*; the merged type+value declarations that consumers see
 * as `net.Socket` / `net.Server` live next to their implementations in
 * ./socket and ./server.
 */

import type { EventEmitter } from '../events';
import type { Duplex } from '../stream';

export interface AddressInfo {
    address: string;
    family: string;
    port: number;
}

export interface SocketConstructorOpts {
    fd?: number;
    allowHalfOpen?: boolean;
    readable?: boolean;
    writable?: boolean;
    signal?: AbortSignal;
}

export interface TcpNetConnectOpts {
    port: number;
    host?: string;
    localAddress?: string;
    localPort?: number;
    family?: number;
    hints?: number;
    lookup?: (hostname: string, options: unknown, callback: (err: Error | null, address: string, family: number) => void) => void;
    noDelay?: boolean;
    keepAlive?: boolean;
    keepAliveInitialDelay?: number;
    signal?: AbortSignal;
    timeout?: number;
    onread?: {
        buffer: Uint8Array | (() => Uint8Array);
        callback: (bytesWritten: number, buffer: Uint8Array) => boolean;
    };
}

export interface IpcNetConnectOpts extends Omit<TcpNetConnectOpts, 'port'> {
    path: string;
}

export type NetConnectOpts = TcpNetConnectOpts | IpcNetConnectOpts;

export interface ServerOpts {
    allowHalfOpen?: boolean;
    pauseOnConnect?: boolean;
    signal?: AbortSignal;
    keepAlive?: boolean;
    keepAliveInitialDelay?: number;
    noDelay?: boolean;
}

export interface ListenOptions {
    port?: number;
    host?: string;
    path?: string;
    backlog?: number;
    exclusive?: boolean;
    readableAll?: boolean;
    writableAll?: boolean;
    ipv6Only?: boolean;
    signal?: AbortSignal;
}

/**
 * Raw socket handle returned by the @cnojs/http core HttpResponse.upgrade().
 * Backs a node:net Socket for the WebSocket-upgrade path so that bytes already
 * buffered by the HTTP parser (upgradeLeftover) are replayed before live reads.
 */
export interface UpgradeHandle {
    write(data: Uint8Array): Promise<void>;
    read(size?: number): Promise<Uint8Array | null>;
    onReadable(cb: (data: Uint8Array | null) => void, errHandler?: (err: Error) => void): void;
    stopReading(): void;
    close(): void;
    isClosed(): boolean;
}

/**
 * TCP handle still owned by @cnojs/http (H1 read/write). Node Socket is only a
 * metadata / destroy facade — never startRead/write on the raw handle.
 */
export interface HttpOwnedTransport {
    /** Tear down the core HTTP connection (idempotent). */
    close(): void;
}

export interface Socket extends Duplex {
    _tcp: CModuleStreams.TCP | null;
    _stream: CModuleStreams.Pipe | null;
    _upgradeHandle: UpgradeHandle | null;
    /** When set, I/O is owned by HTTP core; Socket must not touch `_tcp`. */
    _httpOwned: HttpOwnedTransport | null;
    _connecting: boolean;
    _destroyed: boolean;
    _readable: boolean;
    _writable: boolean;
    _address: AddressInfo | null;
    _remoteAddress: AddressInfo | null;
    _timeout: number | null;
    _timeoutId: ReturnType<typeof setTimeout> | null;
    _keepAlive: boolean;
    _keepAliveDelay: number;
    _noDelay: boolean;
    _readBuffer: Uint8Array;
    _allowHalfOpen: boolean;
    _peerEnded: boolean;
    _tcpReadStarted: boolean;
    _pipeReadStarted: boolean;
    _upgradeReadStarted: boolean;
    _refed: boolean;

    bytesRead: number;
    bytesWritten: number;
    connecting: boolean;
    localAddress?: string;
    localPort?: number;
    localFamily?: string;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
    readonly pending: boolean;
    timeout?: number;
    readyState: 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed';

    connect(options: NetConnectOpts, connectListener?: () => void): this;
    connect(port: number, host?: string, connectListener?: () => void): this;
    connect(path: string, connectListener?: () => void): this;

    _startPipeRead(): void;
    setEncoding(encoding?: BufferEncoding): this;
    pause(): this;
    resume(): this;
    setTimeout(timeout: number, callback?: () => void): this;
    setNoDelay(noDelay?: boolean): this;
    setKeepAlive(enable?: boolean, initialDelay?: number): this;
    address(): AddressInfo | {};
    unref(): this;
    ref(): this;
    _startTcpRead(): void;
    _startUpgradeRead(): void;
    _read(size: number): void;
    _write(chunk: string | Uint8Array, encoding: BufferEncoding, callback: (error?: Error | null) => void): void;
    destroy(error?: Error): this;
}

export interface SocketConstructor {
    new (options?: SocketConstructorOpts): Socket;
    (options?: SocketConstructorOpts): Socket;
    prototype: Socket;
    /** Build a Socket backed by a core @cnojs/http upgrade handle (WebSocket
     *  upgrade path). Reads replay any buffered upgradeLeftover bytes first. */
    fromUpgradeHandle(handle: UpgradeHandle): Socket;
    /**
     * Facade over a TCP still owned by @cnojs/http. Address metadata only;
     * destroy() closes the HTTP connection, never dual-writes the handle.
     */
    fromHttpOwned(
        tcp: CModuleStreams.TCP,
        owned: HttpOwnedTransport,
    ): Socket;
}

export interface Server extends EventEmitter {
    _tcp: CModuleStreams.TCP | null;
    _pipe: CModuleStreams.Pipe | null;
    _listening: boolean;
    _connections: Set<Socket>;
    _maxConnections: number;
    _allowHalfOpen: boolean;
    _pauseOnConnect: boolean;
    _keepAlive: boolean;
    _keepAliveDelay: number;
    _noDelay: boolean;
    _address: AddressInfo | string | null;
    _closing: boolean;
    _handleClosed: boolean;
    _closeCallbacks: Array<(err?: Error) => void>;

    maxConnections?: number;
    connections: number;
    allowHalfOpen: boolean;
    pauseOnConnect: boolean;
    readonly listening: boolean;

    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this;
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    listen(port?: number, backlog?: number, listeningListener?: () => void): this;
    listen(path: string, backlog?: number, listeningListener?: () => void): this;
    listen(options: ListenOptions, listeningListener?: () => void): this;
    listen(handle: unknown, backlog?: number, listeningListener?: () => void): this;

    _acceptLoop(): Promise<void>;
    address(): AddressInfo | string | null;
    getConnections(cb: (err: Error | null, count: number) => void): void;
    close(callback?: (err?: Error) => void): this;
    ref(): this;
    unref(): this;
}

export interface ServerConstructor {
    new (connectionListener?: (socket: Socket) => void): Server;
    new (options?: ServerOpts, connectionListener?: (socket: Socket) => void): Server;
    (connectionListener?: (socket: Socket) => void): Server;
    (options?: ServerOpts, connectionListener?: (socket: Socket) => void): Server;
    prototype: Server;
}
