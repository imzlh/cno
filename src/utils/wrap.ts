const error = import.meta.use('error');
import { errors } from "../deno/01_errors";

export function wrapFSErr(e: CModuleError.Error): never {
    if (!(e instanceof Error) || !e.code) throw e;

    /* Unix path – always available */
    switch (e.code) {
        case error.errno.ENOENT: throw new errors.NotFound(e.message);
        case error.errno.EINTR: throw new errors.Interrupted(e.message);
        case error.errno.EIO: throw new errors.InvalidData(e.message);
        case error.errno.EAGAIN: throw new errors.WouldBlock(e.message);
        case error.errno.ENOMEM: throw new errors.Busy(e.message);
        case error.errno.EACCES: throw new errors.PermissionDenied(e.message);
        case error.errno.EFAULT: throw new errors.InvalidData(e.message);
        case error.errno.EBUSY: throw new errors.Busy(e.message);
        case error.errno.EEXIST: throw new errors.AlreadyExists(e.message);
        case error.errno.ENOTDIR: throw new errors.NotADirectory(e.message);
        case error.errno.EISDIR: throw new errors.IsADirectory(e.message);
        case error.errno.EINVAL: throw new errors.InvalidData(e.message);
        case error.errno.ENFILE: throw new errors.Busy(e.message);
        case error.errno.EMFILE: throw new errors.Busy(e.message);
        case error.errno.EPIPE: throw new errors.BrokenPipe(e.message);
        case error.errno.ERANGE: throw new errors.InvalidData(e.message);
        case error.errno.ENOTEMPTY: throw new errors.AlreadyExists(e.message);
        case error.errno.ELOOP: throw new errors.FilesystemLoop(e.message);
        case error.errno.ETIMEDOUT: throw new errors.TimedOut(e.message);
        case error.errno.EBADF: throw new errors.BadResource(e.message);
        default: throw new errors.NotSupported(error.strerror(e.code));
    }
}

export function __wrap_fs_func(obj: Function) {
    return function (this: any) {
        try {
            const ret = obj.apply(this, arguments);
            if (ret instanceof Promise) {
                return ret.catch(wrapFSErr);
            } else {
                return ret;
            }
        } catch (e) {
            return wrapFSErr(e as any);
        }
    };
}

export function wrapFSns(fsFunc: Partial<typeof Deno>): Partial<typeof Deno> {
    const newFs: Record<string, unknown> = {};
    const oldFs: Record<string, unknown> = fsFunc;
    for (const key in oldFs) {
        const obj = oldFs[key];
        if (typeof obj === "function") {
            newFs[key] = __wrap_fs_func(obj);
        } else {
            newFs[key] = obj;
        }
    }
    return newFs;
};

export function wrapFsClassDec(target: Function, context: ClassMethodDecoratorContext<any, any>) {
    return __wrap_fs_func(target);
}