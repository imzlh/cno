/**
 * Node.js child_process module - shared internals
 *
 * Errno/pipe/stream plumbing, signal + output decoding, prototype flattening and
 * the shell-invocation builder. Internal to the module: nothing here is part of
 * the public `node:child_process` surface.
 */

const os = import.meta.use('os');
const signals = import.meta.use('signals');
const engine = import.meta.use('engine');
// TODO: `text` had no reader in the pre-split mod.ts either. Kept so the split
// does not drop one of the module's native lookups.
const text = import.meta.use('text');

import { Readable, Writable } from '../stream';
import { getTierLimits } from '../_internal/memory';
import { viewToUint8Array } from '../_internal/buffer';
import { normalizeErrnoError } from '../_internal/errno';
import { Buffer } from '../buffer';

// TODO: READ_BUF_SIZE has no reader in this module (it was already unused before
// the split); kept verbatim so the getTierLimits() call still runs at load time.
const { readBufSize: READ_BUF_SIZE } = getTierLimits();

export function asError(error: unknown, syscall?: string, path?: string): Error {
    return normalizeErrnoError(error, syscall, path);
}

export function startPipeReadQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.startRead();
    } catch {
        // The pipe can already be closing while Readable asks for more data.
    }
}

export function stopPipeReadQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.stopRead();
    } catch {
        // Best-effort back-pressure/EOF cleanup.
    }
}

// True while a piped stdio Readable still owes an 'end'/'close'/'error'.
export function streamEndPending(stream: Readable | null): stream is Readable {
    return !!stream && !stream.readableEnded && !stream.destroyed;
}

// Resolve once a piped stdio Readable has ended, closed, or errored.
export function waitStreamEnd(stream: Readable | null): Promise<void> {
    if (!streamEndPending(stream)) return Promise.resolve();
    return new Promise<void>((resolve) => {
        stream.once('end', resolve);
        stream.once('close', resolve);
        stream.once('error', resolve);
    });
}

// Node's `onexit` destroys the child's stdin unconditionally. There is nothing
// to do when stdio was 'inherit'/'ignore' (no stream object exists at all), and
// a second destroy must stay a no-op — teardown may never turn a child's exit
// into a failure of the exit path itself.
export function destroyChildStdin(stream: Writable | null): void {
    if (!stream || stream.destroyed) return;
    try {
        stream.destroy();
    } catch {
        // Best-effort: the pipe can already be tearing down underneath us.
    }
}

export function stdioChunkBytes(chunk: unknown): Uint8Array {
    if (typeof chunk === 'string') return engine.encodeString(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    if (ArrayBuffer.isView(chunk)) return viewToUint8Array(chunk);
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    throw new TypeError('Child process stdio chunk must be a string or binary buffer');
}

// Node uppercases the signal name before looking it up, so kill('sigterm') works
// (measured on v24.18), and reports an unknown name as ERR_UNKNOWN_SIGNAL.
export function transformSignal(signal?: string | number): number | undefined {
    if (signal === undefined || signal === null) return;
    if (typeof signal === 'string') {
        if (!signals) throw new Error('signal handling is unavailable outside the main thread');
        const signalNumber = signals.signals[signal] ?? signals.signals[signal.toUpperCase()];
        if (typeof signalNumber !== 'number') {
            throw Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: 'ERR_UNKNOWN_SIGNAL' });
        }
        return signalNumber;
    }
    return signal;
}

