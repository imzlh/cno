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

import { IPCChannel } from '../ipc_channel';
import { EventEmitter } from '../events';
import { Writable, Readable } from '../stream';
import { getTierLimits } from '../_internal/memory';

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

// Type definitions

export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string>;
    argv0?: string;
    stdio?: Array<'pipe' | 'ignore' | 'inherit' | number | null | undefined> | 'pipe' | 'ignore' | 'inherit';
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
    input?: string | ArrayBuffer | Uint8Array;
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
    encoding?: BufferEncoding;
    maxBuffer?: number;
}

export interface ExecFileOptions extends SpawnOptions {
    encoding?: BufferEncoding;
    timeout?: number;
    maxBuffer?: number;
    killSignal?: string | number;
}

export interface ChildProcess extends EventEmitter {
    stdin: Writable | null;
    stdout: Readable | null;
    stderr: Readable | null;
    readonly pid: number;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly spawnargs: string[];
    readonly spawnfile: string;
    readonly killed: boolean;
    readonly connected: boolean;
}

// ChildProcess class

function transformSignal(signal?: string | number): number | undefined {
    if (!signal) return;
    if (typeof signal === 'string') {
        if (!signals) throw new Error('signal handling is unavailable outside the main thread');
        if (!(signal in signals.signals)) throw new Error(`Unknown signal: ${signal}`);
        // @ts-ignore - signal map
        return signals.signals[signal];
    }
    return signal;
}

function isPathLikeCommand(command: string): boolean {
    return command.includes('/') || command.includes('\\') || /^[A-Za-z]:[\\/]/.test(command);
}

function makeSpawnError(command: string, syscall: string): NodeJS.ErrnoException {
    const err = new Error(`${syscall} ${command} ENOENT`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    err.errno = -2;
    err.syscall = syscall;
    err.path = command;
    return err;
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
    _init(process: CModuleProcess.ChildProcess, command: string, args: string[], options: SpawnOptions): void;
    _createWritable(pipe: CModuleStreams.Pipe): Writable;
    _createReadable(pipe: CModuleStreams.Pipe): Readable;
    _waitExit(): Promise<void>;
    kill(signal?: string | number): boolean;
    disconnect(): void;
    unref(): void;
    ref(): void;
    send(message: any, sendHandle?: any, options?: any, callback?: (error: Error | null) => void): boolean;
    _setupIPC(pipe: CModuleStreams.Pipe): void;
}

interface ChildProcessImplConstructor {
    new (): ChildProcessImpl;
    (): ChildProcessImpl;
    prototype: ChildProcessImpl;
}

function initChildProcessImpl(self: any): void {
    EventEmitter.call(self);
    self._process = null;
    self._killed = false;
    self._exitCode = null;
    self._signalCode = null;
    self._stdin = null;
    self._stdout = null;
    self._stderr = null;
    self._ipcChannel = null;

    self.stdin = null;
    self.stdout = null;
    self.stderr = null;
    self.pid = 0;
    self.exitCode = null;
    self.signalCode = null;
    self.spawnargs = [];
    self.spawnfile = '';
    self.killed = false;
    self.connected = false;
}

const ChildProcessImpl: ChildProcessImplConstructor = function ChildProcessImpl(this: any) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
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
    this.spawnargs = args;

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

    // Asynchronously wait for process exit
    this._waitExit();
};

ChildProcessImpl.prototype._createWritable = function _createWritable(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Writable {
    return new Writable({
        write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            const data = chunk instanceof Uint8Array ? chunk : engine.encodeString(chunk);
            pipe.write(data).then(() => callback()).catch(callback);
        },
        async final(callback: (error?: Error | null) => void) {
            try { await pipe.shutdown(); } finally { callback(); }
        },
    });
};

