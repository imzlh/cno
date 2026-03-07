/**
 * Node.js fs 模块 - 回调风格 API
 * 所有异步操作都支持回调函数
 */

const fs = import.meta.use('fs');
const asfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');
import { toUint8Array, decodeBuffer, toNodeStat, toNodeStatAsync, toNodeDirent, toNodeDirentAsync, parseFlags, pathToString, removeRecursiveSync, removeRecursive, mkdirRecursiveSync, mkdirRecursive } from './utils';

// ============================================================================
// 类型定义
// ============================================================================

type PathLike = string | URL | Buffer;
type TimeLike = string | number | Date;
type Mode = number | string;
type NoParamCallback = (err: NodeJS.ErrnoException | null) => void;

// ============================================================================
// 辅助函数
// ============================================================================

function callbackify<T>(promise: Promise<T>, callback: (err: NodeJS.ErrnoException | null, result?: T) => void): void {
    promise.then(
        result => callback(null, result),
        err => callback(err)
    );
}

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
// 文件读写 - 回调风格
// ============================================================================

export function readFile(
    path: PathLike | number,
    options: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding | null,
    callback: (err: NodeJS.ErrnoException | null, data: string | Buffer) => void
): void;
export function readFile(path: PathLike | number, callback: (err: NodeJS.ErrnoException | null, data: Buffer) => void): void;
export function readFile(path: PathLike | number, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const encoding = typeof options === 'string' ? options : options?.encoding;

    asfs.readFile(pathStr).then(
        buffer => {
            const result = encoding
                ? engine.decodeString(buffer as Uint8Array<ArrayBuffer>) 
                : Buffer.from(buffer);
            callback(null, result);
        },
        err => callback(err)
    );
}

export function writeFile(
    path: PathLike | number,
    data: string | Uint8Array | ArrayBuffer,
    options: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | null,
    callback: NoParamCallback
): void;
export function writeFile(
    path: PathLike | number,
    data: string | Uint8Array | ArrayBuffer,
    callback: NoParamCallback
): void;
export function writeFile(path: PathLike | number, data: any, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const mode = modeToNumber(typeof options === 'object' ? options?.mode : undefined);
    const flag = typeof options === 'object' ? parseFlags(options?.flag) : 'w';
    const buffer = toUint8Array(data);

    asfs.open(pathStr, flag as any, mode).then(
        handle => {
            handle.write(buffer).then(
                () => handle.close().then(() => callback(null), callback),
                err => handle.close().then(() => callback(err), () => callback(err))
            );
        },
        callback
    );
}

export function appendFile(
    path: PathLike | number,
    data: string | Uint8Array | ArrayBuffer,
    options: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | null,
    callback: NoParamCallback
): void;
export function appendFile(
    path: PathLike | number,
    data: string | Uint8Array | ArrayBuffer,
    callback: NoParamCallback
): void;
export function appendFile(path: PathLike | number, data: any, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const mode = modeToNumber(typeof options === 'object' ? options?.mode : undefined);
    const buffer = toUint8Array(data);

    asfs.open(pathStr, 'a', mode).then(
        handle => {
            handle.write(buffer).then(
                () => handle.close().then(() => callback(null), callback),
                err => handle.close().then(() => callback(err), () => callback(err))
            );
        },
        callback
    );
}

// ============================================================================
// 文件状态 - 回调风格
// ============================================================================

export function exists(path: PathLike, callback: (exists: boolean) => void): void {
    const pathStr = pathToString(path as string | URL);
    asfs.stat(pathStr).then(
        () => callback(true),
        () => callback(false)
    );
}

export function stat(path: PathLike, callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void): void;
export function stat(
    path: PathLike,
    options: { bigint?: boolean; throwIfNoEntry?: boolean },
    callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void
): void;
export function stat(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path as string | URL);
    asfs.stat(pathStr).then(
        st => callback(null, toNodeStatAsync(st)),
        callback
    );
}

export function lstat(path: PathLike, callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void): void;
export function lstat(
    path: PathLike,
    options: { bigint?: boolean; throwIfNoEntry?: boolean },
    callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void
): void;
export function lstat(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path as string | URL);
    asfs.lstat(pathStr).then(
        st => callback(null, toNodeStatAsync(st)),
        callback
    );
}

export function fstat(fd: number, callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void): void;
export function fstat(
    fd: number,
    options: { bigint?: boolean },
    callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void
): void;
export function fstat(fd: number, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    callback(new Error('fstat is not supported'));
}

