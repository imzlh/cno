/**
 * HTTP/HTTPS Connection Manager
 * Implements Keep-Alive pooling with connection reuse and automatic cleanup.
 * 
 * Critical OpenSSL BIO behavior:
 * - feed() returns bytes consumed (may be < input length)
 * - read() returns 0 when no data buffered (NOT an error)
 * - handshake() must be called repeatedly until complete
 */

import { assert } from "../../utils/assert";

const streams = import.meta.use("streams");
const ssl     = import.meta.use("ssl");
const dns     = import.meta.use("dns");
const os      = import.meta.use("os");
const timers  = import.meta.use("timers");
const asfs    = import.meta.use("asyncfs");

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* Configuration & State                                              */
/* ------------------------------------------------------------------ */

interface ConnectionConfig {
    hostname: string;
    port: number;
    protocol: "http:" | "https:";
    timeout?: number;
    keepAlive?: boolean;
    keepAliveTimeout?: number;
    maxSockets?: number;
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
/* Single Connection                                                  */
/* ------------------------------------------------------------------ */

export class Connection implements ConnectionLike {
    public socket:   CModuleStreams.TCP;
    public sslPipe:  CModuleSSL.Pipe | null = null;
    public state:    ConnectionState        = ConnectionState.CONNECTING;
    public lastUsed: number                 = Date.now();
    public requests: number                 = 0;

    private idleTimer: number | null = null;
    private config: ConnectionConfig;
    
    // Buffer for unfed ciphertext when SSL pipe is full
    private pendingCiphertext: Uint8Array | null = null;

    constructor(cfg: ConnectionConfig) {
        this.config = cfg;
        this.socket = new streams.TCP();
    }

    /* -------------------------------------------------------------- */
    /* Public API                                                     */
    /* -------------------------------------------------------------- */

    async connect(): Promise<void> {
        try {
            // DNS resolution
            const addrs = await dns.resolve(this.config.hostname, { family: os.AF_UNSPEC });
            if (!addrs || !addrs.length) {
                throw new Error(`DNS resolution failed for ${this.config.hostname}`);
            }

            // Prefer IPv4
            const addr = addrs.find(a => a.family === 4) || addrs[0];
            assert(addr, `No IP address found for ${this.config.hostname}`);

            // TCP connect
            await this.socket.connect({ ip: addr.ip, port: this.config.port });

            // TLS handshake if HTTPS
            if (this.config.protocol === "https:") {
                await this.performTLSHandshake();
            }

            this.state = ConnectionState.IDLE;
            this.startIdleTimer();
        } catch (err) {
            this.state = ConnectionState.CLOSED;
            throw err;
        }
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.sslPipe) {
            // SSL mode: encrypt plaintext
            const written = this.sslPipe.write(data);
            
            // Note: write() returns bytes written, but OpenSSL may buffer
            // We assume it always accepts all data for application writes
            if (written < 0) {
                throw new Error(`SSL_write failed: ${written}`);
            }

            // Send encrypted data to network
            const encrypted = this.sslPipe.getOutput();
            if (encrypted) {
                await this.socket.write(new Uint8Array(encrypted));
            }
        } else {
            // Plain HTTP: write directly
            await this.socket.write(data);
        }
    }

