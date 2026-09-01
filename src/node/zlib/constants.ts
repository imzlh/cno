/**
 * Node.js zlib module — constants, error factories and validation.
 *
 * The flush-mode / level / strategy values come from the native `zlib` module;
 * the `constants` object and `codes` map are Node's published surface.
 *
 * The BROTLI_* operation and parameter numbers live here rather than in
 * `brotli.ts` because three consumers need them at once: the `constants` object
 * below, `validateBrotliOptions`'s range check and `brotli.ts` itself. Keeping
 * them here means this file stays the leaf of the dependency graph instead of
 * importing back out of `brotli.ts`.
 *
 * Node's `Received ...` clause, its ERR_OUT_OF_RANGE numeric-separator form,
 * and the `{ code, errno }` zlib error surface live here too, so that the
 * validation, sync, stream and brotli modules all shape errors identically.
 *
 * The option/input validators sit below the error factories they call.
 * `VALID_FLUSH_FLAGS` is the validator's own table; `streams.ts` reaches the
 * same check through `validateFlushFlag`. The gzip byte probes at the bottom
 * are shared by `sync.ts` (one-shot member walking) and `streams.ts` (chunked
 * member walking), so they sit in this lower-level module to keep those two
 * files free of a cycle.
 */

const zlib = import.meta.use('zlib');

// Constant exports

// Compression Levels
export const NO_COMPRESSION = zlib.NO_COMPRESSION;
export const BEST_SPEED = zlib.BEST_SPEED;
export const BEST_COMPRESSION = zlib.BEST_COMPRESSION;
export const DEFAULT_COMPRESSION = zlib.DEFAULT_COMPRESSION;

// Compression Strategies
export const DEFAULT_STRATEGY = zlib.DEFAULT_STRATEGY;
export const FILTERED = zlib.FILTERED;
export const HUFFMAN_ONLY = zlib.HUFFMAN_ONLY;
export const RLE = zlib.RLE;
export const FIXED = zlib.FIXED;

// Flush Modes
export const NO_FLUSH = zlib.NO_FLUSH;
export const PARTIAL_FLUSH = zlib.PARTIAL_FLUSH;
export const SYNC_FLUSH = zlib.SYNC_FLUSH;
export const FULL_FLUSH = zlib.FULL_FLUSH;
export const FINISH = zlib.FINISH;
export const BLOCK = zlib.BLOCK;

// Brotli operations and parameter ids
export const BROTLI_OPERATION_PROCESS = 0;
export const BROTLI_OPERATION_FLUSH = 1;
export const BROTLI_OPERATION_FINISH = 2;
export const BROTLI_PARAM_MODE = 0;
export const BROTLI_PARAM_QUALITY = 1;
export const BROTLI_PARAM_LGWIN = 2;
export const BROTLI_PARAM_LGBLOCK = 3;
export const BROTLI_PARAM_SIZE_HINT = 5;
export const BROTLI_PARAM_LARGE_WINDOW = 6;

