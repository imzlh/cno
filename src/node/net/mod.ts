/**
 * Node.js net module
 * Based on CModuleStreams for TCP networking
 */

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const engine = import.meta.use('engine');

import { EventEmitter } from '../events';
import { Duplex, Readable, Writable } from '../stream';
import { matchesErrnoCode, normalizeErrnoError } from '../_internal/errno';

// Type definitions

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

export interface IpcNetConnectOpts extends TcpNetConnectOpts {
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

function normalizeTcpHost(host: string): string {
    if (!host || host === '*') return '0.0.0.0';
    if (host === 'localhost') return '127.0.0.1';
    return host;
}

function isUnsupportedSocketOption(error: unknown): boolean {
    return String(error && typeof error === 'object' && 'message' in error ? error.message : error)
        .includes('Not implemented');
}

function setTcpNoDelay(tcp: CModuleStreams.TCP, enabled: boolean): void {
    try { tcp.setNoDelay(enabled); }
    catch (error) { if (!isUnsupportedSocketOption(error)) throw error; }
}

function keepAliveDelayToSeconds(delayMs: number): number {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
    return Math.max(1, Math.ceil(delayMs / 1000));
}

function setTcpKeepAlive(tcp: CModuleStreams.TCP, enabled: boolean, delayMs: number): void {
    const delay = enabled ? keepAliveDelayToSeconds(delayMs) : 0;
    try { tcp.setKeepAlive(enabled, delay); }
    catch (error) { if (!isUnsupportedSocketOption(error)) throw error; }
}

function stopPipeReadQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.stopRead();
    } catch {
        // Ignore best-effort cleanup failures.
    }
}

function closeTcpQuietly(tcp: CModuleStreams.TCP): void {
    try {
        tcp.close();
    } catch {
        // Ignore best-effort cleanup failures.
    }
}

function closePipeQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.close();
    } catch {
        // Ignore best-effort cleanup failures.
    }
}

function closeUpgradeHandleQuietly(handle: UpgradeHandle): void {
    try {
        handle.close();
    } catch {
        // Ignore best-effort cleanup failures.
    }
}

function emitErrorQuietly(emitter: EventEmitter, error: Error): void {
    try {
        emitter.emit('error', error);
    } catch {
        // Preserve destroy() cleanup even if an error listener throws.
    }
}

