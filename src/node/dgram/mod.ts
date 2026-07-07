/**
 * Node.js dgram module
 * Based on CModuleUDP for UDP datagrams
 */

const udp = import.meta.use('udp');
const os = import.meta.use('os');
const sock = import.meta.use('socket');
const engine = import.meta.use('engine');

import { EventEmitter } from '../events';
import { Buffer } from '../buffer';

// Platform-specific IP multicast socket options
const _isWindows = os.uname().sysname === 'Windows_NT';
const IP_ADD_MEMBERSHIP = _isWindows ? 12 : 35;
const IP_DROP_MEMBERSHIP = _isWindows ? 13 : 36;

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

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function validateTTL(ttl: unknown): number {
    if (typeof ttl !== 'number') {
        throw new TypeError('The "ttl" argument must be of type number');
    }
    if (ttl <= 0 || ttl > 255) {
        throw makeError('setTTL EINVAL', 'EINVAL');
    }
    return ttl;
}

function validateSendPort(port: unknown): number {
    const value = typeof port === 'string' && port.trim() !== '' ? Number(port) : port;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value >= 65536) {
        throw Object.assign(
            new RangeError(`Port should be > 0 and < 65536. Received ${String(port)}.`),
            { code: 'ERR_SOCKET_BAD_PORT' },
        );
    }
    return value;
}

function validateAddress(address: unknown): asserts address is string {
    if (typeof address !== 'string') {
        throw new TypeError(`The "address" argument must be of type string. Received type ${typeof address}`);
    }
}

export interface Socket extends EventEmitter {
    readonly isIPv6: boolean;
    _handle: CModuleUDP.UDP | null;
    _type: 'udp4' | 'udp6';
    _reuseAddr: boolean;
    _ipv6Only: boolean;
    _bound: boolean;
    _connected: boolean;
    _address: AddressInfo | null;
    _remoteAddress: AddressInfo | null;
    _recvBufferSize: number;
    _sendBufferSize: number;
    _refd: boolean;
    _init(): Promise<void>;
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
    setMulticastInterface(multicastInterface?: string): this;
    setMulticastLoopback(flag: boolean): this;
    addMembership(multicastAddress: string, multicastInterface?: string): void;
    dropMembership(multicastAddress: string, multicastInterface?: string): void;
    addSourceSpecificMembership(sourceAddress: string, groupAddress: string, multicastInterface?: string): void;
    dropSourceSpecificMembership(sourceAddress: string, groupAddress: string, multicastInterface?: string): void;
    getRecvBufferSize(): number;
    setRecvBufferSize(size: number): this;
    getSendBufferSize(): number;
    setSendBufferSize(size: number): this;
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
    self._handle = null;
    self._bound = false;
    self._connected = false;
    self._address = null;
    self._remoteAddress = null;
    self._recvBufferSize = 65536;
    self._sendBufferSize = 65536;
    self._refd = true;
    self._type = type;
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
    const af = this._type === 'udp6' ? os.AF_INET6 : os.AF_INET;
    this._handle = new udp.UDP(af);
};

Socket.prototype.bind = function bind(this: Socket, portOrOptions?: number | BindOptions, addressOrCallback?: string | (() => void), callback?: () => void): Socket {
    // Asynchronously bind
    this._doBind(portOrOptions, addressOrCallback, callback);
    return this;
};

