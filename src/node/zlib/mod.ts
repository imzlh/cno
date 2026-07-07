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

export type ZlibInput = string | ArrayBuffer | ArrayBufferView;
export type CompressCallback = (err: Error | null, result?: Buffer) => void;
type ZlibHandle = {
    deflate(input: Uint8Array, flush?: number): Uint8Array;
    inflate(input: Uint8Array, flush?: number): Uint8Array;
    finish(): Uint8Array;
    close?: () => void;
    reset?: () => void;
    params?: (level: number, strategy: number) => void;
};
type TransformCallback = (err: unknown, result?: Buffer) => void;
type ZlibStreamCtor<T extends Transform, O> = new (options?: O & TransformOptions) => T;
type BrotliNative = {
    brotliCompress?: (input: Uint8Array) => Uint8Array;
    brotliDecompress?: (input: Uint8Array) => Uint8Array;
};
const nativeBrotli: BrotliNative = zlib;

// Internal helper functions

function finishTransform(cb: TransformCallback, operation: () => Buffer): void {
    try {
        cb(null, operation());
    } catch (err) {
        cb(err);
    }
}

function toUint8Array(data: ZlibInput): Uint8Array {
    if (typeof data === 'string') return Buffer.from(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('The "buffer" argument must be a string, Buffer, TypedArray, DataView, or ArrayBuffer');
}

function validateZlibInput(data: ZlibInput): void {
    if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return;
    throw new TypeError('The "buffer" argument must be a string, Buffer, TypedArray, DataView, or ArrayBuffer');
}

function validateOptions(options?: { flush?: number; finishFlush?: number; maxOutputLength?: number }): void {
    if (options?.flush !== undefined && !Number.isInteger(options.flush)) {
        throw new TypeError('The "options.flush" property must be an integer');
    }
    if (options?.finishFlush !== undefined && !Number.isInteger(options.finishFlush)) {
        throw new TypeError('The "options.finishFlush" property must be an integer');
    }
    if (options?.maxOutputLength !== undefined && (!Number.isInteger(options.maxOutputLength) || options.maxOutputLength < 0)) {
        throw new RangeError('The "options.maxOutputLength" property must be a non-negative integer');
    }
}

function checkMaxOutputLength(output: Buffer, options?: { maxOutputLength?: number }): Buffer {
    const max = options?.maxOutputLength;
    if (max !== undefined && output.byteLength > max) {
        throw new RangeError(`Cannot create a Buffer larger than ${max} bytes`);
    }
    return output;
}

// Sync compress/decompress

export function deflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return checkMaxOutputLength(Buffer.from(zlib.deflate(toUint8Array(buffer), level)), options);
}

export function deflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return checkMaxOutputLength(Buffer.from(zlib.deflateRaw(toUint8Array(buffer), level)), options);
}

export function gzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return checkMaxOutputLength(Buffer.from(zlib.gzip(toUint8Array(buffer), level)), options);
}

export function inflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    return checkMaxOutputLength(Buffer.from(zlib.inflate(toUint8Array(buffer))), options);
}

export function inflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    return checkMaxOutputLength(Buffer.from(zlib.inflateRaw(toUint8Array(buffer))), options);
}

export function gunzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    return checkMaxOutputLength(Buffer.from(zlib.gunzip(toUint8Array(buffer))), options);
}

export function unzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    const buf = toUint8Array(buffer);
    // Auto-detect format by magic number
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        return checkMaxOutputLength(Buffer.from(zlib.gunzip(buf)), options);
    }
    if (buf[0] === 0x78 && (buf[1] === 0x01 || buf[1] === 0x5e || buf[1] === 0x9c || buf[1] === 0xda)) {
        return checkMaxOutputLength(Buffer.from(zlib.inflate(buf)), options);
    }
    // Try gunzip first, then inflate
    try {
        return checkMaxOutputLength(Buffer.from(zlib.gunzip(buf)), options);
    } catch {
        // Fall through to raw zlib inflate for ambiguous payloads.
    }
    return checkMaxOutputLength(Buffer.from(zlib.inflate(buf)), options);
}

