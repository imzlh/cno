/**
 * Node.js child_process module - spawnSync / execSync / execFileSync.
 */

const proc = import.meta.use('process');
const nativeError = import.meta.use('error');

import { Buffer } from '../buffer';
import { buildShellInvocation, decodeOutput } from './_shared';
import {
    getImmediateSpawnError,
    isBatchFileCommand,
    makeBatchFileError,
    normalizeEnv,
    normalizeInput,
    normalizeSpawnFailure,
    resolveCommandForCwd,
    withRequiredEnvVars,
} from './command';
import type { ExecFileOptions, ExecOptions, SpawnOptions, SpawnSyncResult } from './types';
import {
    toNativeStdio,
    validateMaxBuffer,
    validateStdio,
    validateStdioFdRedirects,
    validateTimeout,
} from './validate';

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
    validateTimeout(optsSource.timeout);

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

    let shellVerbatim = false;
    if (optsSource.shell) {
        const invocation = buildShellInvocation(command, args, optsSource.shell);
        command = invocation.command;
        args = invocation.args;
        shellVerbatim = invocation.verbatim === true;
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
    if (optsSource.windowsVerbatimArguments === true || shellVerbatim) {
        Reflect.set(opts, 'windowsVerbatimArguments', true);
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
