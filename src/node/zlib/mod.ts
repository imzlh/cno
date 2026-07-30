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
    flush(): Uint8Array;
    finish(): Uint8Array;
    close?: () => void;
    reset?: () => void;
    params?: (level: number, strategy: number) => void;
    getTotalIn?: () => number;
    getTotalOut?: () => number;
};
type TransformCallback = (err: unknown, result?: Buffer) => void;
type ZlibStreamCtor<T extends Transform, O> = new (options?: O & TransformOptions) => T;
type BrotliNative = {
    available?: boolean;
    compress?: (input: Uint8Array, options?: CModuleBrotli.CompressOptions) => Uint8Array;
    decompress?: (input: Uint8Array, options?: CModuleBrotli.DecompressOptions) => Uint8Array;
    createCompress?: (options?: CModuleBrotli.CompressOptions) => CModuleBrotli.BrotliCompress;
    createDecompress?: (options?: CModuleBrotli.DecompressOptions) => CModuleBrotli.BrotliDecompress;
};
// brotli is an optional native module (built with libbrotli); tolerate absence
let nativeBrotli: BrotliNative = {};
try { nativeBrotli = import.meta.use('brotli'); } catch { /* unavailable */ }

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

const VALID_FLUSH_FLAGS = new Set([NO_FLUSH, PARTIAL_FLUSH, SYNC_FLUSH, FULL_FLUSH, FINISH, BLOCK]);

function validateFlushFlag(value: unknown, name: string): void {
    if (typeof value !== 'number') throw new TypeError(`The "${name}" property must be of type number`);
    if (!Number.isInteger(value) || !VALID_FLUSH_FLAGS.has(value)) {
        throw new RangeError(`The value of "${name}" is out of range`);
    }
}

function validateOptions(options?: ZlibOptions | BrotliOptions): void {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
        throw new TypeError('The "options" argument must be of type object');
    }
    if (options?.flush !== undefined && !Number.isInteger(options.flush)) {
        validateFlushFlag(options.flush, 'options.flush');
    } else if (options?.flush !== undefined) {
        validateFlushFlag(options.flush, 'options.flush');
    }
    if (options?.finishFlush !== undefined && !Number.isInteger(options.finishFlush)) {
        validateFlushFlag(options.finishFlush, 'options.finishFlush');
    } else if (options?.finishFlush !== undefined) {
        validateFlushFlag(options.finishFlush, 'options.finishFlush');
    }
    if (options?.maxOutputLength !== undefined && (!Number.isInteger(options.maxOutputLength) || options.maxOutputLength < 0)) {
        throw new RangeError('The "options.maxOutputLength" property must be a non-negative integer');
    }

    const zlibOptions = options as ZlibOptions | undefined;
    if (zlibOptions?.level !== undefined &&
        (!Number.isInteger(zlibOptions.level) || zlibOptions.level < -1 || zlibOptions.level > 9)) {
        throw new RangeError('The value of "options.level" is out of range. It must be >= -1 and <= 9');
    }
    if (zlibOptions?.memLevel !== undefined &&
        (!Number.isInteger(zlibOptions.memLevel) || zlibOptions.memLevel < 1 || zlibOptions.memLevel > 9)) {
        throw new RangeError('The value of "options.memLevel" is out of range. It must be >= 1 and <= 9');
    }
    if (zlibOptions?.strategy !== undefined &&
        (!Number.isInteger(zlibOptions.strategy) || ![DEFAULT_STRATEGY, FILTERED, HUFFMAN_ONLY, RLE, FIXED].includes(zlibOptions.strategy))) {
        throw new RangeError('The value of "options.strategy" is out of range');
    }
    if (zlibOptions?.chunkSize !== undefined &&
        (!Number.isInteger(zlibOptions.chunkSize) || zlibOptions.chunkSize <= 0)) {
        throw new RangeError('The value of "options.chunkSize" is out of range');
    }
    if (zlibOptions?.windowBits !== undefined && zlibOptions.windowBits !== 0 && zlibOptions.windowBits !== 15) {
        throw new RangeError('Only windowBits values 0 and 15 are supported');
    }
    if (zlibOptions?.dictionary !== undefined) {
        if (!(zlibOptions.dictionary instanceof ArrayBuffer) && !ArrayBuffer.isView(zlibOptions.dictionary)) {
            throw new TypeError('The "options.dictionary" property must be an ArrayBuffer or ArrayBufferView');
        }
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
    if (max !== undefined && output.byteLength > max) {
        throw new RangeError(`Cannot create a Buffer larger than ${max} bytes`);
    }
    return output;
}

// Sync compress/decompress

