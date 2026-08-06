/**
 * Node.js net module
 * Based on CModuleStreams for TCP networking
 */

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const nativeDns = import.meta.use('dns');
const nativeError = import.meta.use('error');

import { EventEmitter } from '../events';
import { Duplex, Readable, Writable } from '../stream';
import { matchesErrnoCode, normalizeErrnoError } from '../_internal/errno';
import { onNetClientSocket, onNetServerSocket } from '../diagnostics_channel/builtins';

/** Guards net.client.socket against the pipe branch's re-entrant connect(). */
const kNetClientSocketPublished = Symbol('kNetClientSocketPublished');

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

// Node's bind/listen failures carry `syscall:'listen'` plus the address that
// failed, and the message is `listen <CODE>: <desc> <address>[:<port>]`.
// Verified against real Node v24.18 on Windows:
//   listen EADDRINUSE: address already in use 127.0.0.1:49625
//   listen EACCES: permission denied C:\...\x.sock
function toListenError(raw: unknown, address: string, port?: number): Error {
    const err = normalizeErrnoError(raw, 'listen') as NodeJS.ErrnoException & {
        address?: string;
        port?: number;
    };
    const code = typeof err.code === 'string' ? err.code : 'UNKNOWN';
    let desc = typeof err.errno === 'number' ? nativeError.strerror(err.errno) : '';
    if (!desc) desc = err.message;
    // strerror/message already carry a `CODE: ` prefix; keep the readable half.
    desc = desc.replace(/^[A-Z][A-Z0-9]*:\s*/, '').trim() || 'unknown error';
    const where = port === undefined ? address : `${address}:${port}`;
    err.message = `listen ${code}: ${desc}${where ? ` ${where}` : ''}`;
    err.syscall = 'listen';
    err.address = address;
    if (port !== undefined) err.port = port;
    // toErrnoException stamps an own `name`; Node's listen errors do not carry
    // one, so `Object.keys(err)` would otherwise not match upstream.
    delete (err as { name?: string }).name;
    return err;
}

// A read error is fatal in Node: `onStreamRead` calls `destroy(err)`, which
// emits 'error' once and then 'close' with hadError=true. Emitting bare and
// leaving the socket open was measured to produce, on a peer RST mid-write:
//   cno: 35 'error' emissions, later ones raw native IOError objects whose
//        `.code` is the NUMBER -4047 and which carry no own properties, and
//        NO 'close' at all — `destroyed` stayed false, readyState 'open'.
//   node: exactly 1 error (code 'ECONNRESET', string) then close(hadError=true).
// A `err.code === 'ECONNRESET'` check — the standard idiom — silently fails
// against a numeric code, so the repeats were also unclassifiable.
function destroyWithReadError(socket: Socket, raw: unknown): void {
    if (socket._destroyed) return;
    socket.destroy(normalizeErrnoError(raw, 'read'));
}

// Node runs 'listening' / listen-error emissions on the next tick so that
// `server.listen(p); server.on('listening'|'error', h)` — the standard idiom —
// still observes them. `process` is resolved lazily to avoid an import cycle
// (same approach as stream/mod.ts's deferTick).
type NextTickHost = { nextTick?: (callback: () => void, ...args: unknown[]) => void };

function deferTick(callback: () => void): void {
    const host = (globalThis as { process?: NextTickHost }).process;
    if (host && typeof host.nextTick === 'function') {
        host.nextTick(callback);
        return;
    }
    queueMicrotask(callback);
}

// Node defers listen failures to nextTick, so `server.listen(p);
// server.on('error', h)` still catches them. Emitting inline instead makes that
// idiom (the standard EADDRINUSE retry) throw out of listen().
function emitListenErrorAsync(server: Server, err: Error): void {
    deferTick(() => emitErrorQuietly(server, err));
}

