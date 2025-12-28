/**
 * HTTP Server Core
 * Handles TCP/TLS listening, SSL handshake, HTTP parsing, and WebSocket upgrade
 * 
 * Key features:
 * - Streaming request body (ReadableStream)
 * - SSL support with proper feed() handling
 * - WebSocket upgrade support
 */

import { assert } from "../../utils/assert";

const streams = import.meta.use("streams");
const ssl = import.meta.use("ssl");
const http = import.meta.use("http");
const engine = import.meta.use("engine");
const timers = import.meta.use("timers");

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* Types & Interfaces                                                 */
/* ------------------------------------------------------------------ */

/**
 * Server configuration
 */
export interface ServerConfig {
    hostname?: string;
    port: number;

    // TLS options (if provided, enables HTTPS)
    cert?: string;  // Path to certificate file
    key?: string;   // Path to private key file

    // Connection limits
    keepAliveTimeout?: number;     // Default: 5000ms
    maxRequestsPerConnection?: number;  // Default: 100
    requestTimeout?: number;       // Default: 30000ms
}

/**
 * Parsed HTTP request (with streaming body)
 */
export interface HttpRequest {
    method: string;
    url: string;
    httpVersion: string;
    headers: Map<string, string>;
    body: ReadableStream<Uint8Array> | null;
}

/**
 * HTTP response builder
 */
export interface HttpResponse {
    /**
     * Write status line and headers
     */
    writeHead(status: number, statusText: string, headers: Record<string, string>): Promise<void>;

    /**
     * Write response body chunk
     */
    write(chunk: Uint8Array | string): Promise<void>;

    /**
     * End response
     */
    end(chunk?: Uint8Array | string): Promise<void>;

    /**
     * Upgrade connection (for WebSocket)
     * Returns the underlying ServerConnection for direct socket access
     */
    upgrade(): ServerConnection;
}

/**
 * Request handler callback
 */
export type RequestHandler = (req: HttpRequest, res: HttpResponse) => void | Promise<void>;

/* ------------------------------------------------------------------ */
/* Server Connection (per-client)                                     */
/* ------------------------------------------------------------------ */

enum ConnectionState {
    HANDSHAKING = "handshaking",  // SSL handshake in progress
    IDLE = "idle",         // Waiting for request
    PARSING = "parsing",      // Parsing HTTP request
    RESPONDING = "responding",   // Sending response
    UPGRADING = "upgrading",   // WebSocket upgrade in progress
    UPGRADED = "upgraded",     // WebSocket/upgraded protocol
    CLOSED = "closed"
}

export class ServerConnection {
    public readonly socket: CModuleStreams.TCP;
    public sslPipe: CModuleSSL.Pipe | null = null;

    private state: ConnectionState = ConnectionState.IDLE;
    private parser: CModuleHTTP.Parser;
    private server: Server;

    // Request parsing state
    private currentMethod = "";
    private currentUrl = "";
    private currentHeaders = new Map<string, string>();
    private currentHeaderField = "";
    private headersComplete = false;
    private expectBody = false;
    private contentLength = 0;
    private isChunked = false;

    // Body stream controller
    private bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    private bodyBytesRead = 0;

    // Response state
    private headersSent = false;
    private responseEnded = false;

    // Keep-alive state
    private requestCount = 0;
    private keepAlive = true;

    // Pending ciphertext (when SSL BIO full)
    private pendingCiphertext: Uint8Array | null = null;

    constructor(socket: CModuleStreams.TCP, server: Server) {
        this.socket = socket;
        this.server = server;
        this.parser = new http.Parser(http.REQUEST);
        this.setupParser();
    }

    /* -------------------------------------------------------------- */
    /* SSL Handshake (Server-side)                                    */
    /* -------------------------------------------------------------- */

    /**
     * Perform server-side SSL handshake
     */
    async performSSLHandshake(sslContext: CModuleSSL.Context): Promise<void> {
        this.state = ConnectionState.HANDSHAKING;

        // Create SSL pipe
        this.sslPipe = new ssl.Pipe(sslContext);

        // Server-side handshake: wait for ClientHello
        const buf = new Uint8Array(16384);
        while (!this.sslPipe.handshakeComplete) {
            // Read from network
            const n = await this.socket.read(buf);

            if (n === null || n === 0) {
                throw new Error("SSL handshake failed: connection closed");
            }

            // Feed to SSL pipe (may not consume all data)
            let toFeed = buf.subarray(0, n);
            while (toFeed.length > 0) {
                const consumed = this.feedCiphertext(toFeed);
                if (consumed <= 0) break;
                toFeed = toFeed.subarray(consumed);
            }

            // Advance handshake
            this.sslPipe.handshake();

            // Send response (ServerHello, Certificate, etc.)
            const response = this.sslPipe.getOutput();
            if (response) {
                await this.socket.write(new Uint8Array(response));
            }
        }

        this.state = ConnectionState.IDLE;
    }

