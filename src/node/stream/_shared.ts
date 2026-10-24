/*
 * node:stream — helpers shared by more than one stream class. State here
 * (`baseStreamStates`, the default high-water marks) must exist exactly once
 * per process: a duplicate makes setDefaultHighWaterMark a silent no-op.
 */

import { EventEmitter } from '../events';
import { StringDecoder } from '../string_decoder';
const os = import.meta.use('os');
export { flattenPrototype } from '../_internal/prototype';
import type {
    BaseStreamState,
    DestroyHookHost,
    DestroyStateLike,
    Duplex,
    NextTickHost,
    PipeTrackedWritable,
    Readable,
    ReadableOptions,
    ReadableState,
    ReadableTarget,
    Stream,
    Writable,
    WritableState,
} from './types';

export function isAsyncIterable(value: Iterable<unknown> | AsyncIterable<unknown>): value is AsyncIterable<unknown> {
    return value !== null && value !== undefined
        && typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
}

export function isIterable(value: Iterable<unknown> | AsyncIterable<unknown>): value is Iterable<unknown> {
    return value !== null && value !== undefined
        && typeof Reflect.get(value, Symbol.iterator) === 'function';
}

export function normalizeChunk(chunk: unknown, objectMode: boolean, encoding: BufferEncoding | undefined, defaultEncoding: BufferEncoding): unknown {
    if (objectMode || chunk === null) return chunk;
    if (typeof chunk === 'string') return Buffer.from(chunk, encoding || defaultEncoding);
    if (ArrayBuffer.isView(chunk) && !(chunk instanceof Buffer)) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return chunk;
}

export function createWriteAfterEndError(): Error & { code: string } {
    return Object.assign(new Error('write after end'), {
        code: 'ERR_STREAM_WRITE_AFTER_END',
    });
}

export function createNullWriteError(): TypeError & { code: string } {
    return Object.assign(new TypeError('May not write null values to stream'), {
        code: 'ERR_STREAM_NULL_VALUES',
    });
}

export function createInvalidChunkError(chunk: unknown): TypeError & { code: string } {
    const constructor = chunk !== null && (typeof chunk === 'object' || typeof chunk === 'function')
        ? Reflect.get(chunk, 'constructor')
        : undefined;
    const received = chunk === undefined
        ? 'undefined'
        : `an instance of ${typeof constructor === 'function' ? constructor.name : typeof chunk}`;
    return Object.assign(new TypeError(
        'The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView. ' +
        `Received ${received}`,
    ), { code: 'ERR_INVALID_ARG_TYPE' });
}

export function createDestroyedError(): Error & { code: string } {
    return Object.assign(new Error('Cannot call write after a stream was destroyed'), {
        code: 'ERR_STREAM_DESTROYED',
    });
}

export function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/* Node runs destroy/error/close emissions on the next tick so that
 * `stream.destroy(err)` never throws at the call site before the caller has had
 * a chance to attach its 'error' listener. `process` is resolved lazily: this
 * module is loaded by ../process/streams, so a static import would form a cycle. */
export function deferTick(callback: () => void): void {
    const host = (globalThis as { process?: NextTickHost }).process;
    if (host && typeof host.nextTick === 'function') {
        host.nextTick(callback);
        return;
    }
    queueMicrotask(callback);
}

/* Shared tail of every destroy() override: invoke the user's `_destroy()` hook
 * (Node's documented teardown seam) and only once it calls back emit 'error'
 * then 'close', both deferred. */
export function runStreamDestroy(
    stream: Stream,
    error: Error | null | undefined,
    states: Array<DestroyStateLike | undefined>,
    afterEvents?: (error: Error | null) => void,
): void {
    const host = stream as DestroyHookHost;
    let settled = false;

    const finish = (hookError?: Error | null) => {
        if (settled) return;
        settled = true;
        const finalError = hookError ?? error ?? null;
        // Node flips `closed` the moment the _destroy callback fires (so it is
        // synchronous for streams with no hook), but still defers the events.
        for (const state of states) {
            if (state) state.closed = true;
        }
        deferTick(() => {
            if (finalError) {
                stream.errored = finalError;
                stream.emit('error', finalError);
            }
            const emitClose = states.some(state => state?.emitClose);
            if (emitClose) stream.emit('close');
            // node settles a pending end() callback after 'close', not before.
            if (afterEvents) afterEvents(finalError);
        });
    };

    if (typeof host._destroy === 'function') {
        try {
            host._destroy(error ?? null, finish);
        } catch (thrown) {
            finish(asError(thrown));
        }
        return;
    }
    finish(null);
}

