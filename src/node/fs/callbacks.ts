/**
 * Node.js fs module - callback-style API
 * All async operations support callback functions
 */
import { toUint8Array, toNodeStat, toNodeDirentAsync, parseFlags, pathToString, splitPathOrFd, describeFd, removeRecursive, mkdirRecursive, modeToNumber, timeToNumber, type PathLike, type TimeLike, type Mode } from './utils';
import { toErrnoException } from '../_internal/errno';
import { getTierLimits } from '../_internal/memory';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const asfs = import.meta.use('asyncfs');

type NoParamCallback = (err: NodeJS.ErrnoException | null) => void;

// ============================================================================
// File read/write - callback style
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

    const target = splitPathOrFd(path as PathLike | number);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if ('fd' in target) {
        try {
            const chunks: Uint8Array[] = [];
            const buf = new Uint8Array(getTierLimits().readBufSize);
            let bytesRead = 0;
            while ((bytesRead = fs.read(target.fd, buf)) > 0) {
                chunks.push(buf.slice(0, bytesRead));
            }
            const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
            const out = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                out.set(chunk, offset);
                offset += chunk.length;
            }
            const result = encoding ? engine.decodeString(out as Uint8Array<ArrayBuffer>) : Buffer.from(out);
            callback(null, result);
        } catch (err) {
            callback(toErrnoException(err, 'readFile', describeFd(target.fd)));
        }
        return;
    }

    asfs.readFile(target.path).then(
        buffer => {
            const result = encoding
                ? engine.decodeString(buffer as Uint8Array<ArrayBuffer>)
                : Buffer.from(buffer);
            callback(null, result);
        },
        err => callback(toErrnoException(err, 'readFile', target.path))
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

    const target = splitPathOrFd(path as PathLike | number);
    const mode = modeToNumber(typeof options === 'object' ? options?.mode : undefined);
    const flag = typeof options === 'object' ? parseFlags(options?.flag) : 'w';
    const buffer = toUint8Array(data);
    if ('fd' in target) {
        try {
            fs.ftruncate(target.fd, 0);
            fs.write(target.fd, buffer);
            callback(null);
        } catch (err) {
            callback(toErrnoException(err, 'writeFile', describeFd(target.fd)));
        }
        return;
    }

    asfs.open(target.path, flag, mode).then(
        handle => 
            handle.write(buffer).then(
                () => callback(null),
                err => callback(toErrnoException(err, 'writeFile', target.path))
            ).finally(() => handle.close()),
        err => callback(toErrnoException(err, 'writeFile', target.path))
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

    const target = splitPathOrFd(path as PathLike | number);
    const mode = modeToNumber(typeof options === 'object' ? options?.mode : undefined);
    const buffer = toUint8Array(data);
    if ('fd' in target) {
        try {
            fs.write(target.fd, buffer);
            callback(null);
        } catch (err) {
            callback(toErrnoException(err, 'appendFile', describeFd(target.fd)));
        }
        return;
    }

    asfs.open(target.path, 'a', mode).then(
        handle =>
            handle.write(buffer).then(
                () => callback(null),
                err => callback(toErrnoException(err, 'appendFile', target.path))
            ).finally(() => handle.close()),
        err => callback(toErrnoException(err, 'appendFile', target.path))
    );
}

// ============================================================================
// File status - callback style
// ============================================================================

export function exists(path: PathLike, callback: (exists: boolean) => void): void {
    const pathStr = pathToString(path);
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

    const pathStr = pathToString(path);
    asfs.stat(pathStr).then(
        st => callback(null, toNodeStat(st)),
        err => callback(toErrnoException(err, 'stat', pathStr))
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

    const pathStr = pathToString(path);
    asfs.lstat(pathStr).then(
        st => callback(null, toNodeStat(st)),
        err => callback(toErrnoException(err, 'lstat', pathStr))
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
    try {
        const st = fs.fstat(fd);
        callback(null, toNodeStat(st));
    } catch (err) {
        callback(toErrnoException(err, 'fstat', describeFd(fd)));
    }
}

export function access(path: PathLike, callback: NoParamCallback): void;
export function access(path: PathLike, mode: number, callback: NoParamCallback): void;
export function access(path: PathLike, mode?: any, callback?: any): void {
    if (typeof mode === 'function') {
        callback = mode;
        mode = fs.F_OK;
    }

    const pathStr = pathToString(path);
    asfs.stat(pathStr).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'access', pathStr))
    );
}

// ============================================================================
// Directory operations - callback style
// ============================================================================

