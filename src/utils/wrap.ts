import { errors } from "../deno/01_errors";

const error = import.meta.use('error');

function getErrorCode(e: Error): string | number | undefined {
    if (!('code' in e)) return undefined;
    const code = Reflect.get(e, 'code');
    return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

export function wrapFSErr(e: unknown): unknown {
    if (e instanceof Error && e.constructor?.name === 'DOMException') return e;
    if (!(e instanceof Error)) return e;

    const code = getErrorCode(e);
    if (code === undefined || typeof code === 'string') return e;

    switch (code) {
        // ── File system ──────────────────────────────────────────────────────
        case error.errno.ENOENT: return new errors.NotFound(e.message);
        case error.errno.EEXIST: return new errors.AlreadyExists(e.message);
        case error.errno.EACCES: return new errors.PermissionDenied(e.message);
        case error.errno.EISDIR: return new errors.IsADirectory(e.message);
        case error.errno.ENOTDIR: return new errors.NotADirectory(e.message);
        case error.errno.EROFS: return new errors.PermissionDenied(e.message);
        case error.errno.ENOTEMPTY: return new errors.AlreadyExists(e.message);
        case error.errno.ELOOP: return new errors.FilesystemLoop(e.message);
        case error.errno.ENAMETOOLONG: return new errors.InvalidData(e.message);
        case error.errno.EFBIG: return new errors.InvalidData(e.message);
        case error.errno.ESPIPE: return new errors.InvalidData(e.message);
        case error.errno.ETXTBSY: return new errors.Busy(e.message);
        case error.errno.EXDEV: return new errors.InvalidData(e.message);
        case error.errno.EILSEQ: return new errors.InvalidData(e.message);
        // ── Resource / memory ────────────────────────────────────────────────
        case error.errno.ENOMEM: return new errors.Busy(e.message);
        case error.errno.ENOSPC: return new errors.Busy(e.message);
        case error.errno.ENFILE: return new errors.Busy(e.message);
        case error.errno.EMFILE: return new errors.Busy(e.message);
        case error.errno.ESRCH: return new errors.NotFound(e.message);
        case error.errno.EBUSY: return new errors.Busy(e.message);
        case error.errno.ENOBUFS: return new errors.Busy(e.message);
        // ── I/O ──────────────────────────────────────────────────────────────
        case error.errno.EIO: return new errors.InvalidData(e.message);
        case error.errno.EAGAIN: return new errors.WouldBlock(e.message);
        case error.errno.EINTR: return new errors.Interrupted(e.message);
        case error.errno.EFAULT: return new errors.InvalidData(e.message);
        case error.errno.EINVAL: return new errors.InvalidData(e.message);
        case error.errno.ERANGE: return new errors.InvalidData(e.message);
        case error.errno.ENOSYS: return new errors.NotSupported(e.message);
        // ── Pipes / streams ──────────────────────────────────────────────────
        case error.errno.EPIPE: return new errors.BrokenPipe(e.message);
        // ── Network: connection ──────────────────────────────────────────────
        case error.errno.ECONNRESET: return new errors.ConnectionReset(e.message);
        case error.errno.ECONNABORTED: return new errors.ConnectionAborted(e.message);
        case error.errno.ECONNREFUSED: return new errors.ConnectionRefused(e.message);
        case error.errno.ENOTCONN: return new errors.NotConnected(e.message);
        case error.errno.ESHUTDOWN: return new errors.NotConnected(e.message);
        case error.errno.EISCONN: return new errors.InvalidData(e.message);
        case error.errno.ETIMEDOUT: return new errors.TimedOut(e.message);
        // ── Network: addresses ───────────────────────────────────────────────
        case error.errno.EADDRINUSE: return new errors.AddrInUse(e.message);
        case error.errno.EADDRNOTAVAIL: return new errors.AddrNotAvailable(e.message);
        case error.errno.EAFNOSUPPORT: return new errors.AddrNotAvailable(e.message);
        case error.errno.ENETUNREACH: return new errors.NetworkUnreachable(e.message);
        case error.errno.EHOSTUNREACH: return new errors.NetworkUnreachable(e.message);
        // ── Network: protocol ────────────────────────────────────────────────
        case error.errno.EPROTONOSUPPORT: return new errors.NotSupported(e.message);
        case error.errno.EPROTOTYPE: return new errors.NotSupported(e.message);
        case error.errno.ENOPROTOOPT: return new errors.InvalidData(e.message);
        case error.errno.EOPNOTSUPP: return new errors.NotSupported(e.message);
        // ── Network: messages ────────────────────────────────────────────────
        case error.errno.EMSGSIZE: return new errors.InvalidData(e.message);
        case error.errno.EDESTADDRREQ: return new errors.InvalidData(e.message);
        // ── Socket ───────────────────────────────────────────────────────────
        case error.errno.EBADF: return new errors.BadResource(e.message);
        // ── Default ─────────────────────────────────────────────────────────
        default: return new errors.NotSupported(error.strerror(code));
    }
}

function __rethrow(e: unknown, _stack: string): never {
    if (typeof e !== "object" || e === null) throw e;
    const stack = _stack.substring(_stack.indexOf('\n') + 1);
    Object.defineProperty(e, 'stack', { value: stack });
    throw e;
}

export function __wrap_fs_func<This, Args extends unknown[], Return>(
    obj: (this: This, ...args: Args) => Return
): (this: This, ...args: Args) => Return {
    function wrappedFsFunc(this: This, ...args: Args): Return {
        const stack = new Error().stack ?? '';
        try {
            const ret = obj.apply(this, args);
            if (ret instanceof Promise) {
                return ret.catch(e => __rethrow(wrapFSErr(e), stack)) as Return;
            } else {
                return ret;
            }
        } catch (e) {
            return __rethrow(wrapFSErr(e), stack);
        }
    }
    return wrappedFsFunc;
}

export function wrapFSns(fsFunc: Partial<typeof Deno>): Partial<typeof Deno> {
    const newFs: Record<string, unknown> = {};
    const oldFs: Record<string, unknown> = fsFunc;
    for (const key in oldFs) {
        const obj = oldFs[key];
        if (typeof obj === "function") {
            newFs[key] = __wrap_fs_func(obj as (this: unknown, ...args: unknown[]) => unknown);
        } else {
            newFs[key] = obj;
        }
    }
    return newFs;
};

export function wrapFsClassDec<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
): (this: This, ...args: Args) => Return {
    return __wrap_fs_func(target);
}
