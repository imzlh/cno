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
        case 'deflate': return new Deflate(opts);
        case 'deflateRaw': return new DeflateRaw(opts);
        case 'gzip': return new Gzip(opts);
        case 'inflate': return new Inflate(opts);
        case 'inflateRaw': return new InflateRaw(opts);
        case 'gunzip': return new Gunzip(opts);
        case 'unzip': return new Unzip(opts);
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
    // Bytes up to the end of the last complete member (what `info` reports).
    let consumed = 0;

    while (true) {
        // The native handle reports malformed compressed data as a TypeError;
        // expose Node's Z_DATA_ERROR instead of treating it as a completed member.
        const rest = input.subarray(offset);
        if (!ArrayBuffer.isView(rest)) throw corruptError();
        let produced: Uint8Array;
        try {
            produced = handle.inflate(rest, NO_FLUSH);
        } catch (err) {
            // The handle refuses input once the member's trailer has been
            // consumed; the `finished` check below normally prevents that.
            if (isAlreadyFinished(err)) break;
            throw corruptError();
        }
        if (produced.length > 0) chunks.push(Buffer.from(produced));

        const used = handle.getTotalIn?.() ?? input.length - offset;
        // The native handle marks itself finished the moment inflate() sees the
        // trailer, and finishing again throws an uncatchable InternalError, so
        // ask for the state instead of calling finish() unconditionally.
        // `partialOk` (finishFlush !== Z_FINISH) keeps a truncated member's
        // output, as Node does; otherwise a member that never reached its
        // trailer is Z_BUF_ERROR.
        if (handle.finished !== true) {
            if (!partialOk) throw truncatedError();
            break;
        }

        offset += used;
        consumed = offset;
        if (used === 0 || offset >= input.length || !multiMember) break;
        // Trailing NUL padding after a complete member is not an error in Node.
        if (trailingIsPadding(input.subarray(offset))) break;
        // Anything else is read as the start of a new member and rejected by
        // Node with Z_DATA_ERROR.
        if (!hasGzipMagic(input.subarray(offset))) throw corruptError();
        if (!handle.reset) break;
        handle.reset();
    }

    return withInfo(
        kind,
        checkMaxOutputLength(Buffer.concat(chunks), options),
        input.byteLength,
        options,
        consumed,
    );
}
// Sync compress/decompress

function compressSync(kind: 'deflate' | 'deflateRaw' | 'gzip', buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    const input = toUint8Array(buffer);
    const output = zlib[kind](input, level, orUndef(options?.strategy), orUndef(options?.memLevel));
    const out = checkMaxOutputLength(Buffer.from(output), options);
    return withInfo(kind, out, input.byteLength, options);
}

export function deflateSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function deflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function deflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    return compressSync('deflate', buffer, options);
}

export function deflateRawSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function deflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function deflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    return compressSync('deflateRaw', buffer, options);
}

export function gzipSync(buffer: ZlibInput, options: ZlibOptions & { info: true }): ZlibInfoResult;
export function gzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer;
export function gzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer | ZlibInfoResult {
    return compressSync('gzip', buffer, options);
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
        const input = new Uint8Array(toUint8Array(buffer));
        validator(opts);
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
