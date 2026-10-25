/**
 * Node.js dgram module, over CModuleUDP for UDP datagrams.
 */

const udp = import.meta.use('udp');
const os = import.meta.use('os');
const sock = import.meta.use('socket');
const engine = import.meta.use('engine');

import { EventEmitter } from '../events';
import { Buffer } from '../buffer';
import { toErrnoException, uvSystemError } from '../_internal/errno';
import { flattenPrototype } from '../_internal/prototype';
import { tryCloseQuietly } from '../_internal/close';
import {
    errnoError,
    makeError,
    normalizeMessage,
    notRunning,
    sliceBuffer,
    validateBufferList,
    validateNumber,
    validatePort,
    validateSocketType,
    validateString,
    viewToBytes,
} from '../util/dgram-validate';

/*
 * IP-level socket option numbers. The native `socket` module only exposes
 * IPPROTO_IP/SOL_SOCKET/SO_*, and these are ABI values that differ between
 * Windows/BSD and Linux (e.g. IP_TTL 4 vs 2), so the tables cannot be shared.
 */
const _isLinux = os.platform === 'linux';

const IPPROTO_IPV6 = 41;

const IP_TTL = _isLinux ? 2 : 4;
const IP_MULTICAST_IF = _isLinux ? 32 : 9;
const IP_MULTICAST_TTL = _isLinux ? 33 : 10;
const IP_MULTICAST_LOOP = _isLinux ? 34 : 11;
const IP_ADD_MEMBERSHIP = _isLinux ? 35 : 12;
const IP_DROP_MEMBERSHIP = _isLinux ? 36 : 13;

const IPV6_UNICAST_HOPS = _isLinux ? 16 : 4;
const IPV6_MULTICAST_IF = _isLinux ? 17 : 9;
const IPV6_MULTICAST_HOPS = _isLinux ? 18 : 10;
const IPV6_MULTICAST_LOOP = _isLinux ? 19 : 11;
const IPV6_ADD_MEMBERSHIP = _isLinux ? 20 : 12;
const IPV6_DROP_MEMBERSHIP = _isLinux ? 21 : 13;

/**
 * Resolve the (level, option) pair for a logical socket option, picking the
 * IPv6 protocol level for udp6 sockets the way libuv's uv_udp_set_* helpers do.
 */
function ipOpt(self: Socket, v4: number, v6: number): [number, number] {
    return self._type === 'udp6'
        ? [IPPROTO_IPV6, v6]
        : [sock.defines.IPPROTO_IP, v4];
}

// Paths to a PosixSocket from UDP's fd. We cache the fd at init time since
// fileno() is async but socket options are set via sync methods
function _getFd(handle: CModuleUDP.UDP): number {
    return handle.fileno();
}

function _getSocket(handle: CModuleUDP.UDP): CModuleSocket.PosixSocket | null {
    const fd = _getFd(handle);
    if (fd < 0) return null;
    try {
        return sock.socket_from_fd(fd);
    } catch {
        return null;
    }
}

// Type definitions

export interface AddressInfo {
    address: string;
    family: string;
    port: number;
}

export interface RemoteInfo {
    address: string;
    family: 'IPv4' | 'IPv6';
    port: number;
    size: number;
}

export interface BindOptions {
    port?: number;
    address?: string;
    exclusive?: boolean;
    fd?: number;
    signal?: AbortSignal;
}

export interface SocketOptions {
    type: 'udp4' | 'udp6';
    reuseAddr?: boolean;
    ipv6Only?: boolean;
    recvBufferSize?: number;
    sendBufferSize?: number;
    lookup?: (hostname: string, options: { family?: 4 | 6 }, callback: (err: Error | null, address: string, family: number) => void) => void;
    signal?: AbortSignal;
}

// Socket class

/**
 * Decorate a native bind/connect failure for delivery through a callback or an
 * 'error' event: Node's shape carries `address`/`port`, unlike uvSystemError.
 */
function bindConnectError(err: unknown, code: string, syscall: string, detail: { address: string; port?: number }): NodeJS.ErrnoException {
    const out = toErrnoException(err, syscall);
    // Non-native failures (e.g. ERR_SOCKET_DGRAM_NOT_RUNNING) keep their own message.
    const shaped = typeof Reflect.get(out, 'errno') === 'number' ? errnoError(code, syscall, detail) : out;
    Reflect.set(shaped, 'address', detail.address);
    if (detail.port) Reflect.set(shaped, 'port', detail.port);
    return shaped;
}

function healthCheck(self: Socket): CModuleUDP.UDP {
    if (!self._handle) throw notRunning();
    return self._handle;
}

/**
 * Socket options need a live OS socket: libuv's Windows backend returns
 * UV_EBADF from uv_udp_set_ttl/set_broadcast/set_multicast_* on an unmaterialized
 * socket. uv_udp_set_membership and the buffer-size calls deferred-bind instead,
 * so they must NOT go through here.
 */
