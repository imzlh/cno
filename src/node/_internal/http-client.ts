const asyncfs = import.meta.use('asyncfs');
const dns = import.meta.use('dns');
const engine = import.meta.use('engine');
const fs = import.meta.use('fs');
const algorithm = import.meta.use('algorithm');
const os = import.meta.use('os');
const timers = import.meta.use('timers');
const win32 = import.meta.use('win32');

import { encodeChunkedFrame, formatRequestHead } from '@cnojs/http/h1-frame';
import { IncomingMessageImpl } from '../http/server';
import type { OutgoingHttpHeader, OutgoingHttpHeaders } from '../http/types';
import { Socket } from '../net';
import { type TLSSocket, type TlsOptions, connect as tlsConnect } from '../tls';
import { arrayBufferBackedBytes, viewToUint8Array } from './buffer';
import { normalizeErrnoError } from './errno';
import {
    buildNodeUrl,
    captureNodeNetworkCallFrames,
    getNodeFetchHook,
    nextNodeRequestId,
    nodeTs,
    normalizeHeaderRecord,
    setupResponseParser,
} from './network-debug';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export interface ClientRequestOptions {
    auth?: string | null;
    headers?: OutgoingHttpHeaders | readonly string[];
    host?: string | null;
    hostname?: string | null;
    lookup?: (hostname: string, options: { family: 4 | 6 }, callback: (err: Error | null, address: string, family: number) => void) => void;
    method?: string;
    path?: string | null;
    port?: number | string | null;
    protocol?: string | null;
    setDefaultHeaders?: boolean;
    setHost?: boolean;
    signal?: AbortSignal;
    timeout?: number;
    ca?: TlsOptions['ca'];
    cert?: TlsOptions['cert'];
    key?: TlsOptions['key'];
    rejectUnauthorized?: boolean;
    servername?: string;
    ciphers?: string;
}

type ClientTransport = Socket | TLSSocket;

export interface ClientRequestState<TTransport extends ClientTransport = ClientTransport> {
    aborted: boolean;
    destroyed?: boolean;
    host: string;
    protocol: string;
    method: string;
    path: string;
    socket: TTransport | null;
    /** Node exposes the IncomingMessage as `req.res` once the response arrives. */
    res?: IncomingMessageImpl | null;
    writableEnded: boolean;
    writableFinished: boolean;
    finished: boolean;
    headersSent: boolean;
    _options: ClientRequestOptions;
    _callback: ((res: IncomingMessageImpl) => void) | null;
    _aborted: boolean;
    _closeEmitted?: boolean;
    _timeoutId: number | null;
    _requestBody: Uint8Array[];
    _bodySent: boolean;
    _requestId: string;
    _requestCallFrames: ReturnType<typeof captureNodeNetworkCallFrames>;
    _abortHandler: (() => void) | null;
    _streamedBeforeEnd: boolean;
    _sendChain: Promise<void>;
    _chunkedEncoding: boolean;
    _headerFlushStarted: boolean;
    _responseReaderStarted?: boolean;
    _header: string | null;
    outputData: Array<{ data: string }>;
    _connectPromise: Promise<void> | null;
    _streamErrored: boolean;
    _transport: TTransport | null;
    _transportCleanup: (() => void) | null;
    abort(): void;
    setTimeout(timeout: number, callback?: () => void): this;
    _cleanup(): void;
    setHeader(name: string, value: OutgoingHttpHeader): this;
    hasHeader(name: string): boolean;
    getHeader(name: string): OutgoingHttpHeader | undefined;
    getHeaders(): OutgoingHttpHeaders;
    _formatHeaders(): string;
    _implicitHeader(): void;
    emit(event: string | symbol, ...args: unknown[]): boolean;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    off(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

export interface ClientHooks<TRequest extends ClientRequestState = ClientRequestState> {
    defaultPort: number;
    defaultUserAgent: string;
    defaultAcceptEncoding?: string;
    requestIdPrefix: string;
    waitForSecureConnect?: boolean;
    connect(request: TRequest): Promise<RequestTransport<TRequest>>;
    onTransportAssigned?(request: TRequest, transport: RequestTransport<TRequest>): void;
}

type RequestTransport<TRequest extends ClientRequestState> = NonNullable<TRequest['_transport']>;
type AgentLike<TRequest extends ClientRequestState> = {
    addRequest(req: TRequest, options: TRequest['_options']): void;
};
type MaybeSecureTransport = ClientTransport & {
    encrypted?: boolean;
    _handshakeComplete?: boolean;
    once(event: 'secureConnect' | 'error', listener: (...args: unknown[]) => void): unknown;
    off(event: 'secureConnect' | 'error', listener: (...args: unknown[]) => void): unknown;
};

const CHUNKED_TRAILER = engine.encodeString('0\r\n\r\n');
function destroyTransportQuietly(transport: { destroy(): unknown }): void {
    try {
        transport.destroy();
    } catch {
        // Best-effort cleanup for aborted or unhandled HTTP sockets.
    }
}

function emitAbortedQuietly(res: IncomingMessageImpl): void {
    try {
        res.emit('aborted');
    } catch {
        // Keep error propagation on the normalized request error path.
    }
}

export function initClientRequestState(self: ClientRequestState, cb?: (res: IncomingMessageImpl) => void): void {
    self.aborted = false;
    self.destroyed = false;
    self.host = 'localhost';
    self.protocol = 'http:';
    self.method = 'GET';
    self.path = '/';

    self.socket = null;
    self.res = null;
    self._callback = cb || null;
    self._aborted = false;
    self._closeEmitted = false;
    self._timeoutId = null;
    self._requestBody = [];
    self._bodySent = false;
    self._requestId = '';
    self._requestCallFrames = captureNodeNetworkCallFrames();
    self._abortHandler = null;
    self._streamedBeforeEnd = false;
    self._sendChain = Promise.resolve();
    self._chunkedEncoding = false;
    self._headerFlushStarted = false;
    self._responseReaderStarted = false;
    self._header = null;
    self.outputData = [];
    self._connectPromise = null;
    self._streamErrored = false;
    self._transport = null;
    self._transportCleanup = null;
}

/** Node's AbortError for a signal-cancelled request. */
function createAbortError(): Error {
    return Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
    });
}

