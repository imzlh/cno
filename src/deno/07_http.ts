const ssl = import.meta.use('ssl');
const streams = import.meta.use('streams');
const engine = import.meta.use('engine');
const dns = import.meta.use('dns');
const os = import.meta.use('os');

import { wrapFsClassDec as wrap } from '../utils/wrap';

/**
 * HTTP proxy connection - CONNECT tunnel
 */
async function connectHttpProxy(
    proxyUrl: URL, 
    targetHost: string, 
    targetPort: number,
    basicAuth?: string
): Promise<CModuleStreams.TCP> {
    // DNS resolution for proxy
    const addrs = await dns.resolve(proxyUrl.hostname, { family: os.AF_UNSPEC });
    if (!addrs || !addrs.length) {
        throw new Error(`DNS resolution failed for proxy ${proxyUrl.hostname}`);
    }
    const addr = addrs.find((a: any) => a.family === 4) || addrs[0];
    
    const socket = new streams.TCP();
    await socket.connect({ 
        ip: addr.ip, 
        port: parseInt(proxyUrl.port) || 80 
    });

    let connectReq = 
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n`;
    
    if (basicAuth) {
        connectReq += `Proxy-Authorization: ${basicAuth}\r\n`;
    }
    
    connectReq += `\r\n`;
    
    await socket.write(engine.encodeString(connectReq));

    const buf = new Uint8Array(1024);
    const n = await socket.read(buf);
    if (!n) {
        socket.close();
        throw new Error('Proxy connection closed');
    }

    const response = engine.decodeString(buf.subarray(0, n));
    if (!response.startsWith('HTTP/1.1 200') && !response.startsWith('HTTP/1.0 200')) {
        socket.close();
        throw new Error(`Proxy CONNECT failed: ${response.split('\r\n')[0]}`);
    }

    return socket;
}

/**
 * HTTP Client configuration
 */
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

/**
 * HTTP Client for custom TLS and proxy configuration
 */
export class HttpClient {
    public readonly options: HttpClientOptions;
    private sslContext: CModuleSSL.Context | null = null;
    private closed = false;

    constructor(options: HttpClientOptions = {}) {
        this.options = {
            poolIdleTimeout: 30000,
            http2: false,
            ...options
        };

        // Build SSL context if custom certs provided
        if (options.caCerts || options.cert || options.key) {
            this.sslContext = this.createSSLContext();
        }
    }

    private createSSLContext(): CModuleSSL.Context {
        // Concatenate CA certs
        let caData: string | undefined;
        if (this.options.caCerts && this.options.caCerts.length > 0) {
            const caContent = this.options.caCerts.filter(c => c && c.trim()).join('\n');
            if (caContent) caData = caContent;
        }

        // Client certificate for mTLS
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

    /**
     * Get SSL context for connections
     */
    getSSLContext(): CModuleSSL.Context | null {
        return this.sslContext;
    }

    /**
     * Check if proxy should be used for a URL
     */
    shouldUseProxy(url: URL): boolean {
        if (!this.options.proxy) return false;
        // TODO: Support NO_PROXY environment variable
        return true;
    }

    /**
     * Get proxy URL
     */
    getProxyUrl(): URL | null {
        if (!this.options.proxy) return null;
        return new URL(this.options.proxy.url);
    }

    /**
     * Get proxy authentication header if configured
     */
    getProxyAuth(): string | null {
        if (!this.options.proxy?.basicAuth) return null;
        const { username, password } = this.options.proxy.basicAuth;
        const creds = engine.encodeString(`${username}:${password}`);
        const base64 = btoa(String.fromCharCode(...creds));
        return `Basic ${base64}`;
    }

    /**
     * Establish connection through proxy if configured
     */
    @wrap
    async connect(hostname: string, port: number, isSecure: boolean): Promise<CModuleStreams.TCP> {
        if (this.closed) {
            throw new Error('HttpClient is closed');
        }

        const proxyUrl = this.getProxyUrl();
        
        if (proxyUrl && !isSecure) {
            // HTTP through proxy - connect to proxy server
            const addrs = await dns.resolve(proxyUrl.hostname, { family: os.AF_UNSPEC });
            if (!addrs || !addrs.length) {
                throw new Error(`DNS resolution failed for proxy ${proxyUrl.hostname}`);
            }
            const addr = addrs.find((a: any) => a.family === 4) || addrs[0];
            
            const socket = new streams.TCP();
            await socket.connect({
                ip: addr.ip,
                port: parseInt(proxyUrl.port) || 80
            });
            return socket;
        } else if (proxyUrl && isSecure) {
            // HTTPS through proxy - use CONNECT tunnel
            const auth = this.getProxyAuth();
            return connectHttpProxy(proxyUrl, hostname, port, auth || undefined);
        } else {
            // Direct connection - DNS resolution
            const addrs = await dns.resolve(hostname, { family: os.AF_UNSPEC });
            if (!addrs || !addrs.length) {
                throw new Error(`DNS resolution failed for ${hostname}`);
            }
            const addr = addrs.find((a: any) => a.family === 4) || addrs[0];
            
            const socket = new streams.TCP();
            await socket.connect({ ip: addr.ip, port });
            return socket;
        }
    }

    close(): void {
        this.closed = true;
        // Note: SSL context cleanup is handled by GC
    }

    [Symbol.dispose](): void {
        this.close();
    }
}

/**
 * Global HTTP client store for fetch integration
 */
const httpClients = new WeakMap<Request, HttpClient>();

/**
 * Associate a client with a request for fetch to use
 */
export function setRequestClient(request: Request, client: HttpClient): void {
    httpClients.set(request, client);
}

/**
 * Get the client associated with a request
 */
export function getRequestClient(request: Request): HttpClient | undefined {
    return httpClients.get(request);
}

/**
 * Create HTTP client (Deno API)
 */
function createHttpClient(options: HttpClientOptions): HttpClient {
    return new HttpClient(options);
}

Object.assign(Deno, {
    createHttpClient,
    HttpClient
} as Partial<typeof Deno>);
