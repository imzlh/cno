/**
 * Node.js fs.promises API
 */

const asfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');
import { FileHandle } from 'fs/promises';
import { toUint8Array, decodeBuffer, toNodeStatAsync, toNodeDirentAsync, parseFlags, pathToString, removeRecursive, mkdirRecursive } from './utils';
import { toErrnoException, wrapPromise } from '../_internal/errno';

// 辅助：包装 asyncfs 调用，自动转换 errno → ErrnoException
function w<T>(promise: Promise<T>, syscall: string, path: string): Promise<T> {
    return wrapPromise(promise, syscall, path);
}
import { StatFsOptions, Stats } from 'fs';

// ============================================================================
// 类型定义
// ============================================================================

type PathLike = string | URL | Buffer;
type TimeLike = string | number | Date;
type Mode = number | string;

function modeToNumber(mode?: Mode): number | undefined {
    if (typeof mode === 'string') {
        return parseInt(mode, 8);
    }
    return mode;
}

function timeToNumber(time: TimeLike): number {
    if (typeof time === 'number') return time;
    if (typeof time === 'string') return new Date(time).getTime();
    return time.getTime();
}

// ============================================================================
// FileHandle 实现
// ============================================================================

class FileHandleImpl implements FileHandle {
    constructor(
        public fd: number,
        private handle: CModuleAsyncFS.FileHandle
    ) {}

    async read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    async read(options?: { buffer?: Uint8Array; offset?: number; length?: number; position?: number | null }): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    async read(...args: any[]): Promise<{ bytesRead: number; buffer: Uint8Array }> {
        if (args.length === 1 && typeof args[0] === 'object') {
            const { buffer = new Uint8Array(16384), offset = 0, length = buffer.length, position = null } = args[0];
            const bytesRead = await this.handle.read(buffer.subarray(offset, offset + length), position);
            return { bytesRead, buffer };
        }

        const [buffer, offset = 0, length = buffer.length, position = null] = args;
        const bytesRead = await this.handle.read(buffer.subarray(offset, offset + length), position);
        return { bytesRead, buffer };
    }

    async write(buffer: Uint8Array | string, offset?: any, length?: any, position?: number | null): Promise<{ bytesWritten: number; buffer: any }> {
        const data = typeof buffer === 'string' ? toUint8Array(buffer) : buffer;
        const actualOffset = typeof offset === 'number' ? offset : 0;
        const actualLength = typeof length === 'number' ? length : data.length - actualOffset;
        const bytesWritten = await this.handle.write(
            data.subarray(actualOffset, actualOffset + actualLength) as Uint8Array<ArrayBuffer>, 
            position ?? null
        );
        return { bytesWritten, buffer: data };
    }

    async close(): Promise<void> {
        await this.handle.close();
    }

    // @ts-ignore
    async stat(ops: StatFsOptions = {}): Promise<Stats> {
        if (ops.bigint) throw new Error('bigint option is not supported');
        const st = await this.handle.stat();
        return toNodeStatAsync(st);
    }

    async sync(): Promise<void> {
        await this.handle.sync();
    }

    async datasync(): Promise<void> {
        await this.handle.datasync();
    }

    async truncate(len?: number): Promise<void> {
        await this.handle.truncate(len ?? 0);
    }

    async chmod(mode: Mode): Promise<void> {
        await this.handle.chmod(modeToNumber(mode)!);
    }

    async chown(uid: number, gid: number): Promise<void> {
        await this.handle.chown(uid, gid);
    }

    async utimes(atime: TimeLike, mtime: TimeLike): Promise<void> {
        await this.handle.utime(timeToNumber(atime) / 1000, timeToNumber(mtime) / 1000);
    }

    async appendFile(data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding): Promise<void> {
        const buffer = toUint8Array(data);
        await this.handle.write(buffer);
    }

    // @ts-ignore
    async readFile(options?: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding): Promise<string | Uint8Array> {
        const stat = await this.handle.stat();
        const buffer = new Uint8Array(stat.size);
        let offset = 0;

        while (offset < stat.size) {
            const bytesRead = await this.handle.read(buffer.subarray(offset), null);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }

        const encoding = typeof options === 'string' ? options : options?.encoding;
        return decodeBuffer(buffer, encoding);
    }

