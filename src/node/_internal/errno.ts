/**
 * Node.js errno error wrapper utility
 * Wraps C module errno errors (CModuleError.Error with negative .code)
 * to Node.js ErrnoException (with string .code like "ENOENT")
 *
 * References Deno wrapFSErr implementation (src/utils/wrap.ts),
 * but outputs Node.js-style ErrnoException instead of Deno errors.
 */

const error = import.meta.use('error');

// errno value -> Node.js error code string mapping
// Only includes constants actually defined in CModuleError.errno
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
    // EOPNOTSUPP === ENOTSUP (-4051), already mapped above
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

const stringToErrno: Record<string, number> = {};
for (const [errnoValue, code] of Object.entries(errnoToString)) {
    stringToErrno[code] = Number(errnoValue);
}

type NodeErrnoError = NodeJS.ErrnoException & { dest?: string };

/**
 * Convert C module errno error to Node.js ErrnoException
 * @param e - C module error (CModuleError.Error with negative .code errno)
 * @param syscall - optional, system call name (e.g. "open", "read")
 * @param path - optional, file path
 * @returns NodeJS.ErrnoException
 */
export function toErrnoException(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): NodeJS.ErrnoException {
    if (!(e instanceof Error)) {
        const err: NodeErrnoError = new Error(e instanceof Error ? e.message : String(e));
        err.code = 'UNKNOWN';
        err.errno = error.errno.UNKNOWN;
        if (syscall) err.syscall = syscall;
        if (path) err.path = path;
        if (dest) err.dest = dest;
        return err;
    }

    const rawCode = Reflect.get(e, 'code');
    if (typeof rawCode === 'string') return e;

    // Not CModuleError.Error (no numeric .code errno)
    if (typeof rawCode !== 'number') {
        const err: NodeErrnoError = new Error(e.message);
        err.code = 'UNKNOWN';
        err.errno = error.errno.UNKNOWN;
        if (syscall) err.syscall = syscall;
        if (path) err.path = path;
        if (dest) err.dest = dest;
        return err;
    }

    const errnoValue = rawCode; // negative value, e.g. -4061
    const codeStr = errnoToString[errnoValue] ?? `UNKNOWN(${errnoValue})`;
    const message = e.message || error.strerror(errnoValue) || 'Unknown error';

    const err: NodeErrnoError = new Error(message);
    err.name = 'ErrnoException';
    err.code = codeStr;
    err.errno = errnoValue;
    if (syscall) err.syscall = syscall;
    if (path) err.path = path;
    if (dest) err.dest = dest;

    // Preserve original stack
    if (e.stack) {
        err.stack = e.stack;
    }

    return err;
}

/**
 * Preserve ordinary JS errors, but normalize C-module errno errors to Node's
 * ErrnoException shape so npm libraries can key off string error codes.
 */
export function normalizeErrnoError(
    e: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): Error {
    if (e instanceof Error) {
        const code = Reflect.get(e, 'code');
        if (typeof code === 'number' || typeof code === 'string') {
            return toErrnoException(e, syscall, path, dest);
        }
        return e;
    }
    return new Error(String(e));
}

/**
 * Match both raw numeric circu errno values and Node-style string codes.
 */
export function matchesErrnoCode(
    e: unknown,
    ...codes: string[]
): boolean {
    if (!(e instanceof Error)) return false;

    const code = Reflect.get(e, 'code');
    if (typeof code === 'string' && codes.includes(code)) return true;
    if (typeof code === 'number') {
        return codes.some((name) => stringToErrno[name] === code);
    }

    const message = String(e.message ?? '');
    return codes.some((name) => message.startsWith(`${name}:`) || message.includes(`${name}: `));
}

/**
 * Convert Promise returning C module errno error to reject with ErrnoException
 */
export function wrapPromise<T>(
    promise: Promise<T>,
    syscall?: string,
    path?: string,
    dest?: string,
): Promise<T> {
    return promise.catch((e: unknown) => {
        throw toErrnoException(e, syscall, path, dest);
    });
}

/**
 * Convert function call that may synchronously throw C module errno error to throw ErrnoException
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
        throw toErrnoException(e, syscall, path, dest);
    }
}
