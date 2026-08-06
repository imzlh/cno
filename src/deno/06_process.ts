import { assert } from "../utils/assert";
import { bytesToArrayBuffer, concatChunks } from "../utils/bytes";
import { malloc } from "../utils/malloc";
import { join } from "../utils/path";
import { isWindows } from "../utils/platform";
import { wrapFsClassDec as wrap, wrapFSns } from "../utils/wrap";
import { ReadableStream } from "../webapi/streams";
import { toString } from "./02_fs";
import { useWritable } from "./05_net";
import { errors } from "./01_errors";

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const proc = import.meta.use('process');
const pty = import.meta.use('pty');
const engine = import.meta.use('engine');
const signal = import.meta.use('signals');
const crypto = import.meta.use('crypto');
const sysError = import.meta.use('error');

type StdioName = 'stdin' | 'stdout' | 'stderr';

function pipe(type: Deno.CommandOptions['stdout'] | undefined, _name: StdioName): CModuleProcess.SpawnOptions<false>['stdout'] {
    switch (type) {
        case undefined:
        case 'inherit':
            return 'inherit';
        case 'piped':
            return 'pipe';
        case 'null':
            return 'ignore';
        default:
            throw new TypeError(`unknown variant \`${String(type)}\`, expected one of \`inherit\`, \`piped\`, \`null\``);
    }
}

function validateStdioOptions(options?: Deno.CommandOptions): void {
    if (!options) return;
    pipe(options.stdin, 'stdin');
    pipe(options.stdout, 'stdout');
    pipe(options.stderr, 'stderr');
}

const signalAliases: Record<string, string> = {
    SIGIO: 'SIGPOLL',
    SIGUNUSED: 'SIGSYS',
};

const denoSignalNames = [
    'SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGEMT',
    'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINFO', 'SIGINT', 'SIGIO', 'SIGPOLL',
    'SIGUNUSED', 'SIGKILL', 'SIGPIPE', 'SIGPROF', 'SIGPWR', 'SIGQUIT',
    'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP',
    'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2',
    'SIGVTALRM', 'SIGWINCH',
] as const satisfies readonly Deno.Signal[];
const denoSignals: ReadonlySet<string> = new Set(denoSignalNames);

function isDenoSignal(value: string): value is Deno.Signal {
    return denoSignals.has(value);
}

// Windows has no signals: TerminateProcess yields a plain exit code, so upstream
// Deno always reports `signal: null` and the raw status there.
function toDenoSignal(value: string | null): Deno.Signal | null {
    if (isWindows) return null;
    return value !== null && isDenoSignal(value) ? value : null;
}

function commandCode(exitStatus: number | null | undefined, termSignal: string | null | undefined): number {
    const denoSignal = termSignal ? toDenoSignal(termSignal) : null;
    if (denoSignal !== null) {
        const nativeName = signalAliases[denoSignal] ?? denoSignal;
        const signalNumber = signal?.signals[nativeName];
        if (typeof signalNumber === 'number') return 128 + signalNumber;
    }
    return exitStatus ?? 0;
}

function normalizeSignal(signo?: number | Deno.Signal): number | undefined {
    if (signo === undefined) return undefined;
    if (typeof signo === 'number') {
        if (!Number.isInteger(signo) || signo < 0 || signo > 0xffffffff) {
            throw new TypeError('data did not match any variant of untagged enum SignalArg');
        }
        return signo;
    }

    const name = signalAliases[signo] ?? signo;
    const num = signal?.signals[name];
    if (typeof num != 'number') throw new TypeError(`Invalid signal: ${signo}`);
    return num;
}

function outputOptions(options?: Deno.CommandOptions): Deno.CommandOptions {
    validateStdioOptions(options);
    if (options?.stdin === 'piped') {
        throw new TypeError("Piped stdin is not supported for this function, use 'Deno.Command.spawn()' instead");
    }
    if (options?.stdout !== undefined && options.stdout !== 'piped') {
        throw new TypeError("Cannot get 'stdout': 'stdout' is not piped");
    }
    if (options?.stderr !== undefined && options.stderr !== 'piped') {
        throw new TypeError("Cannot get 'stderr': 'stderr' is not piped");
    }

    return {
        ...options,
        stdin: options?.stdin ?? 'null',
        stdout: 'piped',
        stderr: 'piped',
    };
}

let cachedUmask: number | undefined;