// Measured against real Node v24.18: `listen()` NEVER emits 'listening' inline.
//   listen(0):              AFTER-listen() listening=true > listening-event > listen-cb > nextTick
//   listen(0,'127.0.0.1'):  AFTER-listen() listening=false > microtask > nextTick > listening-event
// Emitting inline broke two things:
//   1. `server.listen(p); server.on('listening', h)` never fired h at all — the
//      event was already gone by the time the listener attached.
//   2. A listen callback that calls `server.close()` ran *inside* listen(),
//      which tripped a C-level bug where a handle closed from within another
//      handle's close-callback delivery does not hold the loop alive, so the
//      close callback was silently dropped and the process exited early.
function emitListeningAsync(server: Server): void {
    deferTick(() => {
        // close() between listen() and this tick means Node never emits.
        if (!server._listening) return;
        server.emit('listening');
    });
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

type ResolvedConnectAddress = { address: string; family: 4 | 6 };

function normalizeFamily(value: unknown): 0 | 4 | 6 {
    if (value === undefined || value === 0) return 0;
    if (value === 4 || value === 'IPv4') return 4;
    if (value === 6 || value === 'IPv6') return 6;
    throw new TypeError(`The "family" option must be 0, 4, 6, "IPv4", or "IPv6". Received ${String(value)}`);
}

function validatePort(value: unknown, name = 'port'): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
        throw new RangeError(`The "${name}" argument must be an integer between 0 and 65535`);
    }
    return value;
}

function abortError(): Error & { code: string; name: string } {
    const error = new Error('The operation was aborted') as Error & { code: string; name: string };
    error.code = 'ABORT_ERR';
    error.name = 'AbortError';
    return error;
}

