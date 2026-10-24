const ssl = import.meta.use('ssl');
const streams = import.meta.use('streams');
const engine = import.meta.use('engine');
const os = import.meta.use('os');
const crypto = import.meta.use('crypto');
const error = import.meta.use('error');

import type { DnsAddressType } from '@cnojs/http/dns-cache';
import { dnsCache } from '@cnojs/http/dns-cache';
import { wrapFsClassDec as wrap } from '../utils/wrap';
import { shouldBypassProxy } from '../utils/proxy';

const preferIPv4 = (addrs: DnsAddressType[]): DnsAddressType =>
    addrs.find(addr => addr.family === 4) ?? addrs[0];

function safeGetEnv(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}

function hostForUrl(hostname: string): string {
    if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname;
    return hostname.includes(':') ? `[${hostname}]` : hostname;
}

/** An URL with no explicit port leaves `port` empty; HTTP proxies default to 80. */
function proxyPort(proxyUrl: URL): number {
    return parseInt(proxyUrl.port) || 80;
}

async function dialTcp(hostname: string, port: number, viaProxy = false): Promise<CModuleStreams.TCP> {
    const addrs = await dnsCache.resolve(hostname, { family: os.AF_UNSPEC });
    if (!addrs || !addrs.length) {
        throw new Error(`DNS resolution failed for ${viaProxy ? 'proxy ' : ''}${hostname}`);
    }
    const socket = new streams.TCP();
    await socket.connect({ ip: preferIPv4(addrs).ip, port });
    return socket;
}

async function connectHttpProxy(
    proxyUrl: URL,
    targetHost: string,
    targetPort: number,
    basicAuth?: string
): Promise<CModuleStreams.TCP> {
    const socket = await dialTcp(proxyUrl.hostname, proxyPort(proxyUrl), true);

    let connectReq =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n`;
    
    if (basicAuth) {
        connectReq += `Proxy-Authorization: ${basicAuth}\r\n`;
    }
    
    connectReq += `\r\n`;
    
    await socket.write(engine.encodeString(connectReq));

    const buf = new Uint8Array(4096);
    const n = await socket.read(buf);
    if (n === 0) {
        socket.close();
        throw error.Error(error.errno.EOF);
    }

    const response = engine.decodeString(buf.subarray(0, n));
    if (!response.startsWith('HTTP/1.1 200') && !response.startsWith('HTTP/1.0 200')) {
        socket.close();
        throw new Error(`Proxy CONNECT failed: ${response.split('\r\n')[0]}`);
    }

    return socket;
}

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
    poolIdleTimeout?: number;
    http2?: boolean;
}

export class HttpClient {
    #options: HttpClientOptions;
    #sslContext: CModuleSSL.Context | null = null;
    #closed = false;

    constructor(options: HttpClientOptions = {}) {
        this.#options = {
            poolIdleTimeout: 30000,
            http2: false,
            ...options
        };

        // Custom CA/cert material only needs a dedicated context when present.
        if (options.caCerts || options.cert || options.key) {
            this.#sslContext = this.createSSLContext();
        }
    }

    get options(): HttpClientOptions {
        return this.#options;
    }

    private createSSLContext(): CModuleSSL.Context {
        let caData: string | undefined;
        if (this.options.caCerts && this.options.caCerts.length > 0) {
            const caContent = this.options.caCerts.filter(c => c && c.trim()).join('\n');
            if (caContent) caData = caContent;
        }

        let certData: string | undefined;
        let keyData: string | undefined;
        if (this.options.cert && this.options.cert.trim() &&
            this.options.key && this.options.key.trim()) {
            certData = this.options.cert;
            keyData = this.options.key;
        }

        return new ssl.Context({
            mode: 'client',
            verify: !!caData,
            ca: caData,
            cert: certData,
            key: keyData
        });
    }

    getSSLContext(): CModuleSSL.Context | null {
        return this.#sslContext;
    }

    shouldUseProxy(url: URL): boolean {
        if (!this.options.proxy) return false;
        const noProxy = safeGetEnv('NO_PROXY') ?? safeGetEnv('no_proxy');
        return !shouldBypassProxy(url, noProxy);
    }

    getProxyUrl(): URL | null {
        if (!this.options.proxy) return null;
        return new URL(this.options.proxy.url);
    }

    getProxyAuth(): string | null {
        if (!this.options.proxy?.basicAuth) return null;
        const { username, password } = this.options.proxy.basicAuth;
        return `Basic ${crypto.base64Encode(engine.encodeString(`${username}:${password}`))}`;
    }

    @wrap
    async connect(hostname: string, port: number, isSecure: boolean): Promise<CModuleStreams.TCP> {
        if (this.#closed) {
            throw new Error('HttpClient is closed');
        }

        const targetUrl = new URL(`${isSecure ? 'https' : 'http'}://${hostForUrl(hostname)}:${port}/`);
        const proxyUrl = this.shouldUseProxy(targetUrl) ? this.getProxyUrl() : null;

        if (!proxyUrl) return dialTcp(hostname, port);
        if (isSecure) return connectHttpProxy(proxyUrl, hostname, port, this.getProxyAuth() || undefined);
        // Plain HTTP through a proxy connects to the proxy itself; curl sends the absolute-form target.
        return dialTcp(proxyUrl.hostname, proxyPort(proxyUrl), true);
    }

    close(): void {
        this.#closed = true;
    }

    [Symbol.dispose](): void {
        this.close();
    }
}

/** Client attached by fetch()'s `init.client`, looked up at perform time. */
const httpClients = new WeakMap<Request, HttpClient>();

export function setRequestClient(request: Request, client: HttpClient): void {
    httpClients.set(request, client);
}

export function getRequestClient(request: Request): HttpClient | undefined {
    return httpClients.get(request);
}

function createHttpClient(options: HttpClientOptions = {}): HttpClient {
    return new HttpClient(options);
}

Object.assign(Deno, {
    createHttpClient,
    HttpClient
});
