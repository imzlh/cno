/**
 * Deno.serve API Adapter
 * Bridges between Server core and Web API (Request/Response/WebSocket)
 */

import { Server, createServer, type HttpRequest, type HttpResponse } from '@cnojs/http/server';
import { TcpSocket } from '@cnojs/http/socket';
import { assert } from '../utils/assert';
import { createWebSocketFromConnection, type ServerWebSocketMeta, type ServerWebSocketConnection } from "../webapi/websocket";
import { createSwitchingProtocolsResponse, getResponseInitiatorCallFrames, setResponseInitiatorCallFrames } from '../webapi/fetch/server-response';
import { wrapFSErr, wrapFSns, wrapDenoError } from "../utils/wrap";
import { errMsg } from "../utils/error";
import { errors } from './01_errors';
import { getServeHook, captureUserNetworkCallFrames, type NetworkCallFrame } from '../utils/network-hooks';
import { getTierLimits } from '../utils/memory-tier';
import type { ISocket } from "@cnojs/http/socket";

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const http = import.meta.use('http');
const { hookPayloadCap } = getTierLimits();

const kWebSocket = Symbol('deno.serve.websocket');
let serveRequestSeq = 0;

interface WebSocketUpgrade {
    resolve(connection: ISocket, metadata: ServerWebSocketMeta): void;
    reject(reason: unknown): void;
}

