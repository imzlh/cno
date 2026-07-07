/**
 * Node.js fs.promises API
 */


import { normalizeErrnoError, wrapPromise } from '../_internal/errno';
import { getTierLimits } from '../_internal/memory';
import path from '../path';
import { createAsyncDir, createFileHandle, decodeBuffer, encodePathResult, mkdirRecursive, modeToNumber, parseFlags, pathToString, randomHex, readDirEntries, readFileFromFdSync, removeRecursive, splitPathOrFd, timeToNumber, toNodeDirentAsync, toNodeStat, toNodeStatFs, toUint8Array, validateOpendirOptions, assertCopyFileMode, makeAbortError, type Mode, type PathLike, type TimeLike } from './utils';

const { dirname, join } = path;
const { readBufSize: READ_BUF_SIZE } = getTierLimits();

const asfs = import.meta.use('asyncfs');
const fs = import.meta.use('fs');
const os = import.meta.use('os');

// Helper: wrap asyncfs calls, auto-convert errno to ErrnoException
function w<T>(promise: Promise<T>, syscall: string, path: string, dest?: string): Promise<T> {
    return wrapPromise(promise, syscall, path, dest);
}

// File read/write

export async function readFile(path: PathLike | number, options?: { encoding?: BufferEncoding | null; flag?: string | number; signal?: AbortSignal } | BufferEncoding): Promise<string | Uint8Array> {
    const target = splitPathOrFd(path);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const flag = typeof options === 'object' ? options?.flag : undefined;
    const signal = typeof options === 'object' ? options?.signal : undefined;
    if (signal?.aborted) throw makeAbortError(signal);
    const buffer = 'fd' in target
        ? readFileFromFdSync(fs.read, target.fd, READ_BUF_SIZE)
        : flag === undefined
            ? await withAbort(w(asfs.readFile(target.path), 'readFile', target.path), signal)
            : await withAbort(readFileWithFlag(target.path, flag), signal);
    if (signal?.aborted) throw makeAbortError(signal);
    return decodeBuffer(buffer, encoding);
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw makeAbortError(signal);
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(makeAbortError(signal));
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => {
                cleanup();
                resolve(value);
            },
            err => {
                cleanup();
                reject(err);
            },
        );
    });
}

async function readFileWithFlag(path: string, flag: string | number): Promise<Uint8Array<ArrayBuffer>> {
    const handle = await w(asfs.open(path, parseFlags(flag)), 'readFile', path);
    try {
        const st = await handle.stat();
        const buf = new Uint8Array(st.size);
        let off = 0;
        while (off < st.size) {
            const n = await handle.read(buf.subarray(off));
            if (n === 0) break;
            off += n;
        }
        return buf;
    } finally {
        await handle.close();
    }
}

export async function writeFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const target = splitPathOrFd(path);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' && options?.flag !== undefined ? parseFlags(options.flag) : 'w';
    const encoding = typeof options === 'string' ? options : typeof options === 'object' ? options?.encoding : undefined;
    const buffer = toUint8Array(data, encoding);
    if ('fd' in target) {
        fs.ftruncate(target.fd, 0);
        fs.write(target.fd, buffer);
        return;
    }

    const handle = await w(asfs.open(target.path, flag, mode), 'writeFile', target.path);
    try {
        await handle.write(buffer);
    } finally {
        await handle.close();
    }
}

export async function appendFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const target = splitPathOrFd(path);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' && options?.flag !== undefined ? parseFlags(options.flag) : 'a';
    const encoding = typeof options === 'string' ? options : typeof options === 'object' ? options?.encoding : undefined;
    const buffer = toUint8Array(data, encoding);
    if ('fd' in target) {
        fs.write(target.fd, buffer);
        return;
    }

    const handle = await w(asfs.open(target.path, flag, mode), 'appendFile', target.path);
    try {
        await handle.write(buffer);
    } finally {
        await handle.close();
    }
}

// File status

export async function access(path: PathLike): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.stat(pathStr), 'stat', pathStr);
}

export async function stat(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const pathStr = pathToString(path);
    const st = await w(asfs.stat(pathStr), 'stat', pathStr);
    return toNodeStat(st, options);
}