// Node normalizes Windows to `win32`; circu.js exposes `windows` and the
// underlying uname spelling on the low-level os module.
const isWindowsHost = os.platform === 'windows' || os.platform === 'win32'
    || os.uname().sysname === 'Windows_NT';
let defaultByteHighWaterMark = isWindowsHost ? 16 * 1024 : 64 * 1024;
let defaultObjectHighWaterMark = 16;

export function defaultHighWaterMark(objectMode: boolean): number {
    if (objectMode) return defaultObjectHighWaterMark;
    return defaultByteHighWaterMark;
}

function validateHighWaterMark(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0x3fffffff) {
        throw new RangeError('The value of "value" is out of range. It must be a non-negative integer.');
    }
}

export function isConstructCallTarget(value: unknown, prototype: object): value is object {
    return !!value
        && (typeof value === 'object' || typeof value === 'function')
        && prototype.isPrototypeOf(value);
}

export function isReadableLike(value: unknown): value is Readable | Duplex {
    return !!value
        && typeof value === 'object'
        && '_readableState' in value
        && 'readable' in value;
}

export function isWritableLike(value: unknown): value is Writable | Duplex {
    return !!value
        && typeof value === 'object'
        && '_writableState' in value
        && 'writable' in value;
}

export function decoderBytes(chunk: unknown): Buffer | null {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk);
    return null;
}

export function createReadableState(options: ReadableOptions | undefined, objectMode: boolean, highWaterMark: number): ReadableState {
    return {
        buffer: [],
        encoding: options?.encoding ?? null,
        objectMode,
        highWaterMark,
        flowing: null,
        ended: false,
        endEmitted: false,
        reading: false,
        sync: true,
        needReadable: false,
        emittedReadable: false,
        readableListening: false,
        resumeScheduled: false,
        destroyed: false,
        defaultEncoding: 'utf8',
        awaitDrain: 0,
        readingMore: false,
        decoder: options?.encoding ? new StringDecoder(options.encoding) : null,
        disturbed: false,
        emitClose: options?.emitClose ?? true,
        autoDestroy: options?.autoDestroy ?? true,
        closed: false,
    };
}

export function setReadableEncoding<T extends Readable | Duplex>(stream: T, encoding: BufferEncoding): T {
    stream.readableEncoding = encoding;
    const state = stream._readableState;
    state.encoding = encoding;
    state.decoder = new StringDecoder(encoding);
    const decoded: unknown[] = [];
    for (const chunk of state.buffer) {
        const bytes = decoderBytes(chunk);
        if (bytes) {
            const out = state.decoder.write(bytes);
            if (out.length > 0) decoded.push(out);
        } else {
            decoded.push(chunk);
        }
    }
    if (state.ended) {
        const trailing = state.decoder.end();
        if (trailing.length > 0) decoded.push(trailing);
    }
    state.buffer = decoded;
    updateReadableLength(stream);
    return stream;
}

export function onReadableListenerAdded(stream: Readable | Duplex, event: string | symbol): void {
    if (event === 'data') stream.resume();
    if (event === 'readable') {
        const state = stream._readableState;
        state.readableListening = true;
        // A readable listener parks even an already flowing stream.
        state.flowing = false;
        if (state.buffer.length > 0 || state.ended) scheduleReadableEmit(stream);
        else invokeReadableRead(stream);
    }
}

export function resumeReadable<T extends Readable | Duplex>(stream: T, drain: () => void): T {
    const state = stream._readableState;
    if (state.readableListening && stream.listenerCount('data') === 0) {
        stream.emit('resume');
        invokeReadableRead(stream);
        return stream;
    }
    if (!state.flowing) {
        state.flowing = true;
        stream.emit('resume');
    }
    // pipe() registers its end listener after the data listener starts flowing.
    scheduleReadableFlow(stream, drain);
    return stream;
}

