/**
 * node:net Server — bind/listen, the accept loops (TCP and pipe), connection
 * tracking, and close sequencing.
 *
 * Holds one piece of module-level mutable state, `forcePipePath`, used only by
 * Server.prototype.listen; see the comment at its declaration.
 */

const streams = import.meta.use('streams');
const os = import.meta.use('os');

import { EventEmitter } from '../events';
import { matchesErrnoCode, normalizeErrnoError } from '../_internal/errno';
import { onNetServerSocket } from '../diagnostics_channel/builtins';
import {
    closePipeQuietly,
    emitListenErrorAsync,
    emitListeningAsync,
    flattenPrototype,
    normalizeTcpHost,
    toListenError,
} from './_shared';
import { Socket } from './socket';
import type {
    AddressInfo,
    ListenOptions,
    Server as ServerShape,
    ServerConstructor,
    ServerOpts,
} from './types';

export interface Server extends ServerShape {}

function initServer(self: Server, options?: ServerOpts | ((socket: Socket) => void), connectionListener?: (socket: Socket) => void): void {
    EventEmitter.call(self);

    self._tcp = null;
    self._pipe = null;
    self._listening = false;
    self._connections = new Set();
    self._maxConnections = 0;
    self._allowHalfOpen = false;
    self._pauseOnConnect = false;
    // Node mirrors both onto the Server as public readable properties. They were
    // `undefined` here, which reads as "not half-open" only by accident and
    // fails an `=== false` check. Set alongside the private flags so the two can
    // never drift, including on the createServer(cb) and no-options paths.
    self.allowHalfOpen = false;
    self.pauseOnConnect = false;
    self._keepAlive = false;
    self._keepAliveDelay = 0;
    self._noDelay = false;
    self._address = null;
    self._closing = false;
    self._handleClosed = true;
    self._closeCallbacks = [];

    self.connections = 0;

    if (typeof options === 'function') {
        connectionListener = options;
        options = {};
    }

    if (options && typeof options === 'object') {
        self._allowHalfOpen = options.allowHalfOpen ?? false;
        self._pauseOnConnect = options.pauseOnConnect ?? false;
        self._keepAlive = options.keepAlive ?? false;
        self._keepAliveDelay = options.keepAliveInitialDelay ?? 0;
        self._noDelay = options.noDelay ?? false;
        self.allowHalfOpen = self._allowHalfOpen;
        self.pauseOnConnect = self._pauseOnConnect;
        if (options.signal) {
            const closeOnAbort = () => {
                if (self._listening) self.close();
            };
            if (options.signal.aborted) queueMicrotask(closeOnAbort);
            else options.signal.addEventListener('abort', closeOnAbort, { once: true });
        }
    }

    if (connectionListener) {
        self.on('connection', connectionListener);
    }
}

export const Server: ServerConstructor = function Server(
    this: Server | undefined,
    options?: ServerOpts | ((socket: Socket) => void),
    connectionListener?: (socket: Socket) => void
) {
    const target: Server = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Server.prototype);
    initServer(target, options, connectionListener);
    return target;
} as ServerConstructor;

Object.setPrototypeOf(Server, EventEmitter);
Server.prototype = Object.create(EventEmitter.prototype);

Object.defineProperty(Server.prototype, 'listening', {
    get(this: Server): boolean { return this._listening; },
    enumerable: true,
    configurable: true,
});

function finishServerClose(server: Server): void {
    if (!server._closing || !server._handleClosed || server._connections.size !== 0) return;
    server._closing = false;
    const callbacks = server._closeCallbacks.splice(0);
    server.emit('close');
    for (const callback of callbacks) callback();
}

function trackServerSocket(server: Server, socket: Socket): boolean {
    const maxConnections = server.maxConnections;
    if (typeof maxConnections === 'number' && maxConnections >= 0 && server._connections.size >= maxConnections) {
        const dropInfo = {
            localAddress: socket.localAddress,
            localPort: socket.localPort,
            localFamily: socket._address?.family,
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            remoteFamily: socket.remoteFamily,
        };
        socket.destroy();
        server.emit('drop', dropInfo);
        return false;
    }

    server._connections.add(socket);
    server.connections = server._connections.size;
    socket.once('close', () => {
        server._connections.delete(socket);
        server.connections = server._connections.size;
        finishServerClose(server);
    });
    return true;
}

