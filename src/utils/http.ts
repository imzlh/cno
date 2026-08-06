/**
 * Shared HTTP/1.1 connection utilities.
 * Provides TCP connection establishment, HTTP request building,
 * and response header parsing for WebSocket, SSE, and other HTTP-based protocols.
 */

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

/* -------------------------------------------------------------------------- */
/* TLS verification policy                                                    */
/* -------------------------------------------------------------------------- */

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
 * off, so a caller that passes no options gets a verified connection.
 *
 * This mirrors how the libcurl side already works: `--skip-cert-verify` sets one
 * process-global flag rather than threading an option through every call site.
 * The raw path had no equivalent, which is why `https:`/`wss:` were unverified
 * even without the flag.
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
 * Build the client SSL context for a raw TLS connection.
 *
 * `verify: true` is what makes OpenSSL fail the handshake on an untrusted chain
 * (`SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT`), and it is also what
 * arms the hostname check: `ssl.Pipe` calls `SSL_set1_host(servername)` only
 * when the context wants hostname verification, and that check can only reject
 * a handshake while peer verification is on. So chain and name are enforced
 * together or not at all — there is no "chain only" state to reach by accident.
 *
 * The CA bundle must be passed explicitly. OpenSSL's compile-time default verify
 * paths point at a directory that does not exist on Windows, so relying on
 * `SSL_CTX_set_default_verify_paths` alone leaves the store empty and every
 * verification fails with UNKNOWN_CA.
 *
 * KNOWN WEAKNESS — IP-literal targets get chain verification but no name check.
 * `SSL_set1_host` matches DNS names only; OpenSSL requires `SSL_set1_ip_asc` to
 * match an IP against an iPAddress SAN, and the binding never calls it (there is
 * no `GEN_IPADD` handling in mod_ssl.c at all). Measured: a certificate with
 * `CN=127.0.0.1`, supplied as its own trust root, still fails the handshake when
 * connecting to `127.0.0.1` — the chain is fine and the *name* is what rejects.
 * Leaving hostname verification on for IP literals would therefore make every
 * `https://<ip>` connection fail regardless of how correct its certificate is,
 * so it is switched off for those and the chain check is kept. That is weaker
 * than Node, which matches IP SANs, and it must be closed in C rather than here.
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
 * A fresh `streams.TCP` per candidate is required, not an optimisation: a handle
 * that has failed `connect` cannot be reused, so sharing one across the loop made
 * every candidate after the first fail regardless of reachability. Measured with
 * `['::1', '127.0.0.1']` against an IPv4-only listener — shared handle: all
 * candidates failed; fresh handle: connected via 127.0.0.1. Since `dnsCache`
 * returns IPv6 first for `localhost`, that turned "try each IP" into "try only
 * the first" and broke every IPv6-first name on an IPv4-only path.
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

/**
 * Establish a TCP connection (with optional TLS) to the given URL's host.
 * Resolves DNS via cache, tries each IP until one connects, then performs
 * TLS handshake if the URL scheme is https: or wss:.
 *
 * The handshake verifies the peer by default. Pass `tls` to override, e.g. a
 * test that deliberately talks to a self-signed server.
 */
export async function connectDirectTcp(url: URL, tls?: TlsOptions): Promise<TcpSocket> {
    const isSecure = url.protocol === 'https:' || url.protocol === 'wss:';
    const port = url.port ? parseInt(url.port) : (isSecure ? 443 : 80);
    const socket = await openTcp(url.hostname, port);
    if (isSecure) {
        await socket.clientHandshake(createClientTlsContext(['http/1.1'], tls, url.hostname), url.hostname);
    }
    return socket;
}

export async function connectHttp(url: URL): Promise<RawConnection> {
    const hook = getRawConnectionHook();
    return hook ? hook(url) : { socket: await connectDirectTcp(url) };
}

export async function connectTcp(url: URL): Promise<TcpSocket> {
    return (await connectHttp(url)).socket;
}

/**
 * Build raw HTTP/1.1 request bytes from method, URL, and headers.
 */
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
 * Feed socket data into an HttpResponseParser until the headers are complete.
 * Uses the event-driven onReadable pattern.
 * Returns a promise resolving with status code and headers once they are fully parsed.
 * After resolution the socket's reader is stopped so the caller can set up
 * a new onReadable handler for the body / next protocol phase.
 */
export function readHeaders(socket: IHttpSocket, parser: HttpResponseParser): Promise<HttpResponseHead> {
    let settled = false;
    let head: HttpResponseHead | null = null;
    return new Promise<HttpResponseHead>((resolve, reject) => {
        const settle = (fn: 'resolve' | 'reject', value: HttpResponseHead | unknown) => {
            if (settled) return;
            settled = true;
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
            const result = parser.feed(data);
            if (head && !settled) {
                socket.stopReading();
                const consumed = Number(result?.bytesConsumed ?? data.byteLength);
                if (Number.isFinite(consumed) && consumed >= 0 && consumed < data.byteLength) {
                    head.leftover = data.subarray(consumed);
                }
                settle('resolve', head);
            }
        }, err => {
            settle('reject', err);
        });
    });
}
