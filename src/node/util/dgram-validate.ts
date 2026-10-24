/**
 * Argument validation shared by the dgram socket and by the native-backed
 * multicast and buffer-size paths, which expose the same checks to Node users.
 */

const engine = import.meta.use('engine');
const uverror = import.meta.use('error');

type CodedError<T extends Error> = T & { code: string };

function coded<T extends Error>(error: T, code: string): CodedError<T> {
    return Object.assign(error, { code });
}

export function makeError(message: string, code: string): Error & { code: string } {
    return coded(new Error(message), code);
}

export function invalidArgType(message: string): TypeError & { code: string } {
    return coded(new TypeError(message), 'ERR_INVALID_ARG_TYPE');
}

/**
 * Node shapes libuv failures as `<syscall> <CODE>[ <address>[:<port>]]` with a
 * numeric `.errno` from the platform UV table, and bind/connect failures also
 * carry `address` / `port` own properties.
 */
export function errnoError(
    code: string,
    syscall: string,
    detail?: { address: string; port?: number },
): NodeJS.ErrnoException {
    const table = uverror.errno as unknown as Record<string, number | undefined>;
    const where = detail === undefined
        ? ''
        : ` ${detail.port ? `${detail.address}:${detail.port}` : detail.address}`;
    const err: NodeJS.ErrnoException & { address?: string; port?: number } =
        new Error(`${syscall} ${code}${where}`);
    err.code = code;
    const errno = Reflect.get(table, code);
    if (typeof errno === 'number') err.errno = errno;
    err.syscall = syscall;
    if (detail) {
        err.address = detail.address;
        if (detail.port) err.port = detail.port;
    }
    return err;
}

/** `ERR_SOCKET_DGRAM_NOT_RUNNING` — the handle has been closed. */
export function notRunning(): Error & { code: string } {
    return makeError('Not running', 'ERR_SOCKET_DGRAM_NOT_RUNNING');
}

function formatNumber(value: number): string {
    if (value === 0) return Object.is(value, -0) ? '-0' : '0';
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return String(value);
}

/**
 * Node's internal `determineSpecificType()`, used verbatim in its
 * argument-validation messages: primitives are rendered as
 * `type <typeof> (<inspected>)`, while null/undefined render bare. Only the
 * null-prototype-object fallback differs: Node inspects the value, this
 * reports its tag.
 */
export function determineSpecificType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    switch (typeof value) {
        case 'string': {
            const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
            return shown.includes("'") ? `type string (${JSON.stringify(shown)})` : `type string ('${shown}')`;
        }
        case 'number':
            return `type number (${formatNumber(value)})`;
        case 'bigint':
            return `type bigint (${String(value)}n)`;
        case 'symbol':
            return `type symbol (${String(value)})`;
        case 'function':
            return `function ${value.name}`;
        case 'object': {
            const ctor = Reflect.get(value, 'constructor');
            if (typeof ctor === 'function' && 'name' in ctor) return `an instance of ${ctor.name}`;
            const proto = Object.getPrototypeOf(value);
            return proto === null || proto === Object.prototype
                ? '[Object: null prototype] {}'
                : '[object Object]';
        }
        default:
            return `type ${typeof value} (${String(value)})`;
    }
}

/**
 * `validatePort()` from Node's internal validators: accepts a number or a
 * non-blank numeric string, rejects non-integers, out-of-range values and zero
 * unless `allowZero`. The result is truncated with `| 0` like Node's.
 */
export function validatePort(port: unknown, name = 'Port', allowZero = true): number {
    if (
        (typeof port !== 'number' && typeof port !== 'string') ||
        (typeof port === 'string' && port.trim().length === 0) ||
        Number(port) !== (Number(port) >>> 0) ||
        (port as number) > 0xFFFF ||
        (Number(port) === 0 && !allowZero)
    ) {
        throw coded(
            new RangeError(`${name} should be ${allowZero ? '>=' : '>'} 0 and < 65536. Received ${determineSpecificType(port)}.`),
            'ERR_SOCKET_BAD_PORT',
        );
    }
    return Number(port) | 0;
}

