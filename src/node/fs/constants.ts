/**
 * Node.js fs module - constant definitions
 */

const fs = import.meta.use('fs');
const os = import.meta.use('os');

const sysname = os.uname().sysname;
const isWindows = sysname === 'Windows_NT';
const isDarwin = sysname === 'Darwin';
const isLinux = sysname === 'Linux';

export const constants = {
    // File open flags
    O_RDONLY: fs.OPEN_RDONLY,
    O_WRONLY: fs.OPEN_WRONLY,
    O_RDWR: fs.OPEN_RDWR,
    O_CREAT: fs.OPEN_CREAT,
    O_EXCL: fs.OPEN_EXCL,
    O_TRUNC: fs.OPEN_TRUNC,
    O_APPEND: fs.OPEN_APPEND,
    O_DIRECT: isLinux ? 0o40000 : undefined,
    O_NOATIME: isLinux ? 0o1000000 : undefined,
    O_SYMLINK: isDarwin ? 0x200000 : undefined,
    UV_FS_O_FILEMAP: isWindows ? 0x20000000 : 0,

    // File types (POSIX values; host may only export a subset on CModuleFS)
    S_IFMT: fs.S_IFMT ?? 0o170000,
    S_IFREG: fs.S_IFREG ?? 0o100000,
    S_IFDIR: fs.S_IFDIR ?? 0o040000,
    S_IFCHR: 0o020000,
    S_IFBLK: 0o060000,
    S_IFIFO: 0o010000,
    S_IFLNK: 0o120000,
    S_IFSOCK: 0o140000,

    // Permission bits - user
    S_IRWXU: fs.S_IRWXU,
    S_IRUSR: fs.S_IRUSR,
    S_IWUSR: fs.S_IWUSR,
    S_IXUSR: fs.S_IXUSR,

    // Permission bits - group
    S_IRWXG: fs.S_IRWXG,
    S_IRGRP: fs.S_IRGRP,
    S_IWGRP: fs.S_IWGRP,
    S_IXGRP: fs.S_IXGRP,

    // Permission bits - others
    S_IRWXO: fs.S_IRWXO,
    S_IROTH: fs.S_IROTH,
    S_IWOTH: fs.S_IWOTH,
    S_IXOTH: fs.S_IXOTH,

    // Lock constants
    LOCK_SH: fs.LOCK_SH,
    LOCK_EX: fs.LOCK_EX,
    LOCK_NB: fs.LOCK_NB,
    LOCK_UN: fs.LOCK_UN,

    // Access constants
    F_OK: fs.F_OK,
    R_OK: fs.R_OK,
    W_OK: fs.W_OK,
    X_OK: fs.X_OK,

    // copyFile mode flags
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
};

// Export individual constants (Node.js compatible)
export const {
    O_RDONLY,
    O_WRONLY,
    O_RDWR,
    O_CREAT,
    O_EXCL,
    O_TRUNC,
    O_APPEND,
    O_DIRECT,
    O_NOATIME,
    O_SYMLINK,
    UV_FS_O_FILEMAP,
    S_IFMT,
    S_IFREG,
    S_IFDIR,
    S_IFCHR,
    S_IFBLK,
    S_IFIFO,
    S_IFLNK,
    S_IFSOCK,
    S_IRWXU,
    S_IRUSR,
    S_IWUSR,
    S_IXUSR,
    S_IRWXG,
    S_IRGRP,
    S_IWGRP,
    S_IXGRP,
    S_IRWXO,
    S_IROTH,
    S_IWOTH,
    S_IXOTH,
    LOCK_SH,
    LOCK_EX,
    LOCK_NB,
    LOCK_UN,
    F_OK,
    R_OK,
    W_OK,
    X_OK,
    COPYFILE_EXCL,
    COPYFILE_FICLONE,
    COPYFILE_FICLONE_FORCE,
} = constants;