// Async compress/decompress (callback style)

type SyncFn = (buf: ZlibInput, opts?: ZlibOptions) => Buffer;

function wrapCallback(syncFn: SyncFn) {
    return function(buffer: ZlibInput, optionsOrCallback?: ZlibOptions | CompressCallback, callback?: CompressCallback) {
        const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
        const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        if (typeof cb !== 'function') {
            throw new TypeError('The "callback" argument must be of type function');
        }
        validateZlibInput(buffer);
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

function _doTransform(handle: ZlibHandle, chunk: ZlibInput, compress: boolean, cb: TransformCallback) {
    try {
        const fn = compress ? 'deflate' : 'inflate';
        const output = Buffer.from(handle[fn](toUint8Array(chunk)));
        cb(null, output.length > 0 ? output : undefined);
    } catch (err) { cb(err); }
}

function installHandleCompat(handle: ZlibHandle): ZlibHandle {
    handle.close ??= () => {};
    return handle;
}

function processChunk(handle: ZlibHandle, chunk: ZlibInput, compress: boolean, flush?: number): Buffer {
    const fn = compress ? 'deflate' : 'inflate';
    try {
        return Buffer.from(handle[fn](toUint8Array(chunk), flush));
    } catch (err) {
        if (/already finished/i.test(asError(err).message)) {
            return Buffer.alloc(0);
        }
        throw err;
    }
}

function _doFlush(handle: ZlibHandle, cb: TransformCallback) {
    try {
        const output = Buffer.from(handle.finish());
        cb(null, output.length > 0 ? output : undefined);
    } catch (err) {
        if (/already finished/i.test(asError(err).message)) {
            cb();
            return;
        }
        cb(err);
    }
}

export interface Deflate extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(): void;
}

export interface DeflateConstructor {
    new (o?: ZlibOptions & TransformOptions): Deflate;
    (o?: ZlibOptions & TransformOptions): Deflate;
    prototype: Deflate;
}

function initDeflate(self: Deflate, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createDeflate(..._opts(o)));
}

export const Deflate: DeflateConstructor = function Deflate(this: Deflate | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Deflate.prototype);
    initDeflate(target, o);
    return target;
} as DeflateConstructor;

Object.setPrototypeOf(Deflate, Transform);
Deflate.prototype = Object.create(Transform.prototype);

Deflate.prototype._transform = function _transform(this: Deflate, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this._handle, chunk, true, cb);
};

Deflate.prototype._flush = function _flush(this: Deflate, cb: TransformCallback): void {
    _doFlush(this._handle, cb);
};

Deflate.prototype._processChunk = function _processChunk(this: Deflate, chunk: ZlibInput, flush?: number): Buffer {
    return processChunk(this._handle, chunk, true, flush);
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

const _opts = (o?: ZlibOptions) => [
    o?.level ?? zlib.DEFAULT_COMPRESSION,
    o?.strategy ?? zlib.DEFAULT_STRATEGY,
    o?.memLevel ?? 8
] as const;

export interface Inflate extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(): void;
}

export interface InflateConstructor {
    new (o?: ZlibOptions & TransformOptions): Inflate;
    (o?: ZlibOptions & TransformOptions): Inflate;
    prototype: Inflate;
}

function initInflate(self: Inflate, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createInflate());
}

export const Inflate: InflateConstructor = function Inflate(this: Inflate | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Inflate.prototype);
    initInflate(target, o);
    return target;
} as InflateConstructor;

Object.setPrototypeOf(Inflate, Transform);
Inflate.prototype = Object.create(Transform.prototype);

Inflate.prototype._transform = function _transform(this: Inflate, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this._handle, chunk, false, cb);
};

Inflate.prototype._flush = function _flush(this: Inflate, cb: TransformCallback): void {
    _doFlush(this._handle, cb);
};

Inflate.prototype._processChunk = function _processChunk(this: Inflate, chunk: ZlibInput, flush?: number): Buffer {
    return processChunk(this._handle, chunk, false, flush);
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

export interface Gzip extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(): void;
}

