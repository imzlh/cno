import { assert } from "../utils/assert";
import { bytesToArrayBuffer, concatChunks } from "../utils/bytes";
import { malloc } from "../utils/malloc";
import { join, resolvePath, toFsPath } from "../utils/path";
import { isWindows } from "../utils/platform";
import { nativeSignalFromNumber, nativeSignalName, probeProcess } from "../utils/signals";
import { wrapFSns, wrapFSErr, wrapDenoError } from "../utils/wrap";
import { matchesErrnoCode } from "../utils/errno";
import { ReadableStream } from "../webapi/streams";
import { closeStreamQuietly, useWritable } from "./utils/pipe-streams";
import { errors } from "./01_errors";

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const proc = import.meta.use('process');
const engine = import.meta.use('engine');
const signal = import.meta.use('signals');
const crypto = import.meta.use('crypto');

type StdioName = 'stdin' | 'stdout' | 'stderr';

function pipe(type: Deno.CommandOptions['stdout'] | undefined, name: StdioName): CModuleProcess.SpawnOptions<false>['stdout'] {
    switch (type) {
        case undefined:
        case 'inherit':
            return 'inherit';
        case 'piped':
            return 'pipe';
        case 'null':
            return 'ignore';
        default:
            throw new TypeError(`unknown variant \`${name}: ${String(type)}\`, expected one of \`inherit\`, \`piped\`, \`null\``);
    }
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
function toDenoSignal(value: CModuleSignals.Signal | null): Deno.Signal | null {
    if (isWindows) return null;
    const name = nativeSignalName(value);
    return name !== null && isDenoSignal(name) ? name : null;
}

function commandCode(exitStatus: number | null | undefined, termSignal: CModuleSignals.Signal | null | undefined): number {
    if (!isWindows && termSignal !== null && termSignal !== undefined) return 128 + termSignal;
    return exitStatus ?? 0;
}

function normalizeSignal(signo?: number | Deno.Signal): CModuleSignals.Signal | undefined {
    if (signo === undefined) return undefined;
    if (typeof signo === 'number') {
        if (!Number.isInteger(signo) || signo < 0 || signo > 0xffffffff) {
            throw new TypeError('data did not match any variant of untagged enum SignalArg');
        }
        const signalNumber = nativeSignalFromNumber(signo);
        if (signalNumber === undefined) throw new TypeError('EINVAL: Invalid argument');
        return signalNumber;
    }

    const name = signalAliases[signo] ?? signo;
    const num = signal?.signals[name];
    if (typeof num != 'number') throw new TypeError(`Invalid signal: ${signo}`);
    return num;
}

function outputOptions(options?: Deno.CommandOptions): Deno.CommandOptions {
    if (options?.stdin === 'piped') {
        throw new TypeError("Piped stdin is not supported for this function, use 'Deno.Command.spawn()' instead");
    }

    // Defaults must not erase invalid raw variants (real Deno rejects
    // {stdout: null} rather than spawning with it); pipe() stays the single
    // validation point, this pass just closes the null-via-?? gap.
    for (const name of ['stdin', 'stdout', 'stderr'] as const) {
        const raw = options?.[name];
        if (raw !== undefined) pipe(raw, name);
    }

    return {
        ...options,
        stdin: options?.stdin ?? 'null',
        stdout: options?.stdout ?? 'piped',
        stderr: options?.stderr ?? 'piped',
    };
}

function commandOutput(
    code: number,
    signal: Deno.Signal | null,
    success: boolean,
    stdout: Uint8Array,
    stderr: Uint8Array,
    options?: Deno.CommandOptions,
): Deno.CommandOutput {
    const output = { code, signal, success } as Deno.CommandOutput;
    for (const [name, bytes] of [['stdout', stdout], ['stderr', stderr]] as const) {
        Object.defineProperty(output, name, {
            enumerable: true,
            configurable: true,
            get: options?.[name] === undefined || options[name] === 'piped'
                ? () => bytes
                : () => { throw new TypeError(`Cannot get '${name}': '${name}' is not piped`); },
        });
    }
    return output;
}

let cachedUmask: number | undefined;

function readUmask(): number {
    if (cachedUmask !== undefined) return cachedUmask;
    const bytes = new Uint8Array(4);
    crypto.randomFill(bytes);
    const path = join(os.tmpDir, `cno-umask-${os.pid}-${crypto.hexEncode(bytes)}`);
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
                        closeStreamQuietly(pipe);
                        controller.close();
                    } else {
                        controller.enqueue(buf.slice(0, n));
                    }
                } catch (e) {
                    closeStreamQuietly(pipe);
                    controller.error(wrapFSErr(e));
                }
            },
            cancel: () => closeStreamQuietly(pipe),
        });
    }

    @wrapDenoError
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
        this.#status = this.#wait.then(
            result => {
                this.#finished = true;
                return {
                    code: commandCode(result.exit_status, result.term_signal),
                    success: commandSuccess(result.exit_status, result.term_signal),
                    signal: toDenoSignal(result.term_signal),
                };
            },
            error => {
                this.#finished = true;
                throw wrapFSErr(error);
            },
        );
    }

    get pid(): number {
        return this.#pid;
    }

    get status(): Promise<Deno.CommandStatus> {
        return this.#status;
    }

    @wrapDenoError
    async output(): Promise<Deno.CommandOutput> {
        const stdout = this.#stdout?.bytes() ?? Promise.resolve(new Uint8Array(0));
        const stderr = this.#stderr?.bytes() ?? Promise.resolve(new Uint8Array(0));
        const f = await this.#wait;
        return commandOutput(
            commandCode(f.exit_status, f.term_signal),
            toDenoSignal(f.term_signal),
            commandSuccess(f.exit_status, f.term_signal),
            await stdout,
            await stderr,
            {
                stdout: this.#stdout ? 'piped' : 'null',
                stderr: this.#stderr ? 'piped' : 'null',
            },
        );
    }

    @wrapDenoError
    kill(signo?: Deno.Signal | number): void {
        if (this.#finished) throw new TypeError('Child process has already terminated');
        if (signo === 0) {
            probeProcess(this.#pid);
            return;
        }
        this.#proc.kill(normalizeSignal(signo));
    }

    // Child handles are not ref-counted by this runtime's event loop.
    ref(): void { }

    unref(): void { }

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

    @wrapDenoError
    async [Symbol.asyncDispose]() {
        if (!this.#finished) this.kill();
        await this.#status;
    }

    @wrapDenoError
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
    const path = toFsPath(cwd);
    let stat: CModuleFS.Stats;
    try {
        stat = fs.stat(path);
    } catch (e) {
        if (matchesErrnoCode(e, 'ENOENT', 'ENOTDIR')) {
            throw new errors.NotFound(`No such cwd: ${path}`);
        }
        throw e;
    }
    if (!stat.isDirectory) throw new errors.NotFound(`cwd is not a directory: ${path}`);
    return path;
}

function ensureCommandPath(path: string, cwd?: string): void {
    if (!/[\\/]/.test(path)) return;
    const statPath = cwd ? resolvePath(path, cwd) : path;
    const stat = fs.stat(statPath);
    if (stat.isDirectory) throw new errors.PermissionDenied(`Permission denied: ${path}`);
    if (os.platform !== 'windows' && (stat.mode & 0o111) === 0) {
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

// Native options shared verbatim by spawn/spawnSync.
function nativeSpawnOptions(cwd: string | undefined, options?: Deno.CommandOptions): CModuleProcess.SpawnOptions<false> {
    return {
        cwd,
        env: commandEnv(options),
        clearEnv: options?.clearEnv,
        stdin: pipe(options?.stdin, 'stdin'),
        stdout: pipe(options?.stdout, 'stdout'),
        stderr: pipe(options?.stderr, 'stderr'),
        detached: options?.detached,
        windowsVerbatimArguments: options?.windowsRawArguments,
        uid: options?.uid,
        gid: options?.gid
    };
}

function spawn(path: string, args: string[], options?: Deno.CommandOptions): CModuleProcess.ChildProcess {
    const cwd = options?.cwd ? commandCwd(options.cwd) : undefined;
    ensureCommandPath(path, cwd);
    const child = proc.spawn([path, ...args], nativeSpawnOptions(cwd, options));
    applyAbort(child, options?.signal);
    return child;
}

/**
 * Native sync spawn can surface Windows launch failures as an InternalError
 * whose message contains only the raw Win32 error. Preserve Deno's NotFound
 * contract for missing executables while leaving unrelated failures intact.
 */
function wrapSpawnErr(e: unknown, path: string): unknown {
    if (typeof e !== 'object' || e === null) return e;
    if (matchesErrnoCode(e, 'ENOENT')) {
        return new errors.NotFound(`Failed to spawn '${path}': entity not found`);
    }
    if (typeof Reflect.get(e, 'code') === 'number') return e;
    const message = String(Reflect.get(e, 'message') ?? '');
    // Win32: 2 = ERROR_FILE_NOT_FOUND, 3 = ERROR_PATH_NOT_FOUND.
    if (/CreateProcess failed:\s*(2|3)\b/.test(message)) {
        return new errors.NotFound(`Failed to spawn '${path}': entity not found`);
    }
    return e;
}

function spawnSync(path: string, args: string[], options?: Deno.CommandOptions): CModuleProcess.SpawnSyncResult {
    const cwd = options?.cwd ? commandCwd(options.cwd) : undefined;
    ensureCommandPath(path, cwd);
    try {
        return proc.spawnSync([path, ...args], nativeSpawnOptions(cwd, options));
    } catch (error) {
        throw wrapSpawnErr(error, path);
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
        this.#path = toFsPath(command);
        this.#args = options?.args ?? [];
        this.#options = options;
        this.#detached = options?.detached ?? false;
    }

    @wrapDenoError
    output(): Promise<Deno.CommandOutput> {
        assert(!this.#detached, "Detached process cannot be waited");

        const proc = spawn(this.#path, this.#args, outputOptions(this.#options));
        const stdo = proc.stdout ? new RStream(proc.stdout).bytes() : Promise.resolve(new Uint8Array(0));
        const stde = proc.stderr ? new RStream(proc.stderr).bytes() : Promise.resolve(new Uint8Array(0));
        return (async () => {
            const res = await proc.wait();
            return commandOutput(
                commandCode(res.exit_status, res.term_signal),
                toDenoSignal(res.term_signal),
                commandSuccess(res.exit_status, res.term_signal),
                await stdo,
                await stde,
                this.#options,
            );
        })();
    }

    @wrapDenoError
    outputSync(): Deno.CommandOutput {
        assert(!this.#detached, "Detached process cannot be waited");

        const res = spawnSync(this.#path, this.#args, outputOptions(this.#options));
        if (res.error) throw wrapSpawnErr(res.error, this.#path);
        return commandOutput(
            commandCode(res.status, res.signal),
            toDenoSignal(res.signal),
            commandSuccess(res.status, res.signal),
            outputBytes(res.stdout),
            outputBytes(res.stderr),
            this.#options,
        );
    }

    @wrapDenoError
    spawn(): Deno.ChildProcess {
        const proc = spawn(this.#path, this.#args, this.#options);
        const child = new ChildProcess(proc, proc.wait(), childProcessToken);
        if (this.#detached) child.unref();
        return child;
    }
}

const processFunctions = wrapFSns({
    kill(pid: number, signo?: number | Deno.Signal): void {
        if (signo === 0) {
            probeProcess(pid);
            return;
        }
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
        const process = spawn(toFsPath(command), args, options);
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
});

// Export exactly the installed surface: functions translate native errors, while
// constructors must remain unwrapped so their private fields and prototypes work.
export const PROCESS_EXPORTS = { ...processFunctions, Command, ChildProcess, Process };
Object.assign(Deno, PROCESS_EXPORTS);
