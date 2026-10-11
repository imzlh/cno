const nativeError = import.meta.use('error');

import { IPCChannel, type IPCSerialization } from '../ipc_channel';
import { EventEmitter } from '../events';
import { Writable, Readable, Duplex } from '../stream';
import {
    asError,
    destroyChildStdin,
    flattenPrototype,
    startPipeReadQuietly,
    stdioChunkBytes,
    stopPipeReadQuietly,
    streamEndPending,
    transformSignal,
    waitStreamEnd,
} from './_shared';
import type { ChildProcess as ChildProcessInterface, SpawnOptions } from './types';

export type ChildProcess = ChildProcessInterface;

export interface ChildProcessImpl extends ChildProcess {
    // Override the readonly modifiers inherited from ChildProcess — the
    // concrete implementation needs to mutate these internally.
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    spawnargs: string[];
    spawnfile: string;
    killed: boolean;
    connected: boolean;

    _process: CModuleProcess.ChildProcess | null;
    _killed: boolean;
    _exitCode: number | null;
    _signalCode: string | null;
    _stdin: Writable | null;
    _stdout: Readable | null;
    _stderr: Readable | null;
    _ipcChannel: IPCChannel | null;
    _messageQueue: unknown[];
    _init(process: CModuleProcess.ChildProcess, command: string, args: string[], options: SpawnOptions): void;
    _failSpawn(error: NodeJS.ErrnoException, stdioKinds?: (string | undefined)[]): void;
    _createWritable(pipe: CModuleStreams.Pipe): Writable;
    _createReadable(pipe: CModuleStreams.Pipe): Readable;
    _createDuplex(pipe: CModuleStreams.Pipe): Duplex;
    _waitExit(): Promise<void>;
    kill(signal?: string | number): boolean;
    disconnect(): void;
    unref(): void;
    ref(): void;
    send(message: unknown, sendHandle?: unknown, options?: unknown, callback?: (error: Error | null) => void): boolean;
    _setupIPC(pipe: CModuleStreams.Pipe, serialization?: IPCSerialization): void;
    _flushIPCMessages(): void;
}

export interface ChildProcessImplConstructor {
    new (): ChildProcessImpl;
    (): ChildProcessImpl;
    prototype: ChildProcessImpl;
}

function initChildProcessImpl(self: ChildProcessImpl): void {
    EventEmitter.call(self);
    self._process = null;
    self._killed = false;
    self._exitCode = null;
    self._signalCode = null;
    self._stdin = null;
    self._stdout = null;
    self._stderr = null;
    self._ipcChannel = null;
    self._messageQueue = [];

    self.stdin = null;
    self.stdout = null;
    self.stderr = null;
    self.stdio = [null, null, null];
    self.pid = 0;
    self.exitCode = null;
    self.signalCode = null;
    self.spawnargs = [];
    self.spawnfile = '';
    self.killed = false;
    self.connected = false;

    self.on('newListener', (eventName) => {
        if (eventName === 'message') queueMicrotask(() => self._flushIPCMessages());
    });
}

export const ChildProcessImpl: ChildProcessImplConstructor = function ChildProcessImpl(this: ChildProcessImpl | undefined) {
    const target: ChildProcessImpl = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(ChildProcessImpl.prototype);
    initChildProcessImpl(target);
    return target;
} as ChildProcessImplConstructor;

Object.setPrototypeOf(ChildProcessImpl, EventEmitter);
ChildProcessImpl.prototype = Object.create(EventEmitter.prototype);

