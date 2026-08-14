/**
 * Deno.serve API Adapter
 * Bridges between Server core and Web API (Request/Response/WebSocket)
 */

import { Server, createServer, type HttpRequest, type HttpResponse } from '@cnojs/http/server';
import { HttpVersion } from '@cnojs/http/protocol';
import { h2Available } from '@cnojs/http/h2-native';
import { TcpSocket } from '@cnojs/http/socket';
import { assert } from '../utils/assert';
import { createWebSocketFromConnection } from "../webapi/websocket";
import { createSwitchingProtocolsResponse, getResponseInitiatorCallFrames, setResponseInitiatorCallFrames } from '../webapi/fetch';
import { wrapFsClassDec as wrap, wrapFSErr, wrapFSns } from "../utils/wrap";
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

/** Non-disconnect write fault after headers/body started — outer loop must not run onError/500. */
class ServeResponseWriteError extends Error {
    override cause?: unknown;
    constructor(message: string, cause?: unknown) {
        super(message);
        this.cause = cause;
    }
}

function isDenoTransportGone(err: unknown): boolean {
    return err instanceof errors.ConnectionReset
        || err instanceof errors.BrokenPipe
        || err instanceof errors.UnexpectedEof
        || err instanceof errors.NotConnected
        || err instanceof errors.ConnectionAborted
        || err instanceof errors.BadResource
        || err instanceof errors.Interrupted;
}

function isServePeerDisconnect(err: unknown): boolean {
    // Prefer structured UV/Node codes before wrap remapping (ECANCELED etc.).
    if (TcpSocket.isDisconnectError(err)) return true;
    if (isDenoTransportGone(err)) return true;
    return isDenoTransportGone(wrapFSErr(err));
}

type IWSMeta = {
    source: 'serve';
    requestId: string;
    url: string;
    requestHeaders?: Array<[string, string]>;
    responseStatus?: number;
    responseHeaders?: Array<[string, string]>;
} | undefined;

type ServeRuntimeOptions =
    Deno.ServeOptions &
    Partial<Deno.ServeTcpOptions> &
    Partial<Deno.ServeUnixOptions> &
    Partial<Deno.TlsCertifiedKeyPem> &
    Deno.ServeInit;

function hasServeHandler(options: Deno.ServeOptions): options is Deno.ServeOptions & Deno.ServeInit {
    return typeof Reflect.get(options, 'handler') === 'function';
}

function optionalStringOption(options: object, key: string): string | undefined {
    const value = Reflect.get(options, key);
    return typeof value === 'string' ? value : undefined;
}

function optionalNumberOption(options: object, key: string): number | undefined {
    const value = Reflect.get(options, key);
    return typeof value === 'number' ? value : undefined;
}

