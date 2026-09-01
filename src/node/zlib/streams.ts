/**
 * Node.js zlib module — Transform stream classes and their shared machinery.
 *
 * Owns the single `zlibStreamStates` WeakMap: `configureZlibStream`,
 * `streamState`, `checkStreamOutput`, `inflateChunk`, `_doTransform`,
 * `_doFlush` and the `bytesWritten` getter all read the same table, so it must
 * not be duplicated. `sync.ts` reaches it through the export below to stamp
 * `bytesWritten` on an `{ info: true }` engine.
 *
 * The handle types and the prototype helpers (`flattenPrototype`,
 * `receiverOrCreate`, `toTransformOptions`, `_create`) are also used by
 * `brotli.ts`.
 */

import { Transform, TransformOptions } from '../stream';
import { flattenPrototype } from '../_internal/prototype';
export { flattenPrototype };
import {
    asError,
    corruptError,
    DEFAULT_COMPRESSION,
    DEFAULT_STRATEGY,
    FINISH,
    hasErrorCode,
    hasGzipMagic,
    isAlreadyFinished,
    NO_FLUSH,
    SYNC_FLUSH,
    toUint8Array,
    trailingIsPadding,
    truncatedError,
    validateFlushFlag,
    validateOptions,
    type ZlibInput,
    type ZlibOptions,
} from './constants';

const zlib = import.meta.use('zlib');

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

export type { ZlibHandleBase, ZlibDeflateHandle, ZlibInflateHandle, ZlibHandle };

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

export type { TransformCallback, ZlibStreamCtor };

// Native decompression codec names, as tracked on the stream state.
type DecompressKind = 'inflate' | 'inflateRaw' | 'gunzip' | 'unzip';

export type { DecompressKind };
export function receiverOrCreate<T extends object>(receiver: T | undefined, prototype: object): T {
    const target: T = receiver && (typeof receiver === 'object' || typeof receiver === 'function')
        ? receiver
        : Object.create(prototype);
    return target;
}

export function toTransformOptions(o?: ZlibOptions & TransformOptions): TransformOptions | undefined {
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

export const zlibStreamStates = new WeakMap<object, ZlibStreamState>();

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
            if (pending.every((byte) => byte === 0)) { cb(null); return; }
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

export type { NodeZlibTransform };

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
export function _create<T extends Transform, O>(Cls: ZlibStreamCtor<T, O>) {
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

export type {
    DeflateConstructor,
    InflateConstructor,
    GzipConstructor,
    GunzipConstructor,
    DeflateRawConstructor,
    InflateRawConstructor,
    UnzipConstructor,
};
