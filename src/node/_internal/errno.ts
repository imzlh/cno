import {
    errnoCode,
    errnoDescription,
    errnoMessage,
    errnoName,
    errorCode,
    isErrorValue,
    matchesErrnoCode,
    unknownErrno,
} from '../../utils/errno';

type ErrnoException = NodeJS.ErrnoException & { dest?: string };

export type NodeSystemError = NodeJS.ErrnoException & {
    info: {
        errno: number;
        code: string;
        message: string;
        syscall: string;
    };
};

const DISCONNECT_CODES = [
    'EPIPE',
    'ECONNRESET',
    'ECONNABORTED',
    'EBADF',
    'ECANCELED',
    'ESHUTDOWN',
    'ENOTCONN',
    'EOF',
] as const;

type ErrnoContext = {
    syscall?: string;
    path?: string;
    dest?: string;
};

function createErrnoError(message: string, errno: number, source?: Error, context: ErrnoContext = {}): ErrnoException {
    const error = new Error(message) as ErrnoException;
    error.code = errnoName(errno) ?? 'UNKNOWN';
    error.errno = errno;
    if (context.syscall !== undefined) error.syscall = context.syscall;
    if (context.path !== undefined) error.path = context.path;
    if (context.dest !== undefined) error.dest = context.dest;
    if (source?.stack) error.stack = source.stack;
    return error;
}

/**
 * Create Node's `SystemError` shape for APIs that wrap a lower-level UV call.
 * The native errno table stays in `utils/errno`; this function owns only the
 * Node-facing `info`, message and non-enumerable `name` fields.
 */
export function createSystemError(options: {
    nativeCode: string;
    syscall: string;
    code: string;
    prefix: string;
}): NodeSystemError {
    const { nativeCode, syscall, code, prefix } = options;
    const errno = errnoCode(nativeCode) ?? unknownErrno;
    const message = errnoDescription(errno);
    const error = new Error(`${prefix}: ${syscall} returned ${nativeCode} (${message})`) as NodeSystemError;

    error.code = code;
    error.errno = errno;
    error.syscall = syscall;
    error.info = { errno, code: nativeCode, message, syscall };
    Object.defineProperty(error, 'name', {
        value: 'SystemError',
        writable: true,
        configurable: true,
        enumerable: false,
    });
    return error;
}

/** Convert a native numeric UV error into the public Node errno shape. */
export function toErrnoException(
    value: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): NodeJS.ErrnoException {
    const context = { syscall, path, dest };
    if (!isErrorValue(value)) {
        return createErrnoError(String(value), unknownErrno, undefined, context);
    }

    const code = errorCode(value);
    if (typeof code === 'string' || (typeof code === 'number' && !(code < 0))) {
        return value as NodeJS.ErrnoException;
    }

    const errno = typeof code === 'number' ? code : unknownErrno;
    const message = typeof code === 'number'
        ? value.message || errnoMessage(errno) || 'Unknown error'
        : value.message;
    return createErrnoError(message, errno, value, context);
}

/** Preserve ordinary application errors; only normalize native errno values. */
export function normalizeErrnoError(
    value: unknown,
    syscall?: string,
    path?: string,
    dest?: string,
): Error & { code?: string } {
    if (!isErrorValue(value)) return new Error(String(value));

    const code = errorCode(value);
    return typeof code === 'number' && code < 0
        ? toErrnoException(value, syscall, path, dest)
        : value;
}

export function isTransportDisconnectError(value: unknown): boolean {
    return matchesErrnoCode(value, ...DISCONNECT_CODES);
}