export function validateString(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string') {
        throw invalidArgType(`The "${name}" argument must be of type string. Received ${determineSpecificType(value)}`);
    }
}

export function validateNumber(value: unknown, name: string): asserts value is number {
    if (typeof value !== 'number') {
        throw invalidArgType(`The "${name}" argument must be of type number. Received ${determineSpecificType(value)}`);
    }
}

export function validateFunction(value: unknown, name: string): asserts value is (...args: unknown[]) => unknown {
    if (typeof value !== 'function') {
        throw invalidArgType(`The "${name}" argument must be of type function. Received ${determineSpecificType(value)}`);
    }
}

function isAbortSignal(value: unknown): value is AbortSignal {
    return value !== undefined && value !== null && typeof value === 'object' && Reflect.has(value, 'aborted');
}

export function validateAbortSignal(value: unknown, name: string): void {
    if (value !== undefined && !isAbortSignal(value)) {
        throw invalidArgType(`The "${name}" property must be an instance of AbortSignal. Received ${determineSpecificType(value)}`);
    }
}

export function validateSocketType(type: unknown): asserts type is 'udp4' | 'udp6' {
    if (type !== 'udp4' && type !== 'udp6') {
        throw coded(new TypeError('Bad socket type specified. Valid types are: udp4, udp6'), 'ERR_SOCKET_BAD_TYPE');
    }
}

export function isView(value: unknown): value is ArrayBufferView {
    return ArrayBuffer.isView(value);
}

export function viewToBytes(view: ArrayBufferView): Uint8Array {
    return view instanceof Uint8Array
        ? view
        : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function invalidBufferArg(name: string, value: unknown): TypeError & { code: string } {
    return invalidArgType(
        `The "${name}" argument must be of type string or an instance of Buffer, `
        + `TypedArray, or DataView. Received ${determineSpecificType(value)}`,
    );
}

function bufferOutOfBounds(name: 'offset' | 'length'): CodedError<RangeError> {
    return coded(new RangeError(`"${name}" is outside of buffer bounds`), 'ERR_BUFFER_OUT_OF_BOUNDS');
}

/**
 * Node's `sliceBuffer`: `>>> 0` coercion happens before the bounds checks, so a
 * negative offset trips the `offset` check while a negative length trips
 * `length` via `offset + length > byteLength`.
 */
export function sliceBuffer(bytes: Uint8Array, offset: unknown, length: unknown): Uint8Array {
    const off = (offset as number) >>> 0;
    const len = (length as number) >>> 0;
    if (off > bytes.byteLength) throw bufferOutOfBounds('offset');
    if (off + len > bytes.byteLength) throw bufferOutOfBounds('length');
    return bytes.subarray(off, off + len);
}

/** Node's `fixBufferList`, returning null where it returns null. */
function fixBufferList(list: readonly unknown[]): Uint8Array[] | null {
    const out: Uint8Array[] = [];
    for (const item of list) {
        if (typeof item === 'string') out.push(engine.encodeString(item));
        else if (isView(item)) out.push(viewToBytes(item));
        else return null;
    }
    return out;
}

/**
 * Checks a `send()` message the way Node does when the message is a buffer
 * list: the list is encoded, and an unencodable entry fails before any
 * positional argument is read.
 */
export function validateBufferList(msg: unknown): void {
    if (Array.isArray(msg) && fixBufferList(msg) === null) throw invalidBufferArg('buffer list arguments', msg);
}

export function normalizeMessage(msg: unknown): Uint8Array[] {
    if (!Array.isArray(msg)) {
        if (typeof msg === 'string') return [engine.encodeString(msg)];
        if (!isView(msg)) throw invalidBufferArg('buffer', msg);
        return [viewToBytes(msg)];
    }
    const list = fixBufferList(msg);
    if (list === null) throw invalidBufferArg('buffer list arguments', msg);
    return list;
}
