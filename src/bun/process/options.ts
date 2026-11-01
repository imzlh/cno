import { normalizeErrnoError } from '../../node/_internal/errno';
import { isAbsolutePath, join, resolvePath } from '../../utils/path';
import { copyInputBytes, isBufferInput } from './streams';
import type {
    BunSignal,
    ParsedSpawnOptions,
    ParsedSpawnSyncOptions,
    ReadableMode,
    StaticInput,
    WritableMode,
} from './types';

const fs = import.meta.use('fs');
const os = import.meta.use('os');
const nativeError = import.meta.use('error');
const signalsBinding = import.meta.use('signals');
const blobBytesSymbol = Symbol.for('cno.blob.bytes');

type OptionsRecord = Record<PropertyKey, unknown>;
type SpawnKind = 'spawn' | 'spawnSync';

function codedTypeError(message: string): TypeError {
    const error = new TypeError(message);
    Object.defineProperty(error, 'code', { value: 'ERR_INVALID_ARG_TYPE', configurable: true });
    return error;
}

function invalidValue(message: string): TypeError {
    const error = new TypeError(message);
    Object.defineProperty(error, 'code', { value: 'ERR_INVALID_ARG_VALUE', configurable: true });
    return error;
}

/** Native argv/env/cwd are C strings; a NUL would silently truncate them. */
function assertNoNul(value: string, name: string): string {
    if (value.includes('\0')) throw invalidValue(`The argument '${name}' must not contain null bytes`);
    return value;
}

function optionsObject(value: unknown): OptionsRecord {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
        ? value as OptionsRecord
        : Object.create(null) as OptionsRecord;
}

function commandAndOptions(input: unknown, second: unknown): { command: string[]; options: OptionsRecord } {
    let rawCommand: unknown;
    let options: OptionsRecord;
    if (Array.isArray(input)) {
        rawCommand = input;
        options = optionsObject(second);
    } else {
        options = optionsObject(input);
        rawCommand = options.cmd;
    }
    if (!Array.isArray(rawCommand)) throw codedTypeError('cmd must be an array');
    if (rawCommand.length === 0) throw codedTypeError('cmd must not be empty');
    return {
        command: rawCommand.map((part) => assertNoNul(String(part), 'cmd')),
        options,
    };
}

function normalizeEnvironment(value: unknown): Record<string, string> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' && typeof value !== 'function') {
        throw codedTypeError('env must be an object');
    }
    const env: Record<string, string> = {};
    for (const [name, item] of Object.entries(value)) {
        if (item !== undefined) env[assertNoNul(name, 'env')] = assertNoNul(String(item), 'env');
    }
    return env;
}

function normalizeCwd(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const cwd = assertNoNul(String(value), 'cwd');
    try {
        const stat = fs.stat(cwd);
        if (!stat.isDirectory) throw new nativeError.Error(nativeError.errno.ENOTDIR);
    } catch (error) {
        throw normalizeErrnoError(error, 'chdir', cwd);
    }
    return cwd;
}

function isStaticInput(value: unknown): value is StaticInput {
    return (isBufferInput(value) && typeof value !== 'string')
        || (typeof Blob !== 'undefined' && value instanceof Blob)
        || (typeof Request !== 'undefined' && value instanceof Request)
        || (typeof Response !== 'undefined' && value instanceof Response)
        || (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream);
}

function readableMode(value: unknown, fallback: ReadableMode, slot: 1 | 2): ReadableMode {
    if (value === undefined) return fallback;
    if (value === null) return 'ignore';
    if (value === 'pipe' || value === 'inherit' || value === 'ignore') return value;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        const fd = Math.trunc(value);
        if (fd === 0) throw codedTypeError('stdin cannot be used for stdout or stderr');
        return fd;
    }
    throw codedTypeError("stdio must be 'inherit', 'pipe', 'ignore', a matching file descriptor, or null");
}

function writableMode(value: unknown, fallback: WritableMode): WritableMode {
    if (value === undefined) return fallback;
    if (value === null) return 'ignore';
    if (value === 'pipe' || value === 'inherit' || value === 'ignore') return value;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        const fd = Math.trunc(value);
        if (fd === 1 || fd === 2) throw codedTypeError('stdout and stderr cannot be used for stdin');
        return fd;
    }
    if (isStaticInput(value)) return value;
    throw codedTypeError("stdio must be 'inherit', 'pipe', 'ignore', binary input, a matching file descriptor, or null");
}

