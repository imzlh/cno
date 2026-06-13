/**
 * Node.js net module
 * Based on CModuleStreams for TCP networking
 */

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const engine = import.meta.use('engine');

import { EventEmitter } from '../events';
import { Duplex, Readable, Writable } from '../stream';

// ============================================================================
// Type definitions
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
    private _stream: CModuleStreams.Pipe | null = null;
    private _connecting: boolean = false;
    private _destroyed: boolean = false;
    private _readable: boolean = true;
    private _writable: boolean = true;
    private _address: AddressInfo | null = null;
    private _remoteAddress: AddressInfo | null = null;
    private _timeout: number | null = null;
    private _timeoutId: any = null;
    private _keepAlive: boolean = false;
    private _keepAliveDelay: number = 0;
    private _noDelay: boolean = false;
    private _readBuffer: Uint8Array = new Uint8Array(65536);

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
            this.connecting = true;
            this._connecting = true;
            this.readyState = 'opening';

            const pipe = new streams.Pipe();
            pipe.connect(host as string).then(() => {
                this._stream = pipe;
                this.connecting = false;
                this._connecting = false;
                this.readyState = 'open';
                this.emit('connect');
                if (connectListener) connectListener();
                this._startPipeRead();
            }).catch((err: any) => {
                this.emit('error', err);
                this.destroy();
            });

            return this;
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

            const localInfo = this._tcp!.sockname;
            this.localAddress = localInfo.ip;
            this.localPort = localInfo.port;

            const remoteInfo = this._tcp!.peername;
            this.remoteAddress = remoteInfo.ip;
            this.remotePort = remoteInfo.port;
            this.remoteFamily = `IPv${remoteInfo.family}`;

            if (this._keepAlive) {
                this._tcp!.setKeepAlive(true, this._keepAliveDelay);
            }

            this.emit('connect');
            if (connectListener) connectListener();

            // Start reading automatically after connect
            this.resume();
        }).catch((err) => {
            this.emit('error', err);
            this.destroy();
        });

        return this;
    }

    private _startPipeRead(): void {
        if (!this._stream) return;
        this._stream.onread = (result: any, error: any) => {
            if (error) { this.emit('error', error); return; }
            if (result === null || result === undefined) {
                this.push(null);
                this.emit('end');
                return;
            }
            this.bytesRead += result.byteLength;
            this.push(result);
        };
        this._stream.startRead();
    }

    setEncoding(encoding?: BufferEncoding): this {
        if (encoding) this.readableEncoding = encoding;
        return this;
    }

    pause(): this {
        const state = this._readableState;
        if (state.flowing !== false) {
            state.flowing = false;
            this.emit('pause');
        }
        if (this._tcp) this._tcp.stopRead();
        return this;
    }

    resume(): this {
        const state = this._readableState;
        if (!state.flowing) {
            state.flowing = true;
            this.emit('resume');
        }
        if (this._tcp) this._startTcpRead();
        if (this._stream) this._stream.startRead();
        return this;
    }

    setTimeout(timeout: number, callback?: () => void): this {
        this._timeout = timeout;
        if (this._timeoutId) clearTimeout(this._timeoutId);
        if (timeout > 0) {
            this._timeoutId = setTimeout(() => {
                this.emit('timeout');
                if (callback) callback();
            }, timeout);
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
        if (this._tcp) {
            const info = this._tcp.sockname;
            return {
                address: info.ip,
                family: `IPv${info.family}`,
                port: info.port,
            };
        }
        return this._address || {};
    }

    unref(): this {
        if (this._tcp) this._tcp.unref();
        return this;
    }

    ref(): this {
        if (this._tcp) this._tcp.ref();
        return this;
    }

    /** Sustained TCP read loop driven by Duplex _read */
    private _startTcpRead(): void {
        if (!this._tcp || this._destroyed) return;

        (this._tcp as any).onread = (result: any, error: any) => {
            if (error) {
                this.emit('error', error);
                return;
            }
            if (result === null || result === undefined) {
                this.push(null);
                this.emit('end');
                return;
            }
            const data = result as Uint8Array;
            this.bytesRead += data.byteLength;
            this.push(data);
        };

        (this._tcp as any).startRead();
    }

    /** Duplex _read — called when consumer wants data */
    protected _read(size: number): void {
        if (this._destroyed) return;
        if (this._tcp) {
            this._startTcpRead();
        } else if (this._stream) {
            this._startPipeRead();
        }
    }

    /** Duplex _write — called by _writeBuffered with one chunk at a time */
    protected _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (this._destroyed) {
            callback(new Error('Socket is destroyed'));
            return;
        }

        const buffer = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk as Uint8Array;

        if (this._tcp) {
            this._tcp.write(buffer).then((written: number) => {
                this.bytesWritten += written;
                callback();
            }).catch((err: Error) => {
                callback(err);
            });
        } else if (this._stream) {
            this._stream.write(buffer).then(() => {
                this.bytesWritten += buffer.byteLength;
                callback();
            }).catch((err: Error) => {
                callback(err);
            });
        } else {
            callback(new Error('Socket not connected'));
        }
    }

    destroy(error?: Error): this {
        if (this._destroyed) return this;
        this._destroyed = true;
        this.readyState = 'closed';
        this.readable = false;
        this.writable = false;

        if (this._timeoutId) {
            clearTimeout(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._tcp) {
            try { this._tcp.close(); } catch {}
            this._tcp = null;
        }

        if (this._stream) {
            try { this._stream.close(); } catch {}
            this._stream = null;
        }

        if (error) {
            this.emit('error', error);
        }
        this.emit('close', !!error);

        return this;
    }
}

// ============================================================================
// Server
// ============================================================================

export class Server extends EventEmitter {
    private _tcp: CModuleStreams.TCP | null = null;
    private _pipe: CModuleStreams.Pipe | null = null;
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
            const pipePath = portOrPathOrOptions;
            this._pipe = new streams.Pipe();
            try {
                this._pipe.bind(pipePath);
                this._pipe.listen(backlog ?? 511);
                this._pipe.onconnection = (error: any, client: any) => {
                    if (error) { this.emit('error', error); return; }
                    const socket = new Socket({ allowHalfOpen: this._allowHalfOpen });
                    (socket as any)._stream = client;
                    socket.emit('connect');
                    this.emit('connection', socket);
                };
                this._address = { address: pipePath, family: 'Unix', port: -1 };
                this._listening = true;
                if (listeningListener) this.once('listening', listeningListener);
                this.emit('listening');
            } catch (err: any) {
                this.emit('error', err);
            }
            return this;
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
            const info = this._tcp.sockname;
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

    private _acceptLoop(): Promise<void> {
        return new Promise((rs, rj) => this._tcp!.onconnection = (error, clientTcp) => {
            if (error || !clientTcp) return rj(error);
            if (!this._listening) return rs();
            
            const socket = new Socket();
            (socket as any)._tcp = clientTcp;
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
            } else {
                socket.resume();
            }

            this.emit('connection', socket);
        });
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
            } catch { }
            this._tcp = null;
        }

        this.emit('close');
        callback?.();

        return this;
    }

    ref(): this {
        if (this._tcp) this._tcp.ref();
        return this;
    }

    unref(): this {
        if (this._tcp) this._tcp.unref();
        return this;
    }
}

// ============================================================================
// Factory functions
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