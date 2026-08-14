/**
 * Node.js child_process module - the async `spawn` entry point.
 */

const proc = import.meta.use('process');
const os = import.meta.use('os');

import { type IPCSerialization } from '../ipc_channel';
import { buildShellInvocation } from './_shared';
import { ChildProcessImpl } from './child';
import {
    getImmediateSpawnError,
    isBatchFileCommand,
    makeBatchFileError,
    normalizeEnv,
    normalizeSpawnFailure,
    resolveCommandForCwd,
} from './command';
import type { ChildProcess, SpawnOptions } from './types';
import {
    ipcFdFromStdio,
    toNativeExtraStdio,
    toNativeStdio,
    validateStdio,
    validateStdioFdRedirects,
    validateTimeout,
} from './validate';

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
    validateTimeout(opts.timeout);

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