function stdioModes(
    options: OptionsRecord,
    kind: SpawnKind,
): { stdin: WritableMode; stdout: ReadableMode; stderr: ReadableMode } {
    const defaults = kind === 'spawn'
        ? { stdin: 'ignore' as const, stdout: 'pipe' as const, stderr: 'inherit' as const }
        : { stdin: 'ignore' as const, stdout: 'pipe' as const, stderr: 'pipe' as const };
    const stdio = options.stdio;
    if (stdio !== undefined && stdio !== null && !Array.isArray(stdio)) {
        throw codedTypeError('stdio must be an array');
    }
    const stdin = Array.isArray(stdio) && stdio.length > 0 ? stdio[0] : options.stdin;
    const stdout = Array.isArray(stdio) && stdio.length > 1 ? stdio[1] : options.stdout;
    const stderr = Array.isArray(stdio) && stdio.length > 2 ? stdio[2] : options.stderr;
    return {
        stdin: writableMode(stdin, defaults.stdin),
        stdout: readableMode(stdout, defaults.stdout, 1),
        stderr: readableMode(stderr, defaults.stderr, 2),
    };
}

function optionalInteger(value: unknown, name: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number') throw codedTypeError(`The "${name}" property must be of type number`);
    if (!Number.isInteger(value)) throw codedTypeError(`The "${name}" property must be of type integer`);
    return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    return Boolean(value);
}

function rejectUnsupported(options: OptionsRecord, kind: SpawnKind): void {
    const unsupported = kind === 'spawn'
        ? ['cgroup', 'ipc', 'terminal']
        // argv0 is only honored by the native async spawn.
        : ['cgroup', 'ipc', 'terminal', 'signal', 'timeout', 'maxBuffer', 'argv0'];
    for (const name of unsupported) {
        if (options[name] !== undefined) {
            throw new Error(`Bun.${kind}: option "${name}" is unsupported by this runtime`);
        }
    }
}

function optionalTimeout(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number') throw codedTypeError('The "timeout" property must be of type number');
    if (!Number.isInteger(value)) throw codedTypeError('The "timeout" property must be of type integer');
    if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
        const error = new RangeError('The value of "timeout" is out of range');
        Object.defineProperty(error, 'code', { value: 'ERR_OUT_OF_RANGE', configurable: true });
        throw error;
    }
    return value;
}

function optionalSignal(value: unknown): BunSignal | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string') {
        // Reject here: a bad name would otherwise throw from a timer/abort callback.
        if (signalsBinding && !Object.hasOwn(signalsBinding.signals, value)) {
            const error = new TypeError(`Unknown signal: ${value}`);
            Object.defineProperty(error, 'code', { value: 'ERR_UNKNOWN_SIGNAL', configurable: true });
            throw error;
        }
        return value as BunSignal;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        return value as BunSignal;
    }
    throw codedTypeError('killSignal must be a signal name or integer');
}

function optionalMaxBuffer(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
        throw codedTypeError('The "maxBuffer" property must be a non-negative number');
    }
    return value;
}

export function parseSpawn(input: unknown, second?: unknown): ParsedSpawnOptions {
    const { command, options } = commandAndOptions(input, second);
    rejectUnsupported(options, 'spawn');
    const modes = stdioModes(options, 'spawn');
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw codedTypeError('signal must be an AbortSignal');
    }
    if (signal?.aborted) {
        const error = new DOMException('The operation was aborted', 'AbortError');
        Object.defineProperty(error, 'cause', { value: signal.reason, configurable: true });
        throw error;
    }
    if (options.onExit !== undefined && options.onExit !== null && typeof options.onExit !== 'function') {
        throw codedTypeError('onExit must be a function');
    }
    return {
        command,
        cwd: normalizeCwd(options.cwd),
        env: normalizeEnvironment(options.env),
        ...modes,
        detached: optionalBoolean(options.detached),
        uid: optionalInteger(options.uid, 'uid'),
        gid: optionalInteger(options.gid, 'gid'),
        argv0: options.argv0 === undefined ? undefined : assertNoNul(String(options.argv0), 'argv0'),
        windowsHide: optionalBoolean(options.windowsHide),
        windowsVerbatimArguments: optionalBoolean(options.windowsVerbatimArguments),
        onExit: typeof options.onExit === 'function' ? options.onExit as ParsedSpawnOptions['onExit'] : undefined,
        signal: signal as AbortSignal | undefined,
        timeout: optionalTimeout(options.timeout),
        killSignal: optionalSignal(options.killSignal),
        maxBuffer: optionalMaxBuffer(options.maxBuffer),
    };
}