    async writeFile(data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding): Promise<void> {
        const buffer = toUint8Array(data);
        await this.handle.write(buffer);
    }

    // @ts-ignore
    readableWebStream(options?: { type?: 'bytes' }): never {
        throw new Error('readableWebStream is not implemented');
    }

    writableWebStream(options?: { type?: 'bytes' }): WritableStream<Uint8Array> {
        throw new Error('writableWebStream is not implemented');
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }
}

// ============================================================================
// 文件读写
// ============================================================================

export async function readFile(path: PathLike | number, options?: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding): Promise<string | Uint8Array> {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const buffer = await w(asfs.readFile(pathStr), 'readFile', pathStr);
    return decodeBuffer(buffer, encoding);
}

export async function writeFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' ? parseFlags(options?.flag) : 'w';
    const buffer = toUint8Array(data);

    const handle = await w(asfs.open(pathStr, flag as any, mode), 'writeFile', pathStr);
    try {
        await handle.write(buffer);
    } finally {
        await handle.close();
    }
}

export async function appendFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const buffer = toUint8Array(data);

    const handle = await w(asfs.open(pathStr, 'a', mode), 'appendFile', pathStr);
    try {
        await handle.write(buffer);
    } finally {
        await handle.close();
    }
}

// ============================================================================
// 文件状态
// ============================================================================

export async function access(path: PathLike, mode?: number): Promise<void> {
    const pathStr = pathToString(path as string | URL);
    await w(asfs.stat(pathStr), 'stat', pathStr);
}

export async function stat(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const st = await w(asfs.stat(pathToString(path as string | URL)), 'stat', pathToString(path as string | URL));
    return toNodeStatAsync(st);
}

export async function lstat(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const st = await w(asfs.lstat(pathToString(path as string | URL)), 'lstat', pathToString(path as string | URL));
    return toNodeStatAsync(st);
}

// ============================================================================
// 目录操作
// ============================================================================

export async function mkdir(path: PathLike, options?: { mode?: number; recursive?: boolean } | number): Promise<string | undefined> {
    const pathStr = pathToString(path as string | URL);
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
    const pathStr = pathToString(path as string | URL);

    if (options?.recursive) {
        await removeRecursive(pathStr);
    } else {
        await w(asfs.rmdir(pathStr), 'rmdir', pathStr);
    }
}

export async function rm(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void> {
    const pathStr = pathToString(path as string | URL);

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

export async function readdir(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding): Promise<string[] | import('fs').Dirent[]> {
    const pathStr = pathToString(path as string | URL);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;

    const dirHandle = await w(asfs.readDir(pathStr), 'readdir', pathStr);
    const entries: import('fs').Dirent[] = [];

    try {
        for await (const entry of dirHandle) {
            if (withFileTypes) {
                entries.push(toNodeDirentAsync(entry));
            } else {
                entries.push(entry.name as any);
            }
        }
    } finally {
        await dirHandle.close();
    }

    return withFileTypes ? entries : entries.map(e => (e as import('fs').Dirent).name);
}

export async function opendir(path: PathLike, options?: { encoding?: BufferEncoding; bufferSize?: number }): Promise<import('fs').Dir> {
    const pathStr = pathToString(path as string | URL);
    const dirHandle = await w(asfs.readDir(pathStr), 'readdir', pathStr);
    let closed = false;

    const dir: import('fs').Dir = {
        path: pathStr,

        async read(): Promise<import('fs').Dirent | null> {
            if (closed) return null;
            const result = await dirHandle.next();
            if (result.done) return null;
            return toNodeDirentAsync(result.value);
        },

        readSync(): import('fs').Dirent | null {
            throw new Error('readSync is not supported in async opendir');
        },

        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            await dirHandle.close();
        },

        closeSync(): void {
            throw new Error('closeSync is not supported in async opendir');
        },

        [Symbol.asyncIterator](): AsyncIterableIterator<import('fs').Dirent> {
            return {
                async next() {
                    const entry = await dir.read();
                    if (entry === null) {
                        return { done: true, value: undefined };
                    }
                    return { done: false, value: entry };
                },
                async return() {
                    await dir.close();
                    return { done: true, value: undefined };
                },
            } as AsyncIterableIterator<import('fs').Dirent>;
        },
    } as import('fs').Dir;

    return dir;
}

// ============================================================================
// 文件操作
// ============================================================================

export async function unlink(path: PathLike): Promise<void> {
    const __p = pathToString(path as string | URL);
    try { await asfs.unlink(__p); } catch (e) { throw toErrnoException(e, 'unlink', __p); }
}

export async function rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
    await w(asfs.rename(pathToString(oldPath as string | URL), pathToString(newPath as string | URL)), 'rename', pathToString(oldPath as string | URL));
}

