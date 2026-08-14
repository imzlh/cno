/**
 * Node.js zlib module — one-shot (sync) and callback-style compression.
 *
 * Depends on `./streams` for the engine classes that `{ info: true }` returns
 * and for the shared handle types. The dependency runs one way only: the stream
 * classes never call back into this file.
 */

import {
    asError,
    checkMaxOutputLength,
    corruptError,
    FINISH,
    hasGzipMagic,
    isAlreadyFinished,
    NO_FLUSH,
    orUndef,
    toUint8Array,
    trailingIsPadding,
    truncatedError,
    validateOptions,
    validateZlibInput,
    type BrotliOptions,
    type ZlibInput,
    type ZlibOptions,
} from './constants';
import {
    Deflate,
    DeflateRaw,
    Gunzip,
    Gzip,
    Inflate,
    InflateRaw,
    Unzip,
    zlibStreamStates,
    type DecompressKind,
    type NodeZlibTransform,
    type ZlibHandle,
    type ZlibInflateHandle,
} from './streams';
import type { TransformOptions } from '../stream';

const zlib = import.meta.use('zlib');

type CompressCallback = (err: Error | null, result?: Buffer | ZlibInfoResult) => void;

export type { CompressCallback };

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
 * Referenced lazily inside the function body: the stream constructors come from
 * `./streams`, and keeping the lookup in the body (rather than in a top-level
 * table) preserves the original TDZ-safe shape.
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
    bytesWritten = inputLength,
): Buffer | ZlibInfoResult {
    if (options?.info !== true) return output;
    const engine = newInfoEngine(kind, options as (ZlibOptions & TransformOptions) | undefined);
    const state = zlibStreamStates.get(engine);
    if (state) state.bytesWritten = bytesWritten;
    // Node releases the native handle and leaves `_handle === null` on the returned
    // engine, while `closed`/`destroyed` stay false. Match that shape: callers (and
    // Node's own `zlib binding closed` guard) test `_handle` for null.
    engine._handle.close?.();
    (engine as { _handle: ZlibHandle | null })._handle = null;
    return { buffer: output, engine };
}

// Native decompression handle factories, keyed by Node codec name.

const DECOMPRESS_FACTORIES: Record<DecompressKind, () => ZlibInflateHandle> = {
    inflate: () => zlib.createInflate(),
    inflateRaw: () => zlib.createInflateRaw(),
    gunzip: () => zlib.createGunzip(),
    unzip: () => zlib.createUnzip(),
};

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

    return withInfo(
        kind,
        checkMaxOutputLength(Buffer.concat(chunks), options),
        input.byteLength,
        options,
        offset,
    );
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

export type { SyncFn };

export function wrapCallback(syncFn: SyncFn, validator: (options?: ZlibOptions | BrotliOptions) => void = validateOptions) {
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
