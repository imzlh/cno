/**
 * Windows sync-fs errno correction.
 *
 * HISTORY, because the shape of this file only makes sense with it: the native
 * sync `fs` module used to throw `uv_translate_sys_error(errno)` at ~14 call
 * sites, feeding a **CRT errno** to a helper that expects a **Win32** error
 * code. Overlapping numbers meant silent mistranslation:
 *   CRT EEXIST(17)    -> ERROR_NOT_SAME_DEVICE  -> UV_EXDEV    (want EEXIST)
 *   CRT EPERM(1)      -> ERROR_INVALID_FUNCTION -> UV_EINVAL   (want EPERM)
 *   CRT EACCES(13)    -> ERROR_INVALID_DATA     -> UV_EINVAL   (want EISDIR/EPERM)
 *   CRT ENOTEMPTY(41) -> unmapped               -> UV_UNKNOWN  (want ENOTEMPTY)
 *   CRT EBADF(9)      -> unmapped               -> UV_UNKNOWN  (want EBADF)
 *
 * **`mod_fs.c` now decodes CRT errno correctly** (`fs_errno2uv()`, 29 sites), so
 * the raw values arriving here have changed. A guard keyed on the OLD mangled
 * value silently stops firing — measured: `readFileSync(dir)` used to arrive as
 * UV_EINVAL and now arrives as UV_EACCES, so the EISDIR correction below became
 * dead and the error surfaced as EACCES where Node says EISDIR. Same fault hit
 * `openSync(dir,'w')`, `writeFileSync(dir)`, `appendFileSync(dir)` (none of them
 * asserted anywhere) and `unlinkSync(dir)`.
 *
 * So: **each correction must be keyed on the value the C layer actually produces
 * today.** When touching `mod_fs.c`, re-measure the raw `errno` reaching this
 * file rather than assuming. `asyncfs` goes through libuv and is unaffected.
 *
 * **PLATFORM GATE.** Every target value below was measured against Node on
 * *Windows*, and several are actively wrong elsewhere, so the whole numeric
 * remapping is gated on `isWindows`. Three rules would corrupt POSIX errors:
 *
 *   - `UV_EXDEV -> EEXIST/EPERM`. On Windows a real cross-device CRT error can
 *     never decode to UV_EXDEV, so UV_EXDEV is always mangled CRT EEXIST. On
 *     POSIX `rename(2)` across mount points returns a **genuine** EXDEV, and
 *     rewriting it to EEXIST breaks the copy+unlink fallback every library keys
 *     off `err.code === 'EXDEV'`.
 *   - `EACCES + isShareViolation -> EBUSY`. Windows-only: it compensates for the
 *     CRT flattening a share violation onto EACCES. On POSIX an EACCES from
 *     `unlink` is a genuine parent-directory permission denial, and a readable
 *     file would be mislabelled EBUSY.
 *   - `EACCES + isReadonlyFile -> EPERM`. Windows reports the DOS read-only
 *     attribute as EACCES where Node says EPERM. On POSIX a mode-444 file opened
 *     for write is EACCES in Node too, so the rewrite would be wrong.
 *
 * Off Windows the corrections are skipped and the native errno passes through
 * untouched — the pre-`errno-fix` status quo, which cannot mislabel anything.
 * The two rules that are *also* the POSIX answer (readlink of a non-symlink is
 * EINVAL; of a missing path, ENOENT) stay ungated, and where a platform-
 * independent C throw carries no errno at all the POSIX value is supplied
 * separately. See `fixSyncError`.
 */

import { toErrnoException } from '../_internal/errno';
import { uvSyscall } from './syscall-names';

const fs = import.meta.use('fs');
const error = import.meta.use('error');
const os = import.meta.use('os');

/**
 * Platform gate. Matches `fs/constants.ts` in this directory rather than
 * `process.platform` so the check stays inside the native-module layer and does
 * not pull `process` into an `fs` dependency.
 */
const isWindows = os.uname().sysname === 'Windows_NT';

