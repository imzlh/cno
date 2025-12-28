/**
 * Deno.serve API Adapter
 * Bridges between Server core and Web API (Request/Response/WebSocket)
 */

import { Server, ServerConnection, createServer, type HttpRequest, type HttpResponse } from '../module/http/server';
import { WebSocket, createWebSocketFromConnection } from '../module/http/websocket';

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* WebSocket Upgrade Symbol                                           */
/* ------------------------------------------------------------------ */

const websocketSymbol = Symbol('deno.serve.websocket');

interface WebSocketResponse extends Response {
    [websocketSymbol]?: (conn: ServerConnection) => void;
}

/* ------------------------------------------------------------------ */
/* Adapter: Server Core → Web API                                    */
/* ------------------------------------------------------------------ */

/**
 * Convert core HttpRequest to Web API Request
 */
function createWebRequest(coreReq: HttpRequest, connInfo: { hostname: string; port: number }): Request {
    // Build full URL
    const host = coreReq.headers.get('host') || `${connInfo.hostname}:${connInfo.port}`;
    const protocol = 'http:'; // Server will be HTTP or HTTPS, but Request constructor needs valid URL
    const url = new URL(coreReq.url, `${protocol}//${host}`);

    // Convert headers
    const headers = new Headers();
    for (const [key, value] of coreReq.headers) {
        headers.append(key, value);
    }

    return new Request(url.toString(), {
        method: coreReq.method,
        headers,
        body: coreReq.body
    });
}

/**
 * Adapter for HttpResponse to handle Web API Response
 */
class ResponseAdapter {
    private coreRes: HttpResponse;
    private headersSent = false;

    constructor(coreRes: HttpResponse) {
        this.coreRes = coreRes;
    }

    /**
     * Send Web API Response to client
     */
    async sendResponse(response: Response): Promise<void> {
        // Check if this is a WebSocket upgrade response
        const wsResponse = response as WebSocketResponse;
        if (wsResponse[websocketSymbol]) {
            // Handle WebSocket upgrade
            await this.handleWebSocketUpgrade(wsResponse);
            return;
        }

        // Send status and headers
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });

        await this.coreRes.writeHead(response.status, response.statusText, headers);
        this.headersSent = true;

        // Send body if present
        if (response.body) {
            const reader = response.body.getReader();

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    await this.coreRes.write(value);
                }
            } finally {
                reader.releaseLock();
            }
        }

        // End response
        await this.coreRes.end();
    }

    /**
     * Handle WebSocket upgrade
     */
    private async handleWebSocketUpgrade(response: WebSocketResponse): Promise<void> {
        // Send upgrade headers
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });

        await this.coreRes.writeHead(response.status, response.statusText, headers);

        // Upgrade connection
        const conn = this.coreRes.upgrade();

        // Execute WebSocket handler
        if (response[websocketSymbol]) {
            response[websocketSymbol]!(conn);
        }
    }
}

/* ------------------------------------------------------------------ */
/* Deno.serve Implementation                                          */
/* ------------------------------------------------------------------ */

/**
 * HTTP server wrapper (implements Deno.HttpServer interface)
 */
class DenoHttpServer implements Deno.HttpServer<Deno.NetAddr> {
    private server: Server;
    private finishedPromise: Promise<void>;
    private finishedResolve!: () => void;
    public readonly addr: Deno.NetAddr;

    constructor(server: Server) {
        this.server = server;
        this.finishedPromise = new Promise<void>(resolve => {
            this.finishedResolve = resolve;
        });
        const addr = server.address();
        this.addr = {
            transport: 'tcp',
            hostname: addr?.ip ?? '::',
            port: addr?.port ?? 80
        };
    }

    get finished(): Promise<void> {
        return this.finishedPromise;
    }

    ref(): void {
        // Not implemented (Txiki.js doesn't have ref/unref)
    }

    unref(): void {
        // Not implemented
    }

    async shutdown(): Promise<void> {
        this.server.close();
        this.finishedResolve();
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.shutdown();
    }
}

/**
 * Deno.serve - main entry point
 */