/**
 * Emit `'close'` on the ClientRequest exactly once.
 *
 * Node emits 'close' on the request in *every* terminal path — success,
 * destroy(), destroy(err), abort() and a signal abort — and cno emitted it in
 * none of them. `await once(req, 'close')` and `stream.finished(req)` are the
 * ordinary ways to wait for a request to be over, so both hung forever;
 * OBSERVED as TIMEBOX on all six lifecycle probes in /d/tmp/ag-http/p3-lifecycle.js
 * while node completed each one. The response object did emit 'close', which is
 * why the gap survived: anything that happened to await `res` looked fine.
 */
export function emitRequestClose<TRequest extends ClientRequestState>(request: TRequest): void {
    if (request._closeEmitted) return;
    request._closeEmitted = true;
    request.emit('close');
}

export function applyRequestCommonOptions(self: ClientRequestState): void {
    if (self._options.timeout) self.setTimeout(self._options.timeout);
    const signal = self._options.signal;
    if (!signal) return;
    // A signal that is ALREADY aborted must fail the request immediately. cno
    // only ever registered a listener, so a pre-aborted signal was silently
    // ignored and the request proceeded to connect — OBSERVED as p3-lifecycle S5
    // TIMEBOX where node rejects with AbortError before touching the network.
    // Deferred to a microtask so the caller can still attach 'error'/'close'
    // between http.request(...) returning and the failure landing.
    if (signal.aborted) {
        queueMicrotask(() => abortRequestWithSignal(self, signal));
        return;
    }
    self._abortHandler = () => abortRequestWithSignal(self, signal);
    signal.addEventListener('abort', self._abortHandler, { once: true });
}

/**
 * Signal-driven abort. Distinct from the legacy `req.abort()`: node surfaces an
 * `AbortError` (name 'AbortError', code 'ABORT_ERR', message 'The operation was
 * aborted') rather than the ECONNRESET that `abort()` produces. cno routed both
 * through `abort()`, so a signal abort emitted only the legacy 'abort' event and
 * no error at all: code waiting on 'error' never woke up (p3-lifecycle S4).
 *
 * MEASURED (/d/tmp/ag-http/p14-abortreason.js): node's http client ignores
 * `signal.reason` completely — abort(), abort(new Error('X')),
 * abort('string') and abort(new TypeError) all produce the identical
 * ABORT_ERR AbortError. Only `fetch` propagates the reason. Passing the reason
 * through here (the obvious implementation) therefore diverges three ways: a
 * bare abort() leaked the DOMException with numeric `code` 20, and a custom
 * reason leaked its own name/code.
 */
function abortRequestWithSignal(request: ClientRequestState, _signal: AbortSignal): void {
    if (request._aborted) return;
    // `_aborted` is the internal "stop reporting transport errors" flag; the
    // PUBLIC `aborted` stays false for a signal abort. Node only sets
    // `req.aborted` from the legacy `.abort()` — OBSERVED p1-basic T16
    // "close:aborted=false:destroyed=true" — so mirroring it here would make
    // code that branches on `req.aborted` think abort() had been called.
    request._aborted = true;
    cleanupRequest(request);
    request.destroyed = true;
    request.emit('error', createAbortError());
    emitRequestClose(request);
}

export function splitHostPort(host: string | null | undefined): { hostname?: string; port?: string } {
    if (!host) return {};
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        if (end !== -1) {
            const hostname = host.slice(1, end);
            const rest = host.slice(end + 1);
            return rest.startsWith(':') ? { hostname, port: rest.slice(1) } : { hostname };
        }
    }
    const firstColon = host.indexOf(':');
    if (firstColon !== -1 && firstColon === host.lastIndexOf(':')) {
        return { hostname: host.slice(0, firstColon), port: host.slice(firstColon + 1) };
    }
    return { hostname: host };
}

export function normalizeRequestOptions<T extends ClientRequestOptions>(options: T): T {
    if (options.hostname || !options.host) return options;
    const parsed = splitHostPort(options.host);
    return {
        ...options,
        hostname: parsed.hostname ?? options.host,
        port: options.port ?? parsed.port,
    };
}

export function mergeUrlOptions<T extends ClientRequestOptions>(url: string | URL, options?: T): T {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return normalizeRequestOptions({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        auth: parsed.username || parsed.password ? `${parsed.username}:${parsed.password}` : undefined,
        ...(options || {}),
    } as T);
}

