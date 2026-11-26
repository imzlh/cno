/**
 * Node.js child_process module - environment normalisation, command resolution
 * and spawn-failure construction.
 *
 * Internal to the module.
 */

import type { SpawnInput, SpawnOptions } from './types';
import { errnoName, errorCode, isErrorValue, matchesErrnoCode } from '../../utils/errno';
import { normalizeErrnoError } from '../_internal/errno';
import path from '../path';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const nativeError = import.meta.use('error');

const { basename, isAbsolute, resolve } = path;
const isWindows = os.platform === 'windows' || os.platform === 'win32';

export function normalizeSpawnArgs(
    argsOrOptions?: string[] | SpawnOptions,
    options?: SpawnOptions,
): [args: string[], options: SpawnOptions] {
    return Array.isArray(argsOrOptions)
        ? [argsOrOptions, options ?? {}]
        : [[], argsOrOptions || {}];
}

// libuv always merges these from the parent when an explicit env is given, so a
// Windows child never loses PATH/SYSTEMROOT no matter what the caller passes
// (deps/libuv/src/win/process.c required_vars). The async spawn goes through
// uv_spawn and gets that for free; spawnSync does not, so `spawnSync(cmd, {env:
// {}})` handed the child an env with no PATH at all and a bare command name
// stopped resolving (measured: `where.exe cmd.exe` is status 0 on Node and
// status 1 here). Keep this list sorted the same way libuv keeps it.
export const WINDOWS_REQUIRED_ENV_VARS = [
    'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT',
    'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
];

// Windows env keys are case-insensitive, so a block containing both PATH and Path
// is malformed. Node sorts the keys and keeps the first of each case-insensitive
// group (measured on v24.18: {CNOCASE:'upper', cnocase:'lower', CnoCase:'mixed'}
// reaches the child as CNOCASE=upper regardless of insertion order, and
// {PATH:a, Path:b} arrives as PATH=a). Without this the child saw all three keys
// and the winner depended on insertion order — and differed between cno's sync
// and async paths, which disagreed with each other as well as with Node.
export function dedupeWindowsEnvKeys(env: Record<string, string>): Record<string, string> {
    const seen = new Set<string>();
    const out: Record<string, string> = {};
    for (const key of Object.keys(env).sort()) {
        const upper = key.toUpperCase();
        if (seen.has(upper)) continue;
        seen.add(upper);
        out[key] = env[key];
    }
    return out;
}

export function normalizeEnv(env?: SpawnOptions['env']): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        // Node skips only undefined; a null value is stringified to "null"
        // (measured on v24.18: env {A: null} reaches the child as A="null",
        // where dropping the key made it absent instead).
        if (value !== undefined) out[key] = String(value);
    }
    return isWindows ? dedupeWindowsEnvKeys(out) : out;
}

// Only for the sync path, which bypasses uv_spawn's required-vars merge.
export function withRequiredEnvVars(env: Record<string, string>): Record<string, string> {
    if (!isWindows) return env;
    const present = new Set(Object.keys(env).map((k) => k.toUpperCase()));
    const out = { ...env };
    let parent: Record<string, string> | undefined;
    for (const name of WINDOWS_REQUIRED_ENV_VARS) {
        if (present.has(name)) continue;
        if (parent === undefined) {
            try { parent = os.environ(); } catch { parent = {}; }
        }
        for (const [key, value] of Object.entries(parent)) {
            if (key.toUpperCase() === name) {
                out[key] = value;
                break;
            }
        }
    }
    return out;
}

export function normalizeInput(input: unknown): SpawnInput | undefined {
    if (input === undefined) return undefined;
    if (typeof input === 'string' || input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    const ctor = input !== null && typeof input === 'object' && input.constructor
        ? input.constructor.name
        : typeof input;
    const received = ctor === 'Object' ? 'an instance of Object' : `type ${ctor}`;
    throw new TypeError(`The "input" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${received}`);
}

function isWindowsExecutableFile(path: string): boolean {
    try {
        return !fs.stat(path).isDirectory;
    } catch (error) {
        return !matchesErrnoCode(error, 'ENOENT', 'ENOTDIR');
    }
}

export function resolveWindowsSyncCommand(command: string, cwd?: string): string {
    if (!isWindows || (!command.includes('/') && !command.includes('\\') && !/^[A-Za-z]:/.test(command))) {
        return command;
    }

    const target = cwd && !isAbsolute(command) ? resolve(cwd, command) : command;
    if (isWindowsExecutableFile(target)) return target;
    if (!basename(target).includes('.')) {
        for (const extension of ['.com', '.exe']) {
            if (isWindowsExecutableFile(target + extension)) return target + extension;
        }
    }
    throw nativeError.Error(nativeError.errno.ENOENT);
}

// CVE-2024-27980. cmd.exe re-parses batch args, so a `&` runs as a separate
// command; Node throws EINVAL for a .bat/.cmd spec unless `shell` is set.
export function isBatchFileCommand(command: string): boolean {
    return isWindows && /\.(?:bat|cmd)$/i.test(command);
}

export function makeBatchFileError(command: string, args: string[], syscall: string | null): NodeJS.ErrnoException {
    if (syscall === null) {
        return Object.assign(new Error('spawn EINVAL'), {
            errno: nativeError.errno.EINVAL,
            code: 'EINVAL',
            syscall: 'spawn',
        });
    }
    return Object.assign(new Error(`${syscall} ${command} EINVAL`), {
        errno: nativeError.errno.EINVAL,
        code: 'EINVAL',
        syscall: `${syscall} ${command}`,
        path: command,
        spawnargs: [...args],
    });
}

export function normalizeSpawnFailure(err: unknown, command: string | undefined, syscall: string, args?: string[]): NodeJS.ErrnoException {
    const code = errorCode(err);
    if (!isErrorValue(err) || typeof code !== 'number' || !(code < 0)) {
        return normalizeErrnoError(err);
    }

    const name = errnoName(code) ?? 'UNKNOWN';
    const operation = command === undefined ? syscall : `${syscall} ${command}`;
    const normalized = Object.assign(new Error(`${operation} ${name}`), {
        errno: code,
        code: name,
        syscall: operation,
    });
    if (command !== undefined) {
        Object.assign(normalized, { path: command, spawnargs: [...(args ?? [])] });
    }
    return normalized;
}
