/**
 * HTTP/HTTPS 连接管理器
 * 实现 Keep-Alive 连接池，支持连接复用和自动清理
 */

import { assert } from "../../utils/assert";

const streams = import.meta.use('streams');
const ssl = import.meta.use('ssl');
const dns = import.meta.use('dns');
const os = import.meta.use('os');
const timers = import.meta.use('timers');
const asfs = import.meta.use('asyncfs')

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/**
 * 连接配置
 */
interface ConnectionConfig {
    hostname: string;
    port: number;
    protocol: 'http:' | 'https:';
    timeout?: number;
    keepAlive?: boolean;
    keepAliveTimeout?: number;
    maxSockets?: number;
}

/**
 * 连接状态
 */
export enum ConnectionState {
    IDLE = 'idle',           // 空闲可用
    ACTIVE = 'active',       // 正在使用
    CONNECTING = 'connecting', // 连接中
    CLOSED = 'closed'        // 已关闭
}

export interface ConnectionLike {
    socket: any; // 或者更具体的 socket 类型
    sslPipe: null | CModuleSSL.Pipe;
    state: ConnectionState; // 假设 ConnectionState 是一个枚举
    lastUsed: number;
    requests: number;

    connect(): Promise<void>;
    write(data: Uint8Array): Promise<void>;
    read(size?: number): Promise<Uint8Array | null>;
    markActive(): void;
    markIdle(): void;
    close(): void;
    isAvailable(): boolean;
    isClosed(): boolean;
};

/**
 * 连接对象
 */
export class Connection implements ConnectionLike {
    public socket: CModuleStreams.TCP;
    public sslPipe: CModuleSSL.Pipe | null = null;
    public state: ConnectionState = ConnectionState.CONNECTING;
    public lastUsed: number = Date.now();
    public requests: number = 0;
    private idleTimer: number | null = null;
    private config: ConnectionConfig;

    constructor(config: ConnectionConfig) {
        this.config = config;
        this.socket = new streams.TCP();
    }

    /**
     * 连接到远程服务器
     */
    async connect(): Promise<void> {
        try {
            // DNS 解析
            const addresses = await dns.resolve(this.config.hostname, {
                family: os.AF_UNSPEC
            });

            if (!addresses || addresses.length === 0) {
                throw new Error(`DNS resolution failed for ${this.config.hostname}`);
            }

            // 优先使用 IPv4
            const addr = addresses.find(a => a.family === 4) || addresses[0];
            assert(addr, `No IPv4 address found for ${this.config.hostname}`);

            // TCP 连接
            await this.socket.connect({
                ip: addr.ip,
                port: this.config.port
            });

            // HTTPS 需要 SSL 握手
            if (this.config.protocol === 'https:') {
                await this.setupSSL();
            }

            this.state = ConnectionState.IDLE;
            this.startIdleTimer();
        } catch (err) {
            this.state = ConnectionState.CLOSED;
            throw err;
        }
    }

    /**
     * 自动探测系统 CA 证书文件路径
     * @returns {Promise<string>} 可读到的证书文件绝对路径
     * @throws  {Error} 所有候选路径都不可读时抛出
     */
    private async findSystemCaPath() {
        const candidates = (() => {
            switch (os.uname().sysname) {
                case 'Linux':
                    return [
                        '/etc/ssl/certs/ca-certificates.crt',      // Debian/Ubuntu/WSL
                        '/etc/pki/tls/certs/ca-bundle.crt',        // RHEL/CentOS 7
                        '/etc/ssl/ca-bundle.pem',                  // openSUSE/SLES
                        '/etc/pki/tls/cert.pem',                   // Fedora new layout
                        '/etc/ssl/cert.pem',                       // Alpine
                    ];
                case 'Darwin': 
                    return [
                        '/etc/ssl/cert.pem',                       // macOS 自带
                        '/usr/local/etc/openssl/cert.pem',         // Homebrew OpenSSL
                        '/opt/homebrew/etc/openssl/cert.pem',      // Homebrew on Apple Silicon
                    ];
                case 'Windows_NT':
                    return [
                        'C:\\Windows\\cacert.pem',                 // User-provided CA bundle
                        'C:\\Program Files\\OpenSSL-Win64\\bin\\curl-ca-bundle.crt', // OpenSSL full-install
                        'C:\\Program Files\\Git\\mingw64\\ssl\\cert.pem',            // Git for Windows
                    ];
                default:
                    return [];
            }
        })();
        
        for (const p of candidates) {
            try {
                const st = await asfs.stat(p);
                if (st.isFile) return p;
            } catch {
                // not-exist or not-file
            }
        }

        return null;
    }

