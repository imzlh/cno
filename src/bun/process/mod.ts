import { Buffer } from 'node:buffer';
import { normalizeErrnoError } from '../../node/_internal/errno';
import {
    parseSpawn,
    parseSpawnSync,
    assertSyncExecutable,
    blobInputStream,
    isBlobInput,
    nativeMode,
    syncInput,
} from './options';
import { FileSink, copyInputBytes, isBufferInput, pipeInput, readablePipe } from './streams';
import { nativeSignalFromNumber, nativeSignalName, nodeNativeSignalNumber, probeProcess, unknownSignalError } from '../../utils/signals';
import type {
    BunProcessResourceUsage,
    BunSignal,
    BunSpawnFunction,
    BunSpawnSyncFunction,
    BunSubprocess,
    BunSyncSubprocess,
    ParsedSpawnOptions,
    StaticInput,
} from './types';

const processBinding = import.meta.use('process');

function nativeOptions(options: ParsedSpawnOptions, stdinPipe: boolean): CModuleProcess.SpawnOptions<false> {
    return {
        cwd: options.cwd,
        env: options.env,
        clearEnv: options.env !== undefined,
        stdin: nativeMode(options.stdin, stdinPipe),
        stdout: nativeMode(options.stdout),
        stderr: nativeMode(options.stderr),
        detached: options.detached,
        uid: options.uid,
        gid: options.gid,
        argv0: options.argv0,
        background: options.windowsHide,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
    };
}

function inputStream(value: StaticInput): ReadableStream<Uint8Array> {
    if (value instanceof ReadableStream) return value;
    if (isBufferInput(value)) {
        const bytes = copyInputBytes(value);
        return new ReadableStream<Uint8Array>({
            start(controller) {
                if (bytes.byteLength > 0) controller.enqueue(bytes);
                controller.close();
            },
        });
    }
    if (isBlobInput(value)) return blobInputStream(value);
    if (value instanceof Request || value instanceof Response) {
        return value.body ?? new Blob([]).stream();
    }
    throw new TypeError('Unsupported Bun.spawn stdin source');
}

function toNativeSignal(signal?: BunSignal): CModuleSignals.Signal | undefined {
    if (signal === undefined) return undefined;
    const signalNumber = typeof signal === 'number'
        ? nativeSignalFromNumber(signal)
        : nodeNativeSignalNumber(signal);
    if (typeof signalNumber !== 'number') throw unknownSignalError(signal);
    return signalNumber;
}

function callbackFailure(error: unknown): void {
    queueMicrotask(() => { throw error; });
}

// Timer delays above this overflow to 1ms and would fire immediately.
const MAX_TIMER_DELAY = 2 ** 31 - 1;

class SubprocessImpl {
    #native: CModuleProcess.ChildProcess;
    #stdin: FileSink | ReadableStream<Uint8Array> | number | undefined;
    #stdout: ReadableStream<Uint8Array<ArrayBuffer>> | number | undefined;
    #stderr: ReadableStream<Uint8Array<ArrayBuffer>> | number | undefined;
    #pid: number;
    #exited: Promise<number>;
    #exitCode: number | null = null;
    #signalCode: BunSignal | null = null;
    #finished = false;
    #stdio: [null, null, null] = [null, null, null];

