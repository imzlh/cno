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

type NodeSystemError = Error & {
    code: string;
    errno: number;
    syscall: string;
    info: { errno: number; code: string; message: string; syscall: string };
};

/**
 * Node's internal `SystemError`, with the message spelled `<prefix>: <syscall>
 * returned <UVCODE> (<description>)`. Take errno and description from the runtime
 * UV table: hardcoding them is platform-wrong and drifts with libuv.
 */
export function uvSystemError(uvCode: string, syscall: string, code: string, prefix: string): NodeSystemError {
    const errno = stringToErrno[uvCode] ?? error.errno.UNKNOWN;
    const described = error.strerror(errno);
    const message = described.startsWith(`${uvCode}: `) ? described.slice(uvCode.length + 2) : described;

    const err = new Error(`${prefix}: ${syscall} returned ${uvCode} (${message})`) as NodeSystemError;
    err.code = code;
    err.errno = errno;
    err.syscall = syscall;
    err.info = { errno, code: uvCode, message, syscall };
    // Node's `name` is an own but non-enumerable property, so it stays out of
    // Object.keys(err) / JSON round-trips while String(err) keeps the tag.
    Object.defineProperty(err, 'name', { value: 'SystemError', writable: true, configurable: true, enumerable: false });
    return err;
}

/**
 * Convert C module errno error to Node.js ErrnoException
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
    // Node does NOT set an own `name` on errno errors — measured v24.18.0, every
    // fs/net/dns errno error has ownProps [code,errno,message,path?,syscall] and
    // `name === 'Error'` inherited from the prototype. Setting an own 'ErrnoException'
    // leaked into Object.keys/JSON round-trips and broke `e.name === 'Error'` checks.
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
): Error & { code?: string } {
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