export function access(path: PathLike, callback: NoParamCallback): void;
export function access(path: PathLike, mode: number, callback: NoParamCallback): void;
export function access(path: PathLike, mode?: any, callback?: any): void {
    if (typeof mode === 'function') {
        callback = mode;
        mode = fs.F_OK;
    }

    const pathStr = pathToString(path as string | URL);
    asfs.stat(pathStr).then(
        () => callback(null),
        callback
    );
}

// ============================================================================
// 目录操作 - 回调风格
// ============================================================================

export function mkdir(path: PathLike, callback: NoParamCallback): void;
export function mkdir(path: PathLike, mode: Mode | { mode?: number; recursive?: boolean }, callback: NoParamCallback): void;
export function mkdir(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path as string | URL);
    const mode = modeToNumber(typeof options === 'object' ? options?.mode : options);
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        mkdirRecursive(pathStr, mode).then(() => callback(null), callback);
    } else {
        asfs.mkdir(pathStr, mode).then(() => callback(null), callback);
    }
}

export function rmdir(path: PathLike, callback: NoParamCallback): void;
export function rmdir(path: PathLike, options: { recursive?: boolean; maxRetries?: number; retryDelay?: number }, callback: NoParamCallback): void;
export function rmdir(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path as string | URL);

    if (options?.recursive) {
        removeRecursive(pathStr).then(() => callback(null), callback);
    } else {
        asfs.rmdir(pathStr).then(() => callback(null), callback);
    }
}

export function rm(path: PathLike, callback: NoParamCallback): void;
export function rm(path: PathLike, options: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }, callback: NoParamCallback): void;
export function rm(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path as string | URL);

    asfs.lstat(pathStr).then(
        stats => {
            if (stats.isDirectory) {
                if (options?.recursive) {
                    removeRecursive(pathStr).then(() => callback(null), callback);
                } else {
                    asfs.rmdir(pathStr).then(() => callback(null), callback);
                }
            } else {
                asfs.unlink(pathStr).then(() => callback(null), callback);
            }
        },
        err => {
            if (!options?.force) {
                callback(err);
            } else {
                callback(null);
            }
        }
    );
}

export function readdir(
    path: PathLike,
    callback: (err: NodeJS.ErrnoException | null, files: string[]) => void
): void;
export function readdir(
    path: PathLike,
    options: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding,
    callback: (err: NodeJS.ErrnoException | null, files: string[] | import('fs').Dirent[]) => void
): void;
export function readdir(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path as string | URL);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;

    asfs.readDir(pathStr).then(
        async dirHandle => {
            const entries: any[] = [];
            try {
                for await (const entry of dirHandle) {
                    if (withFileTypes) {
                        entries.push(toNodeDirentAsync(entry));
                    } else {
                        entries.push(entry.name);
                    }
                }
                callback(null, entries);
            } finally {
                await dirHandle.close();
            }
        },
        callback
    );
}

// ============================================================================
// 文件操作 - 回调风格
// ============================================================================

export function unlink(path: PathLike, callback: NoParamCallback): void {
    const pathStr = pathToString(path as string | URL);
    asfs.unlink(pathStr).then(() => callback(null), callback);
}

export function rename(oldPath: PathLike, newPath: PathLike, callback: NoParamCallback): void {
    asfs.rename(pathToString(oldPath as string | URL), pathToString(newPath as string | URL)).then(
        () => callback(null),
        callback
    );
}

export function copyFile(src: PathLike, dest: PathLike, callback: NoParamCallback): void;
export function copyFile(src: PathLike, dest: PathLike, mode: number, callback: NoParamCallback): void;
export function copyFile(src: PathLike, dest: PathLike, mode?: any, callback?: any): void {
    if (typeof mode === 'function') {
        callback = mode;
        mode = 0;
    }

    asfs.copyFile(pathToString(src as string | URL), pathToString(dest as string | URL)).then(
        () => callback(null),
        callback
    );
}

export function truncate(path: PathLike, callback: NoParamCallback): void;
export function truncate(path: PathLike, len: number, callback: NoParamCallback): void;
export function truncate(path: PathLike, len?: any, callback?: any): void {
    if (typeof len === 'function') {
        callback = len;
        len = 0;
    }

    const pathStr = pathToString(path as string | URL);
    asfs.open(pathStr, 'r+').then(
        handle => {
            handle.truncate(len ?? 0).then(
                () => handle.close().then(() => callback(null), callback),
                err => handle.close().then(() => callback(err), () => callback(err))
            );
        },
        callback
    );
}

