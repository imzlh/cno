/**
 * Node.js fs 模块 - 同步操作
 */

const fs = import.meta.use('fs');
import { toUint8Array, decodeBuffer, toNodeStat, toNodeDirent, parseFlags, pathToString, removeRecursiveSync, mkdirRecursiveSync } from './utils';

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
// 文件读写
// ============================================================================

export function readFileSync(path: PathLike | number, options?: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding): string | Uint8Array {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const buffer = new Uint8Array(fs.readFile(pathStr));
    return decodeBuffer(buffer, encoding);
}

export function writeFileSync(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): void {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const buffer = toUint8Array(data);
    fs.writeFile(pathStr, buffer.buffer as ArrayBuffer, mode);
}

export function appendFileSync(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): void {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path as string | URL);
    const fd = fs.open(pathStr, 'a');
    try {
        const buffer = toUint8Array(data);
        fs.write(fd, buffer);
    } finally {
        fs.close(fd);
    }
}

// ============================================================================
// 文件状态
// ============================================================================

export function existsSync(path: PathLike): boolean {
    return fs.exists(pathToString(path as string | URL));
}

export function statSync(path: PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }): import('fs').Stats {
    const pathStr = pathToString(path as string | URL);
    const st = fs.stat(pathStr);
    return toNodeStat(st);
}

export function lstatSync(path: PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }): import('fs').Stats {
    const pathStr = pathToString(path as string | URL);
    const st = fs.lstat(pathStr);
    return toNodeStat(st);
}

export function fstatSync(fd: number, options?: { bigint?: boolean }): import('fs').Stats {
    throw new Error('fstatSync is not supported');
}

export function accessSync(path: PathLike, mode?: number): void {
    fs.access(pathToString(path as string | URL), mode ?? fs.F_OK);
}

// ============================================================================
// 目录操作
// ============================================================================

export function mkdirSync(path: PathLike, options?: { mode?: number; recursive?: boolean } | number): string | undefined {
    const pathStr = pathToString(path as string | URL);
    const mode = typeof options === 'number' ? options : options?.mode;
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        mkdirRecursiveSync(pathStr, mode);
        return pathStr;
    }

    fs.mkdir(pathStr, mode);
    return undefined;
}

export function rmdirSync(path: PathLike, options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number }): void {
    const pathStr = pathToString(path as string | URL);

    if (options?.recursive) {
        removeRecursiveSync(pathStr);
    } else {
        fs.rmdir(pathStr);
    }
}

export function rmSync(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): void {
    const pathStr = pathToString(path as string | URL);

    try {
        const stats = fs.lstat(pathStr);

        if (stats.isDirectory) {
            if (options?.recursive) {
                removeRecursiveSync(pathStr);
            } else {
                fs.rmdir(pathStr);
            }
        } else {
            fs.unlink(pathStr);
        }
    } catch (err) {
        if (!options?.force) {
            throw err;
        }
    }
}

export function readdirSync(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding): string[] | import('fs').Dirent[] {
    const pathStr = pathToString(path as string | URL);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;
    const entries = fs.readdir(pathStr);

    if (withFileTypes) {
        return entries.map(name => {
            const stat = fs.lstat(`${pathStr}/${name}`);
            return toNodeDirent(name, stat);
        });
    }

    return entries;
}