function resolveConnectAddress(hostname: string, options: TcpNetConnectOpts): Promise<ResolvedConnectAddress> {
    const requestedFamily = normalizeFamily(options.family);
    const literalFamily = isIPv4(hostname) ? 4 : isIPv6(hostname) ? 6 : 0;
    if (literalFamily) {
        if (requestedFamily && requestedFamily !== literalFamily) {
            const error = new Error('Address family not supported') as Error & { code?: string };
            error.code = 'EAI_FAMILY';
            return Promise.reject(error);
        }
        return Promise.resolve({ address: hostname, family: literalFamily });
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error: unknown, address?: string, family?: number | string): void => {
            if (settled) return;
            settled = true;
            if (error) {
                reject(error);
                return;
            }
            const resolvedFamily = family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : family;
            if (typeof address !== 'string' || (resolvedFamily !== 4 && resolvedFamily !== 6)) {
                reject(Object.assign(new Error('Invalid address returned by lookup'), { code: 'EAI_FAIL' }));
                return;
            }
            if (requestedFamily && requestedFamily !== resolvedFamily) {
                reject(Object.assign(new Error('Address family not supported'), { code: 'EAI_FAMILY' }));
                return;
            }
            resolve({ address, family: resolvedFamily });
        };

        if (options.lookup) {
            try {
                options.lookup(hostname, {
                    family: requestedFamily,
                    hints: options.hints ?? 0,
                }, finish);
            } catch (error) {
                finish(error);
            }
            return;
        }

        nativeDns.resolve(hostname, {
            family: requestedFamily === 4 ? os.AF_INET : requestedFamily === 6 ? os.AF_INET6 : os.AF_UNSPEC,
        }).then((addresses: Array<{ ip: string; family: number }>) => {
            const first = addresses[0];
            finish(first ? null : Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), first?.ip, first?.family);
        }, finish);
    });
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

    if (typeof portOrPath === 'object') {
        if ('path' in portOrPath) {
            if (portOrPath.signal?.aborted) {
                queueMicrotask(() => this.destroy(abortError()));
                return this;
            }
            if (portOrPath.signal) {
                portOrPath.signal.addEventListener('abort', () => this.destroy(abortError()), { once: true });
            }
            return this.connect(portOrPath.path, typeof hostOrCb === 'function' ? hostOrCb : undefined);
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

        const localAddress = options?.localAddress;
        const localPort = options?.localPort;
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
    _keepAlive: boolean;
    _keepAliveDelay: number;
    _noDelay: boolean;
    _address: AddressInfo | string | null;
    _closing: boolean;
    _handleClosed: boolean;
    _closeCallbacks: Array<(err?: Error) => void>;

    maxConnections?: number;
    connections: number;
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

function initServer(self: Server, options?: ServerOpts | ((socket: Socket) => void), connectionListener?: (socket: Socket) => void): void {
    EventEmitter.call(self);

    self._tcp = null;
    self._pipe = null;
    self._listening = false;
    self._connections = new Set();
    self._maxConnections = 0;
    self._allowHalfOpen = false;
    self._pauseOnConnect = false;
    self._keepAlive = false;
    self._keepAliveDelay = 0;
    self._noDelay = false;
    self._address = null;
    self._closing = false;
    self._handleClosed = true;
    self._closeCallbacks = [];

    self.connections = 0;

    if (typeof options === 'function') {
        connectionListener = options;
        options = {};
    }

    if (options && typeof options === 'object') {
        self._allowHalfOpen = options.allowHalfOpen ?? false;
        self._pauseOnConnect = options.pauseOnConnect ?? false;
        self._keepAlive = options.keepAlive ?? false;
        self._keepAliveDelay = options.keepAliveInitialDelay ?? 0;
        self._noDelay = options.noDelay ?? false;
        if (options.signal) {
            const closeOnAbort = () => {
                if (self._listening) self.close();
            };
            if (options.signal.aborted) queueMicrotask(closeOnAbort);
            else options.signal.addEventListener('abort', closeOnAbort, { once: true });
        }
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

Object.defineProperty(Server.prototype, 'listening', {
    get(this: Server): boolean { return this._listening; },
    enumerable: true,
    configurable: true,
});

function finishServerClose(server: Server): void {
    if (!server._closing || !server._handleClosed || server._connections.size !== 0) return;
    server._closing = false;
    const callbacks = server._closeCallbacks.splice(0);
    server.emit('close');
    for (const callback of callbacks) callback();
}

function trackServerSocket(server: Server, socket: Socket): boolean {
    const maxConnections = server.maxConnections;
    if (typeof maxConnections === 'number' && maxConnections >= 0 && server._connections.size >= maxConnections) {
        const dropInfo = {
            localAddress: socket.localAddress,
            localPort: socket.localPort,
            localFamily: socket._address?.family,
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            remoteFamily: socket.remoteFamily,
        };
        socket.destroy();
        server.emit('drop', dropInfo);
        return false;
    }

    server._connections.add(socket);
    server.connections = server._connections.size;
    socket.once('close', () => {
        server._connections.delete(socket);
        server.connections = server._connections.size;
        finishServerClose(server);
    });
    return true;
}

function configureAcceptedSocket(server: Server, socket: Socket): void {
    if (server._noDelay) socket.setNoDelay(true);
    if (server._keepAlive) socket.setKeepAlive(true, server._keepAliveDelay);
    if (server._pauseOnConnect) socket.pause();
}

// Set only for the internal listen({path}) -> listen(path) hop below, so that
// an explicit `path` which happens to look numeric (e.g. {path:'8080'}) is NOT
// coerced into a TCP port by the normalization in listen(). Safe as a module
// flag because listen() is synchronous and consumes/clears it on entry.
let forcePipePath = false;

// Node's `isPipeName`: a string is a PATH only if it does not look numeric.
// `listen('8080')` therefore binds TCP port 8080 — and `listen(process.env.PORT)`
// is the single most common form of that, since env vars are always strings.
// cno treated every string as a pipe path, so it bound a pipe literally named
// "8080" and failed EACCES. Measured: node LISTENED boundPort=8080.
function looksNumeric(value: string): boolean {
    if (value.length === 0) return false;
    return !Number.isNaN(Number(value));
}

// Node throws RangeError ERR_SOCKET_BAD_PORT synchronously:
//   options.port should be >= 0 and < 65536. Received type number (-1).
// cno performed NO validation, so the value went straight to bind() and was
// silently coerced by the C layer — measured misbinds:
//   listen(-1)    -> bound 65535       listen(65536) -> bound an ephemeral port
//   listen(1.5)   -> bound 1           listen(NaN)   -> bound an ephemeral port
// A server asked for one port and silently listening on another is a security
// as well as a correctness problem.
function validateListenPort(value: unknown): number {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535) {
        return value;
    }
    const shown = typeof value === 'number' ? String(value) : JSON.stringify(value);
    throw Object.assign(
        new RangeError(`options.port should be >= 0 and < 65536. Received type ${typeof value} (${shown}).`),
        { code: 'ERR_SOCKET_BAD_PORT' },
    );
}

Server.prototype.listen = function listen(
    this: Server,
    portOrPathOrOptions?: unknown,
    ...args: Array<string | number | (() => void)>
): Server {
    if (this._listening || this._closing) {
        throw Object.assign(new Error('Listen method has been called more than once without closing'), {
            code: 'ERR_SERVER_ALREADY_LISTEN',
        });
    }

    let port: number | undefined;
    let host: string = '0.0.0.0';
    let backlog: number = 511;
    let listeningListener: (() => void) | undefined;
    let ipv6Only: boolean = false;

    // Normalize the first argument the way Node's normalizeArgs does, BEFORE
    // dispatching on its type. Measured on Node v24.18:
    //   listen(undefined) / listen(null) -> bind an ephemeral port (cno: hung
    //     silently — no 'listening', no 'error', nothing at all)
    //   listen('8080')                   -> TCP port 8080, not a pipe
    //   listen(true) / listen({})        -> throw ERR_INVALID_ARG_VALUE
    // Consume the explicit-path flag on entry so it can never leak into a later
    // call, even if this one throws.
    const explicitPipePath = forcePipePath;
    forcePipePath = false;

    if (portOrPathOrOptions === undefined || portOrPathOrOptions === null) {
        portOrPathOrOptions = 0;
    } else if (
        typeof portOrPathOrOptions === 'string'
        && !explicitPipePath
        && looksNumeric(portOrPathOrOptions)
    ) {
        portOrPathOrOptions = Number(portOrPathOrOptions);
    } else if (
        typeof portOrPathOrOptions === 'boolean'
        || typeof portOrPathOrOptions === 'bigint'
        || typeof portOrPathOrOptions === 'symbol'
    ) {
        throw Object.assign(
            new TypeError(`The argument 'options' is invalid. Received { port: ${String(portOrPathOrOptions)} }`),
            { code: 'ERR_INVALID_ARG_VALUE' },
        );
    }

    if (typeof portOrPathOrOptions === 'number') {
        port = validateListenPort(portOrPathOrOptions);
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
            this._handleClosed = false;
            this._pipe.bind(pipePath);
            this._pipe.listen(backlog ?? 511);
            this._pipe.onconnection = (error: CModuleError.Error | undefined, client: CModuleStreams.Stream | undefined) => {
                if (error) {
                    if (!this._listening || matchesErrnoCode(error, 'ECANCELED', 'EBADF')) return;
                    // Raw native errors carry a NUMERIC `.code`; normalize so
                    // `err.code === 'EMFILE'` works as it does in Node.
                    this.emit('error', normalizeErrnoError(error, 'accept'));
                    return;
                }
                if (!client) return;
                const socket = new Socket({ allowHalfOpen: this._allowHalfOpen });
                socket._stream = client as CModuleStreams.Pipe;
                socket.readyState = 'open';
                if (!trackServerSocket(this, socket)) return;
                configureAcceptedSocket(this, socket);
                this.emit('connection', socket);
                // Node publishes net.server.socket directly after emit('connection').
                if (onNetServerSocket.hasSubscribers) {
                    onNetServerSocket.publish({ socket });
                }
                if (!this._pauseOnConnect && !socket._destroyed) socket._startPipeRead();
            };
            // Node returns the bare path string from address() for a pipe
            // server, not an AddressInfo object (verified on real Node v24.18).
            this._address = pipePath;
            this._listening = true;
            if (listeningListener) this.once('listening', listeningListener);
            emitListeningAsync(this);
        } catch (err) {
            this._handleClosed = true;
            closePipeQuietly(this._pipe);
            emitListenErrorAsync(this, toListenError(err, pipePath));
        }
        return this;
    } else if (portOrPathOrOptions && typeof portOrPathOrOptions === 'object') {
        const options = portOrPathOrOptions as ListenOptions;
        if (options.path !== undefined) {
            const listener = typeof args[0] === 'function' ? args[0] : undefined;
            // An explicit path stays a path even if it looks numeric.
            forcePipePath = true;
            const server = listener
                ? this.listen(options.path, options.backlog ?? 511, listener)
                : this.listen(options.path, options.backlog ?? 511);
            forcePipePath = false;
            if (options.signal) {
                if (options.signal.aborted) queueMicrotask(() => server.close());
                else options.signal.addEventListener('abort', () => server.close(), { once: true });
            }
            return server;
        }
        // Node validates options.port identically to the positional form:
        // `listen({port:-1})` throws RangeError ERR_SOCKET_BAD_PORT.
        port = options.port === undefined || options.port === null
            ? 0
            : validateListenPort(
                typeof options.port === 'string' && looksNumeric(options.port)
                    ? Number(options.port)
                    : options.port,
            );
        host = options.host ?? '0.0.0.0';
        backlog = options.backlog ?? 511;
        ipv6Only = options.ipv6Only ?? false;
        if (typeof args[0] === 'function') listeningListener = args[0];
        if (options.signal) {
            if (options.signal.aborted) queueMicrotask(() => this.close());
            else options.signal.addEventListener('abort', () => this.close(), { once: true });
        }
    }

    host = normalizeTcpHost(host);
    const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
    this._tcp = new streams.TCP(family);

    try {
        this._handleClosed = false;
        this._tcp.bind({ ip: host, port: port ?? 0 }, ipv6Only ? streams.TCP_IPV6ONLY : 0);
        this._tcp.listen(backlog);
        const info = this._tcp.sockname;
        this._address = {
            address: info.ip,
            family: `IPv${info.family}`,
            port: info.port,
        };

        this._listening = true;
        this._acceptLoop().catch((err) => {
            if (this._listening) this.emit('error', normalizeErrnoError(err, 'accept'));
        });
        // Node registers the listen callback as a one-shot 'listening' listener
        // *inside* listen(), so a pre-existing s.on('listening') handler runs
        // first; then it emits on the next tick, never inline.
        if (listeningListener) this.once('listening', listeningListener);
        emitListeningAsync(this);
    } catch (err) {
        // Close the handle before surfacing the error: close() refuses to run
        // (ERR_SERVER_NOT_RUNNING) while _listening is false, so the common
        // EADDRINUSE retry idiom would overwrite _tcp and leak this fd.
        this._handleClosed = true;
        try { this._tcp?.close(); } catch { /* already gone */ }
        emitListenErrorAsync(this, toListenError(err, host, port ?? 0));
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

        const socket = new Socket({ allowHalfOpen: this._allowHalfOpen });
        socket._tcp = clientTcp;
        socket.readyState = 'open';

        const localInfo = (clientTcp as CModuleStreams.TCP).sockname;
        socket.localAddress = localInfo.ip;
        socket.localPort = localInfo.port;

        const remoteInfo = (clientTcp as CModuleStreams.TCP).peername;
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

        if (!trackServerSocket(this, socket)) return;
        configureAcceptedSocket(this, socket);

        this.emit('connection', socket);

        // Node publishes net.server.socket directly after emit('connection').
        if (onNetServerSocket.hasSubscribers) {
            onNetServerSocket.publish({ socket });
        }

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
    if (this._closing) {
        if (callback) this._closeCallbacks.push(callback);
        return this;
    }
    if (!this._listening) {
        if (callback) {
            const error = Object.assign(new Error('Server is not running'), { code: 'ERR_SERVER_NOT_RUNNING' });
            queueMicrotask(() => callback(error));
        }
        return this;
    }

    this._listening = false;
    this._closing = true;
    this._address = null;
    if (callback) this._closeCallbacks.push(callback);

    const handles: Array<CModuleStreams.TCP | CModuleStreams.Pipe> = [];
    if (this._tcp) handles.push(this._tcp);
    if (this._pipe) handles.push(this._pipe);
    let pendingHandles = handles.length;
    this._handleClosed = pendingHandles === 0;

    const onHandleClose = (): void => {
        pendingHandles--;
        if (pendingHandles === 0) {
            this._handleClosed = true;
            finishServerClose(this);
        }
    };

    if (this._tcp) {
        const handle = this._tcp;
        handle.onclose = onHandleClose;
        try {
            handle.close();
        } catch {
            onHandleClose();
        }
        this._tcp = null;
    }
    if (this._pipe) {
        const handle = this._pipe;
        handle.onclose = onHandleClose;
        try {
            handle.close();
        } catch {
            onHandleClose();
        }
        this._pipe = null;
    }

    finishServerClose(this);

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

export function connect(options: NetConnectOpts, connectListener?: () => void): Socket;
export function connect(port: number, host?: string, connectListener?: () => void): Socket;
export function connect(path: string, connectListener?: () => void): Socket;
export function connect(portOrPath: number | string | NetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): Socket {
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

export function createConnection(options: NetConnectOpts, connectListener?: () => void): Socket;
export function createConnection(port: number, host?: string, connectListener?: () => void): Socket;
export function createConnection(path: string, connectListener?: () => void): Socket;
export function createConnection(portOrPath: number | string | NetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): Socket {
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
    const parts = parseIpv6Parts(address);
    if (!parts) return null;
    let value = 0n;
    for (const part of parts) {
        value = (value << 16n) + BigInt(part);
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
    family?: 'ipv4' | 'ipv6';
    flowlabel?: number;
}

export class SocketAddress {
    readonly address: string;
    readonly port: number;
    readonly family: 'ipv4' | 'ipv6';
    readonly flowlabel: number;

    constructor(options?: SocketAddressInit) {
        const opts = options ?? {};
        if (opts.family !== undefined && opts.family !== 'ipv4' && opts.family !== 'ipv6') {
            throw new TypeError(`The property 'options.family' is invalid. Received ${String(opts.family)}`);
        }
        const family: 'ipv4' | 'ipv6' = opts.family ?? 'ipv4';

        const address = opts.address ?? (family === 'ipv6' ? '::' : '127.0.0.1');
        if ((family === 'ipv4' && !isIPv4(address)) || (family === 'ipv6' && !isIPv6(address))) {
            throw new TypeError('Invalid socket address');
        }

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
    if (typeof input !== 'string') return false;
    const parts = input.split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => {
        if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
        const num = Number(part);
        return num <= 255;
    });
}

function parseIpv6Parts(input: string): number[] | null {
    if (typeof input !== 'string') return null;
    const zoneIndex = input.indexOf('%');
    const address = zoneIndex === -1 ? input : input.slice(0, zoneIndex);
    if (zoneIndex !== -1 && (zoneIndex === input.length - 1 || input.indexOf('%', zoneIndex + 1) !== -1)) return null;
    if (!address.includes(':')) return null;

    const compression = address.indexOf('::');
    if (compression !== -1 && address.indexOf('::', compression + 2) !== -1) return null;
    const leftText = compression === -1 ? address : address.slice(0, compression);
    const rightText = compression === -1 ? '' : address.slice(compression + 2);
    const left = leftText ? leftText.split(':') : [];
    const right = rightText ? rightText.split(':') : [];
    if (left.some(part => part === '') || right.some(part => part === '')) return null;

    const parseSide = (parts: string[], isRight: boolean): number[] | null => {
        const values: number[] = [];
        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            if (part.includes('.')) {
                const isLastPart = index === parts.length - 1 && (isRight || right.length === 0);
                if (!isLastPart || !isIPv4(part)) return null;
                const bytes = part.split('.').map(Number);
                values.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
                continue;
            }
            if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
            values.push(Number.parseInt(part, 16));
        }
        return values;
    };

    const leftValues = parseSide(left, false);
    const rightValues = parseSide(right, true);
    if (!leftValues || !rightValues) return null;
    const supplied = leftValues.length + rightValues.length;
    if (compression === -1) return supplied === 8 ? leftValues : null;
    if (supplied >= 8) return null;
    return [...leftValues, ...Array(8 - supplied).fill(0), ...rightValues];
}

export function isIPv6(input: string): boolean {
    return parseIpv6Parts(input) !== null;
}
