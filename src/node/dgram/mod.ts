/**
 * Node.js dgram module
 * Based on CModuleUDP for UDP datagrams
 */

const udp = import.meta.use('udp');
const os = import.meta.use('os');
const sock = import.meta.use('socket');
const engine = import.meta.use('engine');
const uverror = import.meta.use('error');
const timers = import.meta.use('timers');

import { EventEmitter } from '../events';
import { Buffer } from '../buffer';
import { toErrnoException } from '../_internal/errno';
import { lookup as dnsLookup } from '../dns';

/*
 * Platform-specific IP/IPv6 socket option numbers.
 *
 * These are ABI values, not portable constants, and the `socket` C module only
 * exposes IPPROTO_IP / SOL_SOCKET / SO_*, so the IP-level numbers have to live
 * here. Windows (winsock2.h / ws2ipdef.h) and macOS/BSD (netinet/in.h) agree on
 * every option below; only Linux (linux/in.h) differs, so this is a two-way
 * split rather than three.
 *
 *              win/bsd   linux
 *   IP_TTL           4       2
 *   IP_MULTICAST_IF  9      32
 *   IP_MULTICAST_TTL 10     33
 *   IP_MULTICAST_LOOP 11    34
 *   IP_ADD_MEMBERSHIP 12    35
 *   IP_DROP_MEMBERSHIP 13   36
 */
const _isLinux = os.uname().sysname === 'Linux';

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

// Helper: get a PosixSocket from UDP's fd for setsockopt
// We cache the fd at init time since fileno() is async but socket options
// are set via sync methods
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

function validateSocketType(type: unknown): asserts type is 'udp4' | 'udp6' {
    if (type !== 'udp4' && type !== 'udp6') {
        throw Object.assign(
            new TypeError('Bad socket type specified. Valid types are: udp4, udp6'),
            { code: 'ERR_SOCKET_BAD_TYPE' },
        );
    }
}

function makeError(message: string, code: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

/**
 * Node shapes libuv failures as `<syscall> <CODE>[ detail]` with a numeric
 * `.errno` from the platform UV table. Values differ per platform (EBADF is
 * -4083 on Windows, -9 on Linux), so read them from the runtime table.
 */
function errnoError(code: string, syscall: string, detail?: string): NodeJS.ErrnoException {
    const table = uverror.errno as unknown as Record<string, number | undefined>;
    const err: NodeJS.ErrnoException = new Error(
        `${syscall} ${code}${detail === undefined ? '' : ` ${detail}`}`,
    );
    err.code = code;
    const errno = Reflect.get(table, code);
    if (typeof errno === 'number') err.errno = errno;
    err.syscall = syscall;
    return err;
}

/** `ERR_SOCKET_DGRAM_NOT_RUNNING` — the handle has been closed. */
function notRunning(): Error & { code: string } {
    return makeError('Not running', 'ERR_SOCKET_DGRAM_NOT_RUNNING');
}

function healthCheck(self: Socket): CModuleUDP.UDP {
    if (!self._handle) throw notRunning();
    return self._handle;
}

/**
 * Socket options need a live OS socket. libuv's Windows backend returns
 * UV_EBADF from uv_udp_set_ttl/set_broadcast/set_multicast_* when the socket
 * has not been materialized yet, so an unbound socket reports EBADF like Node.
 * (uv_udp_set_membership and the buffer-size calls deferred-bind instead, so
 * they must NOT go through here.)
 */
function boundOptionSocket(self: Socket, syscall: string): CModuleSocket.PosixSocket {
    healthCheck(self);
    if (!self._materialized) throw errnoError('EBADF', syscall);
    const handle = self._handle;
    const s = handle ? _getSocket(handle) : null;
    if (!s) throw errnoError('EBADF', syscall);
    return s;
}

function setSockOpt(self: Socket, syscall: string, level: number, option: number, value: Uint8Array): void {
    const s = boundOptionSocket(self, syscall);
    try {
        s.setopt(level, option, value);
    } catch (err) {
        throw normalizeSockOptError(err, syscall);
    }
}

/**
 * The `socket` C module reports setsockopt/getsockopt failures on Windows as a
 * bare `InternalError: WSA error <n>` with no .code/.errno, so the UV name has
 * to be recovered from the message. Only the codes these paths can actually
 * produce are listed; anything else falls through to UNKNOWN.
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
 * implicitly binds it to the wildcard address with SO_REUSEADDR. That is what
 * makes a subsequent setTTL/address() succeed in Node. Mirror it, but do NOT
 * emit 'listening' or start the recv loop: uv__udp_maybe_bind only sets
 * UV_HANDLE_BOUND, and Node's dgram wrapper still considers the socket unbound.
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

function validateTTLNumber(ttl: unknown, name: string): number {
    if (typeof ttl !== 'number') {
        throw Object.assign(
            new TypeError(`The "${name}" argument must be of type number. Received ${determineSpecificType(ttl)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    return ttl;
}

/**
 * `uv_udp_set_ttl` range-checks 1..255 before touching the socket, so an
 * out-of-range value reports EINVAL even on an unbound socket. Multicast TTL
 * has no such check on Windows — Node happily returns 0/-1 there.
 */
function validateTTL(ttl: unknown): number {
    const value = validateTTLNumber(ttl, 'ttl');
    if (value < 1 || value > 255) {
        throw errnoError('EINVAL', 'setTTL');
    }
    return value;
}

/**
 * Mirrors Node's internal `determineSpecificType()`, used verbatim in its
 * argument-validation messages: primitives are rendered as
 * `type <typeof> (<inspected>)`, while null/undefined render bare.
 */
function determineSpecificType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `type string ('${value}')`;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return `type ${typeof value} (${String(value)})`;
    }
    if (typeof value === 'symbol') return `type symbol (${String(value)})`;
    if (typeof value === 'function') return `function ${value.name}`;
    const ctor = (value as object).constructor;
    if (typeof ctor === 'function' && ctor.name) return `an instance of ${ctor.name}`;
    return `type ${typeof value}`;
}

