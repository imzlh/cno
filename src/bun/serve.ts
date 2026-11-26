/** Bun server semantics over the host HTTP and WebSocket primitives. */

import { compileRoutes, type BunServeRoutes, type CompiledRoutes } from './serve-routes';
import {
    BunWebSocketServer,
    parseWebSocketHandler,
    type BunWebSocketData,
    type BunWebSocketHandler,
    type BunWebSocketUpgradeOptions,
    type HostWebSocketUpgrade,
} from './serve-websocket';
export type { BunServeHttpMethod, BunServeRoute, BunServeRoutes } from './serve-routes';
export type { BunServerWebSocket, BunWebSocketBinaryType, BunWebSocketData, BunWebSocketHandler, BunWebSocketUpgradeOptions } from './serve-websocket';

export interface BunServeTlsConfig {
    cert?: string;
    key?: string;
    caCerts?: string[];
    alpnProtocols?: string[];
    servername?: string;
}

type ServeTlsNormalizer = (input: unknown, role: 'server') => BunServeTlsConfig | undefined;
let serveTlsNormalizer: ServeTlsNormalizer | undefined;

export function installServeTlsNormalizer(normalizer: ServeTlsNormalizer): void {
    serveTlsNormalizer = normalizer;
}

export interface BunServeServer<T = unknown> {
    readonly port: number;
    readonly hostname: string;
    readonly url: URL;
    readonly pendingRequests: number;
    readonly pendingWebSockets: number;
    requestIP(request: Request): import('bun').SocketAddress | null;
    ref(): BunServeServer<T>;
    unref(): BunServeServer<T>;
    upgrade(request: Request, options?: BunWebSocketUpgradeOptions<T>): boolean;
    publish(topic: string, data: BunWebSocketData, compress?: boolean): number;
    subscriberCount(topic: string): number;
    /** Graceful shutdown; force-close is intentionally unsupported. */
    stop(closeActiveConnections?: boolean): Promise<void>;
    /** Replace request/error handlers and route tables without rebinding the listener. */
    reload(options: BunServeReloadOptions<T>): BunServeServer<T>;
}

export type BunServeHandler<T = unknown> = (
    this: BunServeServer<T>,
    request: Request,
    server: BunServeServer<T>,
) => Response | void | Promise<Response | void>;

export type BunServeOptions<T = unknown> = {
    error?: (this: BunServeServer<T>, error: unknown) => Response | Promise<Response>;
    port?: number | string;
    hostname?: string;
    websocket?: BunWebSocketHandler<T>;
    tls?: import('bun').TLSOptions | boolean | null;
} & ({ fetch: BunServeHandler<T>; routes?: BunServeRoutes<T> } | { fetch?: BunServeHandler<T>; routes: BunServeRoutes<T> });

/** The handler subset accepted by server.reload(). */
export interface BunServeReloadOptions<T = unknown> {
    fetch?: BunServeHandler<T>;
    routes?: BunServeRoutes<T>;
    error?: (this: BunServeServer<T>, error: unknown) => Response | Promise<Response>;
    // Bun accepts these on reload but leaves the existing listener unchanged.
    port?: number | string;
    hostname?: string;
    websocket?: BunWebSocketHandler<T>;
    tls?: import('bun').TLSOptions | boolean | null;
}

interface HostAddress {
    port: number;
    transport?: string;
}

interface HostHttpServer {
    readonly addr: HostAddress;
    ref(): void;
    unref(): void;
    shutdown(): Promise<void>;
}

interface HostRequestInfo {
    remoteAddr: { transport: 'tcp'; hostname: string; port: number } | { transport: 'unix'; path: string };
    completed: Promise<void>;
}

interface HostServeOptions {
    port: number;
    hostname: string;
    onError?: (error: unknown) => Response | Promise<Response> | undefined;
    cert?: string;
    key?: string;
}

interface HostDeno {
    upgradeWebSocket?: HostWebSocketUpgrade;
    serve(
        options: HostServeOptions,
        handler: (request: Request, info: HostRequestInfo) => Response | Promise<Response>,
    ): HostHttpServer;
}

