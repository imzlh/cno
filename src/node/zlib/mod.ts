/**
 * Node.js zlib module
 * Based on CModuleZLib implementation
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

// Type definitions

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

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
type CompressCallback = (err: Error | null, result?: Buffer | ZlibInfoResult) => void;

// The native zlib handles are direction-specific: createDeflate/createGzip/
// createDeflateRaw expose only `deflate` (plus `params`), while createInflate/
// createGunzip/createInflateRaw/createUnzip expose only `inflate`. Modelling
// them as a single type requiring both methods made every handle fail to
// assign. The `?: undefined` members keep both keys visible on the union so
// dynamic dispatch sites can narrow with a plain `typeof` check.
type ZlibHandleBase = {
    flush(flush?: number): Uint8Array;
    finish(input?: Uint8Array): Uint8Array;
    close?: () => void;
    reset?: () => void;
    getTotalIn?: () => number;
    getTotalOut?: () => number;
};
type ZlibDeflateHandle = ZlibHandleBase & {
    deflate(input: Uint8Array, flush?: number): Uint8Array;
    inflate?: undefined;
    params?: (level: number, strategy: number) => void;
};
type ZlibInflateHandle = ZlibHandleBase & {
    inflate(input: Uint8Array, flush?: number): Uint8Array;
    deflate?: undefined;
    params?: undefined;
};
type ZlibHandle = ZlibDeflateHandle | ZlibInflateHandle;

// Direction is fixed when the handle is created, so dispatch on the handle
// itself rather than on the separately tracked `state.compress` flag.
function isDeflateHandle(handle: ZlibHandle): handle is ZlibDeflateHandle {
    return typeof handle.deflate === 'function';
}
// Must match Transform.prototype._transform / _flush in ../stream exactly: the
// base declares `error?: Error | null`, and an `unknown` first parameter is not
// assignable to it (contravariance), which broke every prototype assignment.
type TransformCallback = (error?: Error | null, result?: Buffer) => void;
type ZlibStreamCtor<T extends Transform, O> = new (options?: O & TransformOptions) => T;
type BrotliNative = {
    available?: boolean;
    compress?: (input: Uint8Array, options?: CModuleBrotli.CompressOptions) => Uint8Array;
    decompress?: (input: Uint8Array, options?: CModuleBrotli.DecompressOptions) => Uint8Array;
    createCompress?: (options?: CModuleBrotli.CompressOptions) => CModuleBrotli.BrotliCompress;
    createDecompress?: (options?: CModuleBrotli.DecompressOptions) => CModuleBrotli.BrotliDecompress;
};
// brotli is an optional native module (built with libbrotli); `use()` types it
// as `| null` for that reason, so tolerate both null and a throwing lookup.
let nativeBrotli: BrotliNative = {};
try { nativeBrotli = import.meta.use('brotli') ?? {}; } catch { /* unavailable */ }

// Internal helper functions

function finishTransform(cb: TransformCallback, operation: () => Buffer): void {
    try {
        cb(null, operation());
    } catch (err) {
        cb(asError(err));
    }
}

function zlibInputTypeError(data: unknown): TypeError {
    return codedError(
        new TypeError(
            'The "buffer" argument must be of type string or an instance of Buffer, '
            + `TypedArray, DataView, or ArrayBuffer. Received ${receivedOf(data)}`,
        ),
        'ERR_INVALID_ARG_TYPE',
    );
}