export function flowReadable(stream: Readable | Duplex): void {
    const state = stream._readableState;
    if (state.destroyed || !state.flowing) return;
    while (!state.destroyed && state.flowing && state.buffer.length > 0) {
        const chunk = state.buffer.shift();
        state.disturbed = true;
        stream.readableDidRead = true;
        subtractReadableLength(stream, readableChunkLength(state, chunk));
        stream.emit('data', chunk);
    }
    if (state.ended) stream._emitReadableEndIfNeeded();
    else invokeReadableRead(stream);
}

function bufferFromView(chunk: unknown): Buffer {
    if (!ArrayBuffer.isView(chunk)) return Buffer.alloc(0);
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export const baseStreamStates = new WeakMap<object, BaseStreamState>();

export function baseStreamState(self: Stream): BaseStreamState {
    let state = baseStreamStates.get(self);
    if (!state) {
        state = { destroyed: false, emitClose: true, closed: false };
        baseStreamStates.set(self, state);
    }
    return state;
}

export function initStream(self: Stream): void {
    EventEmitter.call(self);
    if (typeof self.destroyed !== 'boolean') self.destroyed = false;
    self.errored = null;
    baseStreamState(self);
    if (!Array.isArray(self._pipedDestinations)) self._pipedDestinations = [];
}

export function readableChunkLength(state: ReadableState, chunk: unknown): number {
    if (state.objectMode) return 1;
    if (typeof chunk === 'string') return chunk.length;
    if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
    return 0;
}

export function updateReadableLength(stream: { _readableState: ReadableState; readableLength: number }): number {
    const state = stream._readableState;
    let length = 0;
    for (const chunk of state.buffer) length += readableChunkLength(state, chunk);
    stream.readableLength = length;
    return stream.readableLength;
}

/* O(1) counterparts to updateReadableLength's full rescan. Buffered chunks now
 * accumulate (push() defers 'readable' instead of draining inline), so
 * recomputing the total on every push/read made those paths quadratic. */
export function addReadableLength(stream: { _readableState: ReadableState; readableLength: number }, chunk: unknown): number {
    stream.readableLength += readableChunkLength(stream._readableState, chunk);
    return stream.readableLength;
}

export function subtractReadableLength(stream: { _readableState: ReadableState; readableLength: number }, amount: number): number {
    stream.readableLength = Math.max(0, stream.readableLength - amount);
    return stream.readableLength;
}

function requestReadableData(target: ReadableTarget, size: number): void {
    const state = target._readableState;
    if (state.destroyed || state.ended || state.reading) return;
    state.reading = true;
    try {
        target._read(size);
    } catch (err) {
        state.reading = false;
        target.emit('error', err);
    }
}

function joinReadableChunks(chunks: unknown[], stringMode: boolean): unknown {
    if (chunks.length === 1) return chunks[0];
    if (stringMode) return chunks.join('');
    return Buffer.concat(chunks.map(bufferFromView));
}

function consumeReadableData(state: ReadableState, size: number): { chunk: unknown; consumed: number } {
    if (state.objectMode) {
        return { chunk: state.buffer.shift(), consumed: 1 };
    }

    const chunks: unknown[] = [];
    let remaining = size;
    let consumed = 0;
    while (remaining > 0 && state.buffer.length > 0) {
        const chunk = state.buffer[0];
        const length = readableChunkLength(state, chunk);
        if (length <= remaining) {
            chunks.push(state.buffer.shift());
            remaining -= length;
            consumed += length;
            continue;
        }
        if (typeof chunk === 'string') {
            chunks.push(chunk.slice(0, remaining));
            state.buffer[0] = chunk.slice(remaining);
        } else {
            const bytes = bufferFromView(chunk);
            chunks.push(bytes.subarray(0, remaining));
            state.buffer[0] = bytes.subarray(remaining);
        }
        consumed += remaining;
        remaining = 0;
    }
    return { chunk: joinReadableChunks(chunks, typeof chunks[0] === 'string'), consumed };
}

export function readReadableData(target: ReadableTarget, n?: number): unknown {
    const state = target._readableState;
    const numeric = n === null ? NaN : Number(n);
    const requested = n === undefined || Number.isNaN(numeric) || !Number.isFinite(numeric)
        ? undefined
        : Math.floor(numeric);
    requestReadableData(target, Math.max(state.highWaterMark, requested ?? 0));

    const available = target.readableLength;
    if (requested !== undefined && requested <= 0) return null;
    if (available === 0) {
        if (state.ended) target._emitReadableEndIfNeeded();
        else state.needReadable = true;
        return null;
    }

    let size = requested ?? available;
    if (size > available) {
        if (!state.ended) {
            state.needReadable = true;
            return null;
        }
        size = available;
    }
    if (state.objectMode) size = 1;

    const { chunk, consumed } = consumeReadableData(state, size);
    state.disturbed = true;
    target.readableDidRead = true;
    subtractReadableLength(target, consumed);
    emitDataAfterRead(target as Readable | Duplex, chunk);
    target._emitReadableEndIfNeeded();
    return chunk;
}

export function scheduleReadableFlow(target: { _readableState: ReadableState }, resume: () => void): void {
    const state = target._readableState;
    if (state.destroyed || state.resumeScheduled) return;
    state.resumeScheduled = true;
    queueMicrotask(() => {
        state.resumeScheduled = false;
        if (state.destroyed) return;
        resume();
    });
}

/* Node coalesces 'readable' onto a nextTick via state.emittedReadable rather
 * than firing it inline from push(): emitting synchronously re-enters push()
 * from the listener, which mis-slices chunk boundaries and overflows the stack
 * on large pushes. */
export function scheduleReadableEmit(target: Readable | Duplex): void {
    const state = target._readableState;
    if (state.destroyed || state.emittedReadable) return;
    state.emittedReadable = true;
    deferTick(() => {
        state.emittedReadable = false;
        if (state.destroyed) return;
        if (state.buffer.length === 0 && !state.ended) return;
        target.emit('readable');
    });
}

export function invokeReadableRead(target: { _readableState: ReadableState; _read(size: number): void; emit(event: string, error: unknown): void }): void {
    const state = target._readableState;
    if (state.destroyed || (!state.flowing && !state.readableListening) || state.ended || state.reading) return;
    requestReadableData(target as ReadableTarget, state.highWaterMark);
}

function emitDataAfterRead(stream: Readable | Duplex, chunk: unknown): void {
    if (stream.listenerCount('data') > 0) stream.emit('data', chunk);
}

export function unshiftReadableChunk(stream: Readable | Duplex, chunk: unknown, encoding?: BufferEncoding): boolean {
    const state = stream._readableState;
    if (typeof chunk === 'string') {
        chunk = Buffer.from(chunk, encoding || state.defaultEncoding);
    }
    if (state.endEmitted) {
        state.endEmitted = false;
        stream.readableEnded = false;
        stream.readable = true;
    }
    chunk = normalizeChunk(chunk, state.objectMode, encoding, state.defaultEncoding);
    const bytes = decoderBytes(chunk);
    if (state.decoder && bytes) {
        const decoded = state.decoder.write(bytes);
        if (decoded.length === 0) return updateReadableLength(stream) < state.highWaterMark;
        chunk = decoded;
    }
    state.buffer.unshift(chunk);
    updateReadableLength(stream);
    /* Deferred for the same reason push() defers: unshift() is normally called
     * from inside a 'readable' handler's read() loop, and a synchronous emit
     * re-enters that handler, which appended the unshifted bytes *before* the
     * outer loop appended the ones it already held ("cdabef" for "abcdef"). */
    if (!state.flowing || state.readableListening) scheduleReadableEmit(stream);
    return stream.readableLength < state.highWaterMark;
}

/* Node's unpipe() pauses the source once its last pipe is gone. Leaving
 * `flowing` true drops every chunk produced after the unpipe: push() emits
 * 'data' to zero listeners instead of buffering. Only when a pipe was actually
 * removed and none remain. */
export function unpipeDestinations(source: Readable | Duplex, destination?: Writable): void {
    const destinations = destination ? [destination] : [...source._pipedDestinations];
    let removedAny = false;
    for (const dest of destinations) {
        const cleanups = (dest as PipeTrackedWritable).__pipeCleanups;
        const entry = cleanups?.find(item => item.source === source);
        if (entry) {
            entry.cleanup(true);
            removedAny = true;
        } else {
            const idx = source._pipedDestinations.indexOf(dest);
            if (idx !== -1) {
                source._pipedDestinations.splice(idx, 1);
                removedAny = true;
            }
        }
    }
    if (removedAny && source._pipedDestinations.length === 0) source.pause();
}

/**
 * node's errorOrDestroy(): a stream error tears the stream down, emitting
 * 'close' and releasing the resource; 'error' alone leaks (an fs WriteStream
 * keeps its fd). Only under autoDestroy.
 */
export function writableErrorOrDestroy(stream: Writable, err: Error): void {
    const state = stream._writableState;
    if (state.destroyed) return;
    stream.errored = err;
    if (state.autoDestroy) {
        stream.destroy(err);
        return;
    }
    queueMicrotask(() => {
        stream.emit('error', err);
        /* Without a destroy there is no teardown to settle a pending end
         * callback, so it is settled here — otherwise a _final error under
         * autoDestroy:false parks a promisified end() forever. On the failed
         * write path these are already settled, making this a no-op. */
        settleEndCallbacks(stream, err);
    });
}

/** Settle every pending end() callback exactly once. */
export function settleEndCallbacks(stream: Writable, error: Error | null): void {
    const pending = stream._writableState.endCallbacks.splice(0);
    for (const callback of pending) callback(error);
}

export function maybeAutoDestroy(stream: Stream): void {
    if (stream.destroyed) return;
    const readable = isReadableLike(stream) ? stream : undefined;
    const writable = isWritableLike(stream) ? stream : undefined;
    const autoDestroy = writable?._writableState.autoDestroy ?? readable?._readableState.autoDestroy ?? false;
    if (!autoDestroy) return;
    if (readable && !readable.readableEnded) return;
    if (writable && !writable.writableFinished) return;
    queueMicrotask(() => {
        if (!stream.destroyed) stream.destroy();
    });
}

function writableChunkLength(state: WritableState, chunk: unknown, encoding: BufferEncoding): number {
    if (state.objectMode) return 1;
    if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
    if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
    return 0;
}

export function updateWritableLength(stream: Writable): number {
    const state = stream._writableState;
    stream.writableLength = state.buffer.reduce(
        (total, entry) => total + writableChunkLength(state, entry.chunk, entry.encoding),
        0,
    );
    return stream.writableLength;
}

export function queueSynchronousWriteCallbacks(stream: Writable, callbacks: Array<() => void>): void {
    const state = stream._writableState;
    state.afterWriteCallbacks.push(...callbacks);
    if (state.afterWriteScheduled) return;
    state.afterWriteScheduled = true;
    queueMicrotask(() => {
        state.afterWriteScheduled = false;
        if (state.pendingDrain) {
            state.pendingDrain = false;
            state.awaitDrain = 0;
            stream.writableNeedDrain = false;
            stream.emit('drain');
        }
        /* Drain to exhaustion: a callback may write again and append more. */
        while (state.afterWriteCallbacks.length > 0) {
            const pending = state.afterWriteCallbacks.splice(0);
            for (const callback of pending) callback();
        }
        /* Teardown last, and deliberately NOT in a `finally`: measured against
         * node 24, a write callback that THROWS leaves the stream undestroyed
         * and an fs fd open. Running the teardown regardless would repair a leak
         * node itself has, i.e. diverge. */
        const teardown = state.errorTeardown;
        if (teardown) {
            state.errorTeardown = null;
            teardown();
        }
    });
}

export function collectReadableToArray(stream: Readable | Duplex): Promise<unknown[]> {
    const chunks: unknown[] = [];
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
        };
        const onData = (chunk: unknown) => {
            chunks.push(chunk);
        };
        const onEnd = () => {
            cleanup();
            resolve(chunks);
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };

        stream.on('data', onData);
        stream.once('end', onEnd);
        stream.once('error', onError);
        if (stream.readableEnded || stream._readableState?.endEmitted) {
            cleanup();
            resolve(chunks);
            return;
        }
        stream.resume();
        if ('_duplexReadAndResolve' in stream && typeof stream._duplexReadAndResolve === 'function') {
            stream._duplexReadAndResolve();
        } else if ('_readAndResolve' in stream && typeof stream._readAndResolve === 'function') {
            stream._readAndResolve();
        }
    });
}

export function getDefaultHighWaterMark(objectMode: boolean): number {
    return defaultHighWaterMark(Boolean(objectMode));
}

export function setDefaultHighWaterMark(objectMode: boolean, value: number): void {
    validateHighWaterMark(value);
    if (objectMode) {
        defaultObjectHighWaterMark = value;
    } else {
        defaultByteHighWaterMark = value;
    }
}