export function ftruncate(fd: number, callback: NoParamCallback): void;
export function ftruncate(fd: number, len: number, callback: NoParamCallback): void;
export function ftruncate(fd: number, len?: any, callback?: any): void {
    if (typeof len === 'function') {
        callback = len;
        len = 0;
    }
    fs.ftruncate(fd, len ?? 0);
    callback(null);
}

// ============================================================================
// 链接操作 - 回调风格
// ============================================================================

export function link(existingPath: PathLike, newPath: PathLike, callback: NoParamCallback): void {
    asfs.link(pathToString(existingPath as string | URL), pathToString(newPath as string | URL)).then(
        () => callback(null),
        callback
    );
}

export function symlink(target: PathLike, path: PathLike, callback: NoParamCallback): void;
export function symlink(target: PathLike, path: PathLike, type: 'file' | 'dir' | 'junction', callback: NoParamCallback): void;
export function symlink(target: PathLike, path: PathLike, type?: any, callback?: any): void {
    if (typeof type === 'function') {
        callback = type;
        type = 'file';
    }

    const symlinkType = type === 'dir' ? asfs.SymlinkType.DIR : asfs.SymlinkType.JUNCTION;
    asfs.symlink(pathToString(target as string | URL), pathToString(path as string | URL), symlinkType).then(
        () => callback(null),
        callback
    );
}

export function readlink(
    path: PathLike,
    callback: (err: NodeJS.ErrnoException | null, linkString: string) => void
): void;
export function readlink(
    path: PathLike,
    options: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding,
    callback: (err: NodeJS.ErrnoException | null, linkString: string | Buffer) => void
): void;
export function readlink(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    asfs.readLink(pathToString(path as string | URL)).then(
        result => callback(null, result),
        callback
    );
}

export function realpath(
    path: PathLike,
    callback: (err: NodeJS.ErrnoException | null, resolvedPath: string) => void
): void;
export function realpath(
    path: PathLike,
    options: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding,
    callback: (err: NodeJS.ErrnoException | null, resolvedPath: string | Buffer) => void
): void;
export function realpath(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    asfs.realPath(pathToString(path as string | URL)).then(
        result => callback(null, result),
        callback
    );
}

// ============================================================================
// 权限操作 - 回调风格
// ============================================================================

export function chmod(path: PathLike, mode: Mode, callback: NoParamCallback): void {
    asfs.chmod(pathToString(path as string | URL), modeToNumber(mode)!).then(
        () => callback(null),
        callback
    );
}

export function fchmod(fd: number, mode: Mode, callback: NoParamCallback): void {
    fs.fchmod(fd, modeToNumber(mode)!);
    callback(null);
}

export function lchmod(path: PathLike, mode: Mode, callback: NoParamCallback): void {
    // lchmod 只在 macOS 上实现
    callback(new Error('lchmod is not supported'));
}

export function chown(path: PathLike, uid: number, gid: number, callback: NoParamCallback): void {
    asfs.chown(pathToString(path as string | URL), uid, gid).then(() => callback(null), callback);
}

export function fchown(fd: number, uid: number, gid: number, callback: NoParamCallback): void {
    fs.fchown(fd, uid, gid);
    callback(null);
}

export function lchown(path: PathLike, uid: number, gid: number, callback: NoParamCallback): void {
    asfs.lchown(pathToString(path as string | URL), uid, gid).then(() => callback(null), callback);
}

// ============================================================================
// 时间操作 - 回调风格
// ============================================================================

export function utimes(path: PathLike, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    asfs.utime(
        pathToString(path as string | URL),
        timeToNumber(atime) / 1000,
        timeToNumber(mtime) / 1000
    ).then(() => callback(null), callback);
}

export function futimes(fd: number, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    callback(new Error('futimes is not supported'));
}

export function lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    asfs.lutime(
        pathToString(path as string | URL),
        timeToNumber(atime) / 1000,
        timeToNumber(mtime) / 1000
    ).then(() => callback(null), callback);
}

// ============================================================================
// 文件描述符操作 - 回调风格
// ============================================================================