function toUint8Array(data: ZlibInput): Uint8Array {
    if (typeof data === 'string') return Buffer.from(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw zlibInputTypeError(data);
}

function validateZlibInput(data: ZlibInput): void {
    if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return;
    throw zlibInputTypeError(data);
}

/**
 * null is a valid "use the default" for Node, but the native call needs
 * undefined. NaN passes Node's range check (all comparisons are false) yet the
 * native layer rejects it, so it also falls back to the default.
 */
function orUndef(value: number | null | undefined): number | undefined {
    return value === null || (typeof value === 'number' && Number.isNaN(value)) ? undefined : value;
}

const VALID_FLUSH_FLAGS = new Set([NO_FLUSH, PARTIAL_FLUSH, SYNC_FLUSH, FULL_FLUSH, FINISH, BLOCK]);

function validateFlushFlag(value: unknown, name: string): void {
    if (typeof value !== 'number') throw new TypeError(`The "${name}" property must be of type number`);
    if (!Number.isInteger(value) || !VALID_FLUSH_FLAGS.has(value)) {
        throw new RangeError(`The value of "${name}" is out of range`);
    }
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

function codedError<T extends Error>(err: T, code: string): T {
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
function checkRange(value: unknown, name: string, min: number, max: number): void {
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

function validateOptions(options?: ZlibOptions | BrotliOptions): void {
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

function validateBrotliOptions(options?: BrotliOptions): void {
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

function checkMaxOutputLength(output: Buffer, options?: { maxOutputLength?: number }): Buffer {
    const max = options?.maxOutputLength;
    // `null` means "no limit" (Node's default path), not a limit of zero.
    if (max !== undefined && max !== null && output.byteLength > max) {
        throw bufferTooLargeError(max);
    }
    return output;
}

/**
 * `{ info: true }` makes Node's one-shot helpers return `{ buffer, engine }` rather
 * than a bare Buffer, where `engine` is an instance of the matching stream class
 * carrying `bytesWritten` (the input byte count). Verified against v24.18.0:
 * `gzipSync(35 bytes, {info:true})` yields `engine instanceof Gzip`,
 * `engine.bytesWritten === 35`, and a plain-Object result.
 */
export interface ZlibInfoResult {
    buffer: Buffer;
    engine: NodeZlibTransform;
}

type OneShotKind = 'deflate' | 'deflateRaw' | 'gzip' | 'inflate' | 'inflateRaw' | 'gunzip' | 'unzip';

/**
 * Referenced lazily inside the function body: the stream constructors are declared
 * further down this module, so a top-level table would hit their TDZ at load time.
 */
function newInfoEngine(kind: OneShotKind, opts?: ZlibOptions & TransformOptions): NodeZlibTransform {
    switch (kind) {
        case 'deflate': return new Deflate(opts) as unknown as NodeZlibTransform;
        case 'deflateRaw': return new DeflateRaw(opts) as unknown as NodeZlibTransform;
        case 'gzip': return new Gzip(opts) as unknown as NodeZlibTransform;
        case 'inflate': return new Inflate(opts) as unknown as NodeZlibTransform;
        case 'inflateRaw': return new InflateRaw(opts) as unknown as NodeZlibTransform;
        case 'gunzip': return new Gunzip(opts) as unknown as NodeZlibTransform;
        case 'unzip': return new Unzip(opts) as unknown as NodeZlibTransform;
    }
}

/**
 * Wrap a one-shot result per `options.info`. Node reports the *input* length as the
 * engine's `bytesWritten`, and releases the native handle without destroying the
 * engine (`closed`/`destroyed` stay false).
 */
function withInfo(
    kind: OneShotKind,
    output: Buffer,
    inputLength: number,
    options?: ZlibOptions,
): Buffer | ZlibInfoResult {
    if (options?.info !== true) return output;
    const engine = newInfoEngine(kind, options as (ZlibOptions & TransformOptions) | undefined);
    const state = zlibStreamStates.get(engine);
    if (state) state.bytesWritten = inputLength;
    // Node releases the native handle and leaves `_handle === null` on the returned
    // engine, while `closed`/`destroyed` stay false. Match that shape: callers (and
    // Node's own `zlib binding closed` guard) test `_handle` for null.
    engine._handle.close?.();
    (engine as { _handle: ZlibHandle | null })._handle = null;
    return { buffer: output, engine };
}

// Error shaping: the native layer reports generic InternalErrors, so classify
// them into Node's `{ code, errno }` zlib error surface here.

interface ZlibNativeError extends Error {
    errno: number;
    code: string;
}

function bufferTooLargeError(max: number): RangeError {
    const err = new RangeError(`Cannot create a Buffer larger than ${max} bytes`);
    return Object.assign(err, { code: 'ERR_BUFFER_TOO_LARGE' });
}

function zlibError(code: string, errno: number, message: string): ZlibNativeError {
    return Object.assign(new Error(message), { errno, code });
}

const truncatedError = () => zlibError('Z_BUF_ERROR', -5, 'unexpected end of file');
const corruptError = () => zlibError('Z_DATA_ERROR', -3, 'incorrect header check');

function isAlreadyFinished(error: unknown): boolean {
    return /already finished/i.test(asError(error).message);
}

const hasErrorCode = (error: unknown): boolean =>
    error instanceof Error && Object.hasOwn(error, 'code');

// Native decompression handle factories, keyed by Node codec name.
type DecompressKind = 'inflate' | 'inflateRaw' | 'gunzip' | 'unzip';

const DECOMPRESS_FACTORIES: Record<DecompressKind, () => ZlibInflateHandle> = {
    inflate: () => zlib.createInflate(),
    inflateRaw: () => zlib.createInflateRaw(),
    gunzip: () => zlib.createGunzip(),
    unzip: () => zlib.createUnzip(),
};

const hasGzipMagic = (data: Uint8Array): boolean => data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;

/**
 * Node stops walking gzip members as soon as the byte after a finished member is
 * NUL (`node_zlib.cc`: `... && next_in[0] != 0x00`) and discards everything that
 * follows, however many bytes there are and whatever they hold. Requiring the
 * whole remainder to be zero instead rejects NUL-padded gzip payloads that Node
 * decodes fine.
 */
const trailingIsPadding = (data: Uint8Array): boolean => data.length > 0 && data[0] === 0;

function isAllZeros(data: Uint8Array): boolean {
    for (let i = 0; i < data.length; i++) if (data[i] !== 0) return false;
    return true;
}

// Only gzip streams concatenate members; zlib/raw deflate ignore trailing bytes.
const supportsMultiMember = (kind: DecompressKind, input: Uint8Array): boolean =>
    kind === 'gunzip' || (kind === 'unzip' && hasGzipMagic(input));

/**
 * One-shot decompression over the native streaming handle. The native one-shot
 * `zlib.inflate()` silently returns partial output for truncated input and
 * drops trailing gzip members, so walk members explicitly instead.
 */
function decompressSync(kind: DecompressKind, buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    validateOptions(options);
    const input = toUint8Array(buffer);
    const partialOk = (options?.finishFlush ?? FINISH) !== FINISH;
    const multiMember = supportsMultiMember(kind, input);
    const handle = DECOMPRESS_FACTORIES[kind]();
    const chunks: Buffer[] = [];
    let offset = 0;

    while (true) {
        let produced: Uint8Array;
        try {
            produced = handle.inflate(input.subarray(offset), NO_FLUSH);
        } catch (err) {
            if (isAlreadyFinished(err)) break;
            throw corruptError();
        }
        if (produced.length > 0) chunks.push(Buffer.from(produced));

        const used = handle.getTotalIn?.() ?? input.length - offset;
        let complete: boolean;
        try {
            const tail = handle.finish();
            if (tail.length > 0) chunks.push(Buffer.from(tail));
            complete = true;
        } catch (err) {
            if (isAlreadyFinished(err)) complete = true;
            else if (partialOk) complete = false;
            else throw truncatedError();
        }

        if (!complete) break;
        offset += used;
        if (used === 0 || offset >= input.length || !multiMember) break;
        // Trailing NUL padding after a complete member is not an error in Node.
        if (trailingIsPadding(input.subarray(offset))) break;
        if (!handle.reset) break;
        handle.reset();
    }

    return withInfo(kind, checkMaxOutputLength(Buffer.concat(chunks), options), input.byteLength, options);
}

// Sync compress/decompress

export function deflateSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function deflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function deflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    const input = toUint8Array(buffer);
    const out = checkMaxOutputLength(Buffer.from(zlib.deflate(input, level, orUndef(options?.strategy), orUndef(options?.memLevel))), options);
    return withInfo('deflate', out, input.byteLength, options);
}

export function deflateRawSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function deflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function deflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    const input = toUint8Array(buffer);
    const out = checkMaxOutputLength(Buffer.from(zlib.deflateRaw(input, level, orUndef(options?.strategy), orUndef(options?.memLevel))), options);
    return withInfo('deflateRaw', out, input.byteLength, options);
}

export function gzipSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function gzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function gzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    const input = toUint8Array(buffer);
    const out = checkMaxOutputLength(Buffer.from(zlib.gzip(input, level, orUndef(options?.strategy), orUndef(options?.memLevel))), options);
    return withInfo('gzip', out, input.byteLength, options);
}

export function inflateSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function inflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function inflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    return decompressSync('inflate', buffer, options);
}

export function inflateRawSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function inflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function inflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    return decompressSync('inflateRaw', buffer, options);
}

export function gunzipSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function gunzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function gunzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    return decompressSync('gunzip', buffer, options);
}

