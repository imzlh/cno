/**
 * Bun.allocUnsafe(size) equivalent that returns a fresh Uint8Array.
 *
 * Native Bun may return uninitialized memory. JavaScript cannot obtain that
 * safely, because reading it can expose data from other allocations. This
 * implementation always zero-fills, so callers never see stale bytes. The
 * only observable difference is the content of the buffer. It is never pooled,
 * so every call returns a distinct, independently owned buffer.
 */
export const allocUnsafe = (size: number): Uint8Array => {
    if (typeof size !== 'number') {
        throw codedError(
            new TypeError(`The "size" argument must be of type number. Received ${receivedType(size)}`),
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
            new RangeError(
                `The value of "size" is out of range. It must be >= 0 && <= 4294967295. Received ${formatRangeInteger(size)}`,
            ),
            'ERR_OUT_OF_RANGE',
        );
    }
    return new Uint8Array(size);
};

function receivedType(value: unknown): string {
    if (value === null || value === undefined) return String(value);

    const type = typeof value;
    if (type === 'string') {
        const string = value as string;
        const shown = string.length > 28 ? `${string.slice(0, 25)}...` : string;
        const quote = shown.includes("'") ? '"' : "'";
        const escaped = quote === '"' ? shown.replaceAll('"', '\\"') : shown;
        return `type string (${quote}${escaped}${quote})`;
    }
    if (type === 'bigint') return `type bigint (${String(value)}n)`;
    if (type === 'function') return `function ${(value as Function).name}`;
    if (type !== 'object') return `type ${type} (${String(value)})`;

    const constructor = (value as { constructor?: { name?: unknown } }).constructor;
    if (constructor === undefined || constructor === null) {
        return Object.getPrototypeOf(value) === null ? '[Object: null prototype] {}' : '{}';
    }
    return `an instance of ${String(constructor.name)}`;
}

function formatRangeInteger(value: number): string {
    const text = String(value);
    if (Math.abs(value) <= 0x1_0000_0000) return text;

    let result = '';
    let index = text.length;
    const start = text[0] === '-' ? 1 : 0;
    for (; index >= start + 4; index -= 3) result = `_${text.slice(index - 3, index)}${result}`;
    return `${text.slice(0, index)}${result}`;
}

function codedError<T extends Error>(error: T, code: string): T {
    Object.defineProperty(error, 'code', {
        configurable: true,
        value: code,
        writable: true,
    });
    return error;
}
