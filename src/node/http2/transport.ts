import { Socket } from '../net';
import type { TLSSocket } from '../tls';
import { TcpSocket } from '@cnojs/http/socket';
import { h2Error } from './errors';
import type { ServerHttp2Stream } from './stream';

// Cache per stream so req.socket === res.socket; destroy() stays stream-local.
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
    try {
        tcp.stopRead();
    } catch {
        /* not reading */
    }
    Reflect.set(tcp, 'onread', null);
    socket._tcpReadStarted = false;
    const transport = new TcpSocket(tcp);
    const closeTransport = transport.close.bind(transport);
    socket._httpOwned = { close: closeTransport };
    transport.close = () => {
        try {
            closeTransport();
        } finally {
            socket.destroy();
        }
    };
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
    const stream = underlying instanceof Socket ? underlying._tcp : underlying as CModuleStreams.Stream;
    if (!stream) throw h2Error('ERR_HTTP2_SOCKET_UNBOUND', 'TLS underlying has no TCP handle');
    if (underlying instanceof Socket) {
        underlying.pause();
        underlying._tcpReadStarted = false;
    }
    try { stream.stopRead(); } catch { /* not reading */ }
    Reflect.set(stream, 'onread', null);

    const transport = new TcpSocket(stream);
    transport.sslPipe = sslPipe;
    tlsSocket._sslPipe = null;
    tlsSocket._underlying = null;

    const closeTransport = transport.close.bind(transport);
    const destroyTlsSocket = tlsSocket.destroy.bind(tlsSocket);
    if (underlying instanceof Socket) underlying._httpOwned = { close: closeTransport };
    let closing = false;
    tlsSocket.destroy = (error?: Error) => {
        if (closing) return tlsSocket;
        closing = true;
        try {
            closeTransport();
            if (underlying instanceof Socket) underlying.destroy(error);
        } finally {
            destroyTlsSocket(error);
        }
        return tlsSocket;
    };
    transport.close = () => { tlsSocket.destroy(); };
    return transport;
}

export function isTlsSocket(socket: unknown): socket is TLSSocket {
    return !!socket && typeof socket === 'object'
        && Reflect.get(socket, 'encrypted') === true
        && Reflect.get(socket, '_sslPipe') != null;
}