export function unzipSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function unzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function unzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    return decompressSync('unzip', buffer, options);
}

// Async compress/decompress (callback style)

type SyncFn = (buf: ZlibInput, opts?: ZlibOptions | BrotliOptions) => Buffer | ZlibInfoResult;

function wrapCallback(syncFn: SyncFn, validator: (options?: ZlibOptions | BrotliOptions) => void = validateOptions) {
    return function(buffer: ZlibInput, optionsOrCallback?: ZlibOptions | BrotliOptions | CompressCallback, callback?: CompressCallback) {
        const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
        const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        if (typeof cb !== 'function') {
            throw new TypeError('The "callback" argument must be of type function');
        }
        validateZlibInput(buffer);
        validator(opts);
        const input = new Uint8Array(toUint8Array(buffer));
        queueMicrotask(() => {
            try { cb(null, syncFn(input, opts)); }
            catch (err) { cb(asError(err)); }
        });
    };
}

export const deflate = wrapCallback(deflateSync);
export const deflateRaw = wrapCallback(deflateRawSync);
export const gzip = wrapCallback(gzipSync);
export const inflate = wrapCallback(inflateSync);
export const inflateRaw = wrapCallback(inflateRawSync);
export const gunzip = wrapCallback(gunzipSync);
export const unzip = wrapCallback(unzipSync);

// Stream compress/decompress

import { Transform, TransformOptions } from '../stream';