Socket.prototype._doBind = async function _doBind(this: Socket, portOrOptions?: number | BindOptions, addressOrCallback?: string | (() => void), callback?: () => void): Promise<void> {
    let port: number = 0;
    let address: string = this._type === 'udp6' ? '::' : '0.0.0.0';
    let cb: (() => void) | undefined;

    if (typeof portOrOptions === 'object') {
        port = portOrOptions.port ?? 0;
        address = portOrOptions.address ?? address;
        cb = addressOrCallback as (() => void) | undefined;
        if (portOrOptions.signal) {
            portOrOptions.signal.addEventListener('abort', () => {
                this.close();
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
        if (!this._handle) {
            await this._init();
        }
        const handle = this._handle;
        if (!handle) throw new Error('UDP handle is not initialized');

        const flags = (this._ipv6Only ? udp.UDP_IPV6ONLY : 0) |
            (this._reuseAddr ? udp.UDP_REUSEADDR : 0);

        handle.bind({ ip: address, port }, flags);
        this._bound = true;

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
        this.emit('error', err);
    }
};

Socket.prototype._startRecv = async function _startRecv(this: Socket): Promise<void> {
    if (!this._handle || !this._bound) return;

    const buffer = new Uint8Array(this._recvBufferSize);

    while (this._handle && this._bound) {
        try {
            const result = await this._handle.recv(buffer);
            if (result.nread > 0) {
                const msg = Buffer.from(buffer.subarray(0, result.nread));
                const rinfo: RemoteInfo = {
                    address: result.addr?.ip ?? '',
                    family: result.addr?.family === 6 ? 'IPv6' : 'IPv4',
                    port: result.addr?.port ?? 0,
                    size: result.nread,
                };
                this.emit('message', msg, rinfo);
            }
        } catch (err) {
            if (this._handle) {
                this.emit('error', err);
            }
        }
    }
};

Socket.prototype.send = function send(this: Socket, msg: string | Uint8Array | Array<string | Uint8Array>, port: number, addressOrCallback?: string | ((error: Error | null, bytes?: number) => void), callback?: (error: Error | null, bytes?: number) => void): void {
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
    let address = socket._remoteAddress?.address ?? '127.0.0.1';
    let callback: ((error: Error | null, bytes?: number) => void) | undefined;
    let data: Uint8Array;
    let port: number;

    if (typeof msg === 'string') {
        data = engine.encodeString(msg);
    } else if (Array.isArray(msg)) {
        const buffers = msg.map((item) => typeof item === 'string' ? engine.encodeString(item) : item);
        data = Buffer.concat(buffers);
    } else {
        data = msg;
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
        data = data.subarray(offset, offset + length);
        port = validateSendPort(port);
        validateAddress(address);
        return { data, port, address, callback };
    }

    if (
        socket._remoteAddress &&
        typeof args[0] === 'number' &&
        typeof args[1] === 'number' &&
        typeof args[2] !== 'number'
    ) {
        data = data.subarray(args[0], args[0] + args[1]);
        return { data, connected: true, callback: typeof args[2] === 'function' ? args[2] : undefined };
    }

    if (socket._remoteAddress && (args[0] === undefined || typeof args[0] === 'function')) {
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
        if (!this._handle) {
            await this._init();
        }
        const handle = this._handle;
        if (!handle) throw new Error('UDP handle is not initialized');

        const target = connected
            ? undefined
            : address !== undefined && port !== undefined
            ? { ip: address, port }
            : undefined;
        if (!connected && !target) throw new TypeError('Address and port are required');
        const bytes = await handle.send(data, target);
        callback?.(null, bytes);
        this.emit('send', bytes);
    } catch (err) {
        if (callback) {
            callback(asError(err));
        } else if (this.listenerCount('error') > 0) {
            this.emit('error', err);
        }
    }
};

Socket.prototype.connect = function connect(this: Socket, port: number, address?: string, callback?: () => void): void {
    this._doConnect(port, address, callback);
};

Socket.prototype._doConnect = async function _doConnect(this: Socket, port: number, address?: string, callback?: () => void): Promise<void> {
    try {
        if (!this._handle) {
            await this._init();
        }
        const handle = this._handle;
        if (!handle) throw new Error('UDP handle is not initialized');

        const addr = address ?? '127.0.0.1';

        handle.connect({ ip: addr, port });
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
        this.emit('error', err);
    }
};

Socket.prototype.disconnect = function disconnect(this: Socket): void {
    if (!this._connected) {
        throw makeError('Not connected', 'ERR_SOCKET_DGRAM_NOT_CONNECTED');
    }
    this._handle?.disconnect();
    this._connected = false;
    this._remoteAddress = null;
};

Socket.prototype.address = function address(this: Socket): AddressInfo | null {
    if (!this._bound || !this._address) throw makeError('getsockname EBADF', 'EBADF');
    return this._address;
};

Socket.prototype.remoteAddress = function remoteAddress(this: Socket): AddressInfo | null {
    if (!this._connected || !this._remoteAddress) throw makeError('Not connected', 'ERR_SOCKET_DGRAM_NOT_CONNECTED');
    return this._remoteAddress;
};

Socket.prototype.setBroadcast = function setBroadcast(this: Socket, flag: boolean): void {
    if (!this._handle) return;
    try {
        const s = _getSocket(this._handle);
        if (!s) return;
        const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, flag ? 1 : 0, true);
        s.setopt(sock.defines.SOL_SOCKET, sock.defines.SO_BROADCAST, val);
    } catch { /* best-effort */ }
};

Socket.prototype.setTTL = function setTTL(this: Socket, ttl: number): number {
    ttl = validateTTL(ttl);
    if (!this._handle) return ttl;
    try {
        const s = _getSocket(this._handle);
        if (!s) return ttl;
        const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, ttl, true);
        s.setopt(sock.defines.IPPROTO_IP, 2, val);
    } catch { /* best-effort */ }
    return ttl;
};

Socket.prototype.setMulticastTTL = function setMulticastTTL(this: Socket, ttl: number): number {
    ttl = validateTTL(ttl);
    if (!this._handle) return ttl;
    try {
        const s = _getSocket(this._handle);
        if (!s) return ttl;
        const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, ttl, true);
        s.setopt(sock.defines.IPPROTO_IP, 10, val);
    } catch { /* best-effort */ }
    return ttl;
};

