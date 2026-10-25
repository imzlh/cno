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
    normalizeSpawnArgs,
    normalizeSpawnFailure,
    resolveCommandForCwd,
    withRequiredEnvVars,
} from './command';
import type { ExecFileOptions, ExecOptions, SpawnOptions, SpawnSyncResult } from './types';
import {
    nativeStdioOptions,
    validateMaxBuffer,
    validateStdio,
    validateStdioFdRedirects,
    validateTimeout,
} from './validate';

export function spawnSync(command: string, options?: SpawnOptions): SpawnSyncResult;
export function spawnSync(command: string, args?: string[], options?: SpawnOptions): SpawnSyncResult;
export function spawnSync(command: string, argsOrOptions?: string[] | SpawnOptions, options?: SpawnOptions): SpawnSyncResult {
    let [args, optsSource] = normalizeSpawnArgs(argsOrOptions, options);

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
        background: optsSource.windowsHide === true,
        input: normalizeInput(optsSource.input),
    };
    if (optsSource.windowsVerbatimArguments === true || shellVerbatim) {
        opts.windowsVerbatimArguments = true;
    }

    Object.assign(opts, nativeStdioOptions(optsSource.stdio));

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
        const convert = (bytes: Uint8Array | null): Buffer | string | null => {
            if (bytes === null) return null;
            if (encoding === undefined || encoding === 'buffer' || encoding === null) {
                return Buffer.from(bytes);
            }
            return decodeOutput(bytes, encoding);
        };
        let stdoutBytes = result.stdout === null ? null : new Uint8Array(result.stdout);
        let stderrBytes = result.stderr === null ? null : new Uint8Array(result.stderr);
        let status = result.status;
        let signal = result.signal;
        let error = result.error ? normalizeSpawnFailure(result.error, command, 'spawnSync', optsSource.cwd, args) : undefined;

        // Native sync spawn currently captures to completion. Keep the existing
        // chunk-rounded capture limit, but count the combined raw bytes before
        // decoding: UTF-8, hex and base64 strings have different lengths.
        const maxBuffer = Object.prototype.hasOwnProperty.call(optsSource, 'maxBuffer')
            ? optsSource.maxBuffer
            : 1024 * 1024;
        // 0 and Infinity both mean unlimited, so neither enters the check below.
        if (error === undefined && typeof maxBuffer === 'number' && maxBuffer > 0 && Number.isFinite(maxBuffer)) {
            const CHUNK = 65536;
            if ((stdoutBytes?.byteLength ?? 0) + (stderrBytes?.byteLength ?? 0) > maxBuffer) {
                const limit = (Math.floor(maxBuffer / CHUNK) + 1) * CHUNK;
                stdoutBytes = stdoutBytes?.subarray(0, limit) ?? null;
                stderrBytes = stderrBytes?.subarray(0, limit) ?? null;
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

        const stdout = convert(stdoutBytes);
        const stderr = convert(stderrBytes);

        // `error` is attached only when there is one. Node omits the key entirely
        // on success (measured v24.18: Object.keys is output,pid,signal,status,
        // stderr,stdout), so always listing it makes `'error' in result` -- a
        // reasonable success check -- report a failure that did not happen.
        const syncResult: SpawnSyncResult = {
            pid: result.pid,
            output: [null, stdout, stderr],
            stdout,
            stderr,
            status,
            signal,
        };
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