function flattenPrototype(target: object): void {
    const parent = Object.getPrototypeOf(target);
    if (!parent || parent === Object.prototype) return;

    for (const key of Object.getOwnPropertyNames(parent)) {
        if (key === 'constructor' || Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }

    for (const key of Object.getOwnPropertySymbols(parent)) {
        if (Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }
}

function receiverOrCreate<T extends object>(receiver: T | undefined, prototype: object): T {
    const target: T = receiver && (typeof receiver === 'object' || typeof receiver === 'function')
        ? receiver
        : Object.create(prototype);
    return target;
}

function toTransformOptions(o?: ZlibOptions & TransformOptions): TransformOptions | undefined {
    if (!o) return undefined;
    const {
        flush: _flush,
        finishFlush: _finishFlush,
        level: _level,
        strategy: _strategy,
        memLevel: _memLevel,
        maxOutputLength: _maxOutputLength,
        ...rest
    } = o;
    return rest;
}

type ZlibStreamState = {
    compress: boolean;
    flush: number;
    finishFlush: number;
    maxOutputLength?: number;
    outputLength: number;
    // Node counts every byte handed to the stream (uncompressed for compressors,
    // compressed for decompressors) and exposes it as `bytesWritten`.
    bytesWritten: number;
    // gzip members concatenate; track leftovers across chunk boundaries
    multiMember: boolean;
    autoDetect: boolean;
    pending?: Uint8Array;
    // a NUL byte after a finished gzip member ends the stream; later chunks are dropped
    trailingDone?: boolean;
    // sticky classification so a later flush cannot downgrade it
    error?: Error;
};

const zlibStreamStates = new WeakMap<object, ZlibStreamState>();

function configureZlibStream(stream: object, compress: boolean, options?: ZlibOptions, kind?: DecompressKind): void {
    // Node's ZlibBase records the requested level/strategy on the stream itself;
    // they are observable as `_level` / `_strategy` (v24.18.0 reports -1 / 0 by
    // default), so mirror them rather than leaving them undefined.
    Object.assign(stream, {
        _level: options?.level ?? DEFAULT_COMPRESSION,
        _strategy: options?.strategy ?? DEFAULT_STRATEGY,
    });
    zlibStreamStates.set(stream, {
        compress,
        flush: options?.flush ?? NO_FLUSH,
        finishFlush: options?.finishFlush ?? FINISH,
        // `maxOutputLength` is deliberately NOT carried onto streams: Node applies it
        // only to the convenience methods (zlibBuffer/zlibBufferSync), and a stream
        // created with it decompresses without limit. Verified against v24.18.0 —
        // createGunzip({maxOutputLength:1}) emits the full 100000-byte payload.
        maxOutputLength: undefined,
        outputLength: 0,
        bytesWritten: 0,
        multiMember: kind === 'gunzip',
        autoDetect: kind === 'unzip',
    });
}

function streamState(stream: object): ZlibStreamState {
    const state = zlibStreamStates.get(stream);
    if (!state) throw new Error('zlib stream is not initialized');
    return state;
}

function checkStreamOutput(stream: object, output: Buffer): Buffer {
    const state = streamState(stream);
    state.outputLength += output.byteLength;
    if (state.maxOutputLength !== undefined && state.outputLength > state.maxOutputLength) {
        throw new RangeError(`Cannot create a Buffer larger than ${state.maxOutputLength} bytes`);
    }
    return output;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * Feed one chunk into a decompression handle, walking gzip member boundaries and
 * buffering any bytes that need more input before they can be decoded.
 */
function inflateChunk(stream: NodeZlibTransform, state: ZlibStreamState, handle: ZlibInflateHandle, chunk: Uint8Array): Buffer {
    // A NUL after a finished member closed the stream; everything after is discarded.
    if (state.trailingDone) return checkStreamOutput(stream, Buffer.alloc(0));
    const data = state.pending && state.pending.length > 0 ? concatBytes(state.pending, chunk) : chunk;
    state.pending = undefined;
    if (state.autoDetect && data.length >= 2) {
        state.multiMember = hasGzipMagic(data);
        state.autoDetect = false;
    }
    const outputs: Buffer[] = [];
    let offset = 0;
    while (offset <= data.length) {
        const before = handle.getTotalIn?.() ?? 0;
        let produced: Uint8Array;
        try {
            produced = handle.inflate(data.subarray(offset), state.flush);
        } catch (err) {
            if (!isAlreadyFinished(err)) {
                state.error = corruptError();
                throw state.error;
            }
            // Current member ended; continue with the next one if input remains.
            const rest = data.subarray(offset);
            if (rest.length === 0) break;
            // Only gzip concatenates members; trailing bytes elsewhere are ignored.
            if (!state.multiMember) break;
            if (trailingIsPadding(rest)) {
                // NUL padding closes the stream: drop the rest and every later chunk.
                state.trailingDone = true;
                state.pending = undefined;
                break;
            }
            if (!handle.reset) {
                state.pending = rest;
                break;
            }
            handle.reset();
            continue;
        }
        if (produced.length > 0) outputs.push(Buffer.from(produced));
        const used = (handle.getTotalIn?.() ?? before) - before;
        offset += used;
        if (used === 0) {
            // Needs more input than this chunk carries.
            state.pending = data.subarray(offset);
            break;
        }
        if (offset >= data.length) break;
    }
    return checkStreamOutput(stream, Buffer.concat(outputs));
}

function _doTransform(stream: NodeZlibTransform, chunk: ZlibInput, cb: TransformCallback) {
    try {
        const state = streamState(stream);
        const handle = stream._handle;
        const input = toUint8Array(chunk);
        // Node counts input bytes before processing, so a chunk that errors is
        // still reflected in `bytesWritten`.
        state.bytesWritten += input.byteLength;
        const output = isDeflateHandle(handle)
            ? checkStreamOutput(stream, Buffer.from(handle.deflate(input, state.flush)))
            : inflateChunk(stream, state, handle, input);
        cb(null, output.length > 0 ? output : undefined);
    } catch (err) { cb(asError(err)); }
}

function installHandleCompat(handle: ZlibDeflateHandle): ZlibDeflateHandle;
function installHandleCompat(handle: ZlibInflateHandle): ZlibInflateHandle;
function installHandleCompat(handle: ZlibHandle): ZlibHandle {
    handle.close ??= () => {};
    return handle;
}

function processChunk(handle: ZlibHandle, chunk: ZlibInput, flush?: number): Buffer {
    try {
        const input = toUint8Array(chunk);
        return Buffer.from(isDeflateHandle(handle)
            ? handle.deflate(input, flush)
            : handle.inflate(input, flush));
    } catch (err) {
        if (/already finished/i.test(asError(err).message)) {
            return Buffer.alloc(0);
        }
        throw err;
    }
}

function _doFlush(stream: NodeZlibTransform, cb: TransformCallback) {
    try {
        const state = streamState(stream);
        if (state.error) throw state.error;
        // A NUL after a finished member already completed the stream.
        if (state.trailingDone) { cb(null); return; }
        // Leftover bytes that never formed a decodable member mean the stream was cut
        // short; NUL padding after a complete member is handled by `trailingDone`.
        if (!state.compress && state.pending && state.pending.length > 0) {
            const pending = state.pending;
            state.pending = undefined;
            if (isAllZeros(pending)) { cb(null); return; }
            if (state.finishFlush === FINISH) throw truncatedError();
        }
        const handle = stream._handle;
        const raw = state.finishFlush === FINISH
            ? handle.finish()
            : isDeflateHandle(handle)
                ? handle.deflate(new Uint8Array(), state.finishFlush)
                : handle.inflate(new Uint8Array(), state.finishFlush);
        const output = checkStreamOutput(stream, Buffer.from(raw));
        cb(null, output.length > 0 ? output : undefined);
    } catch (err) {
        const state = zlibStreamStates.get(stream);
        if (state?.error) {
            cb(state.error);
            return;
        }
        if (isAlreadyFinished(err)) {
            cb(null);
            return;
        }
        // The native finish() reports a generic failure when input ended mid-member.
        if (state && !state.compress && !hasErrorCode(err)) {
            cb(truncatedError());
            return;
        }
        cb(asError(err));
    }
}

interface NodeZlibTransform extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    flush(kind?: number | (() => void), callback?: () => void): this;
    reset(): void;
    params(level: number, strategy: number, callback?: () => void): this;
    close(callback?: () => void): void;
    readonly bytesWritten: number;
}

function flushStream(this: NodeZlibTransform, kindOrCallback?: number | (() => void), callback?: () => void): NodeZlibTransform {
    const kind = typeof kindOrCallback === 'number' ? kindOrCallback : SYNC_FLUSH;
    const cb = typeof kindOrCallback === 'function' ? kindOrCallback : callback;
    validateFlushFlag(kind, 'kind');
    try {
        // Called for its side effect: throws if the stream was never initialized.
        streamState(this);
        const output = checkStreamOutput(this, processChunk(this._handle, Buffer.alloc(0), kind));
        if (output.length > 0) this.push(output);
        if (cb) queueMicrotask(cb);
    } catch (error) {
        this.destroy(asError(error));
    }
    return this;
}

function resetStream(this: NodeZlibTransform): void {
    this._handle.reset?.();
    const state = streamState(this);
    state.outputLength = 0;
}

function paramsStream(this: NodeZlibTransform, level: number, strategy: number, callback?: () => void): NodeZlibTransform {
    validateOptions({ level, strategy });
    const handle = this._handle;
    if (!isDeflateHandle(handle) || !handle.params) throw new Error('params() is only supported for compression streams');
    // Drain pending output before changing params, as Node does. The native
    // deflateParams() would otherwise flush into the previous call's output buffer.
    streamState(this);
    const drained = checkStreamOutput(this, processChunk(handle, Buffer.alloc(0), SYNC_FLUSH));
    if (drained.length > 0) this.push(drained);
    handle.params(level, strategy);
    if (callback) queueMicrotask(callback);
    return this;
}

function closeStream(this: NodeZlibTransform, callback?: () => void): void {
    if (callback) this.once('close', callback);
    this._handle.close?.();
    this.destroy();
}

function installZlibMethods(prototype: NodeZlibTransform): void {
    prototype.flush = flushStream;
    prototype.reset = resetStream;
    prototype.params = paramsStream;
    prototype.close = closeStream;
    // Node exposes `bytesWritten` on every zlib stream: the running total of bytes
    // handed to the stream. `reset()` does not clear it (verified against v24.18.0).
    Object.defineProperty(prototype, 'bytesWritten', {
        get(this: NodeZlibTransform): number {
            return zlibStreamStates.get(this)?.bytesWritten ?? 0;
        },
        configurable: true,
        enumerable: false,
    });
}

export interface Deflate extends NodeZlibTransform {
    _handle: ZlibDeflateHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
}

interface DeflateConstructor {
    new (o?: ZlibOptions & TransformOptions): Deflate;
    (o?: ZlibOptions & TransformOptions): Deflate;
    prototype: Deflate;
}

function initDeflate(self: Deflate, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createDeflate(..._opts(o)));
    configureZlibStream(self, true, o);
}

export const Deflate: DeflateConstructor = function Deflate(this: Deflate | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Deflate.prototype);
    initDeflate(target, o);
    return target;
} as DeflateConstructor;