// Flattens a prototype chain onto `target` for interop with consumers that
// expect a single-level prototype (e.g. some npm packages walk own
// properties). Must never clobber a property `target` already defines as its
// own — doing so silently overwrites intentional subclass overrides with the
// parent's version (see stream/mod.ts's flattenPrototype for the incident
// this guards against: Readable.prototype.on/once auto-resume overrides were
// being clobbered by a naive flatten call, hanging every HTTP response body).
function flattenPrototype(target: object): void {
    const parent = Object.getPrototypeOf(target);
    if (!parent || parent === Object.prototype) return;

    for (const key of Object.getOwnPropertyNames(parent)) {
        if (key === 'constructor' || Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }

    for (const key of Object.getOwnPropertySymbols(parent)) {
        if (Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }
}

// Socket

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
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
    readyState: 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed';

    connect(options: TcpNetConnectOpts, connectListener?: () => void): this;
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

type NativeReadResult = Uint8Array<ArrayBuffer> | null | undefined;
type NativeReadError = CModuleError.Error | undefined;

function initSocket(self: Socket, options?: SocketConstructorOpts): void {
    Duplex.call(self, { allowHalfOpen: options?.allowHalfOpen });

    self._tcp = null;
    self._stream = null;
    self._upgradeHandle = null;
    self._httpOwned = null;
    self._connecting = false;
    self._destroyed = false;
    self._readable = true;
    self._writable = true;
    self._address = null;
    self._remoteAddress = null;
    self._timeout = null;
    self._timeoutId = null;
    self._keepAlive = false;
    self._keepAliveDelay = 0;
    self._noDelay = false;
    self._readBuffer = new Uint8Array(65536);
    self._allowHalfOpen = options?.allowHalfOpen ?? false;
    self._peerEnded = false;
    self._tcpReadStarted = false;
    self._pipeReadStarted = false;
    self._upgradeReadStarted = false;
    self._refed = true;

    self.bytesRead = 0;
    self.bytesWritten = 0;
    self.connecting = false;
    self.readyState = 'closed';

    if (options?.fd) {
        self._tcp = new streams.TCP();
        self.readyState = 'open';
    }

    if (options?.readable === false) self._readable = false;
    if (options?.writable === false) self._writable = false;

    if (options?.signal) {
        options.signal.addEventListener('abort', () => {
            self.destroy(new Error('aborted'));
        });
    }
}

export const Socket: SocketConstructor = function Socket(this: Socket | undefined, options?: SocketConstructorOpts) {
    const target: Socket = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Socket.prototype);
    initSocket(target, options);
    return target;
} as SocketConstructor;

Object.setPrototypeOf(Socket, Duplex);
Socket.prototype = Object.create(Duplex.prototype);

Socket.fromUpgradeHandle = function fromUpgradeHandle(handle: UpgradeHandle): Socket {
    const socket = new Socket();
    socket._upgradeHandle = handle;
    socket.readyState = 'open';
    return socket;
};

Socket.fromHttpOwned = function fromHttpOwned(
    tcp: CModuleStreams.TCP,
    owned: HttpOwnedTransport,
): Socket {
    const socket = new Socket();
    const localInfo = tcp.sockname;
    const remoteInfo = tcp.peername;

    // Keep the handle for address()/ref only — never assign for stream I/O.
    socket._httpOwned = owned;
    socket.readyState = 'open';
    socket.localAddress = localInfo.ip;
    socket.localPort = localInfo.port;
    socket.remoteAddress = remoteInfo.ip;
    socket.remotePort = remoteInfo.port;
    socket.remoteFamily = `IPv${remoteInfo.family}`;
    socket._address = {
        address: localInfo.ip,
        family: `IPv${localInfo.family}`,
        port: localInfo.port,
    };
    socket._remoteAddress = {
        address: remoteInfo.ip,
        family: `IPv${remoteInfo.family}`,
        port: remoteInfo.port,
    };
    return socket;
};

function handleSocketEof(socket: Socket): void {
    if (socket._peerEnded || socket._destroyed) return;
    socket._peerEnded = true;
    socket._readableState.reading = false;
    socket.readable = false;
    socket._readable = false;
    socket._tcpReadStarted = false;
    socket._pipeReadStarted = false;
    socket._upgradeReadStarted = false;
    socket.push(null);
    if (!socket._readableState.flowing && socket._readableState.buffer.length === 0) {
        socket._emitReadableEndIfNeeded();
    }

    if (!socket._allowHalfOpen && !socket.writableEnded) {
        socket.readyState = 'readOnly';
        socket.end();
        return;
    }

    if (!socket.writableEnded) {
        socket.readyState = 'writeOnly';
        return;
    }

    socket.readyState = socket.writableFinished ? 'closed' : 'readOnly';
    if (socket.writableFinished) {
        socket.destroy();
    }
}

Socket.prototype.connect = function connect(
    this: Socket,
    portOrPath: number | string | TcpNetConnectOpts,
    hostOrCb?: string | (() => void),
    cb?: () => void
): Socket {
    let port: number | undefined;
    let host: string = 'localhost';
    let connectListener: (() => void) | undefined;

    if (typeof portOrPath === 'object') {
        port = portOrPath.port;
        host = portOrPath.host ?? 'localhost';
        connectListener = typeof hostOrCb === 'function' ? hostOrCb : undefined;
        if (portOrPath.noDelay) this._noDelay = portOrPath.noDelay;
        if (portOrPath.keepAlive) this._keepAlive = portOrPath.keepAlive;
        if (portOrPath.keepAliveInitialDelay) this._keepAliveDelay = portOrPath.keepAliveInitialDelay;
        if (portOrPath.signal) {
            portOrPath.signal.addEventListener('abort', () => {
                this.destroy(new Error('aborted'));
            });
        }
    } else if (typeof portOrPath === 'number') {
        port = portOrPath;
        if (typeof hostOrCb === 'string') {
            host = hostOrCb;
        } else if (typeof hostOrCb === 'function') {
            connectListener = hostOrCb;
        }
        if (typeof cb === 'function') {
            connectListener = cb;
        }
    } else {
        // Unix socket path
        this.connecting = true;
        this._connecting = true;
        this.readyState = 'opening';
        connectListener = typeof hostOrCb === 'function' ? hostOrCb : undefined;

        const pipe = new streams.Pipe();
        this._stream = pipe;
        pipe.connect(portOrPath).then(() => {
            this.connecting = false;
            this._connecting = false;
            this.readyState = 'open';
            this.emit('connect');
            if (connectListener) connectListener();
            if (!this._destroyed) this._startPipeRead();
        }).catch((err) => {
            this.emit('error', normalizeErrnoError(err, 'connect'));
            this.destroy();
        });
        if (!this._refed) pipe.unref();

        return this;
    }

    this.connecting = true;
    this._connecting = true;
    this.readyState = 'opening';

    host = normalizeTcpHost(host);
    const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
    const tcp = new streams.TCP(family);
    this._tcp = tcp;
    if (port === undefined) throw new TypeError('Port is required');

    if (this._noDelay) {
        setTcpNoDelay(tcp, true);
    }

    tcp.connect({ ip: host, port }).then(() => {
        this.connecting = false;
        this._connecting = false;
        this.readyState = 'open';

        const localInfo = tcp.sockname;
        this.localAddress = localInfo.ip;
        this.localPort = localInfo.port;

        const remoteInfo = tcp.peername;
        this.remoteAddress = remoteInfo.ip;
        this.remotePort = remoteInfo.port;
        this.remoteFamily = `IPv${remoteInfo.family}`;

        if (this._keepAlive) {
            setTcpKeepAlive(tcp, true, this._keepAliveDelay);
        }

        this.emit('connect');
        if (connectListener) connectListener();
        if (!this._destroyed) this._startTcpRead();
    }).catch((err) => {
        this.emit('error', normalizeErrnoError(err, 'connect'));
        this.destroy();
    });

    return this;
};

Socket.prototype._startPipeRead = function _startPipeRead(this: Socket): void {
    if (!this._stream || this._destroyed || this._pipeReadStarted) return;
    if (this._connecting) return;
    this._pipeReadStarted = true;
    this._stream.onread = (result: NativeReadResult, error: NativeReadError) => {
        if (error) {
            if ((this._destroyed || this.readyState === 'closed') && matchesErrnoCode(error, 'ECANCELED', 'EBADF')) return;
            this.emit('error', normalizeErrnoError(error, 'read'));
            return;
        }
        if (result === null || result === undefined) {
            handleSocketEof(this);
            return;
        }
        this.bytesRead += result.byteLength;
        this.push(result);
    };
    this._stream.startRead();
};

Socket.prototype.setEncoding = function setEncoding(this: Socket, encoding?: BufferEncoding): Socket {
    if (encoding) this.readableEncoding = encoding;
    return this;
};

Socket.prototype.pause = function pause(this: Socket): Socket {
    const state = this._readableState;
    if (state.flowing !== false) {
        state.flowing = false;
        this.emit('pause');
    }
    if (this._tcp) {
        this._tcp.stopRead();
        this._tcpReadStarted = false;
    }
    if (this._stream && this._pipeReadStarted) {
        stopPipeReadQuietly(this._stream);
        this._pipeReadStarted = false;
    }
    if (this._upgradeHandle) {
        this._upgradeHandle.stopReading();
        this._upgradeReadStarted = false;
    }
    return this;
};

Socket.prototype.resume = function resume(this: Socket): Socket {
    const state = this._readableState;
    if (state.readableListening && this.listenerCount('data') === 0) {
        this.emit('resume');
        this._read(state.highWaterMark);
        if (!this._httpOwned) {
            if (this._tcp) this._startTcpRead();
            if (this._upgradeHandle) this._startUpgradeRead();
            if (this._stream) this._startPipeRead();
        }
        return this;
    }
    if (!state.flowing) {
        state.flowing = true;
        this.emit('resume');
    }
    if (!this._httpOwned) {
        if (this._tcp) this._startTcpRead();
        if (this._upgradeHandle) this._startUpgradeRead();
        if (this._stream) this._startPipeRead();
    }
    queueMicrotask(() => this._duplexReadAndResolve());
    return this;
};

// NOTE: intentionally anonymous — a named function expression called
// `setTimeout` would shadow the global `setTimeout` used in the body below
// (globalThis.setTimeout is a real global in this runtime; see
// src/webapi/basic.ts), turning the timer into infinite self-recursion.
Socket.prototype.setTimeout = function (this: Socket, timeout: number, callback?: () => void): Socket {
    this._timeout = timeout;
    if (this._timeoutId) clearTimeout(this._timeoutId);
    if (timeout > 0) {
        this._timeoutId = setTimeout(() => {
            this.emit('timeout');
            if (callback) callback();
        }, timeout);
    }
    return this;
};

Socket.prototype.setNoDelay = function setNoDelay(this: Socket, noDelay?: boolean): Socket {
    this._noDelay = noDelay ?? true;
    if (this._tcp) {
        setTcpNoDelay(this._tcp, this._noDelay);
    }
    return this;
};

Socket.prototype.setKeepAlive = function setKeepAlive(this: Socket, enable?: boolean, initialDelay?: number): Socket {
    this._keepAlive = enable ?? true;
    this._keepAliveDelay = initialDelay ?? 0;
    if (this._tcp) {
        setTcpKeepAlive(this._tcp, this._keepAlive, this._keepAliveDelay);
    }
    return this;
};

Socket.prototype.address = function address(this: Socket): AddressInfo | {} {
    if (this._tcp) {
        const info = this._tcp.sockname;
        return {
            address: info.ip,
            family: `IPv${info.family}`,
            port: info.port,
        };
    }
    return this._address || {};
};

Socket.prototype.unref = function unref(this: Socket): Socket {
    this._refed = false;
    if (this._tcp) this._tcp.unref();
    if (this._stream) this._stream.unref();
    return this;
};

Socket.prototype.ref = function ref(this: Socket): Socket {
    this._refed = true;
    if (this._tcp) this._tcp.ref();
    if (this._stream) this._stream.ref();
    return this;
};

/** Sustained TCP read loop driven by Duplex _read */
Socket.prototype._startTcpRead = function _startTcpRead(this: Socket): void {
    if (!this._tcp || this._destroyed) return;
    // Duplex _read can be pulled before connect() resolves, racing the
    // post-connect resume(). startRead() on an unconnected handle throws
    // ENOTCONN — bail while still connecting; resume() starts the read once
    // the connect promise settles.
    if (this._connecting) return;
    // The read loop is push-based and persists via `onread`/startRead(); a
    // later _read()/resume() call must not restart it (=> EALREADY).
    if (this._tcpReadStarted) return;
    this._tcpReadStarted = true;

    this._tcp.onread = (result: NativeReadResult, error: NativeReadError) => {
        if (error) {
            if ((this._destroyed || this.readyState === 'closed') && matchesErrnoCode(error, 'ECANCELED', 'EBADF')) return;
            this.emit('error', normalizeErrnoError(error, 'read'));
            return;
        }
        if (result === null || result === undefined) {
            handleSocketEof(this);
            return;
        }
        this.bytesRead += result.byteLength;
        this.push(result);
    };

    this._tcp.startRead();
};

/** Sustained read loop driven by the core upgrade handle. The handle replays
 *  any bytes the HTTP parser already buffered (upgradeLeftover) on the first
 *  onReadable call, so post-handshake WebSocket frames are never dropped. */
Socket.prototype._startUpgradeRead = function _startUpgradeRead(this: Socket): void {
    if (!this._upgradeHandle || this._destroyed) return;
    // Same idempotency requirement as _startTcpRead — see comment there.
    if (this._upgradeReadStarted) return;
    this._upgradeReadStarted = true;
    this._upgradeHandle.onReadable((data) => {
        if (data === null) {
            handleSocketEof(this);
            return;
        }
        this.bytesRead += data.byteLength;
        this.push(data);
    }, (err) => {
        this.emit('error', normalizeErrnoError(err, 'read'));
    });
};

/** Duplex _read — called when consumer wants data */
Socket.prototype._read = function _read(this: Socket, size: number): void {
    if (this._destroyed) return;
    // HTTP-owned sockets never pump the raw TCP — core owns the read loop.
    if (this._httpOwned) return;
    if (this._upgradeHandle) {
        this._startUpgradeRead();
    } else if (this._tcp) {
        this._startTcpRead();
    } else if (this._stream) {
        this._startPipeRead();
    }
};

/** Duplex _write — called by _writeBuffered with one chunk at a time */
Socket.prototype._write = function _write(this: Socket, chunk: string | Uint8Array, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this._destroyed || (!this._allowHalfOpen && this._peerEnded)) {
        callback(Object.assign(new Error(this._peerEnded ? 'broken pipe' : 'Socket is destroyed'), {
            code: this._peerEnded ? 'EPIPE' : 'ERR_SOCKET_CLOSED',
            syscall: 'write',
        }));
        return;
    }

    if (this._connecting) {
        let settled = false;
        const cleanup = () => {
            this.off('connect', onConnect);
            this.off('error', onError);
            this.off('close', onClose);
        };
        const settle = (err?: Error | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(err);
        };
        const onConnect = () => {
            cleanup();
            this._write(chunk, encoding, callback);
        };
        const onError = (err: Error) => settle(normalizeErrnoError(err, 'write'));
        const onClose = () => settle(Object.assign(new Error('Socket is closed'), {
            code: 'ERR_SOCKET_CLOSED',
            syscall: 'write',
        }));
        this.once('connect', onConnect);
        this.once('error', onError);
        this.once('close', onClose);
        return;
    }

    const buffer = typeof chunk === 'string' ? engine.encodeString(chunk) : chunk;

    // Core owns the wire; app must not dual-write the same TCP as H1.
    if (this._httpOwned) {
        callback(Object.assign(new Error('Socket is owned by the HTTP server'), {
            code: 'ERR_SOCKET_HTTP_SERVER',
            syscall: 'write',
        }));
        return;
    }

    if (this._upgradeHandle) {
        this._upgradeHandle.write(buffer).then(() => {
            this.bytesWritten += buffer.byteLength;
            callback();
        }).catch((err: Error) => {
            callback(normalizeErrnoError(err, 'write'));
        });
    } else if (this._tcp) {
        this._tcp.write(buffer).then((written: number) => {
            this.bytesWritten += written;
            callback();
        }).catch((err: Error) => {
            callback(normalizeErrnoError(err, 'write'));
        });
    } else if (this._stream) {
        this._stream.write(buffer).then(() => {
            this.bytesWritten += buffer.byteLength;
            callback();
        }).catch((err: Error) => {
            callback(normalizeErrnoError(err, 'write'));
        });
    } else {
        callback(new Error('Socket not connected'));
    }
};