function boundOptionSocket(self: Socket, syscall: string): CModuleSocket.PosixSocket {
    healthCheck(self);
    if (!self._materialized) throw errnoError('EBADF', syscall);
    const handle = self._handle;
    const s = handle ? _getSocket(handle) : null;
    if (!s) throw errnoError('EBADF', syscall);
    return s;
}

function applySockOpt(s: CModuleSocket.PosixSocket, syscall: string, level: number, option: number, value: Uint8Array): void {
    try {
        s.setopt(level, option, value);
    } catch (err) {
        throw normalizeSockOptError(err, syscall);
    }
}

function setSockOpt(self: Socket, syscall: string, level: number, option: number, value: Uint8Array): void {
    applySockOpt(boundOptionSocket(self, syscall), syscall, level, option, value);
}

/**
 * The `socket` C module reports setsockopt/getsockopt failures on Windows as a
 * bare `InternalError: WSA error <n>` with no .code/.errno, so the UV name is
 * recovered from the message. Anything unlisted falls through to UNKNOWN.
 */
const WSA_TO_UV: Record<number, string> = {
    10009: 'EBADF', // WSAEBADF
    10013: 'EACCES', // WSAEACCES
    10014: 'EFAULT', // WSAEFAULT
    10022: 'EINVAL', // WSAEINVAL
    10024: 'EMFILE', // WSAEMFILE
    10035: 'EAGAIN', // WSAEWOULDBLOCK
    10038: 'ENOTSOCK', // WSAENOTSOCK
    10042: 'ENOPROTOOPT', // WSAENOPROTOOPT
    10047: 'EAFNOSUPPORT', // WSAEAFNOSUPPORT
    10048: 'EADDRINUSE', // WSAEADDRINUSE
    10049: 'EADDRNOTAVAIL', // WSAEADDRNOTAVAIL
    10050: 'ENETDOWN', // WSAENETDOWN
    10051: 'ENETUNREACH', // WSAENETUNREACH
    10055: 'ENOBUFS', // WSAENOBUFS
    10056: 'EISCONN', // WSAEISCONN
    10057: 'ENOTCONN', // WSAENOTCONN
};

/** Best-effort UV code for an error raised by the `socket` module. */
function sockErrCode(err: unknown, syscall: string): string {
    const normalized = toErrnoException(err, syscall);
    if (normalized.code && normalized.code !== 'UNKNOWN') return normalized.code;
    const message = err instanceof Error ? err.message : String(err);
    const match = /WSA error (\d+)/.exec(message);
    if (match) {
        const mapped = WSA_TO_UV[Number(match[1])];
        if (mapped) return mapped;
    }
    return normalized.code ?? 'UNKNOWN';
}

function normalizeSockOptError(err: unknown, syscall: string): NodeJS.ErrnoException {
    return errnoError(sockErrCode(err, syscall), syscall);
}

/**
 * libuv's uv__udp_set_membership4/6 and the buffer-size calls run
 * uv__udp_maybe_bind() first, so joining a group on a never-bound socket
 * implicitly binds it to the wildcard address with SO_REUSEADDR. Mirror it, but
 * do NOT emit 'listening' or start the recv loop, and leave `_bound` false.
 */
function maybeBind(self: Socket): void {
    if (self._materialized) return;
    const handle = healthCheck(self);
    handle.bind(
        { ip: self._type === 'udp6' ? '::' : '0.0.0.0', port: 0 },
        udp.UDP_REUSEADDR,
    );
    self._materialized = true;
}

function uint32le(value: number): Uint8Array {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value >>> 0, true);
    return buf;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * `uv_udp_set_ttl` range-checks 1..255 before touching the socket, so an
 * out-of-range value reports EINVAL even on an unbound socket. Multicast TTL
 * has no such check on Windows — Node happily returns 0/-1 there.
 */
function validateTTL(ttl: unknown): number {
    validateNumber(ttl, 'ttl');
    if (ttl < 1 || ttl > 255) throw errnoError('EINVAL', 'setTTL');
    return ttl;
}

/** Pack an IPv4 dotted quad into `offset..offset+4` of `target`. */
function packIPv4(target: Uint8Array, offset: number, address: string): void {
    const parts = address.split('.');
    if (parts.length !== 4) return;
    for (let i = 0; i < 4; i++) target[offset + i] = parseInt(parts[i], 10) & 0xff;
}