export function parseSpawnSync(input: unknown, second?: unknown): ParsedSpawnSyncOptions {
    const { command, options } = commandAndOptions(input, second);
    rejectUnsupported(options, 'spawnSync');
    return {
        command,
        cwd: normalizeCwd(options.cwd),
        env: normalizeEnvironment(options.env),
        ...stdioModes(options, 'spawnSync'),
        detached: optionalBoolean(options.detached),
        uid: optionalInteger(options.uid, 'uid'),
        gid: optionalInteger(options.gid, 'gid'),
        windowsHide: optionalBoolean(options.windowsHide),
        windowsVerbatimArguments: optionalBoolean(options.windowsVerbatimArguments),
    };
}

function executable(path: string): boolean {
    try {
        const stat = fs.stat(path);
        if (!stat.isFile) return false;
        return os.platform === 'windows' || os.platform === 'win32' || (stat.mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

function windowsCandidates(path: string, env: Record<string, string> | undefined): string[] {
    if (os.platform !== 'windows' && os.platform !== 'win32') return [path];
    if (/\.[^\\/]+$/.test(path)) return [path];
    const pathExt = env?.PATHEXT ?? os.environ().PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
    return [path, ...pathExt.split(';').filter(Boolean).map(ext => path + ext.toLowerCase()),
        ...pathExt.split(';').filter(Boolean).map(ext => path + ext.toUpperCase())];
}

/** Native spawnSync reports an exec failure as status 127 on POSIX, so preflight it. */
export function assertSyncExecutable(command: string, cwd: string | undefined, env: Record<string, string> | undefined): void {
    const hasSeparator = command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command);
    const candidates: string[] = [];
    if (hasSeparator) {
        const path = isAbsolutePath(command) ? command : resolvePath(command, cwd ?? os.cwd);
        candidates.push(...windowsCandidates(path, env));
    } else {
        const inherited = os.environ();
        const pathValue = env
            ? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
            : inherited.PATH;
        const separator = os.platform === 'windows' || os.platform === 'win32' ? ';' : ':';
        const fallback = os.platform === 'windows' || os.platform === 'win32' ? '' : '/usr/local/bin:/usr/bin:/bin';
        for (const directory of (pathValue ?? fallback).split(separator)) {
            if (!directory) continue;
            candidates.push(...windowsCandidates(join(directory, command), env));
        }
    }
    if (candidates.some(executable)) return;
    const error = new nativeError.Error(nativeError.errno.ENOENT);
    throw normalizeErrnoError(error, 'posix_spawn', command);
}

export function syncInput(value: WritableMode): string | Uint8Array<ArrayBuffer> | undefined {
    if (value === 'pipe' || value === 'ignore' || value === 'inherit' || typeof value === 'number') return undefined;
    if (isBufferInput(value)) return copyInputBytes(value);
    if (value instanceof Blob) {
        const getBytes = Reflect.get(value, blobBytesSymbol);
        if (typeof getBytes === 'function') {
            const bytes = Reflect.apply(getBytes, value, []);
            if (bytes instanceof Uint8Array) return copyInputBytes(bytes);
        }
    }
    throw new Error('Bun.spawnSync cannot synchronously consume this stdin source in this runtime');
}

export function nativeMode(value: WritableMode | ReadableMode, staticPipe = false): CModuleProcess.StdioOption {
    if (staticPipe) return 'pipe';
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && (value === 'pipe' || value === 'inherit' || value === 'ignore')) return value;
    return 'pipe';
}