Socket.prototype._final = function _final(this: Socket, callback: (error?: Error | null) => void): void {
    if (this._destroyed) {
        callback();
        return;
    }

    // HTTP core owns half-close / end; facade does not shutdown the handle.
    if (this._httpOwned) {
        callback();
        return;
    }

    if (this._connecting) {
        let settled = false;
        const cleanup = () => {
            this.off('connect', onConnect);
            this.off('error', onError);
            this.off('close', onClose);
        };
        const settle = (err?: Error | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(err);
        };
        const onConnect = () => {
            cleanup();
            this._final(callback);
        };
        const onError = (err: Error) => settle(normalizeErrnoError(err, 'shutdown'));
        const onClose = () => settle();
        this.once('connect', onConnect);
        this.once('error', onError);
        this.once('close', onClose);
        return;
    }

    this.writable = false;
    this._writable = false;

    const closingUpgradeHandle = !!this._upgradeHandle;
    let shutdownResult: Promise<void> | void;
    try {
        if (this._upgradeHandle) {
            this._upgradeHandle.close();
            shutdownResult = undefined;
        } else if (this._stream) {
            shutdownResult = this._stream.shutdown();
        } else if (this._tcp) {
            shutdownResult = this._tcp.shutdown();
        } else {
            shutdownResult = undefined;
        }
    } catch (err) {
        callback(normalizeErrnoError(err, 'shutdown'));
        return;
    }

    this.readyState = this._peerEnded ? 'closed' : 'readOnly';
    Promise.resolve(shutdownResult).then(() => {
        callback();
        queueMicrotask(() => {
            if (closingUpgradeHandle && !this._destroyed) {
                this.destroy();
                return;
            }
            if (this._peerEnded && this.writableFinished && !this._destroyed) {
                this.destroy();
            }
        });
    }, (err) => {
        if (
            (this._destroyed || this._peerEnded || this.readyState === 'closed') &&
            matchesErrnoCode(err, 'ECANCELED', 'EBADF', 'EPIPE')
        ) {
            callback();
            return;
        }
        callback(normalizeErrnoError(err, 'shutdown'));
    });
};