function configureAcceptedSocket(server: Server, socket: Socket): void {
    if (server._noDelay) socket.setNoDelay(true);
    if (server._keepAlive) socket.setKeepAlive(true, server._keepAliveDelay);
    if (server._pauseOnConnect) socket.pause();
}

// Set only for the internal listen({path}) -> listen(path) hop below, so that
// an explicit `path` which happens to look numeric (e.g. {path:'8080'}) is NOT
// coerced into a TCP port by the normalization in listen(). Safe as a module
// flag because listen() is synchronous and consumes/clears it on entry.
let forcePipePath = false;

// Node's `isPipeName`: a string is a PATH only if it does not look numeric.
// `listen('8080')` therefore binds TCP port 8080 — and `listen(process.env.PORT)`
// is the single most common form of that, since env vars are always strings.
// cno treated every string as a pipe path, so it bound a pipe literally named
// "8080" and failed EACCES. Measured: node LISTENED boundPort=8080.
function looksNumeric(value: string): boolean {
    if (value.length === 0) return false;
    return !Number.isNaN(Number(value));
}

// Node throws RangeError ERR_SOCKET_BAD_PORT synchronously:
//   options.port should be >= 0 and < 65536. Received type number (-1).
// cno performed NO validation, so the value went straight to bind() and was
// silently coerced by the C layer — measured misbinds:
//   listen(-1)    -> bound 65535       listen(65536) -> bound an ephemeral port
//   listen(1.5)   -> bound 1           listen(NaN)   -> bound an ephemeral port
// A server asked for one port and silently listening on another is a security
// as well as a correctness problem.
function validateListenPort(value: unknown): number {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535) {
        return value;
    }
    const shown = typeof value === 'number' ? String(value) : JSON.stringify(value);
    throw Object.assign(
        new RangeError(`options.port should be >= 0 and < 65536. Received type ${typeof value} (${shown}).`),
        { code: 'ERR_SOCKET_BAD_PORT' },
    );
}