ChildProcessImpl.prototype._createReadable = function _createReadable(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Readable {
    const readable = new Readable({
        read() {
            // Resume reading when the consumer has drained below the high water mark
            try { pipe.startRead(); } catch {}
        }
    });

    // Use callback-based read: pipe.onread pushes data into the Readable buffer
    pipe.onread = (data: Uint8Array | null | undefined, err?: any) => {
        if (err) { readable.destroy(err as Error); return; }
        if (data === null || data === undefined) {
            readable.push(null);
            try { pipe.stopRead(); } catch {}
            return;
        }
        const ok = readable.push(data);
        if (!ok) {
            // Back-pressure: stop reading until Readable drains
            try { pipe.stopRead(); } catch {}
        }
    };

    // Enter flowing mode so push() emits 'data' immediately.
    // Must be after onread is set — resume() calls _read() → startRead().
    readable.resume();
    return readable;
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
    // FIXME: C module doesn't expose unref per child process
};

ChildProcessImpl.prototype.ref = function ref(this: ChildProcessImpl): void {
    // FIXME
};

ChildProcessImpl.prototype.send = function send(this: ChildProcessImpl, message: any, _sendHandle?: any, _options?: any, callback?: (error: Error | null) => void): boolean {
    if (!this._ipcChannel || !this._ipcChannel.connected) {
        const err = new Error('IPC channel is not enabled for this child process. Use { stdio: [\'inherit\', \'inherit\', \'ipc\'] } to enable.') as NodeJS.ErrnoException;
        err.code = 'ERR_IPC_CHANNEL_CLOSED';
        if (callback) { callback(err); return false; }
        this.emit('error', err);
        return false;
    }

    try {
        // Node sends user messages verbatim (no wrapper) so the peer —
        // including a real node process — receives exactly what was sent.
        this._ipcChannel.send(message);
        if (callback) callback(null);
        return true;
    } catch (err) {
        if (callback) callback(err as Error);
        return false;
    }
};

/**
 * Set up IPC channel (called internally when stdio includes 'ipc')
 */
ChildProcessImpl.prototype._setupIPC = function _setupIPC(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): void {
    this._ipcChannel = new IPCChannel(pipe);
    this.connected = true;

    this._ipcChannel.on('message', (msg) => {
        this.emit('message', msg);
    });

    this._ipcChannel.on('error', (err: Error) => {
        this.emit('error', err);
    });

    this._ipcChannel.on('close', () => {
        this.connected = false;
        this.emit('disconnect');
    });
};

Object.defineProperty(ChildProcessImpl.prototype, 'constructor', {
    value: ChildProcessImpl,
    writable: true,
    configurable: true,
});

flattenPrototype(ChildProcessImpl.prototype);

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
        args = [shellArg, args.length > 0 ? `${command} ${args.join(' ')}` : `"${command}"`];
        command = shell;
    }

    const spawnOpts: CModuleProcess.SpawnOptions<false> = {
        cwd: opts.cwd,
        env: opts.env,
        uid: opts.uid,
        gid: opts.gid,
        detached: opts.detached,
    };

    // Handle stdio
    let hasIPC = false;
    if (opts.stdio) {
        if (Array.isArray(opts.stdio)) {
            spawnOpts.stdin = opts.stdio[0] ?? 'inherit';
            spawnOpts.stdout = opts.stdio[1] ?? 'inherit';
            spawnOpts.stderr = opts.stdio[2] ?? 'inherit';
            // Check for IPC in any stdio position
            hasIPC = opts.stdio.includes('ipc' as any);
        } else {
            spawnOpts.stdin = opts.stdio;
            spawnOpts.stdout = opts.stdio;
            spawnOpts.stderr = opts.stdio;
            hasIPC = (opts.stdio as string) === 'ipc';
        }
    } else {
        spawnOpts.stdin = 'pipe';
        spawnOpts.stdout = 'pipe';
        spawnOpts.stderr = 'pipe';
    }

    const child = new ChildProcessImpl();
    child.spawnfile = command;
    child.spawnargs = args;

    const immediateError = getImmediateSpawnError(command, 'spawn');
    if (immediateError) {
        queueMicrotask(() => child.emit('error', immediateError));
        return child;
    }

    // Set IPC option in spawn options
    if (hasIPC) {
        spawnOpts.ipc = true;
        // The C layer inherits the IPC endpoint to the child as fd 3. Tell the
        // child which fd that is via NODE_CHANNEL_FD (Node-compatible), so the
        // child's process module can wire up process.send()/process.on('message').
        // When the caller did not pass an explicit env we must start from the
        // current environment, otherwise the child would lose all inherited vars.
        const baseEnv = spawnOpts.env ?? os.environ();
        spawnOpts.env = { ...baseEnv, NODE_CHANNEL_FD: '3' };
    }

    let process: CModuleProcess.ChildProcess;
    try {
        process = proc.spawn([command, ...args], spawnOpts);
        child._init(process, command, args, opts);
    } catch (err) {
        queueMicrotask(() => child.emit('error', err as Error));
        return child;
    }

    // Set up IPC channel if created
    if (hasIPC && process.ipc) {
        child._setupIPC(process.ipc);
    }

    if (opts.signal) {
        // @ts-ignore
        opts.signal.addEventListener('abort', () => {
            child.kill();
        });
    }

    if (opts.timeout) {
        const tid = setTimeout(() => {
            if (!child.killed) {
                child.kill(opts.killSignal as string || 'SIGTERM');
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

    collectOutput(child, cb, `Command failed: ${command}`);

    return child;
}

// Helper: collect stdout/stderr from a child process and invoke callback
function collectOutput(
    child: ChildProcess,
    cb: ((err: Error | null, stdout: string, stderr: string) => void) | undefined,
    errorPrefix: string,
): void {
    let stdout = '';
    let stderr = '';

    if (child.stdout) {
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
    }

    if (child.stderr) {
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
    }

    child.on('close', (code) => {
        if (cb) {
            const error = code !== 0 ? new Error(`${errorPrefix}\n${stderr}`) : null;
            cb(error, stdout, stderr);
        }
    });
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
    let cb: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;

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

    collectOutput(child, cb, `Command failed: ${file}`);

    return child;
}

// fork

export function fork(modulePath: string, args?: string[], options?: SpawnOptions): ChildProcess {
    const forkArgs = args ?? [];
    // Fork automatically sets up IPC channel
    return spawn(os.exePath, [modulePath, ...forkArgs], {
        ...options,
        // @ts-ignore - fork always uses ipc
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
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

export function spawnSync(command: string, args?: string[], options?: SpawnOptions): SpawnSyncResult {
    const opts: CModuleProcess.SpawnOptions<false> = {
        cwd: options?.cwd,
        env: options?.env,
        uid: options?.uid,
        gid: options?.gid,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        input: options?.input,
    };

    if (options?.stdio) {
        if (Array.isArray(options.stdio)) {
            opts.stdin = options.stdio[0] ?? 'inherit';
            opts.stdout = options.stdio[1] ?? 'inherit';
            opts.stderr = options.stdio[2] ?? 'inherit';
        } else {
            opts.stdin = options.stdio;
            opts.stdout = options.stdio;
            opts.stderr = options.stdio;
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
        const result = proc.spawnSync(command, args ?? [], opts);
        const encoding = options?.encoding ?? 'utf8';
        const convert = (value: ArrayBuffer | null | undefined): any => {
            if (value == null) return value;
            const bytes = new Uint8Array(value);
            if (encoding === 'buffer' || encoding === null) return bytes;
            return new text.Decoder(encoding).decode(bytes);
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
            error: result.error,
        } as SpawnSyncResult;
    } catch (err) {
        return {
            error: err as Error,
        };
    }
}

export function execSync(command: string, options?: ExecOptions): Buffer | string {
    const isWindows = os.uname().sysname === 'Windows_NT';
    const defaultShell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArg = isWindows ? '/c' : '-c';
    const { encoding, maxBuffer, ...spawnOpts } = options ?? {} as any;
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
    exec(command: string, options?: ExecOptions): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            exec(command, options ?? {}, (error, stdout, stderr) => {
                if (error) reject(Object.assign(error, { stdout, stderr }));
                else resolve({ stdout: stdout as string, stderr: stderr as string });
            });
        });
    },

    execFile(file: string, args?: string[], options?: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            execFile(file, args ?? [], options ?? {}, (error, stdout, stderr) => {
                if (error) reject(Object.assign(error, { stdout, stderr }));
                else resolve({ stdout: stdout as string, stderr: stderr as string });
            });
        });
    },

    spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcess {
        return spawn(command, args ?? [], options ?? {});
    },
};
