/**
 * Node.js fs module - sync operations
 */

import { Dir, toUint8Array, normalizeRwArgs, decodeBuffer, encodePathResult, toNodeStat, toNodeStatFs, toNodeDirent, parseFlags, pathToString, splitPathOrFd, describeFd, removeRecursiveSync, mkdirRecursiveSync, modeToNumber, timeToUnixSeconds, timeToUnixMs, readFileFromFdSync, randomHex, readDirEntriesSync, validateOpendirOptions, validateReaddirOptions, validateFd, assertCopyFileMode, rmIsDirectoryError, writeAllSync, type PathLike, type TimeLike, type Mode } from './utils';
import { wrapSync } from './errno-fix';
import { getTierLimits } from '../_internal/memory';
import { resolve } from '../path';
import { copyPathSync, validateCopyOptions, type CopySyncOptions } from './copy';
import { globPathsSync, type GlobOptions, type GlobResult } from './glob';

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

import { nsfs, nsasfs } from './syspath';
const fs = nsfs;
const asfs = nsasfs;
const engine = import.meta.use('engine');
const os = import.meta.use('os');
/** Matches fs/constants.ts; see fchownSync for why this file needs it. */
const isWindows = os.uname().sysname === 'Windows_NT';

// File read/write

export function readFileSync(path: PathLike | number, options?: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding): string | Uint8Array {
    const target = splitPathOrFd(path);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const flag = typeof options === 'object' ? options?.flag : undefined;
    const buffer = 'fd' in target
        ? wrapSync(() => readFileFromFdSync(fs.read, target.fd, READ_BUF_SIZE), 'readFileSync', describeFd(target.fd))
        : flag === undefined
            ? wrapSync(() => new Uint8Array(fs.readFile(target.path)), 'readFileSync', target.path)
            : wrapSync(() => {
                const fd = fs.open(target.path, parseFlags(flag));
                try {
                    return readFileFromFdSync(fs.read, fd, READ_BUF_SIZE);
                } finally {
                    fs.close(fd);
                }
            }, 'readFileSync', target.path);
    return decodeBuffer(buffer, encoding);
}

export function writeFileSync(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): void {
    const target = splitPathOrFd(path);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' && options?.flag !== undefined ? parseFlags(options.flag) : undefined;
    const encoding = typeof options === 'string' ? options : typeof options === 'object' ? options?.encoding : undefined;
    const buffer = toUint8Array(data, encoding);
    if ('fd' in target) {
        // Node: write from current offset; do not ftruncate(0) the fd.
        wrapSync(() => {
            writeAllSync(target.fd, buffer);
        }, 'writeFileSync', describeFd(target.fd));
        return;
    }
    if (flag !== undefined) {
        wrapSync(() => {
            const fd = fs.open(target.path, flag, mode);
            try {
                writeAllSync(fd, buffer);
            } finally {
                fs.close(fd);
            }
        }, 'writeFileSync', target.path);
        return;
    }
    wrapSync(() => fs.writeFile(target.path, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), mode), 'writeFileSync', target.path);
}

export function appendFileSync(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): void {
    const target = splitPathOrFd(path);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' && options?.flag !== undefined ? parseFlags(options.flag) : 'a';
    const encoding = typeof options === 'string' ? options : typeof options === 'object' ? options?.encoding : undefined;
    wrapSync(() => {
        const fd = 'fd' in target ? target.fd : fs.open(target.path, flag, mode);
        try {
            const buffer = toUint8Array(data, encoding);
            writeAllSync(fd, buffer);
        } finally {
            if (!('fd' in target)) fs.close(fd);
        }
    }, 'appendFileSync', 'fd' in target ? describeFd(target.fd) : target.path);
}

// File status

export function existsSync(path: PathLike): boolean {
    const pathStr = pathToString(path);
    return wrapSync(() => fs.exists(pathStr), 'existsSync', pathStr);
}

export function statSync(path: PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }): import('fs').Stats | undefined {
    const pathStr = pathToString(path);
    try {
        const st = wrapSync(() => fs.stat(pathStr), 'statSync', pathStr);
        return toNodeStat(st, options);
    } catch (err) {
        if (options?.throwIfNoEntry === false && Reflect.get(err, 'code') === 'ENOENT') return undefined;
        throw err;
    }
}