Object.setPrototypeOf(Deflate, Transform);
Deflate.prototype = Object.create(Transform.prototype);

Deflate.prototype._transform = function _transform(this: Deflate, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this, chunk, cb);
};

Deflate.prototype._flush = function _flush(this: Deflate, cb: TransformCallback): void {
    _doFlush(this, cb);
};

Deflate.prototype._processChunk = function _processChunk(this: Deflate, chunk: ZlibInput, flush?: number): Buffer {
    return checkStreamOutput(this, processChunk(this._handle, chunk, flush));
};

Deflate.prototype.close = function close(this: Deflate): void {
    this._handle.close?.();
};

Object.defineProperty(Deflate.prototype, 'constructor', {
    value: Deflate,
    writable: true,
    configurable: true,
});

flattenPrototype(Deflate.prototype);
installZlibMethods(Deflate.prototype);

const _opts = (o?: ZlibOptions) => [
    o?.level ?? zlib.DEFAULT_COMPRESSION,
    o?.strategy ?? zlib.DEFAULT_STRATEGY,
    o?.memLevel ?? 8
] as const;

export interface Inflate extends NodeZlibTransform {
    _handle: ZlibInflateHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
}

interface InflateConstructor {
    new (o?: ZlibOptions & TransformOptions): Inflate;
    (o?: ZlibOptions & TransformOptions): Inflate;
    prototype: Inflate;
}

function initInflate(self: Inflate, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createInflate());
    configureZlibStream(self, false, o);
}

export const Inflate: InflateConstructor = function Inflate(this: Inflate | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Inflate.prototype);
    initInflate(target, o);
    return target;
} as InflateConstructor;

Object.setPrototypeOf(Inflate, Transform);
Inflate.prototype = Object.create(Transform.prototype);

Inflate.prototype._transform = function _transform(this: Inflate, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this, chunk, cb);
};

Inflate.prototype._flush = function _flush(this: Inflate, cb: TransformCallback): void {
    _doFlush(this, cb);
};

Inflate.prototype._processChunk = function _processChunk(this: Inflate, chunk: ZlibInput, flush?: number): Buffer {
    return checkStreamOutput(this, processChunk(this._handle, chunk, flush));
};

Inflate.prototype.close = function close(this: Inflate): void {
    this._handle.close?.();
};

Object.defineProperty(Inflate.prototype, 'constructor', {
    value: Inflate,
    writable: true,
    configurable: true,
});

flattenPrototype(Inflate.prototype);
installZlibMethods(Inflate.prototype);

export interface Gzip extends NodeZlibTransform {
    _handle: ZlibDeflateHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
}

interface GzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Gzip;
    (o?: ZlibOptions & TransformOptions): Gzip;
    prototype: Gzip;
}

function initGzip(self: Gzip, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createGzip(..._opts(o)));
    configureZlibStream(self, true, o);
}

export const Gzip: GzipConstructor = function Gzip(this: Gzip | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Gzip.prototype);
    initGzip(target, o);
    return target;
} as GzipConstructor;

Object.setPrototypeOf(Gzip, Transform);
Gzip.prototype = Object.create(Transform.prototype);

Gzip.prototype._transform = function _transform(this: Gzip, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this, chunk, cb);
};

Gzip.prototype._flush = function _flush(this: Gzip, cb: TransformCallback): void {
    _doFlush(this, cb);
};

Gzip.prototype._processChunk = function _processChunk(this: Gzip, chunk: ZlibInput, flush?: number): Buffer {
    return checkStreamOutput(this, processChunk(this._handle, chunk, flush));
};

Gzip.prototype.close = function close(this: Gzip): void {
    this._handle.close?.();
};

Object.defineProperty(Gzip.prototype, 'constructor', {
    value: Gzip,
    writable: true,
    configurable: true,
});

