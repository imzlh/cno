/**
 * Deno.serve API Adapter
 * Bridges between Server core and Web API (Request/Response/WebSocket)
 */

import { Server, createServer, type HttpRequest, type HttpResponse } from '@cnojs/http/server';
import { assert } from '../utils/assert';
import { createWebSocketFromConnection } from "../webapi/websocket";
import { getResponseInitiatorCallFrames, setResponseInitiatorCallFrames } from '../webapi/fetch';
import { wrapFsClassDec as wrap, wrapFSns } from "../utils/wrap";
import { errors } from './01_errors';
import { getServeHook, captureUserNetworkCallFrames, type NetworkCallFrame } from '../utils/network-hooks';
import { getTierLimits } from '../utils/memory-tier';
import type { ISocket } from "@cnojs/http/socket";

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const http = import.meta.use('http');

const { hookPayloadCap: PAYLOAD_LEN } = getTierLimits();

/* ------------------------------------------------------------------ */
/* WebSocket Upgrade Symbol                                           */
/* ------------------------------------------------------------------ */

const kWebSocket = Symbol('deno.serve.websocket');
const kWSMeta = Symbol('deno.serve.websocket.meta');
let serveRequestSeq = 0;

interface WebSocketResponse extends Response {
    [kWebSocket]?: (conn: ISocket) => void;
}

class ServeResponseWriteError extends Error { }

type IWSMeta = {
    source: 'serve';
    requestId: string;
    url: string;
    requestHeaders?: Array<[string, string]>;
    responseStatus?: number;
    responseHeaders?: Array<[string, string]>;
} | undefined;

function serveTs(): number {
    return Date.now() / 1000;
}

function newServeRequestId(): string {
    return `serve-${++serveRequestSeq}`;
}

function captureServeCallFrames(): NetworkCallFrame[] | undefined {
    return captureUserNetworkCallFrames();
}

function headersArrayToRecord(headers: Array<[string, string]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of headers) out[k] = v;
    return out;
}

function headersToRecord(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
}

function truncateHookPostData(body?: Uint8Array | null): Uint8Array | null | undefined {
    if (!body) return body;
    if (body.byteLength > PAYLOAD_LEN) {
        return new Uint8Array(body.subarray(0, PAYLOAD_LEN));
    }
    return body;
}

/* ------------------------------------------------------------------ */
/* Adapter: Server Core → Web API                                    */
/* ------------------------------------------------------------------ */

/**
 * Convert core HttpRequest to Web API Request
 */
