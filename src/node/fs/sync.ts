/**
 * Node.js fs module - sync operations
 */

const fs = import.meta.use('fs');
import { toUint8Array, decodeBuffer, toNodeStat, toNodeDirent, parseFlags, pathToString, splitPathOrFd, describeFd, removeRecursiveSync, mkdirRecursiveSync, modeToNumber, timeToNumber, readFileFromFdSync, randomHex, type PathLike, type TimeLike, type Mode } from './utils';
import { wrapSync } from '../_internal/errno';
import { getTierLimits } from '../_internal/memory';
import path from '../path';
const { join } = path;

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

// ============================================================================
// File read/write
// ============================================================================

export function readFileSync(path: PathLike | number, options?: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding): string | Uint8Array {
    const target = splitPathOrFd(path as PathLike | number);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const buffer = 'fd' in target
        ? wrapSync(() => readFileFromFdSync(fs.read, target.fd, READ_BUF_SIZE), 'readFileSync', describeFd(target.fd))
        : wrapSync(() => new Uint8Array(fs.readFile(target.path)), 'readFileSync', target.path);
    return decodeBuffer(buffer, encoding);
}

export function writeFileSync(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): void {
    const target = splitPathOrFd(path as PathLike | number);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const buffer = toUint8Array(data);
    if ('fd' in target) {
        wrapSync(() => {
            fs.ftruncate(target.fd, 0);
            fs.write(target.fd, buffer);
        }, 'writeFileSync', describeFd(target.fd));
        return;
    }
    wrapSync(() => fs.writeFile(target.path, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), mode), 'writeFileSync', target.path);
}

export function appendFileSync(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): void {
    const target = splitPathOrFd(path as PathLike | number);
    wrapSync(() => {
        const fd = 'fd' in target ? target.fd : fs.open(target.path, 'a');
        try {
            const buffer = toUint8Array(data);
            fs.write(fd, buffer);
        } finally {
            if (!('fd' in target)) fs.close(fd);
        }
    }, 'appendFileSync', 'fd' in target ? describeFd(target.fd) : target.path);
}

// ============================================================================
// File status
// ============================================================================

export function existsSync(path: PathLike): boolean {
    const pathStr = pathToString(path);
    return wrapSync(() => fs.exists(pathStr), 'existsSync', pathStr);
}

export function statSync(path: PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }): import('fs').Stats {
    const pathStr = pathToString(path);
    const st = wrapSync(() => fs.stat(pathStr), 'statSync', pathStr);
    return toNodeStat(st);
}

export function lstatSync(path: PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }): import('fs').Stats {
    const pathStr = pathToString(path);
    const st = wrapSync(() => fs.lstat(pathStr), 'lstatSync', pathStr);
    return toNodeStat(st);
}

export function fstatSync(fd: number, options?: { bigint?: boolean }): import('fs').Stats {
    const st = wrapSync(() => fs.fstat(fd), 'fstatSync', describeFd(fd));
    return toNodeStat(st);
}

export function accessSync(path: PathLike, mode?: number): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.access(pathStr, mode ?? fs.F_OK), 'accessSync', pathStr);
}

// ============================================================================
// Directory operations
// ============================================================================

export function mkdirSync(path: PathLike, options?: { mode?: number; recursive?: boolean } | number): string | undefined {
    const pathStr = pathToString(path);
    const mode = typeof options === 'number' ? options : options?.mode;
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        mkdirRecursiveSync(pathStr, mode);
        return pathStr;
    }

    wrapSync(() => fs.mkdir(pathStr, mode), 'mkdirSync', pathStr);
    return undefined;
}

export function rmdirSync(path: PathLike, options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number }): void {
    const pathStr = pathToString(path);

    if (options?.recursive) {
        removeRecursiveSync(pathStr);
    } else {
        wrapSync(() => fs.rmdir(pathStr), 'rmdirSync', pathStr);
    }
}

export function rmSync(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): void {
    const pathStr = pathToString(path);

    try {
        const stats = wrapSync(() => fs.lstat(pathStr), 'rmSync', pathStr);

        if (stats.isDirectory) {
            if (options?.recursive) {
                removeRecursiveSync(pathStr);
            } else {
                wrapSync(() => fs.rmdir(pathStr), 'rmSync', pathStr);
            }
        } else {
            wrapSync(() => fs.unlink(pathStr), 'rmSync', pathStr);
        }
    } catch (err) {
        if (!options?.force) {
            throw err;
        }
    }
}