Socket.prototype.setMulticastInterface = function setMulticastInterface(this: Socket, multicastInterface?: string): Socket {
    if (!this._handle) return this;
    try {
        const s = _getSocket(this._handle);
        if (!s) return this;
        const buf = new Uint8Array(4);
        if (multicastInterface) {
            const parts = multicastInterface.split('.');
            if (parts.length === 4) {
                for (let i = 0; i < 4; i++) buf[i] = parseInt(parts[i]);
            }
        }
        s.setopt(sock.defines.IPPROTO_IP, 12, buf);
    } catch { /* best-effort */ }
    return this;
};

Socket.prototype.setMulticastLoopback = function setMulticastLoopback(this: Socket, flag: boolean): Socket {
    if (!this._handle) return this;
    try {
        const s = _getSocket(this._handle);
        if (!s) return this;
        const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, flag ? 1 : 0, true);
        s.setopt(sock.defines.IPPROTO_IP, 11, val);
    } catch { /* best-effort */ }
    return this;
};

Socket.prototype.addMembership = function addMembership(this: Socket, multicastAddress: string, multicastInterface?: string): void {
    if (!this._handle) return;
    try {
        const s = _getSocket(this._handle);
        if (!s) return;
        const mreq = new Uint8Array(8);
        const mcParts = multicastAddress.split('.');
        if (mcParts.length === 4) {
            for (let i = 0; i < 4; i++) mreq[i] = parseInt(mcParts[i]);
        }
        if (multicastInterface) {
            const ifParts = multicastInterface.split('.');
            if (ifParts.length === 4) {
                for (let i = 0; i < 4; i++) mreq[4 + i] = parseInt(ifParts[i]);
            }
        }
        s.setopt(sock.defines.IPPROTO_IP, IP_ADD_MEMBERSHIP, mreq);
    } catch { /* best-effort */ }
};