function serveTs(): number {
    return Date.now() / 1000;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function reportServeError(error: unknown, url: string, phase = 'request'): void {
    try {
        console.error(`Deno.serve ${phase} error${url ? ` for ${url}` : ''}:`, error);
    } catch {
        // Diagnostics must never change the response or accept-loop behavior.
    }
}

function isBodylessStatus(status: number): boolean {
    return (status >= 100 && status < 200) || status === 204 || status === 205 || status === 304;
}

function emitServeHookQuietly(callback: () => void): void {
    try {
        callback();
    } catch {
        // Inspector hooks are observers; hook failures must not affect serve().
    }
}

async function cancelReaderQuietly(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): Promise<void> {
    try {
        await reader.cancel(reason);
    } catch {
        // Downstream is already failing; keep the original write error.
    }
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
    const bodyPoll = coreReq.body;

    const init: RequestInit & { duplex?: 'half' } = {
        method: coreReq.method,
        headers,
        body: bodyPoll ? new ReadableStream({
            async pull(ctrl) {
                const res = await bodyPoll();
                if (!res)   ctrl.close();
                else        ctrl.enqueue(res);
            }
        }) : null
    };
    // cno's Request implementation follows the Fetch streaming-upload rule:
    // a ReadableStream body must explicitly opt into half-duplex handling.
    if (bodyPoll) init.duplex = 'half';
    return new Request(url.toString(), init);
}

/**
 * Adapter for HttpResponse to handle Web API Response
 */
class ResponseAdapter {
    private coreRes: HttpResponse;
    private finishedEmitted = false;
    private method: string;
    private httpVersion: string;
    private requestId: string;
    private url: string;
    private requestHeaders: Array<[string, string]>;
    private requestCallFrames?: NetworkCallFrame[];
    private declaredContentLength: number | null = null;

    constructor(coreRes: HttpResponse, method: string, httpVersion: string, requestId: string, url: string, requestHeaders: Array<[string, string]>, requestCallFrames?: NetworkCallFrame[]) {
        this.coreRes = coreRes;
        this.method = method;
        this.httpVersion = httpVersion;
        this.requestId = requestId;
        this.url = url;
        this.requestHeaders = requestHeaders;
        this.requestCallFrames = requestCallFrames;
    }

    private emitFinished(success: boolean, errorText?: string): void {
        if (this.finishedEmitted) return;
        this.finishedEmitted = true;
        const serveHook = getServeHook();
        if (serveHook) {
            emitServeHookQuietly(() => {
                serveHook.onFinished?.({ requestId: this.requestId, success, errorText, timestamp: serveTs() });
            });
        }
    }

    verify(res: Response): void {
        const getHeader = (name: string) => res.headers.get(name);
        const contentType = getHeader('content-type');
        const contentLength = getHeader('content-length');
        const transferEncoding = getHeader('transfer-encoding');

        if (isBodylessStatus(res.status)) {
            assert(!res.body, `Status ${res.status} must not have a response body`);
            assert(!contentLength || contentLength === '0', `Status ${res.status} must not have Content-Length or it must be 0`);
            assert(!transferEncoding, `Status ${res.status} must not use Transfer-Encoding`);
            return;
        }

        if (contentLength) {
            const value = contentLength.trim();
            assert(/^\d+$/.test(value), `Invalid Content-Length: ${contentLength}`);
            const length = Number(value);
            assert(Number.isSafeInteger(length), `Invalid Content-Length: ${contentLength}`);
            if (length > 0) assert(res.body || this.method === 'HEAD', "Body must exist if Content-Length > 0");
            this.declaredContentLength = length;
        }

        if (transferEncoding) {
            assert(!contentLength, 'Transfer-Encoding and Content-Length cannot coexist');
            assert(transferEncoding.trim().toLowerCase() === 'chunked', 'Unsupported Transfer-Encoding');
        }

        void contentType;
    }

    async sendResponse(response: Response): Promise<void> {
        const wsResponse = response as WebSocketResponse;
        if (wsResponse[kWebSocket]) {
            await this.handleWebSocketUpgrade(wsResponse);
            return;
        }

        const headers2 = new Headers(response.headers);
        const noBodyStatus = isBodylessStatus(response.status);
        const isHead = this.method === 'HEAD';
        const hasBody = response.body !== null && !noBodyStatus && !isHead;
        const hasContentLength = headers2.has('content-length');
        const hasTransferEncoding = headers2.has('transfer-encoding');
        const isHttp2 = this.httpVersion === '2.0';
        let bodyBytes = 0;

        if (isHttp2) {
            headers2.delete('transfer-encoding');
        } else if (hasBody && !hasContentLength && !hasTransferEncoding) {
            headers2.set('transfer-encoding', 'chunked');
        }

        const headers = Array.from(headers2.entries());
        const statusText = response.statusText ?? http.strstatus(response.status);
        const serveHook = getServeHook();
        if (serveHook) {
            emitServeHookQuietly(() => {
                serveHook.onResponse?.({
                    requestId: this.requestId,
                    url: this.url,
                    status: response.status,
                    statusText,
                    headers: headersToRecord(headers2),
                    timestamp: serveTs()
                });
            });
        }
        await this.coreRes.writeHead(response.status, statusText, headers);

        const body = response.body;
        if (hasBody && body) {
            const reader = body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (serveHook) {
                        emitServeHookQuietly(() => {
                            serveHook.onData?.({ requestId: this.requestId, data: value, timestamp: serveTs() });
                        });
                    }
                    bodyBytes += value.byteLength;
                    if (this.declaredContentLength !== null) {
                        assert(bodyBytes <= this.declaredContentLength, 'Response body exceeds Content-Length');
                    }
                    await this.coreRes.write(value);
                }
                if (!isHead && !noBodyStatus && this.declaredContentLength !== null) {
                    assert(bodyBytes === this.declaredContentLength, 'Response body does not match Content-Length');
                }
            } catch (err) {
                const message = errorMessage(err);
                this.emitFinished(false, message);
                // Propagate downstream cancellation/write failure back to the
                // upstream body source (for example fetch -> curl), otherwise
                // the producer keeps downloading after the client has gone away.
                await cancelReaderQuietly(reader, err);
                this.coreRes.close();
                // Keep structured UV/Deno code for peer-gone; do not strip to message-only.
                if (isServePeerDisconnect(err)) throw err;
                throw new ServeResponseWriteError(message, err);
            } finally {
                reader.releaseLock();
            }
        }

        try {
            await this.coreRes.end();
        } catch (err) {
            this.emitFinished(false, errorMessage(err));
            this.coreRes.close();
            if (isServePeerDisconnect(err)) throw err;
            throw new ServeResponseWriteError(errorMessage(err), err);
        }
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
        if (serveHook) {
            emitServeHookQuietly(() => {
                serveHook.onResponse?.({
                    requestId: this.requestId,
                    url: this.url,
                    status: response.status,
                    statusText,
                    headers: headersToRecord(response.headers),
                    timestamp: serveTs()
                });
                this.emitFinished(true);
            });
        }
        await this.coreRes.writeHead(response.status, statusText, headers);

        // Upgrade connection
        const conn = this.coreRes.upgrade();

        // Execute WebSocket handler
        const websocketHandler = response[kWebSocket];
        if (websocketHandler) {
            Reflect.set(conn, kWSMeta, {
                source: 'serve',
                requestId: this.requestId,
                url: this.url,
                requestHeaders: this.requestHeaders,
                responseStatus: response.status,
                responseHeaders: headers,
                callFrames: this.requestCallFrames,
            } as IWSMeta);
            websocketHandler(conn);
        }
    }
}