export function shouldSendZeroContentLength(method: string): boolean {
    return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

export function encodeRequestChunk(chunk: unknown, encoding?: BufferEncoding): Uint8Array {
    if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8') as Uint8Array;
    if (typeof chunk === 'number' && Number.isInteger(chunk) && chunk >= 0 && chunk <= 255) {
        return Uint8Array.of(chunk);
    }
    if (chunk instanceof Uint8Array) return chunk as Uint8Array;
    if (ArrayBuffer.isView(chunk)) {
        return viewToUint8Array(chunk) as Uint8Array;
    }
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    return Buffer.from(String(chunk ?? ''), encoding || 'utf8') as Uint8Array;
}

function resolvePort(port: number | string | null | undefined, fallback: number): number {
    return typeof port === 'string' ? parseInt(port) : port || fallback;
}

function isIPv6Literal(host: string): boolean {
    const bracketed = host.startsWith('[') && host.endsWith(']');
    const value = bracketed ? host.slice(1, -1) : host;
    return bracketed || (value.match(/:/g)?.length ?? 0) > 1;
}

function hostForLookup(host: string): string {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export async function lookupRequestHost(options: ClientRequestOptions, hostname: string, isIPv6: boolean): Promise<{ ip: string; family: number }> {
    const lookup = options.lookup;
    if (lookup) {
        return await new Promise((resolve, reject) => {
            lookup(hostname, { family: isIPv6 ? 6 : 4 }, (err, address, family) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ ip: address, family });
            });
        });
    }

    const addrs = await dns.resolve(hostname, { family: isIPv6 ? os.AF_INET6 : os.AF_INET });
    if (!addrs?.length) throw new Error(`DNS resolution failed for ${hostname}`);
    return addrs.find((item: CModuleDNS.ResolvedAddress) => item.family === (isIPv6 ? 6 : 4)) || addrs[0];
}

async function connectSocket(host: string, port: number): Promise<Socket> {
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
            socket.off('error', onError);
            resolve();
        };
        const onError = (err: Error) => {
            socket.off('connect', onConnect);
            reject(err);
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
        socket.connect(port, host);
    });
    socket.setNoDelay(true);
    return socket;
}

let systemCaPath: string | null | undefined = undefined;

/**
 * Locate a platform CA bundle on disk, returning its **file path**.
 *
 * NOT PEM text. Feeding this to `tls.connect({ ca })` — which takes PEM —
 * throws "SSL_CTX_load_verify_locations_pem" and broke every https request that
 * carried no explicit `ca`. Both former callers were removed for that reason;
 * `tls`'s SecureContext already falls back to the platform trust store when `ca`
 * is absent, so prefer leaving `ca` undefined. Read the file first if a path is
 * genuinely what you need.
 */
export async function getSystemCa(): Promise<string | null> {
    if (systemCaPath !== undefined) return systemCaPath;
    const sysname = os.uname().sysname;
    const candidates: string[] = sysname === 'Linux' ? [
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/pki/tls/certs/ca-bundle.crt',
        '/etc/pki/tls/cert.pem',
        '/etc/ssl/cert.pem',
    ] : sysname === 'Darwin' ? [
        '/etc/ssl/cert.pem',
        '/opt/homebrew/etc/openssl@3/cert.pem',
        '/usr/local/etc/openssl@3/cert.pem',
    ] : sysname === 'FreeBSD' ? [
        '/usr/local/share/certs/ca-root-nss.crt',
        '/etc/ssl/cert.pem',
    ] : [];

    for (const candidate of candidates) {
        try {
            if ((await asyncfs.stat(candidate)).isFile) {
                systemCaPath = candidate;
                return candidate;
            }
        } catch {}
    }

    if (sysname === 'Windows_NT') {
        const tmpDir = os.tmpDir || 'C:\\Windows\\Temp';
        const tmp = `${tmpDir}\\cno-ca-bundle.pem`;
        try {
            const certs = win32!.exportCerts();
            if (certs?.length) {
                await fs.writeFile(tmp, engine.encodeString(certs.join('\n')));
                systemCaPath = tmp;
                return tmp;
            }
        } catch {}
    }

    systemCaPath = null;
    return null;
}

export async function connectPlainTransport<TRequest extends ClientRequestState>(request: TRequest, fallbackPort = 80): Promise<Socket> {
    const port = resolvePort(request._options.port, fallbackPort);
    const lookupHost = hostForLookup(request.host);
    const addr = await lookupRequestHost(request._options, lookupHost, isIPv6Literal(request.host));
    return await connectSocket(addr.ip, port);
}