    /* -------------------------------------------------------------- */
    /* HTTP Request Parsing                                           */
    /* -------------------------------------------------------------- */

    /**
     * Setup llhttp parser callbacks
     */
    private setupParser(): void {
        this.parser.onUrl = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            this.currentUrl += engine.decodeString(view);
        };

        this.parser.onHeaderField = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            this.currentHeaderField = engine.decodeString(view).toLowerCase();
        };

        this.parser.onHeaderValue = (buf, off, len) => {
            if (len > 8192) throw new Error("HTTP header value too long");

            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            const value = engine.decodeString(view);

            // Combine multiple values with comma
            const existing = this.currentHeaders.get(this.currentHeaderField);
            if (existing) {
                this.currentHeaders.set(this.currentHeaderField, existing + ", " + value);
            } else {
                this.currentHeaders.set(this.currentHeaderField, value);
            }
        };

        this.parser.onHeadersComplete = () => {
            this.currentMethod = this.getHttpMethod(this.parser.state.method);
            this.headersComplete = true;

            // Check Connection header for keep-alive
            const connection = this.currentHeaders.get("connection")?.toLowerCase();
            const httpVersion = `${this.parser.state.httpMajor}.${this.parser.state.httpMinor}`;

            // HTTP/1.1 defaults to keep-alive unless "close" specified
            if (httpVersion === "1.1") {
                this.keepAlive = connection !== "close";
            } else {
                this.keepAlive = connection === "keep-alive";
            }

            // Check if body is expected
            const contentLength = this.currentHeaders.get("content-length");
            const transferEncoding = this.currentHeaders.get("transfer-encoding");

            if (contentLength) {
                this.contentLength = parseInt(contentLength);
                this.expectBody = this.contentLength > 0;
            } else if (transferEncoding?.toLowerCase().includes("chunked")) {
                this.isChunked = true;
                this.expectBody = true;
            }
        };

        this.parser.onBody = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);

            // Push to body stream if controller exists
            if (this.bodyController) {
                this.bodyController.enqueue(view);
                this.bodyBytesRead += len;

                // Close stream if we've read all content
                if (!this.isChunked && this.bodyBytesRead >= this.contentLength) {
                    this.bodyController.close();
                    this.bodyController = null;
                }
            }
        };

        this.parser.onMessageComplete = () => {
            // Close body stream if still open
            if (this.bodyController) {
                this.bodyController.close();
                this.bodyController = null;
            }
        };
    }

    /**
     * Get HTTP method name from parser enum
     */
    private getHttpMethod(methodEnum: number): string {
        // llhttp method enum: 0=DELETE, 1=GET, 2=HEAD, 3=POST, 4=PUT, etc.
        const methods = ["DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT",
            "OPTIONS", "TRACE", "COPY", "LOCK", "MKCOL", "MOVE",
            "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND",
            "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY",
            "CHECKOUT", "MERGE", "MSEARCH", "NOTIFY", "SUBSCRIBE",
            "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK"];
        return methods[methodEnum] || "UNKNOWN";
    }

    /**
     * Handle incoming request
     */
    async handleRequest(): Promise<boolean> {
        this.state = ConnectionState.PARSING;

        // Reset parsing state
        this.currentMethod = "";
        this.currentUrl = "";
        this.currentHeaders.clear();
        this.currentHeaderField = "";
        this.headersComplete = false;
        this.expectBody = false;
        this.contentLength = 0;
        this.isChunked = false;
        this.bodyBytesRead = 0;
        this.bodyController = null;
        this.headersSent = false;
        this.responseEnded = false;

        let destState = ConnectionState.RESPONDING;
        try {
            // Read and parse headers
            while (!this.headersComplete) {
                const data = await this.readData();
                if (null === data) {
                    return false;   // closed
                }
                if (data.length === 0) continue;

                const result = this.parser.execute(data);
                if (result.errno !== 0) {
                    if (result.name == 'HPE_PAUSED_UPGRADE') {
                        destState = ConnectionState.UPGRADING;
                        this.keepAlive = false;  // Upgraded connections don't reuse
                        this.expectBody = false;
                        break;
                    }
                    throw new Error(`HTTP parse error: ${result.reason}`);
                }
            }

            // Create body stream if body is expected
            let bodyStream: ReadableStream<Uint8Array> | null = null;

            if (this.expectBody) {
                const self = this;

                bodyStream = new ReadableStream({
                    start(controller) {
                        self.bodyController = controller;
                    },

                    async pull(controller) {
                        // Read more data from socket
                        try {
                            const data = await self.readData();
                            if (!data) {
                                if (data === null) {
                                    controller.close();
                                    self.bodyController = null;
                                }
                                return;
                            }

                            // Feed to parser (will trigger onBody callback)
                            const result = self.parser.execute(data);
                            if (result.errno !== 0) {
                                controller.error(new Error(`HTTP parse error: ${result.reason}`));
                                self.bodyController = null;
                            }

                            // Check if message is complete
                            if (self.parser.state.eof) {
                                controller.close();
                                self.bodyController = null;
                            }
                        } catch (err) {
                            controller.error(err);
                            self.bodyController = null;
                        }
                    },

                    cancel() {
                        self.bodyController = null;
                    }
                });
            }

            // Build request object
            const request: HttpRequest = {
                method: this.currentMethod,
                url: this.currentUrl,
                httpVersion: `${this.parser.state.httpMajor}.${this.parser.state.httpMinor}`,
                headers: this.currentHeaders,
                body: bodyStream
            };

            // Build response object
            const response: HttpResponse = {
                writeHead: this.writeHead.bind(this),
                write: this.writeData.bind(this),
                end: this.endResponse.bind(this),
                upgrade: this.upgradeConnection.bind(this)
            };

            // Call user handler
            this.state = destState;
            await this.server.handler(request, response);

            // Ensure response is ended
            if (!this.responseEnded && !this.isUpgraded()) {
                await this.endResponse();
            }

            // Consume any remaining body data
            if (this.bodyController) {
                (this.bodyController as ReadableStreamDefaultController<Uint8Array>).close();
                this.bodyController = null;
            }

            // Reset parser for next request
            this.parser.reset(http.REQUEST);
            this.requestCount++;

            // Check if we should keep connection alive
            return this.keepAlive &&
                this.requestCount < (this.server.config.maxRequestsPerConnection ?? 1024) &&
                !this.isUpgraded();

        } catch (err) {
            console.error("Request handling error:", err);

            // Try to send 500 error
            if (!this.headersSent) {
                try {
                    await this.writeHead(500, "Internal Server Error", {});
                    await this.endResponse();
                } catch (e) {
                    // Ignore
                }
            }

            return false;
        }
    }

    /* -------------------------------------------------------------- */
    /* Response Methods                                               */
    /* -------------------------------------------------------------- */

    private async writeHead(status: number, statusText: string, headers: Record<string, string>): Promise<void> {
        if (this.headersSent) {
            throw new Error("Headers already sent");
        }

        // Build status line
        let response = `HTTP/1.1 ${status} ${statusText}\r\n`;

        // Add headers
        for (const [key, value] of Object.entries(headers)) {
            response += `${key}: ${value}\r\n`;
        }

        // End headers
        response += "\r\n";

        // Send
        await this.writeRaw(engine.encodeString(response));
        this.headersSent = true;
    }

    private async writeData(chunk: Uint8Array | string): Promise<void> {
        if (this.responseEnded) {
            throw new Error("Response already ended");
        }

        if (!this.headersSent) {
            // Auto-send headers if not sent
            await this.writeHead(200, "OK", {
                "transfer-encoding": "chunked"
            });
        }

        const data = typeof chunk === "string"
            ? engine.encodeString(chunk)
            : chunk;

        await this.writeRaw(data);
    }

    private async endResponse(chunk?: Uint8Array | string): Promise<void> {
        if (this.responseEnded) return;

        if (chunk !== undefined) {
            await this.writeData(chunk);
        } else if (!this.headersSent) {
            // No body sent, send empty response
            await this.writeHead(200, "OK", {
                "content-length": "0"
            });
        }

        this.responseEnded = true;
        this.state = ConnectionState.IDLE;
    }

    private upgradeConnection(): ServerConnection {
        assert (this.headersSent, "Cannot upgrade after headers sent");
        assert (this.state === ConnectionState.UPGRADING, "Cannot upgrade a non-upgrading connection");

        this.state = ConnectionState.UPGRADED;
        this.keepAlive = false;  // Upgraded connections don't reuse

        return this;
    }

    /* -------------------------------------------------------------- */
    /* I/O Helpers                                                    */
    /* -------------------------------------------------------------- */

    /**
     * Read data from socket (handles SSL if enabled)
     */
    async readData(size = 16384): Promise<Uint8Array | null> {
        assert(size > 0, "invaild size");
        if (this.sslPipe) {
            // Try buffered plaintext first
            const buffered = this.sslPipe.read(size);
            if (buffered && buffered.byteLength > 0) {
                return new Uint8Array(buffered);
            }

            // Feed pending ciphertext if any
            if (this.pendingCiphertext && this.pendingCiphertext.length > 0) {
                const consumed = this.feedCiphertext(this.pendingCiphertext);
                if (consumed > 0) {
                    this.pendingCiphertext = consumed < this.pendingCiphertext.length
                        ? this.pendingCiphertext.subarray(consumed)
                        : null;
                }

                const plain = this.sslPipe.read(size);
                if (plain && plain.byteLength > 0) {
                    return new Uint8Array(plain);
                }
            }

            // Read from network
            const buf = new Uint8Array(size);
            const n = await this.socket.read(buf);
            if (n === null || n === 0) return null;

            // Feed to SSL
            const ciphertext = buf.subarray(0, n);
            const consumed = this.feedCiphertext(ciphertext);

            if (consumed < ciphertext.length) {
                this.pendingCiphertext = ciphertext.subarray(consumed);
            }

            // Read plaintext
            const plaintext = this.sslPipe.read(size);
            return (plaintext && plaintext.byteLength > 0)
                ? new Uint8Array(plaintext)
                : null;
        } else {
            // Plain HTTP
            const buf = new Uint8Array(size);
            const n = await this.socket.read(buf);
            return n === null ? null : buf.subarray(0, n ?? 0);
        }
    }

    /**
     * Write raw data to socket (handles SSL if enabled)
     */
    async writeRaw(data: Uint8Array): Promise<void> {
        if (this.sslPipe) {
            // Encrypt
            const written = this.sslPipe.write(data);
            if (written < 0) {
                throw new Error(`SSL_write failed: ${written}`);
            }

            // Send encrypted data
            const encrypted = this.sslPipe.getOutput();
            if (encrypted) {
                await this.socket.write(new Uint8Array(encrypted));
            }
        } else {
            // Plain HTTP
            await this.socket.write(data);
        }
    }

    async readRaw(size = 16384): Promise<Uint8Array | null> {
        if (this.sslPipe) {
            const buf = new Uint8Array(size);
            const n = await this.socket.read(buf);
            if (n === null || n === 0) return null;
            
            const consumed = this.sslPipe.feed(buf.subarray(0, n));
            if (consumed < 0) {
                throw new Error(`SSL feed error: ${consumed}`);
            }
            
            const plaintext = this.sslPipe.read(size);
            return plaintext ? new Uint8Array(plaintext) : null;
        } else {
            const buf = new Uint8Array(size);
            const n = await this.socket.read(buf);
            return (n === null || n === 0) ? null : buf.subarray(0, n);
        }
    }

    /**
     * Feed ciphertext to SSL pipe
     * Returns: bytes consumed (may be < data.length)
     */
    private feedCiphertext(data: Uint8Array): number {
        if (!this.sslPipe) return 0;

        const consumed = this.sslPipe.feed(data);
        if (consumed < 0) {
            throw new Error(`SSL feed error: ${consumed}`);
        }

        return consumed;
    }

    /* -------------------------------------------------------------- */
    /* State                                                          */
    /* -------------------------------------------------------------- */

    isUpgraded(): boolean {
        return this.state === ConnectionState.UPGRADED;
    }

    isClosed(): boolean {
        return this.state === ConnectionState.CLOSED;
    }

    close(): void {
        if (this.state === ConnectionState.CLOSED) return;

        // Close body stream if open
        if (this.bodyController) {
            try {
                this.bodyController.close();
            } catch (e) {
                // Already closed
            }
            this.bodyController = null;
        }

        try {
            this.sslPipe?.shutdown();
            this.socket.close();
        } catch (err) {
            // Ignore
        }

        this.state = ConnectionState.CLOSED;
        this.pendingCiphertext = null;
    }
}