export async function copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void> {
    await w(asfs.copyFile(pathToString(src as string | URL), pathToString(dest as string | URL)), 'copyFile', pathToString(src as string | URL));
}

export async function truncate(path: PathLike, len?: number): Promise<void> {
    const handle = await w(asfs.open(pathToString(path as string | URL), 'r+'), 'truncate', pathToString(path as string | URL));
    try {
        await handle.truncate(len ?? 0);
    } finally {
        await handle.close();
    }
}

// ============================================================================
// 链接操作
// ============================================================================

export async function link(existingPath: PathLike, newPath: PathLike): Promise<void> {
    await w(asfs.link(pathToString(existingPath as string | URL), pathToString(newPath as string | URL)), 'link', pathToString(existingPath as string | URL));
}

export async function symlink(target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction'): Promise<void> {
    const symlinkType = type === 'dir' ? asfs.SymlinkType.DIR : asfs.SymlinkType.JUNCTION;
    await w(asfs.symlink(pathToString(target as string | URL), pathToString(path as string | URL), symlinkType), 'symlink', pathToString(path as string | URL));
}

export async function readlink(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): Promise<string | Uint8Array> {
    const result = await w(asfs.readLink(pathToString(path as string | URL)), 'readlink', pathToString(path as string | URL));
    return result;
}

export async function realpath(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): Promise<string> {
    return await w(asfs.realPath(pathToString(path as string | URL)), 'realpath', pathToString(path as string | URL));
}

// ============================================================================
// 权限操作
// ============================================================================

export async function chmod(path: PathLike, mode: Mode): Promise<void> {
    await w(asfs.chmod(pathToString(path as string | URL), modeToNumber(mode)!), 'chmod', pathToString(path as string | URL));
}

export async function chown(path: PathLike, uid: number, gid: number): Promise<void> {
    await w(asfs.chown(pathToString(path as string | URL), uid, gid), 'chown', pathToString(path as string | URL));
}

export async function lchown(path: PathLike, uid: number, gid: number): Promise<void> {
    await w(asfs.lchown(pathToString(path as string | URL), uid, gid), 'lchown', pathToString(path as string | URL));
}

// ============================================================================
// 时间操作
// ============================================================================

export async function utimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
    await w(asfs.utime(pathToString(path as string | URL), timeToNumber(atime) / 1000, timeToNumber(mtime) / 1000), 'utimes', pathToString(path as string | URL));
}

export async function lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
    await w(asfs.lutime(pathToString(path as string | URL), timeToNumber(atime) / 1000, timeToNumber(mtime) / 1000), 'lutimes', pathToString(path as string | URL));
}

// ============================================================================
// statfs
// ============================================================================

export async function statfs(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').StatsFs> {
    const result = await w(asfs.statFs(pathToString(path as string | URL)), 'statfs', pathToString(path as string | URL));
    return {
        type: result.type,
        bsize: result.bsize,
        blocks: result.blocks,
        bfree: result.bfree,
        bavail: result.bavail,
        files: result.files,
        ffree: result.ffree,
    };
}

// ============================================================================
// 打开文件
// ============================================================================

export async function open(path: PathLike, flags?: string | number, mode?: Mode): Promise<FileHandleImpl> {
    const flag = parseFlags(flags);
    const modeNum = modeToNumber(mode);
    const handle = await w(asfs.open(pathToString(path as string | URL), flag as any, modeNum), 'open', pathToString(path as string | URL));
    return new FileHandleImpl(handle.fileno(), handle);
}

// ============================================================================
// 缺失的导出
// ============================================================================

export async function lchmod(path: PathLike, mode: Mode): Promise<void> {
    // lchmod 通常不被支持，简化实现
    await chmod(path, mode);
}

