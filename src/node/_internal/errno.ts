/**
 * Node.js errno 错误封装工具
 * 将 C 模块的 errno 错误（CModuleError.Error，带负值的 .code）
 * 转换为 Node.js 的 ErrnoException（带字符串 .code 如 "ENOENT"）
 *
 * 参考 Deno 的 wrapFSErr 实现（src/utils/wrap.ts），
 * 但输出 Node.js 风格的 ErrnoException 而非 Deno errors。
 */

const error = import.meta.use('error');

// errno 值 → Node.js 错误码字符串 的映射
// 仅包含 CModuleError.errno 类型中实际定义的常量
const errnoToString: Record<number, string> = {
    [error.errno.EACCES]:       'EACCES',
    [error.errno.EADDRINUSE]:   'EADDRINUSE',
    [error.errno.EADDRNOTAVAIL]:'EADDRNOTAVAIL',
    [error.errno.EAFNOSUPPORT]: 'EAFNOSUPPORT',
    [error.errno.EAGAIN]:       'EAGAIN',
    [error.errno.EALREADY]:     'EALREADY',
    [error.errno.EBADF]:        'EBADF',
    [error.errno.EBUSY]:        'EBUSY',
    [error.errno.ECANCELED]:    'ECANCELED',
    [error.errno.ECONNABORTED]: 'ECONNABORTED',
    [error.errno.ECONNREFUSED]: 'ECONNREFUSED',
    [error.errno.ECONNRESET]:   'ECONNRESET',
    [error.errno.EDESTADDRREQ]: 'EDESTADDRREQ',
    [error.errno.EEXIST]:       'EEXIST',
    [error.errno.EFAULT]:       'EFAULT',
    [error.errno.EFBIG]:        'EFBIG',
    [error.errno.EHOSTDOWN]:    'EHOSTDOWN',
    [error.errno.EHOSTUNREACH]: 'EHOSTUNREACH',
    [error.errno.EILSEQ]:       'EILSEQ',
    [error.errno.EINTR]:        'EINTR',
    [error.errno.EINVAL]:       'EINVAL',
    [error.errno.EIO]:          'EIO',
    [error.errno.EISCONN]:      'EISCONN',
    [error.errno.EISDIR]:       'EISDIR',
    [error.errno.ELOOP]:        'ELOOP',
    [error.errno.EMFILE]:       'EMFILE',
    [error.errno.EMSGSIZE]:     'EMSGSIZE',
    [error.errno.ENAMETOOLONG]: 'ENAMETOOLONG',
    [error.errno.ENETDOWN]:     'ENETDOWN',
    [error.errno.ENETRESET]:    'ENETRESET',
    [error.errno.ENETUNREACH]:  'ENETUNREACH',
    [error.errno.ENFILE]:       'ENFILE',
    [error.errno.ENOBUFS]:      'ENOBUFS',
    [error.errno.ENODEV]:       'ENODEV',
    [error.errno.ENOENT]:       'ENOENT',
    [error.errno.ENOKEY]:       'ENOKEY',
    [error.errno.ENOMEM]:       'ENOMEM',
    [error.errno.ENOPROTOOPT]:  'ENOPROTOOPT',
    [error.errno.ENOSPC]:       'ENOSPC',
    [error.errno.ENOSYS]:       'ENOSYS',
    [error.errno.ENOTCONN]:     'ENOTCONN',
    [error.errno.ENOTDIR]:      'ENOTDIR',
    [error.errno.ENOTEMPTY]:    'ENOTEMPTY',
    [error.errno.ENOTSOCK]:     'ENOTSOCK',
    [error.errno.ENOTSUP]:      'ENOTSUP',
    // EOPNOTSUPP === ENOTSUP (-4051), 已在上方映射
    [error.errno.EPROTO]:       'EPROTO',
    [error.errno.EPROTONOSUPPORT]: 'EPROTONOSUPPORT',
    [error.errno.EPROTOTYPE]:   'EPROTOTYPE',
    [error.errno.ERANGE]:       'ERANGE',
    [error.errno.EREMOTEIO]:    'EREMOTEIO',
    [error.errno.EROFS]:        'EROFS',
    [error.errno.ESHUTDOWN]:    'ESHUTDOWN',
    [error.errno.ESPIPE]:       'ESPIPE',
    [error.errno.ETIMEDOUT]:    'ETIMEDOUT',
    [error.errno.ETXTBSY]:      'ETXTBSY',
    [error.errno.EXDEV]:        'EXDEV',
    [error.errno.EKEYEXPIRED]:  'EKEYEXPIRED',
    [error.errno.EKEYREVOKED]:  'EKEYREVOKED',
    [error.errno.EKEYREJECTED]: 'EKEYREJECTED',
    [error.errno.EOWNERDEAD]:   'EOWNERDEAD',
    [error.errno.ENOTRECOVERABLE]: 'ENOTRECOVERABLE',
    [error.errno.ERFKILL]:      'ERFKILL',
    [error.errno.EHWPOISON]:    'EHWPOISON',
    [error.errno.EBADMSG]:      'EBADMSG',
    [error.errno.EIDRM]:        'EIDRM',
    [error.errno.EMULTIHOP]:    'EMULTIHOP',
    [error.errno.ENODATA]:      'ENODATA',
    [error.errno.ENOLINK]:      'ENOLINK',
    [error.errno.ENOMSG]:       'ENOMSG',
    [error.errno.ENOSR]:        'ENOSR',
    [error.errno.ENOSTR]:       'ENOSTR',
    [error.errno.EOF]:          'EOF',
    [error.errno.EOVERFLOW]:    'EOVERFLOW',
    [error.errno.E2BIG]:        'E2BIG',
};

