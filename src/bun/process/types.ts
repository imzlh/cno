import type { Buffer } from '../../node/buffer';
import type { BunFileLike } from '../file';

export type BunSignal = NodeJS.Signals | number;
export type BunReadableMode = 'pipe' | 'inherit' | 'ignore' | null | undefined | BunFileLike | ArrayBufferView | number;
export type BunWritableMode = BunReadableMode | ReadableStream<Uint8Array> | Blob | Response | Request;

export interface BunProcessFileSink {
    write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): number | Promise<number>;
    flush(): number | Promise<number>;
    end(error?: Error): number | Promise<number>;
    start(options?: { highWaterMark?: number }): void;
    ref(): void;
    unref(): void;
}

export interface BunProcessResourceUsage {
    contextSwitches: { voluntary: number; involuntary: number };
    cpuTime: { user: bigint; system: bigint; total: bigint };
    maxRSS: number;
    messages: { sent: number; received: number };
    ops: { in: number; out: number };
    shmSize: number;
    signalCount: number;
    swapCount: number;
}

export interface BunSpawnOptions<
    In extends BunWritableMode = BunWritableMode,
    Out extends BunReadableMode = BunReadableMode,
    Err extends BunReadableMode = BunReadableMode,
> {
    cwd?: string;
    detached?: boolean;
    uid?: number;
    gid?: number;
    cgroup?: string | number;
    env?: Record<string, string | undefined>;
    stdio?: [In, Out, Err, ...(BunReadableMode | 'socket-fd')[]];
    stdin?: In;
    stdout?: Out;
    stderr?: Err;
    onExit?(
        subprocess: BunSubprocess<In, Out, Err>,
        exitCode: number | null,
        signalCode: BunSignal | null,
        error?: Error,
    ): void | Promise<void>;
    ipc?: (message: unknown, subprocess: BunSubprocess<In, Out, Err>, handle?: unknown) => void;
    onDisconnect?(): void | Promise<void>;
    serialization?: 'json' | 'advanced';
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
    argv0?: string;
    signal?: AbortSignal;
    timeout?: number;
    killSignal?: BunSignal;
    maxBuffer?: number;
    lazy?: boolean;
    terminal?: unknown;
}

export interface BunSpawnSyncOptions<
    In extends BunWritableMode = BunWritableMode,
    Out extends BunReadableMode = BunReadableMode,
    Err extends BunReadableMode = BunReadableMode,
> extends Omit<BunSpawnOptions<In, Out, Err>, 'lazy' | 'terminal' | 'onExit'> {
    onExit?: never;
}

type ReadableToIO<X extends BunReadableMode> = X extends 'pipe' | undefined
    ? BunReadableStream
    : X extends BunFileLike | ArrayBufferView | number
        ? number
        : undefined;

type WritableToIO<X extends BunWritableMode> = X extends 'pipe'
    ? BunProcessFileSink
    : X extends BunFileLike | ArrayBufferView | Blob | Request | Response | number
        ? number
        : X extends ReadableStream<Uint8Array>
            ? X
            : undefined;

type ReadableToSyncIO<X extends BunReadableMode> = X extends 'pipe' | undefined ? Buffer : undefined;

export type BunReadableStream = ReadableStream<Uint8Array<ArrayBuffer>> & {
    blob(): Promise<Blob>;
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
};

export interface BunSubprocess<
    In extends BunWritableMode = BunWritableMode,
    Out extends BunReadableMode = BunReadableMode,
    Err extends BunReadableMode = BunReadableMode,
> extends AsyncDisposable {
    readonly stdin: WritableToIO<In>;
    readonly stdout: ReadableToIO<Out>;
    readonly stderr: ReadableToIO<Err>;
    readonly terminal: undefined;
    readonly stdio: [null, null, null, ...(number | null)[]];
    readonly readable: ReadableToIO<Out>;
    readonly pid: number;
    readonly exited: Promise<number>;
    readonly exitCode: number | null;
    readonly signalCode: BunSignal | null;
    readonly killed: boolean;
    kill(signal?: BunSignal): void;
    ref(): void;
    unref(): void;
    send(message: unknown): void;
    disconnect(): void;
    resourceUsage(): BunProcessResourceUsage | undefined;
}

export interface BunSyncSubprocess<
    Out extends BunReadableMode = BunReadableMode,
    Err extends BunReadableMode = BunReadableMode,
> {
    stdout: ReadableToSyncIO<Out>;
    stderr: ReadableToSyncIO<Err>;
    exitCode: number | null;
    success: boolean;
    resourceUsage: BunProcessResourceUsage;
    signalCode?: BunSignal;
    exitedDueToTimeout?: boolean;
    exitedDueToMaxBuffer?: boolean;
    pid: number;
}

export interface BunSpawnFunction {
    <
        const In extends BunWritableMode = 'ignore',
        const Out extends BunReadableMode = 'pipe',
        const Err extends BunReadableMode = 'inherit',
    >(options: BunSpawnOptions<In, Out, Err> & { cmd: string[] }): BunSubprocess<In, Out, Err>;
    <
        const In extends BunWritableMode = 'ignore',
        const Out extends BunReadableMode = 'pipe',
        const Err extends BunReadableMode = 'inherit',
    >(cmd: string[], options?: BunSpawnOptions<In, Out, Err>): BunSubprocess<In, Out, Err>;
}

export interface BunSpawnSyncFunction {
    <
        const In extends BunWritableMode = 'ignore',
        const Out extends BunReadableMode = 'pipe',
        const Err extends BunReadableMode = 'pipe',
    >(options: BunSpawnSyncOptions<In, Out, Err> & { cmd: string[] }): BunSyncSubprocess<Out, Err>;
    <
        const In extends BunWritableMode = 'ignore',
        const Out extends BunReadableMode = 'pipe',
        const Err extends BunReadableMode = 'pipe',
    >(cmd: string[], options?: BunSpawnSyncOptions<In, Out, Err>): BunSyncSubprocess<Out, Err>;
}

export type CommandInput = string[] | (BunSpawnOptions & { cmd: string[] });
export type SyncCommandInput = string[] | (BunSpawnSyncOptions & { cmd: string[] });
export type ReadableMode = 'pipe' | 'inherit' | 'ignore' | number;
export type WritableMode = ReadableMode | StaticInput;

export type StaticInput =
    | string
    | ArrayBuffer
    | SharedArrayBuffer
    | ArrayBufferView
    | Blob
    | Request
    | Response
    | ReadableStream<Uint8Array>;

export interface ParsedSpawnOptions {
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin: WritableMode;
    stdout: ReadableMode;
    stderr: ReadableMode;
    detached?: boolean;
    uid?: number;
    gid?: number;
    argv0?: string;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
    onExit?: BunSpawnOptions['onExit'];
    signal?: AbortSignal;
    timeout?: number;
    killSignal?: BunSignal;
    maxBuffer?: number;
}

export interface ParsedSpawnSyncOptions {
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin: WritableMode;
    stdout: ReadableMode;
    stderr: ReadableMode;
    detached?: boolean;
    uid?: number;
    gid?: number;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
}
