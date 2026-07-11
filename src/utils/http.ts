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

const streams = import.meta.use('streams');
const ssl = import.meta.use('ssl');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/** Socket subset required for HTTP request/response exchange. */
export type IHttpSocket = Pick<ISocket, 'onReadable' | 'stopReading' | 'write' | 'close'>;

export async function openTcp(hostname: string, port: number): Promise<TcpSocket> {
    const ips = await dnsCache.resolve(hostname);
    const tcp = new streams.TCP();
    for (const ip of ips) try { await tcp.connect({ ip: ip.ip, port }); return new TcpSocket(tcp); } catch { }
    throw new Error('Connection failed');
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
 */
export async function connectDirectTcp(url: URL): Promise<TcpSocket> {
    const isSecure = url.protocol === 'https:' || url.protocol === 'wss:';
    const port = url.port ? parseInt(url.port) : (isSecure ? 443 : 80);
    const socket = await openTcp(url.hostname, port);
    if (isSecure) {
        const ctx = new ssl.Context({
            alpn: ['http/1.1'],
            mode: 'client'
        });
        await socket.clientHandshake(ctx, url.hostname);
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
