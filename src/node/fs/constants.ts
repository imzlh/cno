/**
 * Node.js fs module - constant definitions
 */

const fs = import.meta.use('fs');

export const constants = {
    // File open flags
    O_RDONLY: fs.OPEN_RDONLY,
    O_WRONLY: fs.OPEN_WRONLY,
    O_RDWR: fs.OPEN_RDWR,
    O_CREAT: fs.OPEN_CREAT,
    O_EXCL: fs.OPEN_EXCL,
    O_TRUNC: fs.OPEN_TRUNC,
    O_APPEND: fs.OPEN_APPEND,

    // File types
    S_IFMT: fs.S_IFMT,
    S_IFREG: fs.S_IFREG,
    S_IFDIR: fs.S_IFDIR,

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
    S_IFMT,
    S_IFREG,
    S_IFDIR,
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
} = constants;