const UV_EXDEV = error.errno.EXDEV;
const UV_EINVAL = error.errno.EINVAL;
const UV_UNKNOWN = error.errno.UNKNOWN;
const UV_EEXIST = error.errno.EEXIST;
const UV_EPERM = error.errno.EPERM;
const UV_ENOTEMPTY = error.errno.ENOTEMPTY;
const UV_EBADF = error.errno.EBADF;
const UV_ENOENT = error.errno.ENOENT;
const UV_ENOTDIR = error.errno.ENOTDIR;
const UV_EISDIR = error.errno.EISDIR;
const UV_EACCES = error.errno.EACCES;
const UV_EBUSY = error.errno.EBUSY;

/** Syscalls that take an fd, so a bare UNKNOWN means a bad descriptor. */
const FD_SYSCALLS = new Set([
    'fstat',
    'fchmod',
    'fchown',
    'futimes',
    'fsync',
    'fdatasync',
    'ftruncate',
    'close',
    'read',
    'write',
    'flock',
]);

/** Syscalls where a directory target turns CRT EPERM into Node's EPERM. */
const UNLINK_SYSCALLS = new Set(['unlink', 'rm']);

/** Syscalls that fail with EEXIST when their target path is already present. */
const EEXIST_SYSCALLS = new Set(['symlink', 'link', 'mkdir']);

/** Syscalls that require a directory, so a non-directory target is ENOTDIR. */
const DIR_SYSCALLS = new Set(['readdir', 'scandir', 'opendir']);

/**
 * Syscalls taking (source, dest). Their `path` is the SOURCE, so a check for
 * "what is already in the way" must look at `dest` instead.
 */
const TWO_PATH_SYSCALLS = new Set(['rename', 'copyFile', 'link', 'symlink']);

/**
 * Syscalls that read/write file contents, so a directory target is EISDIR.
 * `truncate` is deliberately NOT here: measured on v24.18.0, truncate of a
 * directory is EINVAL in Node, not EISDIR. It is handled by its own rule below.
 */
const CONTENT_SYSCALLS = new Set(['readFile', 'writeFile', 'appendFile', 'open', 'read', 'write']);

/**
 * Write-intent syscalls. Windows refuses these on a file carrying the read-only
 * attribute with ERROR_ACCESS_DENIED, which decodes to EACCES, but Node reports
 * EPERM. Excludes `unlink`: Node clears the attribute and succeeds instead.
 */
const READONLY_EPERM_SYSCALLS = new Set(['open', 'writeFile', 'appendFile', 'write', 'truncate']);

/** Call sites spell syscalls with or without the Sync suffix. */
const baseSyscall = (syscall?: string): string => {
    if (!syscall) return '';
    return syscall.endsWith('Sync') ? syscall.slice(0, -4) : syscall;
};

const isDir = (p: string): boolean => {
    try { return (fs.stat(p).mode & fs.S_IFMT) === fs.S_IFDIR; } catch { return false; }
};

const isNonEmptyDir = (p: string): boolean => {
    try { return isDir(p) && fs.readdir(p).length > 0; } catch { return false; }
};

/** Present as a link or a real entry — lstat so dangling links still count. */
const lexists = (p: string): boolean => {
    try { fs.lstat(p); return true; } catch { return false; }
};

/** Exists as a non-directory with no owner-write bit — the DOS read-only flag. */
const isReadonlyFile = (p: string): boolean => {
    try {
        const st = fs.stat(p);
        if ((st.mode & fs.S_IFMT) === fs.S_IFDIR) return false;
        return (st.mode & 0o200) === 0;
    } catch { return false; }
};

/** A real symlink/reparse point, so readlink is legitimate. */
const isSymlink = (p: string): boolean => {
    try { return fs.lstat(p).isSymbolicLink; } catch { return false; }
};

/**
 * `describeFd` renders an fd target as `fd:N`, so recover the number to probe it.
 * Returns -1 for a path that is not that form.
 */
const fdFromPath = (p?: string): number => {
    if (!p || !p.startsWith('fd:')) return -1;
    const n = Number(p.slice(3));
    return Number.isInteger(n) && n >= 0 ? n : -1;
};

