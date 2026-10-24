/** Shared HTTP/1.1 utilities: TCP connect helpers, request building and response head parsing. */

import { HttpRequestBuilder, HttpResponseParser } from "@cnojs/http/h1";
import { Headers } from "../webapi/headers";
import { type ISocket, TcpSocket } from "@cnojs/http/socket";
import { dnsCache } from "@cnojs/http/dns-cache";
import { getRawConnectionHook, type RawConnection } from './network-hooks';
import { systemCaBundle } from './ca-certs';

const streams = import.meta.use('streams');
const ssl = import.meta.use('ssl');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/** Socket subset required for HTTP request/response exchange. */
export type IHttpSocket = Pick<ISocket, 'onReadable' | 'stopReading' | 'write' | 'close'>;

/** Per-connection TLS verification settings for the raw (non-libcurl) path. */
export interface TlsOptions {
    /**
     * Verify the peer's certificate chain and hostname. Defaults to true.
     * Setting false disables both, which is what `--skip-cert-verify` maps to.
     */
    rejectUnauthorized?: boolean;
    /** Extra trust roots, PEM. Merged with the platform store, not replacing it. */
    caCerts?: string[];
}

/**
 * Process-wide default. Verification is ON unless something explicitly turns it
 * off, mirroring the libcurl side's single `--skip-cert-verify` flag.
 */
let defaultTls: TlsOptions = { rejectUnauthorized: true };

/**
 * Disable certificate verification for every subsequent raw connection.
 * Called from the `--skip-cert-verify` handler; there is deliberately no
 * re-enable, matching `disableCertVerify()` on the libcurl side.
 */
export function disableRawCertVerify(): void {
    defaultTls = { ...defaultTls, rejectUnauthorized: false };
}

/** Add trust roots used by every subsequent raw connection. */
export function setRawCaCerts(caCerts: string[] | undefined): void {
    defaultTls = { ...defaultTls, caCerts };
}

/** Current policy, for tests and for callers that need to report it. */
export function getRawTlsOptions(): Readonly<TlsOptions> {
    return defaultTls;
}

/** True for an IPv4/IPv6 literal, which needs IP-SAN matching rather than DNS matching. */
function isIpLiteral(hostname: string): boolean {
    const bare = hostname.replace(/^\[(.*)\]$/, '$1');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return true;
    return bare.includes(':');
}

/**
 * Build the client SSL context for a raw TLS connection. The CA bundle must be
 * explicit (OpenSSL's default verify paths are empty on Windows); IP literals get
 * chain verification but no name check.
 */
export function createClientTlsContext(alpn: string[], options?: TlsOptions, servername?: string): CModuleSSL.Context {
    const effective = options ?? defaultTls;
    if (effective.rejectUnauthorized === false) {
        return new ssl.Context({ alpn, mode: 'client' });
    }
    const ca = systemCaBundle(effective.caCerts ?? defaultTls.caCerts);
    return new ssl.Context({
        alpn,
        mode: 'client',
        verify: true,
        verifyHostname: !(servername !== undefined && isIpLiteral(servername)),
        ...(ca ? { ca } : {}),
    });
}

/**
 * Connect to the first reachable address for `hostname`.
 *
 * A fresh `streams.TCP` per candidate is required: a handle whose `connect`
 * failed cannot be reused for the next address.
 */
export async function openTcp(hostname: string, port: number): Promise<TcpSocket> {
    const ips = await dnsCache.resolve(hostname);
    let lastError: unknown = null;
    for (const ip of ips) {
        const tcp = new streams.TCP();
        try {
            await tcp.connect({ ip: ip.ip, port });
            return new TcpSocket(tcp);
        } catch (error) {
            lastError = error;
            try { tcp.close(); } catch { /* never connected */ }
        }
    }
    throw new Error(`Connection failed${lastError ? `: ${(lastError as Error).message}` : ''}`);
}

/** Result of reading HTTP response headers. */
export interface HttpResponseHead {
    status: number;
    headers: Array<[string, string]>;
    leftover?: Uint8Array;
}

/** Connect to the URL's host, over TLS for https:/wss:. `tls` overrides the verification policy. */
export async function connectDirectTcp(url: URL, tls?: TlsOptions): Promise<TcpSocket> {
    const isSecure = url.protocol === 'https:' || url.protocol === 'wss:';
    const port = url.port ? parseInt(url.port) : (isSecure ? 443 : 80);
    const socket = await openTcp(url.hostname, port);
    try {
        if (isSecure) {
            await socket.clientHandshake(createClientTlsContext(['http/1.1'], tls, url.hostname), url.hostname);
        }
        return socket;
    } catch (err) {
        socket.close();
        throw err;
    }
}

export async function connectHttp(url: URL): Promise<RawConnection> {
    const hook = getRawConnectionHook();
    return hook ? hook(url) : { socket: await connectDirectTcp(url) };
}

export async function connectTcp(url: URL): Promise<TcpSocket> {
    return (await connectHttp(url)).socket;
}

/** Build raw HTTP/1.1 request bytes from method, URL, and headers. */
export function buildRequest(opts: {
    method: string;
    url: URL;
    headers: Headers;
    requestTarget?: string;
}): Uint8Array {
    const rawHeaders: Array<[string, string]> = [];
    opts.headers.forEach((v, k) => rawHeaders.push([k, v]));
    return new HttpRequestBuilder({
        method: opts.method,
        path: opts.requestTarget ?? opts.url.pathname + opts.url.search,
        host: opts.url.host,
        headers: rawHeaders
    }).build();
}

/**
 * Parse the response head, then stop the socket's reader so the caller can
 * attach its own handler for the body / next protocol phase.
 */
export function readHeaders(socket: IHttpSocket, parser: HttpResponseParser): Promise<HttpResponseHead> {
    let settled = false;
    let head: HttpResponseHead | null = null;
    return new Promise<HttpResponseHead>((resolve, reject) => {
        const settle = (fn: 'resolve' | 'reject', value: HttpResponseHead | unknown) => {
            if (settled) return;
            settled = true;
            if (fn === 'reject') {
                try { socket.stopReading(); } catch { /* already stopped */ }
                try { socket.close(); } catch { /* already closed */ }
            }
            if (fn === 'resolve') resolve(value as HttpResponseHead);
            else reject(value);
        };

        parser.onHeadersComplete = (status, headers) => {
            head = { status, headers };
        };
        parser.onError = (err) => {
            settle('reject', err);
        };
        socket.onReadable(data => {
            if (!data) {
                socket.close();
                settle('reject', new Error('Connection closed while reading headers'));
                return;
            }
            try {
                const result = parser.feed(data);
                if (head && !settled) {
                    socket.stopReading();
                    const consumed = Number(result?.bytesConsumed ?? data.byteLength);
                    if (Number.isFinite(consumed) && consumed >= 0 && consumed < data.byteLength) {
                        head.leftover = data.subarray(consumed);
                    }
                    settle('resolve', head);
                }
            } catch (err) {
                settle('reject', err);
            }
        }, err => {
            settle('reject', err);
        });
    });
}
