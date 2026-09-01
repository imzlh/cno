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

import { Readable, Writable } from '../stream';
import { viewToUint8Array } from '../_internal/buffer';
import { normalizeErrnoError } from '../_internal/errno';
import { Buffer } from '../buffer';
export { flattenPrototype } from '../_internal/prototype';

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

// Child stdin teardown is idempotent and best-effort.
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

// Buffer owns Node's encoding table; retain allocation-free UTF fast paths.
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

export interface ShellInvocation {
    command: string;
    args: string[];
    /** Command line must reach CreateProcess untouched (Windows cmd.exe only). */
    verbatim?: boolean;
}

export function buildShellInvocation(
    command: string,
    args: string[],
    shellOption: boolean | string,
): ShellInvocation {
    const isWindows = os.platform === 'windows' || os.platform === 'win32';
    const defaultShell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shell = typeof shellOption === 'string' && shellOption ? shellOption : defaultShell;
    const joined = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    const isCmd = /^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(shell);

    if (!isWindows || !isCmd) return { command: shell, args: ['-c', joined] };
    if (!joined.includes('"')) return { command: shell, args: ['/d', '/s', '/c', joined] };
    // /s consumes the outer quotes and preserves the caller's command text.
    return {
        command: shell,
        args: ['/d', '/s', '/c', `"${joined}"`],
        verbatim: true,
    };
}