interface ParsedOptions {
    fetch?: BunServeHandler;
    routes?: CompiledRoutes;
    error?: (error: unknown) => Response | Promise<Response>;
    port: number;
    hostname: string;
    websocket?: BunWebSocketHandler;
    tls?: BunServeTlsConfig;
}

interface ParsedReloadOptions {
    fetch?: BunServeHandler;
    routes?: CompiledRoutes;
    error?: (error: unknown) => Response | Promise<Response>;
    websocket?: BunWebSocketHandler;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = 'localhost';
const DEFAULT_BIND_HOSTNAME = '127.0.0.1';
const SUPPORTED_OPTIONS = new Set(['fetch', 'routes', 'error', 'port', 'hostname', 'websocket', 'tls']);
const requestAddresses = new WeakMap<Request, HostRequestInfo['remoteAddr']>();

const UNSUPPORTED_OPTION_DETAILS = new Map<string, string>([
    ['development', 'development/hot-reload mode is not supported.'],
    ['reload', 'hot-reload options are not supported.'],
    ['hotReload', 'hot-reload options are not supported.'],
    ['unix', 'Unix-socket serving is not part of the TCP HTTP subset.'],
    ['reusePort', 'socket reuse options are not supported by this adapter.'],
    ['idleTimeout', 'idle-timeout configuration is not exposed by this adapter.'],
    ['maxRequestBodySize', 'request body limits are not exposed by this adapter.'],
]);

function unsupportedOption(name: string): TypeError {
    const detail = UNSUPPORTED_OPTION_DETAILS.get(name)
        ?? 'This subset supports fetch, routes, error, port, hostname, and websocket.';
    return new TypeError(`Bun.serve: unsupported option "${name}". ${detail}`);
}

function parsePort(value: unknown): number {
    if (value === undefined) return DEFAULT_PORT;

    let port: number;
    if (typeof value === 'number') {
        port = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        port = Number(value.trim());
    } else {
        throw new TypeError('Bun.serve: port must be a numeric TCP port.');
    }

    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new RangeError('Bun.serve: port must be an integer from 0 through 65535.');
    }
    return port;
}

function parseOptions(value: unknown): ParsedOptions {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Bun.serve: options must be an object.');
    }

    const options = value as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(options)) {
        if (typeof key !== 'string' || !SUPPORTED_OPTIONS.has(key)) {
            throw unsupportedOption(String(key));
        }
    }

    const fetch = options.fetch;
    const routes = options.routes;
    if (fetch !== undefined && typeof fetch !== 'function') {
        throw new TypeError('Bun.serve: fetch must be a function.');
    }
    if (fetch === undefined && routes === undefined) {
        throw new TypeError('Bun.serve: a fetch handler or routes table is required.');
    }

    const hostname = options.hostname === undefined ? DEFAULT_HOSTNAME : options.hostname;
    if (typeof hostname !== 'string' || hostname.length === 0) {
        throw new TypeError('Bun.serve: hostname must be a non-empty string.');
    }

    const error = options.error;
    if (error !== undefined && typeof error !== 'function') {
        throw new TypeError('Bun.serve: error must be a function.');
    }

    const port = parsePort(options.port);
    serverUrl(hostname, port);
    let compiledRoutes: CompiledRoutes | undefined;
    try {
        compiledRoutes = routes === undefined ? undefined : compileRoutes(routes);
        return {
            fetch: fetch as ParsedOptions['fetch'],
            error: error as ParsedOptions['error'],
            routes: compiledRoutes,
            port,
            hostname,
            websocket: parseWebSocketHandler(options.websocket),
            tls: parseServeTls(options.tls),
        };
    } catch (error) {
        compiledRoutes?.dispose();
        throw error;
    }
}

