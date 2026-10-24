// `brotli` is an optional native module, so the lookup tolerates null and a
// throwing `use()`. `nativeBrotli` must stay a single lazily-resolved binding.

import { Transform, TransformOptions } from '../stream';
import {
    asError,
    BROTLI_OPERATION_FINISH,
    BROTLI_OPERATION_FLUSH,
    BROTLI_OPERATION_PROCESS,
    BROTLI_PARAM_LARGE_WINDOW,
    BROTLI_PARAM_LGBLOCK,
    BROTLI_PARAM_LGWIN,
    BROTLI_PARAM_MODE,
    BROTLI_PARAM_QUALITY,
    BROTLI_PARAM_SIZE_HINT,
    checkMaxOutputLength,
    isAlreadyFinished,
    toUint8Array,
    validateBrotliOptions,
    type BrotliOptions,
    type ZlibInput,
} from './constants';
import {
    _create,
    flattenPrototype,
    receiverOrCreate,
    toTransformOptions,
    type TransformCallback,
} from './streams';
import { wrapCallback, type SyncFn } from './sync';

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

function finishTransform(cb: TransformCallback, operation: () => Buffer): void {
    try {
        cb(null, operation());
    } catch (err) {
        cb(asError(err));
    }
}

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

// The literal 1 is BROTLI_DECODER_PARAM_LARGE_WINDOW: decoder parameters are a
// separate enum from the encoder's BROTLI_PARAM_*, so it is not BROTLI_PARAM_QUALITY.
function brotliDecompressOptions(options?: BrotliOptions): CModuleBrotli.DecompressOptions {
    const largeWindow = brotliParam(options, 1);
    return largeWindow === undefined ? {} : { largeWindow: Boolean(largeWindow) };
}

function requireBrotli<T>(value: T | undefined): T {
    if (typeof value !== 'function') throw new Error('Brotli compression is not supported in this environment');
    return value;
}
export function brotliCompressSync(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    validateBrotliOptions(options);
    const compress = requireBrotli(nativeBrotli.compress);
    return checkMaxOutputLength(Buffer.from(compress(toUint8Array(buffer), brotliCompressOptions(options))), options);
}

export function brotliDecompressSync(buffer: ZlibInput, options?: BrotliOptions): Buffer {
    validateBrotliOptions(options);
    const decompress = requireBrotli(nativeBrotli.decompress);
    return checkMaxOutputLength(Buffer.from(decompress(toUint8Array(buffer), brotliDecompressOptions(options))), options);
}

export const brotliCompress = wrapCallback(brotliCompressSync as SyncFn, options => validateBrotliOptions(options as BrotliOptions));
export const brotliDecompress = wrapCallback(brotliDecompressSync as SyncFn, options => validateBrotliOptions(options as BrotliOptions));

type BrotliStreamState = {
    flush: number;
    finishFlush: number;
};

const brotliStreamStates = new WeakMap<object, BrotliStreamState>();

function configureBrotliStream(stream: object, options?: BrotliOptions): void {
    brotliStreamStates.set(stream, {
        flush: options?.flush ?? BROTLI_OPERATION_PROCESS,
        finishFlush: options?.finishFlush ?? BROTLI_OPERATION_FINISH,
    });
}

function brotliStreamState(stream: object): BrotliStreamState {
    const state = brotliStreamStates.get(stream);
    if (!state) throw new Error('Brotli stream is not initialized');
    return state;
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
        return brotliCompressOperation(this._handle, state.flush, toUint8Array(chunk));
    });
};

BrotliCompress.prototype._flush = function _flush(this: BrotliCompress, cb: TransformCallback): void {
    finishTransform(cb, () => {
        const state = brotliStreamStates.get(this)!;
        try {
            return brotliCompressOperation(this._handle, state.finishFlush);
        } catch (error) {
            // Native handle throws carry no code and reach here as a generic
            // "not a function" TypeError; see `isAlreadyFinished`.
            if (isAlreadyFinished(error)) return Buffer.alloc(0);
            throw error;
        }
    });
};

BrotliCompress.prototype.flush = function flush(this: BrotliCompress, callback?: () => void): BrotliCompress {
    try {
        const output = Buffer.from(this._handle.flush());
        brotliStreamState(this);
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
    finishTransform(cb, () => {
        const output = Buffer.from(this._handle.decompress(toUint8Array(chunk)));
        brotliStreamState(this);
        return output;
    });
};

BrotliDecompress.prototype._flush = function _flush(this: BrotliDecompress, cb: TransformCallback): void {
    finishTransform(cb, () => {
        const output = Buffer.from(this._handle.finish());
        brotliStreamState(this);
        return output;
    });
};

BrotliDecompress.prototype.flush = function flush(this: BrotliDecompress, callback?: () => void): BrotliDecompress {
    try {
        const output = Buffer.from(this._handle.decompress(Buffer.alloc(0)));
        brotliStreamState(this);
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

export type { BrotliCompressConstructor, BrotliDecompressConstructor };