export interface Socket extends EventEmitter {
    readonly isIPv6: boolean;
    type: 'udp4' | 'udp6';
    _handle: CModuleUDP.UDP | null;
    _type: 'udp4' | 'udp6';
    _reuseAddr: boolean;
    _ipv6Only: boolean;
    _bound: boolean;
/**
 * Whether the underlying OS socket exists, as opposed to whether bind() was
 * called. cno creates the SOCKET eagerly in uv_udp_init_ex; Node leaves it
 * INVALID_SOCKET until bind() or a deferred-bind option materialises it, and
 * socket options observe that (EBADF). Track it instead of reusing _bound.
 */
    _materialized: boolean;
    _binding: boolean;
    _bindPromise: Promise<void> | null;
    _connected: boolean;
    _connecting: boolean;
    _address: AddressInfo | null;
    _remoteAddress: AddressInfo | null;
    _recvBufferSize: number;
    _sendBufferSize: number;
    _refd: boolean;
    _init(): Promise<void>;
    _ensureBound(): Promise<void>;
    bind(port?: number, address?: string, callback?: () => void): this;
    bind(options: BindOptions, callback?: () => void): this;
    _doBind(portOrOptions?: number | BindOptions, addressOrCallback?: string | (() => void), callback?: () => void): Promise<void>;
    _startRecv(): Promise<void>;
    send(msg: string | Uint8Array | Array<string | Uint8Array>, offset: number, length: number, port: number, address?: string, callback?: (error: Error | null, bytes?: number) => void): void;
    send(msg: string | Uint8Array | Array<string | Uint8Array>, offset: number, length: number, callback?: (error: Error | null, bytes?: number) => void): void;
    send(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, address?: string, callback?: (error: Error | null, bytes?: number) => void): void;
    send(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, address: string, callback: (error: Error | null, bytes?: number) => void): void;
    send(msg: string | Uint8Array | Array<string | Uint8Array>, callback?: (error: Error | null, bytes?: number) => void): void;
    _doSend(request: SendRequest): Promise<void>;
    connect(port: number, address?: string, callback?: () => void): void;
    _doConnect(port: number, address?: string, callback?: () => void): Promise<void>;
    disconnect(): void;
    address(): AddressInfo | null;
    remoteAddress(): AddressInfo | null;
    setBroadcast(flag: boolean): void;
    setTTL(ttl: number): number;
    setMulticastTTL(ttl: number): number;
    setMulticastInterface(multicastInterface?: string): void;
    setMulticastLoopback(flag: boolean): boolean;
    addMembership(multicastAddress: string, multicastInterface?: string): void;
    dropMembership(multicastAddress: string, multicastInterface?: string): void;
    addSourceSpecificMembership(sourceAddress: string, groupAddress: string, multicastInterface?: string): void;
    dropSourceSpecificMembership(sourceAddress: string, groupAddress: string, multicastInterface?: string): void;
    getRecvBufferSize(): number;
    setRecvBufferSize(size: number): void;
    getSendBufferSize(): number;
    setSendBufferSize(size: number): void;
    ref(): this;
    unref(): this;
    close(callback?: () => void): this;
    _doClose(callback?: () => void): Promise<void>;
}

export interface SocketConstructor {
    new (type: 'udp4' | 'udp6', reuseAddr?: boolean, ipv6Only?: boolean): Socket;
    (type: 'udp4' | 'udp6', reuseAddr?: boolean, ipv6Only?: boolean): Socket;
    prototype: Socket;
}

function initSocket(self: Socket, type: 'udp4' | 'udp6', reuseAddr?: boolean, ipv6Only?: boolean): void {
    validateSocketType(type);
    EventEmitter.call(self);
    // State-dependent errors (EBADF vs ERR_SOCKET_DGRAM_NOT_RUNNING) hinge on
    // close(), not on lazy materialization.
    self._handle = new udp.UDP(type === 'udp6' ? os.AF_INET6 : os.AF_INET);
    self._bound = false;
    self._materialized = false;
    self._binding = false;
    self._bindPromise = null;
    self._connected = false;
    self._connecting = false;
    self._address = null;
    self._remoteAddress = null;
    self._recvBufferSize = 65536;
    self._sendBufferSize = 65536;
    self._refd = true;
    self._type = type;
    self.type = type;
    self._reuseAddr = reuseAddr ?? false;
    self._ipv6Only = ipv6Only ?? false;
    Object.defineProperty(self, 'isIPv6', { value: type === 'udp6', enumerable: true });
}

export const Socket: SocketConstructor = function Socket(this: unknown, type: 'udp4' | 'udp6', reuseAddr?: boolean, ipv6Only?: boolean) {
    const target: Socket = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Socket.prototype);
    initSocket(target, type, reuseAddr, ipv6Only);
    return target;
} as SocketConstructor;

Object.setPrototypeOf(Socket, EventEmitter);
Socket.prototype = Object.create(EventEmitter.prototype);

Socket.prototype._init = async function _init(this: Socket): Promise<void> {
    // The handle is created in the constructor; a closed socket must not be
    // resurrected (Node reports ERR_SOCKET_DGRAM_NOT_RUNNING instead).
    if (!this._handle) throw notRunning();
};

