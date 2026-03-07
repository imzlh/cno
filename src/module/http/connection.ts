import { wrapFsClassDec as wrap } from "../../utils/wrap";
import { assert } from "../../utils/assert";
import { HttpClient } from "../../deno/07_http";
import { TcpSocket } from "./socket";

const ssl    = import.meta.use("ssl");
const dns    = import.meta.use("dns");
const os     = import.meta.use("os");
const timers = import.meta.use("timers");
const asfs   = import.meta.use("asyncfs");

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

interface ConnectionConfig {
    hostname: string;
    port: number;
    protocol: "http:" | "https:";
    timeout?: number;
    keepAlive?: boolean;
    keepAliveTimeout?: number;
    maxSockets?: number;
    client?: HttpClient;
}

export enum ConnectionState {
    IDLE       = "idle",
    ACTIVE     = "active",
    CONNECTING = "connecting",
    CLOSED     = "closed"
}

export interface ConnectionLike {
    socket:   CModuleStreams.TCP;
    sslPipe:  CModuleSSL.Pipe | null;
    state:    ConnectionState;
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
}

/* ------------------------------------------------------------------ */
/* CA Certificate Discovery                                           */
/* ------------------------------------------------------------------ */

async function findSystemCaPath(): Promise<string | null> {
    const sysname = os.uname().sysname;
    const candidates: string[] =
        sysname === "Linux" ? [
            "/etc/ssl/certs/ca-certificates.crt",
            "/etc/pki/tls/certs/ca-bundle.crt",
            "/etc/ssl/ca-bundle.pem",
            "/etc/pki/tls/cert.pem",
            "/etc/ssl/cert.pem"
        ] : sysname === "Darwin" ? [
            "/etc/ssl/cert.pem",
            "/usr/local/etc/openssl/cert.pem",
            "/opt/homebrew/etc/openssl/cert.pem"
        ] : sysname === "Windows_NT" ? [
            "C:\\Windows\\cacert.pem",
            "C:\\Program Files\\OpenSSL-Win64\\bin\\curl-ca-bundle.crt",
            "C:\\Program Files\\Git\\mingw64\\ssl\\cert.pem"
        ] : [];

    for (const path of candidates) {
        try {
            if ((await asfs.stat(path)).isFile) return path;
        } catch { /* not found */ }
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Single Connection                                                  */
/* ------------------------------------------------------------------ */

export class Connection extends TcpSocket implements ConnectionLike {
    public state:    ConnectionState = ConnectionState.CONNECTING;
    public lastUsed: number          = Date.now();
    public requests: number          = 0;

    private idleTimer: number | null = null;
    private config: ConnectionConfig;

    constructor(cfg: ConnectionConfig) {
        super();
        this.config = cfg;
    }

    @wrap
    async connect(): Promise<void> {
        try {
            const isSecure = this.config.protocol === "https:";

            if (this.config.client) {
                this.socket = await this.config.client.connect(
                    this.config.hostname, this.config.port, isSecure
                );
            } else {
                const addrs = await dns.resolve(this.config.hostname, { family: os.AF_UNSPEC });
                if (!addrs?.length) throw new Error(`DNS resolution failed for ${this.config.hostname}`);
                const addr = addrs.find((a: any) => a.family === 4) || addrs[0];
                assert(addr, `No IP address found for ${this.config.hostname}`);
                await this.socket.connect({ ip: addr.ip, port: this.config.port });
            }

            if (isSecure) {
                const clientCtx = this.config.client?.getSSLContext();
                if (clientCtx) {
                    await this.clientHandshake(clientCtx, this.config.hostname);
                } else {
                    const caPath = await findSystemCaPath();
                    if (!caPath) console.warn("No system CA bundle found - disabling certificate verification");
                    const ctx = new ssl.Context({ mode: "client", verify: !!caPath, ca: caPath ?? undefined });
                    await this.clientHandshake(ctx, this.config.hostname);
                }
            }

            this.state = ConnectionState.IDLE;
            this.startIdleTimer();
        } catch (err) {
            this.state = ConnectionState.CLOSED;
            throw err;
        }
    }

    markActive(): void {
        this.stopIdleTimer();
        this.state    = ConnectionState.ACTIVE;
        this.lastUsed = Date.now();
        this.requests++;
    }

    markIdle(): void {
        this.state    = ConnectionState.IDLE;
        this.lastUsed = Date.now();
        if (this.config.keepAlive) this.startIdleTimer();
        else this.close();
    }

    @wrap
    close(): void {
        if (this.state === ConnectionState.CLOSED) return;
        this.stopIdleTimer();
        super.close();
        this.state = ConnectionState.CLOSED;
    }

    isAvailable(): boolean { return this.state === ConnectionState.IDLE; }
    isClosed():    boolean { return this.state === ConnectionState.CLOSED; }

    private startIdleTimer(): void {
        if (!this.config.keepAlive) return;
        this.stopIdleTimer();
        this.idleTimer = timers.setTimeout(() => {
            if (this.state === ConnectionState.IDLE) this.close();
        }, this.config.keepAliveTimeout || 5000);
    }

    private stopIdleTimer(): void {
        if (this.idleTimer !== null) {
            timers.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
}

/* ------------------------------------------------------------------ */
/* Connection Pool Manager                                            */
/* ------------------------------------------------------------------ */

export class ConnectionManager {
    private pools = new Map<string, Connection[]>();

    private defaultConfig: Partial<ConnectionConfig> = {
        timeout: 30000, keepAlive: true, keepAliveTimeout: 5000, maxSockets: 10
    };

    private getKey(cfg: ConnectionConfig): string {
        const clientId = cfg.client ? `[client-${cfg.client.getSSLContext() ? 'custom' : 'default'}]` : '';
        const proxyId  = cfg.client?.getProxyUrl() ? `[proxy]` : '';
        return `${cfg.protocol}//${cfg.hostname}:${cfg.port}${clientId}${proxyId}`;
    }

    @wrap
    async acquire(cfg: ConnectionConfig): Promise<Connection> {
        const fullCfg = { ...this.defaultConfig, ...cfg } as ConnectionConfig;
        const key = this.getKey(fullCfg);

        this.cleanupPool(key);

        const pool = this.pools.get(key) || [];
        const available = pool.find(c => c.isAvailable());
        if (available) { available.markActive(); return available; }

        if (pool.length >= (fullCfg.maxSockets || 10)) {
            return this.waitForConnection(key, fullCfg);
        }

        const conn = new Connection(fullCfg);
        await conn.connect();
        conn.markActive();
        pool.push(conn);
        this.pools.set(key, pool);
        return conn;
    }

    release(cfg: ConnectionConfig, conn: Connection): void {
        if (conn.isClosed()) { this.removeConnection(cfg, conn); return; }
        conn.markIdle();
    }

    closeAll(): void {
        for (const pool of this.pools.values()) for (const c of pool) c.close();
        this.pools.clear();
    }

    getStats(): Record<string, { total: number; idle: number; active: number }> {
        const stats: Record<string, any> = {};
        for (const [key, pool] of this.pools.entries()) {
            stats[key] = {
                total : pool.length,
                idle  : pool.filter(c => c.state === ConnectionState.IDLE).length,
                active: pool.filter(c => c.state === ConnectionState.ACTIVE).length
            };
        }
        return stats;
    }

    @wrap
    private async waitForConnection(key: string, cfg: ConnectionConfig): Promise<Connection> {
        return new Promise((resolve, reject) => {
            const timeout = timers.setTimeout(() => reject(new Error("Connection pool timeout")), cfg.timeout || 30000);
            const interval = timers.setInterval(() => {
                const avail = (this.pools.get(key) || []).find(c => c.isAvailable());
                if (avail) {
                    timers.clearTimeout(timeout);
                    timers.clearInterval(interval);
                    avail.markActive();
                    resolve(avail);
                }
            }, 100);
        });
    }

    private cleanupPool(key: string): void {
        const pool = this.pools.get(key);
        if (!pool) return;
        const alive = pool.filter(c => !c.isClosed());
        if (alive.length === 0) this.pools.delete(key);
        else if (alive.length < pool.length) this.pools.set(key, alive);
    }

    private removeConnection(cfg: ConnectionConfig, conn: Connection): void {
        const key = this.getKey(cfg);
        const pool = this.pools.get(key);
        if (!pool) return;
        const i = pool.indexOf(conn);
        if (i !== -1) pool.splice(i, 1);
        if (pool.length === 0) this.pools.delete(key);
    }
}

export const connectionManager = new ConnectionManager();