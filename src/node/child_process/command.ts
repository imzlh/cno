/**
 * Node.js child_process module - environment normalisation, command resolution
 * and spawn-failure construction.
 *
 * Internal to the module.
 */

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const nativeError = import.meta.use('error');

import { asError } from './_shared';
import type { SpawnInput, SpawnOptions } from './types';
import path from '../path';

const { basename, isAbsolute, join, resolve } = path;

function isDrivePath(value: string): boolean {
    return /^[A-Za-z]:/.test(value);
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

export function isWindowsHost(): boolean {
    return os.platform === 'windows' || os.platform === 'win32';
}

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
    return isWindowsHost() ? dedupeWindowsEnvKeys(out) : out;
}

// Only for the sync path, which bypasses uv_spawn's required-vars merge.
export function withRequiredEnvVars(env: Record<string, string>): Record<string, string> {
    if (!isWindowsHost()) return env;
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

export function isPathLikeCommand(command: string): boolean {
    return command.includes('/') || command.includes('\\')
        || isDrivePath(command);
}

export function makeSpawnError(command: string, syscall: string, args?: string[]): NodeJS.ErrnoException {
    // UV errno values are platform-local — never hardcode (Windows differs).
    // Node's syscall carries the command: `spawn <cmd>` / `spawnSync <cmd>`.
    // Key order and the spawnargs entry are Node's (measured on v24.18): errno,
    // code, syscall, path, spawnargs.
    const err = Object.assign(new Error(`${syscall} ${command} ENOENT`), {
        errno: nativeError.errno.ENOENT,
        code: 'ENOENT',
        syscall: `${syscall} ${command}`,
        path: command,
    });
    if (args) Reflect.set(err, 'spawnargs', [...args]);
    return err;
}

// Windows CreateProcess appends the PATHEXT extensions to an extensionless path,
// so `D:/build/cno` legitimately resolves to `cno.exe`. The pre-flight existence
// check must honour that or it rejects paths the native spawn would have run —
// a Windows-only trap for the POSIX-idiomatic extensionless binary path.
export function windowsPathExts(): string[] {
    let raw: string | undefined;
    try { raw = os.getenv('PATHEXT'); } catch { /* unset */ }
    const list = (raw ?? '.COM;.EXE;.BAT;.CMD').split(';')
        .map((ext) => ext.trim())
        .filter((ext) => ext.length > 1 && ext.startsWith('.'));
    return list.length > 0 ? list : ['.COM', '.EXE', '.BAT', '.CMD'];
}

// A directory is not a runnable command: Node reports ENOENT for `spawn('./adir')`
// (measured on v24.18/Windows), so the pre-flight must not count one as resolved.
export function isRunnableFile(path: string): boolean {
    try {
        if (!fs.exists(path)) return false;
    } catch { return false; }
    try {
        return !fs.stat(path).isDirectory;
    } catch {
        // stat can fail where exists() succeeded (permissions, locked file). The
        // command may well run, so keep the pre-flight permissive.
        return true;
    }
}

export function isAbsoluteCommandPath(command: string): boolean {
    return isAbsolute(command);
}

// Relative commands resolve against the CHILD's cwd, not ours. Measured on Node
// v24.18: `spawnSync('./where.exe', { cwd: dir })` runs when dir holds the file
// even though the parent cwd does not — so a pre-flight that ignores options.cwd
// invents an ENOENT for a command that would have run.
export function resolveAgainstCwd(command: string, cwd?: string): string {
    if (!cwd || isAbsoluteCommandPath(command)) return command;
    return resolve(cwd, command);
}

// The native layer resolves a relative command against the PARENT's cwd, not the
// requested one: mod_process.c calls CreateProcessW(NULL, wcmd, …) so Windows
// parses the program out of the command line and resolves it against the parent's
// current directory, while lpCurrentDirectory only sets where the *child* starts
// (the PTY path has the same bug via SearchPathW at mod_process.c:1197). libuv,
// which Node uses, resolves against the child's cwd instead — measured divergence:
// `spawnSync('./where.exe', ['/?'], { cwd: dir })` is status 0 on Node and
// "CreateProcess failed: 2" on the raw native call.
//
// Fixing that is a C change needing a rebuild, so pre-resolve here instead: an
// absolute path makes the native call cwd-independent, and it was verified to run
// correctly with cwd set. Bare names are left alone — they must keep going through
// the native PATH lookup.
export function resolveCommandForCwd(command: string, cwd?: string): string {
    if (!cwd || !isPathLikeCommand(command) || isAbsoluteCommandPath(command)) return command;
    return resolveCommandFile(command, cwd) ?? command;
}

// Returns the path the pre-flight actually found, or null. Callers that only
// need existence use commandFileExists.
//
// The PATHEXT probe deliberately skips .bat/.cmd: CreateProcess cannot launch a
// batch file, so an extensionless spec that only matches `build.bat` is ENOENT
// to Node (measured), and treating it as resolved would both diverge from Node
// and let a batch file reach the native spawn. Direct .bat/.cmd specs are caught
// earlier by isBatchFileCommand.
export function resolveCommandFile(command: string, cwd?: string): string | null {
    const target = resolveAgainstCwd(command, cwd);
    if (isRunnableFile(target)) return target;
    if (!isWindowsHost()) return null;
    // Only an extensionless final segment gets the PATHEXT treatment.
    const base = basename(target);
    if (base.includes('.')) return null;
    for (const ext of windowsPathExts()) {
        if (/^\.(?:bat|cmd)$/i.test(ext)) continue;
        if (isRunnableFile(target + ext)) return target + ext;
        if (isRunnableFile(target + ext.toLowerCase())) return target + ext.toLowerCase();
    }
    return null;
}

export function commandFileExists(command: string, cwd?: string): boolean {
    return resolveCommandFile(command, cwd) !== null;
}

// CVE-2024-27980. cmd.exe re-parses a batch file's argument string, so a `&` in
// any argument runs as a separate command: spawning `hello.bat` with
// `a" & echo INJECTED & rem "b` executed `echo INJECTED` (measured — the output
// landed outside the script's own `args=[%*]` brackets, and the native spawnSync
// still reproduces it when called directly, so this guard is load-bearing).
// libuv's quote_cmd_arg() cannot prevent it, because cmd.exe undoes that quoting.
//
// Node refuses the spawn instead (EINVAL) unless `shell` is set, and so do we.
// The guard lives here rather than in the native layer because buildShellInvocation
// rewrites command/args to `cmd.exe /d /s /c …` for `shell: true`, so by the time
// tjs_spawn runs, options.file is cmd.exe and the "user asked for a shell" vs
// "user spawned a .bat directly" distinction — the whole basis of the fix — is
// gone. Node makes the same choice (normalizeSpawnArguments, not C++).
//
// Measured on Node v24.18/Windows: the test is the RAW spec's suffix and it runs
// BEFORE any existence check — a nonexistent `D:/nope/missing.bat` is EINVAL, not
// ENOENT, and windowsVerbatimArguments does not exempt it. Extensionless specs
// that would only match a `.bat` are ENOENT instead; resolveCommandFile keeps
// them unresolved so they can never reach the native spawn either.
//
// exec/execSync are exempt because they pass `shell: options?.shell ?? true`,
// which is exactly how Node exempts them too.
export function isBatchFileCommand(command: string): boolean {
    if (!isWindowsHost()) return false;
    return /\.(?:bat|cmd)$/i.test(command);
}

// Node's shape, measured on v24.18/Windows. The sync form carries the command in
// the message/syscall plus path/spawnargs; the async form throws a bare
// `spawn EINVAL` with only errno/code/syscall.
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

// Native spawnSync throws a bare InternalError ("CreateProcess failed: 2") with
// no code/errno, so this pre-flight is what turns a missing command into a
// proper ENOENT. Never parse that message — probe the filesystem instead.
export function getImmediateSpawnError(command: string, syscall: string, cwd?: string, args?: string[]): NodeJS.ErrnoException | null {
    if (!isPathLikeCommand(command)) return null;
    if (commandFileExists(command, cwd)) return null;
    return makeSpawnError(command, syscall, args);
}

// Bare names are deliberately not pre-flighted (CreateProcess owns PATH lookup,
// and a JS search that disagrees would reject a command that actually runs). But
// native spawnSync reports an unresolvable command as a codeless InternalError,
// so on the *failure* path we resolve PATH ourselves to decide between ENOENT and
// a genuine unknown error. Runs only after a failure, so success pays nothing.
export function resolvesOnPath(command: string): boolean {
    let raw: string | undefined;
    try { raw = os.getenv('PATH'); } catch { /* unset */ }
    if (!raw) return false;
    const isWindows = isWindowsHost();
    const sep = isWindows ? ';' : ':';
    for (const entry of raw.split(sep)) {
        const dir = entry.trim().replace(/^"|"$/g, '');
        if (!dir) continue;
        const joined = join(dir, command);
        if (commandFileExists(joined)) return true;
    }
    return false;
}

/**
 * A `cwd` that is not an existing directory is its own ENOENT, independent of
 * whether the command resolves. Node reports code ENOENT / errno -4058 for
 * `spawnSync('node', [...], { cwd: '<missing>' })`; the native sync spawn raises
 * a codeless InternalError ("CreateProcess failed: 267" = ERROR_DIRECTORY), and
 * because `node` itself resolves on PATH the command-resolution check below
 * cannot classify it. Returns true only when cwd was given and is missing or is
 * not a directory, so a stat failure on an existing path stays permissive.
 */
export function cwdIsMissing(cwd?: string): boolean {
    if (typeof cwd !== 'string' || cwd.length === 0) return false;
    try {
        if (!fs.exists(cwd)) return true;
    } catch {
        return false;
    }
    try {
        return !fs.stat(cwd).isDirectory;
    } catch {
        return false;
    }
}

// A native error that carries no usable errno tells us nothing; map it to Node's
// ENOENT when the command genuinely cannot be resolved, else leave it alone.
export function normalizeSpawnFailure(err: unknown, command: string, syscall: string, cwd?: string, args?: string[]): Error {
    const code = err instanceof Error ? Reflect.get(err, 'code') : undefined;
    if (typeof code !== 'number' && typeof code !== 'string') {
        if (cwdIsMissing(cwd)) return makeSpawnError(command, syscall, args);
        const resolvable = isPathLikeCommand(command)
            ? commandFileExists(command, cwd)
            : resolvesOnPath(command);
        if (!resolvable) return makeSpawnError(command, syscall, args);
    }
    // Fall-through: the native error already carries a usable code, so it is
    // reported as-is. Node still attaches `spawnargs` here (measured v24.18: a
    // bare-name ENOENT from async spawn has [code,errno,path,spawnargs,syscall]),
    // and execa/cross-spawn read it when formatting a failure. Without this the
    // key was present only on the pre-flighted path-like route.
    const normalized = asError(err, `${syscall} ${command}`, command);
    if (args && !Reflect.has(normalized, 'spawnargs')) {
        Reflect.set(normalized, 'spawnargs', [...args]);
    }
    return normalized;
}