Server.prototype.listen = function listen(
    this: Server,
    portOrPathOrOptions?: unknown,
    ...args: Array<string | number | (() => void)>
): Server {
    if (this._listening || this._closing) {
        throw Object.assign(new Error('Listen method has been called more than once without closing'), {
            code: 'ERR_SERVER_ALREADY_LISTEN',
        });
    }

    let port: number | undefined;
    let host: string = '0.0.0.0';
    let backlog: number = 511;
    let listeningListener: (() => void) | undefined;
    let ipv6Only: boolean = false;

    // Normalize the first argument the way Node's normalizeArgs does, BEFORE
    // dispatching on its type. Measured on Node v24.18:
    //   listen(undefined) / listen(null) -> bind an ephemeral port (cno: hung
    //     silently — no 'listening', no 'error', nothing at all)
    //   listen('8080')                   -> TCP port 8080, not a pipe
    //   listen(true) / listen({})        -> throw ERR_INVALID_ARG_VALUE
    // Consume the explicit-path flag on entry so it can never leak into a later
    // call, even if this one throws.
    const explicitPipePath = forcePipePath;
    forcePipePath = false;

    if (typeof portOrPathOrOptions === 'function') {
        // listen(cb): Node's normalizeArgs peels a leading callback and binds an
        // ephemeral port. cno previously fell through to the object/path branch,
        // which DID listen but never registered the callback — the server came
        // up while the caller's readiness handler silently never ran.
        listeningListener = portOrPathOrOptions as () => void;
        portOrPathOrOptions = 0;
    } else if (portOrPathOrOptions === undefined || portOrPathOrOptions === null) {
        portOrPathOrOptions = 0;
    } else if (
        typeof portOrPathOrOptions === 'string'
        && !explicitPipePath
        && looksNumeric(portOrPathOrOptions)
    ) {
        portOrPathOrOptions = Number(portOrPathOrOptions);
    } else if (
        typeof portOrPathOrOptions === 'boolean'
        || typeof portOrPathOrOptions === 'bigint'
        || typeof portOrPathOrOptions === 'symbol'
    ) {
        throw Object.assign(
            new TypeError(`The argument 'options' is invalid. Received { port: ${String(portOrPathOrOptions)} }`),
            { code: 'ERR_INVALID_ARG_VALUE' },
        );
    }

    if (typeof portOrPathOrOptions === 'number') {
        port = validateListenPort(portOrPathOrOptions);
        for (const arg of args) {
            if (typeof arg === 'string') host = arg;
            else if (typeof arg === 'number') backlog = arg;
            else if (typeof arg === 'function') listeningListener = arg;
        }
    } else if (typeof portOrPathOrOptions === 'string') {
        const pipePath = portOrPathOrOptions;
        for (const arg of args) {
            if (typeof arg === 'number') backlog = arg;
            else if (typeof arg === 'function') listeningListener = arg;
        }
        this._pipe = new streams.Pipe();
        try {
            this._handleClosed = false;
            this._pipe.bind(pipePath);
            this._pipe.listen(backlog ?? 511);
            this._pipe.onconnection = (error: CModuleError.Error | undefined, client: CModuleStreams.Stream | undefined) => {
                if (error) {
                    if (!this._listening || matchesErrnoCode(error, 'ECANCELED', 'EBADF')) return;
                    // Raw native errors carry a NUMERIC `.code`; normalize so
                    // `err.code === 'EMFILE'` works as it does in Node.
                    this.emit('error', normalizeErrnoError(error, 'accept'));
                    return;
                }
                if (!client) return;
                const socket = new Socket({ allowHalfOpen: this._allowHalfOpen });
                socket._stream = client as CModuleStreams.Pipe;
                socket.readyState = 'open';
                if (!trackServerSocket(this, socket)) return;
                configureAcceptedSocket(this, socket);
                this.emit('connection', socket);
                // Node publishes net.server.socket directly after emit('connection').
                if (onNetServerSocket.hasSubscribers) {
                    onNetServerSocket.publish({ socket });
                }
                if (!this._pauseOnConnect && !socket._destroyed) socket._startPipeRead();
            };
            // Node returns the bare path string from address() for a pipe
            // server, not an AddressInfo object (verified on real Node v24.18).
            this._address = pipePath;
            this._listening = true;
            if (listeningListener) this.once('listening', listeningListener);
            emitListeningAsync(this);
        } catch (err) {
            this._handleClosed = true;
            closePipeQuietly(this._pipe);
            emitListenErrorAsync(this, toListenError(err, pipePath));
        }
        return this;
    } else if (portOrPathOrOptions && typeof portOrPathOrOptions === 'object') {
        const options = portOrPathOrOptions as ListenOptions;
        if (options.path !== undefined) {
            const listener = typeof args[0] === 'function' ? args[0] : undefined;
            // An explicit path stays a path even if it looks numeric.
            forcePipePath = true;
            const server = listener
                ? this.listen(options.path, options.backlog ?? 511, listener)
                : this.listen(options.path, options.backlog ?? 511);
            forcePipePath = false;
            if (options.signal) {
                if (options.signal.aborted) queueMicrotask(() => server.close());
                else options.signal.addEventListener('abort', () => server.close(), { once: true });
            }
            return server;
        }
        // Node validates options.port identically to the positional form:
        // `listen({port:-1})` throws RangeError ERR_SOCKET_BAD_PORT.
        port = options.port === undefined || options.port === null
            ? 0
            : validateListenPort(
                typeof options.port === 'string' && looksNumeric(options.port)
                    ? Number(options.port)
                    : options.port,
            );
        host = options.host ?? '0.0.0.0';
        backlog = options.backlog ?? 511;
        ipv6Only = options.ipv6Only ?? false;
        if (typeof args[0] === 'function') listeningListener = args[0];
        if (options.signal) {
            if (options.signal.aborted) queueMicrotask(() => this.close());
            else options.signal.addEventListener('abort', () => this.close(), { once: true });
        }
    }

    host = normalizeTcpHost(host);
    const family = host.includes(':') ? os.AF_INET6 : os.AF_INET;
    this._tcp = new streams.TCP(family);

    try {
        this._handleClosed = false;
        this._tcp.bind({ ip: host, port: port ?? 0 }, ipv6Only ? streams.TCP_IPV6ONLY : 0);
        this._tcp.listen(backlog);
        const info = this._tcp.sockname;
        this._address = {
            address: info.ip,
            family: `IPv${info.family}`,
            port: info.port,
        };

        this._listening = true;
        this._acceptLoop().catch((err) => {
            if (this._listening) this.emit('error', normalizeErrnoError(err, 'accept'));
        });
        // Node registers the listen callback as a one-shot 'listening' listener
        // *inside* listen(), so a pre-existing s.on('listening') handler runs
        // first; then it emits on the next tick, never inline.
        if (listeningListener) this.once('listening', listeningListener);
        emitListeningAsync(this);
    } catch (err) {
        // Close the handle before surfacing the error: close() refuses to run
        // (ERR_SERVER_NOT_RUNNING) while _listening is false, so the common
        // EADDRINUSE retry idiom would overwrite _tcp and leak this fd.
        this._handleClosed = true;
        try { this._tcp?.close(); } catch { /* already gone */ }
        emitListenErrorAsync(this, toListenError(err, host, port ?? 0));
        return this;
    }

    return this;
};

