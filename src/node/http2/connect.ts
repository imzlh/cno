/**
 * node:http2 client entry point: authority/target resolution and `connect()`.
 */

import { Buffer } from '../buffer';
import { Socket, connect as netConnect } from '../net';
import * as tls from '../tls';
import type { TLSSocket } from '../tls';
import { ensureH2, invalidArgType, invalidUrl, unsupportedProtocol } from './errors';
import { isTlsSocket } from './transport';
import { ClientHttp2Session } from './session';

/** http:/https: only — matches Node's connect() protocol allowlist. */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

export interface ResolvedConnectTarget {
    protocol: string;
    /** Dial host — honours options.host/options.hostname overrides. */
    host: string;
    /** Dial port — honours options.port override. */
    port: number;
    secure: boolean;
    /** The `:authority` pseudo-header value (from the URL, not the dial target). */
    authority: string;
}

/**
 * Validate `authority` and resolve the dial target.
 *
 * Exported (double-underscore = internal/test surface, as with
 * __forceH2Unavailable) so the resolution table is observable without a build
 * that has the h2 native extension. Called by connect() BEFORE ensureH2, so a
 * caller gets a useful argument error rather than a build-config message.
 */
export function __resolveConnectTarget(
    authority: unknown,
    options?: Record<string, unknown>,
): ResolvedConnectTarget {
    const opts = options ?? {};

    let url: URL | { protocol?: unknown; hostname?: unknown; host?: unknown; port?: unknown };
    if (typeof authority === 'string') {
        // Node hands the string straight to the URL parser: no `http://`
        // prefixing. '127.0.0.1:1' and 'not a url' are ERR_INVALID_URL, and a
        // prefix would instead have accepted them as cleartext.
        try {
            url = new URL(authority);
        } catch {
            throw invalidUrl(authority);
        }
    } else if (authority instanceof URL) {
        url = authority;
    } else if (
        authority !== null
        && typeof authority === 'object'
        && !Array.isArray(authority)
    ) {
        url = authority as { protocol?: unknown; hostname?: unknown; host?: unknown; port?: unknown };
    } else {
        // null / number / boolean / symbol / array. Node's own no-argument case
        // is an unguarded deref that throws a bare TypeError with no .code; we
        // give it the same codeful error as every other bad type instead.
        throw invalidArgType(
            'authority',
            'of type string or an instance of URL or Object',
            authority,
        );
    }

    // Node's object branch defaults to https: — the secure choice. The old code
    // defaulted to cleartext, so connect({port:8080}) dialled h2c.
    const rawProtocol = url.protocol ?? opts['protocol'] ?? 'https:';
    const protocol = String(rawProtocol).toLowerCase();
    if (!SUPPORTED_PROTOCOLS.has(protocol)) throw unsupportedProtocol(protocol);

    const secure = protocol === 'https:';
    const rawHost = url.hostname ?? url.host ?? 'localhost';
    const urlHost = String(rawHost) || 'localhost';
    if (!urlHost) throw invalidUrl(authority);

    const rawPort = url.port;
    const urlPort = (rawPort === undefined || rawPort === null || rawPort === '')
        ? (secure ? 443 : 80)
        : Number(rawPort);
    if (!Number.isInteger(urlPort) || urlPort < 0 || urlPort > 65535) {
        throw Object.assign(
            new RangeError(`Invalid port: ${String(rawPort)}`),
            { code: 'ERR_SOCKET_BAD_PORT' },
        );
    }

    // Node never elides the port: `http://h/` sends `:authority: h:80`
    // (measured on v24.18.0). The old `port === 80 || port === 443` test
    // consulted no scheme and elided 443-on-http and 80-on-https.
    const authorityHeader = typeof opts['authority'] === 'string'
        ? (opts['authority'] as string)
        : `${urlHost}:${urlPort}`;

    // options.host/port redirect the dial without changing :authority — Node
    // passes them through to net/tls.connect (measured: connect(url, {port})
    // dials `port` and still sends the URL's authority).
    const dialHostRaw = opts['host'] ?? opts['hostname'];
    const host = typeof dialHostRaw === 'string' && dialHostRaw ? dialHostRaw : urlHost;
    let port = urlPort;
    if (opts['port'] !== undefined && opts['port'] !== null) {
        const p = Number(opts['port']);
        if (!Number.isInteger(p) || p < 0 || p > 65535) {
            throw Object.assign(
                new RangeError(`Invalid port: ${String(opts['port'])}`),
                { code: 'ERR_SOCKET_BAD_PORT' },
            );
        }
        port = p;
    }

    return { protocol, host, port, secure, authority: authorityHeader };
}

export function connect(
    authority: string | URL,
    options?: Record<string, unknown> | ((session: ClientHttp2Session, socket: Socket) => void),
    listener?: (session: ClientHttp2Session, socket: Socket) => void,
): ClientHttp2Session {
    let opts: Record<string, unknown> = {};
    let cb = listener;
    if (typeof options === 'function') {
        cb = options;
        opts = {};
    } else if (options) {
        opts = options;
    }

    // Argument validation FIRST: a caller with a bad authority deserves the
    // argument error, not a build-configuration message, and it makes the
    // validation order observable in builds without the h2 extension.
    const target = __resolveConnectTarget(authority, opts);
    if (cb !== undefined && typeof cb !== 'function') {
        throw invalidArgType('listener', 'of type function', cb);
    }
    ensureH2();

    const { host, port, secure } = target;

    const session = new ClientHttp2Session(opts['settings'] as Record<string, unknown> | undefined);
    if (cb) session.once('connect', cb as (session: ClientHttp2Session, socket: Socket) => void);

    session.setAuthority(target.authority);

    if (secure) {
        const createConnection = opts['createConnection'];
        if (typeof createConnection === 'function') {
            const sock = createConnection(opts, () => {}) as Socket | TLSSocket;
            const attach = () => {
                try {
                    if (isTlsSocket(sock)) session.attachTls(sock);
                    else session.attach(sock as Socket, true);
                } catch (e) {
                    session.emit('error', e);
                }
            };
            if (isTlsSocket(sock) && sock.alpnProtocol) {
                queueMicrotask(attach);
            } else {
                sock.once('secureConnect', attach);
                sock.once('connect', attach);
                if ((sock as Socket).readyState === 'open' && isTlsSocket(sock) && sock._handshakeComplete) {
                    queueMicrotask(attach);
                }
            }
            sock.on('error', err => session.emit('error', err));
            return session;
        }

        const tlsSocket = tls.connect({
            host,
            port,
            servername: (opts['servername'] as string) ?? host,
            rejectUnauthorized: (opts['rejectUnauthorized'] as boolean | undefined) ?? true,
            ca: opts['ca'] as string | Buffer | undefined,
            cert: opts['cert'] as string | Buffer | undefined,
            key: opts['key'] as string | Buffer | undefined,
            ALPNProtocols: (opts['ALPNProtocols'] as string[]) ?? ['h2'],
        }, () => {
            try {
                session.attachTls(tlsSocket);
            } catch (e) {
                session.emit('error', e);
            }
        });
        tlsSocket.on('error', err => session.emit('error', err));
        return session;
    }

    const socket = netConnect({ port, host }, () => {
        session.attach(socket, false);
    });
    socket.on('error', err => session.emit('error', err));
    return session;
}
