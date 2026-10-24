/**
 * `err.syscall` for `fs` errors: the **libuv operation name**, not the JS API
 * name. Do not derive it from the JS name. FileHandle methods do not come here.
 */

/**
 * JS API name (minus any `Sync`) -> libuv name for the step that usually fails.
 * Identity entries are kept explicit so an omission never reads as "unverified".
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
    // Module-level readv/writev collapse onto read/write; FileHandle.readv does
    // NOT (it reports 'readv') and bypasses this table.
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

    // --- links. `realpath` walks with lstat in the sync/callback forms;
    // `fs.promises.realpath` and `realpathSync.native` report 'realpath'.
    realpath: 'lstat',
    // `.native` and `fs.promises.realpath` report 'realpath', unlike the other forms.
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
 * Translate a JS API name to the libuv name node reports. Unknown names pass
 * through unchanged, which is load-bearing: call sites that already know the
 * exact failing step (`'lstat'`, `'copyfile'`) and cno-only ops (`flock`) keep
 * their name.
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
