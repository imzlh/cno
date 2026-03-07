/**
 * Node.js net 模块
 * 基于 CModuleStreams 实现 TCP 网络
 */

const streams = import.meta.use('streams');
const os = import.meta.use('os');

import { EventEmitter } from '../events';
import { Duplex, Readable, Writable } from '../stream';

// ============================================================================
// 类型定义
// ============================================================================

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
    lookup?: (hostname: string, options: any, callback: (err: Error | null, address: string, family: number) => void) => void;
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

// ============================================================================
// Socket
// ============================================================================

export class Socket extends Duplex {
    private _tcp: CModuleStreams.TCP | null = null;
    private _connecting: boolean = false;
    private _destroyed: boolean = false;
    private _readable: boolean = true;
    private _writable: boolean = true;
    private _address: AddressInfo | null = null;
    private _remoteAddress: AddressInfo | null = null;
    private _timeout: number | null = null;
    private _keepAlive: boolean = false;
    private _keepAliveDelay: number = 0;
    private _noDelay: boolean = false;

    bytesRead: number = 0;
    bytesWritten: number = 0;
    connecting: boolean = false;
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
    readyState: 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed' = 'closed';

    constructor(options?: SocketConstructorOpts) {
        super({ allowHalfOpen: options?.allowHalfOpen });

        if (options?.fd) {
            // 从现有 fd 创建
            this._tcp = new streams.TCP();
            this.readyState = 'open';
        }

        if (options?.readable === false) this._readable = false;
        if (options?.writable === false) this._writable = false;

        if (options?.signal) {
            options.signal.addEventListener('abort', () => {
                this.destroy(new Error('aborted'));
            });
        }
    }

    connect(options: TcpNetConnectOpts): this;
    connect(port: number, host?: string, connectListener?: () => void): this;
    connect(path: string, connectListener?: () => void): this;
    connect(portOrPath: number | string | TcpNetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): this {
        let port: number | undefined;
        let host: string = 'localhost';
        let connectListener: (() => void) | undefined;

        if (typeof portOrPath === 'object') {
            port = portOrPath.port;
            host = portOrPath.host ?? 'localhost';
            connectListener = undefined;
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
            throw new Error('Unix socket not supported yet');
        }

        this.connecting = true;
        this._connecting = true;
        this.readyState = 'opening';

        const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
        this._tcp = new streams.TCP(family);

        if (this._noDelay) {
            this._tcp.setNoDelay(true);
        }

        this._tcp.connect({ ip: host, port: port! }).then(() => {
            this.connecting = false;
            this._connecting = false;
            this.readyState = 'open';

            const localInfo = this._tcp!.getsockname();
            this.localAddress = localInfo.ip;
            this.localPort = localInfo.port;

            const remoteInfo = this._tcp!.getpeername();
            this.remoteAddress = remoteInfo.ip;
            this.remotePort = remoteInfo.port;
            this.remoteFamily = `IPv${remoteInfo.family}`;

            if (this._keepAlive) {
                this._tcp!.setKeepAlive(true, this._keepAliveDelay);
            }

            this.emit('connect');
            if (connectListener) connectListener();
        }).catch((err) => {
            this.emit('error', err);
            this.destroy();
        });

        return this;
    }

    setEncoding(encoding?: BufferEncoding): this {
        return this;
    }

    pause(): this {
        return this;
    }

    resume(): this {
        return this;
    }

    setTimeout(timeout: number, callback?: () => void): this {
        this._timeout = timeout;
        if (callback) {
            this.once('timeout', callback);
        }
        return this;
    }

    setNoDelay(noDelay?: boolean): this {
        this._noDelay = noDelay ?? true;
        if (this._tcp) {
            this._tcp.setNoDelay(this._noDelay);
        }
        return this;
    }

    setKeepAlive(enable?: boolean, initialDelay?: number): this {
        this._keepAlive = enable ?? true;
        this._keepAliveDelay = initialDelay ?? 0;
        if (this._tcp) {
            this._tcp.setKeepAlive(this._keepAlive, this._keepAliveDelay);
        }
        return this;
    }

    address(): AddressInfo | {} {
        if (!this._tcp) return {};
        const info = this._tcp.getsockname();
        return {
            address: info.ip,
            family: `IPv${info.family}`,
            port: info.port,
        };
    }

    unref(): this {
        return this;
    }

    ref(): this {
        return this;
    }

    write(data: Uint8Array | string, encodingOrCb?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void): boolean {
        if (this._destroyed) {
            const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
            callback?.(new Error('Socket is destroyed'));
            return false;
        }

        let encoding: BufferEncoding = 'utf8';
        let callback: ((err?: Error) => void) | undefined;

        if (typeof encodingOrCb === 'function') {
            callback = encodingOrCb;
        } else if (typeof encodingOrCb === 'string') {
            encoding = encodingOrCb;
            callback = cb;
        }

        const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;

        if (!this._tcp) {
            callback?.(new Error('Socket not connected'));
            return false;
        }

        this._tcp.write(buffer).then((written) => {
            this.bytesWritten += written;
            callback?.();
        }).catch((err) => {
            callback?.(err);
            this.emit('error', err);
        });

        return true;
    }

    end(data?: Uint8Array | string, encoding?: BufferEncoding | (() => void), cb?: () => void): this {
        if (data) {
            this.write(data, typeof encoding === 'function' ? undefined : encoding);
        }

        if (this._tcp) {
            this._tcp.shutdown().then(() => {
                this.emit('end');
                this.emit('finish');
                this.destroy();
            });
        }

        return this;
    }