Socket.prototype.dropMembership = function dropMembership(this: Socket, multicastAddress: string, multicastInterface?: string): void {
    if (!this._handle) return;
    try {
        const s = _getSocket(this._handle);
        if (!s) return;
        const mreq = new Uint8Array(8);
        const mcParts = multicastAddress.split('.');
        if (mcParts.length === 4) {
            for (let i = 0; i < 4; i++) mreq[i] = parseInt(mcParts[i]);
        }
        if (multicastInterface) {
            const ifParts = multicastInterface.split('.');
            if (ifParts.length === 4) {
                for (let i = 0; i < 4; i++) mreq[4 + i] = parseInt(ifParts[i]);
            }
        }
        s.setopt(sock.defines.IPPROTO_IP, IP_DROP_MEMBERSHIP, mreq);
    } catch { /* best-effort */ }
};

Socket.prototype.addSourceSpecificMembership = function addSourceSpecificMembership(this: Socket, _sourceAddress: string, _groupAddress: string, _multicastInterface?: string): void {
    // MCAST_JOIN_SOURCE_GROUP - C layer doesn't expose this constant
    process.emitWarning?.('dgram.addSourceSpecificMembership() is not fully supported in this runtime', 'UnsupportedWarning');
};

Socket.prototype.dropSourceSpecificMembership = function dropSourceSpecificMembership(this: Socket, _sourceAddress: string, _groupAddress: string, _multicastInterface?: string): void {
    process.emitWarning?.('dgram.dropSourceSpecificMembership() is not fully supported in this runtime', 'UnsupportedWarning');
};

Socket.prototype.getRecvBufferSize = function getRecvBufferSize(this: Socket): number {
    if (this._handle) {
        try {
            const s = _getSocket(this._handle);
            if (s) {
                const val = s.getopt(sock.defines.SOL_SOCKET, sock.defines.SO_RCVBUF, 4);
                return new DataView(val.buffer).getUint32(0, true);
            }
        } catch { /* fall through */ }
    }
    return this._recvBufferSize;
};

Socket.prototype.setRecvBufferSize = function setRecvBufferSize(this: Socket, size: number): Socket {
    this._recvBufferSize = size;
    if (this._handle) {
        try {
            const s = _getSocket(this._handle);
            if (s) {
                const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, size, true);
                s.setopt(sock.defines.SOL_SOCKET, sock.defines.SO_RCVBUF, val);
            }
        } catch { /* best-effort */ }
    }
    return this;
};

Socket.prototype.getSendBufferSize = function getSendBufferSize(this: Socket): number {
    if (this._handle) {
        try {
            const s = _getSocket(this._handle);
            if (s) {
                const val = s.getopt(sock.defines.SOL_SOCKET, sock.defines.SO_SNDBUF, 4);
                return new DataView(val.buffer).getUint32(0, true);
            }
        } catch { /* fall through */ }
    }
    return this._sendBufferSize;
};

Socket.prototype.setSendBufferSize = function setSendBufferSize(this: Socket, size: number): Socket {
    this._sendBufferSize = size;
    if (this._handle) {
        try {
            const s = _getSocket(this._handle);
            if (s) {
                const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, size, true);
                s.setopt(sock.defines.SOL_SOCKET, sock.defines.SO_SNDBUF, val);
            }
        } catch { /* best-effort */ }
    }
    return this;
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
    this._doClose(typeof callback === 'function' ? callback : undefined);
    return this;
};

Socket.prototype._doClose = async function _doClose(this: Socket, callback?: () => void): Promise<void> {
    if (this._handle) {
        this._bound = false;
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

    if (typeof typeOrOptions === 'object') {
        if (typeOrOptions === null) validateSocketType(undefined);
        type = typeOrOptions.type;
        reuseAddr = typeOrOptions.reuseAddr ?? false;
        ipv6Only = typeOrOptions.ipv6Only ?? false;
        signal = typeOrOptions.signal;
    } else {
        type = typeOrOptions;
    }
    validateSocketType(type);

    const socket = new Socket(type, reuseAddr, ipv6Only);

    if (callback) {
        socket.on('message', callback);
    }

    if (signal) {
        signal.addEventListener('abort', () => {
            socket.close();
        });
    }

    return socket;
}