/**
 * Is this fd definitely not an open descriptor? `fstat` is the discriminator:
 * measured, the native `fs.stat`-on-fd path reports a correct UV_EBADF for a
 * bogus fd even when its siblings do not.
 *
 * This exists because several fd syscalls report a code with **no relationship to
 * the failure**. `tjs_syncfs_fsync` (mod_fs.c) calls `THROW2`, which formats
 * `GetLastError()`, but the failing step is `_get_osfhandle(fd)` — a CRT call
 * that sets CRT `errno` and leaves the Win32 last-error untouched. The reported
 * code is therefore whatever the *previous* Win32 call left behind. Measured, same
 * `fsyncSync(9999)` call:
 *
 *   preceding op            cno code        real Node
 *   (none)                  UNKNOWN errno=0 EBADF
 *   statSync(missing)       ENOENT          EBADF
 *   closeSync(badfd)        ENOENT          EBADF
 *   openSync(missing)       ENOENT          EBADF
 *
 * A wrong-but-plausible ENOENT is worse than UNKNOWN: retry logic keyed on
 * ENOENT will act on it. Probing the fd is deterministic, so it replaces the
 * guesswork entirely.
 *
 * Not platform-gated: EBADF for an operation on a closed descriptor is the POSIX
 * answer too, and the rule only fires when the fd is *provably* bad.
 */
const isBadFd = (fd: number): boolean => {
    if (fd < 0) return false;
    try { fs.fstat(fd); return false; } catch (e) {
        return Reflect.get(e as object, 'code') === UV_EBADF;
    }
};

/** An fd syscall whose descriptor is provably closed/never-opened. */
const failedOnBadFd = (syscall?: string, path?: string): boolean => {
    if (!FD_SYSCALLS.has(baseSyscall(syscall))) return false;
    return isBadFd(fdFromPath(path));
};

/**
 * Windows refuses to delete/move an entry whose handle is held without
 * FILE_SHARE_DELETE. The CRT surfaces that as EACCES, indistinguishable from a
 * genuine ACL denial, but libuv reports EBUSY/EPERM because it goes through
 * `CreateFileW(..., DELETE, ...)`/`MoveFileExW` and sees the raw Win32 code.
 *
 * **Windows-only.** Reached solely from `correctSyncErrno`, which returns early
 * off Windows. On POSIX an EACCES from `unlink` is a genuine parent-directory
 * permission error and this rule would mislabel any still-readable file EBUSY —
 * that is precisely why the gate exists.
 *
 * The discriminator: a share-violated file is still **openable for read** (the
 * holder allows FILE_SHARE_READ; it only withheld DELETE), whereas an ACL denial
 * blocks the read open too. Readonly-attribute files are excluded — that is the
 * separate, still-open mod_fs.c gap where Node clears the attribute and
 * succeeds, and it must keep reporting EACCES so the known-failing test in
 * fs-errno-parity.test.ts stays accurate.
 *
 * Measured in-process, sqlite3 holding the file (asyncfs IS libuv, so the async
 * column is exactly what Node reports; confirmed against real Node v24.18.0
 * using node:sqlite as the same blocker):
 *
 *   operation                   sync (before)   libuv/async   real Node
 *   unlink(held file)           EACCES          EBUSY         EBUSY
 *   rename(held file)           EACCES          EBUSY         EBUSY
 *   rename(dir w/ held child)   EACCES          EPERM         EPERM
 */
const isShareViolation = (p: string): boolean => {
    try {
        const st = fs.stat(p);
        if ((st.mode & fs.S_IFMT) === fs.S_IFDIR) return false;
        if ((st.mode & 0o200) === 0) return false;   // readonly attribute, different cause
    } catch { return false; }
    try { fs.close(fs.open(p, fs.OPEN_RDONLY)); return true; } catch { return false; }
};

/**
 * Map a mangled native sync errno back to the value real Node reports.
 * Returns the original number when no correction applies.
 */