export function deflateSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return checkMaxOutputLength(Buffer.from(zlib.deflate(toUint8Array(buffer), level, options?.strategy, options?.memLevel)), options);
}

export function deflateRawSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return checkMaxOutputLength(Buffer.from(zlib.deflateRaw(toUint8Array(buffer), level, options?.strategy, options?.memLevel)), options);
}

export function gzipSync(buffer: ZlibInput, options?: ZlibOptions): Buffer {
    validateOptions(options);
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return checkMaxOutputLength(Buffer.from(zlib.gzip(toUint8Array(buffer), level, options?.strategy, options?.memLevel)), options);
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
    return checkMaxOutputLength(Buffer.from(zlib.unzip(toUint8Array(buffer))), options);
}

// Async compress/decompress (callback style)

type SyncFn = (buf: ZlibInput, opts?: ZlibOptions | BrotliOptions) => Buffer;

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
};

const zlibStreamStates = new WeakMap<object, ZlibStreamState>();

function configureZlibStream(stream: object, compress: boolean, options?: ZlibOptions): void {
    zlibStreamStates.set(stream, {
        compress,
        flush: options?.flush ?? NO_FLUSH,
        finishFlush: options?.finishFlush ?? FINISH,
        maxOutputLength: options?.maxOutputLength,
        outputLength: 0,
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

function _doTransform(stream: NodeZlibTransform, chunk: ZlibInput, cb: TransformCallback) {
    try {
        const state = streamState(stream);
        const fn = state.compress ? 'deflate' : 'inflate';
        const output = checkStreamOutput(stream, Buffer.from(stream._handle[fn](toUint8Array(chunk), state.flush)));
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

function _doFlush(stream: NodeZlibTransform, cb: TransformCallback) {
    try {
        const state = streamState(stream);
        const raw = state.finishFlush === FINISH
            ? stream._handle.finish()
            : stream._handle[state.compress ? 'deflate' : 'inflate'](new Uint8Array(), state.finishFlush);
        const output = checkStreamOutput(stream, Buffer.from(raw));
        cb(null, output.length > 0 ? output : undefined);
    } catch (err) {
        if (/already finished/i.test(asError(err).message)) {
            cb(null);
            return;
        }
        cb(err);
    }
}

interface NodeZlibTransform extends Transform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    flush(kind?: number | (() => void), callback?: () => void): this;
    reset(): void;
    params(level: number, strategy: number, callback?: () => void): this;
    close(callback?: () => void): void;
}

function flushStream(this: NodeZlibTransform, kindOrCallback?: number | (() => void), callback?: () => void): NodeZlibTransform {
    const kind = typeof kindOrCallback === 'number' ? kindOrCallback : SYNC_FLUSH;
    const cb = typeof kindOrCallback === 'function' ? kindOrCallback : callback;
    validateFlushFlag(kind, 'kind');
    try {
        const state = streamState(this);
        const output = checkStreamOutput(this, processChunk(this._handle, Buffer.alloc(0), state.compress, kind));
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
    if (!this._handle.params) throw new Error('params() is only supported for compression streams');
    this._handle.params(level, strategy);
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
}

export interface Deflate extends NodeZlibTransform {
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
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
    return checkStreamOutput(this, processChunk(this._handle, chunk, true, flush));
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
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
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
    return checkStreamOutput(this, processChunk(this._handle, chunk, false, flush));
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
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
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
    return checkStreamOutput(this, processChunk(this._handle, chunk, true, flush));
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
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
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
    configureZlibStream(self, false, o);
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
    return checkStreamOutput(this, processChunk(this._handle, chunk, false, flush));
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
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
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
    return checkStreamOutput(this, processChunk(this._handle, chunk, true, flush));
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
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
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
    return checkStreamOutput(this, processChunk(this._handle, chunk, false, flush));
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
    _handle: ZlibHandle;
    _processChunk(chunk: ZlibInput, flush?: number): Buffer;
    close(callback?: () => void): void;
}

export interface UnzipConstructor {
    new (o?: ZlibOptions & TransformOptions): Unzip;
    (o?: ZlibOptions & TransformOptions): Unzip;
    prototype: Unzip;
}

function initUnzip(self: Unzip, o?: ZlibOptions & TransformOptions): void {
    validateOptions(o);
    Transform.call(self, toTransformOptions(o));
    self._handle = installHandleCompat(zlib.createUnzip());
    configureZlibStream(self, false, o);
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
    return checkStreamOutput(this, processChunk(this._handle, chunk, false, flush));
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
        maxOutputLength: options?.maxOutputLength,
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

export interface BrotliCompressConstructor {
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

export interface BrotliDecompressConstructor {
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
};
