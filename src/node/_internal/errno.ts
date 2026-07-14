/**
 * Node.js errno error wrapper utility
 * Wraps C module errno errors (CModuleError.Error with negative .code)
 * to Node.js ErrnoException (with string .code like "ENOENT")
 *
 * References Deno wrapFSErr implementation (src/utils/wrap.ts),
 * but outputs Node.js-style ErrnoException instead of Deno errors.
 */

const error = import.meta.use('error');

// Built from runtime UV table — never hand-maintain (platform-local values drift).
const errnoToString: Record<number, string> = {};
const stringToErrno: Record<string, number> = {};
for (const name of Object.keys(error.errno) as Array<keyof typeof error.errno>) {
    const v = error.errno[name];
    if (typeof v !== 'number' || name === 'OK') continue;
    // First name wins if two labels share a value (e.g. EOPNOTSUPP === ENOTSUP).
    if (errnoToString[v] === undefined) errnoToString[v] = name;
    stringToErrno[name] = v;
}

/** Peer/socket gone — normal for HTTP when the client aborts mid-response. */
const DISCONNECT_CODES = new Set([
    'EPIPE',
    'ECONNRESET',
    'ECONNABORTED',
    'EBADF',
    'ECANCELED',
    'ESHUTDOWN',
    'ENOTCONN',
    'EOF',
]);

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

    const errnoValue = rawCode;
    const codeStr = errnoToString[errnoValue] ?? 'UNKNOWN';
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
 * Match raw UV errno numbers and Node string codes only — never message text.
 */
export function matchesErrnoCode(
    e: unknown,
    ...codes: string[]
): boolean {
    if (!(e instanceof Error)) return false;

    const code = Reflect.get(e, 'code');
    if (typeof code === 'string') return codes.includes(code);
    if (typeof code === 'number') {
        return codes.some((name) => stringToErrno[name] === code);
    }
    return false;
}

/**
 * Peer/socket gone. Structured `.code` only (UV number or Node string).
 * Synthetic adapter errors must set code (e.g. ECONNRESET), not rely on message.
 */
export function isTransportDisconnectError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;

    const code = Reflect.get(e, 'code');
    if (typeof code === 'string') return DISCONNECT_CODES.has(code);
    if (typeof code === 'number') {
        const name = errnoToString[code];
        return !!name && DISCONNECT_CODES.has(name);
    }
    return false;
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
