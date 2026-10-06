/**
 * Node.js zlib module — Transform stream classes and their shared machinery.
 *
 * Owns the stream state shared by all codecs and by `sync.ts`, which stamps
 * `bytesWritten` on the engine returned for `{ info: true }`.
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
function inflateChunk(state: ZlibStreamState, handle: ZlibInflateHandle, chunk: Uint8Array): Buffer {
    // A NUL after a finished member closed the stream; everything after is discarded.
    if (state.trailingDone) return Buffer.alloc(0);
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
    return Buffer.concat(outputs);
}

function _transform(this: NodeZlibTransform, chunk: ZlibInput, _encoding: BufferEncoding, cb: TransformCallback): void {
    try {
        const state = streamState(this);
        const handle = this._handle;
        const input = toUint8Array(chunk);
        // Node counts input bytes before processing, so a chunk that errors is
        // still reflected in `bytesWritten`.
        state.bytesWritten += input.byteLength;
        const output = isDeflateHandle(handle)
            ? Buffer.from(handle.deflate(input, state.flush))
            : inflateChunk(state, handle, input);
        cb(null, output.length > 0 ? output : undefined);
    } catch (err) { cb(asError(err)); }
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
function _flush(this: NodeZlibTransform, cb: TransformCallback): void {
    try {
        const state = streamState(this);
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
        const handle = this._handle;
        const raw = state.finishFlush === FINISH
            ? handle.finish()
            : isDeflateHandle(handle)
                ? handle.deflate(new Uint8Array(), state.finishFlush)
                : handle.inflate(new Uint8Array(), state.finishFlush);
        const output = Buffer.from(raw);
        cb(null, output.length > 0 ? output : undefined);
    } catch (err) {
        const state = zlibStreamStates.get(this);
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
        const output = processChunk(this._handle, Buffer.alloc(0), kind);
        if (output.length > 0) this.push(output);
        if (cb) queueMicrotask(cb);
    } catch (error) {
        this.destroy(asError(error));
    }
    return this;
}

function resetStream(this: NodeZlibTransform): void {
    this._handle.reset?.();
    streamState(this);
}

function paramsStream(this: NodeZlibTransform, level: number, strategy: number, callback?: () => void): NodeZlibTransform {
    validateOptions({ level, strategy });
    const handle = this._handle;
    if (!isDeflateHandle(handle) || !handle.params) throw new Error('params() is only supported for compression streams');
    // Drain pending output before changing params, as Node does. The native
    // deflateParams() would otherwise flush into the previous call's output buffer.
    streamState(this);
    const drained = processChunk(handle, Buffer.alloc(0), SYNC_FLUSH);
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

function _processChunk(this: NodeZlibTransform, chunk: ZlibInput, flush?: number): Buffer {
    const output = processChunk(this._handle, chunk, flush);
    streamState(this);
    return output;
}

interface ZlibConstructor<T extends NodeZlibTransform> {
    new (options?: ZlibOptions & TransformOptions): T;
    (options?: ZlibOptions & TransformOptions): T;
    prototype: T;
}

function defineZlibConstructor<T extends NodeZlibTransform>(
    name: string,
    createHandle: (options?: ZlibOptions) => T['_handle'],
    kind?: DecompressKind,
): ZlibConstructor<T> {
    const Constructor = function(this: T | undefined, options?: ZlibOptions & TransformOptions): T {
        const target = receiverOrCreate(this, Constructor.prototype);
        validateOptions(options);
        Transform.call(target, toTransformOptions(options));
        target._handle = createHandle(options);
        // Native handles use finalizers; Node consumers still expect _handle.close().
        target._handle.close ??= () => {};
        configureZlibStream(target, isDeflateHandle(target._handle), options, kind);
        return target;
    } as ZlibConstructor<T>;
    Object.defineProperty(Constructor, 'name', { value: name, configurable: true });
    Object.setPrototypeOf(Constructor, Transform);
    Constructor.prototype = Object.create(Transform.prototype);
    const prototype: NodeZlibTransform = Constructor.prototype;
    Object.assign(prototype, { _transform, _flush, _processChunk });
    Object.defineProperty(prototype, 'constructor', {
        value: Constructor,
        writable: true,
        configurable: true,
    });
    flattenPrototype(prototype);
    prototype.flush = flushStream;
    prototype.reset = resetStream;
    prototype.params = paramsStream;
    prototype.close = closeStream;
    // reset() preserves bytesWritten; maxOutputLength applies only to one-shots.
    Object.defineProperty(prototype, 'bytesWritten', {
        get(this: NodeZlibTransform): number {
            return zlibStreamStates.get(this)?.bytesWritten ?? 0;
        },
        configurable: true,
        enumerable: false,
    });
    return Constructor;
}

export interface Deflate extends NodeZlibTransform { _handle: ZlibDeflateHandle; }
export interface Inflate extends NodeZlibTransform { _handle: ZlibInflateHandle; }
export interface Gzip extends NodeZlibTransform { _handle: ZlibDeflateHandle; }
export interface Gunzip extends NodeZlibTransform { _handle: ZlibInflateHandle; }
export interface DeflateRaw extends NodeZlibTransform { _handle: ZlibDeflateHandle; }
export interface InflateRaw extends NodeZlibTransform { _handle: ZlibInflateHandle; }
export interface Unzip extends NodeZlibTransform { _handle: ZlibInflateHandle; }

type DeflateConstructor = ZlibConstructor<Deflate>;
type InflateConstructor = ZlibConstructor<Inflate>;
type GzipConstructor = ZlibConstructor<Gzip>;
type GunzipConstructor = ZlibConstructor<Gunzip>;
type DeflateRawConstructor = ZlibConstructor<DeflateRaw>;
type InflateRawConstructor = ZlibConstructor<InflateRaw>;
type UnzipConstructor = ZlibConstructor<Unzip>;

const compressionOptions = (options?: ZlibOptions) => [
    options?.level ?? zlib.DEFAULT_COMPRESSION,
    options?.strategy ?? zlib.DEFAULT_STRATEGY,
    options?.memLevel ?? 8,
] as const;

export const Deflate = defineZlibConstructor<Deflate>('Deflate', options => zlib.createDeflate(...compressionOptions(options)));
export const Inflate = defineZlibConstructor<Inflate>('Inflate', () => zlib.createInflate());
export const Gzip = defineZlibConstructor<Gzip>('Gzip', options => zlib.createGzip(...compressionOptions(options)));
export const Gunzip = defineZlibConstructor<Gunzip>('Gunzip', () => zlib.createGunzip(), 'gunzip');
export const DeflateRaw = defineZlibConstructor<DeflateRaw>('DeflateRaw', options => zlib.createDeflateRaw(...compressionOptions(options)));
export const InflateRaw = defineZlibConstructor<InflateRaw>('InflateRaw', () => zlib.createInflateRaw());
export const Unzip = defineZlibConstructor<Unzip>('Unzip', () => zlib.createUnzip(), 'unzip');

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
