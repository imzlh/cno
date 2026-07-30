/**
 * Node.js child_process module
 * Based on CModuleProcess implementation
 */

const proc = import.meta.use('process');
const os = import.meta.use('os');
const signals = import.meta.use('signals');
const engine = import.meta.use('engine');
const text = import.meta.use('text');
const fs = import.meta.use('fs');

import { IPCChannel, type IPCSerialization } from '../ipc_channel';
import { EventEmitter } from '../events';
import { Writable, Readable, Duplex } from '../stream';
import { getTierLimits } from '../_internal/memory';
import { viewToUint8Array } from '../_internal/buffer';
import { normalizeErrnoError } from '../_internal/errno';
import { Buffer } from '../buffer';

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

function asError(error: unknown, syscall?: string, path?: string): Error {
    return normalizeErrnoError(error, syscall, path);
}

function startPipeReadQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.startRead();
    } catch {
        // The pipe can already be closing while Readable asks for more data.
    }
}

function stopPipeReadQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.stopRead();
    } catch {
        // Best-effort back-pressure/EOF cleanup.
    }
}

// Resolve once a piped stdio Readable has ended, closed, or errored.
function waitStreamEnd(stream: Readable | null): Promise<void> {
    if (!stream) return Promise.resolve();
    if (stream.readableEnded || stream.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
        stream.once('end', resolve);
        stream.once('close', resolve);
        stream.once('error', resolve);
    });
}

// Type definitions
type StdioEntry = 'pipe' | 'ignore' | 'inherit' | 'ipc' | number | null | undefined;
type NativeStdio = CModuleProcess.SpawnOptions<false>['stdin'];
type ChildStdioStream = Writable | Readable | Duplex | null;
type SpawnInput = string | ArrayBuffer | ArrayBufferView;

function stdioChunkBytes(chunk: unknown): Uint8Array {
    if (typeof chunk === 'string') return engine.encodeString(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    if (ArrayBuffer.isView(chunk)) return viewToUint8Array(chunk);
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    throw new TypeError('Child process stdio chunk must be a string or binary buffer');
}

export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | number | boolean | null | undefined>;
    argv0?: string;
    stdio?: StdioEntry[] | 'pipe' | 'ignore' | 'inherit';
    detached?: boolean;
    uid?: number;
    gid?: number;
    serialization?: 'json' | 'advanced';
    shell?: boolean | string;
    windowsVerbatimArguments?: boolean;
    windowsHide?: boolean;
    signal?: AbortSignal;
    timeout?: number;
    killSignal?: string | number;
    execArgv?: string[];
    execPath?: string;
    silent?: boolean;
    input?: SpawnInput;
    encoding?: BufferEncoding | 'buffer' | null;
    /** Enable IPC channel */
    ipc?: boolean;
}

export interface SpawnOptionsWithStdioTuple<
    Stdin extends 'pipe' | 'ignore' | 'inherit' | number,
    Stdout extends 'pipe' | 'ignore' | 'inherit' | number,
    Stderr extends 'pipe' | 'ignore' | 'inherit' | number,
> extends SpawnOptions {
    stdio: [Stdin, Stdout, Stderr];
}

export interface ExecOptions extends SpawnOptions {
    encoding?: BufferEncoding | 'buffer' | null;
    maxBuffer?: number;
}

export interface ExecFileOptions extends SpawnOptions {
    encoding?: BufferEncoding | 'buffer' | null;
    timeout?: number;
    maxBuffer?: number;
    killSignal?: string | number;
}

export interface ChildProcess extends EventEmitter {
    stdin: Writable | null;
    stdout: Readable | null;
    stderr: Readable | null;
    stdio: ChildStdioStream[];
    readonly pid: number;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly spawnargs: string[];
    readonly spawnfile: string;
    readonly killed: boolean;
    readonly connected: boolean;
    kill(signal?: string | number): boolean;
}

// ChildProcess class