export function correctSyncErrno(raw: number, syscall?: string, path?: string, dest?: string): number {
    const base = baseSyscall(syscall);

    // Ungated: a provably-closed descriptor is EBADF on every platform, and the
    // C layer's fd errors are nondeterministic here. See failedOnBadFd.
    if (failedOnBadFd(syscall, path)) return UV_EBADF;

    // Every rule below encodes a Windows-measured value. See the PLATFORM GATE
    // note at the top of this file: on POSIX the EXDEV, share-violation and
    // read-only rules would each turn a correct errno into a wrong one.
    if (!isWindows) return raw;

    // readdir/opendir on a plain file reports the CRT's ENOENT; Node says ENOTDIR.
    if (DIR_SYSCALLS.has(base) && path && raw === UV_ENOENT && lexists(path)) return UV_ENOTDIR;

    // A genuine cross-device CRT error (EXDEV=18) decodes to ERROR_NO_MORE_FILES,
    // never to UV_EXDEV, so UV_EXDEV out of the sync layer is always CRT EEXIST.
    //
    // Which Node code that becomes depends on WHAT is in the way, measured on
    // v24.18.0: an existing **file** target gives EEXIST (link, mkdir), but an
    // existing **directory** target gives EPERM (symlink onto a dir, rename onto
    // a dir — empty or not). An unrestricted `=> EEXIST` rewrite reported EEXIST
    // for both, which was wrong for every directory case.
    //
    // For two-path syscalls the blocking entry is `dest`, not `path`: rename's
    // `path` is the SOURCE file, so checking `path` alone silently missed it.
    if (raw === UV_EXDEV) {
        const blocking = TWO_PATH_SYSCALLS.has(base) ? (dest ?? path) : path;
        if (blocking && isDir(blocking)) return UV_EPERM;
        return UV_EEXIST;
    }

    // Since mod_fs.c decodes CRT errno correctly, `rename` onto an existing entry
    // now arrives as a genuine UV_EEXIST rather than the mangled UV_EXDEV above.
    // Node still reports EPERM when the blocker is a directory, so apply the same
    // rule to an already-correct EEXIST.
    if (raw === UV_EEXIST && TWO_PATH_SYSCALLS.has(base)) {
        const blocking = dest ?? path;
        if (blocking && isDir(blocking)) return UV_EPERM;
        return raw;
    }

    // A directory target: CRT reports EACCES for both, Node distinguishes them.
    // Keyed on UV_EACCES because mod_fs.c now decodes CRT EACCES(13) correctly;
    // before that fix these same failures arrived as UV_EINVAL.
    if (raw === UV_EACCES && path) {
        // unlink/rm of a directory is EPERM in Node.
        if (UNLINK_SYSCALLS.has(base) && isDir(path)) return UV_EPERM;
        // Reading/writing a directory as a file is EISDIR in Node.
        if (CONTENT_SYSCALLS.has(base) && isDir(path)) return UV_EISDIR;
        // The DOS read-only attribute blocking a write is EPERM in Node, not
        // EACCES (measured: openSync(ro,'w'), appendFileSync(ro), writeFileSync(ro)).
        // A read-only *open* of such a file succeeds, so reaching here means write
        // intent. An ACL denial on a writable file keeps EACCES, which is correct.
        if (READONLY_EPERM_SYSCALLS.has(base) && isReadonlyFile(path)) return UV_EPERM;
        // A handle held without FILE_SHARE_DELETE. See isShareViolation above:
        // libuv reports EBUSY for a blocked file and EPERM for a directory whose
        // child is blocked. Checked last so the ACL/readonly cases above win.
        if (UNLINK_SYSCALLS.has(base) && isShareViolation(path)) return UV_EBUSY;
        if (base === 'rename') {
            if (isDir(path)) return UV_EPERM;
            if (isShareViolation(path)) return UV_EBUSY;
        }
        return raw;
    }

    // Retained for the paths mod_fs.c does not route through fs_errno2uv (and
    // for CRT EPERM(1), which still decodes to ERROR_INVALID_FUNCTION).
    if (raw === UV_EINVAL) {
        // rmdir of a non-directory: Windows says "not a directory", Node reports
        // ENOENT — there is no *directory* of that name (measured v24.18.0).
        if (base === 'rmdir' && path && lexists(path) && !isDir(path)) return UV_ENOENT;
        if (UNLINK_SYSCALLS.has(base) && path && isDir(path)) return UV_EPERM;
        if (CONTENT_SYSCALLS.has(base) && path && isDir(path)) return UV_EISDIR;
        return raw;
    }

    // truncate of a directory arrives as a genuine EPERM; Node reports EINVAL.
    if (raw === UV_EPERM && base === 'truncate' && path && isDir(path)) return UV_EINVAL;

    if (raw === UV_UNKNOWN) {
        if (path && isNonEmptyDir(path)) return UV_ENOTEMPTY;
        // symlink/link via GetLastError lose ERROR_ALREADY_EXISTS on this host.
        // A directory already in the way is EPERM in Node, not EEXIST — same
        // distinction as the UV_EXDEV branch above.
        if (EEXIST_SYSCALLS.has(base) && path && lexists(path)) {
            return isDir(path) ? UV_EPERM : UV_EEXIST;
        }
        if (FD_SYSCALLS.has(base)) return UV_EBADF;
        return raw;
    }

    return raw;
}