function readUmask(): number {
    if (cachedUmask !== undefined) return cachedUmask;
    const bytes = new Uint8Array(4);
    crypto.randomFill(bytes);
    const path = `${os.tmpDir}/cno-umask-${os.pid}-${crypto.hexEncode(bytes)}`;
    try {
        fs.mkdir(path, 0o777);
        const mode = fs.stat(path).mode & 0o777;
        fs.rmdir(path);
        cachedUmask = 0o777 & ~mode;
    } catch {
        cachedUmask = 0o022;
    }
    return cachedUmask;
}

class RStream extends ReadableStream<Uint8Array<ArrayBuffer>> implements Deno.SubprocessReadableStream {
    constructor(private pipe: CModuleProcess.Pipe) {
        super({
            async pull(controller) {
                try {
                    const buf = malloc(controller);
                    const n = await pipe.read(buf);
                    if (n === 0) {
                        controller.close();
                    } else {
                        controller.enqueue(buf.slice(0, n));
                    }
                } catch (e) {
                    controller.error(e);
                }
            }
        });
    }

    @wrap
    private async readAll() {
        const bufs: Uint8Array[] = [];
        const reader = this.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bufs.push(value);
        }
        return concatChunks(bufs);
    }

    async text(): Promise<string> {
        const buf = await this.readAll();
        return engine.decodeString(buf);
    }

    async json<T = unknown>(): Promise<T> {
        return JSON.parse(await this.text());
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = await this.readAll();
        return bytesToArrayBuffer(buf);
    }

    bytes(): Promise<Uint8Array<ArrayBuffer>> {
        return this.readAll();
    }
}

const childProcessToken = Symbol('Deno.ChildProcess');

export class ChildProcess implements Deno.ChildProcess {
    #proc: CModuleProcess.ChildProcess;
    #wait: Promise<CModuleProcess.ExitInfo>;
    #stdin?: WritableStream<Uint8Array>;
    #stdout?: RStream;
    #stderr?: RStream;
    #pid: number;
    #status: Promise<Deno.CommandStatus>;
    #finished = false;