export interface GzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Gzip;
    (o?: ZlibOptions & TransformOptions): Gzip;
    prototype: Gzip;
}

function initGzip(self: Gzip, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createGzip(..._opts(o)));
}

export const Gzip: GzipConstructor = function Gzip(this: Gzip | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Gzip.prototype);
    initGzip(target, o);
    return target;
} as GzipConstructor;

Object.setPrototypeOf(Gzip, Transform);
Gzip.prototype = Object.create(Transform.prototype);

Gzip.prototype._transform = function _transform(this: Gzip, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this._handle, chunk, true, cb);
};

Gzip.prototype._flush = function _flush(this: Gzip, cb: TransformCallback): void {
    _doFlush(this._handle, cb);
};

Gzip.prototype._processChunk = function _processChunk(this: Gzip, chunk: ZlibInput, flush?: number): Buffer {
    return processChunk(this._handle, chunk, true, flush);
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

export interface Gunzip extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(): void;
}

export interface GunzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Gunzip;
    (o?: ZlibOptions & TransformOptions): Gunzip;
    prototype: Gunzip;
}

function initGunzip(self: Gunzip, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createGunzip());
}

export const Gunzip: GunzipConstructor = function Gunzip(this: Gunzip | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Gunzip.prototype);
    initGunzip(target, o);
    return target;
} as GunzipConstructor;

Object.setPrototypeOf(Gunzip, Transform);
Gunzip.prototype = Object.create(Transform.prototype);

Gunzip.prototype._transform = function _transform(this: Gunzip, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this._handle, chunk, false, cb);
};

Gunzip.prototype._flush = function _flush(this: Gunzip, cb: TransformCallback): void {
    _doFlush(this._handle, cb);
};

Gunzip.prototype._processChunk = function _processChunk(this: Gunzip, chunk: ZlibInput, flush?: number): Buffer {
    return processChunk(this._handle, chunk, false, flush);
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

export interface DeflateRaw extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(): void;
}

export interface DeflateRawConstructor {
    new (o?: ZlibOptions & TransformOptions): DeflateRaw;
    (o?: ZlibOptions & TransformOptions): DeflateRaw;
    prototype: DeflateRaw;
}

function initDeflateRaw(self: DeflateRaw, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createDeflateRaw(..._opts(o)));
}

export const DeflateRaw: DeflateRawConstructor = function DeflateRaw(this: DeflateRaw | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, DeflateRaw.prototype);
    initDeflateRaw(target, o);
    return target;
} as DeflateRawConstructor;

Object.setPrototypeOf(DeflateRaw, Transform);
DeflateRaw.prototype = Object.create(Transform.prototype);

DeflateRaw.prototype._transform = function _transform(this: DeflateRaw, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this._handle, chunk, true, cb);
};

DeflateRaw.prototype._flush = function _flush(this: DeflateRaw, cb: TransformCallback): void {
    _doFlush(this._handle, cb);
};

DeflateRaw.prototype._processChunk = function _processChunk(this: DeflateRaw, chunk: ZlibInput, flush?: number): Buffer {
    return processChunk(this._handle, chunk, true, flush);
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

export interface InflateRaw extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(): void;
}

export interface InflateRawConstructor {
    new (o?: ZlibOptions & TransformOptions): InflateRaw;
    (o?: ZlibOptions & TransformOptions): InflateRaw;
    prototype: InflateRaw;
}

function initInflateRaw(self: InflateRaw, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createInflateRaw());
}

export const InflateRaw: InflateRawConstructor = function InflateRaw(this: InflateRaw | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, InflateRaw.prototype);
    initInflateRaw(target, o);
    return target;
} as InflateRawConstructor;

Object.setPrototypeOf(InflateRaw, Transform);
InflateRaw.prototype = Object.create(Transform.prototype);

InflateRaw.prototype._transform = function _transform(this: InflateRaw, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this._handle, chunk, false, cb);
};

InflateRaw.prototype._flush = function _flush(this: InflateRaw, cb: TransformCallback): void {
    _doFlush(this._handle, cb);
};

