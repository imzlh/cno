/**
 * Node.js child_process module - exec / execFile / fork and the output collector.
 */

const os = import.meta.use('os');

import { Buffer } from '../buffer';
import { decodeOutput, stdioChunkBytes } from './_shared';
import { spawn } from './spawn';
import type {
    ChildProcess,
    ExecCallback,
    ExecFileOptions,
    ExecOptions,
    SpawnOptions,
    StdioEntry,
} from './types';

// exec

export function exec(command: string, callback?: ExecCallback): ChildProcess;
export function exec(command: string, options: ExecOptions, callback?: ExecCallback): ChildProcess;
export function exec(command: string, optionsOrCallback?: ExecOptions | ExecCallback, callback?: ExecCallback): ChildProcess {
    let opts: ExecOptions = {};
    let cb: ExecCallback | undefined;

    if (typeof optionsOrCallback === 'function') {
        cb = optionsOrCallback;
    } else if (optionsOrCallback) {
        opts = optionsOrCallback;
        cb = callback;
    }

    // Node's exec always runs through a shell; spawn owns the invocation layout
    // (including the Windows quote workaround), so just delegate.
    const child = spawn(command, [], {
        ...opts,
        shell: opts.shell ?? true,
        stdio: 'pipe',
    });

    collectOutput(child, cb, command, opts);

    return child;
}

// Back a byte cut off to the previous UTF-8 sequence start so a truncated capture
// never ends in half a character. Only meaningful for byte-oriented text
// encodings; buffer/hex/base64 callers want the exact byte count.
function utf8SafeCut(bytes: Uint8Array, limit: number, encoding?: BufferEncoding | 'buffer' | null): number {
    if (limit <= 0 || limit >= bytes.byteLength) return Math.max(0, Math.min(limit, bytes.byteLength));
    if (encoding === 'buffer' || encoding === null) return limit;
    const normalized = (encoding ?? 'utf8').toLowerCase().replace(/[-_]/g, '');
    if (normalized !== 'utf8') return limit;
    let cut = limit;
    // 0b10xxxxxx is a continuation byte: walk back to its lead byte.
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
    return cut;
}

// Helper: collect stdout/stderr from a child process and invoke callback
function collectOutput(
    child: ChildProcess,
    cb: ((err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) | undefined,
    cmd: string,
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
            // Truncating at a raw byte offset can cut a multi-byte character in
            // half: with maxBuffer 4 and a 6-byte "€€", the tail decoded to
            // "€�" where Node yields "€€" because it counts DECODED units,
            // not bytes. Back the cut off to the last UTF-8 sequence boundary so
            // the retained prefix at least never contains a mangled character.
            if (allowed > 0) chunks.push(bytes.subarray(0, utf8SafeCut(bytes, allowed, options.encoding)));
            const err = Object.assign(new Error(`${streamName} maxBuffer length exceeded`), {
                code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            });
            maxBufferError = err;
            // Node kills with the caller's killSignal, not an unconditional SIGTERM.
            child.kill(options.killSignal);
            return;
        }
        chunks.push(bytes);
        if (streamName === 'stdout') stdoutLength += bytes.byteLength;
        else stderrLength += bytes.byteLength;
    };

    child.stdout?.on('data', (chunk) => pushChunk(stdoutChunks, chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => pushChunk(stderrChunks, chunk, 'stderr'));

    // Node's exec/execFile failure error: `Command failed: <cmd>\n<stderr>` with
    // code = exit status (absent when signalled), plus killed/signal/cmd.
    // Packages branch on err.code, so this shape is load-bearing.
    const makeExitError = (code: number | null, signal: string | null, stderr: string | Buffer): Error => {
        const err = new Error(`Command failed: ${cmd}\n${String(stderr)}`);
        // Node sets code to the exit status, or null when the child was signalled.
        Reflect.set(err, 'code', code);
        Reflect.set(err, 'killed', child.killed);
        Reflect.set(err, 'signal', signal);
        Reflect.set(err, 'cmd', cmd);
        return err;
    };

    const finish = (error: Error | null, code: number | null = null, signal: string | null = null) => {
        if (settled) return;
        settled = true;
        if (!cb) return;
        const stdout = convertCollectedOutput(stdoutChunks, options.encoding);
        const stderr = convertCollectedOutput(stderrChunks, options.encoding);
        let finalError = error ?? maxBufferError;
        if (finalError) {
            // Node decorates a pre-existing failure (spawn error, maxBuffer) with
            // `cmd` ONLY — measured on v24.18: an ENOENT callback error has keys
            // [errno,code,syscall,path,spawnargs,cmd] and a maxBuffer error has
            // [code,cmd], neither carrying killed/signal. killed/signal appear
            // only on the exit-status error built by makeExitError below.
            if (!Reflect.has(finalError, 'cmd')) Reflect.set(finalError, 'cmd', cmd);
        } else if (code !== 0 || signal !== null) {
            finalError = makeExitError(code, signal, stderr);
        }
        cb(finalError, stdout, stderr);
    };

    child.on('error', (err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', (code, signal) => {
        finish(null, typeof code === 'number' ? code : null, typeof signal === 'string' ? signal : null);
    });
}

// Node's exec/execFile fall back to a raw Buffer for an encoding Buffer does not
// know (measured on v24.18: `encoding:'bogus'` yields a Buffer, it does not
// throw), so mirror that instead of letting the decode throw out of the 'close'
// handler and strand the callback.
function convertCollectedOutput(chunks: Uint8Array[], encoding?: BufferEncoding | 'buffer' | null): string | Buffer {
    const buffer = Buffer.concat(chunks);
    if (encoding === 'buffer' || encoding === null || encoding === undefined) {
        return encoding === undefined ? decodeOutput(buffer, 'utf8') : buffer;
    }
    if (!Buffer.isEncoding(encoding)) return buffer;
    return decodeOutput(buffer, encoding);
}

// execFile

export function execFile(file: string): ChildProcess;
export function execFile(file: string, options: ExecFileOptions): ChildProcess;
export function execFile(file: string, callback?: ExecCallback): ChildProcess;
export function execFile(file: string, args: string[]): ChildProcess;
export function execFile(file: string, args: string[], options: ExecFileOptions): ChildProcess;
export function execFile(file: string, args: string[], callback: ExecCallback): ChildProcess;
export function execFile(file: string, args: string[], options: ExecFileOptions, callback: ExecCallback): ChildProcess;
export function execFile(
    file: string,
    argsOrOptionsOrCallback?: string[] | ExecFileOptions | ExecCallback,
    optionsOrCallback?: ExecFileOptions | ExecCallback,
    callback?: ExecCallback
): ChildProcess {
    let args: string[] = [];
    let opts: ExecFileOptions = {};
    let cb: ExecCallback | undefined;

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

    // Node's cmd for execFile is `file args...` (space-joined, unquoted).
    collectOutput(child, cb, [file, ...args].join(' '), opts);

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
        // Node's code for this is ERR_CHILD_PROCESS_IPC_REQUIRED; callers branch on
        // it, and a codeless TypeError is indistinguishable from a bug in their own
        // argument handling.
        throw Object.assign(
            new TypeError("Forked processes must have an IPC channel, missing value 'ipc' in options.stdio"),
            { code: 'ERR_CHILD_PROCESS_IPC_REQUIRED' },
        );
    }
    const { execArgv: _execArgv, execPath: _execPath, silent: _silent, ...spawnOptions } = forkOptions;
    return spawn(forkOptions.execPath ?? os.exePath, [...execArgv, modulePath, ...forkArgs], {
        ...spawnOptions,
        stdio: forkStdio,
    });
}
