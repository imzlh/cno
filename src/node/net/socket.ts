/**
 * node:net Socket.
 *
 * Owns every piece of identity-sensitive state for the client/accepted socket:
 *   - `kNetClientSocketPublished`, a bare Symbol() whose identity is the guard
 *     against a double diagnostics-channel publish. It must exist exactly once
 *     in the process, so it lives here and nowhere else.
 *   - `duplexWrite`, the Duplex.prototype.write capture. It is order-sensitive:
 *     `../stream` must already be fully evaluated when this module runs.
 */

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const engine = import.meta.use('engine');

import { Duplex } from '../stream';
import { matchesErrnoCode, normalizeErrnoError } from '../_internal/errno';
import { onNetClientSocket } from '../diagnostics_channel/builtins';
import {
    abortError,
    closePipeQuietly,
    closeTcpQuietly,
    closeUpgradeHandleQuietly,
    deferTick,
    destroyWithReadError,
    emitErrorQuietly,
    flattenPrototype,
    isIPv4,
    isIPv6,
    resolveConnectAddress,
    setTcpKeepAlive,
    setTcpNoDelay,
    stopPipeReadQuietly,
    validatePort,
} from './_shared';
import type {
    AddressInfo,
    HttpOwnedTransport,
    NetConnectOpts,
    Socket as SocketShape,
    SocketConstructor,
    SocketConstructorOpts,
    TcpNetConnectOpts,
    UpgradeHandle,
} from './types';

/** Guards net.client.socket against the pipe branch's re-entrant connect(). */
const kNetClientSocketPublished = Symbol('kNetClientSocketPublished');

type NativeReadResult = Uint8Array<ArrayBuffer> | null | undefined;
type NativeReadError = CModuleError.Error | undefined;

export interface Socket extends SocketShape {}

