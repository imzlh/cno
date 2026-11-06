/**
 * Bun.allocUnsafe(size) equivalent that returns a fresh Uint8Array.
 *
 * Native Bun may return uninitialized memory. JavaScript cannot obtain that
 * safely, because reading it can expose data from other allocations. This
 * implementation always zero-fills, so callers never see stale bytes. The
 * only observable difference is the content of the buffer. It is never pooled,
 * so every call returns a distinct, independently owned buffer.
 */
export function allocUnsafe(size: number): Uint8Array {
    if (typeof size !== 'number') {
        const object = size as { constructor?: { name?: string } } | null;
        const received = size === null || size === undefined
            ? String(size)
            : typeof size === 'object'
                ? `an instance of ${object?.constructor?.name ?? 'Object'}`
                : `type ${typeof size} (${typeof size === 'string' ? `'${size}'` : String(size)})`;
        throw codedError(
            new TypeError(`The "size" argument must be of type number. Received ${received}`),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    if (!Number.isInteger(size)) {
        throw codedError(
            new RangeError(`The value of "size" is out of range. It must be an integer. Received ${size}`),
            'ERR_OUT_OF_RANGE',
        );
    }
    if (size < 0 || size > 0xffff_ffff) {
        throw codedError(
            new RangeError(`The value of "size" is out of range. It must be >= 0 && <= 4294967295. Received ${size}`),
            'ERR_OUT_OF_RANGE',
        );
    }
    return new Uint8Array(size);
}

function codedError<T extends Error>(error: T, code: string): T {
    Object.defineProperty(error, 'code', {
        configurable: true,
        value: code,
        writable: true,
    });
    return error;
}
