// Spelled out rather than `export *`: submodules export internals to each other.
// Import order matters: streams.ts flattens prototypes as a side effect.

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
