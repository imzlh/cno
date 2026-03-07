/**
 * Node.js child_process 模块
 * 基于 CModuleProcess 实现
 */

const proc = import.meta.use('process');

import { EventEmitter } from '../events';
import { Writable, Readable } from '../stream';

// ============================================================================
// 类型定义
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
// ChildProcess 类
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

        // 设置 stdin
        if (process.stdin) {
            this._stdin = this._createWritable(process.stdin);
            this.stdin = this._stdin;
        }

        // 设置 stdout
        if (process.stdout) {
            this._stdout = this._createReadable(process.stdout);
            this.stdout = this._stdout;
        }

        // 设置 stderr
        if (process.stderr) {
            this._stderr = this._createReadable(process.stderr);
            this.stderr = this._stderr;
        }

        // 异步等待进程退出
        this._waitExit();
    }

    private _createWritable(pipe: CModuleStreams.Pipe): Writable {
        return new Writable({
            write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
                const data = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk);
                pipe.write(data).then(() => callback()).catch(callback);
            },
            final(callback: (error?: Error | null) => void) {
                pipe.shutdown().then(() => callback()).catch(callback);
            },
        });
    }

    private _createReadable(pipe: CModuleStreams.Pipe): Readable {
        const readable = new Readable();
        readable._read = (size: number) => {
            const buffer = new Uint8Array(size || 65536);
            pipe.read(buffer).then((bytesRead) => {
                if (bytesRead === null) {
                    readable.push(null);
                } else {
                    readable.push(buffer.slice(0, bytesRead));
                }
            }).catch((err) => {
                readable.emit('error', err);
            });
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
    }

    unref(): void {}

    ref(): void {}

    send(message: any, sendHandle?: any, options?: any, callback?: (error: Error | null) => void): boolean {
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

    // 处理 shell 选项
    if (opts.shell) {
        const shell = typeof opts.shell === 'string' ? opts.shell : '/bin/sh';
        args = ['-c', args.length > 0 ? `${command} ${args.join(' ')}` : command];
        command = shell;
    }

    const spawnOpts: CModuleProcess.SpawnOptions = {
        cwd: opts.cwd,
        env: opts.env,
        uid: opts.uid,
        gid: opts.gid,
        detached: opts.detached,
    };

    // 处理 stdio
    if (opts.stdio) {
        if (Array.isArray(opts.stdio)) {
            spawnOpts.stdin = opts.stdio[0] as any;
            spawnOpts.stdout = opts.stdio[1] as any;
            spawnOpts.stderr = opts.stdio[2] as any;
        } else {
            spawnOpts.stdin = opts.stdio as any;
            spawnOpts.stdout = opts.stdio as any;
            spawnOpts.stderr = opts.stdio as any;
        }
    } else {
        spawnOpts.stdin = 'pipe';
        spawnOpts.stdout = 'pipe';
        spawnOpts.stderr = 'pipe';
    }

    const child = new ChildProcessImpl();
    const process = proc.spawn(command, args, spawnOpts);
    child._init(process, command, args, opts);

    if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
            child.kill();
        });
    }

    if (opts.timeout) {
        setTimeout(() => {
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
        cb = optionsOrCallback as any;
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
    const opts: CModuleProcess.SpawnOptions = {
        cwd: options?.cwd,
        env: options?.env,
        uid: options?.uid,
        gid: options?.gid,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
    };

    try {
        const child = proc.spawn(command, args ?? [], opts);
        const info = child.waitSync();

        return {
            pid: child.pid,
            status: info.exit_status,
            signal: info.term_signal,
            stdout: '',
            stderr: '',
        };
    } catch (err) {
        return {
            error: err as Error,
        };
    }
}

export function execSync(command: string, options?: ExecOptions): Buffer | string {
    const result = spawnSync('/bin/sh', ['-c', command], options);
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