/**
 * Normalize Windows synchronous-fs errors that still need path classification.
 * Numeric remaps are Windows-only; asyncfs reports correct libuv codes and must
 * never pass through them.
 */

import { normalizeErrnoError } from '../_internal/errno';
import { errnoName, errorCode, isErrorValue } from '../../utils/errno';
import { uvSyscall } from './syscall-names';

const fs = import.meta.use('fs');
const error = import.meta.use('error');
const os = import.meta.use('os');

/**
 * Platform gate. Reads `os.platform` rather than `process.platform` so this
 * native-module layer does not pull `process` in.
 */
const isWindows = os.platform === 'windows' || os.platform === 'win32';

const UV_EINVAL = error.errno.EINVAL;
const UV_EPERM = error.errno.EPERM;
const UV_EISDIR = error.errno.EISDIR;
const UV_EACCES = error.errno.EACCES;

const UV_FS_SYSCALLS = new Set([
    'rename', 'copyFile', 'readlink', 'rmdir', 'unlink', 'rm', 'link',
    'symlink', 'readdir', 'scandir', 'opendir',
]);

/**
 * Syscalls that read/write file contents, so a directory target is EISDIR.
 * `truncate` is deliberately NOT here (its own rule below): truncate of a
 * directory is EINVAL in Node.
 */
const CONTENT_SYSCALLS = new Set(['readFile', 'writeFile', 'appendFile', 'open']);

/**
 * Write-intent syscalls. Windows refuses these on a file carrying the read-only
 * attribute with ERROR_ACCESS_DENIED, which decodes to EACCES, but Node reports
 * EPERM. Excludes `unlink`: Node clears the attribute and succeeds instead.
 */
const READONLY_EPERM_SYSCALLS = new Set(['open', 'writeFile', 'appendFile', 'truncate']);

/** Call sites spell syscalls with or without the Sync suffix. */
const baseSyscall = (syscall?: string): string => {
    if (!syscall) return '';
    return syscall.endsWith('Sync') ? syscall.slice(0, -4) : syscall;
};

const isDir = (p: string): boolean => {
    try { return (fs.stat(p).mode & fs.S_IFMT) === fs.S_IFDIR; } catch { return false; }
};

/** Exists as a non-directory with no owner-write bit — the DOS read-only flag. */
const isReadonlyFile = (p: string): boolean => {
    try {
        const st = fs.stat(p);
        if ((st.mode & fs.S_IFMT) === fs.S_IFDIR) return false;
        return (st.mode & 0o200) === 0;
    } catch { return false; }
};

/**
 * Map a mangled native sync errno back to the value real Node reports.
 * Returns the original number when no correction applies.
 */
export function correctSyncErrno(raw: number, syscall?: string, path?: string, dest?: string): number {
    const base = baseSyscall(syscall);
    // These native operations already preserve libuv's error domain. In
    // particular, EXDEV from rename is a real cross-device failure.
    if (UV_FS_SYSCALLS.has(base)) return raw;

    // Every rule below encodes a Windows-measured value; on POSIX it would turn
    // a correct errno wrong.
    if (!isWindows) return raw;

    // A directory target: CRT reports EACCES for both, Node distinguishes them.
    if (raw === UV_EACCES && path) {
        // Reading/writing a directory as a file is EISDIR in Node.
        if (CONTENT_SYSCALLS.has(base) && isDir(path)) return UV_EISDIR;
        // The DOS read-only attribute blocking a write is EPERM in Node, not
        // EACCES. An ACL denial on a writable file keeps EACCES.
        if (READONLY_EPERM_SYSCALLS.has(base) && isReadonlyFile(path)) return UV_EPERM;
        return raw;
    }

    if (raw === UV_EINVAL) {
        if (CONTENT_SYSCALLS.has(base) && path && isDir(path)) return UV_EISDIR;
        return raw;
    }

    // truncate of a directory arrives as a genuine EPERM; Node reports EINVAL.
    if (raw === UV_EPERM && base === 'truncate' && path && isDir(path)) return UV_EINVAL;

    return raw;
}

/**
 * Apply the remaining path corrections before shaping the Node error.
 */
export function fixSyncError(e: unknown, syscall?: string, path?: string, dest?: string): unknown {
    if (!path || !isErrorValue(e)) return e;
    const base = baseSyscall(syscall);
    if (UV_FS_SYSCALLS.has(base)) return e;
    const raw = errorCode(e);

    if (typeof raw !== 'number') return e;

    const fixed = correctSyncErrno(raw, syscall, path, dest);
    if (fixed === raw) return e;
    return rebuild(e, fixed, syscall, path);
}

/** Rebuild so the message matches the corrected code, keeping the stack. */
function rebuild(e: Error, code: number, syscall: string | undefined, path: string): Error {
    const next = new Error(`${error.strerror(code)}, ${baseSyscall(syscall) || 'path'} '${path}'`);
    Reflect.set(next, 'code', code);
    if (e.stack) next.stack = e.stack;
    return next;
}

/**
 * `toErrnoException`, then correct `syscall` to the libuv name node reports.
 * Split from `_internal/errno` because that module is shared with
 * net/dns/child_process, whose syscall names must not be remapped.
 */
function toFsErrnoException(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): NodeJS.ErrnoException {
    const code = errorCode(e);
    const name = typeof code === 'number' ? errnoName(code) : undefined;
    return normalizeErrnoError(e, uvSyscall(syscall, name), path, dest) as NodeJS.ErrnoException;
}

/**
 * Drop-in replacement for `_internal/errno`'s toErrnoException for errors from
 * the native *sync* fs module. Async UV operations do not need legacy repairs.
 */
export function toSyncErrnoException(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): NodeJS.ErrnoException {
    return toFsErrnoException(fixSyncError(e, syscall, path, dest), syscall, path, dest);
}

/**
 * Drop-in replacement for `_internal/errno`'s wrapSync that repairs the native
 * sync layer's mangled errno before it is converted to an ErrnoException.
 */
export function wrapSync<T>(
    fn: () => T,
    syscall?: string,
    path?: string,
    dest?: string,
): T {
    try {
        return fn();
    } catch (e) {
        throw toFsErrnoException(fixSyncError(e, syscall, path, dest), syscall, path, dest);
    }
}

/**
 * `syscall`-correcting wrapper for the **async** fs layers (callbacks, promises).
 *
 * Deliberately does NOT call `fixSyncError`: asyncfs errno values are already
 * correct, and the numeric corrections would corrupt them. Only the name is
 * fixed.
 */
export function toAsyncFsErrnoException(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): NodeJS.ErrnoException {
    return toFsErrnoException(e, syscall, path, dest);
}

/** Promise form of `toAsyncFsErrnoException`. */
export function wrapFsPromise<T>(
    promise: Promise<T>,
    syscall?: string,
    path?: string,
    dest?: string,
): Promise<T> {
    return promise.catch((e: unknown) => {
        throw toFsErrnoException(e, syscall, path, dest);
    });
}

/**
 * `normalizeErrnoError` for the async fs layers: preserves ordinary JS errors,
 * gives errno errors Node's shape plus the libuv syscall name. Split from
 * `_internal` because other modules must not have their syscall names remapped.
 */
export function normalizeFsErrnoError(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): Error {
    if (!isErrorValue(e)) return new Error(String(e));
    const code = errorCode(e);
    return typeof code === 'number' || typeof code === 'string'
        ? toFsErrnoException(e, syscall, path, dest)
        : e;
}
