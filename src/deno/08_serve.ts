/**
 * Deno.serve API Adapter
 * Bridges between Server core and Web API (Request/Response/WebSocket)
 */

import { Server, createServer, type HttpRequest, type HttpResponse } from '@cnojs/http/server';
import { assert } from '../utils/assert';

/** ServerConnection — raw HTTP/1.x server connection handle (from @cnojs/http/h1) */
interface ServerConnection {
    socket: any;
    sslPipe: any;
    write(data: Uint8Array): Promise<void>;
    read(size?: number): Promise<Uint8Array | null>;
    onReadable(callback: (data: Uint8Array | null) => void, errHandler?: (err: Error) => void): void;
    stopReading(): void;
    close(): void;
    isClosed(): boolean;
}

function createWebSocketFromConnection(conn: Promise<any>): globalThis.WebSocket {
    // TODO: Implement WebSocket from connection — return a proper WebSocket instance
    return { close() {}, send() {}, addEventListener() {} } as unknown as globalThis.WebSocket;
}
import { wrapFsClassDec as wrap, wrapFSns } from "../utils/wrap";
import { errors } from './01_errors';

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const http = import.meta.use('http');

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
function createWebRequest(coreReq: HttpRequest, connInfo: { hostname: string; port: number; secure: boolean }): Request {
    // Convert headers
    const headers = new Headers();
    for (const [key, value] of coreReq.headers) {
        headers.append(key, value);
    }

    const host = headers.get('host') || `${connInfo.hostname}:${connInfo.port}`;
    const protocol = connInfo.secure ? 'https:' : 'http:';
    const base = `${protocol}//${host}`;

    let rawUrl = coreReq.url;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) {
        const parsed = new URL(rawUrl);
        rawUrl = parsed.pathname + parsed.search + parsed.hash;
    }

    const url = new URL(rawUrl, base);

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
    private method: string;

    constructor(coreRes: HttpResponse, method: string) {
        this.coreRes = coreRes;
        this.method = method;
    }

    verify(res: Response): void {
        const getHeader = (name: string) => res.headers.get(name);
        const contentType = getHeader('content-type');
        const contentLength = getHeader('content-length');
        const transferEncoding = getHeader('transfer-encoding');

        // 1. status code that should not have a body
        const noBodyStatusCodes = [204, 205, 304];
        if (noBodyStatusCodes.includes(res.status)) {
            assert(
                !res.body,
                `Status ${res.status} must not have a response body, but got: ${JSON.stringify(res.body)}`
            );
            assert(!contentLength || contentLength === '0',
                `Status ${res.status} must not have Content-Length or it must be 0`);
            return;
        }

        // 2. Content-Length
        if (contentLength) {
            const length = parseInt(contentLength, 10);
            assert(!isNaN(length), `Invalid Content-Length: ${contentLength}`);
            assert(length >= 0, `Content-Length must be non-negative: ${length}`);
            if (length > 0) assert(res.body, "Body must exist if Content-Length > 0");
        }

        // no Transfer-Encoding and Content-Length(mutex)
        if (transferEncoding && transferEncoding.toLowerCase() === 'chunked') {
            assert(!contentLength,
                'Transfer-Encoding: chunked and Content-Length cannot coexist');
        }

        // ensure client can handle content encoding
        if (res.body && (res.body instanceof ReadableStream) && !transferEncoding && !contentLength) {
            assert(contentType, 'Streamed body exists but no Content-Type, Content-Length or Transfer-Encoding specified');
        }
    }

    async sendResponse(response: Response): Promise<void> {
        const wsResponse = response as WebSocketResponse;
        if (wsResponse[websocketSymbol]) {
            await this.handleWebSocketUpgrade(wsResponse);
            return;
        }

        const headers2 = new Headers(response.headers);
        const noBodyStatus = [204, 205, 304].includes(response.status);
        const isHead = this.method === 'HEAD';
        const hasBody = response.body !== null && !noBodyStatus && !isHead;
        const hasContentLength = headers2.has('content-length');
        const hasTransferEncoding = headers2.has('transfer-encoding');
        
        if (hasBody && !hasContentLength && !hasTransferEncoding) {
            headers2.set('transfer-encoding', 'chunked');
        }

        // Always set Connection header for HTTP/1.1 keep-alive
        if (!headers2.has('connection')) {
            headers2.set('connection', 'keep-alive');
        }

        const headers = Array.from(headers2.entries());
        const statusText = response.statusText ?? http.strstatus(response.status);
        await this.coreRes.writeHead(response.status, statusText, headers);
        this.headersSent = true;

        if (hasBody) {
            const reader = response.body!.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await this.coreRes.write(value);
                }
            } catch (err) {
                this.coreRes.close();
                throw err;
            } finally {
                reader.releaseLock();
            }
        }

        await this.coreRes.end();
    }

    /**
     * Handle WebSocket upgrade
     */
    @wrap
    private async handleWebSocketUpgrade(response: WebSocketResponse): Promise<void> {
        // Send upgrade headers
        const headers = Array.from(response.headers.entries());
        const statusText = response.statusText ?? http.strstatus(response.status);
        await this.coreRes.writeHead(response.status, statusText, headers);

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
        await this.server.shutdown();
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
                    port: addr?.port || options.port || 8000,
                    secure: !!(coreServer as any).sslContext
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

                const adapter = new ResponseAdapter(res, req.method);
                await adapter.sendResponse(webResponse);

            } catch (error) {
                if (!(error instanceof errors.ConnectionReset)) {
                    console.error('Request handler error:', error, '\n', (error as Error).stack);
                }

                // Send 500 error
                try {
                    await res.writeHead(500, 'Internal Server Error', [
                        ['Content-Type', 'text/plain']
                    ]);
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
            key: ('key' in options) ? options.key as string : undefined,
            keepAliveTimeout: ('keepAliveTimeout' in options) ? options.keepAliveTimeout as number : undefined,
            requestTimeout: ('requestTimeout' in options) ? options.requestTimeout as number : undefined,
        }
    );

    // Start listening
    coreServer.listen();
    coreServer.acceptLoop();

    const httpServer = new DenoHttpServer(coreServer);

    // Call onListen callback if provided
    if (options.onListen) {
        options.onListen({
            hostname: httpServer.addr.hostname,
            port: httpServer.addr.port,
            transport: 'tcp'
        });
    }

    return httpServer;
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
function createWebSocketFromServerConnection(conn: Promise<ServerConnection>): globalThis.WebSocket {
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
            await conn.write(data);
        },

        async read(size?: number): Promise<Uint8Array | null> {
            return await conn.read(size);
        },

        onReadable(callback: (data: Uint8Array | null) => void, errHandler?: (err: Error) => void): void {
            conn.onReadable(callback, errHandler);
        },

        stopReading(): void {
            conn.stopReading();
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

Object.assign(Deno, wrapFSns({
    // @ts-ignore
    serve,
    upgradeWebSocket
}));