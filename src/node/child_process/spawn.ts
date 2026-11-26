/**
 * Node.js child_process module - the async `spawn` entry point.
 */

import { errorCode, matchesErrnoCode } from '../../utils/errno';
import { type IPCSerialization } from '../ipc_channel';
import { clearTimeout, setTimeout } from '../timers';
import { buildShellInvocation } from './_shared';
import { ChildProcessImpl } from './child';
import {
    isBatchFileCommand,
    makeBatchFileError,
    normalizeEnv,
    normalizeSpawnArgs,
    normalizeSpawnFailure,
} from './command';
import type { ChildProcess, SpawnOptions } from './types';
import {
    nativeStdioOptions,
    toNativeExtraStdio,
    validateStdio,
    validateStdioFdRedirects,
    validateTimeout,
} from './validate';

const proc = import.meta.use('process');
const os = import.meta.use('os');

export function spawn(command: string): ChildProcess;
export function spawn(command: string, options: SpawnOptions): ChildProcess;
export function spawn(command: string, args: string[]): ChildProcess;
export function spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawn(command: string, argsOrOptions?: string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
    let [args, opts] = normalizeSpawnArgs(argsOrOptions, options);

    // Reject unrecognised stdio entries the way Node does, before anything is
    // spawned.
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

    if (opts.argv0 !== undefined) spawnOpts.argv0 = opts.argv0;
    if (opts.windowsVerbatimArguments === true || shellVerbatim) {
        spawnOpts.windowsVerbatimArguments = true;
    }

    Object.assign(spawnOpts, nativeStdioOptions(opts.stdio));
    const ipcFd = Array.isArray(opts.stdio) ? opts.stdio.indexOf('ipc') : -1;
    if (Array.isArray(opts.stdio) && opts.stdio.length > 3) {
        spawnOpts.stdioExtra = opts.stdio.slice(3).map(toNativeExtraStdio);
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

    // Set IPC option in spawn options
    if (ipcFd >= 0) {
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
        process = proc.spawn([command, ...args], spawnOpts);
    } catch (err) {
        const code = errorCode(err);
        if (typeof code === 'number' && code < 0
            && !matchesErrnoCode(err, 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOENT')) {
            throw normalizeSpawnFailure(err, undefined, 'spawn');
        }
        child._failSpawn(normalizeSpawnFailure(err, command, 'spawn', args), failStdioKinds);
        return child;
    }

    child._init(process, command, args, opts);

    // Set up IPC channel if created
    if (ipcFd >= 0 && process.ipc) {
        child._setupIPC(process.ipc, opts.serialization === 'advanced' ? 'advanced' : 'json');
    }

    if (opts.signal) {
        const signal = opts.signal;
        let closed = false;
        const onAbort = () => {
            if (closed) return;
            child.kill(opts.killSignal ?? 'SIGTERM');
            // Node always builds its own AbortError and ignores signal.reason.
            child.emit('error', Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
                code: 'ABORT_ERR',
            }));
        };
        child.once('close', () => {
            closed = true;
            signal.removeEventListener('abort', onAbort);
        });
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
