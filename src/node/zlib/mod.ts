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

export interface ZlibOptions {
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

export interface BrotliOptions {
    flush?: number;
    finishFlush?: number;
    chunkSize?: number;
    params?: Record<string, number>;
    maxOutputLength?: number;
}

export type CompressCallback = (err: Error | null, result?: Uint8Array) => void;

// Internal helper functions

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
    return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

// Sync compress/decompress

export function deflateSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return new Uint8Array(zlib.deflate(buffer, level));
}

export function deflateRawSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return new Uint8Array(zlib.deflateRaw(buffer, level));
}

export function gzipSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return new Uint8Array(zlib.gzip(buffer, level));
}

export function inflateSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    return new Uint8Array(zlib.inflate(buffer));
}

export function inflateRawSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    return new Uint8Array(zlib.inflateRaw(buffer));
}

export function gunzipSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    return new Uint8Array(zlib.gunzip(buffer));
}

export function unzipSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    // Auto-detect format by magic number
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        return new Uint8Array(zlib.gunzip(buffer));
    }
    if (buf[0] === 0x78 && (buf[1] === 0x01 || buf[1] === 0x5e || buf[1] === 0x9c || buf[1] === 0xda)) {
        return new Uint8Array(zlib.inflate(buffer));
    }
    // Try gunzip first, then inflate
    try { return new Uint8Array(zlib.gunzip(buffer)); } catch {}
    return new Uint8Array(zlib.inflate(buffer));
}

// Async compress/decompress (callback style)

type SyncFn = (buf: ArrayBuffer | Uint8Array, opts?: ZlibOptions) => Uint8Array;

function wrapCallback(syncFn: SyncFn) {
    return function(buffer: ArrayBuffer | Uint8Array, optionsOrCallback: ZlibOptions | CompressCallback, callback?: CompressCallback) {
        const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
        const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        queueMicrotask(() => {
            try { cb?.(null, syncFn(buffer, opts)); }
            catch (err) { cb?.(err as Error); }
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

function _doTransform(handle: any, chunk: any, compress: boolean, cb: any) {
    try {
        const fn = compress ? 'deflate' : 'inflate';
        cb(null, new Uint8Array(handle[fn](toUint8Array(chunk))));
    } catch (err) { cb(err); }
}

function _doFlush(handle: any, cb: any) {
    try { cb(null, new Uint8Array(handle.finish())); }
    catch (err) { cb(err); }
}

export class Deflate extends Transform {
    _handle: any;
    constructor(o?: ZlibOptions & TransformOptions) { super(o); this._handle = zlib.createDeflate(..._opts(o)); }
    _transform(chunk: any, _e: BufferEncoding, cb: any) { _doTransform(this._handle, chunk, true, cb); }
    _flush(cb: any) { _doFlush(this._handle, cb); }
}

const _opts = (o?: ZlibOptions) => [
    o?.level ?? zlib.DEFAULT_COMPRESSION,
    o?.strategy ?? zlib.DEFAULT_STRATEGY,
    o?.memLevel ?? 8
] as const;

export class Inflate extends Transform {
    _handle: any;
    constructor(o?: ZlibOptions & TransformOptions) { super(o); this._handle = zlib.createInflate(); }
    _transform(chunk: any, _e: BufferEncoding, cb: any) { _doTransform(this._handle, chunk, false, cb); }
    _flush(cb: any) { _doFlush(this._handle, cb); }
}

export class Gzip extends Transform {
    _handle: any;
    constructor(o?: ZlibOptions & TransformOptions) { super(o); this._handle = zlib.createGzip(..._opts(o)); }
    _transform(chunk: any, _e: BufferEncoding, cb: any) { _doTransform(this._handle, chunk, true, cb); }
    _flush(cb: any) { _doFlush(this._handle, cb); }
}

export class Gunzip extends Transform {
    _handle: any;
    constructor(o?: ZlibOptions & TransformOptions) { super(o); this._handle = zlib.createGunzip(); }
    _transform(chunk: any, _e: BufferEncoding, cb: any) { _doTransform(this._handle, chunk, false, cb); }
    _flush(cb: any) { _doFlush(this._handle, cb); }
}

export class DeflateRaw extends Transform {
    _handle: any;
    constructor(o?: ZlibOptions & TransformOptions) { super(o); this._handle = zlib.createDeflateRaw(..._opts(o)); }
    _transform(chunk: any, _e: BufferEncoding, cb: any) { _doTransform(this._handle, chunk, true, cb); }
    _flush(cb: any) { _doFlush(this._handle, cb); }
}

export class InflateRaw extends Transform {
    _handle: any;
    constructor(o?: ZlibOptions & TransformOptions) { super(o); this._handle = zlib.createInflateRaw(); }
    _transform(chunk: any, _e: BufferEncoding, cb: any) { _doTransform(this._handle, chunk, false, cb); }
    _flush(cb: any) { _doFlush(this._handle, cb); }
}

export class Unzip extends Transform {
    _handle: any;
    constructor(o?: ZlibOptions & TransformOptions) { super(o); this._handle = zlib.createGunzip(); }
    _transform(chunk: any, _e: BufferEncoding, cb: any) { _doTransform(this._handle, chunk, false, cb); }
    _flush(cb: any) { _doFlush(this._handle, cb); }
}

// Factory functions

function _create(Cls: any) { return (options?: ZlibOptions) => new Cls(options); }

export const createDeflate = _create(Deflate);
export const createInflate = _create(Inflate);
export const createGzip = _create(Gzip);
export const createGunzip = _create(Gunzip);
export const createDeflateRaw = _create(DeflateRaw);
export const createInflateRaw = _create(InflateRaw);
export const createUnzip = _create(Unzip);

// Checksum

export function crc32(data: ArrayBuffer | Uint8Array, value?: number): number {
    return zlib.crc32(data, value);
}

export function adler32(data: ArrayBuffer | Uint8Array, value?: number): number {
    return zlib.adler32(data, value);
}

// Brotli — use native if available, otherwise error

function brotliCompressImpl(buffer: ArrayBuffer | Uint8Array): Uint8Array {
    if (typeof (zlib as any).brotliCompress === 'function') {
        return new Uint8Array((zlib as any).brotliCompress(buffer));
    }
    throw new Error('Brotli compression is not supported in this environment');
}

function brotliDecompressImpl(buffer: ArrayBuffer | Uint8Array): Uint8Array {
    if (typeof (zlib as any).brotliDecompress === 'function') {
        return new Uint8Array((zlib as any).brotliDecompress(buffer));
    }
    throw new Error('Brotli decompression is not supported in this environment');
}

export function brotliCompressSync(buffer: ArrayBuffer | Uint8Array, _options?: BrotliOptions): Uint8Array {
    return brotliCompressImpl(buffer);
}

export function brotliDecompressSync(buffer: ArrayBuffer | Uint8Array, _options?: BrotliOptions): Uint8Array {
    return brotliDecompressImpl(buffer);
}

export const brotliCompress = wrapCallback(brotliCompressSync as SyncFn);
export const brotliDecompress = wrapCallback(brotliDecompressSync as SyncFn);

export class BrotliCompress extends Transform {
    _transform(chunk: any, _e: BufferEncoding, cb: any) {
        try { cb(null, brotliCompressImpl(toUint8Array(chunk))); } catch (err) { cb(err); }
    }
}

export class BrotliDecompress extends Transform {
    _transform(chunk: any, _e: BufferEncoding, cb: any) {
        try { cb(null, brotliDecompressImpl(toUint8Array(chunk))); } catch (err) { cb(err); }
    }
}

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
};