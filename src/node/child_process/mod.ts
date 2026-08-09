/**
 * Node.js child_process module
 * Based on CModuleProcess implementation
 */

const proc = import.meta.use('process');
const os = import.meta.use('os');
const signals = import.meta.use('signals');
const engine = import.meta.use('engine');
const text = import.meta.use('text');
const fs = import.meta.use('fs');
const nativeError = import.meta.use('error');

import { IPCChannel, type IPCSerialization } from '../ipc_channel';
import { EventEmitter } from '../events';
import { Writable, Readable, Duplex } from '../stream';
import { getTierLimits } from '../_internal/memory';
import { viewToUint8Array } from '../_internal/buffer';
import { normalizeErrnoError } from '../_internal/errno';
import { Buffer } from '../buffer';

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

function asError(error: unknown, syscall?: string, path?: string): Error {
    return normalizeErrnoError(error, syscall, path);
}

function startPipeReadQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.startRead();
    } catch {
        // The pipe can already be closing while Readable asks for more data.
    }
}

function stopPipeReadQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.stopRead();
    } catch {
        // Best-effort back-pressure/EOF cleanup.
    }
}

// True while a piped stdio Readable still owes an 'end'/'close'/'error'.
function streamEndPending(stream: Readable | null): stream is Readable {
    return !!stream && !stream.readableEnded && !stream.destroyed;
}