Socket.prototype.bind = function bind(this: Socket, portOrOptions?: number | BindOptions, addressOrCallback?: string | (() => void), callback?: () => void): Socket {
    healthCheck(this);
    if (this._bound || this._binding) {
        throw makeError('Socket is already bound', 'ERR_SOCKET_ALREADY_BOUND');
    }
    this._binding = true;
    // Asynchronously bind
    this._bindPromise = this._doBind(portOrOptions, addressOrCallback, callback);
    this._bindPromise.catch(() => { /* surfaced via the 'error' event */ });
    return this;
};

/**
 * Node implicitly binds to an ephemeral port on the first send from an unbound
 * socket, which is what makes address() usable afterwards.
 */
Socket.prototype._ensureBound = async function _ensureBound(this: Socket): Promise<void> {
    if (this._bound) return;
    if (!this._binding) {
        this._binding = true;
        this._bindPromise = this._doBind(0);
        this._bindPromise.catch(() => { /* surfaced via the 'error' event */ });
    }
    await this._bindPromise;
};

Socket.prototype._doBind = async function _doBind(this: Socket, portOrOptions?: number | BindOptions, addressOrCallback?: string | (() => void), callback?: () => void): Promise<void> {
    let port: number = 0;
    let address: string = this._type === 'udp6' ? '::' : '0.0.0.0';
    let cb: (() => void) | undefined;

    if (typeof portOrOptions === 'object' && portOrOptions !== null) {
        port = portOrOptions.port ?? 0;
        address = portOrOptions.address ?? address;
        cb = addressOrCallback as (() => void) | undefined;
        if (portOrOptions.signal) {
            portOrOptions.signal.addEventListener('abort', () => {
                tryCloseQuietly(this);
            });
        }
    } else {
        port = portOrOptions ?? 0;
        if (typeof addressOrCallback === 'string') {
            address = addressOrCallback;
        } else if (typeof addressOrCallback === 'function') {
            cb = addressOrCallback;
        }
        if (callback) cb = callback;
    }

    try {
        const handle = this._handle;
        if (!handle) throw notRunning();

        const flags = (this._ipv6Only ? udp.UDP_IPV6ONLY : 0) |
            (this._reuseAddr ? udp.UDP_REUSEADDR : 0);

        try {
            handle.bind({ ip: address, port }, flags);
        } catch (err) {
            throw bindConnectError(err, toErrnoException(err, 'bind').code ?? 'UNKNOWN', 'bind', { address, port });
        }
        this._binding = false;
        this._bound = true;
        this._materialized = true;

        const sockname = handle.getsockname();
        this._address = {
            address: sockname.ip ?? address,
            family: this._type === 'udp6' ? 'IPv6' : 'IPv4',
            port: sockname.port ?? port,
        };

        this.emit('listening');
        cb?.();

        // Start receiving
        this._startRecv();
    } catch (err) {
        this._binding = false;
        this.emit('error', asError(err));
        throw asError(err);
    }
};

Socket.prototype._startRecv = async function _startRecv(this: Socket): Promise<void> {
    if (!this._handle || !this._bound) return;

    const buffer = new Uint8Array(this._recvBufferSize);

    while (this._handle && this._bound) {
        try {
            const result = await this._handle.recv(buffer);
            // A zero-length datagram is a real message and Node emits it. The C
            // layer only resolves when a packet actually arrived (libuv's
            // nread==0 && addr==NULL "nothing to read" case is swallowed
            // there), so presence of an address is what marks a datagram.
            if (result.addr && result.nread >= 0) {
                const msg = Buffer.from(buffer.subarray(0, result.nread));
                const rinfo: RemoteInfo = {
                    address: result.addr.ip ?? '',
                    family: result.addr.family === 6 ? 'IPv6' : 'IPv4',
                    port: result.addr.port ?? 0,
                    size: result.nread,
                };
                this.emit('message', msg, rinfo);
            }
        } catch (err) {
            if (this._handle) {
                this.emit('error', err);
            }
            // Stop the recv loop on error so we don't busy-loop on a persistent failure
            break;
        }
    }
};

const DEFAULT_ADDRESS = '127.0.0.1';
const DEFAULT_ADDRESS6 = '::1';

type SendCallback = (error: Error | null, bytes?: number) => void;

interface SendRequest {
    data: Uint8Array;
    port?: number;
    address?: string;
    connected?: boolean;
    callback?: SendCallback;
}

function encodeMessage(msg: unknown): Uint8Array {
    return joinChunks(normalizeMessage(msg));
}

/** Copies each chunk: the result must not alias the caller's memory. */
function joinChunks(list: readonly Uint8Array[]): Uint8Array {
    let total = 0;
    for (const chunk of list) total += chunk.byteLength;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of list) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return data;
}

/** A send() argument list, named by the layout Node's positional dispatch selects. */
type SendLayout = 'slice' | 'destination' | 'connectedSlice' | 'connected';

interface SendLayoutSpec {
    /** Position of the port, or of `length` in the offset/length forms. */
    portIndex: number;
    /** Whether `send()` passes the message through `sliceBuffer` first. */
    sliced: boolean;
}