export async function lstat(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const pathStr = pathToString(path);
    const st = await w(asfs.lstat(pathStr), 'lstat', pathStr);
    return toNodeStat(st, options);
}

// Directory operations

export async function mkdir(path: PathLike, options?: { mode?: number; recursive?: boolean } | number): Promise<string | undefined> {
    const pathStr = pathToString(path);
    const mode = typeof options === 'number' ? options : options?.mode;
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        await mkdirRecursive(pathStr, mode);
        return pathStr;
    }

    await w(asfs.mkdir(pathStr, mode), 'mkdir', pathStr);
    return undefined;
}

export async function rmdir(path: PathLike, options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void> {
    const pathStr = pathToString(path);

    if (options?.recursive) {
        await removeRecursive(pathStr);
    } else {
        await w(asfs.rmdir(pathStr), 'rmdir', pathStr);
    }
}

export async function rm(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void> {
    const pathStr = pathToString(path);

    try {
        const stats = await w(asfs.lstat(pathStr), 'lstat', pathStr);

        if (stats.isDirectory) {
            if (options?.recursive) {
                await removeRecursive(pathStr);
            } else {
                await w(asfs.rmdir(pathStr), 'rmdir', pathStr);
            }
        } else {
            await w(asfs.unlink(pathStr), 'unlink', pathStr);
        }
    } catch (err) {
        if (!options?.force) {
            throw err;
        }
    }
}

export async function readdir(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding): Promise<Array<string | Buffer> | import('fs').Dirent[]> {
    const pathStr = pathToString(path);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;
    const recursive = typeof options === 'object' ? options?.recursive === true : false;

    try {
        const entries = await readDirEntries(pathStr, recursive);
        if (withFileTypes) {
            return entries.map(entry => toNodeDirentAsync(entry));
        }
        return entries.map(entry => encodePathResult(entry.name, options));
    } catch (err) {
        throw normalizeErrnoError(err, 'readdir', pathStr);
    }
}

export async function opendir(path: PathLike, options?: { encoding?: BufferEncoding; bufferSize?: number }): Promise<import('fs').Dir> {
    validateOpendirOptions(options);
    const pathStr = pathToString(path);
    const dirHandle = await w(asfs.readDir(pathStr), 'readdir', pathStr);
    return createAsyncDir(pathStr, dirHandle);
}

// File operations

export async function unlink(path: PathLike): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.unlink(pathStr), 'unlink', pathStr);
}

export async function rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
    const oldStr = pathToString(oldPath);
    const newStr = pathToString(newPath);
    await w(asfs.rename(oldStr, newStr), 'rename', oldStr, newStr);
}

export async function copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void> {
    const srcStr = pathToString(src);
    const destStr = pathToString(dest);
    assertCopyFileMode(srcStr, destStr, mode);
    await w(asfs.copyFile(srcStr, destStr), 'copyFile', srcStr, destStr);
}

export async function truncate(path: PathLike, len?: number): Promise<void> {
    const pathStr = pathToString(path);
    const handle = await w(asfs.open(pathStr, 'r+'), 'truncate', pathStr);
    try {
        await handle.truncate(len ?? 0);
    } finally {
        await handle.close();
    }
}

// Link operations

export async function link(existingPath: PathLike, newPath: PathLike): Promise<void> {
    const existingStr = pathToString(existingPath);
    await w(asfs.link(existingStr, pathToString(newPath)), 'link', existingStr);
}

export async function symlink(target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction'): Promise<void> {
    // Windows: DIR=1, JUNCTION=2, FILE=0 (no flags). SymlinkType enum lacks FILE,
    // so we use 0 for file symlinks which is the correct Windows API value.
    const symlinkType: CModuleAsyncFS.SymlinkType = type === 'dir' ? asfs.SymlinkType.DIR : type === 'junction' ? asfs.SymlinkType.JUNCTION : 0;
    const pathStr = pathToString(path);
    await w(asfs.symlink(pathToString(target), pathStr, symlinkType), 'symlink', pathStr);
}

export async function readlink(path: PathLike): Promise<string | Uint8Array> {
    const pathStr = pathToString(path);
    const result = await w(asfs.readLink(pathStr), 'readlink', pathStr);
    return result;
}