export function opendirSync(path: PathLike, options?: { encoding?: BufferEncoding; bufferSize?: number }): import('fs').Dir {
    const pathStr = pathToString(path as string | URL);
    const entries = fs.readdir(pathStr);
    let index = 0;

    const dir: import('fs').Dir = {
        path: pathStr,

        async read(): Promise<import('fs').Dirent | null> {
            if (index >= entries.length) return null;
            const name = entries[index++];
            const stat = fs.lstat(`${pathStr}/${name}`);
            return toNodeDirent(name, stat);
        },

        readSync(): import('fs').Dirent | null {
            if (index >= entries.length) return null;
            const name = entries[index++];
            const stat = fs.lstat(`${pathStr}/${name}`);
            return toNodeDirent(name, stat);
        },

        async close(): Promise<void> {
            // No-op for sync implementation
        },

        closeSync(): void {
            // No-op for sync implementation
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

export function unlinkSync(path: PathLike): void {
    fs.unlink(pathToString(path as string | URL));
}

export function renameSync(oldPath: PathLike, newPath: PathLike): void {
    fs.rename(pathToString(oldPath as string | URL), pathToString(newPath as string | URL));
}

export function copyFileSync(src: PathLike, dest: PathLike, mode?: number): void {
    fs.copy(pathToString(src as string | URL), pathToString(dest as string | URL));
}

export function truncateSync(path: PathLike, len?: number): void {
    fs.truncate(pathToString(path as string | URL), len ?? 0);
}

export function ftruncateSync(fd: number, len?: number): void {
    fs.ftruncate(fd, len ?? 0);
}

// ============================================================================
// 链接操作
// ============================================================================

export function linkSync(existingPath: PathLike, newPath: PathLike): void {
    fs.link(pathToString(existingPath as string | URL), pathToString(newPath as string | URL));
}

export function symlinkSync(target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction'): void {
    fs.symlink(pathToString(target as string | URL), pathToString(path as string | URL));
}

export function readlinkSync(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): string | Uint8Array {
    const result = fs.readlink(pathToString(path as string | URL));
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? result : result;
}

export function realpathSync(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): string {
    return fs.realpath(pathToString(path as string | URL));
}

// ============================================================================
// 权限操作
// ============================================================================

export function chmodSync(path: PathLike, mode: Mode): void {
    fs.chmod(pathToString(path as string | URL), modeToNumber(mode)!);
}

export function fchmodSync(fd: number, mode: Mode): void {
    fs.fchmod(fd, modeToNumber(mode)!);
}

export function lchmodSync(path: PathLike, mode: Mode): void {
    throw new Error('lchmodSync is not supported');
}

export function chownSync(path: PathLike, uid: number, gid: number): void {
    fs.chown(pathToString(path as string | URL), uid, gid);
}

export function fchownSync(fd: number, uid: number, gid: number): void {
    fs.fchown(fd, uid, gid);
}

export function lchownSync(path: PathLike, uid: number, gid: number): void {
    // lchown 需要特殊处理
    throw new Error('lchownSync is not supported');
}

// ============================================================================
// 时间操作
// ============================================================================

export function utimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
    fs.utimes(pathToString(path as string | URL), timeToNumber(atime) / 1000, timeToNumber(mtime) / 1000);
}

export function lutimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
    throw new Error('lutimesSync is not supported');
}

// ============================================================================
// 底层文件描述符操作
// ============================================================================

export function openSync(path: PathLike, flags?: string | number, mode?: Mode): number {
    return fs.open(pathToString(path as string | URL), parseFlags(flags), modeToNumber(mode));
}

export function closeSync(fd: number): void {
    fs.close(fd);
}

export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position?: number | null): number {
    if (position !== null && position !== undefined) {
        return fs.pread(fd, buffer.subarray(offset, offset + length), position);
    }
    return fs.read(fd, buffer.subarray(offset, offset + length));
}

export function writeSync(fd: number, buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null): number {
    const data = typeof buffer === 'string' ? toUint8Array(buffer) : buffer;
    const actualOffset = offset ?? 0;
    const actualLength = length ?? data.length;

    if (position !== null && position !== undefined) {
        return fs.pwrite(fd, data.subarray(actualOffset, actualOffset + actualLength), position);
    }
    return fs.write(fd, data.subarray(actualOffset, actualOffset + actualLength));
}

export function fsyncSync(fd: number): void {
    fs.fsync(fd);
}

export function fdatasyncSync(fd: number): void {
    fs.fdatasync(fd);
}

// ============================================================================
// 文件锁定
// ============================================================================

export function flockSync(fd: number, operation: number): void {
    fs.flock(fd, operation);
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
    const srcStr = pathToString(src as string | URL);
    const destStr = pathToString(dest as string | URL);

    const srcStat = fs.stat(srcStr);

    if (srcStat.isDirectory) {
        if (!options?.recursive) {
            throw new Error('Cannot copy directory without recursive option');
        }

        // 创建目标目录
        if (!fs.exists(destStr)) {
            fs.mkdir(destStr, srcStat.mode);
        }

        // 递归复制
        const entries = fs.readdir(srcStr);
        for (const entry of entries) {
            cpSync(`${srcStr}/${entry}`, `${destStr}/${entry}`, options);
        }
    } else {
        // 复制文件
        if (fs.exists(destStr) && !options?.force) {
            if (options?.errorOnExist) {
                throw new Error(`File already exists: ${destStr}`);
            }
            return;
        }

        fs.copy(srcStr, destStr);
    }
}