/* ------------------------------------------------------------------ */
/* HTTP Server                                                        */
/* ------------------------------------------------------------------ */

export class Server {
    public readonly config: ServerConfig;
    public readonly handler: RequestHandler;

    private listener: CModuleStreams.TCP | null = null;
    private sslContext: CModuleSSL.Context | null = null;
    private connections = new Set<ServerConnection>();
    private listening = false;
    private cleanupTimer: number | null = null;

    constructor(handler: RequestHandler, config: ServerConfig) {
        this.handler = handler;
        this.config = {
            hostname: config.hostname || "0.0.0.0",
            port: config.port,
            cert: config.cert,
            key: config.key,
            keepAliveTimeout: config.keepAliveTimeout || 5000,
            maxRequestsPerConnection: config.maxRequestsPerConnection || 100,
            requestTimeout: config.requestTimeout || 30000
        };
    }

    /**
     * Start listening
     */
    async listen(): Promise<void> {
        if (this.listening) {
            throw new Error("Server already listening");
        }

        // Create SSL context if cert/key provided
        if (this.config.cert && this.config.key) {
            this.sslContext = new ssl.Context({
                mode: "server",
                cert: this.config.cert,
                key: this.config.key
            });
        }

        // Create TCP listener
        assert(this.config.hostname);
        this.listener = new streams.TCP();
        this.listener.bind({
            ip: this.config.hostname,
            port: this.config.port
        });
        this.listener.listen(511);

        this.listening = true;

        const protocol = this.sslContext ? "https" : "http";
        console.debug(`Server listening on ${protocol}://${this.config.hostname}:${this.config.port}`);

        // Start accept loop
        this.acceptLoop();
    }

