/**
 * node:tls Server — one net.Server per TLS server, wrapping each accepted socket
 * in a TLSSocket and re-emitting 'secureConnection' / 'tlsClientError'.
 *
 * `Server` is a merged type+value name; see the note in ./socket for why the
 * shape interface lives in ./types and the empty extension lives here.
 */

import { EventEmitter } from '../events';
import { Server as NetServer } from '../net';
import type { Socket as NetSocket, ListenOptions as NetListenOptions } from '../net';
import { SecureContext } from './context';
import { TLSSocket } from './socket';
import { flattenPrototype } from './_shared';
import type {
    Server as ServerShape,
    ServerConstructor,
    ServerListenArgs,
    TlsServerOptions,
} from './types';

export interface Server extends ServerShape {}

function initServer(
    self: Server,
    optionsOrListener?: TlsServerOptions | ((socket: TLSSocket) => void),
    secureConnectionListener?: (socket: TLSSocket) => void
): void {
    EventEmitter.call(self);

    self._connections = new Set<TLSSocket>();
    self._listening = false;
    self._allowHalfOpen = false;
    self._requestCert = false;
    self._rejectUnauthorized = true;

    self.maxConnections = 0;
    self.connections = 0;

    let options: TlsServerOptions = {};
    if (typeof optionsOrListener === 'function') {
        secureConnectionListener = optionsOrListener;
    } else if (optionsOrListener) {
        options = optionsOrListener;
    }

    self._allowHalfOpen = options.allowHalfOpen ?? false;
    self._requestCert = options.requestCert ?? false;
    self._rejectUnauthorized = options.rejectUnauthorized ?? true;

    self._secureContext = new SecureContext({
        mode: 'server',
        key: options.key,
        cert: options.cert,
        ca: options.ca,
        ciphers: options.ciphers,
        minVersion: options.minVersion,
        maxVersion: options.maxVersion,
        dhparam: options.dhparam,
        ecdhCurve: options.ecdhCurve,
        ALPNProtocols: options.ALPNProtocols,
        // Without this the server context ran with SSL_VERIFY_NONE, so
        // requestCert never produced a CertificateRequest and every anonymous
        // client was accepted (and reported authorized).
        verify: self._requestCert && self._rejectUnauthorized,
    });

    if (secureConnectionListener) {
        self.on('secureConnection', secureConnectionListener);
    }

    // TLS owns the accepted socket's read pump. Pause the underlying TCP
    // socket at accept time so plaintext bytes are not consumed before
    // TLSSocket installs its handshake reader.
    self._netServer = new NetServer({ allowHalfOpen: self._allowHalfOpen, pauseOnConnect: true });
    self._netServer.on('connection', (socket: NetSocket) => {
        const tlsSocket = new TLSSocket(socket, {
            isServer: true,
            rejectUnauthorized: self._rejectUnauthorized,
            requestCert: self._requestCert,
            secureContext: self._secureContext,
            ALPNProtocols: options.ALPNProtocols,
        });
        queueMicrotask(() => {
            if (!tlsSocket.destroyed) socket.resume();
        });

        self._connections.add(tlsSocket);
        self.connections = self._connections.size;

        tlsSocket.on('close', () => {
            self._connections.delete(tlsSocket);
            self.connections = self._connections.size;
        });

        tlsSocket.on('secureConnect', () => {
            self.emit('secureConnection', tlsSocket);
        });

        tlsSocket.on('error', (err: Error) => {
            self.emit('tlsClientError', err, tlsSocket);
        });
    });

    self._netServer.on('listening', () => {
        self._listening = true;
        self.emit('listening');
    });

    self._netServer.on('error', (err: Error) => {
        self.emit('error', err);
    });

    self._netServer.on('close', () => {
        self._listening = false;
        self.emit('close');
    });
}

export const Server: ServerConstructor = function Server(
    this: Server | undefined,
    optionsOrListener?: TlsServerOptions | ((socket: TLSSocket) => void),
    secureConnectionListener?: (socket: TLSSocket) => void
) {
    const target: Server = this ?? Object.create(Server.prototype);
    initServer(target, optionsOrListener, secureConnectionListener);
    return target;
} as ServerConstructor;

Object.setPrototypeOf(Server, EventEmitter);
Server.prototype = Object.create(EventEmitter.prototype);

Server.prototype.listen = function listen(this: Server, ...args: ServerListenArgs): Server {
    // Narrow to a single net overload: TS cannot resolve a spread of a *union*
    // tuple, and the forms differ only in which trailing args are present.
    const [first, ...rest] = args as [unknown, ...Array<string | number | (() => void)>];
    if (typeof first === 'number') this._netServer.listen(first, ...rest as []);
    else if (typeof first === 'string') this._netServer.listen(first, ...rest as []);
    else this._netServer.listen(first as NetListenOptions, ...rest as []);
    return this;
};

Server.prototype.address = function address(this: Server): { address: string; family: string; port: number } | string | null {
    return this._netServer.address();
};

Server.prototype.getConnections = function getConnections(this: Server, cb: (err: Error | null, count: number) => void): void {
    cb(null, this._connections.size);
};

Server.prototype.close = function close(this: Server, callback?: (err?: Error) => void): Server {
    for (const socket of this._connections) {
        socket.destroy();
    }
    this._connections.clear();
    this.connections = 0;

    this._netServer.close(callback);
    return this;
};

/** Stop accepting new TCP connections without destroying active TLS sockets. */
Server.prototype.closeGracefully = function closeGracefully(this: Server, callback?: (err?: Error) => void): Server {
    this._netServer.close(callback);
    return this;
};

Server.prototype.ref = function ref(this: Server): Server { this._netServer.ref(); return this; };
Server.prototype.unref = function unref(this: Server): Server { this._netServer.unref(); return this; };

Object.defineProperty(Server.prototype, 'listening', {
    get(this: Server) { return this._listening; },
    set(this: Server, val: boolean) { this._listening = val; },
    configurable: true,
});

Object.defineProperty(Server.prototype, 'constructor', {
    value: Server,
    writable: true,
    configurable: true,
});

flattenPrototype(Server.prototype);

// Factory functions

export function createServer(options?: TlsServerOptions, secureConnectionListener?: (socket: TLSSocket) => void): Server;
export function createServer(secureConnectionListener?: (socket: TLSSocket) => void): Server;
export function createServer(optionsOrListener?: TlsServerOptions | ((socket: TLSSocket) => void), secureConnectionListener?: (socket: TLSSocket) => void): Server {
    // Narrow to one ServerConstructor overload — TS cannot pick one for a union
    // argument, though initServer accepts both shapes at runtime.
    return typeof optionsOrListener === 'function'
        ? new Server(optionsOrListener)
        : new Server(optionsOrListener, secureConnectionListener);
}