    constructor(native: CModuleProcess.ChildProcess, options: ParsedSpawnOptions) {
        this.#native = native;
        this.#pid = native.pid;

        const staticInput = options.stdin !== 'pipe'
            && options.stdin !== 'ignore'
            && options.stdin !== 'inherit'
            && typeof options.stdin !== 'number';
        const nativeSink = native.stdin ? new FileSink(native.stdin) : undefined;
        if (options.stdin === 'pipe') this.#stdin = nativeSink;
        else if (typeof options.stdin === 'number') this.#stdin = options.stdin;
        else if (staticInput && options.stdin instanceof ReadableStream) this.#stdin = options.stdin;

        // maxBuffer is per stream, like Bun: exceeding it kills the child.
        const limit = options.maxBuffer;
        const bufferGuard = limit === undefined ? undefined : () => {
            let total = 0;
            return (length: number) => {
                total += length;
                if (total > limit) {
                    try { this.kill(options.killSignal); } catch { /* already gone */ }
                }
            };
        };
        if (native.stdout) this.#stdout = readablePipe(native.stdout, bufferGuard?.());
        else if (typeof options.stdout === 'number') this.#stdout = options.stdout;
        if (native.stderr) this.#stderr = readablePipe(native.stderr, bufferGuard?.());
        else if (typeof options.stderr === 'number') this.#stderr = options.stderr;

        const onExit = options.onExit;
        this.#exited = native.wait().then((info) => {
            this.#finished = true;
            if (info.term_signal) {
                this.#signalCode = nativeSignalName(info.term_signal) as BunSignal | null;
                this.#exitCode = null;
            } else {
                this.#exitCode = info.exit_status;
            }
            // libuv reports exit_status=0 for an asynchronously signalled process.
            const code = info.term_signal ? 128 + info.term_signal : this.#exitCode!;
            if (onExit) {
                try {
                    const result = Reflect.apply(onExit, this, [this, this.#exitCode, this.#signalCode, undefined]);
                    void Promise.resolve(result).catch(callbackFailure);
                } catch (error) {
                    callbackFailure(error);
                }
            }
            return code;
        }, (error) => {
            this.#finished = true;
            if (onExit) {
                try {
                    const result = Reflect.apply(onExit, this, [this, null, null, error]);
                    void Promise.resolve(result).catch(callbackFailure);
                } catch (callbackError) {
                    callbackFailure(callbackError);
                }
            }
            throw error;
        });

        let timeout: ReturnType<typeof setTimeout> | undefined;
        if (options.timeout !== undefined && options.timeout > 0) {
            const arm = (remaining: number): void => {
                const step = Math.min(remaining, MAX_TIMER_DELAY);
                timeout = setTimeout(() => {
                    if (remaining > step) arm(remaining - step);
                    else {
                        try { this.kill(options.killSignal); } catch (error) { callbackFailure(error); }
                    }
                }, step);
            };
            arm(options.timeout);
        }
        const abort = options.signal
            ? () => {
                try { this.kill(options.killSignal); } catch (error) { callbackFailure(error); }
            }
            : undefined;
        options.signal?.addEventListener('abort', abort!, { once: true });
        void this.#exited.finally(() => {
            if (timeout !== undefined) clearTimeout(timeout);
            if (abort) options.signal?.removeEventListener('abort', abort);
        }).catch(() => {});

        if (staticInput && nativeSink) {
            void pipeInput(inputStream(options.stdin as StaticInput), nativeSink).catch(() => {
                try { this.kill(options.killSignal); } catch (error) { callbackFailure(error); }
            });
        }
    }

    get stdin(): FileSink | ReadableStream<Uint8Array> | number | undefined { return this.#stdin; }
    get stdout(): ReadableStream<Uint8Array<ArrayBuffer>> | number | undefined { return this.#stdout; }
    get stderr(): ReadableStream<Uint8Array<ArrayBuffer>> | number | undefined { return this.#stderr; }
    get readable(): ReadableStream<Uint8Array<ArrayBuffer>> | number | undefined { return this.#stdout; }
    get writable(): FileSink | ReadableStream<Uint8Array> | number | undefined { return this.#stdin; }
    get terminal(): undefined { return undefined; }
    get stdio(): [null, null, null] { return this.#stdio; }
    get pid(): number { return this.#pid; }
    get exited(): Promise<number> { return this.#exited; }
    get exitCode(): number | null { return this.#exitCode; }
    get signalCode(): BunSignal | null { return this.#signalCode; }
    get killed(): boolean { return this.#finished; }
    get connected(): boolean { return false; }

    kill(signal?: BunSignal): void {
        if (this.#finished) return;
        if (signal === 0) {
            probeProcess(this.#pid);
            return;
        }
        this.#native.kill(toNativeSignal(signal));
    }

    ref(): void {
        // Native process handles do not expose per-handle loop references yet.
    }

    unref(): void {
        // Kept as a Bun-compatible no-op until the native handle exposes it.
    }

    send(): void {
        throw new Error('Bun.spawn IPC is unsupported by this runtime');
    }

    disconnect(): void {
        throw new Error('Bun.spawn IPC is unsupported by this runtime');
    }

    resourceUsage(): BunProcessResourceUsage | undefined {
        // libuv reaps asynchronous children internally without exposing wait4
        // data. Returning undefined is honest; a shared cumulative snapshot is
        // not attributable when several children exit concurrently.
        return undefined;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.#finished) this.kill();
        await this.#exited;
    }

    get [Symbol.toStringTag](): string { return 'Subprocess'; }
}

for (const name of [
    'stdin', 'stdout', 'stderr', 'readable', 'writable', 'terminal', 'stdio',
    'pid', 'exited', 'exitCode', 'signalCode', 'killed', 'connected',
    'kill', 'ref', 'unref', 'send', 'disconnect', 'resourceUsage',
]) {
    const descriptor = Object.getOwnPropertyDescriptor(SubprocessImpl.prototype, name);
    if (descriptor) Object.defineProperty(SubprocessImpl.prototype, name, { ...descriptor, enumerable: true });
}

function spawnImpl(input: unknown, options?: unknown): BunSubprocess {
    const parsed = parseSpawn(input, options);
    const staticInput = parsed.stdin !== 'pipe'
        && parsed.stdin !== 'ignore'
        && parsed.stdin !== 'inherit'
        && typeof parsed.stdin !== 'number';
    try {
        const native = processBinding.spawn(parsed.command, nativeOptions(parsed, staticInput));
        return new SubprocessImpl(native, parsed) as unknown as BunSubprocess;
    } catch (error) {
        throw normalizeErrnoError(error, 'posix_spawn', parsed.command[0]);
    }
}

function spawnSyncImpl(input: unknown, options?: unknown): BunSyncSubprocess {
    const parsed = parseSpawnSync(input, options);
    const command = parsed.command[0]!;
    assertSyncExecutable(command, parsed.cwd, parsed.env);
    const inputBytes = syncInput(parsed.stdin);
    let result: CModuleProcess.SpawnSyncResult;
    try {
        result = processBinding.spawnSync(parsed.command, {
            cwd: parsed.cwd,
            env: parsed.env,
            clearEnv: parsed.env !== undefined,
            stdin: nativeMode(parsed.stdin),
            stdout: nativeMode(parsed.stdout),
            stderr: nativeMode(parsed.stderr),
            detached: parsed.detached,
            uid: parsed.uid,
            gid: parsed.gid,
            background: parsed.windowsHide,
            windowsVerbatimArguments: parsed.windowsVerbatimArguments,
            input: inputBytes,
        });
    } catch (error) {
        throw normalizeErrnoError(error, 'posix_spawn', command);
    }
    if (result.error) throw normalizeErrnoError(result.error, 'posix_spawn', command);

    const signalCode = nativeSignalName(result.signal) as BunSignal | null;
    const exitCode = signalCode === null ? (result.status ?? 0) : null;
    const output: Record<string, unknown> = { exitCode };
    if (signalCode !== null) output.signalCode = signalCode;
    output.stdout = result.stdout === null ? undefined : Buffer.from(result.stdout);
    output.stderr = result.stderr === null ? undefined : Buffer.from(result.stderr);
    output.success = exitCode === 0 && signalCode === null;
    output.resourceUsage = result.resourceUsage;
    output.pid = result.pid;
    return output as unknown as BunSyncSubprocess;
}

export const spawn = ((input: unknown, options: unknown = undefined) =>
    spawnImpl(input, options)) as BunSpawnFunction;
export const spawnSync = ((input: unknown, options: unknown = undefined) =>
    spawnSyncImpl(input, options)) as BunSpawnSyncFunction;

export type { BunSpawnOptions, BunSubprocess, BunSyncSubprocess } from './types';
export { FileSink } from './streams';