/**
 * Rewrite a native sync error in place so downstream errno wrapping sees the
 * corrected numeric code. Non-errno errors pass through untouched.
 */
export function fixSyncError(e: unknown, syscall?: string, path?: string, dest?: string): unknown {
    if (!(e instanceof Error)) return e;
    const raw = Reflect.get(e, 'code');

    // Native readlink/symlink/copyFile failures arrive as a bare TypeError with a
    // localized message and no errno. Probe the filesystem — never parse the
    // message (it is localized; this host reports Chinese).
    //
    // These C throw sites are NOT Windows-only (`mod_fs.c` throws a bare
    // TypeError on the POSIX leg too, e.g. "Source is not a regular file" at the
    // `!S_ISREG` check), so this block stays live on every platform. The *value*
    // still differs per platform and is selected explicitly below.
    if (raw === undefined) {
        const base = baseSyscall(syscall);

        // `mod_fs.c` rejects several fd operations with a bare TypeError carrying
        // no errno at all — measured: `futimes` ("futimes: invalid file
        // descriptor"), `fchown` ("… not supported on Windows"). Node
        // reports EBADF for a bad descriptor, so an errno-less throw on a
        // provably-closed fd is EBADF. Checked first: it needs no path probing.
        //
        // `fchmod` was in that list until 2026-08-04. It now delegates to
        // uv_fs_fchmod (mod_fs.c:2733), whose VERIFY_FD yields a real UV_EBADF,
        // so it no longer reaches this errno-less block at all. It stays in the
        // FD_SYSCALLS set above because that set is also consulted for the
        // defined-errno path below.
        if (failedOnBadFd(syscall, path)) return rebuild(e, UV_EBADF, syscall, path);

        // A directory already in the way is EPERM in Node on Windows; a file is
        // EEXIST (measured v24.18.0: symlink onto a dir → EPERM even when empty).
        // POSIX has no such split — `symlink(2)`/`link(2)`/`mkdir(2)` onto any
        // existing name is EEXIST — so the isDir refinement is Windows-only.
        if (path && EEXIST_SYSCALLS.has(base) && lexists(path)) {
            return rebuild(e, isWindows && isDir(path) ? UV_EPERM : UV_EEXIST, syscall, path);
        }

        // readlink of a non-reparse-point is EINVAL; of a missing path, ENOENT.
        // Holds for a plain file and for a directory (measured, empty or not).
        // Ungated: EINVAL/ENOENT is also exactly what `readlink(2)` reports, so
        // the rule is correct on POSIX. (It is unreachable there in practice —
        // the POSIX leg of `tjs_syncfs_readlink` already routes through
        // `tjs_throw_errno_path`, so `raw` is a number — but it costs nothing.)
        if (path && base === 'readlink' && !isSymlink(path)) {
            return rebuild(e, lexists(path) ? UV_EINVAL : UV_ENOENT, syscall, path);
        }

        // copyFile onto a directory is EPERM on Windows. `path` is the SOURCE
        // here, so the blocking entry must be read from `dest`.
        //
        // POSIX differs: `uv__fs_copyfile` opens the destination with
        // `O_WRONLY|O_CREAT`, which a directory rejects with EISDIR, so Node
        // reports EISDIR (REASONED from the vendored
        // `deps/libuv/src/unix/fs.c:1283`; not measured — no POSIX host here).
        if (base === 'copyFile' && dest && isDir(dest)) {
            return rebuild(e, isWindows ? UV_EPERM : UV_EISDIR, syscall, path);
        }

        // copyFile *from* a directory is also EPERM in Node on Windows (measured
        // v24.18.0, empty or not). mod_fs.c:1770 rejects this before touching the
        // FS with a bare `JS_ThrowTypeError("Source is a directory, not a file")`,
        // which carries no errno at all — so it arrived as code 'UNKNOWN' and no
        // `e.code === 'EPERM'` check could ever match. Checked after the dest
        // rule so a dir->dir copy still reports on the same footing.
        //
        // On POSIX the C leg throws "Source is not a regular file" from the
        // `!S_ISREG` check at mod_fs.c:1819, equally errno-less. Node there gets
        // EISDIR from reading the directory fd (REASONED, same libuv reading).
        if (base === 'copyFile' && path && isDir(path)) {
            return rebuild(e, isWindows ? UV_EPERM : UV_EISDIR, syscall, path);
        }
    }

    if (typeof raw !== 'number') return e;

    const fixed = correctSyncErrno(raw, syscall, path, dest);
    if (fixed === raw) return e;
    return rebuild(e, fixed, syscall, path);
}