Socket.prototype.destroy = function destroy(this: Socket, error?: Error): Socket {
    if (this._destroyed) return this;
    if (this._peerEnded && !error && !this.readableEnded && this._readableState.buffer.length === 0) {
        this._readableState.ended = true;
        this._emitReadableEndIfNeeded();
    }
    this._destroyed = true;
    this._peerEnded = true;
    this.readyState = 'closed';
    this.readable = false;
    this.writable = false;

    if (this._timeoutId) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
    }

    if (this._httpOwned) {
        // Ask core to drop the connection; do not closeTcp on a borrowed handle.
        try { this._httpOwned.close(); } catch { /* already closed */ }
        this._httpOwned = null;
    } else if (this._tcp) {
        closeTcpQuietly(this._tcp);
        this._tcp = null;
    }

    if (this._stream) {
        stopPipeReadQuietly(this._stream);
        closePipeQuietly(this._stream);
        this._stream = null;
    }

    if (this._upgradeHandle) {
        closeUpgradeHandleQuietly(this._upgradeHandle);
        this._upgradeHandle = null;
    }

    // Sync parent Duplex destroyed state
    this.destroyed = true;

    if (error) {
        emitErrorQuietly(this, normalizeErrnoError(error));
    }
    queueMicrotask(() => this.emit('close', !!error));

    return this;
};