export const constants = {
    Z_NO_FLUSH: zlib.NO_FLUSH,
    Z_PARTIAL_FLUSH: zlib.PARTIAL_FLUSH,
    Z_SYNC_FLUSH: zlib.SYNC_FLUSH,
    Z_FULL_FLUSH: zlib.FULL_FLUSH,
    Z_FINISH: zlib.FINISH,
    Z_BLOCK: zlib.BLOCK,
    Z_NO_COMPRESSION: zlib.NO_COMPRESSION,
    Z_BEST_SPEED: zlib.BEST_SPEED,
    Z_BEST_COMPRESSION: zlib.BEST_COMPRESSION,
    Z_DEFAULT_COMPRESSION: zlib.DEFAULT_COMPRESSION,
    Z_FILTERED: zlib.FILTERED,
    Z_HUFFMAN_ONLY: zlib.HUFFMAN_ONLY,
    Z_RLE: zlib.RLE,
    Z_FIXED: zlib.FIXED,
    Z_DEFAULT_STRATEGY: zlib.DEFAULT_STRATEGY,
    Z_OK: 0,
    Z_STREAM_END: 1,
    Z_NEED_DICT: 2,
    Z_ERRNO: -1,
    Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4,
    Z_BUF_ERROR: -5,
    Z_VERSION_ERROR: -6,
    BROTLI_DECODE: 8,
    BROTLI_ENCODE: 9,
    BROTLI_OPERATION_PROCESS,
    BROTLI_OPERATION_FLUSH,
    BROTLI_OPERATION_FINISH,
    BROTLI_PARAM_MODE,
    BROTLI_MODE_GENERIC: 0,
    BROTLI_MODE_TEXT: 1,
    BROTLI_MODE_FONT: 2,
    BROTLI_DEFAULT_MODE: 0,
    BROTLI_PARAM_QUALITY,
    BROTLI_MIN_QUALITY: 0,
    BROTLI_MAX_QUALITY: 11,
    BROTLI_DEFAULT_QUALITY: 11,
    BROTLI_PARAM_LGWIN,
    BROTLI_MIN_WINDOW_BITS: 10,
    BROTLI_MAX_WINDOW_BITS: 24,
    BROTLI_LARGE_MAX_WINDOW_BITS: 30,
    BROTLI_DEFAULT_WINDOW: 22,
    BROTLI_PARAM_LGBLOCK,
    BROTLI_MIN_INPUT_BLOCK_BITS: 16,
    BROTLI_MAX_INPUT_BLOCK_BITS: 24,
    BROTLI_PARAM_SIZE_HINT,
    BROTLI_PARAM_LARGE_WINDOW,
    BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
    // Stream mode identifiers and the option bounds Node publishes. Values
    // measured from Node v24.18.
    DEFLATE: 1,
    INFLATE: 2,
    GZIP: 3,
    GUNZIP: 4,
    DEFLATERAW: 5,
    INFLATERAW: 6,
    UNZIP: 7,
    Z_MIN_WINDOWBITS: 8,
    Z_MAX_WINDOWBITS: 15,
    Z_DEFAULT_WINDOWBITS: 15,
    Z_MIN_CHUNK: 64,
    Z_MAX_CHUNK: Infinity,
    Z_DEFAULT_CHUNK: 16384,
    Z_MIN_MEMLEVEL: 1,
    Z_MAX_MEMLEVEL: 9,
    Z_DEFAULT_MEMLEVEL: 8,
    Z_MIN_LEVEL: -1,
    Z_MAX_LEVEL: 9,
    Z_DEFAULT_LEVEL: -1,
};
/**
 * Node's `zlib.codes`: a bidirectional name<->number map, frozen. Was missing
 * entirely, so `zlib.codes.Z_DATA_ERROR` threw.
 */
const zlibCodeEntries: ReadonlyArray<readonly [string, number]> = [
    ['Z_OK', 0],
    ['Z_STREAM_END', 1],
    ['Z_NEED_DICT', 2],
    ['Z_ERRNO', -1],
    ['Z_STREAM_ERROR', -2],
    ['Z_DATA_ERROR', -3],
    ['Z_MEM_ERROR', -4],
    ['Z_BUF_ERROR', -5],
    ['Z_VERSION_ERROR', -6],
];

export const codes: Readonly<Record<string, string | number>> = Object.freeze(
    (() => {
        const out: Record<string, string | number> = {};
        // Node's insertion order: the three non-negative names first, then all
        // names, then the negative numeric keys.
        for (const [name, value] of zlibCodeEntries) if (value >= 0) out[String(value)] = name;
        for (const [name, value] of zlibCodeEntries) out[name] = value;
        for (const [name, value] of zlibCodeEntries) if (value < 0) out[String(value)] = name;
        return out;
    })(),
);

// ---------------------------------------------------------------------------
// Error factories and message formatting.
// ---------------------------------------------------------------------------

export function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function zlibInputTypeError(data: unknown): TypeError {
    return codedError(
        new TypeError(
            'The "buffer" argument must be of type string or an instance of Buffer, '
            + `TypedArray, DataView, or ArrayBuffer. Received ${receivedOf(data)}`,
        ),
        'ERR_INVALID_ARG_TYPE',
    );
}

/** Node's `Received ...` clause. Verified against v24.18. */
function receivedOf(actual: unknown): string {
    if (actual === null) return 'null';
    if (actual === undefined) return 'undefined';
    const t = typeof actual;
    if (t === 'string') return `type string ('${actual as string}')`;
    if (t === 'number') return `type number (${Object.is(actual, -0) ? '-0' : String(actual)})`;
    if (t === 'bigint') return `type bigint (${String(actual)}n)`;
    if (t === 'boolean') return `type boolean (${String(actual)})`;
    if (t === 'symbol') return `type symbol (${String(actual)})`;
    if (t === 'function') return `function ${(actual as { name?: string }).name ?? ''}`;
    if (t === 'object') {
        if (Object.getPrototypeOf(actual) === null) return '[Object: null prototype] {}';
        const ctor = (actual as object).constructor;
        return `an instance of ${ctor && ctor.name ? ctor.name : 'Object'}`;
    }
    return `type ${t}`;
}