export function lstatSync(path: PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }): import('fs').Stats | undefined {
    const pathStr = pathToString(path);
    try {
        const st = wrapSync(() => fs.lstat(pathStr), 'lstatSync', pathStr);
        return toNodeStat(st, options);
    } catch (err) {
        if (options?.throwIfNoEntry === false && Reflect.get(err, 'code') === 'ENOENT') return undefined;
        throw err;
    }
}

export function fstatSync(fd: number, options?: { bigint?: boolean }): import('fs').Stats {
    validateFd(fd);
    const st = wrapSync(() => fs.fstat(fd), 'fstatSync', describeFd(fd));
    return toNodeStat(st, options);
}

export function accessSync(path: PathLike, mode?: number): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.access(pathStr, mode ?? fs.F_OK), 'accessSync', pathStr);
}

// Directory operations

export function mkdirSync(path: PathLike, options?: { mode?: number; recursive?: boolean } | number): string | undefined {
    const pathStr = pathToString(path);
    const mode = typeof options === 'number' ? options : options?.mode;
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        // Node returns the first created directory, or undefined if all existed.
        return wrapSync(() => mkdirRecursiveSync(pathStr, mode), 'mkdirSync', pathStr);
    }

    wrapSync(() => fs.mkdir(pathStr, mode), 'mkdirSync', pathStr);
    return undefined;
}

export function rmdirSync(path: PathLike, options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number }): void {
    const pathStr = pathToString(path);

    if (options?.recursive) {
        // Was unwrapped, so a failure escaped as a bare native errno with no
        // `code`/`syscall`/`path`. Measured before: rmdirSync(missing,{recursive})
        // threw `-4058` and the sqlite-held case threw `-4092`, both with
        // syscall=undefined. Node reports ENOENT and EPERM, and labels the
        // syscall `rm` (not `rmdir`) for the recursive form — v24 routes
        // rmdir(recursive) through the same path as rm.
        wrapSync(() => removeRecursiveSync(pathStr), 'rm', pathStr);
    } else {
        wrapSync(() => fs.rmdir(pathStr), 'rmdirSync', pathStr);
    }
}

export function rmSync(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): void {
    const pathStr = pathToString(path);
    let stats: CModuleFS.Stats;
    try {
        stats = wrapSync(() => fs.lstat(pathStr), 'rmSync', pathStr);
    } catch (err) {
        if (options?.force && Reflect.get(err, 'code') === 'ENOENT') return;
        throw err;
    }

    // Symlink-to-dir is not a directory for rm — always unlink the link.
    if (stats.isDirectory && !stats.isSymbolicLink) {
        if (!options?.recursive) throw rmIsDirectoryError(pathStr);
        wrapSync(() => removeRecursiveSync(pathStr), 'rmSync', pathStr);
    } else {
        wrapSync(() => fs.unlink(pathStr), 'rmSync', pathStr);
    }
}

export function readdirSync(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding): Array<string | Buffer> | import('fs').Dirent<string | Buffer>[] {
    validateReaddirOptions(options, true);
    const pathStr = pathToString(path);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;
    const recursive = typeof options === 'object' ? options?.recursive === true : false;
    // 'follow' both with and without withFileTypes: recursive readdirSync walks
    // junctions and directory symlinks alike (measured against node v24.18.0).
    const entries = wrapSync(() => readDirEntriesSync(pathStr, recursive, '', 'follow'), 'readdirSync', pathStr);

    if (withFileTypes) {
        return entries.map(entry => {
            const dirent = toNodeDirent(encodePathResult(entry.name, options), entry, entry.parentPath);
            if (path instanceof Uint8Array) {
                Reflect.set(dirent, 'parentPath', encodePathResult(entry.parentPath, 'buffer'));
            }
            return dirent;
        });
    }

    // recursive string names are root-relative paths (e.g. "sub/f").
    return entries.map(entry => encodePathResult(entry.relativePath, options));
}