Server.prototype._acceptLoop = function _acceptLoop(this: Server): Promise<void> {
    const tcp = this._tcp;
    if (!tcp) return Promise.resolve();
    return new Promise((rs, rj) => tcp.onconnection = (error, clientTcp) => {
        if (error || !clientTcp) {
            if (!this._listening || matchesErrnoCode(error, 'ECANCELED', 'EBADF')) return rs();
            return rj(error);
        }
        if (!this._listening) return rs();

        const socket = new Socket({ allowHalfOpen: this._allowHalfOpen });
        socket._tcp = clientTcp;
        socket.readyState = 'open';

        const localInfo = (clientTcp as CModuleStreams.TCP).sockname;
        socket.localAddress = localInfo.ip;
        socket.localPort = localInfo.port;
        socket.localFamily = `IPv${localInfo.family}`;

        const remoteInfo = (clientTcp as CModuleStreams.TCP).peername;
        socket.remoteAddress = remoteInfo.ip;
        socket.remotePort = remoteInfo.port;
        socket.remoteFamily = `IPv${remoteInfo.family}`;
        socket._address = {
            address: localInfo.ip,
            family: `IPv${localInfo.family}`,
            port: localInfo.port,
        };
        socket._remoteAddress = {
            address: remoteInfo.ip,
            family: `IPv${remoteInfo.family}`,
            port: remoteInfo.port,
        };

        if (!trackServerSocket(this, socket)) return;
        configureAcceptedSocket(this, socket);

        this.emit('connection', socket);

        // Node publishes net.server.socket directly after emit('connection').
        if (onNetServerSocket.hasSubscribers) {
            onNetServerSocket.publish({ socket });
        }

        if (!this._pauseOnConnect && !socket._destroyed) {
            socket._startTcpRead();
        }
    });
};

Server.prototype.address = function address(this: Server): AddressInfo | string | null {
    if (!this._address) return null;
    return this._address;
};

Server.prototype.getConnections = function getConnections(this: Server, cb: (err: Error | null, count: number) => void): void {
    cb(null, this._connections.size);
};

Server.prototype.close = function close(this: Server, callback?: (err?: Error) => void): Server {
    if (this._closing) {
        if (callback) this._closeCallbacks.push(callback);
        return this;
    }
    if (!this._listening) {
        if (callback) {
            const error = Object.assign(new Error('Server is not running'), { code: 'ERR_SERVER_NOT_RUNNING' });
            queueMicrotask(() => callback(error));
        }
        return this;
    }

    this._listening = false;
    this._closing = true;
    this._address = null;
    if (callback) this._closeCallbacks.push(callback);

    const handles: Array<CModuleStreams.TCP | CModuleStreams.Pipe> = [];
    if (this._tcp) handles.push(this._tcp);
    if (this._pipe) handles.push(this._pipe);
    let pendingHandles = handles.length;
    this._handleClosed = pendingHandles === 0;

    const onHandleClose = (): void => {
        pendingHandles--;
        if (pendingHandles === 0) {
            this._handleClosed = true;
            finishServerClose(this);
        }
    };

    if (this._tcp) {
        const handle = this._tcp;
        handle.onclose = onHandleClose;
        try {
            handle.close();
        } catch {
            onHandleClose();
        }
        this._tcp = null;
    }
    if (this._pipe) {
        const handle = this._pipe;
        handle.onclose = onHandleClose;
        try {
            handle.close();
        } catch {
            onHandleClose();
        }
        this._pipe = null;
    }

    finishServerClose(this);

    return this;
};

Server.prototype.ref = function ref(this: Server): Server {
    if (this._tcp) this._tcp.ref();
    if (this._pipe) this._pipe.ref();
    return this;
};

Server.prototype.unref = function unref(this: Server): Server {
    if (this._tcp) this._tcp.unref();
    if (this._pipe) this._pipe.unref();
    return this;
};

Object.defineProperty(Server.prototype, 'constructor', {
    value: Server,
    writable: true,
    configurable: true,
});

flattenPrototype(Server.prototype);