    /**
     * 设置 SSL 连接
     */
    private async setupSSL(): Promise<void> {
        const ca = await this.findSystemCaPath();
        const context = new ssl.Context({
            mode: 'client',
            verify: !!ca,
            ca: ca ?? undefined
        });
        if (!ca) console.warn('No system CA certificate found, skipping SSL verification');

        this.sslPipe = new ssl.Pipe(context, {
            servername: this.config.hostname
        });

        // 开始握手
        this.sslPipe.doHandshake();
        let handshakeData = this.sslPipe.getOutput();
        if (handshakeData) {
            const buf = new Uint8Array(handshakeData);
            await this.socket.write(buf);
        }

        // 完成握手
        while (!this.sslPipe.handshakeComplete) {
            const readBuf = new Uint8Array(16384);
            const n = await this.socket.read(readBuf);

            if (n === null || n === 0) {
                throw new Error('SSL handshake failed: connection closed');
            }

            this.sslPipe.feed(readBuf.slice(0, n));
            this.sslPipe.doHandshake();

            handshakeData = this.sslPipe.getOutput();
            if (handshakeData) {
                const buf = new Uint8Array(handshakeData);
                await this.socket.write(buf);
            }
        }
    }

    /**
     * 写入数据
     */
    async write(data: Uint8Array): Promise<void> {
        if (this.sslPipe) {
            this.sslPipe.write(data);
            const encrypted = this.sslPipe.getOutput();
            if (encrypted) {
                await this.socket.write(new Uint8Array(encrypted));
            }
        } else {
            await this.socket.write(data);
        }
    }

    /**
     * 读取数据
     */
    async read(size: number = 16384): Promise<Uint8Array | null> {
        const buf = new Uint8Array(size);
        const n = await this.socket.read(buf);

        if (n === null || n === 0) {
            return null;
        }

        const data = buf.slice(0, n);

        if (this.sslPipe) {
            this.sslPipe.feed(data);
            const decrypted = this.sslPipe.read(size);
            return decrypted ? new Uint8Array(decrypted) : null;
        }

        return data;
    }

    /**
     * 标记为活跃状态
     */
    markActive(): void {
        this.stopIdleTimer();
        this.state = ConnectionState.ACTIVE;
        this.lastUsed = Date.now();
        this.requests++;
    }

    /**
     * 标记为空闲状态
     */
    markIdle(): void {
        this.state = ConnectionState.IDLE;
        this.lastUsed = Date.now();

        if (this.config.keepAlive) {
            this.startIdleTimer();
        } else {
            this.close();
        }
    }

    /**
     * 启动空闲定时器
     */
    private startIdleTimer(): void {
        if (!this.config.keepAlive) return;

        this.stopIdleTimer();

        const timeout = this.config.keepAliveTimeout || 5000;
        this.idleTimer = timers.setTimeout(() => {
            if (this.state === ConnectionState.IDLE) {
                this.close();
            }
        }, timeout);
    }