export async function realpath(_path: PathLike): Promise<string> {
    const pathStr = pathToString(_path);
    if (path.isAbsolute(pathStr)) {
        return path.normalize(pathStr);
    } else {
        return path.join(os.cwd, pathStr);
    }
}

Reflect.set(realpath, 'native', function (path: PathLike) {
    const pathStr = pathToString(path);
    return w(asfs.realPath(pathStr), 'realpath', pathStr);
});

// Permission operations

export async function chmod(path: PathLike, mode: Mode): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.chmod(pathStr, modeToNumber(mode)), 'chmod', pathStr);
}

export async function chown(path: PathLike, uid: number, gid: number): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.chown(pathStr, uid, gid), 'chown', pathStr);
}

export async function lchown(path: PathLike, uid: number, gid: number): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.lchown(pathStr, uid, gid), 'lchown', pathStr);
}

// Time operations

export async function utimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.utime(pathStr, timeToNumber(atime), timeToNumber(mtime)), 'utimes', pathStr);
}

export async function lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.lutime(pathStr, timeToNumber(atime), timeToNumber(mtime)), 'lutimes', pathStr);
}

// statfs

export async function statfs(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').StatsFs> {
    const pathStr = pathToString(path);
    const result = await w(asfs.statFs(pathStr), 'statfs', pathStr);
    return toNodeStatFs(result, options);
}

// Open file

export async function open(path: PathLike, flags?: string | number, mode?: Mode) {
    const flag = parseFlags(flags);
    const modeNum = modeToNumber(mode);
    const pathStr = pathToString(path);
    const handle = await w(asfs.open(pathStr, flag, modeNum), 'open', pathStr);
    return createFileHandle(handle.fileno(), handle);
}

// Missing exports

export async function lchmod(path: PathLike, mode: Mode): Promise<void> {
    // lchmod is typically not supported, simplified implementation
    await chmod(path, mode);
}

export async function mkdtemp(prefix: string, options?: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding): Promise<string | Buffer> {
    const dirPath = prefix + randomHex();
    const result = encodePathResult(dirPath, options);
    await w(asfs.mkdir(dirPath), 'mkdir', dirPath);
    return result;
}

export async function mkdtempDisposable(prefix: string, options?: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding): Promise<{ path: string | Buffer; cleanup: () => Promise<void> }> {
    const dirPath = prefix + randomHex();
    const result = encodePathResult(dirPath, options);
    await w(asfs.mkdir(dirPath), 'mkdir', dirPath);
    return {
        path: result,
        async cleanup() {
            await removeRecursive(dirPath);
        },
    };
}

export function watch(path: PathLike, options?: { persistent?: boolean; recursive?: boolean; encoding?: BufferEncoding; signal?: AbortSignal }): AsyncIterableIterator<{ eventType: string; filename: string | null }> {
    const pathStr = pathToString(path);
    const fswatch = import.meta.use('fswatch');
    const signal = options?.signal;

    let watcher: CModuleFSWatch.FsWatcher | null = null;
    let queue: Array<{ eventType: string; filename: string | null }> = [];
    let resolveNext: ((value: IteratorResult<{ eventType: string; filename: string | null }>) => void) | null = null;
    let closed = false;

    const pushEvent = (event: { eventType: string; filename: string | null }) => {
        if (closed) return;
        if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ done: false, value: event });
        } else {
            queue.push(event);
        }
    };

    const close = async () => {
        if (closed) return;
        closed = true;
        if (watcher) {
            watcher.close();
            watcher = null;
        }
        if (resolveNext) {
            resolveNext({ done: true, value: undefined });
            resolveNext = null;
        }
    };

    try {
        watcher = fswatch.watch(pathStr, (filename, event) => {
            pushEvent({ eventType: event, filename });
        }, !!options?.recursive);
    } catch {
        void close();
    }

    if (signal) {
        signal.addEventListener('abort', () => { close(); }, { once: true });
        if (signal.aborted) close();
    }

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next() {
            if (closed) return { done: true, value: undefined };
            if (queue.length > 0) {
                const value = queue.shift();
                if (value !== undefined) return { done: false, value };
            }
            return new Promise((resolve) => {
                resolveNext = resolve;
            });
        },
        async return() {
            await close();
            return { done: true, value: undefined };
        },
    } as AsyncIterableIterator<{ eventType: string; filename: string | null }>;
}