ChildProcessImpl.prototype._init = function _init(this: ChildProcessImpl, process: CModuleProcess.ChildProcess, command: string, args: string[], options: SpawnOptions): void {
    this._process = process;
    this.pid = process.pid;
    this.spawnfile = command;
    this.spawnargs = [command, ...args];

    if (process.stdin) {
        this._stdin = this._createWritable(process.stdin);
        this.stdin = this._stdin;
    }

    if (process.stdout) {
        this._stdout = this._createReadable(process.stdout);
        this.stdout = this._stdout;
    }

    if (process.stderr) {
        this._stderr = this._createReadable(process.stderr);
        this.stderr = this._stderr;
    }

    this.stdio = [this.stdin, this.stdout, this.stderr];
    const extra = process.stdioExtra;
    if (Array.isArray(extra)) {
        for (let fd = 3; fd < extra.length; fd++) {
            const pipe = extra[fd];
            this.stdio[fd] = pipe ? this._createDuplex(pipe) : null;
        }
    }

    this._waitExit();
    queueMicrotask(() => this.emit('spawn'));
};

// Failed spawns still expose every requested pipe slot. Readables finish at EOF;
// stdin closes prematurely, matching the lifecycle of a failed child.
function makeFailedReadable(): Readable {
    const readable = new Readable({
        read() { /* EOF is pushed below, once. */ },
    });
    readable.push(null);
    // Flowing, so 'end' then 'close' reach a listener attached synchronously by
    // the caller on the same tick as the spawn call.
    readable.resume();
    return readable;
}

function makeFailedWritable(): Writable {
    const writable = new Writable({
        write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            callback();
        },
    });
    // Destroyed rather than ended, which is what makes finished() settle with
    // ERR_STREAM_PREMATURE_CLOSE exactly as Node's failed-spawn stdin does.
    // Deferred so a synchronous `.on('close', …)` still observes it.
    queueMicrotask(() => {
        try { writable.destroy(); } catch { /* already gone */ }
    });
    return writable;
}

function makeFailedDuplex(): Duplex {
    const duplex = new Duplex({
        read() { /* EOF is pushed below, once. */ },
        write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            callback();
        },
    });
    duplex.push(null);
    duplex.resume();
    return duplex;
}

ChildProcessImpl.prototype._failSpawn = function _failSpawn(this: ChildProcessImpl, error: NodeJS.ErrnoException, stdioKinds?: (string | undefined)[]): void {
    const errno = typeof error.errno === 'number' ? error.errno : null;

    // Build the 'pipe' slots before anything is emitted, so they exist by the
    // time the caller returns from spawn() and can be wired up synchronously.
    if (stdioKinds) {
        const isPipe = (kind: string | undefined) => kind === 'pipe';
        if (isPipe(stdioKinds[0])) {
            this._stdin = makeFailedWritable();
            this.stdin = this._stdin;
        }
        if (isPipe(stdioKinds[1])) {
            this._stdout = makeFailedReadable();
            this.stdout = this._stdout;
        }
        if (isPipe(stdioKinds[2])) {
            this._stderr = makeFailedReadable();
            this.stderr = this._stderr;
        }
        this.stdio = [this.stdin, this.stdout, this.stderr];
        for (let fd = 3; fd < stdioKinds.length; fd++) {
            this.stdio[fd] = isPipe(stdioKinds[fd]) ? makeFailedDuplex() : null;
        }
    }

    queueMicrotask(() => {
        this.emit('error', error);
        this._exitCode = errno;
        this.exitCode = errno;
        this.emit('close', errno, null);
    });
};

ChildProcessImpl.prototype._createWritable = function _createWritable(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Writable {
    return new Writable({
        write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            pipe.write(stdioChunkBytes(chunk)).then(() => callback()).catch(callback);
        },
        async final(callback: (error?: Error | null) => void) {
            try { await pipe.shutdown(); } catch { try { pipe.close(); } catch {} } finally { callback(); }
        },
        // destroy() skips final(), so it must close the native pipe itself.
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
            try { pipe.close(); } catch { /* already closed by the exiting child */ }
            callback(error);
        },
    });
};