/**
 * Node's `addNumericSeparator`: ERR_OUT_OF_RANGE prints the raw value with `_`
 * inserted every 3 characters from the right, so 1e21 reports as `1e_+21`.
 */
function addNumericSeparator(val: string): string {
    let res = '';
    let i = val.length;
    const start = val[0] === '-' ? 1 : 0;
    for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
    return i === val.length ? val : `${val.slice(0, i)}${res}`;
}
/** ERR_OUT_OF_RANGE reports the plain value, NOT the `type number (...)` form. */
function receivedRange(actual: unknown): string {
    if (typeof actual === 'bigint') return addNumericSeparator(`${actual}n`);
    if (typeof actual === 'number') {
        // Node only separates integers, so Infinity/NaN stay verbatim.
        return Number.isInteger(actual) ? addNumericSeparator(String(actual)) : String(actual);
    }
    return receivedOf(actual);
}

export function codedError<T extends Error>(err: T, code: string): T {
    (err as T & { code?: string }).code = code;
    return err;
}

/**
 * Node's `checkRangesOrGetDefault`. Exact semantics, verified against v24.18:
 *   undefined  -> use the default
 *   non-number -> ERR_INVALID_ARG_TYPE (null included; null is not a number)
 *   NaN        -> ACCEPTED, because `NaN < min` and `NaN > max` are both false
 *   +/-Infinity-> ERR_OUT_OF_RANGE "must be a finite number"
 *   non-integer inside the range -> accepted (`{ level: 1.5 }` is legal)
 */
