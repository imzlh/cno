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

export interface Deflate extends Transform {
    _handle: any;
}

export interface DeflateConstructor {
    new (o?: ZlibOptions & TransformOptions): Deflate;
    (o?: ZlibOptions & TransformOptions): Deflate;
    prototype: Deflate;
}

function initDeflate(self: any, o?: ZlibOptions & TransformOptions): void {
    Transform.call(self, o);
    self._handle = zlib.createDeflate(..._opts(o));
}

export const Deflate: DeflateConstructor = function Deflate(this: any, o?: ZlibOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Deflate.prototype);
    initDeflate(target, o);
    return target;
} as DeflateConstructor;

Object.setPrototypeOf(Deflate, Transform);
Deflate.prototype = Object.create(Transform.prototype);

Deflate.prototype._transform = function _transform(this: Deflate, chunk: any, _e: BufferEncoding, cb: any): void {
    _doTransform(this._handle, chunk, true, cb);
};

Deflate.prototype._flush = function _flush(this: Deflate, cb: any): void {
    _doFlush(this._handle, cb);
};

Object.defineProperty(Deflate.prototype, 'constructor', {
    value: Deflate,
    writable: true,
    configurable: true,
});

flattenPrototype(Deflate.prototype);

const _opts = (o?: ZlibOptions) => [
    o?.level ?? zlib.DEFAULT_COMPRESSION,
    o?.strategy ?? zlib.DEFAULT_STRATEGY,
    o?.memLevel ?? 8
] as const;

export interface Inflate extends Transform {
    _handle: any;
}

export interface InflateConstructor {
    new (o?: ZlibOptions & TransformOptions): Inflate;
    (o?: ZlibOptions & TransformOptions): Inflate;
    prototype: Inflate;
}

function initInflate(self: any, o?: ZlibOptions & TransformOptions): void {
    Transform.call(self, o);
    self._handle = zlib.createInflate();
}

export const Inflate: InflateConstructor = function Inflate(this: any, o?: ZlibOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Inflate.prototype);
    initInflate(target, o);
    return target;
} as InflateConstructor;

Object.setPrototypeOf(Inflate, Transform);
Inflate.prototype = Object.create(Transform.prototype);

Inflate.prototype._transform = function _transform(this: Inflate, chunk: any, _e: BufferEncoding, cb: any): void {
    _doTransform(this._handle, chunk, false, cb);
};

Inflate.prototype._flush = function _flush(this: Inflate, cb: any): void {
    _doFlush(this._handle, cb);
};

Object.defineProperty(Inflate.prototype, 'constructor', {
    value: Inflate,
    writable: true,
    configurable: true,
});

flattenPrototype(Inflate.prototype);

export interface Gzip extends Transform {
    _handle: any;
}

export interface GzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Gzip;
    (o?: ZlibOptions & TransformOptions): Gzip;
    prototype: Gzip;
}

function initGzip(self: any, o?: ZlibOptions & TransformOptions): void {
    Transform.call(self, o);
    self._handle = zlib.createGzip(..._opts(o));
}

export const Gzip: GzipConstructor = function Gzip(this: any, o?: ZlibOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Gzip.prototype);
    initGzip(target, o);
    return target;
} as GzipConstructor;

Object.setPrototypeOf(Gzip, Transform);
Gzip.prototype = Object.create(Transform.prototype);

Gzip.prototype._transform = function _transform(this: Gzip, chunk: any, _e: BufferEncoding, cb: any): void {
    _doTransform(this._handle, chunk, true, cb);
};

Gzip.prototype._flush = function _flush(this: Gzip, cb: any): void {
    _doFlush(this._handle, cb);
};

Object.defineProperty(Gzip.prototype, 'constructor', {
    value: Gzip,
    writable: true,
    configurable: true,
});

flattenPrototype(Gzip.prototype);

export interface Gunzip extends Transform {
    _handle: any;
}

export interface GunzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Gunzip;
    (o?: ZlibOptions & TransformOptions): Gunzip;
    prototype: Gunzip;
}

function initGunzip(self: any, o?: ZlibOptions & TransformOptions): void {
    Transform.call(self, o);
    self._handle = zlib.createGunzip();
}

export const Gunzip: GunzipConstructor = function Gunzip(this: any, o?: ZlibOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Gunzip.prototype);
    initGunzip(target, o);
    return target;
} as GunzipConstructor;

Object.setPrototypeOf(Gunzip, Transform);
Gunzip.prototype = Object.create(Transform.prototype);

Gunzip.prototype._transform = function _transform(this: Gunzip, chunk: any, _e: BufferEncoding, cb: any): void {
    _doTransform(this._handle, chunk, false, cb);
};

Gunzip.prototype._flush = function _flush(this: Gunzip, cb: any): void {
    _doFlush(this._handle, cb);
};

Object.defineProperty(Gunzip.prototype, 'constructor', {
    value: Gunzip,
    writable: true,
    configurable: true,
});

flattenPrototype(Gunzip.prototype);

export interface DeflateRaw extends Transform {
    _handle: any;
}

export interface DeflateRawConstructor {
    new (o?: ZlibOptions & TransformOptions): DeflateRaw;
    (o?: ZlibOptions & TransformOptions): DeflateRaw;
    prototype: DeflateRaw;
}

function initDeflateRaw(self: any, o?: ZlibOptions & TransformOptions): void {
    Transform.call(self, o);
    self._handle = zlib.createDeflateRaw(..._opts(o));
}