Object.defineProperty(Socket.prototype, 'constructor', {
    value: Socket,
    writable: true,
    configurable: true,
});

flattenPrototype(Socket.prototype);

// Server

export interface Server extends EventEmitter {
    _tcp: CModuleStreams.TCP | null;
    _pipe: CModuleStreams.Pipe | null;
    _listening: boolean;
    _connections: Set<Socket>;
    _maxConnections: number;
    _allowHalfOpen: boolean;
    _pauseOnConnect: boolean;
    _address: AddressInfo | null;

    maxConnections: number;
    connections: number;

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

function initServer(self: Server, options?: ServerOpts | ((socket: Socket) => void), connectionListener?: (socket: Socket) => void): void {
    EventEmitter.call(self);

    self._tcp = null;
    self._pipe = null;
    self._listening = false;
    self._connections = new Set();
    self._maxConnections = 0;
    self._allowHalfOpen = false;
    self._pauseOnConnect = false;
    self._address = null;

    self.maxConnections = 0;
    self.connections = 0;

    if (typeof options === 'function') {
        connectionListener = options;
        options = {};
    }

    if (options && typeof options === 'object') {
        self._allowHalfOpen = options.allowHalfOpen ?? false;
        self._pauseOnConnect = options.pauseOnConnect ?? false;
    }

    if (connectionListener) {
        self.on('connection', connectionListener);
    }
}

export const Server: ServerConstructor = function Server(
    this: Server | undefined,
    options?: ServerOpts | ((socket: Socket) => void),
    connectionListener?: (socket: Socket) => void
) {
    const target: Server = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Server.prototype);
    initServer(target, options, connectionListener);
    return target;
} as ServerConstructor;