export async function cp(source: PathLike, destination: PathLike, opts?: { force?: boolean; recursive?: boolean; preserveTimestamps?: boolean; filter?: (src: string, dest: string) => boolean | Promise<boolean> }): Promise<void> {
    const srcStr = pathToString(source);
    const destStr = pathToString(destination);
    
    try {
        const stats = await w(asfs.lstat(srcStr), 'cp', srcStr);
        if (opts?.filter) {
            const shouldCopy = await opts.filter(srcStr, destStr);
            if (!shouldCopy) return;
        }

        if (stats.isDirectory) {
            await w(asfs.mkdir(destStr), 'cp', destStr);
            const dir = await w(asfs.readDir(srcStr), 'cp', srcStr);
            try {
                for await (const entry of dir) {
                    const srcPath = join(srcStr, entry.name);
                    const destPath = join(destStr, entry.name);

                    await cp(srcPath, destPath, opts);
                }
            } finally {
                await dir.close();
            }
        } else {
            const parent = dirname(destStr);
            if (parent && parent !== destStr) {
                await mkdirRecursive(parent);
            }
            await w(asfs.copyFile(srcStr, destStr), 'cp', srcStr);
        }
    } catch (err) {
        if (!opts?.force) {
            throw err;
        }
    }
}

function globToRegex(pattern: string): RegExp {
    const sep = '[/\\\\]';
    const notSep = '[^/\\\\]';
    let regex = '';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                if (pattern[i + 2] === '/' || pattern[i + 2] === '\\') {
                    regex += `(?:.*${sep})?`;
                    i += 3;
                } else {
                    regex += '.*';
                    i += 2;
                }
            } else {
                regex += notSep + '*';
                i++;
            }
        } else if (c === '?') {
            regex += notSep;
            i++;
        } else if (c === '[') {
            const j = pattern.indexOf(']', i);
            if (j === -1) {
                regex += '\\[';
                i++;
            } else {
                regex += pattern.slice(i, j + 1).replace(/\\/g, '\\\\');
                i = j + 1;
            }
        } else if (c === '{') {
            const j = pattern.indexOf('}', i);
            if (j === -1) {
                regex += '\\{';
                i++;
            } else {
                const inner = pattern.slice(i + 1, j).split(',').map(s => globToRegex(s).source).join('|');
                regex += `(?:${inner})`;
                i = j + 1;
            }
        } else if ('.+^$|()\\'.includes(c)) {
            regex += '\\' + c;
            i++;
        } else {
            regex += c;
            i++;
        }
    }
    return new RegExp('^' + regex + '$');
}

export async function* glob(pattern: string | readonly string[], options?: { cwd?: string; exclude?: string | string[]; withFileTypes?: boolean }): AsyncIterableIterator<string> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    const cwd = options?.cwd ?? '.';
    const excludes = options?.exclude ? (Array.isArray(options.exclude) ? options.exclude : [options.exclude]) : [];
    const regexes = patterns.map(p => globToRegex(p));
    const excludeRegexes = excludes.map(p => globToRegex(p));

    async function lstatOrNull(path: string): Promise<CModuleAsyncFS.StatResult | null> {
        try {
            return await w(asfs.lstat(path), 'lstat', path);
        } catch {
            return null;
        }
    }

    async function* walk(dir: string): AsyncIterableIterator<string> {
        let entries: string[];
        try {
            const dirIter = await w(asfs.readDir(dir), 'readdir', dir);
            entries = [];
            for await (const entry of dirIter) {
                entries.push(entry.name);
            }
        }
        catch { return; }
        for (const name of entries) {
            const full = join(dir, name);
            let rel = full.slice(cwd.length + 1);
            const stat = await lstatOrNull(full);
            if (!stat) continue;
            if (excludeRegexes.some(r => r.test(rel))) continue;
            if (regexes.some(r => r.test(rel))) yield rel;
            if (stat.isDirectory) yield* walk(full);
        }
    }

    yield* walk(cwd);
}

// Export constants
export { constants } from './constants';