export function readdirSync(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding): string[] | import('fs').Dirent[] {
    const pathStr = pathToString(path);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;
    const entries = withFileTypes
        ? wrapSync(() => fs.readdir(pathStr, true), 'readdirSync', pathStr)
        : wrapSync(() => fs.readdir(pathStr), 'readdirSync', pathStr);

    if (withFileTypes) {
        return (entries as CModuleFS.DirEnt[]).map(entry => {
            return toNodeDirent(entry.name, entry);
        });
    }

    return entries as string[];
}

export function opendirSync(path: PathLike, options?: { encoding?: BufferEncoding; bufferSize?: number }): import('fs').Dir {
    const pathStr = pathToString(path);
    const entries = fs.readdir(pathStr, true);
    let index = 0;

    const dir: import('fs').Dir = {
        path: pathStr,

        async read(): Promise<import('fs').Dirent | null> {
            if (index >= entries.length) return null;
            const entry = entries[index++]!;
            return toNodeDirent(entry.name, entry);
        },

        readSync(): import('fs').Dirent | null {
            if (index >= entries.length) return null;
            const entry = entries[index++]!;
            return toNodeDirent(entry.name, entry);
        },

        async close(): Promise<void> {},

        closeSync(): void {},

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

export function unlinkSync(path: PathLike): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.unlink(pathStr), 'unlinkSync', pathStr);
}

export function renameSync(oldPath: PathLike, newPath: PathLike): void {
    const oldStr = pathToString(oldPath);
    const newStr = pathToString(newPath);
    wrapSync(() => fs.rename(oldStr, newStr), 'renameSync', oldStr);
}

export function copyFileSync(src: PathLike, dest: PathLike, mode?: number): void {
    const srcStr = pathToString(src);
    wrapSync(() => fs.copy(srcStr, pathToString(dest)), 'copyFileSync', srcStr);
}

export function truncateSync(path: PathLike, len?: number): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.truncate(pathStr, len ?? 0), 'truncateSync', pathStr);
}

export function ftruncateSync(fd: number, len?: number): void {
    wrapSync(() => fs.ftruncate(fd, len ?? 0), 'ftruncateSync', describeFd(fd));
}

// ============================================================================
// Link operations
// ============================================================================

export function linkSync(existingPath: PathLike, newPath: PathLike): void {
    const existingStr = pathToString(existingPath);
    wrapSync(() => fs.link(existingStr, pathToString(newPath)), 'linkSync', existingStr);
}

export function symlinkSync(target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction'): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.symlink(pathToString(target), pathStr), 'symlinkSync', pathStr);
}

export function readlinkSync(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): string | Uint8Array {
    const pathStr = pathToString(path);
    const result = wrapSync(() => fs.readlink(pathStr), 'readlinkSync', pathStr);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding === 'buffer') return new TextEncoder().encode(result);
    return result;
}

export function realpathSync(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): string {
    const pathStr = pathToString(path);
    return wrapSync(() => fs.realpath(pathStr), 'realpathSync', pathStr);
}

// ============================================================================
// Permission operations
// ============================================================================

export function chmodSync(path: PathLike, mode: Mode): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.chmod(pathStr, modeToNumber(mode)!), 'chmodSync', pathStr);
}

export function fchmodSync(fd: number, mode: Mode): void {
    wrapSync(() => fs.fchmod(fd, modeToNumber(mode)!), 'fchmodSync', describeFd(fd));
}

export function lchmodSync(path: PathLike, mode: Mode): void {
    // lchmod is macOS-only; best-effort via chmod
    const pathStr = pathToString(path);
    wrapSync(() => fs.chmod(pathStr, modeToNumber(mode)!), 'lchmodSync', pathStr);
}

export function chownSync(path: PathLike, uid: number, gid: number): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.chown(pathStr, uid, gid), 'chownSync', pathStr);
}

export function fchownSync(fd: number, uid: number, gid: number): void {
    wrapSync(() => fs.fchown(fd, uid, gid), 'fchownSync', describeFd(fd));
}

