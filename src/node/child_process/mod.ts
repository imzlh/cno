// Keep public exports explicit: sibling modules also expose implementation helpers.

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

// This exports both the class and its same-named type alias.
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
