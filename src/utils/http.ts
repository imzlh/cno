/**
 * Shared HTTP/1.1 connection utilities.
 * Provides TCP connection establishment, HTTP request building,
 * and response header parsing for WebSocket, SSE, and other HTTP-based protocols.
 */

import { HttpRequestBuilder, HttpResponseParser } from "@cnojs/http/h1";
import { Headers } from "headers-polyfill";
import { type ISocket, TcpSocket } from "@cnojs/http/socket";
import { dnsCache } from "@cnojs/http/dns-cache";

const streams = import.meta.use('streams');
const ssl = import.meta.use('ssl');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/** Socket subset required for HTTP request/response exchange. */
export type IHttpSocket = Pick<ISocket, 'onReadable' | 'stopReading' | 'write' | 'close'>;

/** Result of reading HTTP response headers. */
export interface HttpResponseHead {
    status: number;
    headers: Array<[string, string]>;
}

/**
 * Establish a TCP connection (with optional TLS) to the given URL's host.
 * Resolves DNS via cache, tries each IP until one connects, then performs
 * TLS handshake if the URL scheme is https: or wss:.
 */
export async function connectTcp(url: URL): Promise<TcpSocket> {
    const isSecure = url.protocol === 'https:' || url.protocol === 'wss:';
    const port = url.port ? parseInt(url.port) : (isSecure ? 443 : 80);

    let connected = false;
    const iplist = await dnsCache.resolve(url.hostname);
    const tcp = new streams.TCP();
    for (const ip of iplist) try {
        await tcp.connect({ ip: ip.ip, port });
        connected = true;
        break;
    } catch { }
    if (!connected) throw new Error('Connection failed');

    const socket = new TcpSocket(tcp);
    if (isSecure) {
        const ctx = new ssl.Context({
            alpn: ['http/1.1'],
            mode: 'client'
        });
        await socket.clientHandshake(ctx, url.hostname);
    }
    return socket;
}

/**
 * Build raw HTTP/1.1 request bytes from method, URL, and headers.
 */
export function buildRequest(opts: {
    method: string;
    url: URL;
    headers: Headers;
}): Uint8Array {
    const rawHeaders: Array<[string, string]> = [];
    opts.headers.forEach((v, k) => rawHeaders.push([k, v]));
    return new HttpRequestBuilder({
        method: opts.method,
        path: opts.url.pathname + opts.url.search,
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
    return new Promise<HttpResponseHead>((resolve, reject) => {
        parser.onHeadersComplete = (status, headers) => {
            settled = true;
            socket.stopReading();
            resolve({ status, headers });
        };
        parser.onError = (err) => {
            if (!settled) { settled = true; reject(err); }
        };
        socket.onReadable(data => {
            if (!data) {
                socket.close();
                if (!settled) { settled = true; reject(new Error('Connection closed while reading headers')); }
                return;
            }
            parser.feed(data);
        }, err => {
            if (!settled) { settled = true; reject(err); }
        });
    });
}