flattenPrototype(Gzip.prototype);
installZlibMethods(Gzip.prototype);

export interface Gunzip extends NodeZlibTransform {
    _handle: ZlibInflateHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
}

interface GunzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Gunzip;
    (o?: ZlibOptions & TransformOptions): Gunzip;
    prototype: Gunzip;
}

function initGunzip(self: Gunzip, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createGunzip());
    configureZlibStream(self, false, o, 'gunzip');
}

export const Gunzip: GunzipConstructor = function Gunzip(this: Gunzip | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Gunzip.prototype);
    initGunzip(target, o);
    return target;
} as GunzipConstructor;

Object.setPrototypeOf(Gunzip, Transform);
Gunzip.prototype = Object.create(Transform.prototype);

Gunzip.prototype._transform = function _transform(this: Gunzip, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this, chunk, cb);
};

Gunzip.prototype._flush = function _flush(this: Gunzip, cb: TransformCallback): void {
    _doFlush(this, cb);
};

Gunzip.prototype._processChunk = function _processChunk(this: Gunzip, chunk: ZlibInput, flush?: number): Buffer {
    return checkStreamOutput(this, processChunk(this._handle, chunk, flush));
};

Gunzip.prototype.close = function close(this: Gunzip): void {
    this._handle.close?.();
};

Object.defineProperty(Gunzip.prototype, 'constructor', {
    value: Gunzip,
    writable: true,
    configurable: true,
});

flattenPrototype(Gunzip.prototype);
installZlibMethods(Gunzip.prototype);

export interface DeflateRaw extends NodeZlibTransform {
    _handle: ZlibDeflateHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
}

interface DeflateRawConstructor {
    new (o?: ZlibOptions & TransformOptions): DeflateRaw;
    (o?: ZlibOptions & TransformOptions): DeflateRaw;
    prototype: DeflateRaw;
}

function initDeflateRaw(self: DeflateRaw, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createDeflateRaw(..._opts(o)));
    configureZlibStream(self, true, o);
}

export const DeflateRaw: DeflateRawConstructor = function DeflateRaw(this: DeflateRaw | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, DeflateRaw.prototype);
    initDeflateRaw(target, o);
    return target;
} as DeflateRawConstructor;

Object.setPrototypeOf(DeflateRaw, Transform);
DeflateRaw.prototype = Object.create(Transform.prototype);

DeflateRaw.prototype._transform = function _transform(this: DeflateRaw, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this, chunk, cb);
};

DeflateRaw.prototype._flush = function _flush(this: DeflateRaw, cb: TransformCallback): void {
    _doFlush(this, cb);
};

DeflateRaw.prototype._processChunk = function _processChunk(this: DeflateRaw, chunk: ZlibInput, flush?: number): Buffer {
    return checkStreamOutput(this, processChunk(this._handle, chunk, flush));
};

DeflateRaw.prototype.close = function close(this: DeflateRaw): void {
    this._handle.close?.();
};

Object.defineProperty(DeflateRaw.prototype, 'constructor', {
    value: DeflateRaw,
    writable: true,
    configurable: true,
});

flattenPrototype(DeflateRaw.prototype);
installZlibMethods(DeflateRaw.prototype);

export interface InflateRaw extends NodeZlibTransform {
    _handle: ZlibInflateHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
}

interface InflateRawConstructor {
    new (o?: ZlibOptions & TransformOptions): InflateRaw;
    (o?: ZlibOptions & TransformOptions): InflateRaw;
    prototype: InflateRaw;
}

function initInflateRaw(self: InflateRaw, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createInflateRaw());
    configureZlibStream(self, false, o);
}

export const InflateRaw: InflateRawConstructor = function InflateRaw(this: InflateRaw | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, InflateRaw.prototype);
    initInflateRaw(target, o);
    return target;
} as InflateRawConstructor;

Object.setPrototypeOf(InflateRaw, Transform);
InflateRaw.prototype = Object.create(Transform.prototype);

InflateRaw.prototype._transform = function _transform(this: InflateRaw, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this, chunk, cb);
};

InflateRaw.prototype._flush = function _flush(this: InflateRaw, cb: TransformCallback): void {
    _doFlush(this, cb);
};

InflateRaw.prototype._processChunk = function _processChunk(this: InflateRaw, chunk: ZlibInput, flush?: number): Buffer {
    return checkStreamOutput(this, processChunk(this._handle, chunk, flush));
};

InflateRaw.prototype.close = function close(this: InflateRaw): void {
    this._handle.close?.();
};

Object.defineProperty(InflateRaw.prototype, 'constructor', {
    value: InflateRaw,
    writable: true,
    configurable: true,
});

flattenPrototype(InflateRaw.prototype);
installZlibMethods(InflateRaw.prototype);

export interface Unzip extends NodeZlibTransform {
    _handle: ZlibInflateHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
}

interface UnzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Unzip;
    (o?: ZlibOptions & TransformOptions): Unzip;
    prototype: Unzip;
}

function initUnzip(self: Unzip, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createUnzip());
    configureZlibStream(self, false, o, 'unzip');
}

export const Unzip: UnzipConstructor = function Unzip(this: Unzip | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Unzip.prototype);
    initUnzip(target, o);
    return target;
} as UnzipConstructor;

Object.setPrototypeOf(Unzip, Transform);
Unzip.prototype = Object.create(Transform.prototype);

Unzip.prototype._transform = function _transform(this: Unzip, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this, chunk, cb);
};

Unzip.prototype._flush = function _flush(this: Unzip, cb: TransformCallback): void {
    _doFlush(this, cb);
};

Unzip.prototype._processChunk = function _processChunk(this: Unzip, chunk: ZlibInput, flush?: number): Buffer {
    return checkStreamOutput(this, processChunk(this._handle, chunk, flush));
};

Unzip.prototype.close = function close(this: Unzip): void {
    this._handle.close?.();
};

