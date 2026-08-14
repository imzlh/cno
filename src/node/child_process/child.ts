/**
 * Node.js child_process module - the ChildProcess implementation.
 *
 * `ChildProcessImpl` is exported for the sibling spawn path (which constructs it
 * and calls the underscore-prefixed hooks); `ChildProcess` is the public alias
 * re-exported by mod.ts.
 */

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

// ChildProcess class

// The public `ChildProcess` name carries both meanings, exactly as the pre-split
// mod.ts did: the interface from types.ts and the `ChildProcessImpl` value below.
// Declaring the type alias here is what lets mod.ts re-export both with a single
// `export { ChildProcess } from './child'`.
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

// `export const` rather than a local const plus `export { … }`: the interface
// above and this const merge into one declaration, and TS refuses to emit a
// declaration file when half of a merged declaration is local (TS4045/4047/4033).
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

    // Set stdin
    if (process.stdin) {
        this._stdin = this._createWritable(process.stdin);
        this.stdin = this._stdin;
    }

    // Set stdout
    if (process.stdout) {
        this._stdout = this._createReadable(process.stdout);
        this.stdout = this._stdout;
    }

    // Set stderr
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

    // Asynchronously wait for process exit
    this._waitExit();
    queueMicrotask(() => this.emit('spawn'));
};

// Spawn never started: Node emits 'error', then 'close' with the UV errno as
// the exit code, and no 'exit'. Without the 'close', exec()/promisify hang.
// A spawn that never started still hands back stream objects for every 'pipe'
// slot in Node — it is not an all-or-nothing null. Measured on v24.18/Windows for
// `spawn('<missing>', …)`:
//   stdio 'pipe'                     -> stdin/stdout/stderr are all objects
//   stdio 'ignore' / 'inherit'       -> all three null
//   stdio ['pipe','ignore','inherit']-> stdin object, stdout null, stderr null
//   stdio ['pipe','pipe','pipe','pipe'] -> fd 3 an object too, child.stdio.length 4
// so the decision is PER SLOT. Returning null everywhere made the ordinary
// `child.stdout.on('data', …)` wiring throw "cannot read property 'on' of null"
// before the 'error' event could ever be delivered — which is precisely what
// execa/cross-spawn-shaped code does.
//
// The streams must also SETTLE, or a stub would trade a TypeError for a hang.
// Node's measured settle semantics on a failed spawn are reproduced exactly by:
//   readable ended via push(null) -> finished() settles with NO error   (stdout/stderr)
//   writable destroyed            -> finished() settles ERR_STREAM_PREMATURE_CLOSE (stdin)
// (both verified identical in cno, so no dependency on any pending stream fix).
// KNOWN FIDELITY GAP, deliberate: Node's child stdio streams are Sockets, i.e.
// duplex in both directions even for stdout/stderr (`child.stdout.writable` is
// true there), so on these stubs the opposite-direction properties read
// `undefined` instead of a boolean. Making them Duplex is not assignable to
// cno's own `Readable`/`Writable` slot types (Duplex lacks _readAndResolve/wrap),
// and the settle semantics below — the part that prevents a hang — are already
// byte-identical to Node either way, so the cosmetic property is not worth a cast.
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
        // Node's child stdin is a socket, and destroying a socket closes its
        // handle. Two things needed this hook:
        //  1. `final()` is SKIPPED on the destroy path, so without it the native
        //     pipe was never closed when stdin was destroyed rather than ended.
        //  2. A Writable built with no `destroy` option has NO `_destroy` at all
        //     (stream/mod.ts only assigns it from the option). execa's
        //     `spyOnStdinDestroy` does `const {_destroy} = stdin` and then
        //     `_destroy.call(...)`, so on every child it threw "cannot read
        //     property 'call' of undefined" — which `runStreamDestroy` converts
        //     into a spurious 'error' on the child's stdin.
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
            try { pipe.close(); } catch { /* already closed by the exiting child */ }
            callback(error);
        },
    });
};