Object.setPrototypeOf(Server, EventEmitter);
Server.prototype = Object.create(EventEmitter.prototype);

Server.prototype.listen = function listen(
    this: Server,
    portOrPathOrOptions?: unknown,
    ...args: Array<string | number | (() => void)>
): Server {
    let port: number | undefined;
    let host: string = '0.0.0.0';
    let backlog: number = 511;
    let listeningListener: (() => void) | undefined;
    let ipv6Only: boolean = false;

    if (typeof portOrPathOrOptions === 'number') {
        port = portOrPathOrOptions;
        for (const arg of args) {
            if (typeof arg === 'string') host = arg;
            else if (typeof arg === 'number') backlog = arg;
            else if (typeof arg === 'function') listeningListener = arg;
        }
    } else if (typeof portOrPathOrOptions === 'string') {
        const pipePath = portOrPathOrOptions;
        for (const arg of args) {
            if (typeof arg === 'number') backlog = arg;
            else if (typeof arg === 'function') listeningListener = arg;
        }
        this._pipe = new streams.Pipe();
        try {
            this._pipe.bind(pipePath);
            this._pipe.listen(backlog ?? 511);
            this._pipe.onconnection = (error: CModuleError.Error | undefined, client: CModuleStreams.Stream | undefined) => {
                if (error) {
                    if (!this._listening || matchesErrnoCode(error, 'ECANCELED', 'EBADF')) return;
                    this.emit('error', error);
                    return;
                }
                if (!client) return;
                const socket = new Socket({ allowHalfOpen: this._allowHalfOpen });
                socket._stream = client as CModuleStreams.Pipe;
                socket.emit('connect');
                if (this._pauseOnConnect) {
                    socket.pause();
                }
                this.emit('connection', socket);
                if (!this._pauseOnConnect && !socket._destroyed) socket._startPipeRead();
            };
            this._address = { address: pipePath, family: 'Unix', port: -1 };
            this._listening = true;
            if (listeningListener) this.once('listening', listeningListener);
            this.emit('listening');
        } catch (err) {
            this.emit('error', err);
        }
        return this;
    } else if (portOrPathOrOptions && typeof portOrPathOrOptions === 'object') {
        const options = portOrPathOrOptions as ListenOptions;
        port = options.port;
        host = options.host ?? '0.0.0.0';
        backlog = options.backlog ?? 511;
        ipv6Only = options.ipv6Only ?? false;
        if (typeof args[0] === 'function') listeningListener = args[0];
    }

    host = normalizeTcpHost(host);
    const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
    this._tcp = new streams.TCP(family);

    try {
        this._tcp.bind({ ip: host, port: port ?? 0 });
        this._tcp.listen(backlog);
        const info = this._tcp.sockname;
        this._address = {
            address: info.ip,
            family: `IPv${info.family}`,
            port: info.port,
        };

        this._listening = true;
        this._acceptLoop().catch((err) => {
            if (this._listening) this.emit('error', err);
        });
        this.emit('listening');
        if (listeningListener) listeningListener();
    } catch (err) {
        this.emit('error', err);
        return this;
    }

    return this;
};

Server.prototype._acceptLoop = function _acceptLoop(this: Server): Promise<void> {
    const tcp = this._tcp;
    if (!tcp) return Promise.resolve();
    return new Promise((rs, rj) => tcp.onconnection = (error, clientTcp) => {
        if (error || !clientTcp) {
            if (!this._listening || matchesErrnoCode(error, 'ECANCELED', 'EBADF')) return rs();
            return rj(error);
        }
        if (!this._listening) return rs();

        const socket = new Socket();
        socket._tcp = clientTcp;
        socket.readyState = 'open';

        const localInfo = (clientTcp as CModuleStreams.TCP).sockname;
        socket.localAddress = localInfo.ip;
        socket.localPort = localInfo.port;

        const remoteInfo = (clientTcp as CModuleStreams.TCP).peername;
        socket.remoteAddress = remoteInfo.ip;
        socket.remotePort = remoteInfo.port;
        socket.remoteFamily = `IPv${remoteInfo.family}`;

        this._connections.add(socket);
        this.connections = this._connections.size;

        socket.on('close', () => {
            this._connections.delete(socket);
            this.connections = this._connections.size;
        });

        if (this._pauseOnConnect) {
            socket.pause();
        }

        this.emit('connection', socket);

        if (!this._pauseOnConnect && !socket._destroyed) {
            socket._startTcpRead();
        }
    });
};