export function mkdir(path: PathLike, callback: NoParamCallback): void;
export function mkdir(path: PathLike, mode: Mode | { mode?: number; recursive?: boolean }, callback: NoParamCallback): void;
export function mkdir(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path);
    const mode = modeToNumber(typeof options === 'object' ? options?.mode : options);
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        mkdirRecursive(pathStr, mode).then(() => callback(null), err => callback(toErrnoException(err, 'mkdir', pathStr)));
    } else {
        asfs.mkdir(pathStr, mode).then(() => callback(null), err => callback(toErrnoException(err, 'mkdir', pathStr)));
    }
}

export function rmdir(path: PathLike, callback: NoParamCallback): void;
export function rmdir(path: PathLike, options: { recursive?: boolean; maxRetries?: number; retryDelay?: number }, callback: NoParamCallback): void;
export function rmdir(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path);

    if (options?.recursive) {
        removeRecursive(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rmdir', pathStr)));
    } else {
        asfs.rmdir(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rmdir', pathStr)));
    }
}

export function rm(path: PathLike, callback: NoParamCallback): void;
export function rm(path: PathLike, options: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }, callback: NoParamCallback): void;
export function rm(path: PathLike, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const pathStr = pathToString(path);

    asfs.lstat(pathStr).then(
        stats => {
            if (stats.isDirectory) {
                if (options?.recursive) {
                    removeRecursive(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rm', pathStr)));
                } else {
                    asfs.rmdir(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rm', pathStr)));
                }
            } else {
                asfs.unlink(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rm', pathStr)));
            }
        },
        err => {
            if (!options?.force) {
                callback(toErrnoException(err, 'rm', pathStr));
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

    const pathStr = pathToString(path);
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
        err => callback(toErrnoException(err, 'readdir', pathStr))
    );
}

// ============================================================================
// File operations - callback style
// ============================================================================

export function unlink(path: PathLike, callback: NoParamCallback): void {
    const pathStr = pathToString(path);
    asfs.unlink(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'unlink', pathStr)));
}

export function rename(oldPath: PathLike, newPath: PathLike, callback: NoParamCallback): void {
    const oldStr = pathToString(oldPath);
    const newStr = pathToString(newPath);
    asfs.rename(oldStr, newStr).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'rename', oldStr))
    );
}

export function copyFile(src: PathLike, dest: PathLike, callback: NoParamCallback): void;
export function copyFile(src: PathLike, dest: PathLike, mode: number, callback: NoParamCallback): void;
export function copyFile(src: PathLike, dest: PathLike, mode?: any, callback?: any): void {
    if (typeof mode === 'function') {
        callback = mode;
        mode = 0;
    }

    const srcStr = pathToString(src);
    asfs.copyFile(srcStr, pathToString(dest)).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'copyFile', srcStr))
    );
}

export function truncate(path: PathLike, callback: NoParamCallback): void;
export function truncate(path: PathLike, len: number, callback: NoParamCallback): void;
export function truncate(path: PathLike, len?: any, callback?: any): void {
    if (typeof len === 'function') {
        callback = len;
        len = 0;
    }

    const pathStr = pathToString(path);
    asfs.open(pathStr, 'r+').then(
        handle => 
            handle.truncate(len ?? 0).then(
                () => callback(null),
                err => callback(toErrnoException(err, 'truncate', pathStr))
            ).finally(() => handle.close()),
        err => callback(toErrnoException(err, 'truncate', pathStr))
    );
}

export function ftruncate(fd: number, callback: NoParamCallback): void;
export function ftruncate(fd: number, len: number, callback: NoParamCallback): void;
export function ftruncate(fd: number, len?: any, callback?: any): void {
    if (typeof len === 'function') {
        callback = len;
        len = 0;
    }
    try {
        fs.ftruncate(fd, len ?? 0);
        callback(null);
    } catch (err) {
        callback(toErrnoException(err, 'ftruncate', describeFd(fd)));
    }
}

// ============================================================================
// Link operations - callback style
// ============================================================================

export function link(existingPath: PathLike, newPath: PathLike, callback: NoParamCallback): void {
    const existingStr = pathToString(existingPath);
    asfs.link(existingStr, pathToString(newPath)).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'link', existingStr))
    );
}

export function symlink(target: PathLike, path: PathLike, callback: NoParamCallback): void;
export function symlink(target: PathLike, path: PathLike, type: 'file' | 'dir' | 'junction', callback: NoParamCallback): void;
export function symlink(target: PathLike, path: PathLike, type?: any, callback?: any): void {
    if (typeof type === 'function') {
        callback = type;
        type = 'file';
    }

    const symlinkType = type === 'dir' ? asfs.SymlinkType.DIR : type === 'junction' ? asfs.SymlinkType.JUNCTION : 0 as any;
    asfs.symlink(pathToString(target), pathToString(path), symlinkType).then(
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

    asfs.readLink(pathToString(path)).then(
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

    asfs.realPath(pathToString(path)).then(
        result => callback(null, result),
        callback
    );
}

// ============================================================================
// Permission operations - callback style
// ============================================================================

export function chmod(path: PathLike, mode: Mode, callback: NoParamCallback): void {
    const pathStr = pathToString(path);
    asfs.chmod(pathStr, modeToNumber(mode)!).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'chmod', pathStr))
    );
}