function parseServeTls(value: unknown): BunServeTlsConfig | undefined {
    if (value === undefined || value === false || value === null) return undefined;
    if (Array.isArray(value)) throw new TypeError('Bun.serve: TLS identity arrays are unsupported by this host.');
    if (!serveTlsNormalizer) throw new Error('Bun.serve TLS support is not initialized.');
    const config = serveTlsNormalizer(value, 'server');
    if (config?.caCerts !== undefined || config?.alpnProtocols !== undefined) {
        throw new TypeError('Bun.serve: custom CA and ALPN TLS options are unsupported by the host server.');
    }
    return config;
}

function parseReloadOptions(value: unknown, stopped: boolean): ParsedReloadOptions {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Bun.serve: reload options must be an object.');
    }

    const options = value as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(options)) {
        if (typeof key !== 'string' || !SUPPORTED_OPTIONS.has(key)) {
            throw unsupportedOption(String(key));
        }
    }

    const fetch = options.fetch;
    if (fetch != null && typeof fetch !== 'function') {
        throw new TypeError('Bun.serve: reload fetch must be a function.');
    }
    const error = options.error;
    if (error != null && typeof error !== 'function') {
        throw new TypeError('Bun.serve: reload error must be a function.');
    }
    // Bun validates a supplied port even though reload never rebinds it.
    const port = options.port;
    if (port !== undefined) validateReloadPort(port);
    const routes = options.routes;
    if (stopped && routes !== undefined) {
        throw new TypeError('Bun.serve: cannot replace routes on a stopped server.');
    }
    let compiledRoutes: CompiledRoutes | undefined;
    try {
        compiledRoutes = routes === undefined ? undefined : compileRoutes(routes);
        parseServeTls(options.tls);
        return {
            fetch: fetch == null ? undefined : fetch as BunServeHandler,
            error: error == null ? undefined : error as ParsedReloadOptions['error'],
            routes: compiledRoutes,
            websocket: parseWebSocketHandler(options.websocket),
        };
    } catch (error) {
        compiledRoutes?.dispose();
        throw error;
    }
}

function validateReloadPort(value: unknown): void {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw Object.assign(
            new RangeError('Bun.serve: reload port must coerce to an integer from 0 through 65535.'),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }
}

function hostRuntime(): HostDeno {
    const runtime = (globalThis as unknown as { Deno?: Partial<HostDeno> }).Deno;
    if (!runtime || typeof runtime.serve !== 'function') {
        throw new Error('Bun.serve requires the host Deno.serve primitive.');
    }
    return runtime as HostDeno;
}

function serverUrl(hostname: string, port: number, secure = false): URL {
    const authorityHost = hostname.includes(':') && !hostname.startsWith('[')
        ? `[${hostname}]`
        : hostname;
    return new URL(`${secure ? 'https' : 'http'}://${authorityHost}:${port}/`);
}

function shutdownQuietly(server: HostHttpServer | undefined): void {
    if (!server || typeof server.shutdown !== 'function') return;
    try {
        void Promise.resolve(server.shutdown()).catch(() => {
            // Preserve the startup error when cleanup also fails.
        });
    } catch {
        // Preserve the startup error when cleanup also fails.
    }
}

function defineRequestParams(request: Request, params: Record<string, string>): void {
    // Bun's BunRequest exposes params on every route-dispatched request, empty
    // for exact and wildcard routes. Defined non-enumerably to keep Request
    // itself the same observable object the host handed over.
    Object.defineProperty(request, 'params', {
        value: params,
        writable: false,
        enumerable: false,
        configurable: true,
    });
}

class BunServeServerImpl implements BunServeServer {
    private hostServer: HostHttpServer | undefined;
    private stopPromise: Promise<void> | undefined;
    private currentPort: number;
    private currentUrl: URL;
    private fetchHandler: BunServeHandler | undefined;
    private errorHandler: ((error: unknown) => Response | Promise<Response>) | undefined;
    private routes: CompiledRoutes | undefined;
    private websockets: BunWebSocketServer | undefined;
    private activeRequests = 0;