function initSocket(self: Socket, options?: SocketConstructorOpts): void {
    Duplex.call(self, { allowHalfOpen: options?.allowHalfOpen ?? false });

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
    socket.localFamily = `IPv${localInfo.family}`;
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
    socket._tcpReadStarted = false;
    socket._pipeReadStarted = false;
    socket._upgradeReadStarted = false;
    socket.push(null);
    // Node keeps `readable` true until 'end' is emitted, i.e. until the buffer has
    // actually drained — measured: with 3 bytes still buffered it reports
    // `readable === true`. Clearing it here while chunks remain is what let
    // `Duplex.read()`'s old `if (!this.readable) return null` gate strand them
    // forever, so the flag flip is deferred to _emitReadableEndIfNeeded below.
    socket._readable = false;
    if (socket._destroyed) return;
    if (!socket._readableState.flowing && socket._readableState.buffer.length === 0) {
        socket._emitReadableEndIfNeeded();
    }

    if (!socket._allowHalfOpen && !socket.writableEnded) {
        socket.readyState = 'readOnly';
        // Node's `allowHalfOpen:false` means "auto-end AFTER the 'end' handler
        // has had its turn", not "close the write side now". Node implements it
        // as an `onReadableStreamEnd` listener, which runs on the tick after
        // 'end' — so a server doing `s.on('end', () => s.write(tail))` still
        // delivers `tail`. Calling end() inline here flipped `writable` false
        // before the user's 'end' handler ran, so that write was REJECTED and
        // the peer received "" instead of the payload — measured:
        //   node: S:end(writable=true)  > write returned true  > C:end(recv="AFTER-END")
        //   cno:  S:end(writable=false) > write returned false > C:end(recv="")
        // i.e. silent data loss on every allowHalfOpen:false socket whose 'end'
        // handler writes a farewell (the standard request/response shape).
        // Node's `allowHalfOpen:false` means "auto-end AFTER the 'end' handler
        // has had its turn", not "close the write side now". Node implements it
        // as an `onReadableStreamEnd` listener, which runs on the tick after
        // 'end' — so a server doing `s.on('end', () => s.write(tail))` still
        // delivers `tail`. Calling end() inline flips `writable` false before
        // the user's 'end' handler runs, so that write is REJECTED — measured:
        //   node: S:end(writable=true)  > write returned true  > C:end("AFTER-END")
        //   cno:  S:end(writable=false) > write returned false > C:end("")
        // i.e. silent data loss on an allowHalfOpen:false socket whose 'end'
        // handler writes a farewell (the standard request/response shape).
        // HTTP-owned sockets keep the inline path: core drives its own
        // shutdown sequencing and deferring here hangs every TLS response.
        if (socket._httpOwned) {
            socket.end();
            return;
        }
        deferTick(() => {
            if (socket._destroyed || socket.writableEnded) return;
            socket.end();
        });
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

function armSocketTimeout(socket: Socket): void {
    if (socket._timeoutId) clearTimeout(socket._timeoutId);
    socket._timeoutId = null;
    if (!socket._timeout || socket._destroyed) return;
    socket._timeoutId = setTimeout(() => {
        socket._timeoutId = null;
        socket.emit('timeout');
    }, socket._timeout);
}

Socket.prototype.connect = function connect(
    this: Socket,
    portOrPath: number | string | NetConnectOpts,
    hostOrCb?: string | (() => void),
    cb?: () => void
): Socket {
    // Node publishes net.client.socket at the top of connect(), before any
    // resolution or connection work, with just `{ socket }`. The `{ path }`
    // branch below re-enters connect(), so the flag keeps this exactly-once
    // per user-initiated call rather than publishing twice for a pipe.
    if (onNetClientSocket.hasSubscribers && !Reflect.get(this, kNetClientSocketPublished)) {
        Reflect.set(this, kNetClientSocketPublished, true);
        onNetClientSocket.publish({ socket: this });
    }
    let port: number | undefined;
    let host: string = 'localhost';
    let connectListener: (() => void) | undefined;
    let options: TcpNetConnectOpts | undefined;

    if (typeof portOrPath === 'object' && portOrPath !== null) {
        // Node selects the pipe branch on `!!options.path`, so a key that is merely
        // present with an undefined/null value stays TCP. undici builds its connect
        // options as `{...options, port, host}`, which carries `path: undefined`.
        const pipePath = (portOrPath as { path?: unknown }).path;
        if (pipePath !== undefined && pipePath !== null && pipePath !== '') {
            if (portOrPath.signal?.aborted) {
                queueMicrotask(() => this.destroy(abortError()));
                return this;
            }
            if (portOrPath.signal) {
                portOrPath.signal.addEventListener('abort', () => this.destroy(abortError()), { once: true });
            }
            return this.connect(pipePath as string, typeof hostOrCb === 'function' ? hostOrCb : undefined);
        }
        options = portOrPath;
        port = portOrPath.port;
        host = portOrPath.host ?? 'localhost';
        connectListener = typeof hostOrCb === 'function' ? hostOrCb : undefined;
        if (portOrPath.noDelay !== undefined) this._noDelay = portOrPath.noDelay;
        if (portOrPath.keepAlive !== undefined) this._keepAlive = portOrPath.keepAlive;
        if (portOrPath.keepAliveInitialDelay !== undefined) this._keepAliveDelay = portOrPath.keepAliveInitialDelay;
        if (portOrPath.timeout !== undefined) this.setTimeout(portOrPath.timeout);
        if (portOrPath.signal) {
            if (portOrPath.signal.aborted) {
                queueMicrotask(() => this.destroy(abortError()));
                return this;
            }
            portOrPath.signal.addEventListener('abort', () => this.destroy(abortError()), { once: true });
        }
    } else if (typeof portOrPath === 'number') {
        port = portOrPath;
        options = { port };
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
        if (connectListener) this.once('connect', connectListener);

        const pipe = new streams.Pipe();
        this._stream = pipe;
        pipe.connect(portOrPath).then(() => {
            this.connecting = false;
            this._connecting = false;
            this.readyState = 'open';
            armSocketTimeout(this);
            this.emit('connect');
            this.emit('ready');
            if (!this._destroyed) this._startPipeRead();
        }).catch((err) => {
            this.connecting = false;
            this._connecting = false;
            // Node pipe connect errors report the socket path as `address`.
            const error = normalizeErrnoError(err, 'connect');
            Reflect.set(error, 'address', portOrPath);
            if (!this._destroyed) this.destroy(error);
        });
        if (!this._refed) pipe.unref();

        return this;
    }

    if (port === undefined) throw new TypeError('Port is required');
    port = validatePort(port);
    options = { ...options, port };
    host = host || 'localhost';
    if (connectListener) this.once('connect', connectListener);

    this.connecting = true;
    this._connecting = true;
    this.readyState = 'opening';

    let lookupSucceeded = false;
    let resolvedAddress: string | undefined;
    resolveConnectAddress(host, options).then(({ address, family }) => {
        if (this._destroyed) return;
        lookupSucceeded = true;
        resolvedAddress = address;
        if (!isIPv4(host) && !isIPv6(host)) this.emit('lookup', null, address, family, host);

        // Node gates the local bind on truthiness (`if (localAddress || localPort)`),
        // so null/'' means "no bind". undici passes `localAddress: null`.
        const localAddress = options?.localAddress || undefined;
        const localPort = options?.localPort || undefined;
        if (localAddress !== undefined) {
            const localFamily = isIPv4(localAddress) ? 4 : isIPv6(localAddress) ? 6 : 0;
            if (!localFamily) throw Object.assign(new Error(`bind EINVAL ${localAddress}`), { code: 'EINVAL' });
            if (localFamily !== family) throw Object.assign(new Error('bind EAFNOSUPPORT'), { code: 'EAFNOSUPPORT' });
        }
        if (localPort !== undefined) validatePort(localPort, 'localPort');

        const tcp = new streams.TCP(family === 6 ? os.AF_INET6 : os.AF_INET);
        this._tcp = tcp;
        if (!this._refed) tcp.unref();
        if (localAddress !== undefined || localPort !== undefined) {
            tcp.bind({
                ip: localAddress ?? (family === 6 ? '::' : '0.0.0.0'),
                port: localPort ?? 0,
            });
        }
        if (this._noDelay) setTcpNoDelay(tcp, true);
        return tcp.connect({ ip: address, port }).then(() => tcp);
    }).then((tcp) => {
        if (!tcp || this._destroyed) return;
        this.connecting = false;
        this._connecting = false;
        this.readyState = 'open';
        armSocketTimeout(this);

        const localInfo = tcp.sockname;
        this.localAddress = localInfo.ip;
        this.localPort = localInfo.port;
        this.localFamily = `IPv${localInfo.family}`;

        const remoteInfo = tcp.peername;
        this.remoteAddress = remoteInfo.ip;
        this.remotePort = remoteInfo.port;
        this.remoteFamily = `IPv${remoteInfo.family}`;

        if (this._keepAlive) {
            setTcpKeepAlive(tcp, true, this._keepAliveDelay);
        }

        this.emit('connect');
        this.emit('ready');
        // Listener may have handed the TCP to http/http2 (_httpOwned).
        if (!this._destroyed && !this._httpOwned) this._startTcpRead();
    }).catch((err) => {
        if (!lookupSucceeded && !isIPv4(host) && !isIPv6(host) && !this._destroyed) {
            this.emit('lookup', normalizeErrnoError(err, 'getaddrinfo'), undefined, undefined, host);
        }
        this.connecting = false;
        this._connecting = false;
        // Node connect errors carry the dialed address/port — user code reads them.
        const error = normalizeErrnoError(err, 'connect');
        if (lookupSucceeded) {
            Reflect.set(error, 'address', resolvedAddress ?? host);
            Reflect.set(error, 'port', port);
        }
        if (!this._destroyed) this.destroy(error);
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
            destroyWithReadError(this, error);
            return;
        }
        if (result === null || result === undefined) {
            handleSocketEof(this);
            return;
        }
        this.bytesRead += result.byteLength;
        armSocketTimeout(this);
        this.push(result);
    };
    this._stream.startRead();
};

Socket.prototype.setEncoding = function setEncoding(this: Socket, encoding?: BufferEncoding): Socket {
    // Delegate to Duplex: it installs the StringDecoder so 'data' yields
    // strings and a multi-byte sequence split across TCP segments is rejoined.
    // Setting only the public field left both behaviours broken.
    if (encoding) Duplex.prototype.setEncoding.call(this, encoding);
    return this;
};

Socket.prototype.pause = function pause(this: Socket): Socket {
    const state = this._readableState;
    if (state.flowing !== false) {
        state.flowing = false;
        this.emit('pause');
    }
    // After the write side has finished, keep the native read pump alive so a
    // paused half-closed socket can still observe the peer FIN and close.
    if (this.writableEnded || this.writableFinished) return this;
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
    if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError('The value of "timeout" is out of range');
    this._timeout = Math.trunc(timeout);
    this.timeout = this._timeout;
    if (callback) this.once('timeout', callback);
    armSocketTimeout(this);
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

// Node exposes `pending` as a prototype getter: true until the socket has a
// handle and has finished connecting. It is documented API, and `undefined`
// silently passes a falsy check while failing `=== false`.
Object.defineProperty(Socket.prototype, 'pending', {
    configurable: true,
    enumerable: false,
    get(this: Socket): boolean {
        return !(this._tcp || this._stream || this._httpOwned) || this.connecting;
    },
});

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
    // Protocol layers (http/http2) steal the handle via _httpOwned; connect()
    // still runs after the 'connect' listener — must not reinstall onread.
    if (this._httpOwned) return;
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
            destroyWithReadError(this, error);
            return;
        }
        if (result === null || result === undefined) {
            handleSocketEof(this);
            return;
        }
        this.bytesRead += result.byteLength;
        armSocketTimeout(this);
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
        armSocketTimeout(this);
        this.push(data);
    }, (err) => {
        destroyWithReadError(this, err);
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
    // Only a DESTROYED socket refuses writes. Receiving the peer's FIN closes
    // the read half only — the write half stays open until we shut it down, so
    // Node happily writes after 'end' regardless of allowHalfOpen. Rejecting
    // with EPIPE on `_peerEnded` was the second half of the data-loss bug
    // documented in handleSocketEof.
    if (this._destroyed) {
        callback(Object.assign(new Error('Socket is destroyed'), {
            code: 'ERR_SOCKET_CLOSED',
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
            armSocketTimeout(this);
            callback();
        }).catch((err: Error) => {
            callback(normalizeErrnoError(err, 'write'));
        });
    } else if (this._tcp) {
        this._tcp.write(buffer).then((written: number) => {
            this.bytesWritten += written;
            armSocketTimeout(this);
            callback();
        }).catch((err: Error) => {
            callback(normalizeErrnoError(err, 'write'));
        });
    } else if (this._stream) {
        this._stream.write(buffer).then(() => {
            this.bytesWritten += buffer.byteLength;
            armSocketTimeout(this);
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
            Socket.prototype._final!.call(this, callback);
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
    this._connecting = false;
    this.connecting = false;
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

    // Node's destroy() never emits inline: it defers to nextTick (emitErrorNT /
    // emitCloseNT) so `sock.destroy(err); sock.on('error', h)` — legal because
    // the emit has not happened yet — still reaches h. Measured on Node v24.18
    // that idiom catches; emitting inline here made it miss (caught=false).
    // Both emissions go through the SAME queue so 'error' stays before 'close'.
    deferTick(() => {
        if (error) emitErrorQuietly(this, normalizeErrnoError(error));
        this.emit('close', !!error);
    });

    return this;
};

/**
 * An app write to an HTTP-owned socket facade is REFUSED — core owns the wire.
 *
 * That refusal must not be expressed as a stream fault. It used to be reported
 * by handing an error to _write's callback, which was harmless only because the
 * generic Writable merely emitted 'error' and left the stream alive. Now that a
 * write error correctly destroys the stream (matching node), the same path tore
 * down the live connection and the client saw ECONNRESET mid-response. So the
 * refusal is intercepted before it reaches the writable machinery: the write
 * callback gets ERR_SOCKET_HTTP_SERVER and 'error' is still emitted for
 * compatibility, but the socket is neither errored nor destroyed.
 */
const duplexWrite = Duplex.prototype.write;
Socket.prototype.write = function write(
    this: Socket,
    chunk: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
): boolean {
    if (this._httpOwned && !this._destroyed) {
        const cb = typeof encoding === 'function' ? encoding : callback;
        const err = Object.assign(new Error('Socket is owned by the HTTP server'), {
            code: 'ERR_SOCKET_HTTP_SERVER',
            syscall: 'write',
        });
        // Callback first, then 'error' — the order the previous path produced.
        queueMicrotask(() => {
            if (cb) cb(err);
            this.emit('error', err);
        });
        return false;
    }
    return duplexWrite.call(this, chunk, encoding, callback);
};

Object.defineProperty(Socket.prototype, 'constructor', {
    value: Socket,
    writable: true,
    configurable: true,
});

flattenPrototype(Socket.prototype);