// Resolve once a piped stdio Readable has ended, closed, or errored.
function waitStreamEnd(stream: Readable | null): Promise<void> {
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
function destroyChildStdin(stream: Writable | null): void {
    if (!stream || stream.destroyed) return;
    try {
        stream.destroy();
    } catch {
        // Best-effort: the pipe can already be tearing down underneath us.
    }
}

// Type definitions
type StdioEntry = 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'ipc' | number | null | undefined;
type NativeStdio = CModuleProcess.SpawnOptions<false>['stdin'];
type ChildStdioStream = Writable | Readable | Duplex | null;
type SpawnInput = string | ArrayBuffer | ArrayBufferView;

function stdioChunkBytes(chunk: unknown): Uint8Array {
    if (typeof chunk === 'string') return engine.encodeString(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    if (ArrayBuffer.isView(chunk)) return viewToUint8Array(chunk);
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    throw new TypeError('Child process stdio chunk must be a string or binary buffer');
}

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
    kill(signal?: string | number): boolean;
}

// ChildProcess class

// Node uppercases the signal name before looking it up, so kill('sigterm') works
// (measured on v24.18), and reports an unknown name as ERR_UNKNOWN_SIGNAL.
function transformSignal(signal?: string | number): number | undefined {
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
function decodeOutput(bytes: Uint8Array, encoding: BufferEncoding): string {
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
function stdioEntryIsValid(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'number') return Number.isInteger(value);
    if (typeof value === 'string') {
        return value === 'pipe' || value === 'overlapped' || value === 'ignore'
            || value === 'inherit' || value === 'ipc';
    }
    return false;
}

function describeStdioValue(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return `'${value}'`;
    if (typeof value === 'object') {
        const keys = Object.keys(value as object);
        return keys.length === 0 ? '{}' : `{ ${keys.join(', ')} }`;
    }
    return String(value);
}

function invalidStdioError(value: unknown): TypeError {
    return Object.assign(
        new TypeError(`The argument 'stdio' is invalid. Received ${describeStdioValue(value)}`),
        { code: 'ERR_INVALID_ARG_VALUE' },
    );
}

// A stream is only usable if it exposes a real fd, matching Node.
function stdioFdOf(value: unknown): number | undefined {
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
function validateMaxBuffer(maxBuffer: unknown): void {
    if (maxBuffer === undefined || maxBuffer === null) return;
    if (typeof maxBuffer !== 'number' || Number.isNaN(maxBuffer) || maxBuffer < 0) {
        throw Object.assign(
            new RangeError(`The value of "options.maxBuffer" is out of range. It must be a positive number. Received ${String(maxBuffer)}`),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }
}

function validateStdio(stdio: SpawnOptions['stdio']): void {
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
function assertRedirectableFd(value: unknown, slot: number): void {
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

function validateStdioFdRedirects(stdio: SpawnOptions['stdio']): void {
    if (!Array.isArray(stdio)) return;
    for (let slot = 0; slot < Math.min(3, stdio.length); slot++) {
        assertRedirectableFd(stdio[slot], slot);
    }
}

function toNativeStdio(value: StdioEntry, fallback: NativeStdio = 'pipe'): NativeStdio {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number') return value;
    if (value === 'pipe' || value === 'ignore' || value === 'inherit') return value;
    // Node treats 'overlapped' as a pipe (Windows OVERLAPPED I/O hint only).
    if (value === 'overlapped') return 'pipe';
    return 'inherit';
}

function toNativeExtraStdio(value: StdioEntry): CModuleProcess.StdioOption | null {
    if (value === null || value === undefined || value === 'ipc') return null;
    if (typeof value === 'number') return value;
    if (value === 'pipe' || value === 'overlapped' || value === 'inherit') {
        return value === 'overlapped' ? 'pipe' : value;
    }
    return 'ignore';
}

function ipcFdFromStdio(stdio: StdioEntry[] | undefined): number {
    if (!stdio) return 3;
    const index = stdio.indexOf('ipc');
    return index >= 0 ? index : 3;
}

// libuv always merges these from the parent when an explicit env is given, so a
// Windows child never loses PATH/SYSTEMROOT no matter what the caller passes
// (deps/libuv/src/win/process.c required_vars). The async spawn goes through
// uv_spawn and gets that for free; spawnSync does not, so `spawnSync(cmd, {env:
// {}})` handed the child an env with no PATH at all and a bare command name
// stopped resolving (measured: `where.exe cmd.exe` is status 0 on Node and
// status 1 here). Keep this list sorted the same way libuv keeps it.
const WINDOWS_REQUIRED_ENV_VARS = [
    'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT',
    'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
];

function isWindowsHost(): boolean {
    return os.uname().sysname === 'Windows_NT';
}

// Windows env keys are case-insensitive, so a block containing both PATH and Path
// is malformed. Node sorts the keys and keeps the first of each case-insensitive
// group (measured on v24.18: {CNOCASE:'upper', cnocase:'lower', CnoCase:'mixed'}
// reaches the child as CNOCASE=upper regardless of insertion order, and
// {PATH:a, Path:b} arrives as PATH=a). Without this the child saw all three keys
// and the winner depended on insertion order — and differed between cno's sync
// and async paths, which disagreed with each other as well as with Node.
function dedupeWindowsEnvKeys(env: Record<string, string>): Record<string, string> {
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

function normalizeEnv(env?: SpawnOptions['env']): Record<string, string> | undefined {
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
function withRequiredEnvVars(env: Record<string, string>): Record<string, string> {
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

// A redirection target that comes from a %VAR% cannot work on the sync path: cmd
// resolves the target while parsing the expanded `call %VAR%` line, before the
// second pass that would expand the target itself, so `echo x > "%OUT%"` created
// a file literally named `%OUT%` in the cwd and still reported status 0.
// Returning an error is a deliberate divergence from Node — it is the one
// construct the sync path cannot honour, and silently writing to the wrong path
// in execSync is worse than a catchable failure. The async path handles this
// correctly and is the documented workaround.
function findShellRedirectVarTarget(command: string): string | undefined {
    // `>` or `>>`, optional space, then a target token that contains a %...% pair.
    const match = /(?:^|[^>])>>?\s*("[^"]*%[^%"]+%[^"]*"|[^\s"|&]*%[^%\s"|&]+%[^\s"|&]*)/.exec(command);
    return match ? match[1] : undefined;
}

function makeSyncShellRedirectError(target: string, command: string): NodeJS.ErrnoException {
    const err = new Error(
        `spawnSync: a redirection target that expands an environment variable (${target}) `
        + 'is not supported with shell:true on Windows, because the sync spawn cannot pass '
        + 'the command line through verbatim. Expand the path in JavaScript and pass a '
        + 'literal target, or use the async exec/spawn, which handles this correctly.',
    ) as NodeJS.ErrnoException;
    Reflect.set(err, 'code', 'ERR_CNO_SYNC_SHELL_REDIRECT_VAR');
    Reflect.set(err, 'syscall', `spawnSync ${command}`);
    return err;
}

function normalizeInput(input: unknown): SpawnInput | undefined {
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

function isPathLikeCommand(command: string): boolean {
    return command.includes('/') || command.includes('\\') || /^[A-Za-z]:[\\/]/.test(command);
}

function makeSpawnError(command: string, syscall: string, args?: string[]): NodeJS.ErrnoException {
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
function windowsPathExts(): string[] {
    let raw: string | undefined;
    try { raw = os.getenv('PATHEXT'); } catch { /* unset */ }
    const list = (raw ?? '.COM;.EXE;.BAT;.CMD').split(';')
        .map((ext) => ext.trim())
        .filter((ext) => ext.length > 1 && ext.startsWith('.'));
    return list.length > 0 ? list : ['.COM', '.EXE', '.BAT', '.CMD'];
}

// A directory is not a runnable command: Node reports ENOENT for `spawn('./adir')`
// (measured on v24.18/Windows), so the pre-flight must not count one as resolved.
function isRunnableFile(path: string): boolean {
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

function isAbsoluteCommandPath(command: string): boolean {
    return command.startsWith('/') || command.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(command);
}

// Relative commands resolve against the CHILD's cwd, not ours. Measured on Node
// v24.18: `spawnSync('./where.exe', { cwd: dir })` runs when dir holds the file
// even though the parent cwd does not — so a pre-flight that ignores options.cwd
// invents an ENOENT for a command that would have run.
function resolveAgainstCwd(command: string, cwd?: string): string {
    if (!cwd || isAbsoluteCommandPath(command)) return command;
    return cwd.replace(/[\\/]+$/, '') + '/' + command;
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
function resolveCommandForCwd(command: string, cwd?: string): string {
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
function resolveCommandFile(command: string, cwd?: string): string | null {
    const target = resolveAgainstCwd(command, cwd);
    if (isRunnableFile(target)) return target;
    if (os.uname().sysname !== 'Windows_NT') return null;
    // Only an extensionless final segment gets the PATHEXT treatment.
    const base = target.slice(Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')) + 1);
    if (base.includes('.')) return null;
    for (const ext of windowsPathExts()) {
        if (/^\.(?:bat|cmd)$/i.test(ext)) continue;
        if (isRunnableFile(target + ext)) return target + ext;
        if (isRunnableFile(target + ext.toLowerCase())) return target + ext.toLowerCase();
    }
    return null;
}

function commandFileExists(command: string, cwd?: string): boolean {
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
function isBatchFileCommand(command: string): boolean {
    if (os.uname().sysname !== 'Windows_NT') return false;
    return /\.(?:bat|cmd)$/i.test(command);
}

// Node's shape, measured on v24.18/Windows. The sync form carries the command in
// the message/syscall plus path/spawnargs; the async form throws a bare
// `spawn EINVAL` with only errno/code/syscall.
function makeBatchFileError(command: string, args: string[], syscall: string | null): NodeJS.ErrnoException {
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
function getImmediateSpawnError(command: string, syscall: string, cwd?: string, args?: string[]): NodeJS.ErrnoException | null {
    if (!isPathLikeCommand(command)) return null;
    if (commandFileExists(command, cwd)) return null;
    return makeSpawnError(command, syscall, args);
}

// Bare names are deliberately not pre-flighted (CreateProcess owns PATH lookup,
// and a JS search that disagrees would reject a command that actually runs). But
// native spawnSync reports an unresolvable command as a codeless InternalError,
// so on the *failure* path we resolve PATH ourselves to decide between ENOENT and
// a genuine unknown error. Runs only after a failure, so success pays nothing.
function resolvesOnPath(command: string): boolean {
    let raw: string | undefined;
    try { raw = os.getenv('PATH'); } catch { /* unset */ }
    if (!raw) return false;
    const isWindows = os.uname().sysname === 'Windows_NT';
    const sep = isWindows ? ';' : ':';
    for (const entry of raw.split(sep)) {
        const dir = entry.trim().replace(/^"|"$/g, '');
        if (!dir) continue;
        const joined = dir.replace(/[\\/]+$/, '') + (isWindows ? '\\' : '/') + command;
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
function cwdIsMissing(cwd?: string): boolean {
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
function normalizeSpawnFailure(err: unknown, command: string, syscall: string, cwd?: string, args?: string[]): Error {
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

function flattenPrototype(target: object): void {
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

interface ChildProcessImpl extends ChildProcess {
    // Override the readonly modifiers inherited from ChildProcess — the
    // concrete implementation needs to mutate these internally.
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    spawnargs: string[];
    spawnfile: string;
    killed: boolean;
    connected: boolean;

    _process: CModuleProcess.ChildProcess | null;
    _killed: boolean;
    _exitCode: number | null;
    _signalCode: string | null;
    _stdin: Writable | null;
    _stdout: Readable | null;
    _stderr: Readable | null;
    _ipcChannel: IPCChannel | null;
    _messageQueue: unknown[];
    _init(process: CModuleProcess.ChildProcess, command: string, args: string[], options: SpawnOptions): void;
    _failSpawn(error: NodeJS.ErrnoException, stdioKinds?: (string | undefined)[]): void;
    _createWritable(pipe: CModuleStreams.Pipe): Writable;
    _createReadable(pipe: CModuleStreams.Pipe): Readable;
    _createDuplex(pipe: CModuleStreams.Pipe): Duplex;
    _waitExit(): Promise<void>;
    kill(signal?: string | number): boolean;
    disconnect(): void;
    unref(): void;
    ref(): void;
    send(message: unknown, sendHandle?: unknown, options?: unknown, callback?: (error: Error | null) => void): boolean;
    _setupIPC(pipe: CModuleStreams.Pipe, serialization?: IPCSerialization): void;
    _flushIPCMessages(): void;
}

interface ChildProcessImplConstructor {
    new (): ChildProcessImpl;
    (): ChildProcessImpl;
    prototype: ChildProcessImpl;
}

function initChildProcessImpl(self: ChildProcessImpl): void {
    EventEmitter.call(self);
    self._process = null;
    self._killed = false;
    self._exitCode = null;
    self._signalCode = null;
    self._stdin = null;
    self._stdout = null;
    self._stderr = null;
    self._ipcChannel = null;
    self._messageQueue = [];

    self.stdin = null;
    self.stdout = null;
    self.stderr = null;
    self.stdio = [null, null, null];
    self.pid = 0;
    self.exitCode = null;
    self.signalCode = null;
    self.spawnargs = [];
    self.spawnfile = '';
    self.killed = false;
    self.connected = false;

    self.on('newListener', (eventName) => {
        if (eventName === 'message') queueMicrotask(() => self._flushIPCMessages());
    });
}

const ChildProcessImpl: ChildProcessImplConstructor = function ChildProcessImpl(this: ChildProcessImpl | undefined) {
    const target: ChildProcessImpl = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(ChildProcessImpl.prototype);
    initChildProcessImpl(target);
    return target;
} as ChildProcessImplConstructor;

Object.setPrototypeOf(ChildProcessImpl, EventEmitter);
ChildProcessImpl.prototype = Object.create(EventEmitter.prototype);

ChildProcessImpl.prototype._init = function _init(this: ChildProcessImpl, process: CModuleProcess.ChildProcess, command: string, args: string[], options: SpawnOptions): void {
    this._process = process;
    this.pid = process.pid;
    this.spawnfile = command;
    this.spawnargs = [command, ...args];

    // Set stdin
    if (process.stdin) {
        this._stdin = this._createWritable(process.stdin);
        this.stdin = this._stdin;
    }

    // Set stdout
    if (process.stdout) {
        this._stdout = this._createReadable(process.stdout);
        this.stdout = this._stdout;
    }

    // Set stderr
    if (process.stderr) {
        this._stderr = this._createReadable(process.stderr);
        this.stderr = this._stderr;
    }

    this.stdio = [this.stdin, this.stdout, this.stderr];
    const extra = process.stdioExtra;
    if (Array.isArray(extra)) {
        for (let fd = 3; fd < extra.length; fd++) {
            const pipe = extra[fd];
            this.stdio[fd] = pipe ? this._createDuplex(pipe) : null;
        }
    }

    // Asynchronously wait for process exit
    this._waitExit();
    queueMicrotask(() => this.emit('spawn'));
};

// Spawn never started: Node emits 'error', then 'close' with the UV errno as
// the exit code, and no 'exit'. Without the 'close', exec()/promisify hang.
// A spawn that never started still hands back stream objects for every 'pipe'
// slot in Node — it is not an all-or-nothing null. Measured on v24.18/Windows for
// `spawn('<missing>', …)`:
//   stdio 'pipe'                     -> stdin/stdout/stderr are all objects
//   stdio 'ignore' / 'inherit'       -> all three null
//   stdio ['pipe','ignore','inherit']-> stdin object, stdout null, stderr null
//   stdio ['pipe','pipe','pipe','pipe'] -> fd 3 an object too, child.stdio.length 4
// so the decision is PER SLOT. Returning null everywhere made the ordinary
// `child.stdout.on('data', …)` wiring throw "cannot read property 'on' of null"
// before the 'error' event could ever be delivered — which is precisely what
// execa/cross-spawn-shaped code does.
//
// The streams must also SETTLE, or a stub would trade a TypeError for a hang.
// Node's measured settle semantics on a failed spawn are reproduced exactly by:
//   readable ended via push(null) -> finished() settles with NO error   (stdout/stderr)
//   writable destroyed            -> finished() settles ERR_STREAM_PREMATURE_CLOSE (stdin)
// (both verified identical in cno, so no dependency on any pending stream fix).
// KNOWN FIDELITY GAP, deliberate: Node's child stdio streams are Sockets, i.e.
// duplex in both directions even for stdout/stderr (`child.stdout.writable` is
// true there), so on these stubs the opposite-direction properties read
// `undefined` instead of a boolean. Making them Duplex is not assignable to
// cno's own `Readable`/`Writable` slot types (Duplex lacks _readAndResolve/wrap),
// and the settle semantics below — the part that prevents a hang — are already
// byte-identical to Node either way, so the cosmetic property is not worth a cast.
function makeFailedReadable(): Readable {
    const readable = new Readable({
        read() { /* EOF is pushed below, once. */ },
    });
    readable.push(null);
    // Flowing, so 'end' then 'close' reach a listener attached synchronously by
    // the caller on the same tick as the spawn call.
    readable.resume();
    return readable;
}

function makeFailedWritable(): Writable {
    const writable = new Writable({
        write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            callback();
        },
    });
    // Destroyed rather than ended, which is what makes finished() settle with
    // ERR_STREAM_PREMATURE_CLOSE exactly as Node's failed-spawn stdin does.
    // Deferred so a synchronous `.on('close', …)` still observes it.
    queueMicrotask(() => {
        try { writable.destroy(); } catch { /* already gone */ }
    });
    return writable;
}

function makeFailedDuplex(): Duplex {
    const duplex = new Duplex({
        read() { /* EOF is pushed below, once. */ },
        write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            callback();
        },
    });
    duplex.push(null);
    duplex.resume();
    return duplex;
}

ChildProcessImpl.prototype._failSpawn = function _failSpawn(this: ChildProcessImpl, error: NodeJS.ErrnoException, stdioKinds?: (string | undefined)[]): void {
    const errno = typeof error.errno === 'number' ? error.errno : null;

    // Build the 'pipe' slots before anything is emitted, so they exist by the
    // time the caller returns from spawn() and can be wired up synchronously.
    if (stdioKinds) {
        const isPipe = (kind: string | undefined) => kind === 'pipe';
        if (isPipe(stdioKinds[0])) {
            this._stdin = makeFailedWritable();
            this.stdin = this._stdin;
        }
        if (isPipe(stdioKinds[1])) {
            this._stdout = makeFailedReadable();
            this.stdout = this._stdout;
        }
        if (isPipe(stdioKinds[2])) {
            this._stderr = makeFailedReadable();
            this.stderr = this._stderr;
        }
        this.stdio = [this.stdin, this.stdout, this.stderr];
        for (let fd = 3; fd < stdioKinds.length; fd++) {
            this.stdio[fd] = isPipe(stdioKinds[fd]) ? makeFailedDuplex() : null;
        }
    }

    queueMicrotask(() => {
        this.emit('error', error);
        this._exitCode = errno;
        this.exitCode = errno;
        this.emit('close', errno, null);
    });
};

ChildProcessImpl.prototype._createWritable = function _createWritable(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Writable {
    return new Writable({
        write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            pipe.write(stdioChunkBytes(chunk)).then(() => callback()).catch(callback);
        },
        async final(callback: (error?: Error | null) => void) {
            try { await pipe.shutdown(); } catch { try { pipe.close(); } catch {} } finally { callback(); }
        },
        // Node's child stdin is a socket, and destroying a socket closes its
        // handle. Two things needed this hook:
        //  1. `final()` is SKIPPED on the destroy path, so without it the native
        //     pipe was never closed when stdin was destroyed rather than ended.
        //  2. A Writable built with no `destroy` option has NO `_destroy` at all
        //     (stream/mod.ts only assigns it from the option). execa's
        //     `spyOnStdinDestroy` does `const {_destroy} = stdin` and then
        //     `_destroy.call(...)`, so on every child it threw "cannot read
        //     property 'call' of undefined" — which `runStreamDestroy` converts
        //     into a spurious 'error' on the child's stdin.
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
            try { pipe.close(); } catch { /* already closed by the exiting child */ }
            callback(error);
        },
    });
};

ChildProcessImpl.prototype._createReadable = function _createReadable(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Readable {
    const readable = new Readable({
        read() {
            // Resume reading when the consumer has drained below the high water mark
            startPipeReadQuietly(pipe);
        }
    });

    // Use callback-based read: pipe.onread pushes data into the Readable buffer
    pipe.onread = (data: Uint8Array | null | undefined, err?: unknown) => {
        if (err) {
            readable.destroy(asError(err));
            return;
        }
        if (data === null || data === undefined) {
            readable.push(null);
            stopPipeReadQuietly(pipe);
            return;
        }
        const ok = readable.push(data);
        if (!ok) {
            // Back-pressure: stop reading until Readable drains
            stopPipeReadQuietly(pipe);
        }
    };

    // Enter flowing mode so push() emits 'data' immediately.
    // Must be after onread is set — resume() calls _read() → startRead().
    readable.resume();
    return readable;
};

ChildProcessImpl.prototype._createDuplex = function _createDuplex(this: ChildProcessImpl, pipe: CModuleStreams.Pipe): Duplex {
    const duplex = new Duplex({
        read() {
            startPipeReadQuietly(pipe);
        },
        write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            pipe.write(stdioChunkBytes(chunk)).then(() => callback()).catch(callback);
        },
        async final(callback: (error?: Error | null) => void) {
            try { await pipe.shutdown(); } catch { try { pipe.close(); } catch {} } finally { callback(); }
        },
        // Same two reasons as _createWritable's `destroy` hook, for the fd >= 3
        // duplex streams: `final()` is SKIPPED on the destroy path, so the native
        // pipe leaked whenever an extra stdio stream was destroyed rather than
        // ended; and a Duplex built with no `destroy` option has NO `_destroy` at
        // all, so the `const {_destroy} = stream` + `_destroy.call(...)` pattern
        // (execa's spyOnStdinDestroy) threw "cannot read property 'call' of
        // undefined". Measured: node's fd-3 stream has a `_destroy` function and
        // settles 'close'; without this hook cno's never settled.
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
            try { pipe.close(); } catch { /* already closed by the exiting child */ }
            callback(error);
        },
    });

    pipe.onread = (data: Uint8Array | null | undefined, err?: unknown) => {
        if (err) {
            duplex.destroy(asError(err));
            return;
        }
        if (data === null || data === undefined) {
            duplex.push(null);
            stopPipeReadQuietly(pipe);
            return;
        }
        if (!duplex.push(data)) stopPipeReadQuietly(pipe);
    };

    duplex.resume();
    return duplex;
};

ChildProcessImpl.prototype._waitExit = async function _waitExit(this: ChildProcessImpl): Promise<void> {
    if (!this._process) return;

    try {
        const info = await this._process.wait();
        const exitCode = info.term_signal ? null : info.exit_status;
        this._exitCode = exitCode;
        this.exitCode = exitCode;
        this._signalCode = info.term_signal;
        this.signalCode = info.term_signal;

        // Node's `onexit` destroys the child's stdin BEFORE emitting 'exit', so a
        // listener on 'exit' legitimately observes `stdin.destroyed === true`
        // (measured v24.18). It is a destroy(), not an end(): `writableEnded`
        // stays false and any unread pending write is discarded rather than
        // flushed. Without this the Writable stayed alive forever, so
        // `finished(child.stdin)` NEVER SETTLED — which is exactly the member of
        // execa's Promise.all that made `await execa(...)` hang and then exit 0
        // with no output. stdout/stderr are left alone: they reach EOF on their
        // own and their `finished()` already resolved.
        destroyChildStdin(this._stdin);

        this.emit('exit', this._exitCode, this._signalCode);

        // 'close' must wait for exit AND EOF/close of every piped stdio stream
        // so exec/execFile don't see truncated stdout/stderr. stdin is NOT part
        // of that set — Node only counts stdio indices > 0 toward `_closesNeeded`.
        //
        // Emitting synchronously when nothing is outstanding is load-bearing for
        // event order, not just an optimization: `destroy()` defers stdin's
        // 'close' by a tick, and Node's `maybeClose` runs synchronously inside
        // the same `onexit` turn, which is why Node's order is child 'exit',
        // child 'close', then stdin 'close'. An unconditional `await` here put
        // the child's 'close' behind a microtask and inverted the last two.
        const pending = [this._stdout, this._stderr].filter(streamEndPending);
        if (pending.length > 0) {
            await Promise.all(pending.map((stream) => waitStreamEnd(stream)));
        }
        this.emit('close', this._exitCode, this._signalCode);
    } catch (err) {
        this.emit('error', err);
    }
};

// Windows supports only SIGQUIT/SIGTERM/SIGKILL/SIGINT (libuv's uv__kill switch);
// everything else returns UV_ENOSYS. Node does not surface that as a failure — it
// falls back to an unconditional terminate, which is why `child.kill('SIGHUP')`
// reports true and leaves signalCode 'SIGKILL' there (measured on v24.18/Windows
// for SIGHUP/SIGABRT/SIGBREAK/SIGWINCH and the bare number 1). Without the
// fallback those calls returned false and the child kept running, so a
// `kill('SIGHUP')` shutdown path leaked the process.
//
// The native kill throws an IOError whose `code` is the NUMERIC uv errno
// (measured: -4054 for ENOSYS), so compare against the runtime table — the
// committed .d.ts value for ENOSYS is stale and a hardcoded constant would
// silently never match.
function isUnsupportedSignalError(err: unknown): boolean {
    const code = err instanceof Error ? Reflect.get(err, 'code') : undefined;
    if (typeof code === 'number') {
        return code === nativeError.errno.ENOSYS || code === nativeError.errno.EINVAL;
    }
    return code === 'ENOSYS' || code === 'EINVAL';
}

ChildProcessImpl.prototype.kill = function kill(this: ChildProcessImpl, signal?: string | number): boolean {
    if (this._killed || !this._process) return false;
    // Node returns false and leaves `killed` alone once the child has been reaped
    // (measured: kill-after-exit is false with killed still false), so an
    // already-exited child must not be reported as newly killed.
    if (this._exitCode !== null || this._signalCode !== null) return false;

    const signum = transformSignal(signal);
    // kill(0) is a liveness probe in Node: it must not arm the "already killed"
    // guard, and must never fall through to the native SIGTERM default.
    if (signum !== 0) this._killed = true;
    this.killed = true;

    try {
        this._process.kill(signum);
        return true;
    } catch (err) {
        // Unsupported-signal fallback, matching Node. kill(0) must stay a probe.
        if (signum !== 0 && isUnsupportedSignalError(err)) {
            try {
                this._process.kill(transformSignal('SIGKILL'));
                return true;
            } catch { /* fall through to false */ }
        }
        return false;
    }
};

ChildProcessImpl.prototype.disconnect = function disconnect(this: ChildProcessImpl): void {
    // Only the IPC channel is torn down on disconnect(). In Node, stdin/stdout/
    // stderr are independent of the IPC channel and must stay open. Closing the
    // channel emits 'close', whose handler (registered in _setupIPC) flips
    // `connected` to false and emits 'disconnect' — so we must not emit it here
    // again to avoid a duplicate event.
    if (!this.connected || !this._ipcChannel) return;
    this._ipcChannel.close();
    this._ipcChannel = null;
};

ChildProcessImpl.prototype.unref = function unref(this: ChildProcessImpl): void {
    // Host child processes do not expose per-process loop refs yet.
};

ChildProcessImpl.prototype.ref = function ref(this: ChildProcessImpl): void {
    // Kept as the matching Node-compatible no-op for unref().
};

ChildProcessImpl.prototype.send = function send(this: ChildProcessImpl, message: unknown, _sendHandle?: unknown, _options?: unknown, callback?: (error: Error | null) => void): boolean {
    const cb = typeof _sendHandle === 'function'
        ? _sendHandle
        : typeof _options === 'function'
            ? _options
            : callback;

    // Handle passing is not implemented: the IPC channel serialises the message
    // only, so a handle argument used to be dropped while send() still returned
    // true and the callback reported success — the child's 'message' listener got
    // `undefined` for its second parameter (measured: Node's child receives a
    // `Server`, cno's receives undefined). Silently losing the handle is worse
    // than refusing it, so refuse it the way Node refuses a handle it cannot
    // serialise: a synchronous ERR_INVALID_HANDLE_TYPE (measured shape on
    // v24.18 — it throws, it does not report through the callback).
    const sendHandle = typeof _sendHandle === 'function' ? undefined : _sendHandle;
    if (sendHandle !== undefined && sendHandle !== null) {
        throw Object.assign(new TypeError('This handle type cannot be sent'), {
            code: 'ERR_INVALID_HANDLE_TYPE',
        });
    }

    if (!this._ipcChannel || !this._ipcChannel.connected) {
        const err = Object.assign(
            new Error('IPC channel is not enabled for this child process. Use { stdio: [\'inherit\', \'inherit\', \'ipc\'] } to enable.'),
            { code: 'ERR_IPC_CHANNEL_CLOSED' },
        );
        if (cb) {
            queueMicrotask(() => cb(err));
            return false;
        }
        queueMicrotask(() => this.emit('error', err));
        return false;
    }

    // Node sends user messages verbatim (no wrapper) so the peer —
    // including a real node process — receives exactly what was sent.
    // A write failure must never throw synchronously out of send(): Node
    // reports it through the callback, or as an 'error' event when there is none.
    try {
        this._ipcChannel.send(message);
    } catch (err) {
        const wrapped = asError(err, 'write');
        if (cb) queueMicrotask(() => cb(wrapped));
        else queueMicrotask(() => this.emit('error', wrapped));
        return false;
    }
    if (cb) queueMicrotask(() => cb(null));
    return true;
};

/**
 * Set up IPC channel (called internally when stdio includes 'ipc')
 */
ChildProcessImpl.prototype._setupIPC = function _setupIPC(this: ChildProcessImpl, pipe: CModuleStreams.Pipe, serialization: IPCSerialization = 'json'): void {
    this._ipcChannel = new IPCChannel(pipe, serialization);
    this.connected = true;

    // Node exposes the control channel as child.channel with ref()/unref() on it;
    // `child.channel.unref()` is the documented way to stop the IPC channel from
    // holding the parent's loop open, and libraries call it unguarded. It was
    // missing entirely (measured: child.channel undefined where Node has an
    // object with function ref/unref), so such code threw on a property of
    // undefined. The methods are no-ops for the same reason ChildProcess.unref()
    // is — the host exposes no per-handle loop refs (see unref()).
    const channel = {
        ref: () => { /* no per-handle loop refs available; see unref() */ },
        unref: () => { /* no per-handle loop refs available; see unref() */ },
    };
    Reflect.set(this, 'channel', channel);
    // Node also aliases it as the private _channel.
    Reflect.set(this, '_channel', channel);

    this._ipcChannel.on('message', (msg) => {
        if (this.listenerCount('message') > 0) this.emit('message', msg);
        else this._messageQueue.push(msg);
    });

    this._ipcChannel.on('error', (err: Error) => {
        this.emit('error', err);
    });

    this._ipcChannel.on('close', () => {
        this.connected = false;
        Reflect.set(this, 'channel', null);
        Reflect.set(this, '_channel', null);
        this.emit('disconnect');
    });
};

ChildProcessImpl.prototype._flushIPCMessages = function _flushIPCMessages(this: ChildProcessImpl): void {
    if (this.listenerCount('message') === 0 || this._messageQueue.length === 0) return;
    const queue = this._messageQueue;
    this._messageQueue = [];
    for (const msg of queue) this.emit('message', msg);
};

Object.defineProperty(ChildProcessImpl.prototype, 'constructor', {
    value: ChildProcessImpl,
    writable: true,
    configurable: true,
});

flattenPrototype(ChildProcessImpl.prototype);

export const ChildProcess = ChildProcessImpl;

// spawn

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
interface ShellInvocation {
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
const SHELL_CMD_ENV = 'CNO_INTERNAL_SHELL_COMMAND';

function buildShellInvocation(
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

export function spawn(command: string): ChildProcess;
export function spawn(command: string, options: SpawnOptions): ChildProcess;
export function spawn(command: string, args: string[]): ChildProcess;
export function spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawn(command: string, argsOrOptions?: string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
    let args: string[] = [];
    let opts: SpawnOptions = {};

    if (Array.isArray(argsOrOptions)) {
        args = argsOrOptions;
        opts = options ?? {};
    } else if (argsOrOptions) {
        opts = argsOrOptions;
    }

    // Reject unrecognised stdio entries the way Node does, before anything is
    // spawned. Previously every unknown value fell through to 'inherit'.
    validateStdio(opts.stdio);
    validateStdioFdRedirects(opts.stdio);

    // CVE-2024-27980: refuse a direct .bat/.cmd spawn (see isBatchFileCommand).
    // Must precede the shell rewrite, which would turn `command` into cmd.exe.
    // Node throws this one synchronously rather than deferring to 'error'.
    if (!opts.shell && isBatchFileCommand(command)) {
        throw makeBatchFileError(command, args, null);
    }

    // Handle shell options
    let shellVerbatim = false;
    if (opts.shell) {
        const invocation = buildShellInvocation(command, args, opts.shell);
        command = invocation.command;
        args = invocation.args;
        shellVerbatim = invocation.verbatim === true;
    }

    const spawnOpts: CModuleProcess.SpawnOptions<false> = {
        cwd: opts.cwd,
        env: normalizeEnv(opts.env),
        clearEnv: opts.env !== undefined,
        uid: opts.uid,
        gid: opts.gid,
        detached: opts.detached,
        // Native name for "hide the console window on Windows".
        // Node's default is false (the v11 change to true was reverted).
        background: opts.windowsHide === true,
    };

    // argv0 and windowsVerbatimArguments are both honoured by the native async
    // spawn (mod_process.c reads "argv0" and sets
    // UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS) but were never forwarded, so both
    // options silently did nothing: `argv0:'MYARGV0'` left the child reporting the
    // real exePath, and windowsVerbatimArguments still went through libuv's
    // quote_cmd_arg (measured against Node v24.18, which passes the command line
    // through untouched). Set through Reflect because the committed
    // types/process.d.ts SpawnOptions does not declare either field yet.
    if (opts.argv0 !== undefined) Reflect.set(spawnOpts, 'argv0', opts.argv0);
    if (opts.windowsVerbatimArguments === true || shellVerbatim) {
        Reflect.set(spawnOpts, 'windowsVerbatimArguments', true);
    }

    // Handle stdio
    let hasIPC = false;
    let ipcFd = 3;
    if (opts.stdio) {
        if (Array.isArray(opts.stdio)) {
            spawnOpts.stdin = toNativeStdio(opts.stdio[0]);
            spawnOpts.stdout = toNativeStdio(opts.stdio[1]);
            spawnOpts.stderr = toNativeStdio(opts.stdio[2]);
            if (opts.stdio.length > 3) {
                spawnOpts.stdioExtra = opts.stdio.slice(3).map(toNativeExtraStdio);
            }
            // Check for IPC in any stdio position
            hasIPC = opts.stdio.includes('ipc');
            ipcFd = ipcFdFromStdio(opts.stdio);
        } else {
            spawnOpts.stdin = toNativeStdio(opts.stdio);
            spawnOpts.stdout = toNativeStdio(opts.stdio);
            spawnOpts.stderr = toNativeStdio(opts.stdio);
            hasIPC = false;
        }
    } else {
        spawnOpts.stdin = 'pipe';
        spawnOpts.stdout = 'pipe';
        spawnOpts.stderr = 'pipe';
    }

    const child = new ChildProcessImpl();
    child.spawnfile = command;
    child.spawnargs = [command, ...args];

    // The native slot values ('pipe'/'ignore'/'inherit'/…) are what decide
    // whether a failed spawn still exposes a stream for that slot; see _failSpawn.
    const failStdioKinds: (string | undefined)[] = [
        spawnOpts.stdin as string | undefined,
        spawnOpts.stdout as string | undefined,
        spawnOpts.stderr as string | undefined,
        ...((spawnOpts.stdioExtra ?? []) as (string | undefined)[]),
    ];

    const immediateError = getImmediateSpawnError(command, 'spawn', opts.cwd, args);
    if (immediateError) {
        child._failSpawn(immediateError, failStdioKinds);
        return child;
    }

    // Set IPC option in spawn options
    if (hasIPC) {
        const serialization: IPCSerialization = opts.serialization === 'advanced' ? 'advanced' : 'json';
        spawnOpts.ipc = true;
        spawnOpts.ipcFd = ipcFd;
        // The C layer inherits the IPC endpoint to the requested child fd. Tell
        // the child which fd that is via NODE_CHANNEL_FD (Node-compatible), so
        // the child's process module can wire up process.send()/process.on('message').
        // When the caller did not pass an explicit env we must start from the
        // current environment, otherwise the child would lose all inherited vars.
        const baseEnv = spawnOpts.env ?? os.environ();
        spawnOpts.env = {
            ...baseEnv,
            NODE_CHANNEL_FD: String(ipcFd),
            CNO_IPC_SERIALIZATION: serialization,
        };
    }

    let process: CModuleProcess.ChildProcess;
    try {
        // Only the native argv gets the cwd-resolved path (see resolveCommandForCwd).
        // spawnfile/spawnargs and every error keep the caller's spec, as Node does:
        // `spawn('./where.exe', { cwd })` reports spawnfile './where.exe' (measured).
        process = proc.spawn([resolveCommandForCwd(command, opts.cwd), ...args], spawnOpts);
        child._init(process, command, args, opts);
    } catch (err) {
        // Node's async spawn failure carries the same shape as the sync one,
        // including `spawnargs` (measured v24.18: [code,errno,path,spawnargs,
        // syscall] on both). `asError` takes no args and so silently dropped
        // spawnargs, which execa/cross-spawn read when formatting a failure.
        child._failSpawn(normalizeSpawnFailure(err, command, 'spawn', opts.cwd, args) as NodeJS.ErrnoException, failStdioKinds);
        return child;
    }

    // Set up IPC channel if created
    if (hasIPC && process.ipc) {
        child._setupIPC(process.ipc, opts.serialization === 'advanced' ? 'advanced' : 'json');
    }

    if (opts.signal) {
        const signal = opts.signal;
        const onAbort = () => {
            child.kill(opts.killSignal ?? 'SIGTERM');
            // Node always builds its own AbortError and ignores signal.reason.
            child.emit('error', Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
                code: 'ABORT_ERR',
            }));
        };
        // An already-aborted signal must kill immediately — 'abort' never fires again.
        if (signal.aborted) queueMicrotask(onAbort);
        else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (opts.timeout !== undefined && opts.timeout > 0) {
        const tid = setTimeout(() => {
            if (!child.killed) {
                child.kill(opts.killSignal || 'SIGTERM');
            }
        }, opts.timeout);
        // Clear the timer when the child exits to prevent leaks
        child.on('close', () => clearTimeout(tid));
    }

    return child;
}

// exec

export function exec(command: string, callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function exec(command: string, options: ExecOptions, callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function exec(command: string, optionsOrCallback?: ExecOptions | ((error: Error | null, stdout: string, stderr: string) => void), callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess {
    let opts: ExecOptions = {};
    let cb: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;

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
        finish(null, code, (signal ?? null) as string | null);
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
export function execFile(file: string, callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function execFile(file: string, args: string[]): ChildProcess;
export function execFile(file: string, args: string[], options: ExecFileOptions): ChildProcess;
export function execFile(file: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function execFile(file: string, args: string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
export function execFile(
    file: string,
    argsOrOptionsOrCallback?: string[] | ExecFileOptions | ((error: Error | null, stdout: string, stderr: string) => void),
    optionsOrCallback?: ExecFileOptions | ((error: Error | null, stdout: string, stderr: string) => void),
    callback?: (error: Error | null, stdout: string, stderr: string) => void
): ChildProcess {
    let args: string[] = [];
    let opts: ExecFileOptions = {};
    let cb: ((error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) | undefined;

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

export function spawnSync(command: string, options?: SpawnOptions): SpawnSyncResult;
export function spawnSync(command: string, args?: string[], options?: SpawnOptions): SpawnSyncResult;
export function spawnSync(command: string, argsOrOptions?: string[] | SpawnOptions, options?: SpawnOptions): SpawnSyncResult {
    let args: string[] = [];
    let optsSource: SpawnOptions = {};

    if (Array.isArray(argsOrOptions)) {
        args = argsOrOptions;
        optsSource = options ?? {};
    } else if (argsOrOptions) {
        optsSource = argsOrOptions;
    }

    validateStdio(optsSource.stdio);
    validateStdioFdRedirects(optsSource.stdio);
    validateMaxBuffer(optsSource.maxBuffer);

    // Node validates the encoding up front and throws ERR_UNKNOWN_ENCODING out of
    // spawnSync itself (measured on v24.18: `encoding:'bogus-enc'` throws, it is
    // not reported through result.error). Doing it here also keeps a decode
    // failure from being mistaken for a spawn failure further down, which is how
    // 'hex'/'base64' used to come back as a codeless error with no stdout at all.
    if (optsSource.encoding !== undefined && optsSource.encoding !== null
        && optsSource.encoding !== 'buffer' && !Buffer.isEncoding(optsSource.encoding)) {
        throw Object.assign(new TypeError(`Unknown encoding: ${String(optsSource.encoding)}`), {
            code: 'ERR_UNKNOWN_ENCODING',
        });
    }

    // CVE-2024-27980, sync side. Node reports it in `error` (pid 0, status null)
    // instead of throwing; execFileSync/execSync then rethrow via throwSyncResult.
    if (!optsSource.shell && isBatchFileCommand(command)) {
        return {
            error: makeBatchFileError(command, args, 'spawnSync'),
            status: null,
            signal: null,
        };
    }

    let shellEnv: Record<string, string> | undefined;
    if (optsSource.shell) {
        const joinedForCheck = args.length > 0 ? `${command} ${args.join(' ')}` : command;
        const invocation = buildShellInvocation(command, args, optsSource.shell, true);
        command = invocation.command;
        args = invocation.args;
        shellEnv = invocation.env;
        // Gated on invocation.env so this only ever fires on the env-var branch
        // it describes (Windows + cmd + a quoted command). Reported through
        // `error` rather than thrown, matching the CVE-2024-27980 refusal above,
        // so execSync/execFileSync rethrow it via throwSyncResult.
        if (shellEnv) {
            const target = findShellRedirectVarTarget(joinedForCheck);
            if (target !== undefined) {
                return {
                    error: makeSyncShellRedirectError(target, joinedForCheck),
                    status: null,
                    signal: null,
                };
            }
        }
    }

    const syncEnv = normalizeEnv(optsSource.env);
    const opts: CModuleProcess.SpawnOptions<false> = {
        cwd: optsSource.cwd,
        // The sync spawn does not go through uv_spawn, so libuv's required-vars
        // merge never runs — do it here or the child loses PATH/SYSTEMROOT.
        env: syncEnv === undefined ? undefined : withRequiredEnvVars(syncEnv),
        clearEnv: optsSource.env !== undefined,
        uid: optsSource.uid,
        gid: optsSource.gid,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        background: optsSource.windowsHide === true,
        input: normalizeInput(optsSource.input),
    };
    // NOTE: argv0 / windowsVerbatimArguments are deliberately NOT forwarded here.
    // The sync native entry point (mod_process.c tjs_spawn_sync) never reads
    // either property — only the async tjs_spawn does — so passing them would be
    // silently inert. Reported as a C gap rather than faked here.

    if (shellEnv) {
        opts.env = { ...(opts.env ?? os.environ()), ...shellEnv };
    }

    if (optsSource.stdio) {
        if (Array.isArray(optsSource.stdio)) {
            opts.stdin = toNativeStdio(optsSource.stdio[0]);
            opts.stdout = toNativeStdio(optsSource.stdio[1]);
            opts.stderr = toNativeStdio(optsSource.stdio[2]);
        } else {
            opts.stdin = toNativeStdio(optsSource.stdio);
            opts.stdout = toNativeStdio(optsSource.stdio);
            opts.stderr = toNativeStdio(optsSource.stdio);
        }
    }

    const immediateError = getImmediateSpawnError(command, 'spawnSync', optsSource.cwd, args);
    if (immediateError) {
        return {
            error: immediateError,
            status: null,
            signal: null,
        };
    }

    try {
        const result = proc.spawnSync(resolveCommandForCwd(command, optsSource.cwd), args, opts);
        // Node defaults spawnSync to raw Buffers — only an explicit encoding
        // (other than 'buffer') turns stdout/stderr into strings.
        const encoding = optsSource.encoding;
        const convert = (value: ArrayBuffer | null | undefined): Buffer | string | null | undefined => {
            if (value == null) return value;
            const bytes = new Uint8Array(value);
            if (encoding === undefined || encoding === 'buffer' || encoding === null) {
                return Buffer.from(bytes);
            }
            return decodeOutput(bytes, encoding);
        };
        let stdout = convert(result.stdout);
        let stderr = convert(result.stderr);
        let status = result.status;
        let signal = result.signal;
        let error = result.error ? normalizeSpawnFailure(result.error, command, 'spawnSync', optsSource.cwd, args) : undefined;

        // maxBuffer: the child cannot be killed mid-stream (spawnSync runs to
        // completion in the C layer), but every observable field can still be
        // made Node-exact because the full output is already in hand.
        //
        // Node's measured rule (v24.18/Windows) is NOT "truncate to maxBuffer":
        // it reads 64KiB chunks and keeps everything read, including the chunk
        // that crossed the limit, so
        //     captured = min(totalLen, (floor(maxBuffer/65536)+1)*65536)
        // Verified on mb=1000->65536, 10->65536, 65536->131072, 70000->131072,
        // 100000->131072, default 1MiB->1114112 (=17*65536), and on the
        // total-below-one-chunk case mb=1000/out=2000 -> 2000.
        //
        // Node also treats 0 as "no limit" rather than "capture nothing".
        // (Range validation happens before the try — see validateMaxBuffer.)
        const maxBuffer = optsSource.maxBuffer;
        // 0 and Infinity both mean unlimited, so neither enters the check below.
        if (error === undefined && typeof maxBuffer === 'number' && maxBuffer > 0 && Number.isFinite(maxBuffer)) {
            const CHUNK = 65536;
            const lengthOf = (value: Buffer | string | null | undefined) =>
                value == null ? 0 : (typeof value === 'string' ? value.length : value.byteLength);
            const over = (value: Buffer | string | null | undefined) => lengthOf(value) > maxBuffer;
            if (over(stdout) || over(stderr)) {
                const limit = (Math.floor(maxBuffer / CHUNK) + 1) * CHUNK;
                const truncate = (value: Buffer | string | null | undefined) =>
                    value == null || lengthOf(value) <= limit
                        ? value
                        : (typeof value === 'string' ? value.slice(0, limit) : value.subarray(0, limit));
                stdout = truncate(stdout);
                stderr = truncate(stderr);
                error = Object.assign(new Error(`spawnSync ${command} ENOBUFS`), {
                    code: 'ENOBUFS',
                    errno: nativeError.errno.ENOBUFS,
                    syscall: `spawnSync ${command}`,
                    path: command,
                });
                status = null;
                // Node kills the child once the limit is crossed, so the result
                // reports the kill signal rather than a null signal.
                signal = 'SIGTERM';
            }
        }

        // `error` is attached only when there is one. Node omits the key entirely
        // on success (measured v24.18: Object.keys is output,pid,signal,status,
        // stderr,stdout), so always listing it makes `'error' in result` -- a
        // reasonable success check -- report a failure that did not happen.
        const syncResult = {
            pid: result.pid,
            output: [result.output?.[0] ?? null, stdout ?? null, stderr ?? null],
            stdout,
            stderr,
            status,
            signal,
        } as SpawnSyncResult;
        if (error !== undefined) syncResult.error = error;
        return syncResult;
    } catch (err) {
        return {
            error: normalizeSpawnFailure(err, command, 'spawnSync', optsSource.cwd, args),
            status: null,
            signal: null,
        };
    }
}

// Node's execSync/execFileSync throw an Error decorated with the whole
// spawnSync result: status/signal/output/pid/stdout/stderr. Build scripts read
// e.status and e.stdout, so a bare Error breaks them.
function throwSyncResult(result: SpawnSyncResult, cmd: string): never {
    const stderr = result.stderr ?? '';
    // Node joins the stderr with a newline only when there IS stderr: measured on
    // v24.18, a silent failure's message is exactly `Command failed: <cmd>` with
    // NO trailing newline, while a noisy one is `Command failed: <cmd>\n<stderr>`.
    // Appending unconditionally left a stray "\n" that broke exact-message checks.
    const stderrText = String(stderr);
    const err = result.error ?? new Error(`Command failed: ${cmd}${stderrText.length > 0 ? `\n${stderrText}` : ''}`);
    // Node does ObjectAssign(err, spawnSyncResult), and when the result carries an
    // `error` that error IS err — so the thrown object gets a self-referencing
    // `error` key. Measured on v24.18: present (and === err) for a spawn failure,
    // absent entirely for a plain non-zero exit. Code that does `e.error?.code`
    // depends on it.
    if (result.error) Reflect.set(err, 'error', err);
    Reflect.set(err, 'status', result.status ?? null);
    Reflect.set(err, 'signal', result.signal ?? null);
    Reflect.set(err, 'output', result.output ?? null);
    Reflect.set(err, 'pid', result.pid);
    Reflect.set(err, 'stdout', result.stdout ?? null);
    Reflect.set(err, 'stderr', result.stderr ?? null);
    throw err;
}

export function execSync(command: string, options?: ExecOptions): Buffer | string {
    // Node's execSync default stdio is ['pipe','pipe','inherit'] — stderr goes
    // straight to the parent unless the caller asks otherwise.
    const result = spawnSync(command, [], {
        stdio: ['pipe', 'pipe', 'inherit'],
        ...options,
        shell: options?.shell ?? true,
    } as SpawnOptions);
    if (result.error || result.status !== 0 || result.signal) throwSyncResult(result, command);
    return result.stdout ?? '';
}

export function execFileSync(file: string, args?: string[], options?: ExecFileOptions): Buffer | string {
    const result = spawnSync(file, args ?? [], {
        stdio: ['pipe', 'pipe', 'inherit'],
        ...options,
    } as SpawnOptions);
    if (result.error || result.status !== 0 || result.signal) {
        throwSyncResult(result, [file, ...(args ?? [])].join(' '));
    }
    return result.stdout ?? '';
}

// promises namespace

export const promises = {
    exec(command: string, options?: ExecOptions): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
        return new Promise((resolve, reject) => {
            exec(command, options ?? {}, (error, stdout, stderr) => {
                if (error) reject(Object.assign(error, { stdout, stderr }));
                else resolve({ stdout, stderr });
            });
        });
    },

    execFile(file: string, args?: string[], options?: ExecFileOptions): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
        return new Promise((resolve, reject) => {
            execFile(file, args ?? [], options ?? {}, (error, stdout, stderr) => {
                if (error) reject(Object.assign(error, { stdout, stderr }));
                else resolve({ stdout, stderr });
            });
        });
    },

    spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcess {
        return spawn(command, args ?? [], options ?? {});
    },
};
