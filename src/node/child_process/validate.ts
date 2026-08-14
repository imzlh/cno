/**
 * Node.js child_process module - stdio / maxBuffer / timeout validation
 *
 * Everything that rejects a bad option before a child is spawned, plus the
 * StdioEntry -> native-slot converters. Internal to the module.
 */

import type { NativeStdio, SpawnOptions, StdioEntry } from './types';

// Node rejects an stdio entry it does not recognise instead of guessing. Without
// this, `toNativeStdio` fell through to 'inherit' for every unknown value, so
// `stdio: [{}, 'pipe', 'pipe']` (or `true`, or a typo'd mode string) silently
// spawned with the child wired to the PARENT's console — output going somewhere
// the caller never asked for, with no error at all. Node throws
// ERR_INVALID_ARG_VALUE for those (measured on v24.18).
//
// Streams are accepted only via a numeric `fd`, which is how Node accepts an
// fs.WriteStream; the caller-visible behaviour of a bare numeric fd is handled by
// assertRedirectableFd below.
export function stdioEntryIsValid(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'number') return Number.isInteger(value);
    if (typeof value === 'string') {
        return value === 'pipe' || value === 'overlapped' || value === 'ignore'
            || value === 'inherit' || value === 'ipc';
    }
    return false;
}

export function describeStdioValue(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return `'${value}'`;
    if (typeof value === 'object') {
        const keys = Object.keys(value as object);
        return keys.length === 0 ? '{}' : `{ ${keys.join(', ')} }`;
    }
    return String(value);
}

export function invalidStdioError(value: unknown): TypeError {
    return Object.assign(
        new TypeError(`The argument 'stdio' is invalid. Received ${describeStdioValue(value)}`),
        { code: 'ERR_INVALID_ARG_VALUE' },
    );
}

// A stream is only usable if it exposes a real fd, matching Node.
export function stdioFdOf(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (value !== null && typeof value === 'object') {
        const fd = Reflect.get(value, 'fd');
        if (typeof fd === 'number' && Number.isInteger(fd)) return fd;
    }
    return undefined;
}

// Node rejects a negative or NaN maxBuffer with ERR_OUT_OF_RANGE before the
// child is ever spawned (validateMaxBuffer in node:child_process). Measured on
// v24.18: -1 and NaN both throw a RangeError; 0 and Infinity are accepted and
// mean "no limit". Silently ignoring a bad value instead lets a caller's typo
// disable the cap and capture unbounded output.
export function validateMaxBuffer(maxBuffer: unknown): void {
    if (maxBuffer === undefined || maxBuffer === null) return;
    if (typeof maxBuffer !== 'number' || Number.isNaN(maxBuffer) || maxBuffer < 0) {
        throw Object.assign(
            new RangeError(`The value of "options.maxBuffer" is out of range. It must be a positive number. Received ${String(maxBuffer)}`),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }
}

// Node validates timeout eagerly for both async and sync entry points. A bad
// value must not silently disable the only deadline guarding a child process.
export function validateTimeout(timeout: unknown): void {
    if (timeout === undefined || timeout === null) return;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 0) {
        const received = typeof timeout === 'string' ? `'${timeout}'` : String(timeout);
        throw Object.assign(
            new RangeError(`The value of "timeout" is out of range. It must be an unsigned integer. Received ${received}`),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }
}

export function validateStdio(stdio: SpawnOptions['stdio']): void {
    if (stdio === undefined) return;
    if (!Array.isArray(stdio)) {
        // A bare 'ipc' string is rejected by Node too — 'ipc' is only meaningful as
        // one slot of an array. Compared through unknown because the declared
        // shorthand union does not include it.
        if (!stdioEntryIsValid(stdio) || (stdio as unknown) === 'ipc') throw invalidStdioError(stdio);
        return;
    }
    for (const entry of stdio) {
        // A stream with a usable fd is legal; anything else unrecognised is not.
        if (stdioEntryIsValid(entry) || stdioFdOf(entry) !== undefined) continue;
        throw invalidStdioError(entry);
    }
}

// The native layer cannot redirect fd 0/1/2 to an arbitrary descriptor: the
// SETUP_STDIO macro (mod_process.c:752) runs JS_ToCString on the value, so a
// number arrives as the string "5", misses the 'pipe'/'ignore' comparisons, and
// lands in the else branch that inherits the SLOT's own default fd. The measured
// result is that `stdio: ['ignore', fd, fd]` for an open log file wrote nothing
// to the file and leaked the child's output to the parent's console instead
// (Node writes it to the file). Extra fds are unaffected — setup_extra_stdio
// handles numbers correctly.
//
// A number equal to its own slot index is the one case that is already correct
// (`stdio: [0, 1, 2]` genuinely means "inherit the parent's 0/1/2"), so allow
// that and refuse the rest loudly rather than sending bytes somewhere the caller
// did not ask for. Reported as a C defect with a proposed diff.
export function assertRedirectableFd(value: unknown, slot: number): void {
    const fd = stdioFdOf(value);
    if (fd === undefined || fd === slot) return;
    throw Object.assign(
        new Error(
            `child_process: redirecting stdio fd ${slot} to descriptor ${fd} is not supported by this runtime `
            + '(the native spawn would silently inherit the parent\'s fd '
            + `${slot} instead of writing to descriptor ${fd}); use 'pipe' and forward the data, `
            + 'or pass the same number as the slot index to inherit',
        ),
        { code: 'ERR_INVALID_ARG_VALUE' },
    );
}

export function validateStdioFdRedirects(stdio: SpawnOptions['stdio']): void {
    if (!Array.isArray(stdio)) return;
    for (let slot = 0; slot < Math.min(3, stdio.length); slot++) {
        assertRedirectableFd(stdio[slot], slot);
    }
}

export function toNativeStdio(value: StdioEntry, fallback: NativeStdio = 'pipe'): NativeStdio {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number') return value;
    if (value === 'pipe' || value === 'ignore' || value === 'inherit') return value;
    // Node treats 'overlapped' as a pipe (Windows OVERLAPPED I/O hint only).
    if (value === 'overlapped') return 'pipe';
    return 'inherit';
}

export function toNativeExtraStdio(value: StdioEntry): CModuleProcess.StdioOption | null {
    if (value === null || value === undefined || value === 'ipc') return null;
    if (typeof value === 'number') return value;
    if (value === 'pipe' || value === 'overlapped' || value === 'inherit') {
        return value === 'overlapped' ? 'pipe' : value;
    }
    return 'ignore';
}

export function ipcFdFromStdio(stdio: StdioEntry[] | undefined): number {
    if (!stdio) return 3;
    const index = stdio.indexOf('ipc');
    return index >= 0 ? index : 3;
}