export async function connectSecureTransport<TRequest extends ClientRequestState>(request: TRequest, fallbackPort = 443): Promise<TLSSocket> {
    const port = resolvePort(request._options.port, fallbackPort);
    const lookupHost = hostForLookup(request.host);
    const rejectUnauthorized = request._options.rejectUnauthorized ?? true;
    // getSystemCa() returns a FILE PATH, but `ca` is PEM text: passing the path
    // made the SecureContext constructor throw
    // "SSL_CTX_load_verify_locations_pem", so every https request that did not
    // carry an explicit `ca` failed before it reached the wire. tls's own
    // SecureContext already falls back to the platform trust store when `ca` is
    // absent, so leave it undefined and let that path run.
    const ca = request._options.ca;

    const tlsSocket = tlsConnect(port, lookupHost, {
        lookup: request._options.lookup,
        servername: request._options.servername ?? lookupHost,
        rejectUnauthorized,
        ca,
        cert: request._options.cert,
        key: request._options.key,
        ciphers: request._options.ciphers,
        noDelay: true,
    });

    await new Promise<void>((resolve, reject) => {
        const timeout = timers.setTimeout(() => {
            tlsSocket.off('secureConnect', onConnect);
            tlsSocket.off('error', onError);
            reject(new Error('TLS handshake timeout'));
        }, 10000);
        const onConnect = () => {
            timers.clearTimeout(timeout);
            tlsSocket.off('error', onError);
            if (rejectUnauthorized && !tlsSocket.authorized) {
                reject(tlsSocket.authorizationError ?? new Error('Certificate verification failed'));
                return;
            }
            resolve();
        };
        const onError = (err: Error) => {
            timers.clearTimeout(timeout);
            tlsSocket.off('secureConnect', onConnect);
            reject(err);
        };
        tlsSocket.once('secureConnect', onConnect);
        tlsSocket.once('error', onError);
    });

    return tlsSocket;
}

function removeAbortHandler(request: ClientRequestState): void {
    if (request._abortHandler && request._options.signal) {
        request._options.signal.removeEventListener('abort', request._abortHandler);
        request._abortHandler = null;
    }
}

export function releaseRequestTransport<TRequest extends ClientRequestState>(request: TRequest): void {
    if (request._timeoutId) {
        timers.clearTimeout(request._timeoutId);
        request._timeoutId = null;
    }
    removeAbortHandler(request);
    request._transportCleanup?.();
    request._transport = null;
    request._connectPromise = null;
}

function findHeaderEnd(data: Uint8Array): number {
    for (let i = 3; i < data.byteLength; i++) {
        if (data[i - 3] === 13 && data[i - 2] === 10 && data[i - 1] === 13 && data[i] === 10) {
            return i + 1;
        }
    }
    return -1;
}

function writeToTransport(transport: ClientTransport, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        transport.write(data, (err?: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function assignRequestTransport<TRequest extends ClientRequestState>(request: TRequest, transport: RequestTransport<TRequest>, hooks: ClientHooks<TRequest>): void {
    request._transport = transport;
    request.socket = transport;
    hooks.onTransportAssigned?.(request, transport);
}

function waitForSecureConnectIfNeeded(transport: ClientTransport, hooks: ClientHooks): Promise<void> {
    if (!hooks.waitForSecureConnect) return Promise.resolve();
    const secure = transport as MaybeSecureTransport;
    if (secure.encrypted !== true || secure._handshakeComplete === true) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            secure.off('secureConnect', onSecure);
            secure.off('error', onError);
        };
        const onSecure = () => {
            cleanup();
            resolve();
        };
        const onError = (error: unknown) => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        secure.once('secureConnect', onSecure);
        secure.once('error', onError);
    });
}

function applyConnectedRequestOptions<TRequest extends ClientRequestState>(request: TRequest, hooks: ClientHooks<TRequest>): void {
    const port = resolvePort(request._options.port, hooks.defaultPort);
    const setDefaultHeaders = request._options.setDefaultHeaders !== false;
    const setHost = request._options.setHost !== false;

    if (setHost && !request.hasHeader('host')) {
        request.setHeader('Host', port === 80 || port === 443 ? request.host : `${request.host}:${port}`);
    }
    if (request._options.auth && !request.hasHeader('authorization')) {
        request.setHeader('Authorization', `Basic ${btoa(request._options.auth)}`);
    }
    // Node does not inject User-Agent / Accept-Encoding / Connection: close.
    // Connection: keep-alive is set by ClientRequest when agent.keepAlive is on.
    if (hooks.defaultUserAgent && setDefaultHeaders && !request.hasHeader('user-agent')) {
        request.setHeader('User-Agent', hooks.defaultUserAgent);
    }
    if (hooks.defaultAcceptEncoding && setDefaultHeaders && !request.hasHeader('accept-encoding')) {
        request.setHeader('Accept-Encoding', hooks.defaultAcceptEncoding);
    }
}

export function connectRequest<TRequest extends ClientRequestState>(request: TRequest, hooks: ClientHooks<TRequest>): Promise<void> {
    if (request._connectPromise) return request._connectPromise;
    request._connectPromise = (async () => {
        request._requestId = request._requestId || nextNodeRequestId(hooks.requestIdPrefix);

        const transport = await hooks.connect(request);
        if (request._aborted) {
            destroyTransportQuietly(transport);
            throw new Error('Request aborted');
        }

        assignRequestTransport(request, transport, hooks);
        request.emit('socket', request.socket);
        applyConnectedRequestOptions(request, hooks);
    })();
    return request._connectPromise;
}