function transformSignal(signal?: string | number): number | undefined {
    if (!signal) return;
    if (typeof signal === 'string') {
        if (!signals) throw new Error('signal handling is unavailable outside the main thread');
        const signalNumber = signals.signals[signal];
        if (typeof signalNumber !== 'number') throw new Error(`Unknown signal: ${signal}`);
        return signalNumber;
    }
    return signal;
}

function decodeOutput(bytes: Uint8Array, encoding: BufferEncoding): string {
    const normalized = encoding.toLowerCase().replace(/[-_]/g, '');
    if (normalized === 'utf8') return engine.decodeString(bytes);
    if (normalized === 'utf16le' || normalized === 'ucs2') {
        const len = bytes.byteLength & ~1;
        if (len === 0) return '';
        if ((bytes.byteOffset & 1) === 0) {
            return engine.decodeU16String(new Uint16Array(bytes.buffer, bytes.byteOffset, len >>> 1));
        }
        const copy = new Uint8Array(len);
        copy.set(bytes.subarray(0, len));
        return engine.decodeU16String(copy.buffer);
    }
    return new text.Decoder(encoding).decode(bytes);
}

function toNativeStdio(value: StdioEntry, fallback: NativeStdio = 'pipe'): NativeStdio {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number') return value;
    return value === 'pipe' || value === 'ignore' || value === 'inherit' ? value : 'inherit';
}

function toNativeExtraStdio(value: StdioEntry): CModuleProcess.StdioOption | null {
    if (value === null || value === undefined || value === 'ipc') return null;
    if (typeof value === 'number') return value;
    return value === 'pipe' || value === 'inherit' ? value : 'ignore';
}

function ipcFdFromStdio(stdio: StdioEntry[] | undefined): number {
    if (!stdio) return 3;
    const index = stdio.indexOf('ipc');
    return index >= 0 ? index : 3;
}

function normalizeEnv(env?: SpawnOptions['env']): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && value !== null) out[key] = String(value);
    }
    return out;
}