ChildProcessImpl.prototype._createReadable = function _createReadable(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Readable {
    const readable = new Readable({
        read() {
            startPipeReadQuietly(pipe);
        },
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
            try { pipe.close(); } catch { /* already closed by the exiting child */ }
            callback(error);
        },
    });

    // Use callback-based read: pipe.onread pushes data into the Readable buffer
    pipe.onread = (data: Uint8Array | null | undefined, err?: unknown) => {
        if (err) {
            readable.destroy(asError(err));
            return;
        }
        if (data === null || data === undefined) {
            readable.push(null);
            stopPipeReadQuietly(pipe);
            return;
        }
        const ok = readable.push(data);
        if (!ok) {
            // Back-pressure: stop reading until Readable drains
            stopPipeReadQuietly(pipe);
        }
    };

    // Enter flowing mode so push() emits 'data' immediately.
    // Must be after onread is set — resume() calls _read() → startRead().
    readable.resume();
    return readable;
};

ChildProcessImpl.prototype._createDuplex = function _createDuplex(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Duplex {
    const duplex = new Duplex({
        read() {
            startPipeReadQuietly(pipe);
        },
        write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            pipe.write(stdioChunkBytes(chunk)).then(() => callback()).catch(callback);
        },
        async final(callback: (error?: Error | null) => void) {
            try { await pipe.shutdown(); } catch { try { pipe.close(); } catch {} } finally { callback(); }
        },
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
            try { pipe.close(); } catch { /* already closed by the exiting child */ }
            callback(error);
        },
    });

    pipe.onread = (data: Uint8Array | null | undefined, err?: unknown) => {
        if (err) {
            duplex.destroy(asError(err));
            return;
        }
        if (data === null || data === undefined) {
            duplex.push(null);
            stopPipeReadQuietly(pipe);
            return;
        }
        if (!duplex.push(data)) stopPipeReadQuietly(pipe);
    };

    duplex.resume();
    return duplex;
};

ChildProcessImpl.prototype._waitExit = async function _waitExit(this: ChildProcessImpl): Promise<void> {
    if (!this._process) return;

    try {
        const info = await this._process.wait();
        const exitCode = info.term_signal ? null : info.exit_status;
        this._exitCode = exitCode;
        this.exitCode = exitCode;
        this._signalCode = info.term_signal;
        this.signalCode = info.term_signal;

        // Exit listeners must observe destroyed stdin before its deferred close.
        destroyChildStdin(this._stdin);

        this.emit('exit', this._exitCode, this._signalCode);

        // Wait for output EOF without deferring close when no output is pending.
        const pending = [this._stdout, this._stderr].filter(streamEndPending);
        if (pending.length > 0) {
            await Promise.all(pending.map((stream) => waitStreamEnd(stream)));
        }
        this.emit('close', this._exitCode, this._signalCode);
    } catch (err) {
        this.emit('error', err);
    }
};

// Windows rejects some signals; retry those as SIGKILL using native errno values.
function isUnsupportedSignalError(err: unknown): boolean {
    const code = err instanceof Error ? Reflect.get(err, 'code') : undefined;
    if (typeof code === 'number') {
        return code === nativeError.errno.ENOSYS || code === nativeError.errno.EINVAL;
    }
    return code === 'ENOSYS' || code === 'EINVAL';
}

ChildProcessImpl.prototype.kill = function kill(this: ChildProcessImpl, signal?: string | number): boolean {
    if (this._killed || !this._process) return false;
    if (this._exitCode !== null || this._signalCode !== null) return false;

    const signum = transformSignal(signal);
    // kill(0) is a liveness probe in Node: it must not arm the "already killed"
    // guard, and must never fall through to the native SIGTERM default.
    if (signum !== 0) this._killed = true;
    this.killed = true;

    try {
        this._process.kill(signum);
        return true;
    } catch (err) {
        // Unsupported-signal fallback, matching Node. kill(0) must stay a probe.
        if (signum !== 0 && isUnsupportedSignalError(err)) {
            try {
                this._process.kill(transformSignal('SIGKILL'));
                return true;
            } catch { /* fall through to false */ }
        }
        return false;
    }
};

