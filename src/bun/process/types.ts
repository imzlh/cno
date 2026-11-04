import type * as BunTypes from 'bun';

export type BunSignal = NodeJS.Signals | number;
export type BunReadableMode = BunTypes.Spawn.Readable;
export type BunWritableMode = BunTypes.Spawn.Writable;

// The native adapter implements only the FileSink operations used by spawn.
export interface BunProcessFileSink {
    write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): number | Promise<number>;
    flush(): number | Promise<number>;
    end(error?: Error): number | Promise<number>;
    start(options?: { highWaterMark?: number }): void;
    ref(): void;
    unref(): void;
}

export type BunProcessResourceUsage = BunTypes.ResourceUsage;
export type BunSpawnOptions<
    In extends BunWritableMode = BunWritableMode,
    Out extends BunReadableMode = BunReadableMode,
    Err extends BunReadableMode = BunReadableMode,
> = BunTypes.Spawn.SpawnOptions<In, Out, Err>;
export type BunSpawnSyncOptions<
    In extends BunWritableMode = BunWritableMode,
    Out extends BunReadableMode = BunReadableMode,
    Err extends BunReadableMode = BunReadableMode,
> = BunTypes.Spawn.SpawnSyncOptions<In, Out, Err> & { onExit?: never };
// Bun adds these methods to its process pipes; keep them local to avoid
// augmenting Deno's global ReadableStream type.
export type BunReadableStream = BunTypes.Spawn.ReadableToIO<'pipe'> & {
    blob(): Promise<Blob>;
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
};
export type BunSubprocess<
    In extends BunWritableMode = BunWritableMode,
    Out extends BunReadableMode = BunReadableMode,
    Err extends BunReadableMode = BunReadableMode,
> = BunTypes.Subprocess<In, Out, Err>;
export type BunSyncSubprocess<
    Out extends BunReadableMode = BunReadableMode,
    Err extends BunReadableMode = BunReadableMode,
> = BunTypes.SyncSubprocess<Out, Err>;
export type BunSpawnFunction = typeof BunTypes.spawn;
export type BunSpawnSyncFunction = typeof BunTypes.spawnSync;

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