export async function mkdtemp(prefix: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const randomStr = Math.random().toString(36).substring(2, 10);
    const dirPath = prefix + randomStr;
    await w(asfs.mkdir(dirPath), 'mkdir', dirPath);
    return dirPath;
}

export async function mkdtempDisposable(prefix: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dirPath = await mkdtemp(prefix, options);
    return {
        path: dirPath,
        async cleanup() {
            await removeRecursive(dirPath);
        },
    };
}

export function watch(path: PathLike, options?: { persistent?: boolean; recursive?: boolean; encoding?: BufferEncoding; signal?: AbortSignal }): AsyncIterableIterator<{ eventType: string; filename: string | null }> {
    const pathStr = pathToString(path as string | URL);
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
            await watcher.close();
            watcher = null;
        }
        if (resolveNext) {
            resolveNext({ done: true, value: undefined as any });
            resolveNext = null;
        }
    };

    fswatch.watch(pathStr, (filename: string, event: string) => {
        pushEvent({ eventType: event, filename });
    }).then(w => { watcher = w; }).catch(() => { close(); });

    if (signal) {
        signal.addEventListener('abort', () => { close(); }, { once: true });
        if (signal.aborted) close();
    }

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next() {
            if (closed) return { done: true, value: undefined as any };
            if (queue.length > 0) {
                return { done: false, value: queue.shift()! };
            }
            return new Promise((resolve) => {
                resolveNext = resolve;
            });
        },
        async return() {
            await close();
            return { done: true, value: undefined as any };
        },
    } as AsyncIterableIterator<{ eventType: string; filename: string | null }>;
}

export async function cp(source: PathLike, destination: PathLike, opts?: { force?: boolean; recursive?: boolean; preserveTimestamps?: boolean; filter?: (src: string, dest: string) => boolean | Promise<boolean> }): Promise<void> {
    const srcStr = pathToString(source as string | URL);
    const destStr = pathToString(destination as string | URL);
    
    try {
        const stats = await w(asfs.lstat(srcStr), 'cp', srcStr);

        if (stats.isDirectory) {
            await w(asfs.mkdir(destStr), 'cp', destStr);
            const dir = await w(asfs.readDir(srcStr), 'cp', srcStr);
            try {
                for await (const entry of dir) {
                    const srcPath = srcStr + '/' + entry.name;
                    const destPath = destStr + '/' + entry.name;

                    if (opts?.filter) {
                        const shouldCopy = await opts.filter(srcPath, destPath);
                        if (!shouldCopy) continue;
                    }

                    await cp(srcPath, destPath, opts);
                }
            } finally {
                await dir.close();
            }
        } else {
            if (opts?.filter) {
                const shouldCopy = await opts.filter(srcStr, destStr);
                if (!shouldCopy) return;
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
    let regex = '';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                if (pattern[i + 2] === '/') {
                    regex += '(?:.*/)?';
                    i += 3;
                } else {
                    regex += '.*';
                    i += 2;
                }
            } else {
                regex += '[^/]*';
                i++;
            }
        } else if (c === '?') {
            regex += '[^/]';
            i++;
        } else if (c === '[') {
            const j = pattern.indexOf(']', i);
            if (j === -1) { regex += '\\['; i++; }
            else { regex += pattern.slice(i, j + 1).replace(/\\/g, '\\\\'); i = j + 1; }
        } else if (c === '{') {
            const j = pattern.indexOf('}', i);
            if (j === -1) { regex += '\\{'; i++; }
            else {
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

    async function* walk(dir: string): AsyncIterableIterator<string> {
        let entries: string[];
        try {
            const dirIter = await w(asfs.readDir(dir), 'readdir', dir);
            entries = [];
            for await (const entry of dirIter as any) {
                entries.push(entry.name);
            }
        }
        catch { return; }
        for (const name of entries) {
            const full = dir + '/' + name;
            const rel = full.slice(cwd.length + 1);
            let stat: any;
            try { stat = await w(asfs.lstat(full), 'lstat', full); } catch { continue; }
            if (excludeRegexes.some(r => r.test(rel))) continue;
            if (regexes.some(r => r.test(rel))) yield rel;
            if (stat.isDirectory()) yield* walk(full);
        }
    }

    yield* walk(cwd);
}

// 导出 constants
export { constants } from './constants';