function normalizeInput(input: unknown): SpawnInput | undefined {
    if (input === undefined) return undefined;
    if (typeof input === 'string' || input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    const ctor = input !== null && typeof input === 'object' && input.constructor
        ? input.constructor.name
        : typeof input;
    const received = ctor === 'Object' ? 'an instance of Object' : `type ${ctor}`;
    throw new TypeError(`The "input" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${received}`);
}

function isPathLikeCommand(command: string): boolean {
    return command.includes('/') || command.includes('\\') || /^[A-Za-z]:[\\/]/.test(command);
}

function makeSpawnError(command: string, syscall: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${syscall} ${command} ENOENT`), {
        code: 'ENOENT',
        errno: -2,
        syscall,
        path: command,
    });
}

function getImmediateSpawnError(command: string, syscall: string): NodeJS.ErrnoException | null {
    if (!isPathLikeCommand(command)) return null;
    try {
        if (fs.exists(command)) return null;
    } catch {}
    return makeSpawnError(command, syscall);
}

function flattenPrototype(target: object): void {
    const parent = Object.getPrototypeOf(target);
    if (!parent || parent === Object.prototype) return;

    for (const key of Object.getOwnPropertyNames(parent)) {
        if (key === 'constructor' || Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }

    for (const key of Object.getOwnPropertySymbols(parent)) {
        if (Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }
}

interface ChildProcessImpl extends ChildProcess {
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

interface ChildProcessImplConstructor {
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

const ChildProcessImpl: ChildProcessImplConstructor = function ChildProcessImpl(this: ChildProcessImpl | undefined) {
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

ChildProcessImpl.prototype._createWritable = function _createWritable(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Writable {
    return new Writable({
        write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            pipe.write(stdioChunkBytes(chunk)).then(() => callback()).catch(callback);
        },
        async final(callback: (error?: Error | null) => void) {
            try { await pipe.shutdown(); } catch { try { pipe.close(); } catch {} } finally { callback(); }
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

        this.emit('exit', this._exitCode, this._signalCode);

        // 'close' must wait for exit AND EOF/close of every piped stdio stream
        // so exec/execFile don't see truncated stdout/stderr.
        await Promise.all(
            [this._stdout, this._stderr].map((stream) => waitStreamEnd(stream)),
        );
        this.emit('close', this._exitCode, this._signalCode);
    } catch (err) {
        this.emit('error', err);
    }
};

ChildProcessImpl.prototype.kill = function kill(this: ChildProcessImpl, signal?: string | number): boolean {
    if (this._killed || !this._process) return false;

    this._killed = true;
    this.killed = true;

    try {
        this._process.kill(transformSignal(signal));
        return true;
    } catch {
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
    this._ipcChannel.send(message);
    if (cb) queueMicrotask(() => cb(null));
    return true;
};

/**
 * Set up IPC channel (called internally when stdio includes 'ipc')
 */
ChildProcessImpl.prototype._setupIPC = function _setupIPC(this: ChildProcessImpl, pipe: CModuleStreams.Pipe, serialization: IPCSerialization = 'json'): void {
    this._ipcChannel = new IPCChannel(pipe, serialization);
    this.connected = true;

    this._ipcChannel.on('message', (msg) => {
        if (this.listenerCount('message') > 0) this.emit('message', msg);
        else this._messageQueue.push(msg);
    });

    this._ipcChannel.on('error', (err: Error) => {
        this.emit('error', err);
    });

    this._ipcChannel.on('close', () => {
        this.connected = false;
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

// spawn

export function spawn(command: string): ChildProcess;
export function spawn(command: string, options: SpawnOptions): ChildProcess;
export function spawn(command: string, args: string[]): ChildProcess;
export function spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawn(command: string, argsOrOptions?: string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
    let args: string[] = [];
    let opts: SpawnOptions = {};

    if (Array.isArray(argsOrOptions)) {
        args = argsOrOptions;
        opts = options ?? {};
    } else if (argsOrOptions) {
        opts = argsOrOptions;
    }

    // Handle shell options
    if (opts.shell) {
        const isWindows = os.uname().sysname === 'Windows_NT';
        const defaultShell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shell = typeof opts.shell === 'string' ? opts.shell : defaultShell;
        const shellArg = isWindows ? '/c' : '-c';
        args = [shellArg, args.length > 0 ? `${command} ${args.join(' ')}` : command];
        command = shell;
    }

    const spawnOpts: CModuleProcess.SpawnOptions<false> = {
        cwd: opts.cwd,
        env: normalizeEnv(opts.env),
        clearEnv: opts.env !== undefined,
        uid: opts.uid,
        gid: opts.gid,
        detached: opts.detached,
    };

    // Handle stdio
    let hasIPC = false;
    let ipcFd = 3;
    if (opts.stdio) {
        if (Array.isArray(opts.stdio)) {
            spawnOpts.stdin = toNativeStdio(opts.stdio[0]);
            spawnOpts.stdout = toNativeStdio(opts.stdio[1]);
            spawnOpts.stderr = toNativeStdio(opts.stdio[2]);
            if (opts.stdio.length > 3) {
                spawnOpts.stdioExtra = opts.stdio.slice(3).map(toNativeExtraStdio);
            }
            // Check for IPC in any stdio position
            hasIPC = opts.stdio.includes('ipc');
            ipcFd = ipcFdFromStdio(opts.stdio);
        } else {
            spawnOpts.stdin = toNativeStdio(opts.stdio);
            spawnOpts.stdout = toNativeStdio(opts.stdio);
            spawnOpts.stderr = toNativeStdio(opts.stdio);
            hasIPC = false;
        }
    } else {
        spawnOpts.stdin = 'pipe';
        spawnOpts.stdout = 'pipe';
        spawnOpts.stderr = 'pipe';
    }

    const child = new ChildProcessImpl();
    child.spawnfile = command;
    child.spawnargs = [command, ...args];

    const immediateError = getImmediateSpawnError(command, 'spawn');
    if (immediateError) {
        queueMicrotask(() => child.emit('error', immediateError));
        return child;
    }

    // Set IPC option in spawn options
    if (hasIPC) {
        const serialization: IPCSerialization = opts.serialization === 'advanced' ? 'advanced' : 'json';
        spawnOpts.ipc = true;
        spawnOpts.ipcFd = ipcFd;
        // The C layer inherits the IPC endpoint to the requested child fd. Tell
        // the child which fd that is via NODE_CHANNEL_FD (Node-compatible), so
        // the child's process module can wire up process.send()/process.on('message').
        // When the caller did not pass an explicit env we must start from the
        // current environment, otherwise the child would lose all inherited vars.
        const baseEnv = spawnOpts.env ?? os.environ();
        spawnOpts.env = {
            ...baseEnv,
            NODE_CHANNEL_FD: String(ipcFd),
            CNO_IPC_SERIALIZATION: serialization,
        };
    }

    let process: CModuleProcess.ChildProcess;
    try {
        process = proc.spawn([command, ...args], spawnOpts);
        child._init(process, command, args, opts);
    } catch (err) {
        queueMicrotask(() => child.emit('error', asError(err, 'spawn', command)));
        return child;
    }

    // Set up IPC channel if created
    if (hasIPC && process.ipc) {
        child._setupIPC(process.ipc, opts.serialization === 'advanced' ? 'advanced' : 'json');
    }

    if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
            child.kill();
        }, { once: true });
    }

    if (opts.timeout !== undefined && opts.timeout > 0) {
        const tid = setTimeout(() => {
            if (!child.killed) {
                child.kill(opts.killSignal || 'SIGTERM');
            }
        }, opts.timeout);
        // Clear the timer when the child exits to prevent leaks
        child.on('close', () => clearTimeout(tid));
    }

    return child;
}

// exec

export function exec(command: string, callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function exec(command: string, options: ExecOptions, callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function exec(command: string, optionsOrCallback?: ExecOptions | ((error: Error | null, stdout: string, stderr: string) => void), callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess {
    let opts: ExecOptions = {};
    let cb: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;

    if (typeof optionsOrCallback === 'function') {
        cb = optionsOrCallback;
    } else if (optionsOrCallback) {
        opts = optionsOrCallback;
        cb = callback;
    }

    const isWindows = os.uname().sysname === 'Windows_NT';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArg = isWindows ? '/c' : '-c';

    const child = spawn(shell, [shellArg, command], {
        ...opts,
        stdio: 'pipe',
    });

    collectOutput(child, cb, `Command failed: ${command}`, opts);

    return child;
}

// Helper: collect stdout/stderr from a child process and invoke callback
function collectOutput(
    child: ChildProcess,
    cb: ((err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) | undefined,
    errorPrefix: string,
    options: ExecOptions | ExecFileOptions = {},
): void {
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    let stdoutLength = 0;
    let stderrLength = 0;
    let maxBufferError: Error | null = null;
    let settled = false;

    const pushChunk = (chunks: Uint8Array[], chunk: unknown, streamName: 'stdout' | 'stderr') => {
        if (maxBufferError) return;
        const bytes = stdioChunkBytes(chunk);
        const currentLength = streamName === 'stdout' ? stdoutLength : stderrLength;
        const allowed = maxBuffer - currentLength;
        if (allowed <= 0 || bytes.byteLength > allowed) {
            if (allowed > 0) chunks.push(bytes.subarray(0, allowed));
            const err = Object.assign(new Error(`${streamName} maxBuffer length exceeded`), {
                code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            });
            maxBufferError = err;
            child.kill();
            return;
        }
        chunks.push(bytes);
        if (streamName === 'stdout') stdoutLength += bytes.byteLength;
        else stderrLength += bytes.byteLength;
    };

    child.stdout?.on('data', (chunk) => pushChunk(stdoutChunks, chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => pushChunk(stderrChunks, chunk, 'stderr'));

    const finish = (error: Error | null, code: number | null = null) => {
        if (settled) return;
        settled = true;
        if (cb) {
            const stdout = convertCollectedOutput(stdoutChunks, options.encoding);
            const stderr = convertCollectedOutput(stderrChunks, options.encoding);
            const finalError = error ?? maxBufferError ?? (code !== 0 ? new Error(`${errorPrefix}\n${String(stderr)}`) : null);
            cb(finalError, stdout, stderr);
        }
    };

    child.on('error', (err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', (code) => {
        finish(null, code);
    });
}

function convertCollectedOutput(chunks: Uint8Array[], encoding?: BufferEncoding | 'buffer' | null): string | Buffer {
    const buffer = Buffer.concat(chunks);
    if (encoding === 'buffer' || encoding === null) return buffer;
    return decodeOutput(buffer, encoding ?? 'utf8');
}

// execFile

export function execFile(file: string): ChildProcess;
export function execFile(file: string, options: ExecFileOptions): ChildProcess;
export function execFile(file: string, callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function execFile(file: string, args: string[]): ChildProcess;
export function execFile(file: string, args: string[], options: ExecFileOptions): ChildProcess;
export function execFile(file: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function execFile(file: string, args: string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function execFile(
    file: string,
    argsOrOptionsOrCallback?: string[] | ExecFileOptions | ((error: Error | null, stdout: string, stderr: string) => void),
    optionsOrCallback?: ExecFileOptions | ((error: Error | null, stdout: string, stderr: string) => void),
    callback?: (error: Error | null, stdout: string, stderr: string) => void
): ChildProcess {
    let args: string[] = [];
    let opts: ExecFileOptions = {};
    let cb: ((error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) | undefined;

    if (Array.isArray(argsOrOptionsOrCallback)) {
        args = argsOrOptionsOrCallback;
        if (typeof optionsOrCallback === 'function') {
            cb = optionsOrCallback;
        } else if (optionsOrCallback) {
            opts = optionsOrCallback;
            cb = callback;
        }
    } else if (typeof argsOrOptionsOrCallback === 'function') {
        cb = argsOrOptionsOrCallback;
    } else if (argsOrOptionsOrCallback) {
        opts = argsOrOptionsOrCallback;
        if (typeof optionsOrCallback === 'function') {
            cb = optionsOrCallback;
        }
    }

    const child = spawn(file, args, {
        ...opts,
        stdio: 'pipe',
    });

    collectOutput(child, cb, `Command failed: ${file}`, opts);

    return child;
}

// fork

export function fork(modulePath: string, args?: string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
    const forkArgs = Array.isArray(args) ? args : [];
    const forkOptions = Array.isArray(args) ? (options ?? {}) : (args ?? {});
    const execArgv = forkOptions.execArgv ?? [];
    const configuredStdio = forkOptions.stdio;
    const forkStdio: StdioEntry[] = configuredStdio === undefined
        ? (forkOptions.silent ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'])
        : (Array.isArray(configuredStdio) ? configuredStdio : [configuredStdio, configuredStdio, configuredStdio, 'ipc']);
    if (!forkStdio.includes('ipc')) {
        throw new TypeError('fork() requires an IPC channel in the stdio array');
    }
    const { execArgv: _execArgv, execPath: _execPath, silent: _silent, ...spawnOptions } = forkOptions;
    return spawn(forkOptions.execPath ?? os.exePath, [...execArgv, modulePath, ...forkArgs], {
        ...spawnOptions,
        stdio: forkStdio,
    });
}

// spawnSync / execSync / execFileSync

export interface SpawnSyncResult {
    pid?: number;
    output?: Array<string | Buffer | null>;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    status?: number | null;
    signal?: string | null;
    error?: Error;
}

export interface ExecSyncResult {
    pid?: number;
    output?: Array<string | Buffer | null>;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    status?: number | null;
    signal?: string | null;
    error?: Error;
}

export function spawnSync(command: string, options?: SpawnOptions): SpawnSyncResult;
export function spawnSync(command: string, args?: string[], options?: SpawnOptions): SpawnSyncResult;
export function spawnSync(command: string, argsOrOptions?: string[] | SpawnOptions, options?: SpawnOptions): SpawnSyncResult {
    let args: string[] = [];
    let optsSource: SpawnOptions = {};

    if (Array.isArray(argsOrOptions)) {
        args = argsOrOptions;
        optsSource = options ?? {};
    } else if (argsOrOptions) {
        optsSource = argsOrOptions;
    }

    if (optsSource.shell) {
        const isWindows = os.uname().sysname === 'Windows_NT';
        const defaultShell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shell = typeof optsSource.shell === 'string' ? optsSource.shell : defaultShell;
        const shellArg = isWindows ? '/c' : '-c';
        args = [shellArg, args.length > 0 ? `${command} ${args.join(' ')}` : command];
        command = shell;
    }

    const opts: CModuleProcess.SpawnOptions<false> = {
        cwd: optsSource.cwd,
        env: normalizeEnv(optsSource.env),
        clearEnv: optsSource.env !== undefined,
        uid: optsSource.uid,
        gid: optsSource.gid,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        input: normalizeInput(optsSource.input),
    };

    if (optsSource.stdio) {
        if (Array.isArray(optsSource.stdio)) {
            opts.stdin = toNativeStdio(optsSource.stdio[0]);
            opts.stdout = toNativeStdio(optsSource.stdio[1]);
            opts.stderr = toNativeStdio(optsSource.stdio[2]);
        } else {
            opts.stdin = toNativeStdio(optsSource.stdio);
            opts.stdout = toNativeStdio(optsSource.stdio);
            opts.stderr = toNativeStdio(optsSource.stdio);
        }
    }

    const immediateError = getImmediateSpawnError(command, 'spawnSync');
    if (immediateError) {
        return {
            error: immediateError,
            status: null,
            signal: null,
        };
    }

    try {
        const result = proc.spawnSync(command, args, opts);
        const encoding = optsSource.encoding ?? 'utf8';
        const convert = (value: ArrayBuffer | null | undefined): Uint8Array | string | null | undefined => {
            if (value == null) return value;
            const bytes = new Uint8Array(value);
            if (encoding === 'buffer' || encoding === null) return bytes;
            return decodeOutput(bytes, encoding);
        };
        const stdout = convert(result.stdout);
        const stderr = convert(result.stderr);
        return {
            pid: result.pid,
            output: [result.output?.[0] ?? null, stdout, stderr],
            stdout,
            stderr,
            status: result.status,
            signal: result.signal,
            error: result.error ? asError(result.error, 'spawnSync', command) : undefined,
        } as SpawnSyncResult;
    } catch (err) {
        return {
            error: asError(err, 'spawnSync', command),
        };
    }
}

export function execSync(command: string, options?: ExecOptions): Buffer | string {
    const isWindows = os.uname().sysname === 'Windows_NT';
    const defaultShell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArg = isWindows ? '/c' : '-c';
    const { encoding, maxBuffer, ...spawnOpts } = options ?? {};
    const result = spawnSync(defaultShell, [shellArg, command], { ...spawnOpts, encoding } as SpawnOptions);
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Command failed: ${command}`);
    }
    return result.stdout ?? '';
}

export function execFileSync(file: string, args?: string[], options?: ExecFileOptions): Buffer | string {
    const result = spawnSync(file, args, options);
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Command failed: ${file}`);
    }
    return result.stdout ?? '';
}

// promises namespace

export const promises = {
    exec(command: string, options?: ExecOptions): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
        return new Promise((resolve, reject) => {
            exec(command, options ?? {}, (error, stdout, stderr) => {
                if (error) reject(Object.assign(error, { stdout, stderr }));
                else resolve({ stdout, stderr });
            });
        });
    },

    execFile(file: string, args?: string[], options?: ExecFileOptions): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
        return new Promise((resolve, reject) => {
            execFile(file, args ?? [], options ?? {}, (error, stdout, stderr) => {
                if (error) reject(Object.assign(error, { stdout, stderr }));
                else resolve({ stdout, stderr });
            });
        });
    },

    spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcess {
        return spawn(command, args ?? [], options ?? {});
    },
};