export function checkRange(value: unknown, name: string, min: number, max: number): void {
    if (value === undefined) return;
    if (typeof value !== 'number') {
        throw codedError(
            new TypeError(`The "${name}" property must be of type number. Received ${receivedOf(value)}`),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    if (!Number.isFinite(value) && !Number.isNaN(value)) {
        throw codedError(
            new RangeError(`The value of "${name}" is out of range. It must be a finite number. Received ${receivedRange(value)}`),
            'ERR_OUT_OF_RANGE',
        );
    }
    if (value < min || value > max) {
        const bound = max === Number.POSITIVE_INFINITY ? `>= ${min}` : `>= ${min} and <= ${max}`;
        throw codedError(
            new RangeError(`The value of "${name}" is out of range. It must be ${bound}. Received ${receivedRange(value)}`),
            'ERR_OUT_OF_RANGE',
        );
    }
}

// Error shaping: the native layer reports generic InternalErrors, so classify
// them into Node's `{ code, errno }` zlib error surface here.

interface ZlibNativeError extends Error {
    errno: number;
    code: string;
}

export function bufferTooLargeError(max: number): RangeError {
    const err = new RangeError(`Cannot create a Buffer larger than ${max} bytes`);
    return Object.assign(err, { code: 'ERR_BUFFER_TOO_LARGE' });
}

function zlibError(code: string, errno: number, message: string): ZlibNativeError {
    return Object.assign(new Error(message), { errno, code });
}

export const truncatedError = () => zlibError('Z_BUF_ERROR', -5, 'unexpected end of file');
export const corruptError = () => zlibError('Z_DATA_ERROR', -3, 'incorrect header check');

export function isAlreadyFinished(error: unknown): boolean {
    return /already finished/i.test(asError(error).message);
}

export const hasErrorCode = (error: unknown): boolean =>
    error instanceof Error && Object.hasOwn(error, 'code');

// ---------------------------------------------------------------------------
// Option/input validation and byte helpers.
// ---------------------------------------------------------------------------

interface ZlibOptions {
    flush?: number;
    finishFlush?: number;
    chunkSize?: number;
    level?: number;
    strategy?: number;
    memLevel?: number;
    windowBits?: number;
    dictionary?: ArrayBuffer | Uint8Array;
    info?: boolean;
    maxOutputLength?: number;
}

interface BrotliOptions {
    flush?: number;
    finishFlush?: number;
    chunkSize?: number;
    params?: Record<string, number>;
    maxOutputLength?: number;
}

type ZlibInput = string | ArrayBuffer | ArrayBufferView;

export type { ZlibOptions, BrotliOptions, ZlibInput };

export function toUint8Array(data: ZlibInput): Uint8Array {
    if (typeof data === 'string') return Buffer.from(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw zlibInputTypeError(data);
}

/**
 * null is a valid "use the default" for Node, but the native call needs
 * undefined. NaN passes Node's range check (all comparisons are false) yet the
 * native layer rejects it, so it also falls back to the default.
 */
export function orUndef(value: number | null | undefined): number | undefined {
    return value === null || (typeof value === 'number' && Number.isNaN(value)) ? undefined : value;
}

const VALID_FLUSH_FLAGS = new Set([NO_FLUSH, PARTIAL_FLUSH, SYNC_FLUSH, FULL_FLUSH, FINISH, BLOCK]);

export function validateFlushFlag(value: unknown, name: string): void {
    if (typeof value !== 'number') throw new TypeError(`The "${name}" property must be of type number`);
    if (!Number.isInteger(value) || !VALID_FLUSH_FLAGS.has(value)) {
        throw new RangeError(`The value of "${name}" is out of range`);
    }
}
export function validateOptions(options?: ZlibOptions | BrotliOptions): void {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
        throw codedError(new TypeError('The "options" argument must be of type object'), 'ERR_INVALID_ARG_TYPE');
    }
    if (options?.flush !== undefined) validateFlushFlag(options.flush, 'options.flush');
    if (options?.finishFlush !== undefined) validateFlushFlag(options.finishFlush, 'options.finishFlush');

    const zlibOptions = options as ZlibOptions | undefined;
    checkRange(zlibOptions?.maxOutputLength, 'options.maxOutputLength', 1, Number.MAX_SAFE_INTEGER);
    checkRange(zlibOptions?.level, 'options.level', -1, 9);
    checkRange(zlibOptions?.memLevel, 'options.memLevel', 1, 9);
    checkRange(zlibOptions?.strategy, 'options.strategy', 0, 4);
    checkRange(zlibOptions?.chunkSize, 'options.chunkSize', 64, Number.POSITIVE_INFINITY);
    // Node's range is [8,15] for deflate and [0,15] for inflate, but the native
    // binding accepts no windowBits argument at all, so anything that would
    // change the window is refused rather than silently ignored.
    if (zlibOptions?.windowBits !== undefined) {
        checkRange(zlibOptions.windowBits, 'options.windowBits', 0, 15);
        if (zlibOptions.windowBits !== 0 && zlibOptions.windowBits !== 15) {
            throw codedError(
                new RangeError('Only windowBits values 0 and 15 are supported'),
                'ERR_OUT_OF_RANGE',
            );
        }
    }
    if (zlibOptions?.dictionary !== undefined) {
        if (!(zlibOptions.dictionary instanceof ArrayBuffer) && !ArrayBuffer.isView(zlibOptions.dictionary)) {
            throw codedError(
                new TypeError('The "options.dictionary" property must be an ArrayBuffer or ArrayBufferView'),
                'ERR_INVALID_ARG_TYPE',
            );
        }
        // The native binding takes no dictionary argument; accepting one would
        // silently produce a stream the peer cannot inflate.
        if (zlibOptions.dictionary.byteLength !== 0) {
            throw new Error('Non-empty zlib dictionaries are not supported');
        }
    }
}

export function validateBrotliOptions(options?: BrotliOptions): void {
    validateOptions(options);
    for (const [name, value] of [['flush', options?.flush], ['finishFlush', options?.finishFlush]] as const) {
        if (value !== undefined && (!Number.isInteger(value) || value < BROTLI_OPERATION_PROCESS || value > BROTLI_OPERATION_FINISH)) {
            throw new RangeError(`The value of "options.${name}" is out of range`);
        }
    }
    if (options?.params !== undefined && (options.params === null || typeof options.params !== 'object')) {
        throw new TypeError('The "options.params" property must be an object');
    }
    for (const value of Object.values(options?.params ?? {})) {
        if (!Number.isInteger(value)) throw new TypeError('Brotli parameter values must be integers');
    }
}

export function checkMaxOutputLength(output: Buffer, options?: { maxOutputLength?: number }): Buffer {
    const max = options?.maxOutputLength;
    // `null` means "no limit" (Node's default path), not a limit of zero.
    if (max !== undefined && max !== null && output.byteLength > max) {
        throw bufferTooLargeError(max);
    }
    return output;
}

// Input byte probes. Shared by the one-shot member walk in `sync.ts` and the
// chunked member walk in `streams.ts`; they live in this lower-level module so
// neither of those two has to import from the other.

export const hasGzipMagic = (data: Uint8Array): boolean => data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;

/**
 * Node stops walking gzip members as soon as the byte after a finished member is
 * NUL (`node_zlib.cc`: `... && next_in[0] != 0x00`) and discards everything that
 * follows, however many bytes there are and whatever they hold. Requiring the
 * whole remainder to be zero instead rejects NUL-padded gzip payloads that Node
 * decodes fine.
 */
export const trailingIsPadding = (data: Uint8Array): boolean => data.length > 0 && data[0] === 0;
