import { errors } from '../../deno/01_errors';
import { basicAuth, openTcp } from '../../utils/http';
import { getEnv } from '../../utils/env';
import { connectHttpProxyTunnel, shouldBypassProxy, type ProxyConfig } from '../../utils/proxy';
import { wrapDenoError } from '../../utils/wrap';
import { createCurlPool } from './helpers';
import type { SocketTransport } from '@cnojs/http/socket';

const timers = import.meta.use('timers');
const ssl = import.meta.use('ssl');

export interface HttpClientOptions {
    caCerts?: string[];
    cert?: string;
    key?: string;
    proxy?: {
        url: string;
        basicAuth?: {
            username: string;
            password: string;
        };
    };
    poolIdleTimeout?: number | false;
    http2?: boolean;
}

export interface HttpClientLease {
    pool: CModuleCURL.ConnPool;
    release(): void;
}

export const acquireHttpClientPool = Symbol('acquireHttpClientPool');

function hostForUrl(hostname: string): string {
    if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname;
    return hostname.includes(':') ? `[${hostname}]` : hostname;
}

export class HttpClient {
    #options: HttpClientOptions;
    #sslContext: CModuleSSL.Context | null = null;
    #pool: CModuleCURL.ConnPool | undefined;
    #requests = 0;
    #idleTimer: number | null = null;
    #closed = false;

    constructor(options: HttpClientOptions = {}) {
        if ((options.cert === undefined) !== (options.key === undefined)) {
            throw new TypeError('cert and key must be provided together');
        }
        if (options.proxy !== undefined) {
            if (options.proxy === null || typeof options.proxy !== 'object' || typeof options.proxy.url !== 'string') {
                throw new TypeError('proxy.url must be a string');
            }
            new URL(options.proxy.url);
        }
        this.#options = {
            poolIdleTimeout: 30000,
            http2: true,
            ...options,
        };
    }

    static isHttpClient(value: unknown): value is HttpClient {
        return typeof value === 'object' && value !== null && #pool in value;
    }

    get options(): HttpClientOptions {
        return this.#options;
    }

    assertOpen(): void {
        if (this.#closed) throw new errors.BadResource('Bad resource ID');
    }

    [acquireHttpClientPool](): HttpClientLease {
        this.assertOpen();
        this.#clearIdleTimer();
        const pool = this.#pool ??= createCurlPool();
        this.#requests++;
        let released = false;
        return {
            pool,
            release: () => {
                if (released) return;
                released = true;
                if (--this.#requests !== 0) return;
                if (this.#closed) this.#closePool();
                else this.#scheduleIdleClose();
            },
        };
    }

    shouldUseProxy(url: URL): boolean {
        if (!this.options.proxy) return false;
        const noProxy = getEnv('NO_PROXY') ?? getEnv('no_proxy');
        return !shouldBypassProxy(url, noProxy);
    }

    getProxyUrl(): URL | null {
        if (!this.options.proxy) return null;
        return new URL(this.options.proxy.url);
    }

    getSSLContext(): CModuleSSL.Context | null {
        if (!this.#sslContext && (this.options.caCerts || this.options.cert || this.options.key)) {
            this.#sslContext = this.createSSLContext();
        }
        return this.#sslContext;
    }

    getProxyAuth(): string | null {
        const auth = this.options.proxy?.basicAuth;
        return auth ? basicAuth(auth.username, auth.password) : null;
    }

    @wrapDenoError
    async connect(hostname: string, port: number, isSecure: boolean): Promise<SocketTransport> {
        if (this.#closed) throw new Error('HttpClient is closed');

        const target = new URL(`${isSecure ? 'https' : 'http'}://${hostForUrl(hostname)}:${port}/`);
        const proxyUrl = this.shouldUseProxy(target) ? this.getProxyUrl() : null;
        if (!proxyUrl) return (await openTcp(hostname, port)).socket;
        if (proxyUrl.protocol !== 'http:') {
            throw new TypeError('HttpClient.connect supports only HTTP proxies');
        }
        if (!isSecure) return (await openTcp(proxyUrl.hostname, Number(proxyUrl.port) || 80)).socket;

        const options = this.options.proxy;
        if (!options) return (await openTcp(hostname, port)).socket;
        const config: ProxyConfig = {
            url: proxyUrl.href,
            type: 'http',
            ...(options.basicAuth ? {
                user: options.basicAuth.username,
                pass: options.basicAuth.password,
            } : {}),
        };
        return (await connectHttpProxyTunnel(target, config)).socket;
    }

    private createSSLContext(): CModuleSSL.Context {
        const ca = this.options.caCerts?.filter(cert => cert && cert.trim()).join('\n');
        const cert = this.options.cert?.trim() ? this.options.cert : undefined;
        const key = this.options.key?.trim() ? this.options.key : undefined;
        return new ssl.Context({
            mode: 'client',
            verify: !!ca,
            ...(ca ? { ca } : {}),
            ...(cert && key ? { cert, key } : {}),
        });
    }

    #closePool(): void {
        this.#clearIdleTimer();
        const pool = this.#pool;
        this.#pool = undefined;
        pool?.close();
    }

    #clearIdleTimer(): void {
        if (this.#idleTimer === null) return;
        timers.clearTimeout(this.#idleTimer);
        this.#idleTimer = null;
    }

    #scheduleIdleClose(): void {
        this.#clearIdleTimer();
        const timeout = this.options.poolIdleTimeout;
        const pool = this.#pool;
        if (pool === undefined || timeout === false || timeout === undefined) return;
        this.#idleTimer = timers.setTimeout(() => {
            this.#idleTimer = null;
            if (this.#closed || this.#requests !== 0 || this.#pool !== pool) return;
            if (pool.closeIdleConnections) pool.closeIdleConnections();
            else this.#closePool();
        }, timeout);
        timers.unrefTimer(this.#idleTimer);
    }

    close(): void {
        if (this.#closed) throw new errors.BadResource('Bad resource ID');
        this.#closed = true;
        this.#clearIdleTimer();
        if (this.#requests === 0) {
            this.#closePool();
        } else if (this.#pool?.closeIdleConnections) {
            // close() can be called by a fetch observer inside curl_multi_socket_action.
            const pool = this.#pool;
            queueMicrotask(() => {
                if (this.#pool === pool) pool.closeIdleConnections?.();
            });
        }
        // Older libcurl has no idle-only eviction API; the last lease closes its pool.
    }

    [Symbol.dispose](): void {
        if (!this.#closed) this.close();
    }
}