const isNumber = (value: unknown) => typeof value === 'number';

/**
 * Node picks the layout from the types of the first three arguments after the
 * message, and from whether the socket is connected (see docs/node-internals.md
 * #dgram-send-layout).
 */
const SEND_LAYOUTS: Record<SendLayout, SendLayoutSpec & { matches: (args: readonly unknown[]) => boolean }> = {
    slice: {
        portIndex: 2,
        sliced: true,
        matches: ([first, second, third]) => isNumber(first) && isNumber(second) && isNumber(third),
    },
    destination: { portIndex: 0, sliced: false, matches: () => true },
    connectedSlice: {
        portIndex: 2,
        sliced: true,
        matches: ([first, second, third]) => isNumber(first) && isNumber(second) && !isNumber(third),
    },
    connected: { portIndex: 0, sliced: false, matches: () => true },
};

function sendLayout(args: readonly unknown[], connected: boolean): SendLayoutSpec {
    const candidates: SendLayout[] = connected ? ['connectedSlice', 'connected'] : ['slice', 'destination'];
    return SEND_LAYOUTS[candidates.find((name) => SEND_LAYOUTS[name].matches(args))!];
}

/** Node's `sliceBuffer`, over the message as a string or a view. */
function sliceSendMessage(msg: string | ArrayBufferView, offset: unknown, length: unknown): Uint8Array {
    const bytes = typeof msg === 'string' ? engine.encodeString(msg) : viewToBytes(msg);
    return sliceBuffer(bytes, offset, length);
}

/** Resolves the address and callback of a send that names a destination. */
function readDestination(next: unknown, tail: unknown, type: 'udp4' | 'udp6'): { address: string; callback?: SendCallback } {
    if (next != null && typeof next !== 'function') validateString(next, 'address');
    const target = (typeof next === 'string' ? next : undefined) || (type === 'udp6' ? DEFAULT_ADDRESS6 : DEFAULT_ADDRESS);
    const callback = typeof next === 'function' ? next : typeof tail === 'function' ? tail : undefined;

    validateString(target, 'address');
    return { address: target, callback: callback as SendCallback | undefined };
}

/**
 * Node's `send()` dispatch. The layout decides which arguments were meant as
 * offset/length and which as port/address/callback; every layout is then read
 * with the same connected check, port validation and destination tail.
 */
function normalizeSendArgs(
    socket: Socket,
    msg: string | Uint8Array | Array<string | Uint8Array>,
    args: unknown[],
): SendRequest {
    const connected = socket._connected || socket._connecting;
    const { portIndex, sliced } = sendLayout(args, connected);
    const next = args[portIndex + 1];
    const tail = args[portIndex + 2];

    if (connected) {
        // The destination check precedes every other check, buffer included.
        const destination = portIndex === 0
            ? next !== undefined && typeof next !== 'function'
            : tail !== undefined;
        if (destination) throw makeError('Already connected', 'ERR_SOCKET_DGRAM_IS_CONNECTED');
        if (sliced) msg = sliceSendMessage(msg, args[0], args[1]) as typeof msg;
        // Connected sends put the callback where an unconnected send puts its port.
        const cb = args[portIndex];
        return { data: encodeMessage(msg), connected: true, callback: typeof cb === 'function' ? cb as SendCallback : undefined };
    }

    if (sliced) msg = sliceSendMessage(msg, args[0], args[1]) as typeof msg;
    else validateBufferList(msg);
    const data = encodeMessage(msg);
    const port = validatePort(args[portIndex], 'Port', false);
    return { data, port, ...readDestination(next, tail, socket._type) };
}

Socket.prototype.send = function send(this: Socket, msg: string | Uint8Array | Array<string | Uint8Array>, ...args: unknown[]): void {
    const request = normalizeSendArgs(this, msg, args);
    healthCheck(this);
    this._doSend(request);
};

Socket.prototype._doSend = async function _doSend(this: Socket, request: SendRequest): Promise<void> {
    const { data, port, address, callback, connected } = request;

    try {
        if (!this._handle) throw notRunning();
        // Node implicitly binds before the first send so that address() works
        // and the receive loop is running.
        await this._ensureBound();
        const handle = this._handle;
        if (!handle) throw notRunning();

        const target = connected
            ? undefined
            : address !== undefined && port !== undefined
            ? { ip: address, port }
            : undefined;
        if (!connected && !target) throw new TypeError('Address and port are required');
        const bytes = await handle.send(data, target);
        callback?.(null, bytes);
    } catch (err) {
        const normalized = toErrnoException(err, 'send');
        if (callback) {
            callback(normalized);
        } else if (this.listenerCount('error') > 0) {
            this.emit('error', normalized);
        }
    }
};