ChildProcessImpl.prototype._createReadable = function _createReadable(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Readable {
    const readable = new Readable({
        read() {
            // Resume reading when the consumer has drained below the high water mark
            startPipeReadQuietly(pipe);
        }
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
        // Same two reasons as _createWritable's `destroy` hook, for the fd >= 3
        // duplex streams: `final()` is SKIPPED on the destroy path, so the native
        // pipe leaked whenever an extra stdio stream was destroyed rather than
        // ended; and a Duplex built with no `destroy` option has NO `_destroy` at
        // all, so the `const {_destroy} = stream` + `_destroy.call(...)` pattern
        // (execa's spyOnStdinDestroy) threw "cannot read property 'call' of
        // undefined". Measured: node's fd-3 stream has a `_destroy` function and
        // settles 'close'; without this hook cno's never settled.
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

        // Node's `onexit` destroys the child's stdin BEFORE emitting 'exit', so a
        // listener on 'exit' legitimately observes `stdin.destroyed === true`
        // (measured v24.18). It is a destroy(), not an end(): `writableEnded`
        // stays false and any unread pending write is discarded rather than
        // flushed. Without this the Writable stayed alive forever, so
        // `finished(child.stdin)` NEVER SETTLED — which is exactly the member of
        // execa's Promise.all that made `await execa(...)` hang and then exit 0
        // with no output. stdout/stderr are left alone: they reach EOF on their
        // own and their `finished()` already resolved.
        destroyChildStdin(this._stdin);

        this.emit('exit', this._exitCode, this._signalCode);

        // 'close' must wait for exit AND EOF/close of every piped stdio stream
        // so exec/execFile don't see truncated stdout/stderr. stdin is NOT part
        // of that set — Node only counts stdio indices > 0 toward `_closesNeeded`.
        //
        // Emitting synchronously when nothing is outstanding is load-bearing for
        // event order, not just an optimization: `destroy()` defers stdin's
        // 'close' by a tick, and Node's `maybeClose` runs synchronously inside
        // the same `onexit` turn, which is why Node's order is child 'exit',
        // child 'close', then stdin 'close'. An unconditional `await` here put
        // the child's 'close' behind a microtask and inverted the last two.
        const pending = [this._stdout, this._stderr].filter(streamEndPending);
        if (pending.length > 0) {
            await Promise.all(pending.map((stream) => waitStreamEnd(stream)));
        }
        this.emit('close', this._exitCode, this._signalCode);
    } catch (err) {
        this.emit('error', err);
    }
};

// Windows supports only SIGQUIT/SIGTERM/SIGKILL/SIGINT (libuv's uv__kill switch);
// everything else returns UV_ENOSYS. Node does not surface that as a failure — it
// falls back to an unconditional terminate, which is why `child.kill('SIGHUP')`
// reports true and leaves signalCode 'SIGKILL' there (measured on v24.18/Windows
// for SIGHUP/SIGABRT/SIGBREAK/SIGWINCH and the bare number 1). Without the
// fallback those calls returned false and the child kept running, so a
// `kill('SIGHUP')` shutdown path leaked the process.
//
// The native kill throws an IOError whose `code` is the NUMERIC uv errno
// (measured: -4054 for ENOSYS), so compare against the runtime table — the
// committed .d.ts value for ENOSYS is stale and a hardcoded constant would
// silently never match.
function isUnsupportedSignalError(err: unknown): boolean {
    const code = err instanceof Error ? Reflect.get(err, 'code') : undefined;
    if (typeof code === 'number') {
        return code === nativeError.errno.ENOSYS || code === nativeError.errno.EINVAL;
    }
    return code === 'ENOSYS' || code === 'EINVAL';
}

ChildProcessImpl.prototype.kill = function kill(this: ChildProcessImpl, signal?: string | number): boolean {
    if (this._killed || !this._process) return false;
    // Node returns false and leaves `killed` alone once the child has been reaped
    // (measured: kill-after-exit is false with killed still false), so an
    // already-exited child must not be reported as newly killed.
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
    // Only the IPC channel is torn down on disconnect(). In Node, stdin/stdout/
    // stderr are independent of the IPC channel and must stay open. Closing the
    // channel emits 'close', whose handler (registered in _setupIPC) flips
    // `connected` to false and emits 'disconnect' — so we must not emit it here
    // again to avoid a duplicate event.
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

    // Handle passing is not implemented: the IPC channel serialises the message
    // only, so a handle argument used to be dropped while send() still returned
    // true and the callback reported success — the child's 'message' listener got
    // `undefined` for its second parameter (measured: Node's child receives a
    // `Server`, cno's receives undefined). Silently losing the handle is worse
    // than refusing it, so refuse it the way Node refuses a handle it cannot
    // serialise: a synchronous ERR_INVALID_HANDLE_TYPE (measured shape on
    // v24.18 — it throws, it does not report through the callback).
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

/**
 * Set up IPC channel (called internally when stdio includes 'ipc')
 */
ChildProcessImpl.prototype._setupIPC = function _setupIPC(this: ChildProcessImpl, pipe: CModuleStreams.Pipe, serialization: IPCSerialization = 'json'): void {
    this._ipcChannel = new IPCChannel(pipe, serialization);
    this.connected = true;

    // Node exposes the control channel as child.channel with ref()/unref() on it;
    // `child.channel.unref()` is the documented way to stop the IPC channel from
    // holding the parent's loop open, and libraries call it unguarded. It was
    // missing entirely (measured: child.channel undefined where Node has an
    // object with function ref/unref), so such code threw on a property of
    // undefined. The methods are no-ops for the same reason ChildProcess.unref()
    // is — the host exposes no per-handle loop refs (see unref()).
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