    /**
     * 停止空闲定时器
     */
    private stopIdleTimer(): void {
        if (this.idleTimer !== null) {
            timers.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /**
     * 关闭连接
     */
    close(): void {
        this.stopIdleTimer();

        if (this.state === ConnectionState.CLOSED) {
            return;
        }

        try {
            if (this.sslPipe) {
                this.sslPipe.shutdown();
            }
            this.socket.close();
        } catch (err) {
            // 忽略关闭错误
        }

        this.state = ConnectionState.CLOSED;
    }

    /**
     * 检查连接是否可用
     */
    isAvailable(): boolean {
        return this.state === ConnectionState.IDLE;
    }

    /**
     * 检查连接是否已关闭
     */
    isClosed(): boolean {
        return this.state === ConnectionState.CLOSED;
    }
}

/**
 * 连接池管理器
 */
export class ConnectionManager {
    private pools: Map<string, Connection[]> = new Map();
    private defaultConfig: Partial<ConnectionConfig> = {
        timeout: 30000,
        keepAlive: true,
        keepAliveTimeout: 5000,
        maxSockets: 10
    };

    /**
     * 获取连接键
     */
    private getKey(config: ConnectionConfig): string {
        return `${config.protocol}//${config.hostname}:${config.port}`;
    }

    /**
     * 获取或创建连接
     */
    async acquire(config: ConnectionConfig): Promise<Connection> {
        const fullConfig = { ...this.defaultConfig, ...config };
        const key = this.getKey(fullConfig as ConnectionConfig);

        // 清理已关闭的连接
        this.cleanupPool(key);

        // 查找可用连接
        const pool = this.pools.get(key) || [];
        const available = pool.find(conn => conn.isAvailable());

        if (available) {
            available.markActive();
            return available;
        }

        // 检查连接数限制
        const maxSockets = fullConfig.maxSockets || 10;
        if (pool.length >= maxSockets) {
            // 等待可用连接
            return this.waitForConnection(key, fullConfig as ConnectionConfig);
        }

        // 创建新连接
        const conn = new Connection(fullConfig as ConnectionConfig);
        await conn.connect();
        conn.markActive();

        pool.push(conn);
        this.pools.set(key, pool);

        return conn;
    }

    /**
     * 释放连接
     */
    release(config: ConnectionConfig, conn: Connection): void {
        if (conn.isClosed()) {
            this.removeConnection(config, conn);
            return;
        }

        conn.markIdle();
    }

    /**
     * 等待可用连接
     */
    private async waitForConnection(
        key: string,
        config: ConnectionConfig
    ): Promise<Connection> {
        return new Promise((resolve, reject) => {
            const timeout = timers.setTimeout(() => {
                reject(new Error('Connection pool timeout'));
            }, config.timeout || 30000);

            const checkInterval = timers.setInterval(() => {
                const pool = this.pools.get(key) || [];
                const available = pool.find(conn => conn.isAvailable());

                if (available) {
                    timers.clearTimeout(timeout);
                    timers.clearInterval(checkInterval);
                    available.markActive();
                    resolve(available);
                }
            }, 100);
        });
    }

    /**
     * 清理连接池
     */
    private cleanupPool(key: string): void {
        const pool = this.pools.get(key);
        if (!pool) return;

        const active = pool.filter(conn => !conn.isClosed());

        if (active.length === 0) {
            this.pools.delete(key);
        } else {
            this.pools.set(key, active);
        }
    }

    /**
     * 移除连接
     */
    private removeConnection(config: ConnectionConfig, conn: Connection): void {
        const key = this.getKey(config);
        const pool = this.pools.get(key);

        if (!pool) return;

        const index = pool.indexOf(conn);
        if (index !== -1) {
            pool.splice(index, 1);
        }

        if (pool.length === 0) {
            this.pools.delete(key);
        }
    }

    /**
     * 关闭所有连接
     */
    closeAll(): void {
        for (const pool of this.pools.values()) {
            for (const conn of pool) {
                conn.close();
            }
        }
        this.pools.clear();
    }

    /**
     * 获取连接池统计
     */
    getStats(): Record<string, { total: number; idle: number; active: number }> {
        const stats: Record<string, any> = {};

        for (const [key, pool] of this.pools.entries()) {
            const idle = pool.filter(c => c.state === ConnectionState.IDLE).length;
            const active = pool.filter(c => c.state === ConnectionState.ACTIVE).length;

            stats[key] = {
                total: pool.length,
                idle,
                active
            };
        }

        return stats;
    }
}

// 导出单例
export const connectionManager = new ConnectionManager();