interface WebSocketResponse extends Response {
    [kWebSocket]?: WebSocketUpgrade;
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

function createServeCompletion(): {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
} {
    const deferred = Promise.withResolvers<void>();
    let settled = false;

    // A client disconnect is an ordinary server event. Keep the runtime from
    // reporting an unhandled rejection when a handler does not observe it;
    // consumers of `promise` still receive the original rejection.
    void deferred.promise.catch(() => {});

    return {
        promise: deferred.promise,
        resolve() {
            if (settled) return;
            settled = true;
            deferred.resolve();
        },
        reject(reason: unknown) {
            if (settled) return;
            settled = true;
            const error = reason instanceof errors.Interrupted
                ? reason
                : new errors.Interrupted(errMsg(reason), { cause: reason });
            deferred.reject(error);
        },
    };
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

function closeResponseQuietly(response: HttpResponse): void {
    try {
        response.close();
    } catch {
        // Preserve the request/response failure that triggered teardown.
    }
}

function newServeRequestId(): string {
    return `serve-${++serveRequestSeq}`;
}

/** captureUserNetworkCallFrames skips the fetch() frame; skip this helper's too. */
function captureServeCallFrames(): NetworkCallFrame[] | undefined {
    return captureUserNetworkCallFrames();
}

function headersToRecord(headers: Iterable<[string, string]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
}

type ServeRequestBodyCapture = {
    present: boolean;
    chunks: Uint8Array[];
    bytes: number;
    complete: boolean;
};

function captureServeRequestBody(capture: ServeRequestBodyCapture, chunk: Uint8Array | null): void {
    if (chunk === null) {
        capture.complete = true;
        return;
    }
    if (capture.bytes >= hookPayloadCap) return;
    const length = Math.min(chunk.byteLength, hookPayloadCap - capture.bytes);
    if (length === 0) return;
    const copy = new Uint8Array(length);
    copy.set(chunk.subarray(0, length));
    capture.chunks.push(copy);
    capture.bytes += length;
}

function capturedServeRequestBody(capture: ServeRequestBodyCapture): Uint8Array | undefined {
    // A handler may deliberately leave a streaming request body unread. Do not
    // report a misleading prefix unless the body was consumed to completion or
    // the bounded hook preview is already full.
    if (!capture.present || (!capture.complete && capture.bytes < hookPayloadCap)) return undefined;
    const body = new Uint8Array(capture.bytes);
    let offset = 0;
    for (const chunk of capture.chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

function createWebRequest(
    coreReq: HttpRequest,
    connInfo: { hostname: string; port: number; secure: boolean },
    signal: AbortSignal,
): { request: Request; postData: () => Uint8Array | undefined } {
    const headers = new Headers(coreReq.headers);
    const host = headers.get('host') || `${connInfo.hostname}:${connInfo.port}`;
    const protocol = connInfo.secure ? 'https:' : 'http:';
    const base = `${protocol}//${host}`;
    const url = new URL(coreReq.url, base);
    const bodyPoll = coreReq.body;
    const capture: ServeRequestBodyCapture = {
        present: bodyPoll !== null,
        chunks: [],
        bytes: 0,
        complete: false,
    };
    let bodyEnded = false;

    const init: RequestInit & { duplex?: 'half' } = {
        method: coreReq.method,
        headers,
        signal,
        body: bodyPoll ? new ReadableStream({
            async pull(ctrl) {
                const res = await bodyPoll();
                if (!res) {
                    bodyEnded = true;
                    captureServeRequestBody(capture, null);
                    ctrl.close();
                } else {
                    captureServeRequestBody(capture, res);
                    ctrl.enqueue(res);
                }
            },
            cancel() {
                if (!bodyEnded) coreReq.cancelBody();
            },
        }) : null
    };
    // cno's Request implementation follows the Fetch streaming-upload rule:
    // a ReadableStream body must explicitly opt into half-duplex handling.
    if (bodyPoll) init.duplex = 'half';
    const request = new Request(url.toString(), init);
    return { request, postData: () => capturedServeRequestBody(capture) };
}

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
        const contentLength = res.headers.get('content-length');
        const transferEncoding = res.headers.get('transfer-encoding');

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
        const body = response.body;
        const reader = body?.getReader();
        let disconnectError: Error | undefined;
        let cancellation: Promise<void> | undefined;
        const cancelBody = (reason: unknown) => {
            if (!reader) return Promise.resolve();
            return cancellation ??= cancelReaderQuietly(reader, reason);
        };
        // A proxy may be awaiting an idle upstream read when the client leaves.
        // Cancel that read immediately instead of waiting for another body write.
        const removeCloseListener = hasBody ? this.coreRes.onTerminalClose(() => {
            disconnectError = Object.assign(new Error('HTTP response peer disconnected'), { code: 'ECONNRESET' });
            void cancelBody(disconnectError);
        }) : undefined;
        try {
            if (disconnectError) throw disconnectError;
            await this.coreRes.writeHead(response.status, statusText, headers);
            if (disconnectError) throw disconnectError;

            if (hasBody && reader) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (disconnectError) throw disconnectError;
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
            } else if (reader) {
                // HEAD sends representation headers but must release its producer.
                void cancelBody(undefined);
            }
            // Ending a completed H2 response can itself close its stream.
            removeCloseListener?.();
            await this.coreRes.end();
        } catch (err) {
            const message = errMsg(err);
            this.emitFinished(false, message);
            closeResponseQuietly(this.coreRes);
            // A producer's cancel() may never settle. Transport teardown and
            // request completion must not depend on that user-owned promise.
            void cancelBody(err);
            if (isServePeerDisconnect(err)) throw err;
            throw new ServeResponseWriteError(message, err);
        } finally {
            removeCloseListener?.();
            reader?.releaseLock();
        }
        this.emitFinished(true);
    }

    @wrapDenoError
    private async handleWebSocketUpgrade(response: WebSocketResponse): Promise<void> {
        const upgrade = response[kWebSocket]!;
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
            });
        }
        try {
            await this.coreRes.writeHead(response.status, statusText, headers);
            const conn = this.coreRes.upgrade();
            upgrade.resolve(conn, {
                source: 'serve',
                requestId: this.requestId,
                url: this.url,
                requestHeaders: this.requestHeaders,
                responseStatus: response.status,
                responseHeaders: headers,
                callFrames: this.requestCallFrames,
            });
            this.emitFinished(true);
        } catch (error) {
            upgrade.reject(error);
            this.emitFinished(false, errMsg(error));
            closeResponseQuietly(this.coreRes);
            throw new ServeResponseWriteError(errMsg(error), error);
        }
    }
}

