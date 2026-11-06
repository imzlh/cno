import { isAbsolutePath, join, resolvePath } from '../../utils/path';
import { isWindows } from '../../utils/platform';
import type { WhichOptions } from 'bun';

const fs = import.meta.use('fs');
const os = import.meta.use('os');

export type { WhichOptions };

function getEnv(name: string): string | undefined {
    try {
        return os.getenv(name) ?? undefined;
    } catch {
        return undefined;
    }
}

function currentDirectory(): string {
    return os.cwd;
}

function isExecutableFile(path: string): boolean {
    try {
        if (!fs.stat(path).isFile) return false;
        fs.access(path, fs.X_OK);
        return true;
    } catch {
        return false;
    }
}

function windowsCandidates(command: string): string[] {
    const exts = (getEnv('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((ext) => ext.trim())
        .filter(Boolean);
    const lower = command.toLowerCase();
    if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) return [command];
    return exts.map((ext) => command + ext);
}

/**
 * Resolve a command name to an absolute path of an executable file, or null.
 * Mirrors Bun.which: names containing a path separator are resolved against
 * `cwd` and not searched in PATH; empty PATH entries are skipped so the current
 * directory is never searched implicitly.
 */
export function which(command: string, options: WhichOptions = {}): string | null {
    if (typeof command === 'symbol') throw new TypeError('Cannot convert a symbol to a string');
    command = command == null ? '' : String(command);
    if (command.length === 0) return null;

    const optionObject = options !== null && (typeof options === 'object' || typeof options === 'function')
        ? options
        : {};
    const cwd = resolvePath(optionObject.cwd == null ? currentDirectory() : String(optionObject.cwd), currentDirectory());
    const names = isWindows ? windowsCandidates(command) : [command];
    const hasSeparator = command.includes('/') || (isWindows && command.includes('\\'));

    if (hasSeparator) {
        for (const name of names) {
            const candidate = isAbsolutePath(name) ? name : resolvePath(name, cwd);
            if (isExecutableFile(candidate)) return candidate;
        }
        return null;
    }

    const searchPath = optionObject.PATH == null
        ? getEnv('PATH') ?? getEnv('Path') ?? ''
        : String(optionObject.PATH);
    const delimiter = isWindows ? ';' : ':';
    const dirs = searchPath
        .split(delimiter)
        .filter((dir) => dir.length > 0)
        .map((dir) => (isAbsolutePath(dir) ? dir : resolvePath(dir, cwd)));
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = join(dir, name);
            if (isExecutableFile(candidate)) return candidate;
        }
    }
    return null;
}