export function connectRequestWithAgent<TRequest extends ClientRequestState>(request: TRequest, hooks: ClientHooks<TRequest>, agent: AgentLike<TRequest>): Promise<void> {
    if (request._connectPromise) return request._connectPromise;
    request._connectPromise = (async () => {
        request._requestId = request._requestId || nextNodeRequestId(hooks.requestIdPrefix);
        applyConnectedRequestOptions(request, hooks);
        const agentOptions = {
            ...request._options,
            host: request._options.host ?? request.host,
            hostname: request._options.hostname ?? request.host,
        };
        const transport = await new Promise<RequestTransport<TRequest>>((resolve, reject) => {
            const onSocket = (socket: RequestTransport<TRequest>) => {
                // @ts-ignore - args cast
                request.off('error', onError);
                if (!request._transport) assignRequestTransport(request, socket, hooks);
                resolve(request._transport || socket);
            };
            const onError = (error: Error) => {
                // @ts-ignore - args cast
                request.off('socket', onSocket);
                reject(error);
            };
            // @ts-ignore - args cast
            request.once('socket', onSocket);
            // @ts-ignore - args cast
            request.once('error', onError);
            try {
                agent.addRequest(request, agentOptions);
            } catch (error) {
                // @ts-ignore - args cast
                request.off('socket', onSocket);
                // @ts-ignore - args cast
                request.off('error', onError);
                reject(error);
            }
        });
        if (request._aborted) {
            destroyTransportQuietly(transport);
            throw new Error('Request aborted');
        }
        await waitForSecureConnectIfNeeded(transport, hooks);
    })();
    return request._connectPromise;
}

export function ensureRequestConnected<TRequest extends ClientRequestState>(request: TRequest, hooks: ClientHooks<TRequest>): Promise<void> {
    const agent = (request as TRequest & { agent?: unknown }).agent;
    if (agent && typeof agent === 'object' && typeof (agent as AgentLike<TRequest>).addRequest === 'function') {
        return connectRequestWithAgent(request, hooks, agent as AgentLike<TRequest>);
    }
    return connectRequest(request, hooks);
}

export async function sendRequestLine<TRequest extends ClientRequestState>(request: TRequest): Promise<void> {
    const transport = request._transport;
    if (!transport) return;
    const fetchHook = getNodeFetchHook();

    try {
        fetchHook?.onRequest?.({
            requestId: request._requestId,
            timestamp: nodeTs(),
            url: buildNodeUrl(request.protocol, request.host, request.path),
            method: request.method,
            headers: normalizeHeaderRecord(request.getHeaders()),
            postData: undefined,
            callFrames: request._requestCallFrames,
            resourceType: 'Fetch',
        });
    } catch {}

    // Same pure head framing as HttpRequestBuilder / HTTPS implicit header.
    await writeToTransport(
        transport,
        engine.encodeString(formatClientRequestHeader(request)),
    );
    request.headersSent = true;
}

/** Node `_header` string: request-line + formatted headers + blank line. */
export function formatClientRequestHeader<TRequest extends ClientRequestState>(request: TRequest): string {
    // Node injects Connection on the wire without exposing it via getHeader().
    let extra = '';
    if (!request.hasHeader('connection')) {
        const agent = (request as TRequest & { agent?: unknown; shouldKeepAlive?: boolean }).agent;
        const keepAlive = !!(
            agent &&
            typeof agent === 'object' &&
            (agent as { options?: { keepAlive?: boolean } }).options?.keepAlive
        );
        const flag = (request as TRequest & { shouldKeepAlive?: boolean }).shouldKeepAlive;
        const useKeepAlive = flag !== undefined ? flag : keepAlive;
        extra = `Connection: ${useKeepAlive ? 'keep-alive' : 'close'}\r\n`;
    }
    return formatRequestHead(request.method, request.path, '1.1', request._formatHeaders() + extra);
}

export function markRequestFinished<TRequest extends ClientRequestState>(request: TRequest): void {
    if (request.writableFinished) return;
    request.writableEnded = true;
    request.writableFinished = true;
    request.finished = true;
    request.emit('finish');
}

export async function doBufferedRequest<TRequest extends ClientRequestState>(request: TRequest, hooks: ClientHooks<TRequest>): Promise<void> {
    const fetchHook = getNodeFetchHook();
    try {
        await ensureRequestConnected(request, hooks);
        if (!request._transport) return;

        const requestBody = Buffer.concat(request._requestBody);
        const bodyLength = request._requestBody.reduce((sum, chunk) => sum + chunk.length, 0);

        if (request.hasHeader('transfer-encoding') && String(request.getHeader('transfer-encoding')).toLowerCase().includes('chunked')) {
            await sendRequestLine(request);
            if (bodyLength > 0) {
                await writeToTransport(request._transport, encodeChunkedFrame(requestBody as Uint8Array));
            }
            await writeToTransport(request._transport, CHUNKED_TRAILER);
            request._bodySent = true;
            markRequestFinished(request);
            readResponse(request);
            return;
        }

        if (
            !request.hasHeader('content-length') &&
            !request.hasHeader('transfer-encoding') &&
            (bodyLength > 0 || shouldSendZeroContentLength(request.method))
        ) {
            request.setHeader('Content-Length', bodyLength);
        }

        await sendRequestLine(request);
        for (const chunk of request._requestBody) {
            await writeToTransport(request._transport, chunk);
        }
        request._bodySent = true;
        markRequestFinished(request);
        readResponse(request);
    } catch (err) {
        const normalized = normalizeErrnoError(err);
        try {
            fetchHook?.onFinished?.({
                requestId: request._requestId,
                timestamp: nodeTs(),
                success: false,
                errorText: String(normalized.message ?? normalized),
            });
        } catch {}
        if (!request._aborted) request.emit('error', normalized);
    }
}