function validateSendPort(port: unknown): number {
    const value = typeof port === 'string' && port.trim() !== '' ? Number(port) : port;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value >= 65536) {
        throw Object.assign(
            new RangeError(`Port should be > 0 and < 65536. Received ${determineSpecificType(port)}.`),
            { code: 'ERR_SOCKET_BAD_PORT' },
        );
    }
    return value;
}

function validateAddress(address: unknown, name = 'address'): asserts address is string {
    if (typeof address !== 'string') {
        throw Object.assign(
            new TypeError(`The "${name}" argument must be of type string. Received ${determineSpecificType(address)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
}

function isView(value: unknown): value is ArrayBufferView {
    return ArrayBuffer.isView(value);
}

function viewToBytes(view: ArrayBufferView): Uint8Array {
    return view instanceof Uint8Array
        ? view
        : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function badBufferArg(value: unknown, name = 'buffer'): TypeError & { code: string } {
    return Object.assign(
        new TypeError(
            `The "${name}" argument must be of type string or an instance of Buffer, `
            + `TypedArray, or DataView. Received ${determineSpecificType(value)}`,
        ),
        { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

function outOfBounds(name: 'offset' | 'length'): RangeError & { code: string } {
    return Object.assign(
        new RangeError(`"${name}" is outside of buffer bounds`),
        { code: 'ERR_BUFFER_OUT_OF_BOUNDS' },
    );
}

/**
 * Node's internal `sliceBuffer` bounds check, applied to already-encoded bytes.
 *
 * Node coerces both values with `>>> 0` *before* comparing, so a negative
 * offset becomes huge and trips the `offset` check, while a negative length
 * trips the `length` check via `offset + length > byteLength`. Reproducing that
 * coercion is what makes -1 report 'offset' and -5 report 'length' rather than
 * the other way round. Verified against node v24.18.0 for
 * offset=-1/20, length=99/-5 and offset=5+length=6.
 */
function checkSendBounds(bytes: Uint8Array, offset: unknown, length: unknown): Uint8Array {
    const off = (offset as number) >>> 0;
    const len = (length as number) >>> 0;
    if (off > bytes.byteLength) throw outOfBounds('offset');
    if (off + len > bytes.byteLength) throw outOfBounds('length');
    return bytes.subarray(off, off + len);
}

/**
 * Node's internal `sliceBuffer`: coerce the message to bytes, then bounds-check
 * `offset` and `length` against it. Non-numeric/NaN values coerce to 0, so only
 * genuinely out-of-range integers throw — `>>> 0` would turn -1 into 4294967295
 * and report the wrong one of the two errors.
 */
function sliceSendBuffer(msg: string | ArrayBufferView, offset: unknown, length: unknown): Uint8Array {
    const bytes = typeof msg === 'string' ? engine.encodeString(msg) : viewToBytes(msg);
    const off = Number(offset) || 0;
    const len = Number(length) || 0;
    if (off > bytes.byteLength || off < 0) throw outOfBounds('offset');
    if (len > bytes.byteLength - off || len < 0) throw outOfBounds('length');
    return bytes.subarray(off, off + len);
}

function validateSendMessage(msg: unknown): void {
    if (typeof msg === 'string' || isView(msg)) return;
    if (Array.isArray(msg)) {
        // Node reports the *list* under the name "buffer list arguments", not the
        // offending element under "buffer" (internal fixBufferList returns false
        // and the caller throws with the whole array as the received value).
        for (const item of msg) {
            if (typeof item !== 'string' && !isView(item)) throw badBufferArg(msg, 'buffer list arguments');
        }
        return;
    }
    throw badBufferArg(msg);
}

function validateMulticastAddress(address: unknown, name: string): asserts address is string {
    if (address === undefined) {
        throw Object.assign(
            new TypeError(`The "${name}" argument must be specified`),
            { code: 'ERR_MISSING_ARGS' },
        );
    }
    validateAddress(address);
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
     * Whether the underlying OS socket exists, as opposed to whether the user
     * called bind(). cno's `new udp.UDP(af)` passes a concrete address family
     * to uv_udp_init_ex, so the SOCKET is created eagerly; Node passes
     * AF_UNSPEC and leaves it INVALID_SOCKET until bind() or a deferred-bind
     * option (set_membership, buffer sizes) materialises it. Socket options
     * observe that distinction (EBADF while INVALID_SOCKET), so track it
     * explicitly instead of reusing _bound.
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
    // Node creates the libuv handle in the constructor, so state-dependent
    // errors (EBADF vs ERR_SOCKET_DGRAM_NOT_RUNNING) hinge on close(), not on
    // whether the handle has been lazily materialized yet.
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
    self.isIPv6 = type === 'udp6';
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
                try { this.close(); } catch { /* already closed */ }
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
            const normalized = toErrnoException(err, 'bind');
            throw errnoError(normalized.code ?? 'UNKNOWN', 'bind', `${address}:${port}`);
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

Socket.prototype.send = function send(this: Socket, msg: string | Uint8Array | Array<string | Uint8Array>, port: number, addressOrCallback?: string | ((error: Error | null, bytes?: number) => void), callback?: (error: Error | null, bytes?: number) => void): void {
    healthCheck(this);
    const args: unknown[] = Array.prototype.slice.call(arguments, 1);
    this._doSend(normalizeSendArgs(this, msg, args));
};

interface SendRequest {
    data: Uint8Array;
    port?: number;
    address?: string;
    connected?: boolean;
    callback?: (error: Error | null, bytes?: number) => void;
}

function normalizeSendArgs(
    socket: Socket,
    msg: string | Uint8Array | Array<string | Uint8Array>,
    args: unknown[],
): SendRequest {
    validateSendMessage(msg);

    // A connected socket rejects any attempt to re-specify the destination.
    // The offset/length form stays legal, so only treat a trailing numeric
    // argument (or a non-numeric second argument) as a supplied port.
    if (socket._connected || socket._connecting) {
        const suppliesDestination = typeof args[0] === 'number'
            ? (typeof args[1] === 'number' ? typeof args[2] === 'number' : true)
            : args[0] !== undefined && typeof args[0] !== 'function';
        if (suppliesDestination) {
            throw makeError('Already connected', 'ERR_SOCKET_DGRAM_IS_CONNECTED');
        }
    }

    let address = socket._remoteAddress?.address
        ?? (socket._type === 'udp6' ? '::1' : '127.0.0.1');
    let callback: ((error: Error | null, bytes?: number) => void) | undefined;
    let data: Uint8Array;
    let port: number;

    if (typeof msg === 'string') {
        data = engine.encodeString(msg);
    } else if (Array.isArray(msg)) {
        const buffers = msg.map((item) => typeof item === 'string' ? engine.encodeString(item) : viewToBytes(item));
        data = Buffer.concat(buffers);
    } else {
        data = viewToBytes(msg);
    }

    if (
        typeof args[0] === 'number' &&
        typeof args[1] === 'number' &&
        typeof args[2] === 'number'
    ) {
        const offset = args[0];
        const length = args[1];
        port = args[2];
        if (typeof args[3] === 'string') {
            address = args[3];
            if (typeof args[4] === 'function') callback = args[4];
        } else if (typeof args[3] === 'function') {
            callback = args[3];
        } else if (args[3] !== undefined) {
            validateAddress(args[3]);
        } else {
            callback = undefined;
        }
        data = checkSendBounds(data, offset, length);
        port = validateSendPort(port);
        validateAddress(address);
        return { data, port, address, callback };
    }

    const connected = socket._connected || socket._connecting;

    if (
        connected &&
        typeof args[0] === 'number' &&
        typeof args[1] === 'number' &&
        typeof args[2] !== 'number'
    ) {
        data = checkSendBounds(data, args[0], args[1]);
        return { data, connected: true, callback: typeof args[2] === 'function' ? args[2] : undefined };
    }

    if (connected && (args[0] === undefined || typeof args[0] === 'function')) {
        return { data, connected: true, callback: typeof args[0] === 'function' ? args[0] : undefined };
    }

    port = args[0];
    if (typeof args[1] === 'string') {
        address = args[1];
        if (typeof args[2] === 'function') callback = args[2];
    } else if (typeof args[1] === 'function') {
        callback = args[1];
    } else if (args[1] !== undefined) {
        validateAddress(args[1]);
    } else {
        callback = undefined;
    }

    port = validateSendPort(port);
    validateAddress(address);
    return { data, port, address, callback };
}

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
    const validatedPort = validateSendPort(port);
    if (address !== undefined && typeof address !== 'function') validateAddress(address);
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

        const addr = address ?? (this._type === 'udp6' ? '::1' : '127.0.0.1');

        try {
            handle.connect({ ip: addr, port });
        } catch (err) {
            const normalized = toErrnoException(err, 'connect');
            throw errnoError(normalized.code ?? 'UNKNOWN', 'connect', `${addr}:${port}`);
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
    const value = validateTTLNumber(ttl, 'ttl');
    if (value < -1 || value > 255) throw errnoError('EINVAL', 'setMulticastTTL');
    const [level, option] = ipOpt(this, IP_MULTICAST_TTL, IPV6_MULTICAST_HOPS);
    setSockOpt(this, 'setMulticastTTL', level, option, uint32le(value));
    return value;
};

Socket.prototype.setMulticastInterface = function setMulticastInterface(this: Socket, multicastInterface?: string): void {
    const [level, option] = ipOpt(this, IP_MULTICAST_IF, IPV6_MULTICAST_IF);
    // IPv4 takes an in_addr; IPv6 takes an unsigned interface index. Node
    // accepts a scoped literal like "::%2" for udp6 -- take the scope id.
    let buf: Uint8Array;
    if (this._type === 'udp6') {
        let index = 0;
        if (multicastInterface !== undefined) {
            validateAddress(multicastInterface);
            const scope = multicastInterface.lastIndexOf('%');
            if (scope !== -1) index = parseInt(multicastInterface.slice(scope + 1), 10) || 0;
        }
        buf = uint32le(index);
    } else {
        buf = new Uint8Array(4);
        if (multicastInterface !== undefined) {
            validateAddress(multicastInterface);
            packIPv4(buf, 0, multicastInterface);
        }
    }
    setSockOpt(this, 'setMulticastInterface', level, option, buf);
};

Socket.prototype.setMulticastLoopback = function setMulticastLoopback(this: Socket, flag: boolean): boolean {
    const [level, option] = ipOpt(this, IP_MULTICAST_LOOP, IPV6_MULTICAST_LOOP);
    setSockOpt(this, 'setMulticastLoopback', level, option, uint32le(flag ? 1 : 0));
    return flag;
};

Socket.prototype.addMembership = function addMembership(this: Socket, multicastAddress: string, multicastInterface?: string): void {
    validateMulticastAddress(multicastAddress, 'multicastAddress');
    const handle = healthCheck(this);
    const mreq = new Uint8Array(8);
    packIPv4(mreq, 0, multicastAddress);
    if (multicastInterface !== undefined) {
        validateAddress(multicastInterface);
        packIPv4(mreq, 4, multicastInterface);
    }
    // uv__udp_set_membership4 deferred-binds before the setsockopt.
    maybeBind(this);
    const s = _getSocket(handle);
    if (!s) throw errnoError('EBADF', 'addMembership');
    const [level, option] = ipOpt(this, IP_ADD_MEMBERSHIP, IPV6_ADD_MEMBERSHIP);
    try {
        s.setopt(level, option, mreq);
    } catch (err) {
        throw normalizeSockOptError(err, 'addMembership');
    }
};

Socket.prototype.dropMembership = function dropMembership(this: Socket, multicastAddress: string, multicastInterface?: string): void {
    validateMulticastAddress(multicastAddress, 'multicastAddress');
    const handle = healthCheck(this);
    const mreq = new Uint8Array(8);
    packIPv4(mreq, 0, multicastAddress);
    if (multicastInterface !== undefined) {
        validateAddress(multicastInterface);
        packIPv4(mreq, 4, multicastInterface);
    }
    maybeBind(this);
    const s = _getSocket(handle);
    if (!s) throw errnoError('EBADF', 'dropMembership');
    const [level, option] = ipOpt(this, IP_DROP_MEMBERSHIP, IPV6_DROP_MEMBERSHIP);
    try {
        s.setopt(level, option, mreq);
    } catch (err) {
        throw normalizeSockOptError(err, 'dropMembership');
    }
};

Socket.prototype.addSourceSpecificMembership = function addSourceSpecificMembership(this: Socket, _sourceAddress: string, _groupAddress: string, _multicastInterface?: string): void {
    // MCAST_JOIN_SOURCE_GROUP - C layer doesn't expose this constant
    process.emitWarning?.('dgram.addSourceSpecificMembership() is not fully supported in this runtime', 'UnsupportedWarning');
};

Socket.prototype.dropSourceSpecificMembership = function dropSourceSpecificMembership(this: Socket, _sourceAddress: string, _groupAddress: string, _multicastInterface?: string): void {
    process.emitWarning?.('dgram.dropSourceSpecificMembership() is not fully supported in this runtime', 'UnsupportedWarning');
};

/**
 * Buffer-size accessors on a never-bound socket. libuv routes these through
 * uv__udp_maybe_bind, but on Windows the SOCKET is still INVALID at that point
 * and the call fails with ENOTSOCK, which Node rewraps as
 * ERR_SOCKET_BUFFER_SIZE. probe4's afterRecvBufSize_setTTL confirms the socket
 * is NOT left materialised, so this must not bind.
 */
function bufferSizeSocket(self: Socket, syscall: string): CModuleSocket.PosixSocket {
    const handle = healthCheck(self);
    if (!self._materialized) throw bufferSizeError('ENOTSOCK', syscall);
    const s = _getSocket(handle);
    if (!s) throw bufferSizeError('ENOTSOCK', syscall);
    return s;
}

function bufferSizeError(code: string, syscall: string): NodeJS.ErrnoException {
    const err = errnoError(code, syscall);
    err.message = `Could not get or set buffer size: ${syscall} returned ${code}`;
    err.code = 'ERR_SOCKET_BUFFER_SIZE';
    err.syscall = syscall;
    const table = uverror.errno as unknown as Record<string, number | undefined>;
    const errno = Reflect.get(table, code);
    if (typeof errno === 'number') err.errno = errno;
    return err;
}

Socket.prototype.getRecvBufferSize = function getRecvBufferSize(this: Socket): number {
    const s = bufferSizeSocket(this, 'uv_recv_buffer_size');
    try {
        const val = s.getopt(sock.defines.SOL_SOCKET, sock.defines.SO_RCVBUF, 4);
        return new DataView(val.buffer, val.byteOffset, val.byteLength).getUint32(0, true);
    } catch (err) {
        throw bufferSizeError(sockErrCode(err, 'uv_recv_buffer_size'), 'uv_recv_buffer_size');
    }
};

Socket.prototype.setRecvBufferSize = function setRecvBufferSize(this: Socket, size: number): void {
    const s = bufferSizeSocket(this, 'uv_recv_buffer_size');
    try {
        s.setopt(sock.defines.SOL_SOCKET, sock.defines.SO_RCVBUF, uint32le(size));
    } catch (err) {
        throw bufferSizeError(sockErrCode(err, 'uv_recv_buffer_size'), 'uv_recv_buffer_size');
    }
    this._recvBufferSize = size;
};

Socket.prototype.getSendBufferSize = function getSendBufferSize(this: Socket): number {
    const s = bufferSizeSocket(this, 'uv_send_buffer_size');
    try {
        const val = s.getopt(sock.defines.SOL_SOCKET, sock.defines.SO_SNDBUF, 4);
        return new DataView(val.buffer, val.byteOffset, val.byteLength).getUint32(0, true);
    } catch (err) {
        throw bufferSizeError(sockErrCode(err, 'uv_send_buffer_size'), 'uv_send_buffer_size');
    }
};

Socket.prototype.setSendBufferSize = function setSendBufferSize(this: Socket, size: number): void {
    const s = bufferSizeSocket(this, 'uv_send_buffer_size');
    try {
        s.setopt(sock.defines.SOL_SOCKET, sock.defines.SO_SNDBUF, uint32le(size));
    } catch (err) {
        throw bufferSizeError(sockErrCode(err, 'uv_send_buffer_size'), 'uv_send_buffer_size');
    }
    this._sendBufferSize = size;
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
            try { socket.close(); } catch { /* already closed */ }
        });
    }

    return socket;
}
