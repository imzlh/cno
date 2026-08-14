/**
 * node:http2 transport adoption: stealing a Node Socket / TLSSocket for nghttp2,
 * plus the `req.socket` / `res.socket` proxy for the compat classes.
 *
 * `proxySocketCache` must exist exactly once — it is what makes
 * `req.socket === res.socket` hold for a single request.
 */

import { Socket } from '../net';
import type { TLSSocket } from '../tls';
import { TcpSocket } from '@cnojs/http/socket';
import { h2Error } from './errors';
import type { ServerHttp2Stream } from './stream';

/**
 * `req.socket` / `res.socket` for the compat classes.
 *
 * Node returns a Proxy over the Http2Stream that forwards a fixed whitelist of
 * socket properties to the session's real socket and everything else to the
 * stream. It caches that Proxy on the stream, which is what makes
 * `req.socket === res.socket` hold for one request — so the cache is keyed on
 * the stream here too, not on the request.
 *
 * DELIBERATE DIVERGENCE: when the session's real socket is reachable we return
 * it directly instead of wrapping it. Node's Proxy exists to keep `destroy()`
 * and friends pointed at the stream rather than tearing down the whole
 * connection; we get the same by preferring the socket only for the read-only
 * address/encryption properties. Returning a live socket makes
 * `req.socket.remoteAddress` work, which is the single most common use of this
 * property (logging, rate-limiting) and which throws on Node whenever the
 * session socket is not wired up.
 */
const proxySocketCache = new WeakMap<object, object>();

const SOCKET_PASSTHROUGH = new Set([
    'address', 'localAddress', 'localPort', 'remoteAddress', 'remoteFamily',
    'remotePort', 'encrypted', 'authorized', 'authorizationError',
    'getPeerCertificate', 'getCipher', 'getProtocol', 'alpnProtocol',
    'servername', 'bytesRead', 'bytesWritten', 'ref', 'unref',
]);

export function sessionSocketFor(state: { stream: ServerHttp2Stream }): unknown {
    const stream = state.stream as unknown as {
        session?: { socket?: unknown };
    } & object;
    const cached = proxySocketCache.get(stream);
    if (cached) return cached;
    const real = stream.session?.socket as Record<string, unknown> | undefined;
    const proxy = new Proxy(stream, {
        get(target, prop, recv) {
            if (real && typeof prop === 'string' && SOCKET_PASSTHROUGH.has(prop)) {
                const v = (real as Record<string, unknown>)[prop];
                return typeof v === 'function' ? (v as () => unknown).bind(real) : v;
            }
            const v = Reflect.get(target, prop, recv);
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v;
        },
        set(target, prop, value) {
            if (real && typeof prop === 'string' && SOCKET_PASSTHROUGH.has(prop)) {
                (real as Record<string, unknown>)[prop] = value;
                return true;
            }
            return Reflect.set(target, prop, value);
        },
        has(target, prop) {
            if (real && typeof prop === 'string' && SOCKET_PASSTHROUGH.has(prop)) return prop in real;
            return Reflect.has(target, prop);
        },
    });
    proxySocketCache.set(stream, proxy);
    return proxy;
}

/** Steal TCP from a Node Socket so nghttp2 owns the read loop (no dual onread). */
export function takeTcpForH2(socket: Socket): TcpSocket {
    const tcp = socket._tcp;
    if (!tcp) throw h2Error('ERR_HTTP2_SOCKET_UNBOUND', 'socket has no TCP handle');
    // Same ownership model as node:http ServerImpl.socketForCoreRequest:
    // Node facade keeps addresses; wire I/O is exclusive to the protocol layer.
    socket._httpOwned = {
        close: () => {
            try {
                tcp.close();
            } catch {
                /* already closed */
            }
        },
    };
    try {
        tcp.stopRead();
    } catch {
        /* not reading */
    }
    Reflect.set(tcp, 'onread', null);
    Reflect.set(socket, '_tcpReadStarted', false);
    const transport = new TcpSocket(tcp);
    transport.close = () => socket.destroy();
    return transport;
}

/**
 * Steal a completed TLSSocket into TcpSocket for H2.
 * Detaches Node duplex pumps so only nghttp2 + TcpSocket own cipher/plain I/O.
 */
export function takeTlsForH2(tlsSocket: TLSSocket): TcpSocket {
    const underlying = tlsSocket._underlying;
    const sslPipe = tlsSocket._sslPipe;
    if (!underlying || !sslPipe) {
        throw h2Error('ERR_HTTP2_SOCKET_UNBOUND', 'TLS socket is not ready for HTTP/2');
    }
    try {
        if (underlying instanceof Socket) {
            try {
                underlying.pause();
            } catch {
                /* */
            }
            const tcp = underlying._tcp;
            if (!tcp) throw h2Error('ERR_HTTP2_SOCKET_UNBOUND', 'TLS underlying has no TCP handle');
            try {
                tcp.stopRead();
            } catch {
                /* */
            }
            Reflect.set(tcp, 'onread', null);
            Reflect.set(underlying, '_tcpReadStarted', false);
            underlying._httpOwned = {
                close: () => {
                    try {
                        tcp.close();
                    } catch {
                        /* */
                    }
                },
            };
            const transport = new TcpSocket(tcp);
            transport.sslPipe = sslPipe;
            tlsSocket._sslPipe = null;
            tlsSocket._underlying = null;
            const destroyTlsSocket = tlsSocket.destroy.bind(tlsSocket);
            let closing = false;
            tlsSocket.destroy = (error?: Error) => {
                if (closing) return tlsSocket;
                closing = true;
                try {
                    underlying.destroy(error);
                } finally {
                    destroyTlsSocket(error);
                }
                return tlsSocket;
            };
            transport.close = () => { tlsSocket.destroy(); };
            return transport;
        }
        // Raw CModuleStreams.Stream under TLS
        const stream = underlying as CModuleStreams.Stream;
        try {
            stream.stopRead();
        } catch {
            /* */
        }
        Reflect.set(stream, 'onread', null);
        const transport = new TcpSocket(stream);
        transport.sslPipe = sslPipe;
        tlsSocket._sslPipe = null;
        tlsSocket._underlying = null;
        const destroyTlsSocket = tlsSocket.destroy.bind(tlsSocket);
        let closing = false;
        tlsSocket.destroy = (error?: Error) => {
            if (closing) return tlsSocket;
            closing = true;
            try {
                stream.close();
            } finally {
                destroyTlsSocket(error);
            }
            return tlsSocket;
        };
        transport.close = () => { tlsSocket.destroy(); };
        return transport;
    } catch (e) {
        throw e;
    }
}

export function isTlsSocket(socket: unknown): socket is TLSSocket {
    return !!socket && typeof socket === 'object'
        && Reflect.get(socket, 'encrypted') === true
        && Reflect.get(socket, '_sslPipe') != null;
}