    constructor(
        private readonly configuredHostname: string,
        requestedPort: number,
        fetchHandler: BunServeHandler | undefined,
        errorHandler: ((error: unknown) => Response | Promise<Response>) | undefined,
        routes: CompiledRoutes | undefined,
        websocketHandlers?: BunWebSocketHandler,
        private readonly upgradeWebSocket?: HostWebSocketUpgrade,
        private readonly secure = false,
    ) {
        this.currentPort = requestedPort;
        this.currentUrl = serverUrl(configuredHostname, requestedPort, secure);
        this.fetchHandler = fetchHandler;
        this.errorHandler = errorHandler;
        this.routes = routes;
        if (websocketHandlers) {
            if (!upgradeWebSocket) throw new Error('Bun.serve: the host does not support WebSocket upgrades.');
            this.websockets = new BunWebSocketServer(websocketHandlers, upgradeWebSocket);
        }
    }

    get port(): number {
        return this.currentPort;
    }

    get hostname(): string {
        return this.configuredHostname;
    }

    get url(): URL {
        return this.currentUrl;
    }

    get pendingWebSockets(): number {
        return this.websockets?.pendingWebSockets ?? 0;
    }

    get pendingRequests(): number {
        return this.activeRequests;
    }

    requestIP(request: Request): import('bun').SocketAddress | null {
        if (!(request instanceof Request)) throw new TypeError('Expected Request object');
        const address = requestAddresses.get(request);
        if (address?.transport !== 'tcp' || request.signal.aborted) return null;
        return {
            address: address.hostname,
            family: address.hostname.includes(':') ? 'IPv6' : 'IPv4',
            port: address.port,
        };
    }

    ref(): this {
        if (!this.stopPromise) this.hostServer?.ref();
        return this;
    }

    unref(): this {
        if (!this.stopPromise) this.hostServer?.unref();
        return this;
    }

    upgrade(request: Request, options?: BunWebSocketUpgradeOptions): boolean {
        const upgraded = this.websockets?.upgrade(request, options) ?? false;
        if (upgraded) requestAddresses.delete(request);
        return upgraded;
    }

    publish(topic: string, data: BunWebSocketData, _compress?: boolean): number {
        return this.websockets?.publish(topic, data) ?? 0;
    }

    subscriberCount(topic: string): number {
        return this.websockets?.subscriberCount(topic) ?? 0;
    }

    handleFetch(request: Request, info?: HostRequestInfo): Response | Promise<Response> {
        if (info) {
            this.activeRequests++;
            requestAddresses.set(request, info.remoteAddr);
            const complete = () => {
                requestAddresses.delete(request);
                this.activeRequests--;
            };
            void info.completed.then(complete, complete);
        }
        if (this.websockets) {
            return this.websockets.handleRequest(request, () => this.dispatchRequest(request), error => this.handleError(error));
        }
        return this.dispatchRequest(request) as Response | Promise<Response>;
    }

    private dispatchRequest(request: Request): Response | void | Promise<Response | void> {
        const matched = this.routes?.resolve(request);
        if (matched) {
            defineRequestParams(request, matched.params);
            return matched.handler.call(this, request, this);
        }
        const handler = this.fetchHandler;
        return handler ? handler.call(this, request, this) : new Response('Not Found', { status: 404 });
    }

    handleError(error: unknown): Response | Promise<Response> | undefined {
        if (this.errorHandler) return this.errorHandler.call(this, error);
        try {
            console.error('Bun.serve request error:', error);
        } catch {
            // Diagnostics must not replace the original request failure.
        }
        return undefined;
    }