function serve(options: Deno.ServeOptions): Deno.HttpServer;
function serve(handler: Deno.ServeHandler): Deno.HttpServer;
function serve(
    options: Deno.ServeOptions,
    handler: Deno.ServeHandler
): Deno.HttpServer;
function serve(
    optionsOrHandler: Deno.ServeOptions | Deno.ServeHandler,
    handler?: Deno.ServeHandler
): Deno.HttpServer {
    let options: Deno.ServeOptions & Deno.ServeTcpOptions & { handler: Deno.ServeHandler };

    // Handle overloads
    if (typeof optionsOrHandler === 'function') {
        options = {
            handler: optionsOrHandler,
            port: 8000
        };
    } else {
        // @ts-ignore
        options = optionsOrHandler;
        if (handler) {
            options.handler = handler;
        }
    }

    // Validate handler
    if (!options.handler) {
        throw new TypeError('Handler is required');
    }

    // Check for Unix socket
    if ('path' in options && options.path) {
        throw new Deno.errors.NotSupported('Unix socket server not yet implemented');
    }

    // Create core server
    const coreServer = createServer(
        async (req, res) => {
            try {
                // Create Web API Request
                const addr = coreServer.address();
                const webRequest = createWebRequest(req, {
                    hostname: addr?.ip || '0.0.0.0',
                    port: addr?.port || options.port || 8000
                });

                // Create connection info
                const connInfo: Deno.ServeHandlerInfo = {
                    remoteAddr: {
                        hostname: addr?.ip || '0.0.0.0',
                        port: addr?.port || 0,
                        transport: 'tcp'
                    },
                    completed: Promise.resolve() // Simplified
                };

                // Call user handler
                const webResponse = await options.handler!(webRequest, connInfo);
                if (!webResponse || !(webResponse instanceof Response)) {
                    throw new TypeError('Handler must return a Response');
                }

                // Send response
                const adapter = new ResponseAdapter(res);
                await adapter.sendResponse(webResponse);

            } catch (error) {
                console.error('Request handler error:', error);

                // Send 500 error
                try {
                    await res.writeHead(500, 'Internal Server Error', {
                        'content-type': 'text/plain'
                    });
                    await res.end('Internal Server Error');
                } catch (e) {
                    // Ignore
                }
            }
        },
        {
            hostname: options.hostname || '0.0.0.0',
            port: options.port || 8000,
            cert: ('cert' in options) ? options.cert as string : undefined,
            key: ('key' in options) ? options.key as string : undefined
        }
    );

    // Start listening
    coreServer.listen();

    return new DenoHttpServer(coreServer);
}

/* ------------------------------------------------------------------ */
/* Deno.upgradeWebSocket                                              */
/* ------------------------------------------------------------------ */

/**
 * Calculate WebSocket accept value
 */
function calculateWebSocketAccept(key: string): string {
    const magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const hash = crypto.sha1(engine.encodeString(key + magic));
    return crypto.base64Encode(hash);
}

/**
 * Deno.upgradeWebSocket implementation
 */
function upgradeWebSocket(
    request: Request,
    options?: Deno.UpgradeWebSocketOptions
): Deno.WebSocketUpgrade {
    // Validate WebSocket request
    const upgradeHeader = request.headers.get('upgrade')?.toLowerCase();
    const connectionHeader = request.headers.get('connection')?.toLowerCase();
    const wsKey = request.headers.get('sec-websocket-key');
    const wsVersion = request.headers.get('sec-websocket-version');

    if (upgradeHeader !== 'websocket' || !connectionHeader?.includes('upgrade')) {
        throw new TypeError('Not a WebSocket upgrade request');
    }

    if (wsVersion !== '13') {
        throw new TypeError('Unsupported WebSocket version');
    }

    if (!wsKey) {
        throw new TypeError('Missing Sec-WebSocket-Key header');
    }

    // Build response headers
    const headers = new Headers({
        'upgrade': 'websocket',
        'connection': 'Upgrade',
        'sec-websocket-accept': calculateWebSocketAccept(wsKey)
    });

    // Handle protocol negotiation
    const protocols = request.headers.get('sec-websocket-protocol');
    if (protocols && options?.protocol) {
        const requestedProtocols = protocols.split(',').map(p => p.trim());
        if (requestedProtocols.includes(options.protocol)) {
            headers.set('sec-websocket-protocol', options.protocol);
        }
    }

    // Create WebSocket promise
    const conProm = Promise.withResolvers<ServerConnection>();

    // Create upgrade response
    const response = new Response(null, {
        status: 101,
        statusText: 'Switching Protocols',
        headers
    }) as WebSocketResponse;

    // Attach WebSocket handler
    const ws = createWebSocketFromServerConnection(conProm.promise);
    response[websocketSymbol] = c => conProm.resolve(c);

    return {
        response,
        socket: ws
    };
}

/**
 * Create WebSocket from ServerConnection
 * This adapts the raw connection to WebSocket protocol
 */
function createWebSocketFromServerConnection(conn: Promise<ServerConnection>): WebSocket {
    // Wrap ServerConnection to match Connection interface expected by WebSocket


    // Create WebSocket in server mode
    return createWebSocketFromConnection(conn.then(conn => ({
        socket: conn.socket,
        sslPipe: conn.sslPipe,
        state: 'active' as any,
        lastUsed: Date.now(),
        requests: 0,

        async connect() { },

        async write(data: Uint8Array) {
            await conn.writeRaw(data);
        },

        async read(size?: number): Promise<Uint8Array | null> {
            return await conn.readRaw(size);
        },

        markActive() { },
        markIdle() { },

        close() {
            conn.close();
        },

        isAvailable() {
            return false;
        },

        isClosed() {
            return conn.isClosed();
        }
    })));
}

/* ------------------------------------------------------------------ */
/* Export to Deno namespace                                           */
/* ------------------------------------------------------------------ */

Object.assign(Deno, {
    serve,
    upgradeWebSocket
});