export async function streamChunk<TRequest extends ClientRequestState>(request: TRequest, data: Uint8Array, hooks: ClientHooks<TRequest>): Promise<void> {
    if (request._streamErrored) return;
    if (!request._headerFlushStarted) {
        request._headerFlushStarted = true;
        request._chunkedEncoding = !request.hasHeader('content-length') && !request.hasHeader('transfer-encoding');
        if (request._chunkedEncoding && !request.hasHeader('transfer-encoding')) {
            request.setHeader('Transfer-Encoding', 'chunked');
        }
        await ensureRequestConnected(request, hooks);
        if (!request._transport) return;
        await sendRequestLine(request);
    }

    if (!request._transport) return;
    if (request._chunkedEncoding) {
        await writeToTransport(request._transport, encodeChunkedFrame(data));
        return;
    }
    await writeToTransport(request._transport, data);
}

export async function finishStreaming<TRequest extends ClientRequestState>(request: TRequest, hooks: ClientHooks<TRequest>): Promise<void> {
    if (!request._headerFlushStarted) {
        request._headerFlushStarted = true;
        request._chunkedEncoding = !request.hasHeader('content-length') && !request.hasHeader('transfer-encoding');
        if (request._chunkedEncoding && !request.hasHeader('transfer-encoding')) {
            request.setHeader('Transfer-Encoding', 'chunked');
        }
        await ensureRequestConnected(request, hooks);
        if (!request._transport) return;
        await sendRequestLine(request);
    }
    if (request._transport && request._chunkedEncoding) {
        await writeToTransport(request._transport, CHUNKED_TRAILER);
    }
    request._bodySent = true;
    markRequestFinished(request);
    readResponse(request);
}

/**
 * Connect and write the request head *now*, without waiting for `end()`.
 *
 * Two callers need this:
 *  - `req.flushHeaders()`, which in cno only flipped `headersSent` and never
 *    touched the socket.
 *  - `Expect: 100-continue`, where the whole point is that the server sees the
 *    head and answers 100 *before* the body is produced. cno deferred every
 *    byte until `end()`, so the documented flow — wait for 'continue', then
 *    `end(body)` — deadlocked: the client waited for 100, the server waited for
 *    a request. OBSERVED as TIMEBOX with no bytes on the wire at all
 *    (/d/tmp/ag-http/p15-continue.js CASE-A and CASE-B) against node's
 *    ["continue","info:100","res:200:OK"].
 *
 * Framing is decided here because the head is about to be committed: an
 * explicit Content-Length is honoured, otherwise chunked, matching what
 * streamChunk would have chosen. The response reader is started too, since the
 * 1xx cannot be observed without a parser attached.
 */
export async function flushRequestHeaders<TRequest extends ClientRequestState>(request: TRequest, hooks: ClientHooks<TRequest>): Promise<void> {
    if (request._headerFlushStarted) return;
    request._headerFlushStarted = true;
    request._chunkedEncoding = !request.hasHeader('content-length') && !request.hasHeader('transfer-encoding');
    if (request._chunkedEncoding) request.setHeader('Transfer-Encoding', 'chunked');
    await ensureRequestConnected(request, hooks);
    if (!request._transport) return;
    await sendRequestLine(request);
    readResponse(request);
}

/** True when the caller asked for the 100-continue handshake. */
export function expectsContinue(request: ClientRequestState): boolean {
    return String(request.getHeader('expect') ?? '').toLowerCase().includes('100-continue');
}

/**
 * Kick off the early head flush for Expect: 100-continue, reporting a failure
 * the same way the normal send path does. Called from the ClientRequest
 * constructor, so it must never throw synchronously into user code.
 */
export function startContinueHandshake<TRequest extends ClientRequestState>(request: TRequest, hooks: ClientHooks<TRequest>): void {
    request._sendChain = request._sendChain
        .then(() => flushRequestHeaders(request, hooks))
        .catch((err) => {
            if (!request._streamErrored && !request._aborted) {
                request._streamErrored = true;
                request.emit('error', normalizeErrnoError(err));
            }
        });
}

