import { errors } from "../deno/01_errors";
import { errnoName, errorCode, isErrorValue } from './errno';

const error = import.meta.use('error');
const engine = import.meta.use('engine');

export function wrapFSErr(value: unknown): unknown {
    if (!isErrorValue(value)) return value;

    const code = errorCode(value);
    if (typeof code !== 'number' || !(code < 0)) return value;

    switch (code) {
        // File system
        case error.errno.ENOENT: return new errors.NotFound(value.message);
        case error.errno.EEXIST: return new errors.AlreadyExists(value.message);
        case error.errno.EACCES:
        case error.errno.EPERM: return new errors.PermissionDenied(value.message);
        case error.errno.EISDIR: return new errors.IsADirectory(value.message);
        case error.errno.ENOTDIR: return new errors.NotADirectory(value.message);
        case error.errno.EROFS: return new errors.PermissionDenied(value.message);
        case error.errno.ENOTEMPTY:
        case error.errno.ENOSPC: {
            // Deno keeps these codes on plain errors. Do not mutate a native
            // error, which can be frozen or belong to another realm.
            const target = Object.assign(new Error(value.message), { code: errnoName(code) });
            const stack = Object.getOwnPropertyDescriptor(value, 'stack');
            if (stack && 'value' in stack) {
                Object.defineProperty(target, 'stack', {
                    value: stack.value,
                    writable: true,
                    configurable: true,
                });
            }
            return target;
        }
        case error.errno.ELOOP: return new errors.FilesystemLoop(value.message);
        case error.errno.ENAMETOOLONG:
        case error.errno.EFBIG:
        case error.errno.ESPIPE:
        case error.errno.EXDEV:
        case error.errno.EILSEQ: return new errors.InvalidData(value.message);
        // Resource and I/O
        case error.errno.ENOMEM:
        case error.errno.ENFILE:
        case error.errno.EMFILE:
        case error.errno.ETXTBSY:
        case error.errno.EBUSY:
        case error.errno.ENOBUFS: return new errors.Busy(value.message);
        case error.errno.ESRCH: return new errors.NotFound(value.message);
        case error.errno.EIO:
        case error.errno.EFAULT:
        case error.errno.EINVAL:
        case error.errno.ERANGE: return new errors.InvalidData(value.message);
        case error.errno.EAGAIN: return new errors.WouldBlock(value.message);
        case error.errno.EINTR: return new errors.Interrupted(value.message);
        case error.errno.ENOSYS:
        case error.errno.ENOTSUP: return new errors.NotSupported(value.message);
        // Pipes and network
        case error.errno.EPIPE: return new errors.BrokenPipe(value.message);
        case error.errno.EOF: return new errors.UnexpectedEof(value.message);
        case error.errno.ECONNRESET: return new errors.ConnectionReset(value.message);
        case error.errno.ECONNABORTED: return new errors.ConnectionAborted(value.message);
        case error.errno.ECONNREFUSED: return new errors.ConnectionRefused(value.message);
        case error.errno.ENOTCONN:
        case error.errno.ESHUTDOWN: return new errors.NotConnected(value.message);
        case error.errno.EISCONN: return new errors.InvalidData(value.message);
        case error.errno.ETIMEDOUT: return new errors.TimedOut(value.message);
        case error.errno.ECANCELED: return new errors.Interrupted(value.message);
        case error.errno.EADDRINUSE: return new errors.AddrInUse(value.message);
        case error.errno.EADDRNOTAVAIL:
        case error.errno.EAFNOSUPPORT: return new errors.AddrNotAvailable(value.message);
        case error.errno.ENETUNREACH:
        case error.errno.EHOSTUNREACH: return new errors.NetworkUnreachable(value.message);
        case error.errno.EPROTONOSUPPORT:
        case error.errno.EPROTOTYPE: return new errors.NotSupported(value.message);
        case error.errno.ENOPROTOOPT:
        case error.errno.EMSGSIZE:
        case error.errno.EDESTADDRREQ: return new errors.InvalidData(value.message);
        case error.errno.EBADF: return new errors.BadResource(value.message);
        default: return new errors.NotSupported(error.strerror(code));
    }
}

export function __wrap_fs_func<This, Args extends unknown[], Return>(
    method: (this: This, ...args: Args) => Return,
): (this: This, ...args: Args) => Return {
    function wrappedDenoErrorMethod(this: This, ...args: Args): Return {
        try {
            const result = method.apply(this, args);
            if (engine.isPromise(result)) {
                return Promise.prototype.then.call(result, undefined, value => {
                    throw wrapFSErr(value);
                }) as Return;
            }
            return result;
        } catch (value) {
            throw wrapFSErr(value);
        }
    }
    return wrappedDenoErrorMethod;
}

export function wrapFSns(fsFunc: Partial<typeof Deno>): Partial<typeof Deno> {
    const wrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fsFunc)) {
        wrapped[key] = typeof value === 'function'
            ? __wrap_fs_func(value as (this: unknown, ...args: unknown[]) => unknown)
            : value;
    }
    return wrapped;
}

export function wrapDenoError<This, Args extends unknown[], Return>(
    method: (this: This, ...args: Args) => Return,
    _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
): (this: This, ...args: Args) => Return {
    return __wrap_fs_func(method);
}

export { wrapDenoError as wrapFsClassDec };
