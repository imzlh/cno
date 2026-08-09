/**
 * `err.syscall` for `fs` errors: the **libuv operation name**, not the JS API name.
 *
 * WHY THIS TABLE EXISTS AT ALL. Node does not report the function you called. It
 * reports the name of the libuv call that actually failed, and real packages
 * branch on it — `graceful-fs`, `rimraf`, `fs-extra` and `chokidar` all test
 * `err.syscall === 'open'` / `=== 'scandir'`. Before this table cno reported the
 * JS name (`readFileSync`, `statSync`, `readdirSync`), so every one of those
 * checks silently took the wrong branch.
 *
 * The names are NOT derivable from the JS name, which is the whole point:
 *
 *     readdir   -> scandir      (libuv calls it uv_fs_scandir)
 *     copyFile  -> copyfile     (lowercase, no camel hump)
 *     utimes    -> utime        (singular!)  lutimes -> lutime, futimes -> futime
 *     realpath  -> lstat        (sync/callback resolve by walking with lstat)
 *     rm, cp    -> lstat        (both probe the target before doing anything)
 *     truncate  -> open         (node opens the path, then ftruncates the fd)
 *
 * So do not "simplify" this away into `name.replace(/Sync$/, '')`. That is
 * exactly the bug it fixes. Every value below was measured against real node
 * v24.18.0 on this platform by triggering the failure and reading `err.syscall`;
 * where node's answer is surprising it is recorded as measured, not normalised.
 *
 * SCOPE. Call sites keep passing the **JS** name, because `errno-fix.ts` keys ~30
 * numeric-errno corrections off it (`CONTENT_SYSCALLS`, `TWO_PATH_SYSCALLS`, …).
 * Translation happens only at the moment the field is stamped onto the error, so
 * those rules are untouched. `FileHandle` methods do NOT come through here: node
 * uses a *different* set of names for them (`fh.utimes` reports 'futimes' where
 * module-level `futimes` reports 'futime'), and they are already correct at their
 * own call sites in `utils.ts`.
 */

/**
 * JS API name (minus any `Sync`) -> libuv name for the step that usually fails.
 * Identity entries are kept explicit: they document "measured, node agrees" and
 * stop a future reader assuming the omission means "unverified".
 */
const UV_NAME: Record<string, string> = {
    // --- content ops. The reported step depends on the errno; see STEP_BY_CODE.
    readFile: 'open',
    writeFile: 'open',
    appendFile: 'open',

    // --- open/close and fd data transfer
    open: 'open',
    close: 'close',
    read: 'read',
    write: 'write',
    // Module-level readv/writev collapse onto read/write. (FileHandle.readv does
    // NOT — it reports 'readv'. That path bypasses this table.)
    readv: 'read',
    writev: 'write',

    // --- metadata
    stat: 'stat',
    lstat: 'lstat',
    fstat: 'fstat',
    statfs: 'statfs',
    access: 'access',

    // --- directories
    readdir: 'scandir',
    opendir: 'opendir',
    mkdir: 'mkdir',
    rmdir: 'rmdir',
    mkdtemp: 'mkdtemp',

    // --- removal / copy. Both lstat the target first, and that probe is what
    // fails for a missing path — the overwhelmingly common case.
    unlink: 'unlink',
    rm: 'lstat',
    cp: 'lstat',

    // --- size
    // `truncate(path)` has no libuv equivalent: node opens the path and then
    // ftruncates the fd, so a missing path is reported against 'open' and a
    // directory (which opens fine) against 'ftruncate'.
    truncate: 'open',
    ftruncate: 'ftruncate',

    // --- links. `realpath` walks the path with lstat in the sync/callback forms,
    // so that is the name node reports; `fs.promises.realpath` and
    // `realpathSync.native` call uv_fs_realpath and report 'realpath'.
    realpath: 'lstat',
    // Node's own inconsistency, measured on v24.18.0 against a missing path:
    //   realpathSync(p) / fs.realpath(p, cb)   -> 'lstat'
    //   realpathSync.native(p) / fs.realpath.native -> 'realpath'
    //   fs.promises.realpath(p)                -> 'realpath'
    // So the promises form reports the *direct* uv call even though it is not
    // spelled `.native`, and shares this key with the `.native` entry points.
    // cno makes a single native realpath call on every path, so the distinction
    // cannot come from the implementation — the call site has to pick.
    realpathNative: 'realpath',
    readlink: 'readlink',
    link: 'link',
    symlink: 'symlink',

    // --- permissions and ownership
    chmod: 'chmod',
    fchmod: 'fchmod',
    lchmod: 'lchmod',
    chown: 'chown',
    fchown: 'fchown',
    lchown: 'lchown',

    // --- timestamps. Singular, and it is not a typo: libuv is uv_fs_utime.
    utimes: 'utime',
    lutimes: 'lutime',
    futimes: 'futime',

    // --- flush
    fsync: 'fsync',
    fdatasync: 'fdatasync',

    // --- two-path
    rename: 'rename',
    copyFile: 'copyfile',

    // --- watching
    watch: 'watch',
    watchFile: 'stat',
};

/**
 * Where node names a different step depending on which one failed. Keyed by the
 * resolved Node string code, checked before the default above.
 *
 * `readFile` is the clearest case, all measured on v24.18.0:
 *   readFileSync(missing) -> ENOENT, syscall 'open'   (the open failed)
 *   readFileSync(dir)     -> EISDIR, syscall 'read'   (dir opens, the read fails)
 *   readFileSync(badFd)   -> EBADF,  syscall 'fstat'  (it fstats to size the read)
 *
 * `writeFile`/`appendFile` split the same way: with 'w' the O_TRUNC open is
 * refused (EISDIR against 'open'), while with 'a' the open succeeds and the
 * write is refused (EISDIR against 'write'). cno reaches the native call as one
 * step and cannot see which half failed, so the errno decides — which lands on
 * node's answer for the default flag of each API. Documented divergence:
 * `writeFileSync(dir, data, {flag:'a'})` reports 'open' here where node says
 * 'write'; an explicit append flag on a directory is not a case anything branches on.
 */
const STEP_BY_CODE: Record<string, Record<string, string>> = {
    readFile: { EISDIR: 'read', EBADF: 'fstat' },
    writeFile: { EISDIR: 'open', EBADF: 'write' },
    appendFile: { EISDIR: 'write', EBADF: 'write' },
    truncate: { EINVAL: 'ftruncate' },
};

/** Call sites spell syscalls with or without the `Sync` suffix. */
function baseName(syscall: string): string {
    return syscall.endsWith('Sync') ? syscall.slice(0, -4) : syscall;
}

/**
 * Translate a JS API name to the libuv name node reports.
 *
 * Unknown names pass through unchanged, which is deliberate and load-bearing:
 * call sites that already know the exact failing step pass it directly (`'lstat'`
 * for rm's probe, `'copyfile'` from the copy helper) and must not be rewritten,
 * and cno-only operations with no node equivalent (`flock`) keep their name.
 *
 * @param syscall JS API name, with or without a `Sync` suffix
 * @param code    resolved Node string code (`'ENOENT'`), when known
 */
export function uvSyscall(syscall?: string, code?: string): string | undefined {
    if (!syscall) return syscall;
    const base = baseName(syscall);
    if (code !== undefined) {
        const refined = STEP_BY_CODE[base]?.[code];
        if (refined !== undefined) return refined;
    }
    return UV_NAME[base] ?? base;
}