export function fchmod(fd: number, mode: Mode, callback: NoParamCallback): void {
    try {
        fs.fchmod(fd, modeToNumber(mode)!);
        callback(null);
    } catch (err) {
        callback(toErrnoException(err, 'fchmod', describeFd(fd)));
    }
}

export function lchmod(path: PathLike, mode: Mode, callback: NoParamCallback): void {
    // lchmod: best-effort via chmod (C layer doesn't distinguish symlink chmod)
    const pathStr = pathToString(path);
    try {
        fs.chmod(pathStr, modeToNumber(mode)!);
        callback(null);
    } catch (err) {
        callback(toErrnoException(err, 'lchmod', pathStr));
    }
}

export function chown(path: PathLike, uid: number, gid: number, callback: NoParamCallback): void {
    const __pathStr = pathToString(path);
    asfs.chown(__pathStr, uid, gid).then(() => callback(null), err => callback(toErrnoException(err, 'chown', __pathStr)));
}

export function fchown(fd: number, uid: number, gid: number, callback: NoParamCallback): void {
    try {
        fs.fchown(fd, uid, gid);
        callback(null);
    } catch (err) {
        callback(toErrnoException(err, 'fchown', describeFd(fd)));
    }
}

export function lchown(path: PathLike, uid: number, gid: number, callback: NoParamCallback): void {
    const pathStr = pathToString(path);
    asfs.lchown(pathStr, uid, gid).then(() => callback(null), err => callback(toErrnoException(err, 'lchown', pathStr)));
}

// ============================================================================
// Time operations - callback style
// ============================================================================

export function utimes(path: PathLike, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    const pathStr = pathToString(path);
    asfs.utime(
        pathStr,
        timeToNumber(atime) / 1000,
        timeToNumber(mtime) / 1000
    ).then(() => callback(null), err => callback(toErrnoException(err, 'utimes', pathStr)));
}

export function futimes(fd: number, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    try {
        fs.futimes(fd, timeToNumber(atime) / 1000, timeToNumber(mtime) / 1000);
        callback(null);
    } catch (err) {
        callback(toErrnoException(err, 'futimes', describeFd(fd)));
    }
}

export function lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    const pathStr = pathToString(path);
    asfs.lutime(
        pathStr,
        timeToNumber(atime) / 1000,
        timeToNumber(mtime) / 1000
    ).then(() => callback(null), err => callback(toErrnoException(err, 'lutimes', pathStr)));
}

// ============================================================================
// File descriptor operations - callback style
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

    const pathStr = pathToString(path);
    asfs.open(pathStr, parseFlags(flags), modeToNumber(mode)).then(
        handle => callback(null, handle.fileno()),
        err => callback(toErrnoException(err, 'open', pathStr))
    );
}

export function close(fd: number, callback: NoParamCallback): void {
    try {
        fs.close(fd);
        callback(null);
    } catch (err) {
        callback(toErrnoException(err, 'close', describeFd(fd)));
    }
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
            bytesRead = fs.pread(fd, buffer.subarray(offset, offset + length), position);
        } else {
            bytesRead = fs.read(fd, buffer.subarray(offset, offset + length));
        }
        callback(null, bytesRead, buffer);
    } catch (err) {
        callback(toErrnoException(err, 'read', describeFd(fd)), 0, buffer);
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
        callback(toErrnoException(err, 'write', describeFd(fd)), 0, buffer);
    }
}

export function fsync(fd: number, callback: NoParamCallback): void {
    try {
        fs.fsync(fd);
        callback(null);
    } catch (err) {
        callback(toErrnoException(err, 'fsync', describeFd(fd)));
    }
}

export function fdatasync(fd: number, callback: NoParamCallback): void {
    try {
        fs.fdatasync(fd);
        callback(null);
    } catch (err) {
        callback(toErrnoException(err, 'fdatasync', describeFd(fd)));
    }
}

// ============================================================================
// statfs - callback style
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

    const pathStr = pathToString(path);
    asfs.statFs(pathStr).then(
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
        err => callback(toErrnoException(err, 'statfs', pathStr))
    );
}

// ============================================================================
// opendir - callback style
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

    const pathStr = pathToString(path);
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
        err => callback(toErrnoException(err, 'opendir', pathStr))
    );
}