Object.defineProperty(Unzip.prototype, 'constructor', {
    value: Unzip,
    writable: true,
    configurable: true,
});

flattenPrototype(Unzip.prototype);
installZlibMethods(Unzip.prototype);

// Factory functions

// The options reach `Cls` verbatim, so the parameter must carry the same
// `& TransformOptions` the constructor declares rather than a bare `O`.
function _create<T extends Transform, O>(Cls: ZlibStreamCtor<T, O>) {
    return (options?: O & TransformOptions) => new Cls(options);
}

export const createDeflate = _create(Deflate);
export const createInflate = _create(Inflate);
export const createGzip = _create(Gzip);
export const createGunzip = _create(Gunzip);
export const createDeflateRaw = _create(DeflateRaw);
export const createInflateRaw = _create(InflateRaw);
export const createUnzip = _create(Unzip);

// Checksum

export function crc32(data: ZlibInput, value?: number): number {
    return zlib.crc32(toUint8Array(data), value);
}

export function adler32(data: ZlibInput, value?: number): number {
    return zlib.adler32(toUint8Array(data), value);
}

// Brotli — use the native stateful encoder/decoder when available

const BROTLI_OPERATION_PROCESS = 0;
const BROTLI_OPERATION_FLUSH = 1;
const BROTLI_OPERATION_FINISH = 2;
const BROTLI_PARAM_MODE = 0;
const BROTLI_PARAM_QUALITY = 1;
const BROTLI_PARAM_LGWIN = 2;
const BROTLI_PARAM_LGBLOCK = 3;
const BROTLI_PARAM_SIZE_HINT = 5;
const BROTLI_PARAM_LARGE_WINDOW = 6;

function brotliParam(options: BrotliOptions | undefined, parameter: number): number | undefined {
    return options?.params?.[String(parameter)];
}

function brotliCompressOptions(options?: BrotliOptions): CModuleBrotli.CompressOptions {
    const result: CModuleBrotli.CompressOptions = {};
    const mode = brotliParam(options, BROTLI_PARAM_MODE);
    const quality = brotliParam(options, BROTLI_PARAM_QUALITY);
    const lgwin = brotliParam(options, BROTLI_PARAM_LGWIN);
    const lgblock = brotliParam(options, BROTLI_PARAM_LGBLOCK);
    const sizeHint = brotliParam(options, BROTLI_PARAM_SIZE_HINT);
    const largeWindow = brotliParam(options, BROTLI_PARAM_LARGE_WINDOW);
    if (mode !== undefined) result.mode = mode;
    if (quality !== undefined) result.quality = quality;
    if (lgwin !== undefined) result.lgwin = lgwin;
    if (lgblock !== undefined) result.lgblock = lgblock;
    if (sizeHint !== undefined) result.sizeHint = sizeHint;
    if (largeWindow !== undefined) result.largeWindow = Boolean(largeWindow);
    return result;
}

function brotliDecompressOptions(options?: BrotliOptions): CModuleBrotli.DecompressOptions {
    const largeWindow = brotliParam(options, 1);
    return largeWindow === undefined ? {} : { largeWindow: Boolean(largeWindow) };
}

function requireBrotli<T>(value: T | undefined): T {
    if (typeof value !== 'function') throw new Error('Brotli compression is not supported in this environment');
    return value;
}

function brotliCompressImpl(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    validateBrotliOptions(options);
    const compress = requireBrotli(nativeBrotli.compress);
    return checkMaxOutputLength(Buffer.from(compress(toUint8Array(buffer), brotliCompressOptions(options))), options);
}

function brotliDecompressImpl(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    validateBrotliOptions(options);
    const decompress = requireBrotli(nativeBrotli.decompress);
    return checkMaxOutputLength(Buffer.from(decompress(toUint8Array(buffer), brotliDecompressOptions(options))), options);
}

export function brotliCompressSync(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    return brotliCompressImpl(buffer, options);
}

export function brotliDecompressSync(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    return brotliDecompressImpl(buffer, options);
}

export const brotliCompress = wrapCallback(brotliCompressSync as SyncFn, options => validateBrotliOptions(options as BrotliOptions));
export const brotliDecompress = wrapCallback(brotliDecompressSync as SyncFn, options => validateBrotliOptions(options as BrotliOptions));

type BrotliStreamState = {
    flush: number;
    finishFlush: number;
    maxOutputLength?: number;
    outputLength: number;
};

const brotliStreamStates = new WeakMap<object, BrotliStreamState>();

function configureBrotliStream(stream: object, options?: BrotliOptions): void {
    brotliStreamStates.set(stream, {
        flush: options?.flush ?? BROTLI_OPERATION_PROCESS,
        finishFlush: options?.finishFlush ?? BROTLI_OPERATION_FINISH,
        // As with the zlib streams above, Node scopes `maxOutputLength` to the
        // convenience methods only. Measured on v24.18.0:
        // createBrotliDecompress({maxOutputLength:1}) emits all 100000 bytes,
        // while brotliDecompressSync(..., {maxOutputLength:1}) throws
        // ERR_BUFFER_TOO_LARGE. NOTE: not exercisable in this build, which has no
        // system libbrotli, so these ctors throw before reaching here.
        maxOutputLength: undefined,
        outputLength: 0,
    });
}

function checkBrotliStreamOutput(stream: object, output: Buffer): Buffer {
    const state = brotliStreamStates.get(stream);
    if (!state) throw new Error('Brotli stream is not initialized');
    state.outputLength += output.byteLength;
    if (state.maxOutputLength !== undefined && state.outputLength > state.maxOutputLength) {
        throw new RangeError(`Cannot create a Buffer larger than ${state.maxOutputLength} bytes`);
    }
    return output;
}

