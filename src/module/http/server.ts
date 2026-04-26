import { assert } from "../../utils/assert";
import { TcpSocket } from "./socket";
import { ServerConnection, type RequestHandler } from "./server-conn";

const streams = import.meta.use("streams");
const ssl = import.meta.use("ssl");
const timers = import.meta.use("timers");
const http = import.meta.use('http');

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface ServerConfig {
    hostname?: string;
    port: number;
    cert?: string;              // Path to TLS certificate
    key?: string;              // Path to TLS private key
    keepAliveTimeout?: number;  // ms — default 5000
    maxRequestsPerConnection?: number;  // default 100
    requestTimeout?: number;    // ms — default 30000
}

export type { RequestHandler, HttpRequest, HttpResponse } from "./server-conn";

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

export class Server {
    public readonly config: Required<ServerConfig>;
    public readonly handler: RequestHandler;

    private listener: CModuleStreams.TCP | null = null;
    private sslContext: CModuleSSL.Context | null = null;
    private connections: Set<ServerConnection> = new Set();
    private listening = false;
    private accepting = false;

    constructor(handler: RequestHandler, config: ServerConfig) {
        this.handler = handler;
        this.config = {
            hostname: config.hostname ?? "0.0.0.0",
            port: config.port,
            cert: config.cert ?? "",
            key: config.key ?? "",
            keepAliveTimeout: config.keepAliveTimeout ?? 5000,
            maxRequestsPerConnection: config.maxRequestsPerConnection ?? 100,
            requestTimeout: config.requestTimeout ?? 30000,
        };
    }

    listen(): void {
        assert(!this.listening, "Server already listening");

        if (this.config.cert && this.config.key) {
            this.sslContext = new ssl.Context({
                mode: "server",
                cert: this.config.cert,
                key: this.config.key
            });
        }

        this.listener = new streams.TCP();
        this.listener.bind({ ip: this.config.hostname, port: this.config.port });
        this.listener.listen(511);
        this.listening = true;
    }

    async acceptLoop(): Promise<void> {
        assert(!this.accepting, "Server already accepting");

        const protocol = this.sslContext ? "https" : "http";
        console.debug(`Server listening on ${protocol}://${this.config.hostname}:${this.config.port}`);

        this.listener!.onconnection = (err, client) => {
            if (err || !client) return console.error("Accept error:", err);
            const socket = client as CModuleStreams.TCP;
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 1000);
            this.handleConnection(socket).catch(err => {
                if (!TcpSocket.isDisconnectError(err)) {
                    console.error("Connection error:", err);
                }
            });
        };
    }

    close(): void {
        if (!this.listening) return;
        this.listening = false;
        for (const conn of this.connections) conn.close();
        this.connections.clear();
        this.listener?.close();
        this.listener = null;
    }

    address(): { ip: string; port: number } | null {
        return this.listener?.getsockname() ?? null;
    }

    /* -------------------------------------------------------------- */
    /* Private                                                        */
    /* -------------------------------------------------------------- */

    private async handleConnection(socket: CModuleStreams.TCP): Promise<void> {
        const conn = new ServerConnection(socket, this);
        this.connections.add(conn);

        try {
            if (this.sslContext) {
                await conn.serverHandshake(this.sslContext);
            }

            let keepAlive = true;
            let firstRequest = true;

            while (keepAlive && !conn.isClosed() && !conn.isUpgraded()) {
                const timeoutMs = firstRequest
                    ? this.config.requestTimeout
                    : this.config.keepAliveTimeout;

                let timedOut = false;
                const tid = timers.setTimeout(() => { timedOut = true; conn.close(); }, timeoutMs);

                try {
                    keepAlive = await conn.handleRequest();
                    firstRequest = false;
                    if (conn.isClosed()) keepAlive = false;
                } catch (err: any) {
                    if (!TcpSocket.isDisconnectError(err) && !timedOut) {
                        console.error("Request error:", err);
                    }
                    keepAlive = false;
                } finally {
                    timers.clearTimeout(tid);
                }
            }

        } catch (err) {
            console.error("Connection error:", err);
        } finally {
            if (!conn.isUpgraded()) conn.close();
            this.connections.delete(conn);
        }
    }
}

export function createServer(handler: RequestHandler, config: ServerConfig): Server {
    return new Server(handler, config);
}

// save to module scope to allow nodejs server reuse
Reflect.set(http, "__cno", {
    Server,
    createServer
});