Socket.prototype.connect = function connect(this: Socket, port: number, address?: string, callback?: () => void): void {
    healthCheck(this);
    if (this._connected || this._connecting) {
        throw makeError('Already connected', 'ERR_SOCKET_DGRAM_IS_CONNECTED');
    }
    const validatedPort = validatePort(port, 'Port', false);
    if (address !== undefined && typeof address !== 'function') validateString(address, 'address');
    this._connecting = true;
    this._doConnect(validatedPort, typeof address === 'function' ? undefined : address, typeof address === 'function' ? address : callback);
};

Socket.prototype._doConnect = async function _doConnect(this: Socket, port: number, address?: string, callback?: () => void): Promise<void> {
    try {
        if (!this._handle) throw notRunning();
        // Connecting an unbound socket binds it first, exactly as send() does.
        await this._ensureBound();
        const handle = this._handle;
        if (!handle) throw notRunning();

        const addr = address ?? (this._type === 'udp6' ? DEFAULT_ADDRESS6 : DEFAULT_ADDRESS);

        try {
            handle.connect({ ip: addr, port });
        } catch (err) {
            throw bindConnectError(err, toErrnoException(err, 'connect').code ?? 'UNKNOWN', 'connect', { address: addr, port });
        }
        this._connecting = false;
        this._connected = true;

        const peername = handle.getpeername();
        this._remoteAddress = {
            address: peername.ip ?? addr,
            family: this._type === 'udp6' ? 'IPv6' : 'IPv4',
            port: peername.port ?? port,
        };

        this.emit('connect');
        callback?.();
    } catch (err) {
        this._connecting = false;
        this.emit('error', asError(err));
    }
};

Socket.prototype.disconnect = function disconnect(this: Socket): void {
    if (!this._connected) {
        throw makeError('Not connected', 'ERR_SOCKET_DGRAM_NOT_CONNECTED');
    }
    this._handle?.disconnect();
    this._connected = false;
    this._connecting = false;
    this._remoteAddress = null;
};

Socket.prototype.address = function address(this: Socket): AddressInfo | null {
    const handle = healthCheck(this);
    // Node calls getsockname() on the handle unconditionally and only reports
    // EBADF when the SOCKET does not exist yet. A deferred-bind option (e.g.
    // addMembership) materialises it without going through bind(), so query the
    // handle rather than relying on the cached bind() result.
    if (!this._materialized) throw errnoError('EBADF', 'getsockname');
    if (!this._address) {
        try {
            const sockname = handle.getsockname();
            return {
                address: sockname.ip ?? (this._type === 'udp6' ? '::' : '0.0.0.0'),
                family: this._type === 'udp6' ? 'IPv6' : 'IPv4',
                port: sockname.port ?? 0,
            };
        } catch (err) {
            throw errnoError(toErrnoException(err, 'getsockname').code ?? 'EBADF', 'getsockname');
        }
    }
    return this._address;
};

Socket.prototype.remoteAddress = function remoteAddress(this: Socket): AddressInfo | null {
    if (!this._connected || !this._remoteAddress) throw makeError('Not connected', 'ERR_SOCKET_DGRAM_NOT_CONNECTED');
    return this._remoteAddress;
};

Socket.prototype.setBroadcast = function setBroadcast(this: Socket, flag: boolean): void {
    setSockOpt(this, 'setBroadcast', sock.defines.SOL_SOCKET, sock.defines.SO_BROADCAST, uint32le(flag ? 1 : 0));
};

Socket.prototype.setTTL = function setTTL(this: Socket, ttl: number): number {
    const value = validateTTL(ttl);
    const [level, option] = ipOpt(this, IP_TTL, IPV6_UNICAST_HOPS);
    setSockOpt(this, 'setTTL', level, option, uint32le(value));
    return value;
};

Socket.prototype.setMulticastTTL = function setMulticastTTL(this: Socket, ttl: number): number {
    // libuv's Windows SOCKOPT_SETTER validates BEFORE the INVALID_SOCKET check,
    // and VALIDATE_MULTICAST_TTL accepts -1..255 (wider than unicast TTL's
    // 1..255), so an out-of-range value yields EINVAL even when unbound.
    validateNumber(ttl, 'ttl');
    if (ttl < -1 || ttl > 255) throw errnoError('EINVAL', 'setMulticastTTL');
    const [level, option] = ipOpt(this, IP_MULTICAST_TTL, IPV6_MULTICAST_HOPS);
    setSockOpt(this, 'setMulticastTTL', level, option, uint32le(ttl));
    return ttl;
};

