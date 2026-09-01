/**
 * Node.js child_process module - type definitions
 *
 * Shared across the sibling implementation modules. The internal aliases
 * (StdioEntry / NativeStdio / ChildStdioStream / SpawnInput / ExecCallback) are
 * exported for the siblings only — mod.ts deliberately does not re-export them.
 */

import type { EventEmitter } from '../events';
import type { Writable, Readable, Duplex } from '../stream';
import type { Buffer } from '../buffer';

// Type definitions
export type StdioEntry = 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'ipc' | number | null | undefined;
export type NativeStdio = CModuleProcess.SpawnOptions<false>['stdin'];
export type ChildStdioStream = Writable | Readable | Duplex | null;
export type SpawnInput = string | ArrayBuffer | ArrayBufferView;

export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | number | boolean | null | undefined>;
    argv0?: string;
    stdio?: StdioEntry[] | 'pipe' | 'overlapped' | 'ignore' | 'inherit';
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
    /** Cap on captured stdout/stderr (spawnSync: enforced post-hoc, see mod docs). */
    maxBuffer?: number;
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
    channel?: { ref(): void; unref(): void } | null;
    kill(signal?: string | number): boolean;
    disconnect(): void;
    ref(): void;
    unref(): void;
    send(message: unknown, callback?: (error: Error | null) => void): boolean;
    send(message: unknown, sendHandle?: unknown, options?: unknown, callback?: (error: Error | null) => void): boolean;
}

export type ExecCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;

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
