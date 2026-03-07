/**
 * Node.js dgram 模块
 * 基于 CModuleUDP 实现 UDP 数据报
 */

const udp = import.meta.use('udp');
const os = import.meta.use('os');

import { EventEmitter } from '../events';
// @ts-ignore - buffer is dynamic import
import { Buffer } from '../buffer';

// ============================================================================
// 类型定义
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
// Socket 类
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
        // 异步执行绑定
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

            await this._handle!.bind({ ip: address, port });
            this._bound = true;

            const sockname = await this._handle!.getsockname();
            this._address = {
                address: sockname.ip ?? address,
                family: this._type === 'udp6' ? 'IPv6' : 'IPv4',
                port: sockname.port ?? port,
            };

            this.emit('listening');
            cb?.();

            // 开始接收
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
        // 异步执行发送
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
            data = new TextEncoder().encode(msg);
        } else if (Array.isArray(msg)) {
            const buffers = msg.map(m => typeof m === 'string' ? new TextEncoder().encode(m) : m);
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

        await this._handle!.connect({ ip: addr, port });
        this._connected = true;

        const peername = await this._handle!.getpeername();
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
        return this;
    }

    setTTL(ttl: number): this {
        return this;
    }

    setMulticastTTL(ttl: number): this {
        return this;
    }

    setMulticastInterface(multicastInterface?: string): this {
        return this;
    }

    setMulticastLoopback(flag: boolean): this {
        return this;
    }

    addMembership(multicastAddress: string, multicastInterface?: string): void {}

    dropMembership(multicastAddress: string, multicastInterface?: string): void {}

    addSourceSpecificMembership(sourceAddress: string, groupAddress: string, multicastInterface?: string): void {}

    dropSourceSpecificMembership(sourceAddress: string, groupAddress: string, multicastInterface?: string): void {}

    getRecvBufferSize(): number {
        return this._recvBufferSize;
    }

    setRecvBufferSize(size: number): this {
        this._recvBufferSize = size;
        return this;
    }

    getSendBufferSize(): number {
        return this._sendBufferSize;
    }

    setSendBufferSize(size: number): this {
        this._sendBufferSize = size;
        return this;
    }

    ref(): this {
        return this;
    }

    unref(): this {
        return this;
    }

    close(callback?: () => void): this {
        this._doClose(callback);
        return this;
    }

    private async _doClose(callback?: () => void): Promise<void> {
        if (this._handle) {
            this._bound = false;
            await this._handle.close();
            this._handle = null;
        }
        this.emit('close');
        callback?.();
    }
}

// ============================================================================
// 工厂函数
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