    reload(options: BunServeReloadOptions): BunServeServer {
        const parsed = parseReloadOptions(options, this.stopPromise !== undefined);
        // User getters and Response.clone() can re-enter stop() while parsing.
        // Never install (or retain) a route table compiled after shutdown began.
        if (this.stopPromise !== undefined) {
            parsed.routes?.dispose();
            if (parsed.routes !== undefined) {
                throw new TypeError('Bun.serve: cannot replace routes on a stopped server.');
            }
            return this;
        }
        let websockets = this.websockets;
        if (parsed.websocket !== undefined && websockets === undefined) {
            if (!this.upgradeWebSocket) {
                parsed.routes?.dispose();
                throw new Error('Bun.serve: the host does not support WebSocket upgrades.');
            }
            websockets = new BunWebSocketServer(parsed.websocket, this.upgradeWebSocket);
        }
        const previousRoutes = this.routes;
        // Validation is complete before any live handler or route table is changed.
        if (parsed.fetch !== undefined) this.fetchHandler = parsed.fetch;
        if (parsed.error !== undefined) this.errorHandler = parsed.error;
        if (parsed.routes !== undefined) this.routes = parsed.routes;
        if (parsed.websocket !== undefined) {
            websockets!.reload(parsed.websocket);
            this.websockets = websockets;
        }
        if (parsed.routes !== undefined) previousRoutes?.dispose();
        return this;
    }

    attach(hostServer: HostHttpServer): void {
        const address = hostServer.addr;
        if (!address || !Number.isSafeInteger(address.port) || address.port < 0 || address.port > 65535) {
            throw new Error('Bun.serve: host returned an invalid TCP address.');
        }
        if (address.transport !== undefined && address.transport !== 'tcp') {
            throw new Error('Bun.serve: host returned a non-TCP address.');
        }
        this.currentPort = address.port;
        this.currentUrl = serverUrl(this.configuredHostname, address.port, this.secure);
        this.hostServer = hostServer;
    }

    stop(closeActiveConnections?: boolean): Promise<void> {
        if (closeActiveConnections !== undefined && typeof closeActiveConnections !== 'boolean') {
            throw new TypeError('Bun.serve: stop() expects a boolean when an argument is provided.');
        }
        if (closeActiveConnections === true) {
            throw new TypeError(
                'Bun.serve: forceful stop is unsupported; the cno host only provides graceful shutdown.',
            );
        }
        if (this.stopPromise) return this.stopPromise;
        if (!this.hostServer) return Promise.reject(new Error('Bun.serve: server is not initialized.'));

        const stopped = Promise.withResolvers<void>();
        this.stopPromise = stopped.promise;
        this.routes?.dispose();
        const websockets = this.websockets?.stop();
        try {
            void Promise.all([this.hostServer.shutdown(), websockets]).then(() => stopped.resolve(), stopped.reject);
        } catch (error) {
            stopped.reject(error);
        }
        return this.stopPromise;
    }
}

/** Start an HTTP server with optional WebSocket upgrades. */
export function serve<T = unknown>(options: BunServeOptions<T>): BunServeServer<T> {
    const parsed = parseOptions(options);
    let hostServer: HostHttpServer | undefined;
    try {
        const runtime = hostRuntime();
        const exposedServer = new BunServeServerImpl(
            parsed.hostname, parsed.port, parsed.fetch, parsed.error, parsed.routes, parsed.websocket,
            runtime.upgradeWebSocket?.bind(runtime),
            parsed.tls !== undefined,
        );
        const hostOptions: HostServeOptions = {
            port: parsed.port,
            // The host's native TCP bind only accepts literal IP addresses.
            hostname: parsed.hostname === DEFAULT_HOSTNAME ? DEFAULT_BIND_HOSTNAME : parsed.hostname,
            onError: error => exposedServer.handleError(error),
            cert: parsed.tls?.cert,
            key: parsed.tls?.key,
        };
        hostServer = runtime.serve.call(
            runtime,
            hostOptions,
            (request, info) => exposedServer.handleFetch(request, info),
        );
        if (!hostServer || typeof hostServer.shutdown !== 'function') {
            throw new Error('Bun.serve: host server does not expose graceful shutdown.');
        }
        exposedServer.attach(hostServer);
        return exposedServer as BunServeServer<T>;
    } catch (error) {
        shutdownQuietly(hostServer);
        parsed.routes?.dispose();
        throw error;
    }
}