export function opendirSync(path: PathLike, options?: { encoding?: BufferEncoding; bufferSize?: number; recursive?: boolean }): import('fs').Dir {
    validateOpendirOptions(options);
    // opendir does not type-check `recursive`; a truthy value walks (measured).
    return new Dir(pathToString(path), Boolean(options?.recursive)) as import('fs').Dir;
}

// File operations

export function unlinkSync(path: PathLike): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.unlink(pathStr), 'unlinkSync', pathStr);
}

export function renameSync(oldPath: PathLike, newPath: PathLike): void {
    const oldStr = pathToString(oldPath);
    const newStr = pathToString(newPath);
    wrapSync(() => fs.rename(oldStr, newStr), 'renameSync', oldStr, newStr);
}

export function copyFileSync(src: PathLike, dest: PathLike, mode?: number): void {
    const srcStr = pathToString(src);
    const destStr = pathToString(dest);
    wrapSync(() => {
        assertCopyFileMode(srcStr, destStr, mode);
        fs.copy(srcStr, destStr);
    }, 'copyFileSync', srcStr, destStr);
}

export function truncateSync(path: PathLike, len?: number): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.truncate(pathStr, len ?? 0), 'truncateSync', pathStr);
}

export function ftruncateSync(fd: number, len?: number): void {
    validateFd(fd);
    wrapSync(() => fs.ftruncate(fd, len ?? 0), 'ftruncateSync', describeFd(fd));
}

// Link operations

export function linkSync(existingPath: PathLike, newPath: PathLike): void {
    const existingStr = pathToString(existingPath);
    wrapSync(() => fs.link(existingStr, pathToString(newPath)), 'linkSync', existingStr);
}

export function symlinkSync(target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction'): void {
    const pathStr = pathToString(path);
    // Sync C layer takes a Windows hint string and has no junction flag — map to 'dir'.
    const hint = type === 'dir' || type === 'junction' ? 'dir' : type;
    wrapSync(() => fs.symlink(pathToString(target), pathStr, hint), 'symlinkSync', pathStr);
}

export function readlinkSync(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): string | Buffer {
    const pathStr = pathToString(path);
    const result = wrapSync(() => fs.readlink(pathStr), 'readlinkSync', pathStr);
    return encodePathResult(result, options);
}

export function realpathSync(pathLike: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): string | Buffer {
    const pathStr = pathToString(pathLike);
    // Resolve symlinks (was normalize-only — diverged from Node for links).
    const resolved = wrapSync(() => fs.realpath(pathStr), 'realpathSync', pathStr);
    return encodePathResult(resolved, options);
}

Reflect.set(realpathSync, 'native', function (pathLike: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding) {
    const pathStr = pathToString(pathLike);
    const resolved = wrapSync(() => fs.realpath(pathStr), 'realpathSync', pathStr);
    return encodePathResult(resolved, options);
});

// Permission operations

export function chmodSync(path: PathLike, mode: Mode): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.chmod(pathStr, modeToNumber(mode)), 'chmodSync', pathStr);
}

export function fchmodSync(fd: number, mode: Mode): void {
    validateFd(fd);
    wrapSync(() => fs.fchmod(fd, modeToNumber(mode)), 'fchmodSync', describeFd(fd));
}

export function lchmodSync(path: PathLike, mode: Mode): void {
    // No O_NOFOLLOW open on all hosts — open via lstat guard then fchmod.
    const pathStr = pathToString(path);
    wrapSync(() => {
        const st = fs.lstat(pathStr);
        if (st.isSymbolicLink) {
            // Linux lchmod is unsupported; Node throws ENOSYS — match when link.
            const err = new Error(`ENOSYS: function not implemented, lchmod '${pathStr}'`) as NodeJS.ErrnoException;
            err.code = 'ENOSYS';
            err.syscall = 'lchmod';
            err.path = pathStr;
            throw err;
        }
        fs.chmod(pathStr, modeToNumber(mode));
    }, 'lchmodSync', pathStr);
}

