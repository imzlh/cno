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
    try { return sock.socket_from_fd(fd); } catch { return null; }
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
    lookup?: (hostname: string, options: any, callback: (err: Error | null, address: string, family: number) => void) => void;
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
    send(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, address?: string, callback?: (error: Error | null, bytes?: number) => void): this;
    send(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, address: string, callback: (error: Error | null, bytes?: number) => void): this;
    _doSend(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, addressOrCallback?: string | ((error: Error | null, bytes?: number) => void), callback?: (error: Error | null, bytes?: number) => void): Promise<void>;
    connect(port: number, address?: string, callback?: () => void): Promise<this>;
    disconnect(): Promise<this>;
    address(): AddressInfo | null;
    remoteAddress(): AddressInfo | null;
    setBroadcast(flag: boolean): this;
    setTTL(ttl: number): this;
    setMulticastTTL(ttl: number): this;
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

function initSocket(self: any, type: 'udp4' | 'udp6', reuseAddr?: boolean, ipv6Only?: boolean): void {
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

export const Socket: SocketConstructor = function Socket(this: any, type: 'udp4' | 'udp6', reuseAddr?: boolean, ipv6Only?: boolean) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
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

        const flags = this._ipv6Only ? udp.UDP_IPV6ONLY : 0;

        this._handle!.bind({ ip: address, port }, flags);
        this._bound = true;

        const sockname = this._handle!.getsockname();
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

Socket.prototype.send = function send(this: Socket, msg: string | Uint8Array | Array<string | Uint8Array>, port: number, addressOrCallback?: string | ((error: Error | null, bytes?: number) => void), callback?: (error: Error | null, bytes?: number) => void): Socket {
    // Asynchronously send
    this._doSend(msg, port, addressOrCallback, callback);
    return this;
};

Socket.prototype._doSend = async function _doSend(this: Socket, msg: string | Uint8Array | Array<string | Uint8Array>, port: number, addressOrCallback?: string | ((error: Error | null, bytes?: number) => void), callback?: (error: Error | null, bytes?: number) => void): Promise<void> {
    let address: string;
    let cb: ((error: Error | null, bytes?: number) => void) | undefined;

    if (typeof addressOrCallback === 'string') {
        address = addressOrCallback;
        cb = callback;
    } else {
        address = this._remoteAddress?.address ?? '127.0.0.1';
        cb = addressOrCallback;
    }

    let data: Uint8Array;
    if (typeof msg === 'string') {
        data = engine.encodeString(msg);
    } else if (Array.isArray(msg)) {
        const buffers = msg.map(m => typeof m === 'string' ? engine.encodeString(m) : m);
        // @ts-ignore - Buffer.concat returns Buffer which is Uint8Array
        data = Buffer.concat(buffers);
    } else {
        data = msg;
    }

    try {
        if (!this._handle) {
            await this._init();
        }

        const bytes = await this._handle!.send(data, { ip: address, port });
        cb?.(null, bytes);
        this.emit('send', bytes);
    } catch (err) {
        if (cb) {
            cb(err as Error);
        } else if (this.listenerCount('error') > 0) {
            this.emit('error', err);
        }
    }
};

Socket.prototype.connect = async function connect(this: Socket, port: number, address?: string, callback?: () => void): Promise<Socket> {
    if (!this._handle) {
        await this._init();
    }

    const addr = address ?? '127.0.0.1';

    this._handle!.connect({ ip: addr, port });
    this._connected = true;

    const peername = this._handle!.getpeername();
    this._remoteAddress = {
        address: peername.ip ?? addr,
        family: this._type === 'udp6' ? 'IPv6' : 'IPv4',
        port: peername.port ?? port,
    };

    this.emit('connect');
    callback?.();

    return this;
};

Socket.prototype.disconnect = async function disconnect(this: Socket): Promise<Socket> {
    this._connected = false;
    this._remoteAddress = null;
    return this;
};

Socket.prototype.address = function address(this: Socket): AddressInfo | null {
    return this._address;
};

Socket.prototype.remoteAddress = function remoteAddress(this: Socket): AddressInfo | null {
    return this._remoteAddress;
};

Socket.prototype.setBroadcast = function setBroadcast(this: Socket, flag: boolean): Socket {
    if (!this._handle) return this;
    try {
        const s = _getSocket(this._handle);
        if (!s) return this;
        const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, flag ? 1 : 0, true);
        s.setopt(sock.defines.SOL_SOCKET, sock.defines.SO_BROADCAST, val);
    } catch { /* best-effort */ }
    return this;
};

Socket.prototype.setTTL = function setTTL(this: Socket, ttl: number): Socket {
    if (!this._handle) return this;
    try {
        const s = _getSocket(this._handle);
        if (!s) return this;
        const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, ttl, true);
        s.setopt(sock.defines.IPPROTO_IP, 2, val);
    } catch { /* best-effort */ }
    return this;
};

Socket.prototype.setMulticastTTL = function setMulticastTTL(this: Socket, ttl: number): Socket {
    if (!this._handle) return this;
    try {
        const s = _getSocket(this._handle);
        if (!s) return this;
        const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, ttl, true);
        s.setopt(sock.defines.IPPROTO_IP, 10, val);
    } catch { /* best-effort */ }
    return this;
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
    this._doClose(callback);
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
        type = typeOrOptions.type;
        reuseAddr = typeOrOptions.reuseAddr ?? false;
        ipv6Only = typeOrOptions.ipv6Only ?? false;
        signal = typeOrOptions.signal;
    } else {
        type = typeOrOptions;
    }

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