export function open(path: PathLike, callback: (err: NodeJS.ErrnoException | null, fd: number) => void): void;
export function open(path: PathLike, flags: string | number, callback: (err: NodeJS.ErrnoException | null, fd: number) => void): void;
export function open(path: PathLike, flags: string | number, mode: Mode, callback: (err: NodeJS.ErrnoException | null, fd: number) => void): void;
export function open(path: PathLike, flags?: any, mode?: any, callback?: any): void {
    if (typeof flags === 'function') {
        callback = flags;
        flags = 'r';
        mode = 0o666;
    } else if (typeof mode === 'function') {
        callback = mode;
        mode = 0o666;
    }

    const pathStr = pathToString(path as string | URL);
    asfs.open(pathStr, parseFlags(flags) as any, modeToNumber(mode)).then(
        handle => callback(null, handle.fileno()),
        callback
    );
}

export function close(fd: number, callback: NoParamCallback): void {
    fs.close(fd);
    callback(null);
}

export function read(
    fd: number,
    buffer: Buffer<ArrayBuffer> | Uint8Array<ArrayBuffer>,
    offset: number,
    length: number,
    position: number | null,
    callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer | Uint8Array) => void
): void {
    try {
        let bytesRead: number;
        if (position !== null && position !== undefined) {
            bytesRead = fs.pread(fd, buffer.subarray(offset, offset + length) as any, position);
        } else {
            bytesRead = fs.read(fd, buffer.subarray(offset, offset + length) as any);
        }
        callback(null, bytesRead, buffer);
    } catch (err) {
        callback(err as NodeJS.ErrnoException, 0, buffer);
    }
}

export function write(
    fd: number,
    buffer: Buffer | Uint8Array | string,
    offset: number,
    length: number,
    position: number | null,
    callback: (err: NodeJS.ErrnoException | null, written: number, buffer: Buffer | Uint8Array | string) => void
): void;
export function write(
    fd: number,
    buffer: Buffer | Uint8Array | string,
    callback: (err: NodeJS.ErrnoException | null, written: number, buffer: Buffer | Uint8Array | string) => void
): void;
export function write(fd: number, buffer: any, offset?: any, length?: any, position?: any, callback?: any): void {
    if (typeof offset === 'function') {
        callback = offset;
        offset = 0;
        length = buffer.length;
        position = null;
    } else if (typeof length === 'function') {
        callback = length;
        length = buffer.length - offset;
        position = null;
    } else if (typeof position === 'function') {
        callback = position;
        position = null;
    }

    try {
        const data = typeof buffer === 'string' ? toUint8Array(buffer) : buffer;
        let written: number;
        if (position !== null && position !== undefined) {
            written = fs.pwrite(fd, data.subarray(offset, offset + length), position);
        } else {
            written = fs.write(fd, data.subarray(offset, offset + length));
        }
        callback(null, written, buffer);
    } catch (err) {
        callback(err as NodeJS.ErrnoException, 0, buffer);
    }
}

export function fsync(fd: number, callback: NoParamCallback): void {
    fs.fsync(fd);
    callback(null);
}

export function fdatasync(fd: number, callback: NoParamCallback): void {
    fs.fdatasync(fd);
    callback(null);
}

// ============================================================================
// statfs - 回调风格
// ============================================================================

export function statfs(path: PathLike, callback: (err: NodeJS.ErrnoException | null, stats: import('fs').StatsFs) => void): void;
export function statfs(
    path: PathLike,
    options: { bigint?: boolean },
    callback: (err: NodeJS.ErrnoException | null, stats: import('fs').StatsFs) => void
): void;
export function statfs(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    asfs.statFs(pathToString(path as string | URL)).then(
        result => {
            callback(null, {
                type: result.type,
                bsize: result.bsize,
                blocks: result.blocks,
                bfree: result.bfree,
                bavail: result.bavail,
                files: result.files,
                ffree: result.ffree,
            });
        },
        callback
    );
}

// ============================================================================
// opendir - 回调风格
// ============================================================================

export function opendir(path: PathLike, callback: (err: NodeJS.ErrnoException | null, dir: import('fs').Dir) => void): void;
export function opendir(
    path: PathLike,
    options: { encoding?: BufferEncoding; bufferSize?: number },
    callback: (err: NodeJS.ErrnoException | null, dir: import('fs').Dir) => void
): void;
export function opendir(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path as string | URL);
    asfs.readDir(pathStr).then(
        dirHandle => {
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

            callback(null, dir);
        },
        callback
    );
}