InflateRaw.prototype._processChunk = function _processChunk(this: InflateRaw, chunk: ZlibInput, flush?: number): Buffer {
    return processChunk(this._handle, chunk, false, flush);
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

export interface Unzip extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(): void;
}

export interface UnzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Unzip;
    (o?: ZlibOptions & TransformOptions): Unzip;
    prototype: Unzip;
}

function initUnzip(self: Unzip, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createGunzip());
}

export const Unzip: UnzipConstructor = function Unzip(this: Unzip | undefined, o?: ZlibOptions & TransformOptions) {
    const target = receiverOrCreate(this, Unzip.prototype);
    initUnzip(target, o);
    return target;
} as UnzipConstructor;

Object.setPrototypeOf(Unzip, Transform);
Unzip.prototype = Object.create(Transform.prototype);

Unzip.prototype._transform = function _transform(this: Unzip, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    _doTransform(this._handle, chunk, false, cb);
};

Unzip.prototype._flush = function _flush(this: Unzip, cb: TransformCallback): void {
    _doFlush(this._handle, cb);
};

Unzip.prototype._processChunk = function _processChunk(this: Unzip, chunk: ZlibInput, flush?: number): Buffer {
    return processChunk(this._handle, chunk, false, flush);
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

// Factory functions

function _create<T extends Transform, O>(Cls: ZlibStreamCtor<T, O>) {
    return (options?: O) => new Cls(options);
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

// Brotli — use native if available, otherwise error

function brotliCompressImpl(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    validateOptions(options);
    if (typeof nativeBrotli.brotliCompress === 'function') {
        return checkMaxOutputLength(Buffer.from(nativeBrotli.brotliCompress(toUint8Array(buffer))), options);
    }
    throw new Error('Brotli compression is not supported in this environment');
}

function brotliDecompressImpl(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    validateOptions(options);
    if (typeof nativeBrotli.brotliDecompress === 'function') {
        return checkMaxOutputLength(Buffer.from(nativeBrotli.brotliDecompress(toUint8Array(buffer))), options);
    }
    throw new Error('Brotli decompression is not supported in this environment');
}

export function brotliCompressSync(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    return brotliCompressImpl(buffer, options);
}

export function brotliDecompressSync(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    return brotliDecompressImpl(buffer, options);
}

export const brotliCompress = wrapCallback(brotliCompressSync as SyncFn);
export const brotliDecompress = wrapCallback(brotliDecompressSync as SyncFn);

export interface BrotliCompress extends Transform {}

export interface BrotliCompressConstructor {
    new (options?: BrotliOptions & TransformOptions): BrotliCompress;
    (options?: BrotliOptions & TransformOptions): BrotliCompress;
    prototype: BrotliCompress;
}

export const BrotliCompress: BrotliCompressConstructor = function BrotliCompress(this: BrotliCompress | undefined, options?: BrotliOptions & TransformOptions) {
    const target = receiverOrCreate(this, BrotliCompress.prototype);
    validateOptions(options);
    Transform.call(target, options);
    return target;
} as BrotliCompressConstructor;

Object.setPrototypeOf(BrotliCompress, Transform);
BrotliCompress.prototype = Object.create(Transform.prototype);

BrotliCompress.prototype._transform = function _transform(this: BrotliCompress, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    finishTransform(cb, () => brotliCompressImpl(chunk));
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

export const BrotliDecompress: BrotliDecompressConstructor = function BrotliDecompress(this: BrotliDecompress | undefined, options?: BrotliOptions & TransformOptions) {
    const target = receiverOrCreate(this, BrotliDecompress.prototype);
    validateOptions(options);
    Transform.call(target, options);
    return target;
} as BrotliDecompressConstructor;

Object.setPrototypeOf(BrotliDecompress, Transform);
BrotliDecompress.prototype = Object.create(Transform.prototype);

BrotliDecompress.prototype._transform = function _transform(this: BrotliDecompress, chunk: ZlibInput, _e: BufferEncoding, cb: TransformCallback): void {
    finishTransform(cb, () => brotliDecompressImpl(chunk));
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