export function readResponse<TRequest extends ClientRequestState>(request: TRequest): void {
    if (!request._transport) return;
    // With Expect: 100-continue the reader is started right after the head is
    // flushed, long before the body goes out, so the later finishStreaming /
    // doBufferedRequest call must not attach a second parser to the same socket.
    if (request._responseReaderStarted) return;
    request._responseReaderStarted = true;
    const res = new IncomingMessageImpl(request.socket);
    const isConnect = request.method === 'CONNECT';
    let connectResponse: IncomingMessageImpl | null = null;
    let upgradeResponse: IncomingMessageImpl | null = null;
    const { parser, finish } = setupResponseParser<IncomingMessageImpl>({
        requestId: request._requestId,
        protocol: request.protocol,
        host: request.host,
        path: request.path,
        res,
        getHeaders: () => request.getHeaders(),
        onResponse: (response) => {
            (request as TRequest & { _response?: IncomingMessageImpl | null })._response = response;
            // Node sets `req.res` before invoking the response callback. got's
            // close-handler guard (core/index.js:1198 `Boolean(request.res)`) reads
            // it to tell "closed after a response" from "closed with none"; leaving
            // it unset made every completed request raise a bogus
            // ReadError/ECONNRESET "The server aborted pending request".
            request.res = response;
            request.emit('response', response);
            if (request._callback) request._callback(response);
        },
        onInformation: (info) => {
            // Node's order is 'continue' first, then 'information' (OBSERVED
            // p15-continue CASE-A: ["continue","info:100",...]).
            if (info.statusCode === 100) request.emit('continue');
            request.emit('information', info);
        },
        onConnect: (response) => {
            connectResponse = response;
        },
        onUpgrade: (response) => {
            upgradeResponse = response;
        },
        onComplete: () => request._cleanup(),
        connectMode: isConnect,
        skipBody: request.method === 'HEAD',
    });

    let pending: Uint8Array | null = null;
    let failed = false;
    const transport = request._transport;
    const formatParseError = (
        result: Pick<CModuleHTTP.ParserExecuteResult, 'name' | 'reason'> | undefined,
        fallback: string,
    ): string => {
        const detail = result?.reason ?? result?.name;
        return detail ? `${fallback}: ${detail}` : fallback;
    };
    const failResponse = (message: string, error?: Error) => {
        if (failed) return;
        failed = true;
        const normalized = normalizeErrnoError(error ?? Object.assign(new Error(message), { code: 'ECONNRESET' }), 'read');
        if (!res.complete) {
            res.aborted = true;
            emitAbortedQuietly(res);
            // Only fail the response with the error once the caller has actually
            // received it. If the fault happened before 'response' was emitted
            // (a refused handshake, for instance) nobody can have attached an
            // 'error' listener, so res.destroy(err) re-raised it asynchronously
            // as an uncaught exception *after* the request had already reported
            // the same error. The request below is the correct — and only —
            // place to report it.
            const delivered = !!(request as TRequest & { _response?: IncomingMessageImpl | null })._response;
            if (delivered) res.destroy(normalized);
            else res.destroy();
        }
        if (!request._aborted) request.emit('error', normalized);
        finish(false, String(normalized.message ?? normalized));
        request._cleanup();
    };
    const emitConnect = (head: Uint8Array) => {
        if (failed) return;
        failed = true;
        releaseRequestTransport(request);
        finish(true);
        const socket = transport;
        const handled = request.emit('connect', connectResponse ?? res, socket, Buffer.from(head));
        if (!handled) {
            destroyTransportQuietly(socket);
        }
    };
    const emitUpgrade = (head: Uint8Array) => {
        if (failed) return;
        failed = true;
        releaseRequestTransport(request);
        finish(true);
        const socket = transport;
        const headBuffer = Buffer.from(head);
        queueMicrotask(() => {
            const handled = request.emit('upgrade', upgradeResponse ?? res, socket, headBuffer);
            if (!handled) {
                destroyTransportQuietly(socket);
            }
        });
    };

    const onData = (chunk: Uint8Array) => {
        let toParse = chunk;
        if (pending) {
            const combined = arrayBufferBackedBytes(algorithm.bytesConcat([pending, chunk]));
            pending = null;
            toParse = combined;
        }
        if (isConnect) {
            const headerEnd = findHeaderEnd(toParse);
            if (headerEnd === -1) {
                pending = new Uint8Array(toParse);
                return;
            }
            const head = new Uint8Array(toParse.subarray(headerEnd));
            const headerBytes = toParse.subarray(0, headerEnd);
            const headerBuffer = headerBytes.buffer instanceof SharedArrayBuffer
                ? new Uint8Array(headerBytes).buffer
                : headerBytes.buffer;
            const result = parser.execute(headerBuffer.slice(headerBytes.byteOffset, headerBytes.byteOffset + headerBytes.byteLength));
            if (result.errno !== 0) {
                failResponse(formatParseError(result, 'HTTP parse error'));
                return;
            }
            emitConnect(head);
            return;
        }
        const buffer = toParse.buffer instanceof SharedArrayBuffer
            ? new Uint8Array(toParse).buffer
            : toParse.buffer;
        const result = parser.execute(buffer.slice(toParse.byteOffset, toParse.byteOffset + toParse.byteLength));
        const consumed = result.bytesConsumed;
        if (result.name === 'HPE_PAUSED_UPGRADE') {
            const head = consumed !== undefined && consumed < toParse.byteLength
                ? new Uint8Array(toParse.subarray(consumed))
                : new Uint8Array(0);
            emitUpgrade(head);
            return;
        }
        if (result.errno !== 0) {
            failResponse(formatParseError(result, 'HTTP parse error'));
            return;
        }
        if (consumed !== undefined && consumed < toParse.byteLength) {
            pending = new Uint8Array(toParse.subarray(consumed));
        }
    };
    const finishAtEof = () => {
        if (!res.complete) {
            const result = parser.finish();
            if (result.errno !== 0) {
                failResponse(formatParseError(result, 'HTTP parse error'));
                return;
            }
        }
        if (!res.complete) {
            failResponse('socket hang up');
            return;
        }
        request._cleanup();
    };
    const onEnd = () => {
        finishAtEof();
    };
    const onClose = () => {
        finishAtEof();
    };
    const onError = (err: Error) => {
        failResponse(err.message, err);
    };

    request._transportCleanup = () => {
        transport.off('data', onData);
        transport.off('end', onEnd);
        transport.off('close', onClose);
        transport.off('error', onError);
        request._transportCleanup = null;
    };

    transport.on('data', onData);
    transport.on('end', onEnd);
    transport.on('close', onClose);
    transport.on('error', onError);
}

