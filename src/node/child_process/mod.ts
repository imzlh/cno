/**
 * Node.js child_process module — public surface.
 * Based on CModuleProcess implementation
 *
 * This file is a facade: the implementation lives in the sibling modules listed
 * below, and the export list here IS the public API. It is deliberately spelled
 * out name by name rather than using `export *`, because the submodules also
 * export internals to each other (pipe/stream helpers, stdio validators, command
 * resolution, spawn-error factories) and `export *` would silently publish those
 * as `node:child_process` exports.
 *
 *   types.ts     SpawnOptions / ExecOptions / ChildProcess / SpawnSyncResult, …
 *   _shared.ts   pipe + stdio-stream plumbing, transformSignal, decodeOutput,
 *                flattenPrototype, buildShellInvocation
 *   validate.ts  stdio / maxBuffer / timeout validation + native stdio converters
 *   command.ts   env normalisation, command resolution, spawn-error construction
 *   child.ts     ChildProcessImpl (the ChildProcess class) + failed-spawn stubs
 *   spawn.ts     spawn
 *   exec.ts      exec, execFile, fork, output collection
 *   sync.ts      spawnSync, execSync, execFileSync
 */

import type { Buffer } from '../buffer';
import { exec, execFile } from './exec';
import { spawn } from './spawn';
import type { ChildProcess, ExecFileOptions, ExecOptions, SpawnOptions } from './types';

export type {
    SpawnOptions,
    SpawnOptionsWithStdioTuple,
    ExecOptions,
    ExecFileOptions,
    SpawnSyncResult,
    ExecSyncResult,
} from './types';

// `ChildProcess` is one name with two meanings (the interface and the class), as
// it was before the split. child.ts re-exports the interface as a type alias
// alongside the value, so this single line publishes both — listing it in the
// `export type` block above as well would be a duplicate identifier.
export { ChildProcess } from './child';

export { spawn } from './spawn';

export { exec, execFile, fork } from './exec';

export { spawnSync, execSync, execFileSync } from './sync';

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
