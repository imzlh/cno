/**
 * Node.js net module — public surface.
 * Based on CModuleStreams for TCP networking.
 *
 * This file is a facade: the implementation lives in the sibling modules listed
 * below, and the export list here IS the public API. It is deliberately spelled
 * out name by name rather than using `export *`, because the submodules also
 * export internals to each other (socket-option setters, listen-error shapers,
 * the shared IPv6 parser) and `export *` would silently publish those as
 * `node:net` exports.
 *
 *   types.ts       every interface/type: AddressInfo, connect/listen options,
 *                  UpgradeHandle, HttpOwnedTransport, Socket/Server shapes
 *   _shared.ts     socket-option setters, quiet-cleanup wrappers, toListenError,
 *                  deferTick / emitListeningAsync, flattenPrototype; port
 *                  validation, family normalisation, connect-time DNS;
 *                  isIP / isIPv4 / isIPv6 + the shared IPv6 parser
 *   socket.ts      Socket ctor + prototype; owns kNetClientSocketPublished and
 *                  the order-sensitive Duplex.prototype.write capture
 *   server.ts      Server ctor + prototype, accept loops, close sequencing;
 *                  owns the listen-only `forcePipePath` flag
 *   blocklist.ts   BlockList, SocketAddress
 *
 * Load order matters: ./socket captures `Duplex.prototype.write` at evaluation
 * time, so `../stream` must already be fully evaluated when it runs. Importing
 * ./server first (as the factories below need) pulls ./socket, which pulls
 * ../stream — the same order the single-file version produced.
 */

import { Server } from './server';
import { Socket } from './socket';
import type { NetConnectOpts, ServerOpts } from './types';

// Factory functions

export function createServer(options?: ServerOpts, connectionListener?: (socket: Socket) => void): Server {
    return new Server(options, connectionListener);
}

export function connect(options: NetConnectOpts, connectListener?: () => void): Socket;
export function connect(port: number, host?: string, connectListener?: () => void): Socket;
export function connect(path: string, connectListener?: () => void): Socket;
export function connect(portOrPath: number | string | NetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): Socket {
    const socket = new Socket();
    if (typeof portOrPath === 'object') {
        socket.connect(portOrPath, typeof hostOrCb === 'function' ? hostOrCb : undefined);
    } else if (typeof portOrPath === 'number') {
        if (typeof hostOrCb === 'string') {
            socket.connect(portOrPath, hostOrCb, cb);
        } else {
            socket.connect(portOrPath, 'localhost', hostOrCb as (() => void) | undefined);
        }
    } else {
        socket.connect(portOrPath, hostOrCb as (() => void) | undefined);
    }
    return socket;
}

export function createConnection(options: NetConnectOpts, connectListener?: () => void): Socket;
export function createConnection(port: number, host?: string, connectListener?: () => void): Socket;
export function createConnection(path: string, connectListener?: () => void): Socket;
export function createConnection(portOrPath: number | string | NetConnectOpts, hostOrCb?: string | (() => void), cb?: () => void): Socket {
    if (typeof portOrPath === 'object') {
        return connect(portOrPath, typeof hostOrCb === 'function' ? hostOrCb : undefined);
    }
    if (typeof portOrPath === 'number') {
        return typeof hostOrCb === 'string'
            ? connect(portOrPath, hostOrCb, cb)
            : connect(portOrPath, 'localhost', hostOrCb);
    }
    return connect(portOrPath, hostOrCb as (() => void) | undefined);
}

// Re-exports — the public `node:net` surface.

export type {
    AddressInfo,
    SocketConstructorOpts,
    TcpNetConnectOpts,
    IpcNetConnectOpts,
    NetConnectOpts,
    ServerOpts,
    ListenOptions,
    UpgradeHandle,
    HttpOwnedTransport,
    SocketConstructor,
    ServerConstructor,
} from './types';

export { Socket } from './socket';
export { Server } from './server';

export { BlockList, SocketAddress, type SocketAddressInit } from './blocklist';

export { isIP, isIPv4, isIPv6 } from './_shared';