export function chownSync(path: PathLike, uid: number, gid: number): void {
    // Bridge asyncfs via waitIO, exactly as lchownSync below. The sync C layer
    // throws a bare TypeError "chown not supported on Windows" (no errno, so it
    // surfaced as code UNKNOWN), whereas libuv's Windows `fs__chown` is
    // `SET_REQ_RESULT(req, 0)` — a deliberate no-op. Measured v24.18.0:
    // chownSync succeeds on Windows for any path, even a missing one. Going
    // through asyncfs inherits that per-platform behaviour instead of hardcoding
    // it, so POSIX still performs a real chown and reports its real errors.
    const pathStr = pathToString(path);
    wrapSync(() => engine.waitIO(asfs.chown(pathStr, uid, gid)), 'chownSync', pathStr);
}

export function fchownSync(fd: number, uid: number, gid: number): void {
    validateFd(fd);
    // asyncfs exposes no fchown, and the sync C layer throws "fchown not
    // supported on Windows" with no errno. libuv's `fs__fchown` is the same
    // `SET_REQ_RESULT(req, 0)` no-op as `fs__chown`, and Node on Windows
    // therefore succeeds for ANY fd — measured v24.18.0: fchownSync(9999)
    // does not throw. Match that on Windows; elsewhere keep the native call.
    if (isWindows) return;
    wrapSync(() => fs.fchown(fd, uid, gid), 'fchownSync', describeFd(fd));
}

export function lchownSync(path: PathLike, uid: number, gid: number): void {
    // Sync C layer has no lchown; bridge asyncfs via waitIO.
    const pathStr = pathToString(path);
    wrapSync(() => engine.waitIO(asfs.lchown(pathStr, uid, gid)), 'lchownSync', pathStr);
}

// Time operations

export function utimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
    const pathStr = pathToString(path);
    wrapSync(() => fs.utimes(pathStr, timeToUnixSeconds(atime, 'atime'), timeToUnixSeconds(mtime, 'mtime')), 'utimesSync', pathStr);
}

export function lutimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
    // Sync C layer has no lutimes; bridge asyncfs via waitIO.
    const pathStr = pathToString(path);
    wrapSync(
        () => engine.waitIO(asfs.lutime(pathStr, timeToUnixMs(atime, 'atime'), timeToUnixMs(mtime, 'mtime'))),
        'lutimesSync',
        pathStr,
    );
}

export function futimesSync(fd: number, atime: TimeLike, mtime: TimeLike): void {
    validateFd(fd);
    wrapSync(() => fs.futimes(fd, timeToUnixSeconds(atime, 'atime'), timeToUnixSeconds(mtime, 'mtime')), 'futimesSync', describeFd(fd));
}

// Low-level file descriptor operations

export function openSync(path: PathLike, flags?: string | number, mode?: Mode): number {
    const pathStr = pathToString(path);
    return wrapSync(() => fs.open(pathStr, parseFlags(flags), modeToNumber(mode)), 'openSync', pathStr);
}

export function closeSync(fd: number): void {
    validateFd(fd);
    wrapSync(() => fs.close(fd), 'closeSync', describeFd(fd));
}

export function readSync(fd: number, buffer: ArrayBufferView, offset?: number | null | object, length?: number | null, position?: number | null): number {
    validateFd(fd);
    const fdPath = describeFd(fd);
    const { window, position: pos } = normalizeRwArgs(buffer, offset, length, position);
    if (pos !== null) {
        return wrapSync(() => fs.pread(fd, window, pos), 'readSync', fdPath);
    }
    return wrapSync(() => fs.read(fd, window), 'readSync', fdPath);
}

