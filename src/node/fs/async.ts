/**
 * Node.js fs module - async operations
 */

const fs = import.meta.use('fs');
const asfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');
import { toUint8Array, decodeBuffer, toNodeStatAsync, toNodeDirentAsync, parseFlags, pathToString, splitPathOrFd, removeRecursive, mkdirRecursive, readFileFromFdSync, createFileHandle, type PathLike } from './utils';
import { getTierLimits } from '../_internal/memory';

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

// ============================================================================
// File read/write
// ============================================================================

export async function readFile(path: PathLike | number, options?: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding): Promise<string | Uint8Array> {
    const target = splitPathOrFd(path as PathLike | number);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const buffer = 'fd' in target
        ? readFileFromFdSync(fs.read, target.fd, READ_BUF_SIZE)
        : await asfs.readFile(target.path);
    return decodeBuffer(buffer, encoding);
}

export async function writeFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: number | string; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const target = splitPathOrFd(path as PathLike | number);
    const mode = typeof options === 'object' ? (typeof options?.mode === 'string' ? parseInt(options.mode, 8) : options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' ? parseFlags(options?.flag) : 'w';
    const buffer = toUint8Array(data);

    if ('fd' in target) {
        fs.ftruncate(target.fd, 0);
        fs.write(target.fd, buffer);
        return;
    }

    const handle = await asfs.open(target.path, flag, mode);
    try {
        await handle.write(buffer);
    } finally {
        await handle.close();
    }
}

export async function appendFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: number | string; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const target = splitPathOrFd(path as PathLike | number);
    const mode = typeof options === 'object' ? (typeof options?.mode === 'string' ? parseInt(options.mode, 8) : options?.mode) : typeof options === 'number' ? options : undefined;
    const buffer = toUint8Array(data);

    if ('fd' in target) {
        fs.write(target.fd, buffer);
        return;
    }

    const handle = await asfs.open(target.path, 'a', mode);
    try {
        await handle.write(buffer);
    } finally {
        await handle.close();
    }
}

// ============================================================================
// File status
// ============================================================================

export async function exists(path: PathLike): Promise<boolean> {
    try {
        await asfs.stat(pathToString(path));
        return true;
    } catch {
        return false;
    }
}

export async function stat(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const st = await asfs.stat(pathToString(path));
    return toNodeStatAsync(st);
}

export async function lstat(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const st = await asfs.lstat(pathToString(path));
    return toNodeStatAsync(st);
}

export async function access(path: PathLike, mode?: number): Promise<void> {
    // asyncfs has no access, simulate with stat
    const pathStr = pathToString(path);
    await asfs.stat(pathStr);
}

// ============================================================================
// Directory operations
// ============================================================================

export async function mkdir(path: PathLike, options?: { mode?: number; recursive?: boolean } | number): Promise<string | undefined> {
    const pathStr = pathToString(path);
    const mode = typeof options === 'number' ? options : options?.mode;
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        await mkdirRecursive(pathStr, mode);
        return pathStr;
    }

    await asfs.mkdir(pathStr, mode);
    return undefined;
}

export async function rmdir(path: PathLike, options?: { recursive?: boolean }): Promise<void> {
    const pathStr = pathToString(path);

    if (options?.recursive) {
        await removeRecursive(pathStr);
    } else {
        await asfs.rmdir(pathStr);
    }
}

export async function rm(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void> {
    const pathStr = pathToString(path);

    try {
        const stats = await asfs.lstat(pathStr);

        if (stats.isDirectory) {
            if (options?.recursive) {
                await removeRecursive(pathStr);
            } else {
                await asfs.rmdir(pathStr);
            }
        } else {
            await asfs.unlink(pathStr);
        }
    } catch (err) {
        if (!options?.force) {
            throw err;
        }
    }
}

export async function readdir(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding): Promise<string[] | import('fs').Dirent[]> {
    const pathStr = pathToString(path);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;

    const dirHandle = await asfs.readDir(pathStr);
    const entries: import('fs').Dirent[] = [];
    const names: string[] = [];

    try {
        for await (const entry of dirHandle) {
            if (withFileTypes) {
                entries.push(toNodeDirentAsync(entry));
            } else {
                names.push(entry.name);
            }
        }
    } finally {
        await dirHandle.close();
    }

    return withFileTypes ? entries : names;
}

export async function opendir(path: PathLike, options?: { encoding?: BufferEncoding; bufferSize?: number }): Promise<import('fs').Dir> {
    const pathStr = pathToString(path);
    const dirHandle = await asfs.readDir(pathStr);
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
// File operations
// ============================================================================

export async function unlink(path: PathLike): Promise<void> {
    await asfs.unlink(pathToString(path));
}

export async function rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
    await asfs.rename(pathToString(oldPath), pathToString(newPath));
}

export async function copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void> {
    await asfs.copyFile(pathToString(src), pathToString(dest));
}

export async function truncate(path: PathLike, len?: number): Promise<void> {
    const handle = await asfs.open(pathToString(path), 'r+');
    try {
        await handle.truncate(len ?? 0);
    } finally {
        await handle.close();
    }
}

// ============================================================================
// Link operations
// ============================================================================

export async function link(existingPath: PathLike, newPath: PathLike): Promise<void> {
    await asfs.link(pathToString(existingPath), pathToString(newPath));
}

export async function symlink(target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction'): Promise<void> {
    const symlinkType = type === 'dir' ? asfs.SymlinkType.DIR : type === 'junction' ? asfs.SymlinkType.JUNCTION : 0 as any;
    await asfs.symlink(pathToString(target), pathToString(path), symlinkType);
}

export async function readlink(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): Promise<string | Uint8Array> {
    const result = await asfs.readLink(pathToString(path));
    return result;
}

export async function realpath(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): Promise<string> {
    return await asfs.realPath(pathToString(path));
}

// ============================================================================
// Permission operations
// ============================================================================

export async function chmod(path: PathLike, mode: number | string): Promise<void> {
    const modeNum = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    await asfs.chmod(pathToString(path), modeNum);
}

export async function chown(path: PathLike, uid: number, gid: number): Promise<void> {
    await asfs.chown(pathToString(path), uid, gid);
}

// ============================================================================
// Time operations
// ============================================================================

export async function utimes(path: PathLike, atime: number | Date | string, mtime: number | Date | string): Promise<void> {
    const atimeMs = typeof atime === 'number' ? atime : typeof atime === 'string' ? new Date(atime).getTime() : atime.getTime();
    const mtimeMs = typeof mtime === 'number' ? mtime : typeof mtime === 'string' ? new Date(mtime).getTime() : mtime.getTime();
    await asfs.utime(pathToString(path), atimeMs / 1000, mtimeMs / 1000);
}

// ============================================================================
// Open file
// ============================================================================

export async function open(path: PathLike, flags?: string | number, mode?: number | string) {
    const flag = parseFlags(flags);
    const modeNum = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    const handle = await asfs.open(pathToString(path), flag, modeNum);
    return createFileHandle(handle.fileno(), handle);
}