Server.prototype.address = function address(this: Server): AddressInfo | string | null {
    if (!this._address) return null;
    return this._address;
};

Server.prototype.getConnections = function getConnections(this: Server, cb: (err: Error | null, count: number) => void): void {
    cb(null, this._connections.size);
};

Server.prototype.close = function close(this: Server, callback?: (err?: Error) => void): Server {
    if (!this._listening) {
        callback?.(new Error('Server is not running'));
        return this;
    }

    this._listening = false;

    for (const socket of this._connections) {
        socket.destroy();
    }
    this._connections.clear();
    this.connections = 0;

    if (this._tcp) {
        try {
            this._tcp.close();
        } catch { }
        this._tcp = null;
    }
    if (this._pipe) {
        try {
            this._pipe.close();
        } catch { }
        this._pipe = null;
    }

    this.emit('close');
    callback?.();

    return this;
};

Server.prototype.ref = function ref(this: Server): Server {
    if (this._tcp) this._tcp.ref();
    if (this._pipe) this._pipe.ref();
    return this;
};

Server.prototype.unref = function unref(this: Server): Server {
    if (this._tcp) this._tcp.unref();
    if (this._pipe) this._pipe.unref();
    return this;
};

Object.defineProperty(Server.prototype, 'constructor', {
    value: Server,
    writable: true,
    configurable: true,
});

flattenPrototype(Server.prototype);

// Factory functions

export function createServer(options?: ServerOpts, connectionListener?: (socket: Socket) => void): Server {
    return new Server(options, connectionListener);
}

export function connect(options: TcpNetConnectOpts, connectListener?: () => void): Socket;
export function connect(port: number, host?: string, connectListener?: () => void): Socket;
export function connect(path: string, connectListener?: () => void): Socket;
export function connect(portOrPath: number | string | TcpNetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): Socket {
    const socket = new Socket();
    if (typeof portOrPath === 'object') {
        socket.connect(portOrPath, typeof hostOrCb === 'function' ? hostOrCb : undefined);
    } else if (typeof portOrPath === 'number') {
        if (typeof hostOrCb === 'string') {
            socket.connect(portOrPath, hostOrCb, cb);
        } else {
            socket.connect(portOrPath, 'localhost', hostOrCb as (() => void) | undefined);
        }
    } else {
        socket.connect(portOrPath, hostOrCb as (() => void) | undefined);
    }
    return socket;
}

export function createConnection(options: TcpNetConnectOpts, connectListener?: () => void): Socket;
export function createConnection(port: number, host?: string, connectListener?: () => void): Socket;
export function createConnection(path: string, connectListener?: () => void): Socket;
export function createConnection(portOrPath: number | string | TcpNetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): Socket {
    if (typeof portOrPath === 'object') {
        return connect(portOrPath, typeof hostOrCb === 'function' ? hostOrCb : undefined);
    }
    if (typeof portOrPath === 'number') {
        return typeof hostOrCb === 'string'
            ? connect(portOrPath, hostOrCb, cb)
            : connect(portOrPath, 'localhost', hostOrCb);
    }
    return connect(portOrPath, hostOrCb as (() => void) | undefined);
}

type BlockListFamily = 'ipv4' | 'ipv6';
type BlockListRule = {
    family: BlockListFamily;
    start: bigint;
    end: bigint;
    rule: string;
};

function parseIpv4(address: string): bigint | null {
    if (!isIPv4(address)) return null;
    const parts = address.split('.').map((part) => Number(part));
    const [a, b, c, d] = parts;
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    return BigInt(((a << 24) >>> 0) + (b << 16) + (c << 8) + d);
}

function parseIpv6(address: string): bigint | null {
    if (!address.includes(':')) return null;
    const halves = address.split('::');
    if (halves.length > 2) return null;

    const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
    const right = halves[1] ? halves[1].split(':').filter(Boolean) : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;

    const parts = [...left, ...Array(missing).fill('0'), ...right];
    if (parts.length !== 8) return null;

    let value = 0n;
    for (const part of parts) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
        value = (value << 16n) + BigInt(parseInt(part, 16));
    }
    return value;
}

function parseBlockListAddress(address: string, type?: string): { family: BlockListFamily; value: bigint; normalized: string } {
    const requested = type?.toLowerCase();
    if (requested !== undefined && requested !== 'ipv4' && requested !== 'ipv6') {
        throw new TypeError('The "type" argument must be either "ipv4" or "ipv6"');
    }

    const text = String(address);
    const ipv4 = parseIpv4(text);
    if (ipv4 !== null) {
        if (requested === 'ipv6') throw new TypeError('Address family mismatch');
        return { family: 'ipv4', value: ipv4, normalized: text };
    }

    const ipv6 = parseIpv6(text);
    if (ipv6 !== null) {
        if (requested === 'ipv4') throw new TypeError('Address family mismatch');
        return { family: 'ipv6', value: ipv6, normalized: text.toLowerCase() };
    }

    throw new TypeError('Invalid IP address');
}