Socket.prototype.setMulticastInterface = function setMulticastInterface(this: Socket, multicastInterface?: string): void {
    healthCheck(this);
    // IPv4 takes an in_addr; IPv6 takes an unsigned interface index. Node
    // accepts a scoped literal like "::%2" for udp6 -- take the scope id.
    if (this._type === 'udp6') {
        let index = 0;
        if (multicastInterface !== undefined) {
            validateString(multicastInterface, 'interfaceAddress');
            const scope = multicastInterface.lastIndexOf('%');
            if (scope !== -1) index = parseInt(multicastInterface.slice(scope + 1), 10) || 0;
        }
        setSockOpt(this, 'setMulticastInterface', IPPROTO_IPV6, IPV6_MULTICAST_IF, uint32le(index));
    } else {
        const addr = new Uint8Array(4);
        if (multicastInterface !== undefined) {
            validateString(multicastInterface, 'interfaceAddress');
            packIPv4(addr, 0, multicastInterface);
        }
        setSockOpt(this, 'setMulticastInterface', sock.defines.IPPROTO_IP, IP_MULTICAST_IF, addr);
    }
};

Socket.prototype.setMulticastLoopback = function setMulticastLoopback(this: Socket, flag: boolean): boolean {
    const [level, option] = ipOpt(this, IP_MULTICAST_LOOP, IPV6_MULTICAST_LOOP);
    setSockOpt(this, 'setMulticastLoopback', level, option, uint32le(flag ? 1 : 0));
    return flag;
};

function membershipRequest(self: Socket, multicastAddress: unknown, multicastInterface: unknown): Uint8Array {
    healthCheck(self);
    if (!multicastAddress) {
        throw Object.assign(
            new TypeError('The "multicastAddress" argument must be specified'),
            { code: 'ERR_MISSING_ARGS' },
        );
    }
    validateString(multicastAddress, 'multicastAddress');
    const mreq = new Uint8Array(8);
    packIPv4(mreq, 0, multicastAddress);
    if (multicastInterface !== undefined) {
        validateString(multicastInterface, 'interfaceAddress');
        packIPv4(mreq, 4, multicastInterface);
    }
    return mreq;
}

function modifyMembership(self: Socket, syscall: string, v4: number, v6: number, mreq: Uint8Array): void {
    // uv__udp_set_membership4 deferred-binds before the setsockopt.
    maybeBind(self);
    const handle = healthCheck(self);
    const s = _getSocket(handle);
    if (!s) throw errnoError('EBADF', syscall);
    const [level, option] = ipOpt(self, v4, v6);
    applySockOpt(s, syscall, level, option, mreq);
}

Socket.prototype.addMembership = function addMembership(this: Socket, multicastAddress: string, multicastInterface?: string): void {
    modifyMembership(this, 'addMembership', IP_ADD_MEMBERSHIP, IPV6_ADD_MEMBERSHIP, membershipRequest(this, multicastAddress, multicastInterface));
};

Socket.prototype.dropMembership = function dropMembership(this: Socket, multicastAddress: string, multicastInterface?: string): void {
    modifyMembership(this, 'dropMembership', IP_DROP_MEMBERSHIP, IPV6_DROP_MEMBERSHIP, membershipRequest(this, multicastAddress, multicastInterface));
};

function unsupportedMembership(this: Socket, name: string): void {
    const emitWarning = Reflect.get(process, 'emitWarning');
    if (typeof emitWarning === 'function') Reflect.apply(emitWarning, process, [`dgram.${name}() is not fully supported in this runtime`, 'UnsupportedWarning']);
}

Socket.prototype.addSourceSpecificMembership = function addSourceSpecificMembership(this: Socket, _sourceAddress: string, _groupAddress: string, _multicastInterface?: string): void {
    // MCAST_JOIN_SOURCE_GROUP - C layer doesn't expose this constant
    unsupportedMembership(this, 'addSourceSpecificMembership');
};

Socket.prototype.dropSourceSpecificMembership = function dropSourceSpecificMembership(this: Socket, _sourceAddress: string, _groupAddress: string, _multicastInterface?: string): void {
    unsupportedMembership(this, 'dropSourceSpecificMembership');
};

/**
 * Buffer-size accessors on a never-bound socket. On Windows the SOCKET is still
 * INVALID, the call fails with ENOTSOCK, and Node rewraps it as
 * ERR_SOCKET_BUFFER_SIZE. This must not bind.
 */
function bufferSizeSocket(self: Socket, syscall: string): CModuleSocket.PosixSocket {
    const handle = healthCheck(self);
    if (!self._materialized) throw bufferSizeError('ENOTSOCK', syscall);
    const s = _getSocket(handle);
    if (!s) throw bufferSizeError('ENOTSOCK', syscall);
    return s;
}

function bufferSizeError(code: string, syscall: string): NodeJS.ErrnoException {
    return uvSystemError(code, syscall, 'ERR_SOCKET_BUFFER_SIZE', 'Could not get or set buffer size');
}

const BUFFER_SIZE_OPTIONS = {
    recv: { syscall: 'uv_recv_buffer_size', option: sock.defines.SO_RCVBUF, field: '_recvBufferSize' },
    send: { syscall: 'uv_send_buffer_size', option: sock.defines.SO_SNDBUF, field: '_sendBufferSize' },
} as const;