    constructor(proc?: CModuleProcess.ChildProcess, wait?: Promise<CModuleProcess.ExitInfo>, token?: symbol) {
        if (token !== childProcessToken || !proc || !wait) {
            throw new TypeError('Deno.ChildProcess cannot be constructed directly');
        }
        this.#proc = proc;
        this.#wait = wait;
        if (proc.stdin) this.#stdin = useWritable(proc.stdin);
        if (proc.stdout) this.#stdout = new RStream(proc.stdout);
        if (proc.stderr) this.#stderr = new RStream(proc.stderr);
        this.#pid = proc.pid;
        this.#status = this.#wait.then(f => {
            this.#finished = true;
            return {
                code: commandCode(f.exit_status, f.term_signal),
                success: commandSuccess(f.exit_status, f.term_signal),
                signal: toDenoSignal(f.term_signal)
            };
        });
    }

    get pid(): number {
        return this.#pid;
    }

    get status(): Promise<Deno.CommandStatus> {
        return this.#status;
    }

    @wrap
    async output(): Promise<Deno.CommandOutput> {
        if (!this.#stdout) throw new TypeError("Cannot get 'stdout': 'stdout' is not piped");
        if (!this.#stderr) throw new TypeError("Cannot get 'stderr': 'stderr' is not piped");
        const stdout = this.#stdout.bytes();
        const stderr = this.#stderr.bytes();
        const f = await this.#wait;
        return {
            code: commandCode(f.exit_status, f.term_signal),
            signal: toDenoSignal(f.term_signal),
            success: commandSuccess(f.exit_status, f.term_signal),
            stderr: await stderr,
            stdout: await stdout
        };
    }

    @wrap
    kill(signo?: Deno.Signal | number): void {
        if (this.#finished) throw new TypeError('Child process has already terminated');
        this.#proc.kill(normalizeSignal(signo));
    }

    ref(): void { /* no-op: process lifecycle not managed by ref counting */ }

    unref(): void { /* no-op */ }

    get stdin(): WritableStream<Uint8Array<ArrayBufferLike>> {
        if (!this.#stdin) throw new TypeError("Cannot get 'stdin': 'stdin' is not piped");
        return this.#stdin;
    }

    get stdout(): Deno.SubprocessReadableStream {
        if (!this.#stdout) throw new TypeError("Cannot get 'stdout': 'stdout' is not piped");
        return this.#stdout;
    }

    get stderr(): Deno.SubprocessReadableStream {
        if (!this.#stderr) throw new TypeError("Cannot get 'stderr': 'stderr' is not piped");
        return this.#stderr;
    }

    @wrap
    async [Symbol.asyncDispose]() {
        if (!this.#finished) this.kill();
        await this.#status;
    }

    @wrap
    async resize(cols: number, rows: number): Promise<void> {
        const stdin = this.#proc.stdin?.fileno;
        assert(stdin !== undefined, "stdin is not piped");
        return this.#proc.resize(cols, rows);
    }
}

class Process {
    constructor() {
        throw new TypeError('Deno.Process cannot be constructed directly');
    }
}

function commandEnv(options?: Deno.CommandOptions): Record<string, string> | undefined {
    if (!options?.clearEnv && !options?.env) return undefined;
    if (options.clearEnv) return { ...(options.env ?? {}) };
    return { ...Deno.env.toObject(), ...options.env };
}

function commandCwd(cwd: string | URL): string {
    const path = toString(cwd);
    let stat: CModuleFS.Stats;
    try {
        stat = fs.stat(path);
    } catch (e) {
        const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
        if (code === sysError.errno.ENOENT || code === sysError.errno.ENOTDIR) {
            throw new errors.NotFound(`No such cwd: ${path}`);
        }
        throw e;
    }
    if (!stat.isDirectory) throw new errors.NotFound(`cwd is not a directory: ${path}`);
    return path;
}

function isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function ensureCommandPath(path: string, cwd?: string): void {
    if (!/[\\/]/.test(path)) return;
    const statPath = cwd && !isAbsolutePath(path) ? join(cwd, path) : path;
    const stat = fs.stat(statPath);
    if (stat.isDirectory) throw new errors.PermissionDenied(`Permission denied: ${path}`);
    if (os.uname().sysname !== 'Windows_NT' && (stat.mode & 0o111) === 0) {
        throw new errors.PermissionDenied(`Permission denied: ${path}`);
    }
}

function applyAbort(child: CModuleProcess.ChildProcess, signal?: AbortSignal): void {
    if (!signal) return;
    const abort = () => {
        try {
            child.kill(normalizeSignal('SIGTERM'));
        } catch {
            // Process may have exited before the abort signal was observed.
        }
    };
    if (signal.aborted) {
        abort();
        return;
    }
    signal.addEventListener('abort', abort, { once: true });
    child.wait().finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
}

function spawn(path: string, args: string[], options?: Deno.CommandOptions): CModuleProcess.ChildProcess {
    const cwd = options?.cwd ? commandCwd(options.cwd) : undefined;
    ensureCommandPath(path, cwd);
    const child = proc.spawn([path, ...args], {
        cwd,
        env: commandEnv(options),
        clearEnv: options?.clearEnv,
        stdin: pipe(options?.stdin, 'stdin'),
        stdout: pipe(options?.stdout, 'stdout'),
        stderr: pipe(options?.stderr, 'stderr'),
        detached: options?.detached,
        uid: options?.uid,
        gid: options?.gid
    });
    applyAbort(child, options?.signal);
    return child;
}

/**
 * The native sync spawn surfaces launch failures as an InternalError carrying a
 * raw Win32 code in its message and no numeric `code`, so wrapFSErr cannot
 * classify it. Real Deno reports a missing executable as NotFound/ENOENT for
 * both the async and sync paths; the async path already arrives as UV_ENOENT.
 */
function wrapSpawnErr(e: unknown, path: string): unknown {
    if (typeof e !== 'object' || e === null) return e;
    if (typeof Reflect.get(e, 'code') === 'number') return e;
    const message = String(Reflect.get(e, 'message') ?? '');
    // Win32: 2 = ERROR_FILE_NOT_FOUND, 3 = ERROR_PATH_NOT_FOUND.
    if (/CreateProcess failed:\s*(2|3)\b/.test(message) || /ENOENT/.test(message)) {
        return new errors.NotFound(`Failed to spawn '${path}': entity not found`);
    }
    return e;
}

function spawnSync(path: string, args: string[], options?: Deno.CommandOptions): CModuleProcess.SpawnSyncResult {
    const cwd = options?.cwd ? commandCwd(options.cwd) : undefined;
    ensureCommandPath(path, cwd);
    try {
        return proc.spawnSync([path, ...args], {
            cwd,
            env: commandEnv(options),
            clearEnv: options?.clearEnv,
            stdin: pipe(options?.stdin, 'stdin'),
            stdout: pipe(options?.stdout, 'stdout'),
            stderr: pipe(options?.stderr, 'stderr'),
            detached: options?.detached,
            uid: options?.uid,
            gid: options?.gid
        });
    } catch (e) {
        throw wrapSpawnErr(e, path);
    }
}

function commandArgs(
    optOrArgs?: Deno.CommandOptions | string[],
    opt?: Deno.CommandOptions,
): { args: string[]; options?: Deno.CommandOptions } {
    const options = Array.isArray(optOrArgs) ? opt : optOrArgs;
    const args = Array.isArray(optOrArgs) ? optOrArgs : options?.args ?? [];
    return { args, options };
}

function outputBytes(buffer: ArrayBuffer | null): Uint8Array<ArrayBuffer> {
    return new Uint8Array(buffer ? buffer.slice(0) : new ArrayBuffer(0));
}

function commandSuccess(code: number | null | undefined, signal: unknown): boolean {
    return (code ?? 0) === 0 && signal == null;
}

class Command implements Deno.Command {
    #path: string;
    #args: string[];
    #options: Deno.CommandOptions | undefined;
    #detached: boolean;

    constructor(command: string | URL, options?: Deno.CommandOptions) {
        this.#path = toString(command);
        this.#args = options?.args ?? [];
        this.#options = options;
        this.#detached = options?.detached ?? false;
    }

    @wrap
    async output(): Promise<Deno.CommandOutput> {
        assert(!this.#detached, "Detached process cannot be waited");

        const proc = spawn(this.#path, this.#args, outputOptions(this.#options));
        const stdo = proc.stdout ? new RStream(proc.stdout).bytes() : Promise.resolve(new Uint8Array(0));
        const stde = proc.stderr ? new RStream(proc.stderr).bytes() : Promise.resolve(new Uint8Array(0));
        const res = await proc.wait();
        return {
            code: commandCode(res.exit_status, res.term_signal),
            signal: toDenoSignal(res.term_signal),
            success: commandSuccess(res.exit_status, res.term_signal),
            stderr: await stde,
            stdout: await stdo
        };
    }

    @wrap
    outputSync(): Deno.CommandOutput {
        assert(!this.#detached, "Detached process cannot be waited");

        const res = spawnSync(this.#path, this.#args, outputOptions(this.#options));
        if (res.error) throw wrapSpawnErr(res.error, this.#path);
        return {
            code: commandCode(res.status, res.signal),
            signal: toDenoSignal(res.signal),
            success: commandSuccess(res.status, res.signal),
            stderr: outputBytes(res.stderr),
            stdout: outputBytes(res.stdout)
        };
    }

    @wrap
    spawn(): Deno.ChildProcess {
        const proc = spawn(this.#path, this.#args, this.#options);
        const child = new ChildProcess(proc, proc.wait(), childProcessToken);
        if (this.#detached) child.unref();
        return child;
    }
}

Object.assign(Deno, wrapFSns({
    kill(pid: number, signo?: number | Deno.Signal): void {
        proc.kill(pid, normalizeSignal(signo));
    },

    umask(mask?: number): number {
        const old = readUmask();
        if (mask !== undefined) cachedUmask = mask;
        return old;
    },

    // unstable, but useful
    spawn(command: string | URL, optOrArgs?: Deno.CommandOptions | string[], opt?: Deno.CommandOptions): Deno.ChildProcess {
        const { args, options } = commandArgs(optOrArgs, opt);
        const process = spawn(toString(command), args, options);
        return new ChildProcess(process, process.wait(), childProcessToken);
    },

    spawnAndWait(command: string | URL, optOrArgs?: Deno.CommandOptions | string[], opt?: Deno.CommandOptions): Promise<Deno.CommandOutput> {
        const { args, options } = commandArgs(optOrArgs, opt);
        return new Command(command, { ...options, args }).output();
    },

    spawnAndWaitSync(command: string | URL, optOrArgs?: Deno.CommandOptions | string[], opt?: Deno.CommandOptions): Deno.CommandOutput {
        const { args, options } = commandArgs(optOrArgs, opt);
        return new Command(command, { ...options, args }).outputSync();
    },
}));

// class constructor should NEVER being wrapped
Reflect.set(Deno, "Command", Command);
Reflect.set(Deno, "ChildProcess", ChildProcess);
Reflect.set(Deno, "Process", Process);