function blockListMaxBits(family: BlockListFamily): number {
    return family === 'ipv4' ? 32 : 128;
}

function blockListLabel(family: BlockListFamily): string {
    return family === 'ipv4' ? 'IPv4' : 'IPv6';
}

export class BlockList {
    #rules: BlockListRule[] = [];

    addAddress(address: string, type?: string): void {
        const parsed = parseBlockListAddress(address, type);
        this.#rules.push({
            family: parsed.family,
            start: parsed.value,
            end: parsed.value,
            rule: `Address: ${blockListLabel(parsed.family)} ${parsed.normalized}`,
        });
    }

    addRange(start: string, end: string, type?: string): void {
        const from = parseBlockListAddress(start, type);
        const to = parseBlockListAddress(end, type);
        if (from.family !== to.family) throw new TypeError('Address family mismatch');
        if (from.value > to.value) throw new RangeError('Start address must be less than or equal to end address');
        this.#rules.push({
            family: from.family,
            start: from.value,
            end: to.value,
            rule: `Range: ${blockListLabel(from.family)} ${from.normalized}-${to.normalized}`,
        });
    }

    addSubnet(net: string, prefix: number, type?: string): void {
        const parsed = parseBlockListAddress(net, type);
        const max = blockListMaxBits(parsed.family);
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
            throw new RangeError('Subnet prefix is out of range');
        }

        const hostBits = BigInt(max - prefix);
        const allBits = (1n << BigInt(max)) - 1n;
        const hostMask = hostBits === 0n ? 0n : (1n << hostBits) - 1n;
        const network = parsed.value & (allBits ^ hostMask);
        this.#rules.push({
            family: parsed.family,
            start: network,
            end: network | hostMask,
            rule: `Subnet: ${blockListLabel(parsed.family)} ${parsed.normalized}/${prefix}`,
        });
    }

    check(address: string, type?: string): boolean {
        const parsed = parseBlockListAddress(address, type);
        return this.#rules.some((rule) =>
            rule.family === parsed.family && parsed.value >= rule.start && parsed.value <= rule.end
        );
    }

    get rules(): string[] {
        return this.#rules.map((rule) => rule.rule);
    }
}

// SocketAddress (Node 15+)

export interface SocketAddressInit {
    address?: string;
    port?: number;
    family?: 'ipv4' | 'ipv6' | 4 | 6;
    flowlabel?: number;
}

export class SocketAddress {
    readonly address: string;
    readonly port: number;
    readonly family: 'ipv4' | 'ipv6';
    readonly flowlabel: number;

    constructor(options?: SocketAddressInit) {
        const opts = options ?? {};
        let family: 'ipv4' | 'ipv6' = 'ipv4';
        if (opts.family === 6 || opts.family === 'ipv6') family = 'ipv6';
        else if (opts.family === 4 || opts.family === 'ipv4') family = 'ipv4';

        const address = opts.address ?? (family === 'ipv6' ? '::' : '127.0.0.1');
        if (family === 'ipv4' && !isIPv4(address)) {
            // Infer family from address when default/unspecified family.
            if (isIPv6(address)) family = 'ipv6';
            else throw new TypeError('Invalid socket address');
        }
        if (family === 'ipv6' && !isIPv6(address) && !isIPv4(address)) {
            throw new TypeError('Invalid socket address');
        }
        if (family === 'ipv4' && isIPv6(address)) family = 'ipv6';

        const port = opts.port ?? 0;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new RangeError('Port should be >= 0 and < 65536');
        }
        const flowlabel = opts.flowlabel ?? 0;
        if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xfffff) {
            throw new RangeError('flowlabel should be >= 0 and < 1048576');
        }

        this.address = address;
        this.port = port;
        this.family = family;
        this.flowlabel = flowlabel;
    }
}

// isIP / isIPv4 / isIPv6

export function isIP(input: string): number {
    if (isIPv4(input)) return 4;
    if (isIPv6(input)) return 6;
    return 0;
}

export function isIPv4(input: string): boolean {
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Regex.test(input)) return false;
    const parts = input.split('.');
    return parts.every(part => {
        const num = parseInt(part, 10);
        return num >= 0 && num <= 255;
    });
}

export function isIPv6(input: string): boolean {
    // Simplified IPv6 detection
    if (input.includes(':')) {
        const parts = input.split(':');
        if (parts.length < 3 || parts.length > 8) return false;
        // Check each part
        for (const part of parts) {
            if (part === '') continue; // allow ::
            if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false;
        }
        return true;
    }
    return false;
}
