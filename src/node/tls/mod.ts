/**
 * Node.js tls module
 * Built on CModuleSSL (OpenSSL) + Duplex stream for TLS/SSL
 * TLSSocket is a full Duplex, accepts any underlying Duplex stream
 */

/**
 * This file is a facade: the implementation lives in the sibling modules listed
 * below, and the export list here IS the public API. It is deliberately spelled
 * out name by name rather than using `export *`, because the submodules also
 * export internals to each other (PEM converters, the prototype flattener, the
 * error factories, the CA cache) and `export *` would silently publish those as
 * `node:tls` exports.
 *
 *   types.ts     every interface/type, plus the TLSSocket / Server *shapes*
 *   errors.ts    X509_V_ERR_* -> Node `code` table, verify-error factories,
 *                checkServerIdentity, nameFailureError, cipher/version constants
 *   _shared.ts   PEM/byte helpers, ALPN normalisation, quiet cleanup,
 *                flattenPrototype, and the CA trust state: system-store cache
 *                + override set + flag
 *   context.ts   SecureContext, the JS-stream adapter, the secureContext merge
 *   socket.ts    TLSSocket ctor + prototype
 *   server.ts    Server ctor + prototype, createServer
 *
 * Load order: ./socket sets its prototype from `Duplex.prototype` and ./server
 * from `EventEmitter.prototype` at evaluation time, so ../stream and ../events
 * must already be evaluated when they run. Importing ./socket (as connect()
 * below does) pulls ../stream — the same order the single-file version produced.
 */

import { mergeSuppliedSecureContext } from './context';
import { TLSSocket } from './socket';
import type { TlsConnectOptions } from './types';

const streams = import.meta.use('streams');
const os = import.meta.use('os');
const dns = import.meta.use('dns');

export function connect(options: TlsConnectOptions, secureConnectListener?: () => void): TLSSocket;
export function connect(port: number, host?: string, options?: TlsConnectOptions, secureConnectListener?: () => void): TLSSocket;
export function connect(port: number, options?: TlsConnectOptions, secureConnectListener?: () => void): TLSSocket;
export function connect(
    portOrOptions: number | TlsConnectOptions,
    hostOrOptions?: string | TlsConnectOptions | (() => void),
    optionsOrCb?: TlsConnectOptions | (() => void),
    cb?: () => void
): TLSSocket {
    let port: number | undefined;
    let host: string = 'localhost';
    let options: TlsConnectOptions = {};
    let secureConnectListener: (() => void) | undefined;

    if (typeof portOrOptions === 'object') {
        options = portOrOptions;
        port = options.port;
        host = options.host ?? 'localhost';
        if (typeof hostOrOptions === 'function') {
            secureConnectListener = hostOrOptions;
        }
    } else {
        port = portOrOptions;
        if (typeof hostOrOptions === 'string') {
            host = hostOrOptions;
            if (typeof optionsOrCb === 'function') {
                secureConnectListener = optionsOrCb;
            } else if (optionsOrCb) {
                options = optionsOrCb;
                if (typeof cb === 'function') secureConnectListener = cb;
            }
        } else if (hostOrOptions) {
            if (typeof hostOrOptions === 'function') {
                secureConnectListener = hostOrOptions;
            } else {
                options = hostOrOptions;
                if (typeof optionsOrCb === 'function') secureConnectListener = optionsOrCb;
            }
        }
    }

    const secureContext = mergeSuppliedSecureContext(options.secureContext, {
        mode: 'client',
        verify: options.rejectUnauthorized ?? true,
        // See initTLSSocket: a caller-supplied checkServerIdentity replaces the
        // built-in name check, so the C-layer SSL_set1_host check must not
        // pre-empt it by failing the handshake first.
        verifyHostname: (options.rejectUnauthorized ?? true)
            && !!(options.servername ?? host)
            && !options.checkServerIdentity,
        key: options.key,
        cert: options.cert,
        ca: options.ca,
        ciphers: options.ciphers,
        minVersion: options.minVersion,
        maxVersion: options.maxVersion,
        dhparam: options.dhparam,
        ecdhCurve: options.ecdhCurve,
        ALPNProtocols: options.ALPNProtocols,
    });

    // If an existing socket was provided, upgrade it
    if (options.socket) {
        const tlsSocket = new TLSSocket(options.socket, {
            isServer: false,
            rejectUnauthorized: options.rejectUnauthorized ?? true,
            secureContext,
            servername: options.servername ?? host,
            ALPNProtocols: options.ALPNProtocols,
            checkServerIdentity: options.checkServerIdentity,
            start: true,
        });

        tlsSocket.on('secureConnect', () => {
            if (secureConnectListener) secureConnectListener();
        });

        return tlsSocket;
    }

    // Otherwise create a new TCP connection
    if (port === undefined) throw new TypeError('tls.connect requires a port when socket is not provided');
    const connectPort = port;
    const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
    const tcp = new streams.TCP(family);

    const tlsSocket = new TLSSocket(tcp, {
        isServer: false,
        rejectUnauthorized: options.rejectUnauthorized ?? true,
        secureContext,
        servername: options.servername ?? host,
        ALPNProtocols: options.ALPNProtocols,
        checkServerIdentity: options.checkServerIdentity,
        start: false,
    });

    // Attach secureConnect listener BEFORE initiating connection to avoid race
    // condition where handshake completes before .then() callback runs.
    if (secureConnectListener) {
        tlsSocket.on('secureConnect', () => {
            secureConnectListener();
        });
    }

    const connectAndHandshake = async () => {
        try {
            const isIPv6 = host.includes(':');
            const lookupFamily = isIPv6 ? 6 : 4;
            let ip = host;
            if (options.lookup) {
                ip = await new Promise<string>((resolve, reject) => {
                    options.lookup!(host, { family: lookupFamily }, (err, address, _family) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve(address);
                    });
                });
            } else {
                const addrs = await dns.resolve(host, { family: isIPv6 ? os.AF_INET6 : os.AF_INET });
                const addr = addrs?.find((a: CModuleDNS.ResolvedAddress) => a.family === lookupFamily) || addrs?.[0];
                if (!addr) throw new Error(`DNS resolution failed for ${host}`);
                ip = addr.ip;
            }
            await tcp.connect({ ip, port: connectPort });
            const localInfo = tcp.sockname;
            tlsSocket.localAddress = localInfo.ip;
            tlsSocket.localPort = localInfo.port;
            const remoteInfo = tcp.peername;
            tlsSocket.remoteAddress = remoteInfo.ip;
            tlsSocket.remotePort = remoteInfo.port;
            tlsSocket.remoteFamily = `IPv${remoteInfo.family}`;
            tlsSocket._initTls();
        } catch (err) {
            tlsSocket.emit('error', err);
            tlsSocket.destroy();
        }
    };
    connectAndHandshake();

    return tlsSocket;
}

// Re-exports — the public `node:tls` surface.

export type {
    TlsKeyInput,
    TlsCertInput,
    TlsOptions,
    SecureContextOptions,
    SecurePair,
    TlsConnectOptions,
    TlsServerOptions,
    PeerCertificate,
    TLSSocketConstructor,
    ServerConstructor,
} from './types';

export { SecureContext, createSecureContext } from './context';

export { TLSSocket } from './socket';

export { Server, createServer } from './server';

export { rootCertificates, setDefaultCACertificates } from './_shared';

export {
    DEFAULT_CIPHERS,
    DEFAULT_ECDH_CURVE,
    DEFAULT_MIN_VERSION,
    DEFAULT_MAX_VERSION,
    getCiphers,
    convertProtocols,
    checkServerIdentity,
} from './errors';