export const DeflateRaw: DeflateRawConstructor = function DeflateRaw(this: any, o?: ZlibOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(DeflateRaw.prototype);
    initDeflateRaw(target, o);
    return target;
} as DeflateRawConstructor;

Object.setPrototypeOf(DeflateRaw, Transform);
DeflateRaw.prototype = Object.create(Transform.prototype);

DeflateRaw.prototype._transform = function _transform(this: DeflateRaw, chunk: any, _e: BufferEncoding, cb: any): void {
    _doTransform(this._handle, chunk, true, cb);
};

DeflateRaw.prototype._flush = function _flush(this: DeflateRaw, cb: any): void {
    _doFlush(this._handle, cb);
};

Object.defineProperty(DeflateRaw.prototype, 'constructor', {
    value: DeflateRaw,
    writable: true,
    configurable: true,
});

flattenPrototype(DeflateRaw.prototype);

export interface InflateRaw extends Transform {
    _handle: any;
}

export interface InflateRawConstructor {
    new (o?: ZlibOptions & TransformOptions): InflateRaw;
    (o?: ZlibOptions & TransformOptions): InflateRaw;
    prototype: InflateRaw;
}

function initInflateRaw(self: any, o?: ZlibOptions & TransformOptions): void {
    Transform.call(self, o);
    self._handle = zlib.createInflateRaw();
}

export const InflateRaw: InflateRawConstructor = function InflateRaw(this: any, o?: ZlibOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(InflateRaw.prototype);
    initInflateRaw(target, o);
    return target;
} as InflateRawConstructor;

Object.setPrototypeOf(InflateRaw, Transform);
InflateRaw.prototype = Object.create(Transform.prototype);

InflateRaw.prototype._transform = function _transform(this: InflateRaw, chunk: any, _e: BufferEncoding, cb: any): void {
    _doTransform(this._handle, chunk, false, cb);
};

InflateRaw.prototype._flush = function _flush(this: InflateRaw, cb: any): void {
    _doFlush(this._handle, cb);
};

Object.defineProperty(InflateRaw.prototype, 'constructor', {
    value: InflateRaw,
    writable: true,
    configurable: true,
});

flattenPrototype(InflateRaw.prototype);

export interface Unzip extends Transform {
    _handle: any;
}

export interface UnzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Unzip;
    (o?: ZlibOptions & TransformOptions): Unzip;
    prototype: Unzip;
}

function initUnzip(self: any, o?: ZlibOptions & TransformOptions): void {
    Transform.call(self, o);
    self._handle = zlib.createGunzip();
}

export const Unzip: UnzipConstructor = function Unzip(this: any, o?: ZlibOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Unzip.prototype);
    initUnzip(target, o);
    return target;
} as UnzipConstructor;

Object.setPrototypeOf(Unzip, Transform);
Unzip.prototype = Object.create(Transform.prototype);

Unzip.prototype._transform = function _transform(this: Unzip, chunk: any, _e: BufferEncoding, cb: any): void {
    _doTransform(this._handle, chunk, false, cb);
};

Unzip.prototype._flush = function _flush(this: Unzip, cb: any): void {
    _doFlush(this._handle, cb);
};

Object.defineProperty(Unzip.prototype, 'constructor', {
    value: Unzip,
    writable: true,
    configurable: true,
});

flattenPrototype(Unzip.prototype);

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

export interface BrotliCompress extends Transform {}

export interface BrotliCompressConstructor {
    new (options?: BrotliOptions & TransformOptions): BrotliCompress;
    (options?: BrotliOptions & TransformOptions): BrotliCompress;
    prototype: BrotliCompress;
}

export const BrotliCompress: BrotliCompressConstructor = function BrotliCompress(this: any, options?: BrotliOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(BrotliCompress.prototype);
    Transform.call(target, options);
    return target;
} as BrotliCompressConstructor;

Object.setPrototypeOf(BrotliCompress, Transform);
BrotliCompress.prototype = Object.create(Transform.prototype);

BrotliCompress.prototype._transform = function _transform(this: BrotliCompress, chunk: any, _e: BufferEncoding, cb: any): void {
    try { cb(null, brotliCompressImpl(toUint8Array(chunk))); } catch (err) { cb(err); }
};

Object.defineProperty(BrotliCompress.prototype, 'constructor', {
    value: BrotliCompress,
    writable: true,
    configurable: true,
});

flattenPrototype(BrotliCompress.prototype);

export interface BrotliDecompress extends Transform {}

export interface BrotliDecompressConstructor {
    new (options?: BrotliOptions & TransformOptions): BrotliDecompress;
    (options?: BrotliOptions & TransformOptions): BrotliDecompress;
    prototype: BrotliDecompress;
}

export const BrotliDecompress: BrotliDecompressConstructor = function BrotliDecompress(this: any, options?: BrotliOptions & TransformOptions) {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(BrotliDecompress.prototype);
    Transform.call(target, options);
    return target;
} as BrotliDecompressConstructor;

Object.setPrototypeOf(BrotliDecompress, Transform);
BrotliDecompress.prototype = Object.create(Transform.prototype);

BrotliDecompress.prototype._transform = function _transform(this: BrotliDecompress, chunk: any, _e: BufferEncoding, cb: any): void {
    try { cb(null, brotliDecompressImpl(toUint8Array(chunk))); } catch (err) { cb(err); }
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
};