class DenoHttpServer implements Deno.HttpServer<Deno.Addr> {
    private server: Server;
    private finishedPromise: Promise<void>;
    private finishedResolve: () => void;
    private shutdownPromise?: Promise<void>;
    private removeAbortListener?: () => void;
    public readonly addr: Deno.Addr;

    constructor(server: Server, addr: Deno.Addr) {
        this.server = server;
        const finished = Promise.withResolvers<void>();
        this.finishedPromise = finished.promise;
        this.finishedResolve = finished.resolve;
        this.addr = addr;
    }

    get finished(): Promise<void> {
        return this.finishedPromise;
    }

    ref(): void { this.server.ref(); }

    unref(): void { this.server.unref(); }

    bindSignal(signal: AbortSignal): void {
        const abort = () => {
            void this.shutdown().catch(error => reportServeError(error, '', 'shutdown'));
        };
        signal.addEventListener('abort', abort, { once: true });
        this.removeAbortListener = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
    }

    @wrapDenoError
    shutdown(): Promise<void> {
        this.removeAbortListener?.();
        this.removeAbortListener = undefined;
        return this.shutdownPromise ??= this.server.closeGracefully().then(() => this.finishedResolve());
    }

    @wrapDenoError
    [Symbol.asyncDispose](): Promise<void> {
        return this.shutdown();
    }
}

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
        if (typeof optionHandler !== 'function') {
            throw new TypeError(optionHandler === undefined ? 'Handler is required' : 'Handler must be a function');
        }
        options = { ...optionsOrHandler, handler: optionHandler };
    }

    const requestHandler = options.handler;
    const unixPath = 'path' in options ? options.path : undefined;
    const cert = optionalStringOption(options, 'cert');
    const key = optionalStringOption(options, 'key');

    // Create core server
    const coreServer = createServer(
        async (req, res) => {
            const serveHook = getServeHook();
            const requestId = serveHook ? newServeRequestId() : '';
            const requestStartTime = serveTs();
            const requestEntryCallFrames = serveEntryCallFrames ?? (serveHook ? captureServeCallFrames() : undefined);
            let requestUrl = '';
            let requestPostData: Uint8Array | undefined;
            let requestPostDataSource: (() => Uint8Array | undefined) | undefined;
            let requestReported = false;
            const reportRequest = () => {
                if (!serveHook || requestReported) return;
                requestReported = true;
                requestPostData ??= requestPostDataSource?.();
                emitServeHookQuietly(() => serveHook.onRequest?.({
                    requestId,
                    url: requestUrl,
                    method: req.method,
                    headers: headersToRecord(req.headers),
                    postData: requestPostData,
                    callFrames: requestEntryCallFrames,
                    timestamp: requestStartTime,
                }));
            };
            const sendResponse = (response: Response) => {
                const adapter = new ResponseAdapter(res, req.method, req.httpVersion, requestId, requestUrl, req.headers, requestEntryCallFrames);
                try {
                    adapter.verify(response);
                } catch (error) {
                    (response as WebSocketResponse)[kWebSocket]?.reject(error);
                    throw error;
                }
                return adapter.sendResponse(response);
            };
            const requestAbort = new AbortController();
            const completion = createServeCompletion();
            const removeRequestCloseListener = res.onTerminalClose(() => {
                const error = Object.assign(new Error('HTTP request peer disconnected'), { code: 'ECONNRESET' });
                requestAbort.abort(error);
                completion.reject(error);
            });
            try {
                const webRequestResult = createWebRequest(req, {
                    hostname: denoAddr.transport === 'tcp' ? denoAddr.hostname : 'localhost',
                    port: denoAddr.transport === 'tcp' ? denoAddr.port : 80,
                    secure: coreServer.isSecure
                }, requestAbort.signal);
                const webRequest = webRequestResult.request;
                requestPostDataSource = webRequestResult.postData;
                requestUrl = webRequest.url;

                const remote = req.connection.remoteAddress;
                const connInfo: Deno.ServeHandlerInfo = {
                    remoteAddr: 'path' in remote
                        ? { transport: 'unix', path: remote.path }
                        : { transport: 'tcp', hostname: remote.ip, port: remote.port },
                    completed: completion.promise,
                };

                const webResponse = await requestHandler(webRequest, connInfo);
                requestPostData = webRequestResult.postData();
                if (!(webResponse instanceof Response)) {
                    throw new TypeError('Handler must return a Response');
                }

                let responseCallFrames = getResponseInitiatorCallFrames(webResponse) ?? requestEntryCallFrames;
                if (!responseCallFrames && serveHook) {
                    responseCallFrames = captureServeCallFrames();
                    setResponseInitiatorCallFrames(webResponse, responseCallFrames);
                }
                reportRequest();
                await sendResponse(webResponse);
                completion.resolve();
            } catch (error) {
                // A started response or disconnected peer cannot be recovered with another response.
                if (requestAbort.signal.aborted || error instanceof ServeResponseWriteError || isServePeerDisconnect(error)) {
                    completion.reject(error);
                    return;
                }
                if (typeof options.onError !== 'function') {
                    reportServeError(error, requestUrl);
                }
                try {
                    reportRequest();
                    const handled = options.onError ? await options.onError(error) : undefined;
                    const errorResponse = handled instanceof Response ? handled : new Response('Internal Server Error', {
                        status: 500,
                        headers: { 'Content-Type': 'text/plain' },
                    });
                    await sendResponse(errorResponse);
                    completion.resolve();
                } catch (recoveryError) {
                    completion.reject(recoveryError);
                    closeResponseQuietly(res);
                    if (!isServePeerDisconnect(recoveryError)) {
                        reportServeError(recoveryError, requestUrl, 'error handler');
                    }
                    // Keep the connection failure isolated from the accept loop.
                }
            } finally {
                removeRequestCloseListener();
            }
        },
        {
            hostname: unixPath ? '0.0.0.0' : options.hostname || '0.0.0.0',
            port: unixPath ? 0 : options.port ?? 8000,
            path: unixPath,
            cert,
            key,
            keepAliveTimeout: optionalNumberOption(options, 'keepAliveTimeout'),
            requestTimeout: optionalNumberOption(options, 'requestTimeout'),
        }
    );

    let denoAddr: Deno.Addr;
    try {
        coreServer.listen();
        // The listen address is constant for the listener's lifetime.
        const listenAddr = coreServer.address();
        denoAddr = listenAddr && 'path' in listenAddr
            ? { transport: 'unix', path: listenAddr.path }
            : {
                hostname: listenAddr?.ip || '0.0.0.0',
                port: listenAddr?.port ?? options.port ?? 8000,
                transport: 'tcp'
            };
        coreServer.acceptLoop();
        const httpServer = new DenoHttpServer(coreServer, denoAddr);
        options.onListen?.(httpServer.addr);
        if (options.signal) httpServer.bindSignal(options.signal);
        return httpServer;
    } catch (error) {
        coreServer.close();
        throw error;
    }
}

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

    const headers = new Headers({
        'upgrade': 'websocket',
        'connection': 'Upgrade',
        'sec-websocket-accept': calculateWebSocketAccept(wsKey)
    });

    const protocols = request.headers.get('sec-websocket-protocol');
    if (protocols && options?.protocol) {
        const requestedProtocols = protocols.split(',').map(p => p.trim());
        if (requestedProtocols.includes(options.protocol)) {
            headers.set('sec-websocket-protocol', options.protocol);
        }
    }

    const connection = Promise.withResolvers<ServerWebSocketConnection>();

    const response = createSwitchingProtocolsResponse({
        statusText: 'Switching Protocols',
        headers
    }) as WebSocketResponse;

    const ws = createWebSocketFromConnection(connection.promise);
    response[kWebSocket] = {
        resolve(socket, meta) {
            connection.resolve({ socket, metadata: meta });
        },
        reject(reason) {
            connection.reject(reason);
        },
    };

    return {
        response,
        socket: ws
    };
}

export const SERVE_EXPORTS = wrapFSns({
    // @ts-ignore - serve cast
    serve,
    upgradeWebSocket
});
Object.assign(Deno, SERVE_EXPORTS);