export function lchownSync(path: PathLike, uid: number, gid: number): void {
    // C layer doesn't have sync lchown; best-effort via chown (follows symlink)
    const pathStr = pathToString(path);
    wrapSync(() => fs.chown(pathStr, uid, gid), 'lchownSync', pathStr);
}

// ============================================================================
// Time operations
// ============================================================================

export function utimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.utimes(pathStr, timeToNumber(atime) / 1000, timeToNumber(mtime) / 1000), 'utimesSync', pathStr);
}

export function lutimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
    // C layer doesn't have sync lutimes; best-effort via utimes (follows symlink)
    const pathStr = pathToString(path);
    wrapSync(() => fs.utimes(pathStr, timeToNumber(atime) / 1000, timeToNumber(mtime) / 1000), 'lutimesSync', pathStr);
}

// ============================================================================
// Low-level file descriptor operations
// ============================================================================

export function openSync(path: PathLike, flags?: string | number, mode?: Mode): number {
    const pathStr = pathToString(path);
    return wrapSync(() => fs.open(pathStr, parseFlags(flags), modeToNumber(mode)), 'openSync', pathStr);
}

export function closeSync(fd: number): void {
    wrapSync(() => fs.close(fd), 'closeSync', describeFd(fd));
}

export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position?: number | null): number {
    const fdPath = describeFd(fd);
    if (position !== null && position !== undefined) {
        return wrapSync(() => fs.pread(fd, buffer.subarray(offset, offset + length), position), 'readSync', fdPath);
    }
    return wrapSync(() => fs.read(fd, buffer.subarray(offset, offset + length)), 'readSync', fdPath);
}

export function writeSync(fd: number, buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null): number {
    const data = typeof buffer === 'string' ? toUint8Array(buffer) : buffer;
    const actualOffset = offset ?? 0;
    const actualLength = length ?? data.length;
    const fdPath = describeFd(fd);

    if (position !== null && position !== undefined) {
        return wrapSync(() => fs.pwrite(fd, data.subarray(actualOffset, actualOffset + actualLength), position), 'writeSync', fdPath);
    }
    return wrapSync(() => fs.write(fd, data.subarray(actualOffset, actualOffset + actualLength)), 'writeSync', fdPath);
}

export function fsyncSync(fd: number): void {
    wrapSync(() => fs.fsync(fd), 'fsyncSync', describeFd(fd));
}

export function fdatasyncSync(fd: number): void {
    wrapSync(() => fs.fdatasync(fd), 'fdatasyncSync', describeFd(fd));
}

// ============================================================================
// File locking
// ============================================================================

export function flockSync(fd: number, operation: number): void {
    wrapSync(() => fs.flock(fd, operation), 'flockSync', describeFd(fd));
}

// ============================================================================
// statfs
// ============================================================================

export function statfsSync(path: PathLike, options?: { bigint?: boolean }): import('fs').StatsFs {
    throw new Error('statfsSync is not supported');
}

// ============================================================================
// cp / cpSync
// ============================================================================

export interface CopyOptionsSync {
    mode?: Mode;
    force?: boolean;
    recursive?: boolean;
    errorOnExist?: boolean;
    filter?: (src: string, dest: string) => boolean;
}

export function cpSync(src: PathLike, dest: PathLike, options?: CopyOptionsSync): void {
    const srcStr = pathToString(src);
    const destStr = pathToString(dest);

    const srcStat = wrapSync(() => fs.stat(srcStr), 'cpSync', srcStr);

    if (srcStat.isDirectory) {
        if (!options?.recursive) {
            throw new Error('Cannot copy directory without recursive option');
        }

        if (!fs.exists(destStr)) {
            fs.mkdir(destStr, srcStat.mode);
        }

        const entries = fs.readdir(srcStr);
        for (const entry of entries) {
            cpSync(join(srcStr, entry), join(destStr, entry), options);
        }
    } else {
        if (fs.exists(destStr) && !options?.force) {
            if (options?.errorOnExist) {
                throw new Error(`File exists: ${destStr}`);
            }
            return;
        }

        wrapSync(() => fs.copy(srcStr, destStr), 'cpSync', srcStr);
    }
}

export function mkdtempSync(prefix: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): string {
    const dirPath = prefix + randomHex();
    wrapSync(() => fs.mkdir(dirPath), 'mkdtempSync', dirPath);
    return dirPath;
}