ChildProcessImpl.prototype.disconnect = function disconnect(this: ChildProcessImpl): void {
    // The channel's close handler emits disconnect; stdio remains independent.
    if (!this.connected || !this._ipcChannel) return;
    this._ipcChannel.close();
    this._ipcChannel = null;
};

ChildProcessImpl.prototype.unref = function unref(this: ChildProcessImpl): void {
    // Host child processes do not expose per-process loop refs yet.
};

ChildProcessImpl.prototype.ref = function ref(this: ChildProcessImpl): void {
    // Kept as the matching Node-compatible no-op for unref().
};

ChildProcessImpl.prototype.send = function send(this: ChildProcessImpl, message: unknown, _sendHandle?: unknown, _options?: unknown, callback?: (error: Error | null) => void): boolean {
    const cb = typeof _sendHandle === 'function'
        ? _sendHandle
        : typeof _options === 'function'
            ? _options
            : callback;

    // Refuse unsupported handle passing instead of silently dropping the handle.
    const sendHandle = typeof _sendHandle === 'function' ? undefined : _sendHandle;
    if (sendHandle !== undefined && sendHandle !== null) {
        throw Object.assign(new TypeError('This handle type cannot be sent'), {
            code: 'ERR_INVALID_HANDLE_TYPE',
        });
    }

    if (!this._ipcChannel || !this._ipcChannel.connected) {
        const err = Object.assign(
            new Error('IPC channel is not enabled for this child process. Use { stdio: [\'inherit\', \'inherit\', \'ipc\'] } to enable.'),
            { code: 'ERR_IPC_CHANNEL_CLOSED' },
        );
        if (cb) {
            queueMicrotask(() => cb(err));
            return false;
        }
        queueMicrotask(() => this.emit('error', err));
        return false;
    }

    // Node sends user messages verbatim (no wrapper) so the peer —
    // including a real node process — receives exactly what was sent.
    // A write failure must never throw synchronously out of send(): Node
    // reports it through the callback, or as an 'error' event when there is none.
    try {
        this._ipcChannel.send(message);
    } catch (err) {
        const wrapped = asError(err, 'write');
        if (cb) queueMicrotask(() => cb(wrapped));
        else queueMicrotask(() => this.emit('error', wrapped));
        return false;
    }
    if (cb) queueMicrotask(() => cb(null));
    return true;
};

ChildProcessImpl.prototype._setupIPC = function _setupIPC(this: ChildProcessImpl, pipe: CModuleStreams.Pipe, serialization: IPCSerialization = 'json'): void {
    this._ipcChannel = new IPCChannel(pipe, serialization);
    this.connected = true;

    // The host does not expose process-channel refs yet.
    const channel = {
        ref: () => { /* no per-handle loop refs available; see unref() */ },
        unref: () => { /* no per-handle loop refs available; see unref() */ },
    };
    Reflect.set(this, 'channel', channel);
    // Node also aliases it as the private _channel.
    Reflect.set(this, '_channel', channel);

    this._ipcChannel.on('message', (msg) => {
        if (this.listenerCount('message') > 0) this.emit('message', msg);
        else this._messageQueue.push(msg);
    });

    this._ipcChannel.on('error', (err: Error) => {
        this.emit('error', err);
    });

    this._ipcChannel.on('close', () => {
        this.connected = false;
        Reflect.set(this, 'channel', null);
        Reflect.set(this, '_channel', null);
        this.emit('disconnect');
    });
};

ChildProcessImpl.prototype._flushIPCMessages = function _flushIPCMessages(this: ChildProcessImpl): void {
    if (this.listenerCount('message') === 0 || this._messageQueue.length === 0) return;
    const queue = this._messageQueue;
    this._messageQueue = [];
    for (const msg of queue) this.emit('message', msg);
};

Object.defineProperty(ChildProcessImpl.prototype, 'constructor', {
    value: ChildProcessImpl,
    writable: true,
    configurable: true,
});

flattenPrototype(ChildProcessImpl.prototype);

export const ChildProcess = ChildProcessImpl;