    private cleanup(): void {
        for (const conn of this.connections) {
            if (conn.isClosed()) {
                this.connections.delete(conn);
            }
        }
    }

    /**
     * Accept loop
     */
    private async acceptLoop(): Promise<void> {
        this.cleanupTimer = timers.setInterval(() => {
            this.cleanup();
        }, 30000);

        while (this.listening && this.listener) {
            try {
                const socket = await this.listener.accept() as CModuleStreams.TCP;
                socket.setNoDelay(true);
                socket.setKeepAlive(true, 1000);
                this.handleConnection(socket);
            } catch (err) {
                if (this.listening) {
                    console.error("Accept error:", err);
                }
                break;
            }
        }
    }

    /**
     * Handle new connection
     */
    private async handleConnection(socket: CModuleStreams.TCP): Promise<void> {
        const conn = new ServerConnection(socket, this);
        this.connections.add(conn);

        try {
            // Perform SSL handshake if needed
            if (this.sslContext) {
                await conn.performSSLHandshake(this.sslContext);
            }

            // Handle requests in a loop (keep-alive)
            let keepAlive = true;
            // Set timeout for request
            let timeoutId;
            if (this.config.requestTimeout)
                timeoutId = timers.setTimeout(() => {
                    conn.close();
                }, this.config.requestTimeout);

            try {
                keepAlive = await conn.handleRequest();
            } finally {
                if (timeoutId) timers.clearTimeout(timeoutId);
            }

            // If upgraded (WebSocket), stop processing HTTP
            // with Keep-alive idle timeout
            while (keepAlive && !conn.isClosed() && !conn.isUpgraded()) {
                const idlePromise = Promise.withResolvers<void>();
                const idleTimeout = timers.setTimeout(() => {
                    conn.close();
                    idlePromise.resolve(undefined);
                }, this.config.keepAliveTimeout ?? 600_000);

                // Wait for next request or timeouttry {
                const r = await Promise.race([
                    conn.handleRequest(),
                    idlePromise.promise
                ]);
                if (typeof r === "boolean") {
                    keepAlive = r;
                } else {
                    // timeout
                    keepAlive = false;
                }
            }
        } catch (err) {
            console.error("Connection error:", err);
        } finally {
            if (!conn.isUpgraded()) {
                conn.close();
            }
            this.connections.delete(conn);
        }
    }

    /**
     * Close server
     */
    close(): void {
        if (!this.listening) return;

        this.listening = false;

        // Close all connections
        for (const conn of this.connections) {
            conn.close();
        }
        this.connections.clear();

        // Close listener
        if (this.listener) {
            this.listener.close();
            this.listener = null;
        }
    }

    /**
     * Get server address
     */
    address(): { ip: string; port: number } | null {
        return this.listener?.getsockname() ?? null;
    }
}

/**
 * Create HTTP server
 */
export function createServer(handler: RequestHandler, config: ServerConfig): Server {
    return new Server(handler, config);
}