function brotliCompressOperation(handle: CModuleBrotli.BrotliCompress, operation: number, input?: Uint8Array): Buffer {
    switch (operation) {
        case BROTLI_OPERATION_PROCESS:
            return Buffer.from(handle.compress(input));
        case BROTLI_OPERATION_FLUSH: {
            const chunks: Buffer[] = [];
            if (input) chunks.push(Buffer.from(handle.compress(input)));
            chunks.push(Buffer.from(handle.flush()));
            return Buffer.concat(chunks);
        }
        case BROTLI_OPERATION_FINISH:
            return Buffer.from(handle.finish(input));
        default:
            throw new RangeError('Invalid Brotli stream operation');
    }
}

export interface BrotliCompress extends Transform {
    _handle: CModuleBrotli.BrotliCompress;
    flush(callback?: () => void): this;
    close(callback?: () => void): void;
}

interface BrotliCompressConstructor {
    new (options?: BrotliOptions & TransformOptions): BrotliCompress;
    (options?: BrotliOptions & TransformOptions): BrotliCompress;
    prototype: BrotliCompress;
}

export const BrotliCompress: BrotliCompressConstructor = function BrotliCompress(this: BrotliCompress | undefined, options?: BrotliOptions & TransformOptions) {
    const target = receiverOrCreate(this, BrotliCompress.prototype);
    validateBrotliOptions(options);
    Transform.call(target, toTransformOptions(options));
    target._handle = requireBrotli(nativeBrotli.createCompress)(brotliCompressOptions(options));
    configureBrotliStream(target, options);
    return target;
} as BrotliCompressConstructor;

Object.setPrototypeOf(BrotliCompress, Transform);
BrotliCompress.prototype = Object.create(Transform.prototype);

BrotliCompress.prototype._transform = function _transform(this: BrotliCompress, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    finishTransform(cb, () => {
        const state = brotliStreamStates.get(this)!;
        return checkBrotliStreamOutput(this, brotliCompressOperation(this._handle, state.flush, toUint8Array(chunk)));
    });
};

BrotliCompress.prototype._flush = function _flush(this: BrotliCompress, cb: TransformCallback): void {
    finishTransform(cb, () => {
        const state = brotliStreamStates.get(this)!;
        try {
            return checkBrotliStreamOutput(this, brotliCompressOperation(this._handle, state.finishFlush));
        } catch (error) {
            if (/already finished/i.test(asError(error).message)) return Buffer.alloc(0);
            throw error;
        }
    });
};

BrotliCompress.prototype.flush = function flush(this: BrotliCompress, callback?: () => void): BrotliCompress {
    try {
        const output = checkBrotliStreamOutput(this, Buffer.from(this._handle.flush()));
        if (output.length > 0) this.push(output);
        if (callback) queueMicrotask(callback);
    } catch (error) {
        this.destroy(asError(error));
    }
    return this;
};

BrotliCompress.prototype.close = function close(this: BrotliCompress, callback?: () => void): void {
    if (callback) this.once('close', callback);
    this.destroy();
};

Object.defineProperty(BrotliCompress.prototype, 'constructor', {
    value: BrotliCompress,
    writable: true,
    configurable: true,
});

flattenPrototype(BrotliCompress.prototype);

export interface BrotliDecompress extends Transform {
    _handle: CModuleBrotli.BrotliDecompress;
    flush(callback?: () => void): this;
    close(callback?: () => void): void;
}

interface BrotliDecompressConstructor {
    new (options?: BrotliOptions & TransformOptions): BrotliDecompress;
    (options?: BrotliOptions & TransformOptions): BrotliDecompress;
    prototype: BrotliDecompress;
}

export const BrotliDecompress: BrotliDecompressConstructor = function BrotliDecompress(this: BrotliDecompress | undefined, options?: BrotliOptions & TransformOptions) {
    const target = receiverOrCreate(this, BrotliDecompress.prototype);
    validateBrotliOptions(options);
    Transform.call(target, toTransformOptions(options));
    target._handle = requireBrotli(nativeBrotli.createDecompress)(brotliDecompressOptions(options));
    configureBrotliStream(target, options);
    return target;
} as BrotliDecompressConstructor;

Object.setPrototypeOf(BrotliDecompress, Transform);
BrotliDecompress.prototype = Object.create(Transform.prototype);

BrotliDecompress.prototype._transform = function _transform(this: BrotliDecompress, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    finishTransform(cb, () => checkBrotliStreamOutput(this, Buffer.from(this._handle.decompress(toUint8Array(chunk)))));
};

BrotliDecompress.prototype._flush = function _flush(this: BrotliDecompress, cb: TransformCallback): void {
    finishTransform(cb, () => checkBrotliStreamOutput(this, Buffer.from(this._handle.finish())));
};

BrotliDecompress.prototype.flush = function flush(this: BrotliDecompress, callback?: () => void): BrotliDecompress {
    try {
        const output = checkBrotliStreamOutput(this, Buffer.from(this._handle.decompress(Buffer.alloc(0))));
        if (output.length > 0) this.push(output);
        if (callback) queueMicrotask(callback);
    } catch (error) {
        this.destroy(asError(error));
    }
    return this;
};

BrotliDecompress.prototype.close = function close(this: BrotliDecompress, callback?: () => void): void {
    if (callback) this.once('close', callback);
    this.destroy();
};

Object.defineProperty(BrotliDecompress.prototype, 'constructor', {
    value: BrotliDecompress,
    writable: true,
    configurable: true,
});

flattenPrototype(BrotliDecompress.prototype);

export const createBrotliCompress = _create(BrotliCompress);
export const createBrotliDecompress = _create(BrotliDecompress);

// Constants

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

// `export type` (not `export interface`) so `export * from './mod'`
// cannot materialise these as undefined runtime exports.
export type {
    ZlibOptions,
    BrotliOptions,
    ZlibInput,
    CompressCallback,
    DeflateConstructor,
    InflateConstructor,
    GzipConstructor,
    GunzipConstructor,
    DeflateRawConstructor,
    InflateRawConstructor,
    UnzipConstructor,
    BrotliCompressConstructor,
    BrotliDecompressConstructor,
};
