/**
 * Node.js fs 模块 - 常量定义
 */

const fs = import.meta.use('fs');

export const constants = {
    // 文件打开标志
    O_RDONLY: fs.OPEN_RDONLY,
    O_WRONLY: fs.OPEN_WRONLY,
    O_RDWR: fs.OPEN_RDWR,
    O_CREAT: fs.OPEN_CREAT,
    O_EXCL: fs.OPEN_EXCL,
    O_TRUNC: fs.OPEN_TRUNC,
    O_APPEND: fs.OPEN_APPEND,

    // 文件类型
    S_IFMT: fs.S_IFMT,
    S_IFREG: fs.S_IFREG,
    S_IFDIR: fs.S_IFDIR,

    // 权限位 - 用户
    S_IRWXU: fs.S_IRWXU,
    S_IRUSR: fs.S_IRUSR,
    S_IWUSR: fs.S_IWUSR,
    S_IXUSR: fs.S_IXUSR,

    // 权限位 - 组
    S_IRWXG: fs.S_IRWXG,
    S_IRGRP: fs.S_IRGRP,
    S_IWGRP: fs.S_IWGRP,
    S_IXGRP: fs.S_IXGRP,

    // 权限位 - 其他
    S_IRWXO: fs.S_IRWXO,
    S_IROTH: fs.S_IROTH,
    S_IWOTH: fs.S_IWOTH,
    S_IXOTH: fs.S_IXOTH,

    // 锁定常量
    LOCK_SH: fs.LOCK_SH,
    LOCK_EX: fs.LOCK_EX,
    LOCK_NB: fs.LOCK_NB,
    LOCK_UN: fs.LOCK_UN,

    // 访问常量
    F_OK: fs.F_OK,
    R_OK: fs.R_OK,
    W_OK: fs.W_OK,
    X_OK: fs.X_OK,
};

// 导出单独的常量（兼容 Node.js 风格）
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