    async read(size = 16384): Promise<Uint8Array | null> {
        if (this.sslPipe) {
            // Try to read buffered plaintext first
            const buffered = this.sslPipe.read(size);
            if (buffered && buffered.byteLength > 0) {
                return new Uint8Array(buffered);
            }

            // Feed any pending ciphertext from previous partial feed
            if (this.pendingCiphertext && this.pendingCiphertext.length > 0) {
                const consumed = this.feedCiphertext(this.pendingCiphertext);
                if (consumed > 0) {
                    this.pendingCiphertext = consumed < this.pendingCiphertext.length
                        ? this.pendingCiphertext.subarray(consumed)
                        : null;
                }
                
                // Check if we got plaintext now
                const plain = this.sslPipe.read(size);
                if (plain && plain.byteLength > 0) {
                    return new Uint8Array(plain);
                }
            }

            // Read more ciphertext from network
            const cipherBuf = new Uint8Array(size);
            const n = await this.socket.read(cipherBuf);
            
            if (n === null || n === 0) {
                return null; // EOF or no data
            }

            // Feed ciphertext to SSL pipe
            const ciphertext = cipherBuf.subarray(0, n);
            const consumed = this.feedCiphertext(ciphertext);
            
            // Store unfed portion for next read
            if (consumed < ciphertext.length) {
                this.pendingCiphertext = ciphertext.subarray(consumed);
            }

            // Try to read decrypted plaintext
            const plaintext = this.sslPipe.read(size);
            
            // IMPORTANT: read() returns 0/null when no data, NOT an error
            return (plaintext && plaintext.byteLength > 0) 
                ? new Uint8Array(plaintext) 
                : null;
        } else {
            // Plain HTTP: read directly from socket
            const buf = new Uint8Array(size);
            const n = await this.socket.read(buf);
            
            if (n === null || n === 0) {
                return null;
            }
            
            return buf.subarray(0, n);
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
        
        if (this.config.keepAlive) {
            this.startIdleTimer();
        } else {
            this.close();
        }
    }

    close(): void {
        if (this.state === ConnectionState.CLOSED) return;

        this.stopIdleTimer();
        
        try {
            if (this.sslPipe) {
                this.sslPipe.shutdown();
            }
            this.socket.close();
        } catch (err) {
            // Ignore close errors
        }

        this.state = ConnectionState.CLOSED;
        this.pendingCiphertext = null;
    }

    isAvailable(): boolean {
        return this.state === ConnectionState.IDLE;
    }

    isClosed(): boolean {
        return this.state === ConnectionState.CLOSED;
    }

    /* -------------------------------------------------------------- */
    /* TLS Handshake                                                  */
    /* -------------------------------------------------------------- */

    private async performTLSHandshake(): Promise<void> {
        // Find system CA bundle
        const caPath = await this.findSystemCaPath();
        
        // Create SSL context
        const ctx = new ssl.Context({
            mode  : "client",
            verify: !!caPath,
            ca    : caPath ?? undefined
        });
        
        if (!caPath) {
            console.warn("No system CA bundle found - disabling certificate verification");
        }

        // Create SSL pipe
        this.sslPipe = new ssl.Pipe(ctx, { servername: this.config.hostname });

        // Start handshake (generates ClientHello)
        this.sslPipe.handshake();
        
        // Send initial handshake data
        const initialData = this.sslPipe.getOutput();
        if (initialData) {
            await this.socket.write(new Uint8Array(initialData));
        }

        // Complete handshake loop
        while (!this.sslPipe.handshakeComplete) {
            // Read server response
            const buf = new Uint8Array(16384);
            const n = await this.socket.read(buf);
            
            if (n === null || n === 0) {
                throw new Error("TLS handshake failed: connection closed");
            }

            // Feed server data to SSL pipe
            // CRITICAL: feed() may not consume all data at once
            let toFeed = buf.subarray(0, n);
            while (toFeed.length > 0) {
                const consumed = this.feedCiphertext(toFeed);
                
                if (consumed <= 0) {
                    // Should not happen during handshake, but handle gracefully
                    throw new Error(`SSL feed failed during handshake: consumed=${consumed}`);
                }
                
                if (consumed < toFeed.length) {
                    toFeed = toFeed.subarray(consumed);
                } else {
                    break;
                }
            }

            // Advance handshake state machine
            this.sslPipe.handshake();

            // Send handshake response if any
            const responseData = this.sslPipe.getOutput();
            if (responseData) {
                await this.socket.write(new Uint8Array(responseData));
            }
        }
    }

    /* -------------------------------------------------------------- */
    /* SSL Pipe Helpers                                               */
    /* -------------------------------------------------------------- */

    /**
     * Feed ciphertext to SSL pipe
     * Returns: number of bytes consumed (may be < data.length)
     * 
     * CRITICAL: feed() uses BIO_write which may return less than
     * the input size when the internal buffer is full
     */
    private feedCiphertext(data: Uint8Array): number {
        if (!this.sslPipe) return 0;
        
        const consumed = this.sslPipe.feed(data);
        
        // consumed can be:
        // - positive: bytes written to BIO
        // - 0: BIO buffer full (try again later)
        // - negative: error (should not happen normally)
        
        if (consumed < 0) {
            throw new Error(`SSL feed error: ${consumed}`);
        }
        
        return consumed;
    }

    /* -------------------------------------------------------------- */
    /* CA Certificate Discovery                                       */
    /* -------------------------------------------------------------- */

    private async findSystemCaPath(): Promise<string | null> {
        const candidates = (() => {
            switch (os.uname().sysname) {
                case "Linux":
                    return [
                        "/etc/ssl/certs/ca-certificates.crt",       // Debian/Ubuntu
                        "/etc/pki/tls/certs/ca-bundle.crt",        // RHEL/CentOS
                        "/etc/ssl/ca-bundle.pem",                  // OpenSUSE
                        "/etc/pki/tls/cert.pem",                   // Fedora
                        "/etc/ssl/cert.pem"                        // Alpine
                    ];
                case "Darwin":
                    return [
                        "/etc/ssl/cert.pem",                       // macOS system
                        "/usr/local/etc/openssl/cert.pem",         // Homebrew Intel
                        "/opt/homebrew/etc/openssl/cert.pem"       // Homebrew ARM
                    ];
                case "Windows_NT":
                    return [
                        "C:\\Windows\\cacert.pem",
                        "C:\\Program Files\\OpenSSL-Win64\\bin\\curl-ca-bundle.crt",
                        "C:\\Program Files\\Git\\mingw64\\ssl\\cert.pem"
                    ];
                default:
                    return [];
            }
        })();

        for (const path of candidates) {
            try {
                const stat = await asfs.stat(path);
                if (stat.isFile) {
                    return path;
                }
            } catch (err) {
                // File doesn't exist, try next
            }
        }

        return null;
    }

    /* -------------------------------------------------------------- */
    /* Idle Timeout Management                                        */
    /* -------------------------------------------------------------- */

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
        timeout         : 30000,
        keepAlive       : true,
        keepAliveTimeout: 5000,
        maxSockets      : 10
    };