function readBufferSize(self: Socket, { syscall, option }: typeof BUFFER_SIZE_OPTIONS[keyof typeof BUFFER_SIZE_OPTIONS]): number {
    const s = bufferSizeSocket(self, syscall);
    try {
        const val = s.getopt(sock.defines.SOL_SOCKET, option, 4);
        return new DataView(val.buffer, val.byteOffset, val.byteLength).getUint32(0, true);
    } catch (err) {
        throw bufferSizeError(sockErrCode(err, syscall), syscall);
    }
}

function writeBufferSize(self: Socket, { syscall, option, field }: typeof BUFFER_SIZE_OPTIONS[keyof typeof BUFFER_SIZE_OPTIONS], size: number): void {
    const s = bufferSizeSocket(self, syscall);
    try {
        s.setopt(sock.defines.SOL_SOCKET, option, uint32le(size));
    } catch (err) {
        throw bufferSizeError(sockErrCode(err, syscall), syscall);
    }
    self[field] = size;
}

Socket.prototype.getRecvBufferSize = function getRecvBufferSize(this: Socket): number {
    return readBufferSize(this, BUFFER_SIZE_OPTIONS.recv);
};

Socket.prototype.setRecvBufferSize = function setRecvBufferSize(this: Socket, size: number): void {
    writeBufferSize(this, BUFFER_SIZE_OPTIONS.recv, size);
};

Socket.prototype.getSendBufferSize = function getSendBufferSize(this: Socket): number {
    return readBufferSize(this, BUFFER_SIZE_OPTIONS.send);
};

Socket.prototype.setSendBufferSize = function setSendBufferSize(this: Socket, size: number): void {
    writeBufferSize(this, BUFFER_SIZE_OPTIONS.send, size);
};

Socket.prototype.ref = function ref(this: Socket): Socket {
    this._refd = true;
    return this;
};

Socket.prototype.unref = function unref(this: Socket): Socket {
    this._refd = false;
    return this;
};

Socket.prototype.close = function close(this: Socket, callback?: () => void): Socket {
    healthCheck(this);
    this._doClose(typeof callback === 'function' ? callback : undefined);
    return this;
};

Socket.prototype._doClose = async function _doClose(this: Socket, callback?: () => void): Promise<void> {
    if (this._handle) {
        this._bound = false;
        this._materialized = false;
        this._binding = false;
        this._connected = false;
        this._connecting = false;
        this._handle.close();
        this._handle = null;
    }
    this.emit('close');
    callback?.();
};

Object.defineProperty(Socket.prototype, 'constructor', {
    value: Socket,
    writable: true,
    configurable: true,
});

flattenPrototype(Socket.prototype);

// Factory functions

export function createSocket(type: 'udp4' | 'udp6', callback?: (msg: Uint8Array, rinfo: RemoteInfo) => void): Socket;
export function createSocket(options: SocketOptions, callback?: (msg: Uint8Array, rinfo: RemoteInfo) => void): Socket;
export function createSocket(typeOrOptions: 'udp4' | 'udp6' | SocketOptions, callback?: (msg: Uint8Array, rinfo: RemoteInfo) => void): Socket {
    let type: 'udp4' | 'udp6';
    let reuseAddr = false;
    let ipv6Only = false;
    let signal: AbortSignal | undefined;
    let recvBufferSize: number | undefined;
    let sendBufferSize: number | undefined;

    if (typeof typeOrOptions === 'object') {
        if (typeOrOptions === null) validateSocketType(undefined);
        type = typeOrOptions.type;
        reuseAddr = typeOrOptions.reuseAddr ?? false;
        ipv6Only = typeOrOptions.ipv6Only ?? false;
        signal = typeOrOptions.signal;
        recvBufferSize = typeOrOptions.recvBufferSize;
        sendBufferSize = typeOrOptions.sendBufferSize;
    } else {
        type = typeOrOptions;
    }
    validateSocketType(type);

    const socket = new Socket(type, reuseAddr, ipv6Only);

    // The OS socket does not exist until bind, so remember the requested sizes
    // and apply them as soon as it does.
    if (recvBufferSize !== undefined || sendBufferSize !== undefined) {
        if (recvBufferSize !== undefined) socket._recvBufferSize = recvBufferSize;
        if (sendBufferSize !== undefined) socket._sendBufferSize = sendBufferSize;
        socket.on('listening', () => {
            try {
                if (recvBufferSize !== undefined) socket.setRecvBufferSize(recvBufferSize);
                if (sendBufferSize !== undefined) socket.setSendBufferSize(sendBufferSize);
            } catch { /* mirrors libuv's best-effort SO_RCVBUF/SO_SNDBUF sizing */ }
        });
    }

    if (callback) {
        socket.on('message', callback);
    }

    if (signal) {
        signal.addEventListener('abort', () => {
            tryCloseQuietly(socket);
        });
    }

    return socket;
}
