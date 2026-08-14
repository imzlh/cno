/**
 * Node.js zlib module — public surface.
 * Based on CModuleZLib implementation
 *
 * This file is a facade: the implementation lives in the sibling modules listed
 * below, and the export list here IS the public API. It is spelled out name by
 * name rather than using `export *`, because the submodules also export
 * internals to each other (error factories, byte probes, prototype helpers, the
 * stream-state WeakMap) and `export *` would publish those as `node:zlib`
 * exports.
 *
 *   constants.ts  native flush/level/strategy values, `constants`, `codes`;
 *                 error factories, Node's `Received ...`/ERR_OUT_OF_RANGE
 *                 forms; option and input validation, byte probes,
 *                 VALID_FLUSH_FLAGS
 *   streams.ts    the 7 zlib Transform classes + the zlibStreamStates WeakMap
 *   sync.ts       one-shot *Sync helpers and their callback wrappers
 *   brotli.ts     Brotli one-shots, streams + the brotliStreamStates WeakMap
 *
 * Import order below mirrors the original single-file evaluation order
 * (constants, then streams/sync, then brotli), so side effects such as the
 * prototype flattening in `streams.ts` still run at the same point.
 */

export {
    // Compression Levels
    NO_COMPRESSION,
    BEST_SPEED,
    BEST_COMPRESSION,
    DEFAULT_COMPRESSION,
    // Compression Strategies
    DEFAULT_STRATEGY,
    FILTERED,
    HUFFMAN_ONLY,
    RLE,
    FIXED,
    // Flush Modes
    NO_FLUSH,
    PARTIAL_FLUSH,
    SYNC_FLUSH,
    FULL_FLUSH,
    FINISH,
    BLOCK,
    // Published constant tables
    constants,
    codes,
} from './constants';

export {
    Deflate,
    Inflate,
    Gzip,
    Gunzip,
    DeflateRaw,
    InflateRaw,
    Unzip,
    createDeflate,
    createInflate,
    createGzip,
    createGunzip,
    createDeflateRaw,
    createInflateRaw,
    createUnzip,
    crc32,
    adler32,
} from './streams';

export {
    deflateSync,
    deflateRawSync,
    gzipSync,
    inflateSync,
    inflateRawSync,
    gunzipSync,
    unzipSync,
    deflate,
    deflateRaw,
    gzip,
    inflate,
    inflateRaw,
    gunzip,
    unzip,
} from './sync';

export {
    brotliCompressSync,
    brotliDecompressSync,
    brotliCompress,
    brotliDecompress,
    BrotliCompress,
    BrotliDecompress,
    createBrotliCompress,
    createBrotliDecompress,
} from './brotli';

// `export type` (not `export interface`) so `export * from './mod'`
// cannot materialise these as undefined runtime exports.
export type { ZlibInfoResult, CompressCallback } from './sync';
export type { ZlibOptions, BrotliOptions, ZlibInput } from './constants';
export type {
    DeflateConstructor,
    InflateConstructor,
    GzipConstructor,
    GunzipConstructor,
    DeflateRawConstructor,
    InflateRawConstructor,
    UnzipConstructor,
} from './streams';
export type { BrotliCompressConstructor, BrotliDecompressConstructor } from './brotli';