/**
 * 将 C 模块的 errno 错误转换为 Node.js ErrnoException
 * @param e - C 模块错误（CModuleError.Error，.code 为负值 errno）
 * @param syscall - 可选，系统调用名称（如 'open', 'read'）
 * @param path - 可选，文件路径
 * @returns NodeJS.ErrnoException
 */
export function toErrnoException(
    e: unknown,
    syscall?: string,
    path?: string
): NodeJS.ErrnoException {
    // 如果已经是 ErrnoException（字符串 .code），直接返回
    if (e instanceof Error && (e as any).code && typeof (e as any).code === 'string') {
        return e as NodeJS.ErrnoException;
    }

    // 非 CModuleError.Error（没有 .code 数字 errno）
    if (!(e instanceof Error) || typeof (e as any).code !== 'number') {
        const err = new Error((e as Error)?.message ?? String(e)) as NodeJS.ErrnoException;
        err.code = 'UNKNOWN';
        err.errno = error.errno.UNKNOWN;
        if (syscall) err.syscall = syscall;
        if (path) err.path = path;
        return err;
    }

    const cErr = e as CModuleError.Error & Error;
    const errnoValue = cErr.code; // 负值，如 -4061
    const codeStr = errnoToString[errnoValue] ?? `UNKNOWN(${errnoValue})`;
    const message = cErr.message || error.strerror(errnoValue) || 'Unknown error';

    const err = new Error(message) as NodeJS.ErrnoException;
    err.name = 'ErrnoException';
    err.code = codeStr;
    err.errno = errnoValue;
    if (syscall) err.syscall = syscall;
    if (path) err.path = path;

    // 保留原始 stack
    if (cErr.stack) {
        err.stack = cErr.stack;
    }

    return err;
}

/**
 * 将返回 C 模块 errno 错误的 Promise 转换为在 reject 时返回 ErrnoException
 */
export function wrapPromise<T>(
    promise: Promise<T>,
    syscall?: string,
    path?: string
): Promise<T> {
    return promise.catch((e: unknown) => {
        throw toErrnoException(e, syscall, path);
    });
}

/**
 * 将可能同步抛出 C 模块 errno 错误的函数调用转换为抛出 ErrnoException
 */
export function wrapSync<T>(
    fn: () => T,
    syscall?: string,
    path?: string
): T {
    try {
        return fn();
    } catch (e) {
        throw toErrnoException(e, syscall, path);
    }
}
