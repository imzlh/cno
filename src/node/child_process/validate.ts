import type { NativeStdio, SpawnOptions, StdioEntry } from './types';

// Reject unknown entries rather than silently inheriting stdio.
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

export function stdioFdOf(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (value !== null && typeof value === 'object') {
        const fd = Reflect.get(value, 'fd');
        if (typeof fd === 'number' && Number.isInteger(fd)) return fd;
    }
    return undefined;
}

// Reject invalid caps before spawning; zero and Infinity are unlimited.
export function validateMaxBuffer(maxBuffer: unknown): void {
    if (maxBuffer === undefined || maxBuffer === null) return;
    if (typeof maxBuffer !== 'number' || Number.isNaN(maxBuffer) || maxBuffer < 0) {
        throw Object.assign(
            new RangeError(`The value of "options.maxBuffer" is out of range. It must be a positive number. Received ${String(maxBuffer)}`),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }
}

// Validate before spawning so an invalid timeout cannot disable the deadline.
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
        // 'ipc' is valid only as an array slot.
        if (!stdioEntryIsValid(stdio) || (stdio as unknown) === 'ipc') throw invalidStdioError(stdio);
        return;
    }
    let ipcCount = 0;
    for (const entry of stdio) {
        if (!stdioEntryIsValid(entry) && stdioFdOf(entry) === undefined) {
            throw invalidStdioError(entry);
        }
        if (entry === 'ipc' && ++ipcCount > 1) {
            throw Object.assign(new Error('Child process can have only one IPC pipe'), {
                code: 'ERR_IPC_ONE_PIPE',
            });
        }
    }
}

// Native spawn cannot redirect fd 0/1/2 to arbitrary descriptors. Reject them
// rather than silently inheriting the parent's standard stream; extra fds work.
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
    // Treat Node's Windows-only 'overlapped' mode as a pipe.
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
