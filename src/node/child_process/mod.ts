/**
 * Node.js child_process module
 * Based on CModuleProcess implementation
 */

const proc = import.meta.use('process');
const os = import.meta.use('os');

import { EventEmitter } from '../events';
import { Writable, Readable } from '../stream';

// ============================================================================
// Type definitions
// ============================================================================

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

// ============================================================================
// ChildProcess class
// ============================================================================

class ChildProcessImpl extends EventEmitter implements ChildProcess {
    private _process: CModuleProcess.ChildProcess | null = null;
    private _killed: boolean = false;
    private _exitCode: number | null = null;
    private _signalCode: string | null = null;
    private _stdin: Writable | null = null;
    private _stdout: Readable | null = null;
    private _stderr: Readable | null = null;

    stdin: Writable | null = null;
    stdout: Readable | null = null;
    stderr: Readable | null = null;
    pid: number = 0;
    exitCode: number | null = null;
    signalCode: string | null = null;
    spawnargs: string[] = [];
    spawnfile: string = '';
    killed: boolean = false;
    connected: boolean = false;

    constructor() {
        super();
    }

    _init(process: CModuleProcess.ChildProcess, command: string, args: string[], options: SpawnOptions): void {
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
    }

    private _createWritable(pipe: CModuleStreams.Pipe): Writable {
        return new Writable({
            write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
                const data = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk);
                pipe.write(data).then(() => callback()).catch(callback);
            },
            final(callback: (error?: Error | null) => void) {
                try{ pipe.shutdown(); } finally { callback(); }
            },
        });
    }

    private _createReadable(pipe: CModuleStreams.Pipe): Readable {
        const readable = new Readable();

        readable._read = async (size: number) => {
            const chunkSize = size || 65536;
            const buf = new Uint8Array(chunkSize);

            try {
                const n = await pipe.read(buf);
                if (n === 0) {
                    readable.push(null);
                    return;
                }
                readable.push(buf.subarray(0, n));
            } catch (err) {
                readable.emit('error', err);
                readable.push(null);
            }
        };

        return readable;
    }

    private async _waitExit(): Promise<void> {
        if (!this._process) return;

        try {
            const info = await this._process.wait();
            this._exitCode = info.exit_status;
            this.exitCode = info.exit_status;
            this._signalCode = info.term_signal;
            this.signalCode = info.term_signal;

            this.emit('exit', this._exitCode, this._signalCode);
            this.emit('close', this._exitCode, this._signalCode);
        } catch (err) {
            this.emit('error', err);
        }
    }

    kill(signal?: string | number): boolean {
        if (this._killed || !this._process) return false;

        this._killed = true;
        this.killed = true;

        try {
            this._process.kill(signal as CModuleProcess.Signal || 'SIGTERM');
            return true;
        } catch {
            return false;
        }
    }

    disconnect(): void {
        this.connected = false;
        // Close stdin/stdout/stderr to signal disconnect
        if (this.stdin) { this.stdin.end(); this.stdin = null; }
        if (this.stdout) { this.stdout.destroy(); this.stdout = null; }
        if (this.stderr) { this.stderr.destroy(); this.stderr = null; }
        this.emit('disconnect');
    }

    unref(): void {
        // Best-effort: C module doesn't expose unref per child process
    }

    ref(): void {
        // Best-effort
    }

    send(message: any, _sendHandle?: any, _options?: any, callback?: (error: Error | null) => void): boolean {
        // No IPC channel established (spawn doesn't create one by default)
        const err = new Error('IPC channel is not enabled for this child process. Use { stdio: [\'inherit\', \'inherit\', \'ipc\'] } to enable.') as NodeJS.ErrnoException;
        err.code = 'ERR_IPC_CHANNEL_CLOSED';
        if (callback) { callback(err); return false; }
        this.emit('error', err);
        return false;
    }
}

// ============================================================================
// spawn
// ============================================================================

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
        const defaultShell = os.uname().sysname === 'Windows_NT' ? 'cmd.exe' : '/bin/sh';
        const shell = typeof opts.shell === 'string' ? opts.shell : defaultShell;
        args = ['-c', args.length > 0 ? `${command} ${args.join(' ')}` : command];
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
    if (opts.stdio) {
        if (Array.isArray(opts.stdio)) {
            spawnOpts.stdin = opts.stdio[0] ?? 'inherit';
            spawnOpts.stdout = opts.stdio[1] ?? 'inherit';
            spawnOpts.stderr = opts.stdio[2] ?? 'inherit';
        } else {
            spawnOpts.stdin = opts.stdio;
            spawnOpts.stdout = opts.stdio;
            spawnOpts.stderr = opts.stdio;
        }
    } else {
        spawnOpts.stdin = 'pipe';
        spawnOpts.stdout = 'pipe';
        spawnOpts.stderr = 'pipe';
    }

    const child = new ChildProcessImpl();
    // @ts-ignore
    const process = proc.spawn(command, args, spawnOpts);
    child._init(process, command, args, opts);

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
    }

    return child;
}

// ============================================================================
// exec
// ============================================================================

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

    const child = spawn('/bin/sh', ['-c', command], {
        ...opts,
        stdio: 'pipe',
    });

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
            const error = code !== 0 ? new Error(`Command failed: ${command}\n${stderr}`) : null;
            cb(error, stdout, stderr);
        }
    });

    return child;
}

// ============================================================================
// execFile
// ============================================================================

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
            const error = code !== 0 ? new Error(`Command failed: ${file}\n${stderr}`) : null;
            cb(error, stdout, stderr);
        }
    });

    return child;
}

// ============================================================================
// fork
// ============================================================================

export function fork(modulePath: string, args?: string[], options?: SpawnOptions): ChildProcess {
    const forkArgs = args ?? [];
    // @ts-ignore - fork uses ipc channel
    return spawn(process.execPath, [modulePath, ...forkArgs], {
        ...options,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

// ============================================================================
// spawnSync / execSync / execFileSync
// ============================================================================

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

    try {
        const result = proc.spawnSync(command, args ?? [], opts);
        const encoding = options?.encoding ?? 'utf8';
        const convert = (value: ArrayBuffer | null | undefined): any => {
            if (value == null) return value;
            const bytes = new Uint8Array(value);
            if (encoding === 'buffer' || encoding === null) return bytes;
            return new TextDecoder(encoding as string).decode(bytes);
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
    const defaultShell = os.uname().sysname === 'Windows_NT' ? 'cmd.exe' : '/bin/sh';
    const result = spawnSync(defaultShell, ['-c', command], options);
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