function vectorView(buffer: ArrayBufferView): Uint8Array {
    if (!ArrayBuffer.isView(buffer)) throw new TypeError('The "buffers" argument must be an ArrayBufferView[]');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function readvSync(fd: number, buffers: readonly ArrayBufferView[], position?: number | null): number {
    validateFd(fd);
    if (!Array.isArray(buffers)) throw new TypeError('The "buffers" argument must be an Array');
    let bytesRead = 0;
    let currentPosition = position;
    for (const buffer of buffers) {
        const view = vectorView(buffer);
        if (view.byteLength === 0) continue;
        const read = readSync(fd, view, 0, view.byteLength, currentPosition);
        bytesRead += read;
        if (currentPosition != null) currentPosition += read;
        if (read < view.byteLength) break;
    }
    return bytesRead;
}

export function writeSync(fd: number, buffer: ArrayBufferView, offset?: number | null, length?: number | null, position?: number | null): number;
export function writeSync(fd: number, buffer: ArrayBufferView, options?: { offset?: number; length?: number; position?: number | null }): number;
export function writeSync(fd: number, string: string, position?: number | null, encoding?: BufferEncoding): number;
export function writeSync(fd: number, buffer: ArrayBufferView | string, offsetOrPosition?: unknown, lengthOrEncoding?: unknown, position?: number | null): number {
    validateFd(fd);
    const fdPath = describeFd(fd);
    if (typeof buffer === 'string') {
        const encoding = typeof lengthOrEncoding === 'string' ? (lengthOrEncoding as BufferEncoding) : undefined;
        const data = toUint8Array(buffer, encoding);
        const at = offsetOrPosition === null || offsetOrPosition === undefined ? null : Number(offsetOrPosition);
        if (at !== null) return wrapSync(() => fs.pwrite(fd, data, at), 'writeSync', fdPath);
        return wrapSync(() => fs.write(fd, data), 'writeSync', fdPath);
    }
    const { window, position: pos } = normalizeRwArgs(buffer, offsetOrPosition, lengthOrEncoding, position);
    if (pos !== null) {
        return wrapSync(() => fs.pwrite(fd, window, pos), 'writeSync', fdPath);
    }
    return wrapSync(() => fs.write(fd, window), 'writeSync', fdPath);
}

export function writevSync(fd: number, buffers: readonly ArrayBufferView[], position?: number | null): number {
    validateFd(fd);
    if (!Array.isArray(buffers)) throw new TypeError('The "buffers" argument must be an Array');
    let bytesWritten = 0;
    let currentPosition = position;
    for (const buffer of buffers) {
        const view = vectorView(buffer);
        if (view.byteLength === 0) continue;
        const written = writeSync(fd, view, 0, view.byteLength, currentPosition);
        bytesWritten += written;
        if (currentPosition != null) currentPosition += written;
        if (written < view.byteLength) break;
    }
    return bytesWritten;
}

export function fsyncSync(fd: number): void {
    validateFd(fd);
    wrapSync(() => fs.fsync(fd), 'fsyncSync', describeFd(fd));
}

export function fdatasyncSync(fd: number): void {
    validateFd(fd);
    wrapSync(() => fs.fdatasync(fd), 'fdatasyncSync', describeFd(fd));
}

// File locking

export function flockSync(fd: number, operation: number): void {
    validateFd(fd);
    wrapSync(() => fs.flock(fd, operation), 'flockSync', describeFd(fd));
}

// statfs

export function statfsSync(path: PathLike, options?: { bigint?: boolean }): import('fs').StatsFs {
    const pathStr = pathToString(path);
    const st = wrapSync(() => fs.statFs(pathStr), 'statfsSync', pathStr);
    return toNodeStatFs(st, options);
}

// cp / cpSync

export type CopyOptionsSync = CopySyncOptions;

export function cpSync(src: PathLike, dest: PathLike, options?: CopyOptionsSync): void {
    const resolvedOptions = validateCopyOptions(options);
    copyPathSync(pathToString(src), pathToString(dest), resolvedOptions);
}

export function globSync(pattern: string | readonly string[], options?: GlobOptions): GlobResult[] {
    return globPathsSync(pattern, options);
}

export function mkdtempSync(prefix: string, options?: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding): string | Buffer {
    const dirPath = prefix + randomHex();
    const result = encodePathResult(dirPath, options);
    wrapSync(() => fs.mkdir(dirPath), 'mkdtempSync', dirPath);
    return result;
}

export function mkdtempDisposableSync(prefix: string, options?: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding): {
    path: string | Buffer;
    remove: () => void;
    [Symbol.dispose]: () => void;
} {
    const dirPath = prefix + randomHex();
    const result = encodePathResult(dirPath, options);
    wrapSync(() => fs.mkdir(dirPath), 'mkdtempDisposableSync', dirPath);
    const fullPath = resolve(dirPath);
    const remove = () => {
        if (!fs.exists(fullPath)) return;
        wrapSync(() => removeRecursiveSync(fullPath), 'rm', fullPath);
    };
    return {
        path: result,
        remove,
        [Symbol.dispose]() { remove(); },
    };
}