// Node decodes captured output with Buffer semantics, not TextDecoder's. The
// difference is not cosmetic: TextDecoder rejects 'binary'/'hex'/'base64'/
// 'base64url' outright (RangeError) and decodes 'ascii' as UTF-8, so routing
// through it made `exec`/`execFile` with those encodings throw inside the
// 'close' handler — after collectOutput had already marked itself settled, so
// the callback was never invoked and the caller hung forever (measured: no
// callback after 6s for binary/hex/base64/base64url/unknown). 'ascii' was worse
// than a hang: every byte >= 0x80 came back as U+FFFD where Node masks to 0x7f,
// which is silent corruption of half the byte range.
//
// Buffer.prototype.toString implements exactly Node's table, so use it and keep
// only the utf8/utf16le fast paths that avoid a Buffer allocation.
export function decodeOutput(bytes: Uint8Array, encoding: BufferEncoding): string {
    const normalized = encoding.toLowerCase().replace(/[-_]/g, '');
    if (normalized === 'utf8') return engine.decodeString(bytes);
    if (normalized === 'utf16le' || normalized === 'ucs2') {
        const len = bytes.byteLength & ~1;
        if (len === 0) return '';
        if ((bytes.byteOffset & 1) === 0) {
            return engine.decodeU16String(new Uint16Array(bytes.buffer, bytes.byteOffset, len >>> 1));
        }
        const copy = new Uint8Array(len);
        copy.set(bytes.subarray(0, len));
        return engine.decodeU16String(copy.buffer);
    }
    return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString(encoding);
}

export function flattenPrototype(target: object): void {
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

// Node's shell:true layout. On Windows the joined command goes to
// `cmd.exe /d /s /c` (/d skips AutoRun, /s keeps the outer quote handling).
//
// Windows quoting: Node wraps the whole command in one extra pair of quotes and
// sets windowsVerbatimArguments, so libuv hands the command line to
// CreateProcess untouched and cmd.exe's `/s` strips exactly that outer pair.
// We do the same. `verbatim` is only meaningful on the async path, which
// forwards it to uv_spawn (UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS).
//
// The previous approach passed the command through an environment variable and
// ran `call %VAR%` to dodge libuv's quote_cmd_arg(). That was wrong in three
// measured ways, all because the command text was no longer in the command line
// at parse time:
//   1. Redirection targets were resolved before `call`'s second expansion pass,
//      so `echo x > "%OUT%"` created a file literally named `%OUT%` in the cwd
//      — rc=0, empty stderr, silent data misplacement.
//   2. A caret in a quoted argument came back doubled (`"a^b"` -> `"a^^b"`).
//   3. The internal variable stayed in the child's environment, where a
//      grandchild could read the command text back.
// All three are gone with verbatim args, measured identical to Node v24.18 for
// quotes, `&&`, `||`, pipes, redirection, caret, `%VAR%` expansion depth and
// exit-code propagation.
export interface ShellInvocation {
    command: string;
    args: string[];
    /** Command line must reach CreateProcess untouched (Windows cmd.exe only). */
    verbatim?: boolean;
    /** Sync-path-only fallback: the command travels in an env var (see below). */
    env?: Record<string, string>;
}

// The sync path cannot use verbatim args: tjs_spawn_sync builds its own command
// line (mod_process.c spawn_sync_build_win_cmdline) and never reads the flag, so
// its quoter escapes every inner `"` to `\"` under MSVCRT rules and cmd.exe then
// passes the backslashes through literally. Until that C gap is closed the sync
// path keeps the older `call %VAR%` indirection, which handles quotes correctly
// but mis-resolves redirection targets — see spawnSync, which now refuses that
// one construct loudly instead of writing to the wrong path.
export const SHELL_CMD_ENV = 'CNO_INTERNAL_SHELL_COMMAND';

export function buildShellInvocation(
    command: string,
    args: string[],
    shellOption: boolean | string,
    forSync = false,
): ShellInvocation {
    const isWindows = os.uname().sysname === 'Windows_NT';
    const defaultShell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shell = typeof shellOption === 'string' && shellOption ? shellOption : defaultShell;
    const joined = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    const isCmd = /^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(shell);

    if (!isWindows || !isCmd) return { command: shell, args: ['-c', joined] };
    if (!joined.includes('"')) return { command: shell, args: ['/d', '/s', '/c', joined] };
    if (forSync) {
        return {
            command: shell,
            args: ['/d', '/s', '/c', `call %${SHELL_CMD_ENV}%`],
            env: { [SHELL_CMD_ENV]: joined },
        };
    }
    // Node: args = ['/d', '/s', '/c', `"${command}"`] with verbatim set. The
    // outer quotes are what `/s` consumes, leaving the inner text exactly as
    // the caller wrote it.
    return {
        command: shell,
        args: ['/d', '/s', '/c', `"${joined}"`],
        verbatim: true,
    };
}