    destroy(error?: Error): this {
        if (this._destroyed) return this;
        this._destroyed = true;
        this.readyState = 'closed';

        if (this._tcp) {
            try {
                this._tcp.close();
            } catch {}
            this._tcp = null;
        }

        if (error) {
            this.emit('error', error);
        }
        this.emit('close', !!error);

        return this;
    }

    protected _read(size: number): void {
        if (!this._tcp || this._destroyed) return;

        const buffer = new Uint8Array(size);
        this._tcp.read(buffer).then((bytesRead) => {
            if (bytesRead === null) {
                // @ts-ignore - push exists on Readable side of Duplex
                this.push(null);
                this.emit('end');
            } else {
                this.bytesRead += bytesRead;
                // @ts-ignore - push exists on Readable side of Duplex
                this.push(buffer.slice(0, bytesRead));
            }
        }).catch((err) => {
            this.emit('error', err);
        });
    }

    protected _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.write(chunk, encoding, callback);
    }
}

// ============================================================================
// Server
// ============================================================================

export class Server extends EventEmitter {
    private _tcp: CModuleStreams.TCP | null = null;
    private _listening: boolean = false;
    private _connections: Set<Socket> = new Set();
    private _maxConnections: number = 0;
    private _allowHalfOpen: boolean = false;
    private _pauseOnConnect: boolean = false;
    private _address: AddressInfo | null = null;

    maxConnections: number = 0;
    connections: number = 0;

    constructor(connectionListener?: (socket: Socket) => void);
    constructor(options?: ServerOpts, connectionListener?: (socket: Socket) => void);
    constructor(options?: ServerOpts | ((socket: Socket) => void), connectionListener?: (socket: Socket) => void) {
        super();

        if (typeof options === 'function') {
            connectionListener = options;
            options = {};
        }

        if (options && typeof options === 'object') {
            this._allowHalfOpen = options.allowHalfOpen ?? false;
            this._pauseOnConnect = options.pauseOnConnect ?? false;
        }

        if (connectionListener) {
            this.on('connection', connectionListener);
        }
    }

    listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this;
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    listen(port?: number, backlog?: number, listeningListener?: () => void): this;
    listen(path: string, backlog?: number, listeningListener?: () => void): this;
    listen(options: ListenOptions, listeningListener?: () => void): this;
    listen(handle: any, backlog?: number, listeningListener?: () => void): this;
    listen(portOrPathOrOptions?: number | string | ListenOptions | any, ...args: any[]): this {
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
            throw new Error('Unix socket not supported yet');
        } else if (typeof portOrPathOrOptions === 'object') {
            const options = portOrPathOrOptions as ListenOptions;
            port = options.port;
            host = options.host ?? '0.0.0.0';
            backlog = options.backlog ?? 511;
            ipv6Only = options.ipv6Only ?? false;
            listeningListener = args[0];
        }

        const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
        this._tcp = new streams.TCP(family);

        try {
            this._tcp.bind({ ip: host, port: port ?? 0 });
            this._tcp.listen(backlog);

            const info = this._tcp.getsockname();
            this._address = {
                address: info.ip,
                family: `IPv${info.family}`,
                port: info.port,
            };

            this._listening = true;
            this.emit('listening');
            if (listeningListener) listeningListener();

            this._acceptLoop();
        } catch (err) {
            this.emit('error', err);
            return this;
        }

        return this;
    }

    private async _acceptLoop(): Promise<void> {
        while (this._listening && this._tcp) {
            try {
                const clientTcp = await this._tcp.accept();
                const socket = new Socket();
                (socket as any)._tcp = clientTcp;
                socket.readyState = 'open';

                const localInfo = (clientTcp as CModuleStreams.TCP).getsockname();
                socket.localAddress = localInfo.ip;
                socket.localPort = localInfo.port;

                const remoteInfo = (clientTcp as CModuleStreams.TCP).getpeername();
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
            } catch (err) {
                if (this._listening) {
                    this.emit('error', err);
                }
            }
        }
    }

    address(): AddressInfo | string | null {
        if (!this._address) return null;
        return this._address;
    }

    getConnections(cb: (err: Error | null, count: number) => void): void {
        cb(null, this._connections.size);
    }

    close(callback?: (err?: Error) => void): this {
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
            } catch {}
            this._tcp = null;
        }

        this.emit('close');
        callback?.();

        return this;
    }

    ref(): this {
        return this;
    }

    unref(): this {
        return this;
    }
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createServer(options?: ServerOpts, connectionListener?: (socket: Socket) => void): Server {
    return new Server(options, connectionListener);
}

export function connect(options: TcpNetConnectOpts): Socket;
export function connect(port: number, host?: string, connectListener?: () => void): Socket;
export function connect(path: string, connectListener?: () => void): Socket;
export function connect(portOrPath: number | string | TcpNetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): Socket {
    const socket = new Socket();
    if (typeof portOrPath === 'object') {
        socket.connect(portOrPath);
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

export function createConnection(options: TcpNetConnectOpts): Socket;
export function createConnection(port: number, host?: string, connectListener?: () => void): Socket;
export function createConnection(path: string, connectListener?: () => void): Socket;
export function createConnection(portOrPath: number | string | TcpNetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): Socket {
    return connect(portOrPath as any, hostOrCb as any, cb);
}

// ============================================================================
// isIP / isIPv4 / isIPv6
// ============================================================================

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
    // 简化的 IPv6 检测
    if (input.includes(':')) {
        const parts = input.split(':');
        if (parts.length < 3 || parts.length > 8) return false;
        // 检查每个部分
        for (const part of parts) {
            if (part === '') continue; // 允许 :: 
            if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false;
        }
        return true;
    }
    return false;
}