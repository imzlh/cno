/*
 * Facade for node:net; the export list is the public API and is spelled out
 * rather than `export *`, because submodules export internals to each other.
 * Keep ./server imported first: it pulls ./socket, which captures
 * `Duplex.prototype.write` at evaluation time and needs ../stream loaded first.
 */

import { Server } from './server';
import { Socket } from './socket';
import type { NetConnectOpts, ServerOpts } from './types';

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
