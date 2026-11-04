/**
 * HTTP-only Bun.serve adapter.
 *
 * Deno.serve owns parsing, response streaming, and connection lifetime in the
 * host. This adapter keeps Bun's synchronous handle and metadata while
 * rejecting transport features that the host cannot represent faithfully.
 */

export interface BunServeServer {
    readonly port: number;
    readonly hostname: string;
    readonly url: URL;
    /** Graceful shutdown; force-close is intentionally unsupported. */
    stop(closeActiveConnections?: boolean): Promise<void>;
    /** Replace request/error handlers without rebinding the listener. */
    reload(options: BunServeReloadOptions): BunServeServer;
}

export type BunServeHandler = (
    this: BunServeServer,
    request: Request,
    server: BunServeServer,
) => Response | Promise<Response>;

export interface BunServeOptions {
    fetch: BunServeHandler;
    error?: (this: BunServeServer, error: unknown) => Response | Promise<Response>;
    port?: number | string;
    hostname?: string;
}

/** The handler subset accepted by server.reload(). */
export interface BunServeReloadOptions {
    fetch?: BunServeHandler;
    error?: (this: BunServeServer, error: unknown) => Response | Promise<Response>;
    // Bun accepts these on reload but leaves the existing listener unchanged.
    port?: number | string;
    hostname?: string;
}

interface HostAddress {
    port: number;
    transport?: string;
}

interface HostHttpServer {
    readonly addr: HostAddress;
    shutdown(): Promise<void>;
}

interface HostServeOptions {
    port: number;
    hostname: string;
    onError?: (error: unknown) => Response | Promise<Response> | undefined;
}

interface HostDeno {
    serve(
        options: HostServeOptions,
        handler: (request: Request) => Response | Promise<Response>,
    ): HostHttpServer;
}

interface ParsedOptions {
    fetch: BunServeHandler;
    error?: (error: unknown) => Response | Promise<Response>;
    port: number;
    hostname: string;
}

interface ParsedReloadOptions {
    fetch?: BunServeHandler;
    error?: (error: unknown) => Response | Promise<Response>;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = 'localhost';
const DEFAULT_BIND_HOSTNAME = '127.0.0.1';
const SUPPORTED_OPTIONS = new Set(['fetch', 'error', 'port', 'hostname']);

const UNSUPPORTED_OPTION_DETAILS = new Map<string, string>([
    ['websocket', 'WebSocket upgrades are not part of the HTTP-only subset.'],
    ['tls', 'TLS is not part of the HTTP-only subset.'],
    ['routes', 'route tables are not supported; dispatch in fetch instead.'],
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
        ?? 'This subset supports only fetch, error, port, and hostname.';
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
    if (typeof fetch !== 'function') {
        throw new TypeError('Bun.serve: fetch must be a function.');
    }

    const hostname = options.hostname === undefined ? DEFAULT_HOSTNAME : options.hostname;
    if (typeof hostname !== 'string' || hostname.length === 0) {
        throw new TypeError('Bun.serve: hostname must be a non-empty string.');
    }

    const error = options.error;
    if (error !== undefined && typeof error !== 'function') {
        throw new TypeError('Bun.serve: error must be a function.');
    }

    return {
        fetch: fetch as BunServeHandler,
        error: error as ParsedOptions['error'],
        port: parsePort(options.port),
        hostname,
    };
}

function parseReloadOptions(value: unknown): ParsedReloadOptions {
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

    return {
        fetch: fetch == null ? undefined : fetch as BunServeHandler,
        error: error == null ? undefined : error as ParsedReloadOptions['error'],
    };
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

function serverUrl(hostname: string, port: number): URL {
    const authorityHost = hostname.includes(':') && !hostname.startsWith('[')
        ? `[${hostname}]`
        : hostname;
    return new URL(`http://${authorityHost}:${port}/`);
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

class BunServeServerImpl implements BunServeServer {
    private hostServer: HostHttpServer | undefined;
    private stopPromise: Promise<void> | undefined;
    private currentPort: number;
    private currentUrl: URL;
    private fetchHandler: BunServeHandler;
    private errorHandler: ((error: unknown) => Response | Promise<Response>) | undefined;

    constructor(
        private readonly configuredHostname: string,
        requestedPort: number,
        fetchHandler: BunServeHandler,
        errorHandler: ((error: unknown) => Response | Promise<Response>) | undefined,
    ) {
        this.currentPort = requestedPort;
        this.currentUrl = serverUrl(configuredHostname, requestedPort);
        this.fetchHandler = fetchHandler;
        this.errorHandler = errorHandler;
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

    handleFetch(request: Request): Response | Promise<Response> {
        return this.fetchHandler.call(this, request, this);
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
        const parsed = parseReloadOptions(options);
        // Validation is complete before either field is changed.
        if (parsed.fetch !== undefined) this.fetchHandler = parsed.fetch;
        if (parsed.error !== undefined) this.errorHandler = parsed.error;
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
        this.currentUrl = serverUrl(this.configuredHostname, address.port);
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

        try {
            this.stopPromise = Promise.resolve(this.hostServer.shutdown());
        } catch (error) {
            this.stopPromise = Promise.reject(error);
        }
        return this.stopPromise;
    }
}

/** Start the supported HTTP subset of Bun.serve. */
export function serve(options: BunServeOptions): BunServeServer {
    const parsed = parseOptions(options);
    const runtime = hostRuntime();
    const exposedServer = new BunServeServerImpl(parsed.hostname, parsed.port, parsed.fetch, parsed.error);
    const hostOptions: HostServeOptions = {
        port: parsed.port,
        // The host's native TCP bind only accepts literal IP addresses. Keep
        // Bun's public default while binding localhost on its IPv4 loopback.
        hostname: parsed.hostname === DEFAULT_HOSTNAME ? DEFAULT_BIND_HOSTNAME : parsed.hostname,
    };
    // Keep the callback installed so reload() can replace handlers without
    // restarting Deno.serve. Without a custom handler the host still emits 500.
    hostOptions.onError = error => exposedServer.handleError(error);

    let hostServer: HostHttpServer;
    try {
        hostServer = runtime.serve.call(
            runtime,
            hostOptions,
            request => exposedServer.handleFetch(request),
        );
    } catch (error) {
        throw error;
    }

    if (!hostServer || typeof hostServer.shutdown !== 'function') {
        shutdownQuietly(hostServer);
        throw new Error('Bun.serve: host server does not expose graceful shutdown.');
    }

    try {
        exposedServer.attach(hostServer);
    } catch (error) {
        shutdownQuietly(hostServer);
        throw error;
    }
    return exposedServer;
}