/**
 * Rebuild so the message matches the corrected code, keeping the stack.
 *
 * An fd syscall's `path` is the synthetic `fd:N` form, which Node never puts in
 * a message — measured v24.18.0: `fsyncSync(9999)` reports exactly
 * "EBADF: bad file descriptor, fsync", with no path clause. So suppress the
 * clause for fd paths rather than quoting a string no real Node ever prints.
 */
function rebuild(e: Error, code: number, syscall?: string, path?: string): Error {
    const name = baseSyscall(syscall);
    const suffix = fdFromPath(path) >= 0
        ? (name ? `, ${name}` : '')
        : (path ? `, ${name || 'path'} '${path}'` : '');
    const next = new Error(error.strerror(code) + suffix);
    Reflect.set(next, 'code', code);
    if (e.stack) next.stack = e.stack;
    return next;
}

/**
 * `toErrnoException`, then correct `syscall` to the libuv name node reports.
 *
 * Split out rather than folded into `_internal/errno` because that module is
 * shared with net/dns/child_process, whose syscall names are already correct and
 * follow different conventions (`spawn <cmd>`, `getaddrinfo`). Only `fs` needs
 * the translation.
 *
 * The mapping runs *after* conversion because several libuv names depend on the
 * resolved code, not just the API — see STEP_BY_CODE in `syscall-names.ts`
 * (`readFile` is 'open' for ENOENT but 'read' for EISDIR).
 *
 * Guarded on `err.syscall === syscall`: only the JS name we just passed in is
 * rewritten. A nested wrapper that already stamped a specific step (rm's inner
 * 'lstat') is left alone, since `toErrnoException` returns an
 * already-string-coded error untouched and its name is more precise than ours.
 */
function toFsErrnoException(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): NodeJS.ErrnoException {
    const err = toErrnoException(e, syscall, path, dest);
    if (syscall !== undefined && err.syscall === syscall) {
        const uv = uvSyscall(syscall, err.code);
        if (uv !== undefined) err.syscall = uv;
    }
    return err;
}

/**
 * Drop-in replacement for `_internal/errno`'s toErrnoException for errors that
 * came out of the native *sync* fs module. Never use on asyncfs errors: those
 * already carry correct UV codes and a real EXDEV would be rewritten to EEXIST.
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
 * Deliberately does NOT call `fixSyncError`: asyncfs goes through libuv and its
 * errno values are already correct, so the numeric corrections would corrupt
 * them (a genuine EXDEV would become EEXIST). Only the syscall name is fixed.
 */
export function toAsyncFsErrnoException(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): NodeJS.ErrnoException {
    return toFsErrnoException(e, syscall, path, dest);
}

/** Promise form of `toAsyncFsErrnoException`, mirroring `_internal/errno`'s wrapPromise. */
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
 * `normalizeErrnoError` for the async fs layers: preserves ordinary JS errors but
 * gives errno errors Node's shape *and* the libuv syscall name. Same reason
 * `toAsyncFsErrnoException` exists — the `_internal` version is shared with
 * modules whose syscall names must not be remapped.
 */
export function normalizeFsErrnoError(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): Error {
    if (e instanceof Error) {
        const code = Reflect.get(e, 'code');
        if (typeof code === 'number' || typeof code === 'string') {
            return toFsErrnoException(e, syscall, path, dest);
        }
        return e;
    }
    return new Error(String(e));
}
