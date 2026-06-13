/**
 * Node.js dgram module
 * Based on CModuleUDP for UDP datagrams
 */

const udp = import.meta.use('udp');
const os = import.meta.use('os');
const sock = import.meta.use('socket');
const engine = import.meta.use('engine');

import { EventEmitter } from '../events';
// @ts-ignore - buffer is dynamic import
import { Buffer } from '../buffer';

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

// ============================================================================
// Type definitions
// ============================================================================

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

// ============================================================================
// Socket class
// ============================================================================

export class Socket extends EventEmitter {
    private _handle: CModuleUDP.UDP | null = null;
    private _type: 'udp4' | 'udp6';
    private _reuseAddr: boolean;
    private _ipv6Only: boolean;
    private _bound: boolean = false;
    private _connected: boolean = false;
    private _address: AddressInfo | null = null;
    private _remoteAddress: AddressInfo | null = null;
    private _recvBufferSize: number = 65536;
    private _sendBufferSize: number = 65536;

    readonly isIPv6: boolean;

    constructor(type: 'udp4' | 'udp6', reuseAddr?: boolean, ipv6Only?: boolean) {
        super();
        this._type = type;
        this._reuseAddr = reuseAddr ?? false;
        this._ipv6Only = ipv6Only ?? false;
        this.isIPv6 = type === 'udp6';
    }

    async _init(): Promise<void> {
        const af = this._type === 'udp6' ? os.AF_INET6 : os.AF_INET;
        this._handle = await udp.create(af);
    }

    bind(port?: number, address?: string, callback?: () => void): this;
    bind(options: BindOptions, callback?: () => void): this;
    bind(portOrOptions?: number | BindOptions, addressOrCallback?: string | (() => void), callback?: () => void): this {
        // Asynchronously bind
        this._doBind(portOrOptions, addressOrCallback, callback);
        return this;
    }

    private async _doBind(portOrOptions?: number | BindOptions, addressOrCallback?: string | (() => void), callback?: () => void): Promise<void> {
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

            this._handle!.bind({ ip: address, port });
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
    }

    private async _startRecv(): Promise<void> {
        if (!this._handle || !this._bound) return;

        const buffer = new Uint8Array(this._recvBufferSize);

        while (this._handle && this._bound) {
            try {
                const result = await this._handle.recv(buffer);
                if (result.nread > 0) {
                    const msg = buffer.slice(0, result.nread);
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
    }

    send(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, address?: string, callback?: (error: Error | null, bytes?: number) => void): this;
    send(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, address: string, callback: (error: Error | null, bytes?: number) => void): this;
    send(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, addressOrCallback?: string | ((error: Error | null, bytes?: number) => void), callback?: (error: Error | null, bytes?: number) => void): this {
        // Asynchronously send
        this._doSend(msg, port, addressOrCallback, callback);
        return this;
    }

    private async _doSend(msg: string | Uint8Array | Array<string | Uint8Array>, port: number, addressOrCallback?: string | ((error: Error | null, bytes?: number) => void), callback?: (error: Error | null, bytes?: number) => void): Promise<void> {
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
            cb?.(err as Error);
            this.emit('error', err);
        }
    }

    async connect(port: number, address?: string, callback?: () => void): Promise<this> {
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
    }

    async disconnect(): Promise<this> {
        this._connected = false;
        this._remoteAddress = null;
        return this;
    }

    address(): AddressInfo | null {
        return this._address;
    }

    remoteAddress(): AddressInfo | null {
        return this._remoteAddress;
    }

    setBroadcast(flag: boolean): this {
        if (!this._handle) return this;
        try {
            const s = _getSocket(this._handle);
            if (!s) return this;
            const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, flag ? 1 : 0, true);
            s.setopt(sock.defines.SOL_SOCKET, sock.defines.SO_BROADCAST, val);
        } catch { /* best-effort */ }
        return this;
    }

    setTTL(ttl: number): this {
        if (!this._handle) return this;
        try {
            const s = _getSocket(this._handle);
            if (!s) return this;
            const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, ttl, true);
            s.setopt(sock.defines.IPPROTO_IP, 2, val);
        } catch { /* best-effort */ }
        return this;
    }

    setMulticastTTL(ttl: number): this {
        if (!this._handle) return this;
        try {
            const s = _getSocket(this._handle);
            if (!s) return this;
            const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, ttl, true);
            s.setopt(sock.defines.IPPROTO_IP, 10, val);
        } catch { /* best-effort */ }
        return this;
    }

    setMulticastInterface(multicastInterface?: string): this {
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
    }

    setMulticastLoopback(flag: boolean): this {
        if (!this._handle) return this;
        try {
            const s = _getSocket(this._handle);
            if (!s) return this;
            const val = new Uint8Array(4); new DataView(val.buffer).setUint32(0, flag ? 1 : 0, true);
            s.setopt(sock.defines.IPPROTO_IP, 11, val);
        } catch { /* best-effort */ }
        return this;
    }

    addMembership(multicastAddress: string, multicastInterface?: string): void {
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
            s.setopt(sock.defines.IPPROTO_IP, 12, mreq);
        } catch { /* best-effort */ }
    }

    dropMembership(multicastAddress: string, multicastInterface?: string): void {
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
            s.setopt(sock.defines.IPPROTO_IP, 13, mreq);
        } catch { /* best-effort */ }
    }

    addSourceSpecificMembership(_sourceAddress: string, _groupAddress: string, _multicastInterface?: string): void {
        // MCAST_JOIN_SOURCE_GROUP - C layer doesn't expose this constant
        process.emitWarning?.('dgram.addSourceSpecificMembership() is not fully supported in this runtime', 'UnsupportedWarning');
    }

    dropSourceSpecificMembership(_sourceAddress: string, _groupAddress: string, _multicastInterface?: string): void {
        process.emitWarning?.('dgram.dropSourceSpecificMembership() is not fully supported in this runtime', 'UnsupportedWarning');
    }

    getRecvBufferSize(): number {
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
    }

    setRecvBufferSize(size: number): this {
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
    }

    getSendBufferSize(): number {
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
    }

    setSendBufferSize(size: number): this {
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
    }

    private _refd: boolean = true;

    ref(): this {
        this._refd = true;
        return this;
    }

    unref(): this {
        this._refd = false;
        return this;
    }

    close(callback?: () => void): this {
        this._doClose(callback);
        return this;
    }

    private async _doClose(callback?: () => void): Promise<void> {
        if (this._handle) {
            this._bound = false;
            this._handle.close();
            this._handle = null;
        }
        this.emit('close');
        callback?.();
    }
}

// ============================================================================
// Factory functions
// ============================================================================

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