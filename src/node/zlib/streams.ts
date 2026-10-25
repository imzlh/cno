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
    concatBytes,
    corruptError,
    DEFAULT_COMPRESSION,
    DEFAULT_STRATEGY,
    FINISH,
    hasGzipMagic,
    isAlreadyFinished,
    trailingIsPadding,
    NO_FLUSH,
    SYNC_FLUSH,
    toUint8Array,
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
    readonly finished?: boolean;
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
    // codec for decompressors; undefined for compressors
    kind?: DecompressKind;
    // flush mode requested on each feed
    flush: number;
    finishFlush: number;
    bytesWritten: number;
    // gzip members concatenate; track leftovers across chunk boundaries
    multiMember: boolean;
    autoDetect: boolean;
    // Input the native handle has not consumed yet.
    pending?: Uint8Array;
    headerFirst?: number;
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
        kind,
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

/** Keep one native handle across writes, resetting only between gzip members. */
function inflateChunk(state: ZlibStreamState, handle: ZlibInflateHandle, chunk: Uint8Array): Buffer {
    if (state.trailingDone) return Buffer.alloc(0);
    // Unzip's two-byte header may arrive in separate writes.
    if (state.autoDetect && chunk.length > 0) {
        if (state.headerFirst !== undefined) {
            state.multiMember = state.headerFirst === 0x1f && chunk[0] === 0x8b;
            state.autoDetect = false;
        } else if (chunk.length >= 2) {
            state.multiMember = hasGzipMagic(chunk);
            state.autoDetect = false;
        } else {
            state.headerFirst = chunk[0];
        }
    }
    const data = state.pending?.length ? concatBytes(state.pending, chunk) : chunk;
    state.pending = undefined;
    const outputs: Buffer[] = [];
    let offset = 0;
    while (offset < data.length) {
        const rest = data.subarray(offset);
        if (handle.finished === true) {
            if (!state.multiMember) break;
            if (trailingIsPadding(rest)) {
                state.trailingDone = true;
                break;
            }
            handle.reset?.();
        }
        const before = handle.getTotalIn?.() ?? 0;
        let output: Uint8Array;
        try {
            output = handle.inflate(rest, state.flush);
        } catch {
            state.error = corruptError();
            throw state.error;
        }
        if (output.length > 0) outputs.push(Buffer.from(output));
        const used = handle.getTotalIn ? handle.getTotalIn() - before : rest.length;
        offset += used;
        if (used === 0) {
            state.pending = rest;
            break;
        }
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
    // Once the member's trailer is consumed the native handle reports failure as
    // an uncatchable InternalError, so a flush after the end of the stream
    // produces nothing instead of ending the process.
    if (handle.finished === true) return Buffer.alloc(0);
    try {
        const input = toUint8Array(chunk);
        return Buffer.from(isDeflateHandle(handle)
            ? handle.deflate(input, flush)
            : handle.inflate(input, flush));
    } catch (err) {
        if (isAlreadyFinished(err)) {
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
        const handle = this._handle;
        if (!isDeflateHandle(handle)) {
            if (state.finishFlush === FINISH && handle.finished !== true) throw truncatedError();
            // A finished member has already emitted all output. Calling its
            // native finish() again raises an uncatchable terminal-state error.
            const output = handle.finished === true ? Buffer.alloc(0)
                : Buffer.from(handle.inflate(state.pending ?? new Uint8Array(), state.finishFlush));
            state.pending = undefined;
            cb(null, output.length > 0 ? output : undefined);
            return;
        }
        const raw = state.finishFlush === FINISH
            ? handle.finish()
            : handle.deflate(new Uint8Array(), state.finishFlush);
        const output = Buffer.from(raw);
        cb(null, output.length > 0 ? output : undefined);
    } catch (err) {
        const state = zlibStreamStates.get(this);
        if (state?.error) {
            cb(state.error);
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
    const state = streamState(this);
    state.pending = undefined;
    state.headerFirst = undefined;
    state.trailingDone = false;
    state.error = undefined;
    state.multiMember = state.kind === 'gunzip';
    state.autoDetect = state.kind === 'unzip';
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
export const Inflate = defineZlibConstructor<Inflate>('Inflate', () => zlib.createInflate(), 'inflate');
export const Gzip = defineZlibConstructor<Gzip>('Gzip', options => zlib.createGzip(...compressionOptions(options)));
export const Gunzip = defineZlibConstructor<Gunzip>('Gunzip', () => zlib.createGunzip(), 'gunzip');
export const DeflateRaw = defineZlibConstructor<DeflateRaw>('DeflateRaw', options => zlib.createDeflateRaw(...compressionOptions(options)));
export const InflateRaw = defineZlibConstructor<InflateRaw>('InflateRaw', () => zlib.createInflateRaw(), 'inflateRaw');
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