function createWebRequest(coreReq: HttpRequest, connInfo: { hostname: string; port: number; secure: boolean }): Request {
    // Convert headers
    const headers = new Headers(coreReq.headers);
    const host = headers.get('host') || `${connInfo.hostname}:${connInfo.port}`;
    const protocol = connInfo.secure ? 'https:' : 'http:';
    const base = `${protocol}//${host}`;
    const url = new URL(coreReq.url, base);

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
    private finishedEmitted = false;
    private method: string;
    private requestId: string;
    private url: string;
    private requestHeaders: Array<[string, string]>;
    private requestCallFrames?: NetworkCallFrame[];

    constructor(coreRes: HttpResponse, method: string, requestId: string, url: string, requestHeaders: Array<[string, string]>, requestCallFrames?: NetworkCallFrame[]) {
        this.coreRes = coreRes;
        this.method = method;
        this.requestId = requestId;
        this.url = url;
        this.requestHeaders = requestHeaders;
        this.requestCallFrames = requestCallFrames;
    }

    private emitFinished(success: boolean, errorText?: string): void {
        if (this.finishedEmitted) return;
        this.finishedEmitted = true;
        const serveHook = getServeHook();
        if (serveHook) try {
            serveHook.onFinished?.({ requestId: this.requestId, success, errorText, timestamp: serveTs() });
        } catch { }
    }

    verify(res: Response): void {
        const getHeader = (name: string) => res.headers.get(name);
        const contentType = getHeader('content-type');
        const contentLength = getHeader('content-length');
        const transferEncoding = getHeader('transfer-encoding');

        const noBodyStatusCodes = [204, 205, 304];
        if (noBodyStatusCodes.includes(res.status)) {
            assert(!res.body, `Status ${res.status} must not have a response body`);
            assert(!contentLength || contentLength === '0', `Status ${res.status} must not have Content-Length or it must be 0`);
            return;
        }

        if (contentLength) {
            const length = parseInt(contentLength, 10);
            assert(!isNaN(length), `Invalid Content-Length: ${contentLength}`);
            assert(length >= 0, `Content-Length must be non-negative: ${length}`);
            if (length > 0) assert(res.body, "Body must exist if Content-Length > 0");
        }

        if (transferEncoding && transferEncoding.toLowerCase() === 'chunked') {
            assert(!contentLength, 'Transfer-Encoding: chunked and Content-Length cannot coexist');
        }

        if (res.body && (res.body instanceof ReadableStream) && !transferEncoding && !contentLength) {
            assert(contentType, 'Streamed body exists but no Content-Type, Content-Length or Transfer-Encoding specified');
        }
    }

    async sendResponse(response: Response): Promise<void> {
        const wsResponse = response as WebSocketResponse;
        if (wsResponse[kWebSocket]) {
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

        const headers = Array.from(headers2.entries());
        const statusText = response.statusText ?? http.strstatus(response.status);
        const serveHook = getServeHook();
        if (serveHook) try {
            serveHook.onResponse?.({
                requestId: this.requestId,
                url: this.url,
                status: response.status,
                statusText,
                headers: headersToRecord(headers2),
                timestamp: serveTs()
            });
        } catch { }
        await this.coreRes.writeHead(response.status, statusText, headers);

        if (hasBody) {
            const reader = response.body!.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (serveHook) try {
                        serveHook.onData?.({ requestId: this.requestId, data: value, timestamp: serveTs() });
                    } catch { }
                    await this.coreRes.write(value);
                }
            } catch (err) {
                const message = String((err as Error)?.message ?? err);
                this.emitFinished(false, message);
                // Propagate downstream cancellation/write failure back to the
                // upstream body source (for example fetch -> curl), otherwise
                // the producer keeps downloading after the client has gone away.
                try { await reader.cancel(err); } catch {}
                this.coreRes.close();
                throw new ServeResponseWriteError(message);
            } finally {
                reader.releaseLock();
            }
        }

        await this.coreRes.end();
        this.emitFinished(true);
    }

    /**
     * Handle WebSocket upgrade
     */
    @wrap
    private async handleWebSocketUpgrade(response: WebSocketResponse): Promise<void> {
        // Send upgrade headers
        const headers = Array.from(response.headers.entries());
        const statusText = response.statusText ?? http.strstatus(response.status);
        const serveHook = getServeHook();
        if (serveHook) try {
            serveHook.onResponse?.({
                requestId: this.requestId,
                url: this.url,
                status: response.status,
                statusText,
                headers: headersToRecord(response.headers),
                timestamp: serveTs()
            });
            this.emitFinished(true);
        } catch { }
        await this.coreRes.writeHead(response.status, statusText, headers);

        // Upgrade connection
        const conn = this.coreRes.upgrade();

        // Execute WebSocket handler
        if (response[kWebSocket]) {
            Reflect.set(conn, kWSMeta, {
                source: 'serve',
                requestId: this.requestId,
                url: this.url,
                requestHeaders: this.requestHeaders,
                responseStatus: response.status,
                responseHeaders: headers,
                callFrames: this.requestCallFrames,
            } as IWSMeta);
            response[kWebSocket]!(conn);
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

    then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
        return this.finishedPromise.then(onfulfilled, onrejected);
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
    // Capture call frames HERE — the user's code is on the stack.
    // Inside the server callback the stack is all internal infra.
    const serveEntryCallFrames = captureServeCallFrames();
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
            const serveHook = getServeHook();
            const requestId = serveHook ? newServeRequestId() : '';
            const requestStartTime = serveTs();
            const requestEntryCallFrames = serveEntryCallFrames ?? (serveHook ? captureServeCallFrames() : undefined);
            const requestPostData = req.body instanceof Uint8Array ? truncateHookPostData(req.body) : undefined;
            let requestUrl = '';
            let requestReported = false;
            try {
                // Create Web API Request
                const addr = coreServer.address();
                const webRequest = createWebRequest(req, {
                    hostname: addr?.ip || '0.0.0.0',
                    port: addr?.port || options.port || 8000,
                    secure: coreServer.isSecure
                });
                req.body = null;
                requestUrl = webRequest.url;

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

                let responseCallFrames = getResponseInitiatorCallFrames(webResponse) ?? requestEntryCallFrames;
                if (!responseCallFrames && serveHook) {
                    responseCallFrames = captureServeCallFrames();
                    setResponseInitiatorCallFrames(webResponse, responseCallFrames);
                }
                if (serveHook && requestId && !requestReported) try {
                    serveHook.onRequest?.({
                        requestId,
                        url: requestUrl,
                        method: req.method,
                        headers: headersArrayToRecord(req.headers),
                        postData: requestPostData,
                        callFrames: requestEntryCallFrames,
                        timestamp: requestStartTime,
                    });
                    requestReported = true;
                } catch { }

                const adapter = new ResponseAdapter(res, req.method, requestId, requestUrl, req.headers, requestEntryCallFrames);
                adapter.verify(webResponse);
                await adapter.sendResponse(webResponse);

            } catch (error) {
                if (error instanceof ServeResponseWriteError) {
                    // The adapter already reported loadingFailed and closed the connection.
                } else if (!(error instanceof errors.ConnectionReset)) {
                    // Send 500 error
                    try {
                        const body = 'Internal Server Error';
                        const headers: Array<[string, string]> = [['Content-Type', 'text/plain']];
                        if (serveHook && requestId && !requestReported) {
                            serveHook.onRequest?.({
                                requestId,
                                url: requestUrl,
                                method: req.method,
                                headers: headersArrayToRecord(req.headers),
                                postData: requestPostData,
                                callFrames: requestEntryCallFrames,
                                timestamp: requestStartTime,
                            });
                            requestReported = true;
                        }
                        if (serveHook && requestId) {
                            serveHook.onResponse?.({
                                requestId,
                                url: requestUrl,
                                status: 500,
                                statusText: 'Internal Server Error',
                                headers: headersArrayToRecord(headers),
                                timestamp: serveTs()
                            });
                            serveHook.onData?.({ requestId, data: engine.encodeString(body) as Uint8Array, timestamp: serveTs() });
                        }
                        await res.writeHead(500, 'Internal Server Error', headers);
                        await res.end(body);
                        if (serveHook && requestId) serveHook.onFinished?.({ requestId, success: true, timestamp: serveTs() });
                    } catch (e) {
                        // Ignore
                    }
                } else if (serveHook && requestId) {
                    try {
                        serveHook.onFinished?.({ requestId, success: false, errorText: String((error as Error)?.message ?? error), timestamp: serveTs() });
                    } catch { }
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

    // Handle abort signal
    if (options.signal) {
        options.signal.addEventListener('abort', () => httpServer.shutdown(), { once: true });
    }

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
    const conProm = Promise.withResolvers<ISocket>();

    // Create upgrade response
    const response = new Response(null, {
        status: 101,
        statusText: 'Switching Protocols',
        headers
    }) as WebSocketResponse;

    // Attach WebSocket handler
    const ws = createWebSocketFromISocket(conProm.promise);
    response[kWebSocket] = c => conProm.resolve(c);

    return {
        response,
        socket: ws
    };
}

/**
 * Create WebSocket from ISocket
 * This adapts the raw connection to WebSocket protocol
 */
function createWebSocketFromISocket(conn: Promise<ISocket>): globalThis.WebSocket {
    const serverMeta = conn.then(c => Reflect.get(c, kWSMeta) as IWSMeta);
    return createWebSocketFromConnection(
        conn.then(c => ({
            ...c,
            async clientHandshake(ctx, servername) {
                return; // here we already handled handshake, so just a stub enough
            },
        })),
        serverMeta,
    );
}

/* ------------------------------------------------------------------ */
/* Export to Deno namespace                                           */
/* ------------------------------------------------------------------ */

Object.assign(Deno, wrapFSns({
    // @ts-ignore
    serve,
    upgradeWebSocket
}));