export function writeRequest<TRequest extends ClientRequestState>(request: TRequest, chunk: unknown, encodingOrCb?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void, hooks?: ClientHooks<TRequest>): boolean {
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    if (!hooks) throw new Error('Client hooks are required to write request data');
    if (request.writableEnded || request._bodySent) {
        const err = Object.assign(new Error(request.writableEnded ? 'write after end' : 'Request body already sent'), {
            code: request.writableEnded ? 'ERR_STREAM_WRITE_AFTER_END' : 'ERR_HTTP_REQUEST_BODY_SENT',
        });
        callback?.(err);
        queueMicrotask(() => request.emit('error', err));
        return false;
    }

    const data = encodeRequestChunk(chunk, encoding);
    request._streamedBeforeEnd = true;
    request._sendChain = request._sendChain
        .then(() => streamChunk(request, data, hooks))
        .then(() => callback?.(), (err) => {
            if (!request._streamErrored && !request._aborted) {
                request._streamErrored = true;
                request.emit('error', normalizeErrnoError(err));
            }
            callback?.(normalizeErrnoError(err));
        });

    return true;
}

export function endRequest<TRequest extends ClientRequestState>(request: TRequest, chunk: unknown, encodingOrCb: BufferEncoding | (() => void) | undefined, cb: (() => void) | undefined, hooks: ClientHooks<TRequest>): TRequest {
    let callback: (() => void) | undefined;
    let finalChunk = chunk;
    if (typeof finalChunk === 'function') {
        callback = finalChunk as () => void;
        finalChunk = undefined;
    } else if (typeof encodingOrCb === 'function') {
        callback = encodingOrCb;
    } else if (typeof cb === 'function') {
        callback = cb;
    }

    if (request.writableEnded) {
        callback?.();
        return request;
    }

    // A pre-flushed head (flushHeaders() or Expect: 100-continue) means the
    // buffered path can no longer own the framing — it would re-send the head
    // and re-add Content-Length. The streaming path already keys off
    // `_headerFlushStarted`, so route through it instead.
    if (request._streamedBeforeEnd || request._headerFlushStarted) {
        if (finalChunk !== undefined) {
            const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
            const data = encodeRequestChunk(finalChunk, encoding);
            request._sendChain = request._sendChain.then(() => streamChunk(request, data, hooks));
        }
        request.writableEnded = true;
        request._sendChain = request._sendChain.then(() => finishStreaming(request, hooks)).then(() => {
            markRequestFinished(request);
            callback?.();
        }, (err) => {
            if (!request._streamErrored && !request._aborted) {
                request._streamErrored = true;
                request.emit('error', normalizeErrnoError(err));
            }
            callback?.();
        });
        return request;
    }

    if (finalChunk !== undefined) {
        const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
        request._requestBody.push(encodeRequestChunk(finalChunk, encoding));
    }

    request.writableEnded = true;
    doBufferedRequest(request, hooks).then(() => callback?.()).catch((err) => {
        if (!request._aborted) request.emit('error', normalizeErrnoError(err));
        callback?.();
    });
    return request;
}

export function abortRequest<TRequest extends ClientRequestState>(request: TRequest): void {
    if (request._aborted) return;
    request._aborted = true;
    request.aborted = true;
    request.emit('abort');
    const inFlight = request.headersSent && !isResponseComplete(request);
    cleanupRequest(request);
    request.destroyed = true;
    // Node's legacy abort() tears the socket down under an in-flight request, so
    // the caller sees ECONNRESET then 'close'. cno emitted neither, so
    // `req.on('error')` never fired and 'close' never arrived (p3 S3).
    if (inFlight) request.emit('error', socketResetError());
    emitRequestClose(request);
}

export function destroyRequest<TRequest extends ClientRequestState>(request: TRequest, error?: Error): TRequest {
    if (request.destroyed) {
        if (error) request.emit('error', normalizeErrnoError(error));
        return request;
    }
    const inFlight = request.headersSent && !isResponseComplete(request);
    cleanupRequest(request);
    request.destroyed = true;
    if (error) request.emit('error', normalizeErrnoError(error));
    else if (inFlight && !request._aborted) request.emit('error', socketResetError());
    emitRequestClose(request);
    return request;
}

function socketResetError(): Error {
    return normalizeErrnoError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'read');
}

function isResponseComplete(request: ClientRequestState): boolean {
    const response = (request as ClientRequestState & { _response?: IncomingMessageImpl | null })._response;
    return !!response?.complete;
}

export function cleanupRequest<TRequest extends ClientRequestState>(request: TRequest): void {
    if (request._timeoutId) {
        timers.clearTimeout(request._timeoutId);
        request._timeoutId = null;
    }
    removeAbortHandler(request);
    request._transportCleanup?.();
    if (request._transport) {
        destroyTransportQuietly(request._transport);
        request._transport = null;
    }
    request._connectPromise = null;
    // Deferred so the caller's own 'error'/'end' handlers, and the explicit
    // emitRequestClose() in destroyRequest/abortRequest, all land first;
    // emitRequestClose is idempotent so whichever runs first wins.
    queueMicrotask(() => emitRequestClose(request));
}

export function setRequestTimeout<TRequest extends ClientRequestState>(request: TRequest, timeout: number, callback?: () => void): TRequest {
    if (request._timeoutId) timers.clearTimeout(request._timeoutId);
    request._timeoutId = timers.setTimeout(() => {
        request._timeoutId = null;
        request.emit('timeout');
    }, timeout);
    if (callback) request.once('timeout', callback);
    return request;
}