/* ------------------------------------------------------------------ */
/* Deno.serve Implementation                                          */
/* ------------------------------------------------------------------ */

/**
 * HTTP server wrapper (implements Deno.HttpServer interface)
 */
class DenoHttpServer implements Deno.HttpServer<Deno.Addr> {
    private server: Server;
    private finishedPromise: Promise<void>;
    private finishedResolve: () => void;
    public readonly addr: Deno.Addr;

    constructor(server: Server) {
        this.server = server;
        const finished = Promise.withResolvers<void>();
        this.finishedPromise = finished.promise;
        this.finishedResolve = finished.resolve;
        const addr = server.address();
        this.addr = addr && 'path' in addr
            ? { transport: 'unix', path: addr.path }
            : {
                transport: 'tcp',
                hostname: addr?.ip ?? '::',
                port: addr?.port ?? 80
            };
    }

    get finished(): Promise<void> {
        return this.finishedPromise;
    }

    ref(): void {
        // Txiki.js server handles do not expose ref/unref.
    }

    unref(): void {
        // Kept as the matching no-op for ref().
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
    // Capture call frames HERE — the user's code is on the stack.
    // Inside the server callback the stack is all internal infra.
    const serveEntryCallFrames = captureServeCallFrames();
    let options: ServeRuntimeOptions;

    // Handle overloads
    if (typeof optionsOrHandler === 'function') {
        options = {
            handler: optionsOrHandler,
            port: 8000
        };
    } else {
        const optionHandler = handler ?? (hasServeHandler(optionsOrHandler) ? optionsOrHandler.handler : undefined);
        if (!optionHandler) throw new TypeError('Handler is required');
        options = { ...optionsOrHandler, handler: optionHandler };
    }

    // Validate handler
    if (!options.handler) {
        throw new TypeError('Handler is required');
    }

    const unixPath = 'path' in options ? options.path : undefined;

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
                const denoAddr: Deno.Addr = addr && 'path' in addr
                    ? { transport: 'unix', path: addr.path }
                    : {
                        hostname: addr?.ip || '0.0.0.0',
                        port: addr?.port ?? options.port ?? 8000,
                        transport: 'tcp'
                    };
                const webRequest = createWebRequest(req, {
                    hostname: denoAddr.transport === 'tcp' ? denoAddr.hostname : 'localhost',
                    port: denoAddr.transport === 'tcp' ? denoAddr.port : 80,
                    secure: coreServer.isSecure
                });
                req.body = null;
                requestUrl = webRequest.url;

                // Create connection info
                const connInfo: Deno.ServeHandlerInfo = {
                    remoteAddr: denoAddr,
                    completed: Promise.resolve() // Simplified
                };

                // Call user handler
                const handler = options.handler;
                if (!handler) throw new TypeError('Deno.serve requires a handler');
                const webResponse = await handler(webRequest, connInfo);
                if (!webResponse || !(webResponse instanceof Response)) {
                    throw new TypeError('Handler must return a Response');
                }

                let responseCallFrames = getResponseInitiatorCallFrames(webResponse) ?? requestEntryCallFrames;
                if (!responseCallFrames && serveHook) {
                    responseCallFrames = captureServeCallFrames();
                    setResponseInitiatorCallFrames(webResponse, responseCallFrames);
                }
                if (serveHook && requestId && !requestReported) {
                    emitServeHookQuietly(() => {
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
                    });
                }

                const adapter = new ResponseAdapter(res, req.method, req.httpVersion, requestId, requestUrl, req.headers, requestEntryCallFrames);
                adapter.verify(webResponse);
                await adapter.sendResponse(webResponse);

            } catch (error) {
                if (error instanceof ServeResponseWriteError) {
                    // The adapter already reported loadingFailed and closed the connection.
                } else if (isServePeerDisconnect(error)) {
                    // Peer left mid-response. Adapter already closed + onFinished; never onError/500.
                } else {
                    // Give user code the same error-recovery hook Deno.serve exposes.
                    if (typeof options.onError !== 'function') {
                        reportServeError(error, requestUrl);
                    }
                    try {
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

                        let errorResponse: Response | undefined;
                        if (options.onError) {
                            const handled = await options.onError(error);
                            if (handled instanceof Response) errorResponse = handled;
                        }
                        errorResponse ??= new Response('Internal Server Error', {
                            status: 500,
                            headers: { 'Content-Type': 'text/plain' },
                        });

                        const adapter = new ResponseAdapter(res, req.method, req.httpVersion, requestId, requestUrl, req.headers, requestEntryCallFrames);
                        adapter.verify(errorResponse);
                        await adapter.sendResponse(errorResponse);
                    } catch (recoveryError) {
                        if (!isServePeerDisconnect(recoveryError)) {
                            reportServeError(recoveryError, requestUrl, 'error handler');
                        }
                        // Keep the connection failure isolated from the accept loop.
                    }
                }
            }
        },
        {
            hostname: unixPath ? '0.0.0.0' : options.hostname || '0.0.0.0',
            port: unixPath ? 0 : options.port ?? 8000,
            path: unixPath,
            cert: optionalStringOption(options, 'cert'),
            key: optionalStringOption(options, 'key'),
            keepAliveTimeout: optionalNumberOption(options, 'keepAliveTimeout'),
            requestTimeout: optionalNumberOption(options, 'requestTimeout'),
            // TLS: offer h2 when the native extension is linked (client ALPN picks).
            // Cleartext stays HTTP/1.1 only — Deno.serve does not speak prior-knowledge h2c.
            protocols: (() => {
                const hasTls = !!(optionalStringOption(options, 'cert') && optionalStringOption(options, 'key'));
                if (hasTls && h2Available()) return [HttpVersion.HTTP2, HttpVersion.HTTP11];
                return [HttpVersion.HTTP11];
            })(),
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
        options.onListen(httpServer.addr);
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

    if (upgradeHeader !== 'websocket') {
        throw new TypeError("Invalid Header: 'upgrade' header must contain 'websocket'");
    }

    if (!connectionHeader?.includes('upgrade')) {
        throw new TypeError("Invalid Header: 'connection' header must contain 'Upgrade'");
    }

    if (!wsKey) {
        throw new TypeError("Invalid Header: 'sec-websocket-key' header must be set");
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
    const response = createSwitchingProtocolsResponse({
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
    // @ts-ignore - serve cast
    serve,
    upgradeWebSocket
}));