    /**
     * Generate pool key from connection config
     */
    private getKey(cfg: ConnectionConfig): string {
        return `${cfg.protocol}//${cfg.hostname}:${cfg.port}`;
    }

    /**
     * Acquire a connection from the pool or create a new one
     */
    async acquire(cfg: ConnectionConfig): Promise<Connection> {
        const fullCfg = { ...this.defaultConfig, ...cfg } as ConnectionConfig;
        const key = this.getKey(fullCfg);

        // Clean up closed connections
        this.cleanupPool(key);

        // Try to reuse an idle connection
        const pool = this.pools.get(key) || [];
        const available = pool.find(c => c.isAvailable());
        
        if (available) {
            available.markActive();
            return available;
        }

        // Check pool size limit
        const maxSockets = fullCfg.maxSockets || 10;
        if (pool.length >= maxSockets) {
            return this.waitForConnection(key, fullCfg);
        }

        // Create new connection
        const conn = new Connection(fullCfg);
        await conn.connect();
        conn.markActive();

        // Add to pool
        pool.push(conn);
        this.pools.set(key, pool);

        return conn;
    }

    /**
     * Release a connection back to the pool
     */
    release(cfg: ConnectionConfig, conn: Connection): void {
        if (conn.isClosed()) {
            this.removeConnection(cfg, conn);
            return;
        }

        conn.markIdle();
    }

    /**
     * Close all connections in all pools
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
     * Get pool statistics
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

    /* -------------------------------------------------------------- */
    /* Private Helpers                                                */
    /* -------------------------------------------------------------- */

    /**
     * Wait for a connection to become available
     */
    private async waitForConnection(key: string, cfg: ConnectionConfig): Promise<Connection> {
        return new Promise((resolve, reject) => {
            const timeout = timers.setTimeout(() => {
                reject(new Error("Connection pool timeout"));
            }, cfg.timeout || 30000);

            const checkInterval = timers.setInterval(() => {
                const pool = this.pools.get(key) || [];
                const available = pool.find(c => c.isAvailable());

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
     * Remove closed connections from pool
     */
    private cleanupPool(key: string): void {
        const pool = this.pools.get(key);
        if (!pool) return;

        const alive = pool.filter(c => !c.isClosed());

        if (alive.length === 0) {
            this.pools.delete(key);
        } else if (alive.length < pool.length) {
            this.pools.set(key, alive);
        }
    }

    /**
     * Remove a specific connection from pool
     */
    private removeConnection(cfg: ConnectionConfig, conn: Connection): void {
        const key = this.getKey(cfg);
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
}

/**
 * Global connection manager instance
 */
export const connectionManager = new ConnectionManager();