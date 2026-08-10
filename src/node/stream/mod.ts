import { EventEmitter } from '../events';
import { StringDecoder } from '../string_decoder';
import {
    installStreamOperators,
    type StreamLike as OperatorStreamLike,
} from './operators';

const os = import.meta.use('os');

export interface StreamOptions {
    highWaterMark?: number;
    encoding?: BufferEncoding;
    objectMode?: boolean;
    emitClose?: boolean;
    autoDestroy?: boolean;
    destroy?: (error: Error | null, callback: (error?: Error | null) => void) => void;
}

export interface ReadableOptions extends StreamOptions {
    read?: (size: number) => void;
    readableObjectMode?: boolean;
    readableHighWaterMark?: number;
}

export interface WritableOptions extends StreamOptions {
    decodeStrings?: boolean;
    defaultEncoding?: BufferEncoding;
    write?: (chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) => void;
    writev?: (chunks: Array<{ chunk: unknown; encoding: BufferEncoding }>, callback: (error?: Error | null) => void) => void;
    final?: (callback: (error?: Error | null) => void) => void;
    writableObjectMode?: boolean;
    writableHighWaterMark?: number;
}

export interface DuplexOptions extends ReadableOptions, WritableOptions {
    allowHalfOpen?: boolean;
    readable?: boolean;
    writable?: boolean;
    readableObjectMode?: boolean;
    writableObjectMode?: boolean;
    readableHighWaterMark?: number;
    writableHighWaterMark?: number;
}

export interface TransformOptions extends DuplexOptions {
    transform?: (chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void) => void;
    flush?: (callback: (error?: Error | null, data?: unknown) => void) => void;
}

export interface PipeOptions {
    end?: boolean;
}

/* Shared shapes for the iterator helpers. node passes the callback a second
 * `{ signal }` argument, so callbacks may legitimately be binary. */
export interface StreamIteratorOptions {
    signal?: AbortSignal;
    concurrency?: number;
    highWaterMark?: number;
}

export type StreamIteratorCallback = (value: unknown, options?: { signal: AbortSignal }) => unknown;
export type StreamReducer = (previous: unknown, value: unknown, options?: { signal: AbortSignal }) => unknown;

function isAsyncIterable(value: Iterable<unknown> | AsyncIterable<unknown>): value is AsyncIterable<unknown> {
    return value !== null && value !== undefined
        && typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
}

function isIterable(value: Iterable<unknown> | AsyncIterable<unknown>): value is Iterable<unknown> {
    return value !== null && value !== undefined
        && typeof Reflect.get(value, Symbol.iterator) === 'function';
}

function normalizeChunk(chunk: unknown, objectMode: boolean, encoding: BufferEncoding | undefined, defaultEncoding: BufferEncoding): unknown {
    if (objectMode || chunk === null) return chunk;
    if (typeof chunk === 'string') return Buffer.from(chunk, encoding || defaultEncoding);
    if (ArrayBuffer.isView(chunk) && !(chunk instanceof Buffer)) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return chunk;
}

function createWriteAfterEndError(): Error & { code: string } {
    return Object.assign(new Error('write after end'), {
        code: 'ERR_STREAM_WRITE_AFTER_END',
    });
}

function createNullWriteError(): TypeError & { code: string } {
    return Object.assign(new TypeError('May not write null values to stream'), {
        code: 'ERR_STREAM_NULL_VALUES',
    });
}

function createInvalidChunkError(chunk: unknown): TypeError & { code: string } {
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

function createDestroyedError(): Error & { code: string } {
    return Object.assign(new Error('Cannot call write after a stream was destroyed'), {
        code: 'ERR_STREAM_DESTROYED',
    });
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/* Node runs destroy/error/close emissions on the next tick so that
 * `stream.destroy(err)` never throws at the call site before the caller has had
 * a chance to attach its 'error' listener. `process` is resolved lazily: this
 * module is loaded by ../process/streams, so a static import would form a cycle. */
type NextTickHost = { nextTick?: (callback: () => void, ...args: unknown[]) => void };

function deferTick(callback: () => void): void {
    const host = (globalThis as { process?: NextTickHost }).process;
    if (host && typeof host.nextTick === 'function') {
        host.nextTick(callback);
        return;
    }
    queueMicrotask(callback);
}

type DestroyStateLike = { destroyed: boolean; emitClose: boolean; closed: boolean };
type DestroyHookHost = Stream & {
    _destroy?(error: Error | null, callback: (error?: Error | null) => void): void;
};

/* Shared tail of every destroy() override: invoke the user's `_destroy()` hook
 * (Node's documented teardown seam) and only once it calls back emit 'error'
 * then 'close', both deferred. */
function runStreamDestroy(
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

const isWindows = os.uname().sysname === 'Windows_NT';
let defaultByteHighWaterMark = isWindows ? 16 * 1024 : 64 * 1024;
let defaultObjectHighWaterMark = 16;

function defaultHighWaterMark(objectMode: boolean): number {
    return objectMode ? defaultObjectHighWaterMark : defaultByteHighWaterMark;
}

function validateHighWaterMark(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0x3fffffff) {
        throw new RangeError('The value of "value" is out of range. It must be a non-negative integer.');
    }
}

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

function isConstructCallTarget(value: unknown, prototype: object): value is object {
    return !!value
        && (typeof value === 'object' || typeof value === 'function')
        && prototype.isPrototypeOf(value);
}

type PipeCleanupEntry = { source: Stream; cleanup: (emitUnpipe?: boolean) => void };
type PipeTrackedWritable = Writable & { __pipeCleanups?: PipeCleanupEntry[] };
type MaybePausable = { pause?: () => unknown; resume?: () => unknown; destroyed?: boolean };
type StreamListener = (...args: unknown[]) => void;
type ReadableWrappedSource = EventEmitter & MaybePausable;

function isReadableLike(value: unknown): value is Readable | Duplex {
    return !!value
        && typeof value === 'object'
        && '_readableState' in value
        && 'readable' in value;
}

function isWritableLike(value: unknown): value is Writable | Duplex {
    return !!value
        && typeof value === 'object'
        && '_writableState' in value
        && 'writable' in value;
}

function decoderBytes(chunk: unknown): Buffer | null {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk);
    return null;
}

function bufferFromView(chunk: unknown): Buffer {
    if (!ArrayBuffer.isView(chunk)) return Buffer.alloc(0);
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export interface Stream extends EventEmitter {
    destroyed: boolean;
    closed: boolean;
    errored: Error | null;
    _pipedDestinations: Writable[];
    _destroy?(error: Error | null, callback: (error?: Error | null) => void): void;
    pipe<T extends Writable>(destination: T, options?: PipeOptions): T;
    destroy(error?: Error | null): this;
}

export interface StreamConstructor {
    new (): Stream;
    (): Stream;
    prototype: Stream;
}

/* Base-stream stand-in for the per-side state objects Readable/Writable carry:
 * gives plain Stream instances somewhere to record emitClose/closed. */
type BaseStreamState = DestroyStateLike;
const baseStreamStates = new WeakMap<object, BaseStreamState>();

function baseStreamState(self: Stream): BaseStreamState {
    let state = baseStreamStates.get(self);
    if (!state) {
        state = { destroyed: false, emitClose: true, closed: false };
        baseStreamStates.set(self, state);
    }
    return state;
}

function initStream(self: Stream): void {
    EventEmitter.call(self);
    if (typeof self.destroyed !== 'boolean') self.destroyed = false;
    self.errored = null;
    baseStreamState(self);
    if (!Array.isArray(self._pipedDestinations)) self._pipedDestinations = [];
}

export const Stream: StreamConstructor = function Stream(this: Stream | undefined) {
    const target = isConstructCallTarget(this, Stream.prototype)
        ? this
        : Object.create(Stream.prototype);
    initStream(target);
    return target;
} as StreamConstructor;

Object.setPrototypeOf(Stream, EventEmitter);
Stream.prototype = Object.create(EventEmitter.prototype);

Stream.prototype.pipe = function pipe<T extends Writable>(this: Stream, destination: T, options?: PipeOptions): T {
    const src = this as Stream & MaybePausable;
    const trackedDestination = destination as PipeTrackedWritable;
    let drained = true;

    if (!Array.isArray(this._pipedDestinations)) this._pipedDestinations = [];
    this._pipedDestinations.push(destination);

    const onData = (chunk: unknown) => {
        if (!destination.write(chunk)) {
            drained = false;
            src.pause?.();
        }
    };

    const onDrain = () => {
        if (!drained) {
            drained = true;
            src.resume?.();
        }
    };

    const onEnd = () => {
        if (options?.end !== false) {
            destination.end();
        }
        cleanup(true);
    };

    const cleanup = (emitUnpipe = false) => {
        const cleanups = trackedDestination.__pipeCleanups;
        const entryIndex = cleanups?.findIndex(entry => entry.source === this && entry.cleanup === cleanup) ?? -1;
        const wasPiped = entryIndex !== -1;
        this.removeListener('data', onData);
        destination.removeListener('drain', onDrain);
        this.removeListener('end', onEnd);
        this.removeListener('close', onClose);
        destination.removeListener('close', onDestClose);
        if (wasPiped && cleanups) {
            cleanups.splice(entryIndex, 1);
            if (cleanups.length === 0) delete trackedDestination.__pipeCleanups;
        }
        const idx = this._pipedDestinations.indexOf(destination);
        if (idx !== -1) this._pipedDestinations.splice(idx, 1);
        if (emitUnpipe && wasPiped) destination.emit('unpipe', this);
    };

    const onClose = () => {
        cleanup(true);
    };

    const onDestClose = () => {
        cleanup(true);
        if (!src.destroyed) src.pause?.();
    };

    this.on('data', onData);
    destination.on('drain', onDrain);
    this.on('end', onEnd);
    this.on('close', onClose);
    destination.on('close', onDestClose);

    const cleanups = trackedDestination.__pipeCleanups ??= [];
    cleanups.push({ source: this, cleanup });
    destination.emit('pipe', this);
    src.resume?.();

    // Source already at EOF: 'end' fired before this pipe existed, so `onEnd`
    // above would never run and the destination would wait forever for an end
    // that never comes. Node ends the destination in this shape (measured on
    // v24.18.0), which is what lets pipeline() over a consumed source resolve.
    // Deferred so 'pipe' is observed first and ordering matches the live path.
    const alreadyEnded = (this as Stream & {
        readableEnded?: boolean;
        _readableState?: { endEmitted?: boolean };
    }).readableEnded === true
        || (this as Stream & {
            _readableState?: { endEmitted?: boolean };
        })._readableState?.endEmitted === true;
    if (alreadyEnded) {
        process.nextTick(() => {
            if (this._pipedDestinations.indexOf(destination) === -1) return;
            onEnd();
        });
    }

    return destination;
};

Stream.prototype.destroy = function destroy(this: Stream, error?: Error | null): Stream {
    if (this.destroyed) return this;
    this.destroyed = true;
    const state = baseStreamState(this);
    state.destroyed = true;
    runStreamDestroy(this, error, [state]);
    return this;
};

/* `closed` reads through to whichever state object the concrete stream owns; a
 * bare Stream falls back to its side table entry. Readable/Writable/Duplex
 * override this getter with a state-specific one. */
Object.defineProperty(Stream.prototype, 'closed', {
    get(this: Stream): boolean {
        return baseStreamStates.get(this)?.closed ?? false;
    },
    enumerable: false,
    configurable: true,
});

Object.defineProperty(Stream.prototype, 'constructor', {
    value: Stream,
    writable: true,
    configurable: true,
});

flattenPrototype(Stream.prototype);

type ReadableState = {
    buffer: unknown[];
    objectMode: boolean;
    highWaterMark: number;
    flowing: boolean | null;
    ended: boolean;
    endEmitted: boolean;
    reading: boolean;
    sync: boolean;
    needReadable: boolean;
    emittedReadable: boolean;
    readableListening: boolean;
    resumeScheduled: boolean;
    destroyed: boolean;
    defaultEncoding: BufferEncoding;
    awaitDrain: number;
    readingMore: boolean;
    decoder: StringDecoder | null;
    encoding: BufferEncoding | null;
    disturbed: boolean;
    emitClose: boolean;
    autoDestroy: boolean;
    closed: boolean;
};

type ReadableTarget = {
    _readableState: ReadableState;
    readableLength: number;
    readableDidRead: boolean;
    _read(size: number): void;
    _emitReadableEndIfNeeded(): void;
    emit(event: string, ...args: unknown[]): boolean;
};

function readableChunkLength(state: ReadableState, chunk: unknown): number {
    if (state.objectMode) return 1;
    if (typeof chunk === 'string') return chunk.length;
    if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
    return 0;
}

function updateReadableLength(stream: { _readableState: ReadableState; readableLength: number }): number {
    const state = stream._readableState;
    let length = 0;
    for (const chunk of state.buffer) length += readableChunkLength(state, chunk);
    stream.readableLength = length;
    return stream.readableLength;
}

/* O(1) counterparts to updateReadableLength's full rescan. Buffered chunks now
 * accumulate (push() defers 'readable' instead of draining inline), so
 * recomputing the total on every push/read made those paths quadratic. */
function addReadableLength(stream: { _readableState: ReadableState; readableLength: number }, chunk: unknown): number {
    stream.readableLength += readableChunkLength(stream._readableState, chunk);
    return stream.readableLength;
}

function subtractReadableLength(stream: { _readableState: ReadableState; readableLength: number }, amount: number): number {
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

function readReadableData(target: ReadableTarget, n?: number): unknown {
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

function scheduleReadableFlow(target: { _readableState: ReadableState }, resume: () => void): void {
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
function scheduleReadableEmit(target: Readable | Duplex): void {
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

function invokeReadableRead(target: { _readableState: ReadableState; _read(size: number): void; emit(event: string, error: unknown): void }): void {
    const state = target._readableState;
    if (state.destroyed || (!state.flowing && !state.readableListening) || state.ended || state.reading) return;
    requestReadableData(target as ReadableTarget, state.highWaterMark);
}

function emitDataAfterRead(stream: Readable | Duplex, chunk: unknown): void {
    if (stream.listenerCount('data') > 0) stream.emit('data', chunk);
}

function unshiftReadableChunk(stream: Readable | Duplex, chunk: unknown, encoding?: BufferEncoding): boolean {
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

export interface Readable extends Stream {
    readable: boolean;
    readableEnded: boolean;
    readableFlowing: boolean | null;
    readableHighWaterMark: number;
    readableLength: number;
    readableObjectMode: boolean;
    readableEncoding: BufferEncoding | null;
    readableAborted: boolean;
    readableDidRead: boolean;
    _readableState: ReadableState;
    _read(size: number): void;
    _emitReadableEndIfNeeded(): void;
    _readAndResolve(): void;
    read(n?: number): unknown;
    setEncoding(enc: BufferEncoding): this;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    unpipe(destination?: Writable): this;
    unshift(chunk: unknown, encoding?: BufferEncoding): boolean;
    wrap(stream: ReadableWrappedSource): this;
    push(chunk: unknown, encoding?: BufferEncoding): boolean;
    toArray(options?: StreamIteratorOptions): Promise<unknown[]>;
    map(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Readable;
    filter(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Readable;
    flatMap(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Readable;
    take(count: number, options?: StreamIteratorOptions): Readable;
    drop(count: number, options?: StreamIteratorOptions): Readable;
    forEach(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Promise<void>;
    reduce(reducer: StreamReducer, initialValue?: unknown, options?: StreamIteratorOptions): Promise<unknown>;
    some(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Promise<boolean>;
    every(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Promise<boolean>;
    find(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Promise<unknown>;
    iterator(options?: { destroyOnReturn?: boolean }): AsyncIterableIterator<unknown>;
    compose(stream: unknown, options?: StreamIteratorOptions): Duplex;
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
}

export interface ReadableConstructor {
    new (options?: ReadableOptions): Readable;
    (options?: ReadableOptions): Readable;
    prototype: Readable;
    from(iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: ReadableOptions): Readable;
}

function initReadable(self: Readable, options?: ReadableOptions): void {
    Stream.call(self);
    self.readable = true;
    self.readableEnded = false;
    self.readableObjectMode = options?.objectMode ?? false;
    self.readableHighWaterMark = options?.highWaterMark ?? defaultHighWaterMark(self.readableObjectMode);
    self.readableLength = 0;
    self.readableEncoding = options?.encoding ?? null;
    self.readableAborted = false;
    self.readableDidRead = false;
    self._readableState = {
        buffer: [],
        encoding: options?.encoding ?? null,
        objectMode: self.readableObjectMode,
        highWaterMark: self.readableHighWaterMark,
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

    if (options?.read) {
        self._read = options.read;
    }
    if (options?.destroy) {
        self._destroy = options.destroy;
    }
}

export const Readable: ReadableConstructor = function Readable(this: Readable | undefined, options?: ReadableOptions) {
    const target = isConstructCallTarget(this, Readable.prototype)
        ? this
        : Object.create(Readable.prototype);
    initReadable(target, options);
    return target;
} as ReadableConstructor;

Object.setPrototypeOf(Readable, Stream);
Readable.prototype = Object.create(Stream.prototype);

Readable.prototype.on = function on(this: Readable, event: string | symbol, fn: StreamListener): Readable {
    Stream.prototype.on.call(this, event, fn);
    if (event === 'data') this.resume();
    if (event === 'readable') {
        const state = this._readableState;
        state.readableListening = true;
        // Node parks the stream in paused mode when a 'readable' listener is
        // attached, overriding an earlier flowing=true, so isPaused() and
        // readableFlowing report false rather than null/true.
        state.flowing = false;
        if (state.buffer.length > 0 || state.ended) scheduleReadableEmit(this);
        else invokeReadableRead(this);
    }
    return this;
};

Readable.prototype.once = function once(this: Readable, event: string | symbol, fn: StreamListener): Readable {
    Stream.prototype.once.call(this, event, fn);
    if (event === 'data') this.resume();
    if (event === 'readable') {
        const state = this._readableState;
        state.readableListening = true;
        // Node parks the stream in paused mode when a 'readable' listener is
        // attached, overriding an earlier flowing=true, so isPaused() and
        // readableFlowing report false rather than null/true.
        state.flowing = false;
        if (state.buffer.length > 0 || state.ended) scheduleReadableEmit(this);
        else invokeReadableRead(this);
    }
    return this;
};

Readable.prototype.removeListener = function removeListener(this: Readable, event: string | symbol, fn: StreamListener): Readable {
    Stream.prototype.removeListener.call(this, event, fn);
    if (event === 'readable' && this.listenerCount('readable') === 0) {
        this._readableState.readableListening = false;
    }
    return this;
};

Readable.prototype.off = Readable.prototype.removeListener;

Readable.prototype.removeAllListeners = function removeAllListeners(this: Readable, event?: string | symbol): Readable {
    Stream.prototype.removeAllListeners.call(this, event);
    if (event === undefined || event === 'readable') {
        this._readableState.readableListening = false;
    }
    return this;
};

Readable.prototype._emitReadableEndIfNeeded = function _emitReadableEndIfNeeded(this: Readable): void {
    const state = this._readableState;
    if (!state.ended || state.endEmitted || state.buffer.length > 0) return;
    state.endEmitted = true;
    this.readableEnded = true;
    this.readable = false;
    /* Node emits 'end' from a nextTick (endReadableNT), never inline. This is
     * reached from inside read(), so emitting synchronously ran the consumer's
     * 'end' handler before read() had returned the chunk to its caller — a
     * 'readable'+read() loop then reported an empty body with no error. */
    deferTick(() => {
        this.emit('end');
        maybeAutoDestroy(this);
    });
};

Readable.from = function from(iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: ReadableOptions): Readable {
    const readable = new Readable({ objectMode: true, ...options });
    if (typeof iterable === 'string' || Buffer.isBuffer(iterable)) {
        let ended = false;
        readable._read = () => {
            if (ended) return;
            ended = true;
            readable.push(iterable);
            readable.push(null);
        };
        return readable;
    }

    const iterator = isAsyncIterable(iterable)
        ? iterable[Symbol.asyncIterator]()
        : isIterable(iterable)
            ? iterable[Symbol.iterator]()
            : undefined;
    if (!iterator || typeof iterator.next !== 'function') {
        throw new TypeError('The "iterable" argument must be an instance of Iterable');
    }

    let reading = false;
    let ended = false;
    let cleaned = false;
    /* Node calls iterator.return() when the consumer bails out early (break,
     * destroy, throw) so generators run their finally blocks and release
     * handles; without it the source leaks. */
    const cleanupIterator = () => {
        if (cleaned) return;
        cleaned = true;
        if (typeof iterator.return !== 'function') return;
        try {
            const result = iterator.return();
            if (result && typeof (result as Promise<unknown>).then === 'function') {
                (result as Promise<unknown>).then(undefined, () => {});
            }
        } catch {
            // Cleanup is best-effort; a throwing return() must not mask the
            // original destroy reason.
        }
    };

    readable._destroy = (error, callback) => {
        ended = true;
        cleanupIterator();
        callback(error);
    };
    readable.once('end', cleanupIterator);

    readable._read = async () => {
        if (reading || ended) return;
        reading = true;
        try {
            const { value, done } = await iterator.next();
            if (done) {
                ended = true;
                cleaned = true;
                readable.push(null);
            } else if (readable.destroyed) {
                ended = true;
                cleanupIterator();
            } else {
                if (value === null) {
                    ended = true;
                    readable.destroy(createNullWriteError());
                    return;
                }
                readable.push(value);
            }
        } catch (err) {
            cleaned = true;
            readable.destroy(err instanceof Error ? err : new Error(String(err)));
        } finally {
            reading = false;
        }
    };

    return readable;
};

Readable.prototype.read = function read(this: Readable, n?: number): unknown {
    return readReadableData(this, n);
};

Readable.prototype.setEncoding = function setEncoding(this: Readable, enc: BufferEncoding): Readable {
    this.readableEncoding = enc;
    const state = this._readableState;
    state.encoding = enc;
    state.decoder = new StringDecoder(enc);
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
    updateReadableLength(this);
    return this;
};

Readable.prototype.pause = function pause(this: Readable): Readable {
    const state = this._readableState;
    if (state.flowing !== false) {
        state.flowing = false;
        this.emit('pause');
    }
    return this;
};

Readable.prototype.resume = function resume(this: Readable): Readable {
    const state = this._readableState;
    if (state.readableListening && this.listenerCount('data') === 0) {
        this.emit('resume');
        invokeReadableRead(this);
        return this;
    }
    if (!state.flowing) {
        state.flowing = true;
        this.emit('resume');
        // Defer like Node's nextTick, else pipe()'s own 'end' listener (added
        // right after this.on('data',...)) isn't registered yet when it fires.
        scheduleReadableFlow(this, () => this._readAndResolve());
    } else {
        scheduleReadableFlow(this, () => this._readAndResolve());
    }
    return this;
};

Readable.prototype._readAndResolve = function _readAndResolve(this: Readable): void {
    const state = this._readableState;
    if (state.destroyed || !state.flowing) return;

    while (!state.destroyed && state.flowing && state.buffer.length > 0) {
        let chunk = state.buffer.shift();
        state.disturbed = true;
        this.readableDidRead = true;
        subtractReadableLength(this, readableChunkLength(state, chunk));
        this.emit('data', chunk);
    }

    if (state.ended) {
        this._emitReadableEndIfNeeded();
        return;
    }

    invokeReadableRead(this);
};

Readable.prototype.isPaused = function isPaused(this: Readable): boolean {
    return this._readableState.flowing === false;
};

/* Mirror of _readableState.flowing rather than a field: it was assigned null at
 * init and never updated, so anything branching on the documented
 * null -> false -> true state machine saw null forever. */
Object.defineProperty(Readable.prototype, 'readableFlowing', {
    get(this: Readable): boolean | null { return this._readableState.flowing; },
    set(this: Readable, v: boolean | null) { this._readableState.flowing = v; },
    enumerable: true,
    configurable: true,
});

/* Node's unpipe() pauses the source once its last pipe is gone. Leaving
 * `flowing` true is what loses data: push() then takes its flowing branch and
 * emits 'data' to zero listeners, so every chunk produced after the unpipe is
 * dropped on the floor instead of staying buffered for the next consumer.
 * Only pauses when a pipe was actually removed (an unpipe() naming a
 * never-piped destination, or with nothing piped at all, is a no-op in node)
 * and only when no pipes remain (unpiping one of two keeps the source flowing). */
function unpipeDestinations(source: Readable | Duplex, destination?: Writable): void {
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

Readable.prototype.unpipe = function unpipe(this: Readable, destination?: Writable): Readable {
    unpipeDestinations(this, destination);
    return this;
};

Readable.prototype.unshift = function unshift(this: Readable, chunk: unknown, encoding?: BufferEncoding): boolean {
    return unshiftReadableChunk(this, chunk, encoding);
};

Readable.prototype.wrap = function wrap(this: Readable, stream: ReadableWrappedSource): Readable {
    if (stream && typeof stream.on === 'function') {
        stream.on('data', (chunk: unknown) => {
            if (!this.push(chunk)) {
                stream.pause?.();
            }
        });
        stream.on('end', () => { this.push(null); });
        stream.on('error', (err: Error) => { this.destroy(err); });
        stream.resume?.();
    }
    return this;
};

Readable.prototype.push = function push(this: Readable, chunk: unknown, encoding?: BufferEncoding): boolean {
    const state = this._readableState;
    if (state.destroyed) return false;
    state.reading = false;

    let decodedTrailing = false;
    const ending = chunk === null;
    if (ending) {
        state.ended = true;
        if (state.decoder) {
            const trailing = state.decoder.end();
            if (trailing) {
                chunk = trailing;
                decodedTrailing = true;
            } else {
                // Same EOF notification as the no-decoder branch below. Without
                // it, setEncoding() + a 'readable' listener never saw 'end':
                // nothing re-entered read() to drain the buffer and emit it.
                if (!state.flowing && state.readableListening) this.emit('readable');
                if (state.flowing) this._emitReadableEndIfNeeded();
                return false;
            }
        } else {
            if (!state.flowing && state.readableListening) this.emit('readable');
            if (state.flowing) this._emitReadableEndIfNeeded();
            return false;
        }
    }

    if (!state.objectMode && chunk === undefined) return true;
    if (!state.objectMode && typeof chunk !== 'string' && !ArrayBuffer.isView(chunk)) {
        this.destroy(createInvalidChunkError(chunk));
        return false;
    }
    // Node drops zero-length pushes entirely: they are not EOF (unlike
    // push(null)) and must not surface as an empty 'data' event.
    if (!state.objectMode && !ending && readableChunkLength(state, chunk) === 0) {
        return this.readableLength < state.highWaterMark;
    }

    if (!decodedTrailing) chunk = normalizeChunk(chunk, state.objectMode, encoding, state.defaultEncoding);
    const bytes = decoderBytes(chunk);
    if (!decodedTrailing && state.decoder && bytes) {
        const decoded = state.decoder.write(bytes);
        if (decoded.length === 0) return updateReadableLength(this) < state.highWaterMark;
        chunk = decoded;
    }

    if (state.flowing && !state.readableListening) {
        state.disturbed = true;
        this.readableDidRead = true;
        this.emit('data', chunk);
        if (!state.destroyed) scheduleReadableFlow(this, () => this._readAndResolve());
        return ending ? false : this.readableLength < state.highWaterMark;
    }

    state.buffer.push(chunk);
    addReadableLength(this, chunk);
    scheduleReadableEmit(this);

    return ending ? false : this.readableLength < state.highWaterMark;
};

Readable.prototype._read = function _read(this: Readable, size: number): void {
    throw new Error('_read() must be implemented');
};

Readable.prototype.destroy = function destroy(this: Readable, error?: Error | null): Readable {
    const state = this._readableState;
    if (state.destroyed) return this;
    state.destroyed = true;
    this.destroyed = true;
    this.readableAborted = !this.readableEnded;
    if (error) this.errored = error;
    this.readable = false;
    state.buffer.length = 0;
    this.readableLength = 0;
    runStreamDestroy(this, error, [state]);
    return this;
};

Object.defineProperty(Readable.prototype, 'closed', {
    get(this: Readable): boolean { return this._readableState.closed; },
    enumerable: false,
    configurable: true,
});

Readable.prototype.toArray = function toArray(this: Readable): Promise<unknown[]> {
    return collectReadableToArray(this);
};

Readable.prototype[Symbol.asyncIterator] = function asyncIterator(this: Readable): AsyncIterableIterator<unknown> {
    const readable = this;
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next(): Promise<IteratorResult<unknown>> {
            const buffered = readable.read();
            if (buffered !== null) {
                return Promise.resolve({ done: false, value: buffered });
            }
            if (readable.readableEnded) {
                return Promise.resolve({ done: true, value: undefined });
            }
            // Already torn down: no further event will ever arrive.
            if (readable.destroyed) {
                if (readable.errored) {
                    const error = readable.errored;
                    // read() can synchronously enter the destroyed state while
                    // destroy(error) has only queued its 'error' event. The
                    // iterator already reports that error through its rejected
                    // next() result, but the deferred event still needs a
                    // listener or EventEmitter will throw it a second time.
                    const consumeDeferredError = () => {};
                    readable.once('error', consumeDeferredError);
                    deferTick(() => readable.off('error', consumeDeferredError));
                    return Promise.reject(error);
                }
                return Promise.resolve({ done: true, value: undefined });
            }
            // Node's createAsyncIterator waits on 'readable' and pulls with read();
            // it never resumes. Resuming here would switch the stream to flowing mode
            // and hand the data to any 'data' listener instead of this iterator, so a
            // concurrent paused-mode reader (got's Request duplex, for one) would starve
            // and observe a silently empty body.
            const useDataEvents = readable.readableFlowing === true;
            return new Promise((resolve, reject) => {
                const onReadable = () => {
                    const chunk = readable.read();
                    if (chunk !== null) {
                        cleanup();
                        resolve({ done: false, value: chunk });
                        return;
                    }
                    // A 'readable' with an empty buffer means EOF is imminent; 'end'
                    // settles it. Anything else is a spurious wakeup -- keep waiting.
                    if (readable.readableEnded) {
                        cleanup();
                        resolve({ done: true, value: undefined });
                    }
                };
                const onData = (chunk: unknown) => {
                    cleanup();
                    readable.pause();
                    resolve({ done: false, value: chunk });
                };
                const onEnd = () => {
                    cleanup();
                    resolve({ done: true, value: undefined });
                };
                const onError = (err: Error) => {
                    cleanup();
                    reject(err);
                };
                // destroy() with no error emits only 'close'; without this the
                // promise never settles and the for-await loop hangs forever.
                const onClose = () => {
                    cleanup();
                    if (readable.readableEnded) {
                        resolve({ done: true, value: undefined });
                        return;
                    }
                    const err = readable.errored;
                    if (err) {
                        reject(err);
                        return;
                    }
                    reject(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
                };
                const cleanup = () => {
                    readable.off('readable', onReadable);
                    readable.off('data', onData);
                    readable.off('end', onEnd);
                    readable.off('error', onError);
                    readable.off('close', onClose);
                };

                if (useDataEvents) {
                    // The stream was handed to us already flowing; joining the 'data'
                    // path is the only way to see those chunks.
                    readable.on('data', onData);
                } else {
                    readable.on('readable', onReadable);
                }
                readable.on('end', onEnd);
                readable.on('error', onError);
                readable.on('close', onClose);
            });
        },
        async return() {
            // Node destroys the readable when the loop is exited early via
            // break/return/throw — otherwise the fd or socket handle leaks.
            readable.pause();
            readable.destroy();
            return { done: true, value: undefined };
        },
    } as AsyncIterableIterator<unknown>;
};

Object.defineProperty(Readable.prototype, 'constructor', {
    value: Readable,
    writable: true,
    configurable: true,
});

flattenPrototype(Readable.prototype);

type WritableState = {
    objectMode: boolean;
    highWaterMark: number;
    buffer: Array<{ chunk: unknown; encoding: BufferEncoding; callback: (error?: Error | null) => void }>;
    writing: boolean;
    corked: number;
    ended: boolean;
    finished: boolean;
    finishScheduled: boolean;
    finalCalled: boolean;
    decodeStrings: boolean;
    defaultEncoding: BufferEncoding;
    destroyed: boolean;
    awaitDrain: number;
    emitClose: boolean;
    autoDestroy: boolean;
    afterWriteCallbacks: Array<() => void>;
    afterWriteScheduled: boolean;
    pendingDrain: boolean;
    closed: boolean;
    /* Callbacks handed to end(); node settles them with the stream's error when
     * one appears and with null on 'finish', so they cannot be armed on 'finish'
     * alone — a stream that errors never emits it and the callback would park
     * forever (a promisified end() hangs). */
    endCallbacks: Array<(error?: Error | null) => void>;
    /* Teardown for a failed write, run once the ENTIRE afterWrite queue has
     * drained. It cannot be an element of that queue: with several buffered
     * chunks each failing write appends its own entries, so a teardown sitting
     * mid-array settled the end callback before the last write callback and
     * produced w2>endcb>w3 where node drains w1>w2>w3 first. */
    errorTeardown: (() => void) | null;
};

/**
 * node's errorOrDestroy(): a stream error tears the stream down rather than
 * merely announcing itself, which is what emits 'close' and releases the
 * underlying resource. Emitting 'error' alone (as this did) left the stream
 * alive — destroyed stayed false, 'close' never came, an fs WriteStream leaked
 * its fd, and the still-writable stream accepted the next chunk and emitted a
 * SECOND 'error'. Measured against node 24: destroy happens only under
 * autoDestroy; with autoDestroy:false node emits 'error' and leaves the stream
 * undestroyed.
 */
function writableErrorOrDestroy(stream: Writable, err: Error): void {
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
function settleEndCallbacks(stream: Writable, error: Error | null): void {
    const pending = stream._writableState.endCallbacks.splice(0);
    for (const callback of pending) callback(error);
}

function maybeAutoDestroy(stream: Stream): void {
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

function updateWritableLength(stream: Writable): number {
    const state = stream._writableState;
    stream.writableLength = state.buffer.reduce(
        (total, entry) => total + writableChunkLength(state, entry.chunk, entry.encoding),
        0,
    );
    return stream.writableLength;
}

function queueSynchronousWriteCallbacks(stream: Writable, callbacks: Array<() => void>): void {
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

export interface Writable extends Stream {
    writable: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    writableHighWaterMark: number;
    writableLength: number;
    writableObjectMode: boolean;
    writableCorked: number;
    writableNeedDrain: boolean;
    writableAborted: boolean;
    _writableState: WritableState;
    _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void;
    _writev?(chunks: Array<{ chunk: unknown; encoding: BufferEncoding }>, callback: (error?: Error | null) => void): void;
    _final?(callback: (error?: Error | null) => void): void;
    _writeBuffered(): void;
    _doFinal(): void;
    write(chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean;
    setDefaultEncoding(encoding: BufferEncoding): this;
    end(chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): this;
    cork(): void;
    uncork(): void;
}

export interface WritableConstructor {
    new (options?: WritableOptions): Writable;
    (options?: WritableOptions): Writable;
    prototype: Writable;
}

function initWritable(self: Writable, options?: WritableOptions | DuplexOptions): void {
    Stream.call(self);
    self.writable = true;
    self.writableEnded = false;
    self.writableFinished = false;
    self.writableObjectMode = !!(options?.objectMode || options?.writableObjectMode);
    self.writableHighWaterMark = options?.highWaterMark
        ?? options?.writableHighWaterMark
        ?? defaultHighWaterMark(self.writableObjectMode);
    self.writableLength = 0;
    self.writableCorked = 0;
    self.writableNeedDrain = false;
    self.writableAborted = false;
    self._writableState = {
        objectMode: self.writableObjectMode,
        highWaterMark: self.writableHighWaterMark,
        buffer: [],
        writing: false,
        corked: 0,
        ended: false,
        finished: false,
        finishScheduled: false,
        finalCalled: false,
        decodeStrings: options?.decodeStrings ?? true,
        defaultEncoding: options?.defaultEncoding ?? 'utf8',
        destroyed: false,
        awaitDrain: 0,
        emitClose: options?.emitClose ?? true,
        autoDestroy: options?.autoDestroy ?? true,
        afterWriteCallbacks: [],
        afterWriteScheduled: false,
        pendingDrain: false,
        closed: false,
        endCallbacks: [],
        errorTeardown: null,
    };

    if (options?.write) {
        self._write = options.write;
    }
    if (options?.writev) {
        self._writev = options.writev;
    }
    if (options?.final) {
        self._final = options.final;
    }
    if (options?.destroy) {
        self._destroy = options.destroy;
    }
}

export const Writable: WritableConstructor = function Writable(this: Writable | undefined, options?: WritableOptions) {
    const target = isConstructCallTarget(this, Writable.prototype)
        ? this
        : Object.create(Writable.prototype);
    initWritable(target, options);
    return target;
} as WritableConstructor;

Object.setPrototypeOf(Writable, Stream);
Writable.prototype = Object.create(Stream.prototype);

Writable.prototype.write = function write(
    this: Writable,
    chunk: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
): boolean {
    let writeEncoding: BufferEncoding | undefined = typeof encoding === 'function' ? undefined : encoding;
    if (typeof encoding === 'function') {
        callback = encoding;
        writeEncoding = 'utf8';
    }

    const state = this._writableState;

    /* Node rejects writes on a torn-down stream before they can reach _write.
     * The error goes to the write callback on a later tick and NOT to 'error':
     * node routes it through errorOrDestroy(), which returns immediately when
     * the stream is already destroyed. Emitting it unconditionally (as this did)
     * killed the process whenever no 'error' listener was attached — verified
     * against node 24, which survives the same program. */
    if (state.destroyed) {
        const err = createDestroyedError();
        if (callback) deferTick(() => callback(err));
        return false;
    }

    /* Write-after-end DOES surface as 'error' in node, but by way of
     * errorOrDestroy(): the stream is destroyed with the error, which emits it
     * once and only if the stream was still alive. A stream that already
     * auto-destroyed after 'finish' therefore reports to the callback alone. */
    if (state.ended) {
        const err = createWriteAfterEndError();
        if (callback) deferTick(() => callback(err));
        this.destroy(err);
        return false;
    }

    if (chunk === null) throw createNullWriteError();
    if (!state.objectMode && typeof chunk !== 'string' && !ArrayBuffer.isView(chunk)) {
        throw createInvalidChunkError(chunk);
    }

    if (!state.objectMode && state.decodeStrings && typeof chunk === 'string') {
        chunk = Buffer.from(chunk, writeEncoding ?? state.defaultEncoding);
        writeEncoding = 'binary';
    } else if (!state.objectMode && ArrayBuffer.isView(chunk) && !(chunk instanceof Buffer)) {
        chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        writeEncoding = 'binary';
    }

    state.buffer.push({ chunk, encoding: writeEncoding ?? 'utf8', callback: callback ?? (() => {}) });
    updateWritableLength(this);

    if (!state.writing && state.corked === 0) {
        this._writeBuffered();
    }

    const ok = this.writableLength < state.highWaterMark;
    // 'drain' only fires (in _writeBuffered below) if this is armed — else
    // a paused pipe() source waits forever for a 'drain' that never comes.
    if (!ok) {
        state.awaitDrain = 1;
        this.writableNeedDrain = true;
    }
    return ok;
};

Writable.prototype._writeBuffered = function _writeBuffered(this: Writable): void {
    const state = this._writableState;
    if (state.writing || state.buffer.length === 0 || state.corked > 0) return;

    state.writing = true;
    const useWritev = state.buffer.length > 1 && typeof this._writev === 'function';
    const count = useWritev ? state.buffer.length : 1;
    const entries = state.buffer.slice(0, count);

    let called = false;
    let synchronous = true;
    const onWrite = (err?: Error | null) => {
        if (called) return;
        called = true;
        state.writing = false;
        state.buffer.splice(0, count);
        updateWritableLength(this);

        if (err) {
            const failedEntries = entries.concat(state.buffer.splice(0));
            updateWritableLength(this);
            this.errored = err;
            this.writableAborted = true;
            this.writable = false;
            /* Order measured against node 24: every write callback, then every
             * end callback, then 'error', then 'close'. The teardown therefore
             * runs after the WHOLE queue drains rather than as a member of it. */
            const callbacks = failedEntries.map((entry) => () => entry.callback(err));
            const teardown = () => {
                settleEndCallbacks(this, err);
                writableErrorOrDestroy(this, err);
            };
            if (synchronous) {
                // First failure owns the teardown; later ones reuse its error.
                state.errorTeardown ??= teardown;
                queueSynchronousWriteCallbacks(this, callbacks);
            } else {
                for (const callback of callbacks) callback();
                teardown();
            }
            return;
        }

        const callbacks = entries.map((entry) => () => entry.callback());
        if (synchronous) queueSynchronousWriteCallbacks(this, callbacks);

        if (state.buffer.length > 0) {
            this._writeBuffered();
        } else if (state.ended && !state.finished) {
            this._doFinal();
        } else if (state.awaitDrain > 0) {
            if (synchronous) {
                state.pendingDrain = true;
            } else {
                state.awaitDrain = 0;
                this.writableNeedDrain = false;
                this.emit('drain');
            }
        }

        if (!synchronous) for (const callback of callbacks) callback();
    };

    try {
        if (useWritev) {
            this._writev!(entries.map(({ chunk, encoding }) => ({ chunk, encoding })), onWrite);
        } else {
            const entry = entries[0];
            this._write(entry.chunk, entry.encoding, onWrite);
        }
    } catch (err) {
        onWrite(asError(err));
    }
    synchronous = false;
};

Writable.prototype._doFinal = function _doFinal(this: Writable): void {
    const state = this._writableState;
    if (state.finished || state.finalCalled) return;
    state.finalCalled = true;

    const finish = () => {
        if (state.finished || state.finishScheduled) return;
        state.finishScheduled = true;
        queueMicrotask(() => {
            state.finishScheduled = false;
            if (state.finished) return;
            /* node's needFinish() requires !errored && !destroyed, so a stream
             * that failed or was torn down NEVER emits 'finish'. Without this
             * guard a failed fs WriteStream emitted error>close>finish and
             * reported writableFinished:true — a false success signal — because
             * the fs layer calls back cleanly once an open failure is already
             * reported. */
            if (state.destroyed || this.errored) return;
            state.finished = true;
            this.writableFinished = true;
            this.writable = false;
            // node settles the end callback just BEFORE 'finish', not after.
            settleEndCallbacks(this, null);
            this.emit('finish');
            maybeAutoDestroy(this);
        });
    };

    if (this._final) {
        let called = false;
        const onFinal = (err?: Error | null) => {
            if (called) return;
            called = true;
            if (err) {
                /* A _final error is a stream error: node destroys, which emits
                 * 'error' then 'close' and only THEN settles the end callback
                 * (measured: error>close>endcb:F). Note this is the opposite
                 * order from a failed write, where node settles the end callback
                 * BEFORE 'error' — so the two paths cannot share one helper. */
                writableErrorOrDestroy(this, err);
            } else {
                finish();
            }
        };
        try {
            this._final(onFinal);
        } catch (err) {
            onFinal(asError(err));
        }
    } else {
        finish();
    }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(this: Writable, encoding: BufferEncoding): Writable {
    this._writableState.defaultEncoding = encoding;
    return this;
};

/* Node reports end()-after-teardown through the end callback and nowhere else:
 * ERR_STREAM_ALREADY_FINISHED / ERR_STREAM_DESTROYED never reach 'error'
 * (verified against node 24 with no 'error' listener attached — the process
 * survives). So these are delivered to the callback only. */
function createAlreadyFinishedError(): Error & { code: string } {
    return Object.assign(new Error('Cannot call end after a stream was finished'), {
        code: 'ERR_STREAM_ALREADY_FINISHED',
    });
}

function createEndAfterDestroyError(): Error & { code: string } {
    return Object.assign(new Error('Cannot call end after a stream was destroyed'), {
        code: 'ERR_STREAM_DESTROYED',
    });
}

Writable.prototype.end = function end(
    this: Writable,
    chunk?: unknown,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void
): Writable {
    if (typeof chunk === 'function') {
        callback = chunk as () => void;
        chunk = null;
        encoding = undefined;
    } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
    }

    const state = this._writableState;
    const endCallback = callback as ((error?: Error | null) => void) | undefined;

    /* Node resolves ONE error for the whole call and reports it to the end
     * callback and nowhere else, in a fixed precedence: a rejected write wins,
     * then an already-*finished* stream, then a *destroyed* one. Testing
     * destroyed first (as this did) dropped the callback entirely for the
     * commonest shape — a second end() on a stream that finished and then
     * auto-destroyed — because `finished` implies `destroyed` under the default
     * autoDestroy:true, so the no-chunk destroyed branch swallowed it. */
    let err: (Error & { code: string }) | undefined;

    if (chunk !== null && chunk !== undefined) {
        /* write() rejects a torn-down stream itself and performs the matching
         * destroy()/'error' side effects, but reports only to a *write*
         * callback; node surfaces the same error on the end callback. Its order
         * is write-after-end before destroyed, so a finished-then-destroyed
         * stream reports ERR_STREAM_WRITE_AFTER_END, not ERR_STREAM_DESTROYED. */
        if (state.ended) err = createWriteAfterEndError();
        else if (state.destroyed) err = createDestroyedError();
        this.write(chunk, typeof encoding === 'string' ? encoding : undefined);
    }

    if (!err && !this.errored && !state.ended) {
        state.ended = true;
        this.writableEnded = true;

        // Node hands the end callback an explicit `null` on the success path.
        // Registering it here (rather than on 'finish') is what lets an error or
        // a destroy settle it — a stream that fails never emits 'finish', so a
        // 'finish'-only arm parks the callback forever.
        if (endCallback) state.endCallbacks.push(endCallback);

        // Node: `.end()` fully uncorks regardless of nesting depth. Without this a
        // corked stream drops its buffer and never emits 'finish', so finished()
        // and pipeline() on it hang forever.
        if (state.corked) {
            state.corked = 1;
            this.uncork();
        }

        /* A destroyed stream never emits 'finish' (node's needFinish() requires
         * !destroyed), so the callback armed above is deliberately left parked
         * rather than settled. */
        if (!state.destroyed && !state.writing && state.buffer.length === 0) {
            this._doFinal();
        }

        return this;
    }

    if (!err) {
        if (state.finished) err = createAlreadyFinishedError();
        else if (state.destroyed) err = createEndAfterDestroyError();
    }

    if (endCallback) {
        /* No error and still draining: node waits for 'finish' and reports
         * success (measured — a second end() over a slow write settles with
         * null once the first one completes). */
        if (err) deferTick(() => endCallback(err));
        else state.endCallbacks.push(endCallback);
    }

    return this;
};

Writable.prototype.cork = function cork(this: Writable): void {
    this._writableState.corked++;
    this.writableCorked = this._writableState.corked;
};

Writable.prototype.uncork = function uncork(this: Writable): void {
    const state = this._writableState;
    if (state.corked > 0) {
        state.corked--;
        this.writableCorked = state.corked;
        if (state.corked === 0) this._writeBuffered();
    }
};

Writable.prototype._write = function _write(this: Writable, chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    throw new Error('_write() must be implemented');
};

Writable.prototype.destroy = function destroy(this: Writable, error?: Error | null): Writable {
    const state = this._writableState;
    if (state.destroyed) return this;
    state.destroyed = true;
    this.destroyed = true;
    this.writableAborted = !this.writableFinished;
    this.writable = false;
    if (error) this.errored = error;
    /* A pending end callback must be settled by the teardown, with the destroy
     * error when there is one. It used to be armed on 'finish', which a
     * destroyed stream never emits: node reports error>close>endcb:<err>, while
     * this reported endcb:null (a false success) or nothing at all. */
    const hadEndCallbacks = state.endCallbacks.length > 0;
    const settleError = error ?? createEndAfterDestroyError();
    runStreamDestroy(this, error, [state], hadEndCallbacks
        ? () => settleEndCallbacks(this, settleError)
        : undefined);
    return this;
};

Object.defineProperty(Writable.prototype, 'closed', {
    get(this: Writable): boolean { return this._writableState.closed; },
    enumerable: false,
    configurable: true,
});

Object.defineProperty(Writable.prototype, 'constructor', {
    value: Writable,
    writable: true,
    configurable: true,
});

flattenPrototype(Writable.prototype);

export interface Duplex extends Writable {
    allowHalfOpen: boolean;
    readable: boolean;
    readableEnded: boolean;
    readableFlowing: boolean | null;
    readableHighWaterMark: number;
    readableLength: number;
    readableObjectMode: boolean;
    readableEncoding: BufferEncoding | null;
    readableAborted: boolean;
    readableDidRead: boolean;
    _readableState: ReadableState;
    _read(size: number): void;
    _emitReadableEndIfNeeded(): void;
    _duplexReadAndResolve(): void;
    read(n?: number): unknown;
    setEncoding(enc: BufferEncoding): this;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    unpipe(destination?: Writable): this;
    unshift(chunk: unknown, encoding?: BufferEncoding): boolean;
    push(chunk: unknown, encoding?: BufferEncoding): boolean;
    toArray(options?: StreamIteratorOptions): Promise<unknown[]>;
    map(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Readable;
    filter(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Readable;
    flatMap(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Readable;
    take(count: number, options?: StreamIteratorOptions): Readable;
    drop(count: number, options?: StreamIteratorOptions): Readable;
    forEach(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Promise<void>;
    reduce(reducer: StreamReducer, initialValue?: unknown, options?: StreamIteratorOptions): Promise<unknown>;
    some(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Promise<boolean>;
    every(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Promise<boolean>;
    find(fn: StreamIteratorCallback, options?: StreamIteratorOptions): Promise<unknown>;
    iterator(options?: { destroyOnReturn?: boolean }): AsyncIterableIterator<unknown>;
    compose(stream: unknown, options?: StreamIteratorOptions): Duplex;
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
}

export interface DuplexConstructor {
    new (options?: DuplexOptions): Duplex;
    (options?: DuplexOptions): Duplex;
    prototype: Duplex;
    fromSource(source: Iterable<unknown> | AsyncIterable<unknown>): Duplex;
    from(body: unknown): Duplex;
}

function initDuplex(self: Duplex, options?: DuplexOptions): void {
    Writable.call(self, options);
    self.readable = options?.readable ?? true;
    self.writable = options?.writable ?? true;
    self.allowHalfOpen = options?.allowHalfOpen ?? true;
    self.readableEnded = false;
    self.readableObjectMode = !!(options?.objectMode || options?.readableObjectMode);
    self.readableHighWaterMark = options?.highWaterMark
        ?? options?.readableHighWaterMark
        ?? defaultHighWaterMark(self.readableObjectMode);
    self.readableLength = 0;
    self.readableEncoding = options?.encoding ?? null;
    self.readableAborted = false;
    self.readableDidRead = false;
    self._readableState = {
        buffer: [],
        encoding: options?.encoding ?? null,
        objectMode: self.readableObjectMode,
        highWaterMark: self.readableHighWaterMark,
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

    if (options?.readable === false) {
        self.readableEnded = true;
        self._readableState.ended = true;
        self._readableState.endEmitted = true;
    }
    if (options?.writable === false) {
        self.writableEnded = true;
        self.writableFinished = true;
        self._writableState.ended = true;
        self._writableState.finished = true;
    }

    if (options?.read) {
        self._read = options.read;
    }
    if (options?.destroy) {
        self._destroy = options.destroy;
    }
}

export const Duplex: DuplexConstructor = function Duplex(this: Duplex | undefined, options?: DuplexOptions) {
    const target = isConstructCallTarget(this, Duplex.prototype)
        ? this
        : Object.create(Duplex.prototype);
    initDuplex(target, options);
    return target;
} as DuplexConstructor;

Object.setPrototypeOf(Duplex, Writable);
Duplex.prototype = Object.create(Writable.prototype);

Duplex.prototype.read = function read(this: Duplex, n?: number): unknown {
    /* Gates on `destroyed`, NOT on the public `readable` flag: Node's read()
     * never consults it, and net's EOF handler clears `socket.readable` right
     * after push(null) while chunks are still buffered. Refusing those made a
     * 'readable' + read() consumer see an empty body and no 'end' at all. */
    if (this._readableState.destroyed) return null;
    return readReadableData(this, n);
};

Duplex.prototype.setEncoding = function setEncoding(this: Duplex, enc: BufferEncoding): Duplex {
    this.readableEncoding = enc;
    const state = this._readableState;
    state.encoding = enc;
    state.decoder = new StringDecoder(enc);
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
    updateReadableLength(this);
    return this;
};

Duplex.prototype.pause = function pause(this: Duplex): Duplex {
    if (!this.readable) return this;
    const state = this._readableState;
    if (state.flowing !== false) {
        state.flowing = false;
        this.emit('pause');
    }
    return this;
};

Duplex.prototype.resume = function resume(this: Duplex): Duplex {
    if (!this.readable) return this;
    const state = this._readableState;
    if (state.readableListening && this.listenerCount('data') === 0) {
        this.emit('resume');
        invokeReadableRead(this);
        return this;
    }
    if (!state.flowing) {
        state.flowing = true;
        this.emit('resume');
        // Same deferral as Readable.prototype.resume — see comment there.
        scheduleReadableFlow(this, () => this._duplexReadAndResolve());
    } else {
        scheduleReadableFlow(this, () => this._duplexReadAndResolve());
    }
    return this;
};

Duplex.prototype.on = function on(this: Duplex, event: string | symbol, fn: StreamListener): Duplex {
    Writable.prototype.on.call(this, event, fn);
    if (event === 'data') this.resume();
    if (event === 'readable') {
        const state = this._readableState;
        state.readableListening = true;
        // Node parks the stream in paused mode when a 'readable' listener is
        // attached, overriding an earlier flowing=true, so isPaused() and
        // readableFlowing report false rather than null/true.
        state.flowing = false;
        if (state.buffer.length > 0 || state.ended) scheduleReadableEmit(this);
        else invokeReadableRead(this);
    }
    return this;
};

Duplex.prototype.once = function once(this: Duplex, event: string | symbol, fn: StreamListener): Duplex {
    Writable.prototype.once.call(this, event, fn);
    if (event === 'data') this.resume();
    if (event === 'readable') {
        const state = this._readableState;
        state.readableListening = true;
        // Node parks the stream in paused mode when a 'readable' listener is
        // attached, overriding an earlier flowing=true, so isPaused() and
        // readableFlowing report false rather than null/true.
        state.flowing = false;
        if (state.buffer.length > 0 || state.ended) scheduleReadableEmit(this);
        else invokeReadableRead(this);
    }
    return this;
};

Duplex.prototype.removeListener = function removeListener(this: Duplex, event: string | symbol, fn: StreamListener): Duplex {
    Writable.prototype.removeListener.call(this, event, fn);
    if (event === 'readable' && this.listenerCount('readable') === 0) {
        this._readableState.readableListening = false;
    }
    return this;
};

Duplex.prototype.off = Duplex.prototype.removeListener;

Duplex.prototype.removeAllListeners = function removeAllListeners(this: Duplex, event?: string | symbol): Duplex {
    Writable.prototype.removeAllListeners.call(this, event);
    if (event === undefined || event === 'readable') {
        this._readableState.readableListening = false;
    }
    return this;
};

Duplex.prototype._emitReadableEndIfNeeded = function _emitReadableEndIfNeeded(this: Duplex): void {
    const state = this._readableState;
    if (!state.ended || state.endEmitted || state.buffer.length > 0) return;
    state.endEmitted = true;
    this.readableEnded = true;
    this.readable = false;
    // Deferred for the same reason as the Readable copy above.
    deferTick(() => {
        this.emit('end');
        if (!this.allowHalfOpen && !this.writableEnded) queueMicrotask(() => this.end());
        maybeAutoDestroy(this);
    });
};

Duplex.prototype._duplexReadAndResolve = function _duplexReadAndResolve(this: Duplex): void {
    const state = this._readableState;
    if (state.destroyed || !state.flowing) return;

    while (!state.destroyed && state.flowing && state.buffer.length > 0) {
        let chunk = state.buffer.shift();
        state.disturbed = true;
        this.readableDidRead = true;
        subtractReadableLength(this, readableChunkLength(state, chunk));
        this.emit('data', chunk);
    }

    if (state.ended) {
        this._emitReadableEndIfNeeded();
        return;
    }

    invokeReadableRead(this);
};

Duplex.prototype.isPaused = function isPaused(this: Duplex): boolean {
    return this._readableState.flowing === false;
};

Object.defineProperty(Duplex.prototype, 'readableFlowing', {
    get(this: Duplex): boolean | null { return this._readableState.flowing; },
    set(this: Duplex, v: boolean | null) { this._readableState.flowing = v; },
    enumerable: true,
    configurable: true,
});

Duplex.prototype.unpipe = function unpipe(this: Duplex, destination?: Writable): Duplex {
    // Same helper as Readable.prototype.unpipe — see the comment there for why
    // the source has to be paused.
    unpipeDestinations(this, destination);
    return this;
};

Duplex.prototype.unshift = function unshift(this: Duplex, chunk: unknown, encoding?: BufferEncoding): boolean {
    return unshiftReadableChunk(this, chunk, encoding);
};

Duplex.prototype.push = function push(this: Duplex, chunk: unknown, encoding?: BufferEncoding): boolean {
    if (!this.readable) return false;
    const state = this._readableState;
    if (state.destroyed) return false;
    state.reading = false;

    let decodedTrailing = false;
    const ending = chunk === null;
    if (ending) {
        state.ended = true;
        if (state.decoder) {
            const trailing = state.decoder.end();
            if (trailing) {
                chunk = trailing;
                decodedTrailing = true;
            } else {
                // See the Readable copy: without this, setEncoding() plus a
                // 'readable' listener never reaches 'end'.
                if (!state.flowing && state.readableListening) this.emit('readable');
                if (state.flowing) this._emitReadableEndIfNeeded();
                return false;
            }
        } else {
            if (!state.flowing && state.readableListening) this.emit('readable');
            if (state.flowing) this._emitReadableEndIfNeeded();
            return false;
        }
    }

    if (!state.objectMode && chunk === undefined) return true;
    if (!state.objectMode && typeof chunk !== 'string' && !ArrayBuffer.isView(chunk)) {
        this.destroy(createInvalidChunkError(chunk));
        return false;
    }
    if (!state.objectMode && !ending && readableChunkLength(state, chunk) === 0) {
        return this.readableLength < state.highWaterMark;
    }

    if (!decodedTrailing) chunk = normalizeChunk(chunk, state.objectMode, encoding, state.defaultEncoding);
    const bytes = decoderBytes(chunk);
    if (!decodedTrailing && state.decoder && bytes) {
        const decoded = state.decoder.write(bytes);
        if (decoded.length === 0) return updateReadableLength(this) < state.highWaterMark;
        chunk = decoded;
    }

    if (state.flowing && !state.readableListening) {
        state.disturbed = true;
        this.readableDidRead = true;
        this.emit('data', chunk);
        if (!state.destroyed) scheduleReadableFlow(this, () => this._duplexReadAndResolve());
    } else {
        state.buffer.push(chunk);
        addReadableLength(this, chunk);
    }
    if (!state.flowing) scheduleReadableEmit(this);
    return ending ? false : this.readableLength < state.highWaterMark;
};

Duplex.prototype._read = function _read(this: Duplex, size: number): void {
    throw new Error('_read() is not implemented');
};

Duplex.fromSource = function fromSource(source: Iterable<unknown> | AsyncIterable<unknown>): Duplex {
    if (isAsyncIterable(source)) {
        const duplex = new Duplex({
            read() {},
            write(chunk, encoding, cb) { cb(); },
        });
        (async () => {
            try {
                for await (const chunk of source) {
                    if (!duplex.push(chunk)) break;
                }
                duplex.push(null);
            } catch (err) {
                duplex.destroy(asError(err));
            }
        })();
        return duplex;
    }
    if (isIterable(source)) {
        const duplex = new Duplex({
            read() {},
            write(chunk, encoding, cb) { cb(); },
        });
        for (const chunk of source) {
            if (!duplex.push(chunk)) break;
        }
        duplex.push(null);
        return duplex;
    }
    return new Duplex();
};

function collectReadableToArray(stream: Readable | Duplex): Promise<unknown[]> {
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

Duplex.prototype.toArray = function toArray(this: Duplex): Promise<unknown[]> {
    return collectReadableToArray(this);
};

Duplex.prototype.destroy = function destroy(this: Duplex, error?: Error | null): Duplex {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readableAborted = !this.readableEnded;
    this.writableAborted = !this.writableFinished;
    this.readable = false;
    this.writable = false;
    const state = this._readableState;
    const writableState = this._writableState;
    state.destroyed = true;
    writableState.destroyed = true;
    state.buffer.length = 0;
    this.readableLength = 0;
    if (error) this.errored = error;
    runStreamDestroy(this, error, [writableState, state]);
    return this;
};

Object.defineProperty(Duplex.prototype, 'closed', {
    get(this: Duplex): boolean {
        return this._writableState.closed || this._readableState.closed;
    },
    enumerable: false,
    configurable: true,
});

(Duplex.prototype as Duplex & Record<symbol, unknown>)[Symbol.asyncIterator] = Readable.prototype[Symbol.asyncIterator];

Object.defineProperty(Duplex.prototype, 'constructor', {
    value: Duplex,
    writable: true,
    configurable: true,
});

flattenPrototype(Duplex.prototype);

export interface Transform extends Duplex {
    _transform(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void): void;
    _flush?(callback: (error?: Error | null, data?: unknown) => void): void;
}

export interface TransformConstructor {
    new (options?: TransformOptions): Transform;
    (options?: TransformOptions): Transform;
    prototype: Transform;
}

function initTransform(self: Transform, options?: TransformOptions): void {
    Duplex.call(self, options);
    if (options?.transform) {
        self._transform = options.transform;
    }
    if (options?.flush) {
        self._flush = options.flush;
    }
}

export const Transform: TransformConstructor = function Transform(this: Transform | undefined, options?: TransformOptions) {
    const target = isConstructCallTarget(this, Transform.prototype)
        ? this
        : Object.create(Transform.prototype);
    initTransform(target, options);
    return target;
} as TransformConstructor;

Object.setPrototypeOf(Transform, Duplex);
Transform.prototype = Object.create(Duplex.prototype);

Transform.prototype._transform = function _transform(
    this: Transform,
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: unknown) => void
): void {
    throw new Error('_transform() must be implemented');
};

/* Node parks the write callback of a transform whose push() filled the readable
 * side, and only releases it from _read() once a consumer has drained. Without
 * that, write() reports `true` forever and the readable buffer grows without
 * bound (measured at 25x highWaterMark). Held off the instance so it cannot
 * collide with a subclass field, and off _writableState so flattenPrototype and
 * the shared state shape stay untouched. */
const transformPendingWriteCallbacks = new WeakMap<object, (error?: Error | null) => void>();

/* Release a parked callback. Node's Transform.prototype._read does exactly this
 * and nothing else: the readable output of a transform is produced by writes,
 * not by pulls, so the only work a read can do is let the next write proceed. */
function releaseTransformWrite(self: Transform): void {
    const pending = transformPendingWriteCallbacks.get(self);
    if (!pending) return;
    transformPendingWriteCallbacks.delete(self);
    pending();
}

Transform.prototype._read = function _read(this: Transform, _size: number): void {
    // A pull is the signal that the readable side made room, so it is what
    // unparks the write callback withheld by _write below. When nothing is
    // parked this stays the no-op it always was: a transform's readable output
    // is driven by writes, so there is nothing else a read could produce.
    releaseTransformWrite(this);
};

Transform.prototype._write = function _write(
    this: Transform,
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
): void {
    const readableState = this._readableState;
    const writableState = this._writableState;
    // Sampled before _transform runs so a transform that pushes nothing (a
    // digest accumulating state, a filter dropping a chunk) is never made to
    // wait for a read that has nothing to consume.
    const lengthBefore = this.readableLength;

    let called = false;
    const onTransform = (err?: Error | null, data?: unknown) => {
        if (called) return;
        called = true;
        if (err) return callback(err);
        // Node's afterTransform tests `val != null`: cb(null, null) pushes
        // nothing. Forwarding null to push() would signal EOF and end the
        // readable side after the very first chunk.
        if (data !== undefined && data !== null) this.push(data);

        if (
            // end() was already called: parking now would strand the writable
            // buffer and 'finish' would never fire.
            writableState.ended
            // Nothing was pushed, so no read can release us.
            || lengthBefore === this.readableLength
            // The readable side still has room.
            || this.readableLength < readableState.highWaterMark
        ) {
            callback();
            return;
        }
        transformPendingWriteCallbacks.set(this, callback);
    };
    try {
        this._transform(chunk, encoding, onTransform);
    } catch (err) {
        onTransform(asError(err));
    }
};

Transform.prototype._final = function _final(this: Transform, callback: (error?: Error | null) => void): void {
    let called = false;
    const done = (err?: Error | null, data?: unknown) => {
        if (called) return;
        called = true;
        if (err) return callback(err);
        if (data !== undefined) this.push(data);
        this.push(null);
        callback();
    };

    if (this._flush) {
        try {
            this._flush(done);
        } catch (err) {
            done(asError(err));
        }
    } else {
        done();
    }
};

Object.defineProperty(Transform.prototype, 'constructor', {
    value: Transform,
    writable: true,
    configurable: true,
});

flattenPrototype(Transform.prototype);

export interface PassThrough extends Transform {}

export interface PassThroughConstructor {
    new (options?: TransformOptions): PassThrough;
    (options?: TransformOptions): PassThrough;
    prototype: PassThrough;
}

export const PassThrough: PassThroughConstructor = function PassThrough(this: PassThrough | undefined, options?: TransformOptions) {
    const target = isConstructCallTarget(this, PassThrough.prototype)
        ? this
        : Object.create(PassThrough.prototype);
    Transform.call(target, options);
    return target;
} as PassThroughConstructor;

Object.setPrototypeOf(PassThrough, Transform);
PassThrough.prototype = Object.create(Transform.prototype);

PassThrough.prototype._transform = function _transform(
    this: PassThrough,
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: unknown) => void
): void {
    callback(null, chunk);
};

Object.defineProperty(PassThrough.prototype, 'constructor', {
    value: PassThrough,
    writable: true,
    configurable: true,
});

flattenPrototype(PassThrough.prototype);

export function isDisturbed(stream: unknown): boolean {
    if (isReadableLike(stream)) {
        return !!stream._readableState.disturbed || stream.readableEnded || stream.readableAborted || stream.destroyed;
    }
    return false;
}

export function isErrored(stream: unknown): boolean {
    if (isReadableLike(stream) || isWritableLike(stream) || stream instanceof Stream) {
        return Reflect.get(stream, 'errored') != null;
    }
    const controller = stream && (typeof stream === 'object' || typeof stream === 'function')
        ? Reflect.get(stream as object, '_controller')
        : undefined;
    if (controller && typeof controller === 'object') return Reflect.get(controller, '_state') === 'errored';
    return false;
}

export function isDestroyed(stream: unknown): boolean | null {
    if (!stream || (typeof stream !== 'object' && typeof stream !== 'function')) return null;
    if (isReadableLike(stream)) return !!stream._readableState.destroyed;
    if (isWritableLike(stream)) return !!stream._writableState.destroyed;
    if (stream instanceof Stream) return !!stream.destroyed;
    return null;
}

export function isReadable(stream: unknown): boolean | null {
    if (isReadableLike(stream)) {
        return stream.readable === true && !stream.readableEnded && !stream.destroyed;
    }
    const controller = stream && (typeof stream === 'object' || typeof stream === 'function')
        ? Reflect.get(stream as object, '_controller')
        : undefined;
    if (controller && typeof controller === 'object' && typeof Reflect.get(stream as object, 'getReader') === 'function') {
        return Reflect.get(controller, '_state') === 'readable';
    }
    return null;
}

export function isWritable(stream: unknown): boolean | null {
    if (isWritableLike(stream)) {
        return stream.writable === true && !stream.writableEnded && !stream.destroyed;
    }
    const controller = stream && (typeof stream === 'object' || typeof stream === 'function')
        ? Reflect.get(stream as object, '_controller')
        : undefined;
    if (controller && typeof controller === 'object' && typeof Reflect.get(stream as object, 'getWriter') === 'function') {
        return Reflect.get(controller, '_state') === 'writable';
    }
    return null;
}

function createAbortError(reason?: unknown): Error & { code: string; cause?: unknown } {
    const error: Error & { code: string; cause?: unknown } = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
    });
    if (reason !== undefined) error.cause = reason;
    return error;
}

function createStreamDestroyedError(): Error & { code: string } {
    return Object.assign(new Error('Cannot call write after a stream was destroyed'), {
        code: 'ERR_STREAM_DESTROYED',
    });
}

export function destroy(stream: unknown, error?: Error | null): void {
    if (stream === null || stream === undefined) return;
    const destroyMethod = Reflect.get(Object(stream), 'destroy');
    const reason = error ?? createAbortError();
    if (typeof destroyMethod === 'function') {
        destroyMethod.call(stream, reason);
        return;
    }
    const emit = Reflect.get(Object(stream), 'emit');
    if (typeof emit === 'function') {
        queueMicrotask(() => {
            emit.call(stream, 'error', reason);
            emit.call(stream, 'close');
        });
    }
}

export function duplexPair(options: DuplexOptions = {}): [Duplex, Duplex] {
    const pendingWrites = new WeakMap<Duplex, Array<(error?: Error | null) => void>>();
    let first: Duplex;
    let second: Duplex;

    const createEndpoint = (peer: () => Duplex): Duplex => new Duplex({
        ...options,
        autoDestroy: false,
        read() {
            const writer = peer();
            const callbacks = pendingWrites.get(writer);
            const callback = callbacks?.shift();
            if (!callback) return;
            if (callbacks && callbacks.length === 0) pendingWrites.delete(writer);
            callback();
        },
        write(chunk, _encoding, callback) {
            const target = peer();
            if (target.destroyed) {
                callback(createStreamDestroyedError());
                return;
            }
            if (target.push(chunk)) callback();
            else {
                const callbacks = pendingWrites.get(this as Duplex) ?? [];
                callbacks.push(callback);
                pendingWrites.set(this as Duplex, callbacks);
            }
        },
        final(callback) {
            const target = peer();
            if (!target.destroyed) target.push(null);
            callback();
        },
    });

    first = createEndpoint(() => second);
    second = createEndpoint(() => first);

    const closeIfComplete = () => {
        const complete = first.readableEnded && first.writableFinished
            && second.readableEnded && second.writableFinished;
        if (!complete) return;
        if (!first.destroyed) first.destroy();
        if (!second.destroyed) second.destroy();
    };
    first.on('end', closeIfComplete);
    first.on('finish', closeIfComplete);
    second.on('end', closeIfComplete);
    second.on('finish', closeIfComplete);

    const firstDestroy = first.destroy;
    const secondDestroy = second.destroy;
    const abortPendingWrites = () => {
        for (const endpoint of [first, second]) {
            const callbacks = pendingWrites.get(endpoint);
            if (!callbacks) continue;
            pendingWrites.delete(endpoint);
        }
    };
    // Node propagates an errored destroy() to the opposite endpoint, but on a
    // later tick and without re-emitting the error there (the peer only sees
    // 'close'). A plain destroy() with no error does not touch the peer at all.
    const destroyPeerLater = (peer: Duplex, peerDestroy: Duplex['destroy']) => {
        process.nextTick(() => {
            if (!peer.destroyed) peerDestroy.call(peer);
        });
    };
    first.destroy = function destroyFirst(error?: Error | null): Duplex {
        const completed = first.readableEnded && first.writableFinished;
        const result = firstDestroy.call(first, error);
        if (!completed) abortPendingWrites();
        if (!completed && error) destroyPeerLater(second, secondDestroy);
        return result;
    };
    second.destroy = function destroySecond(error?: Error | null): Duplex {
        const completed = second.readableEnded && second.writableFinished;
        const result = secondDestroy.call(second, error);
        if (!completed) abortPendingWrites();
        if (!completed && error) destroyPeerLater(first, firstDestroy);
        return result;
    };

    return [first, second];
}

export function compose(...streams: Array<Duplex | Readable | Writable>): Duplex {
    if (streams.length < 2) throw new TypeError('compose requires at least two streams');
    for (let i = 0; i < streams.length - 1; i++) {
        const src = streams[i];
        const dst = streams[i + 1];
        if (!isWritableLike(dst)) {
            throw new TypeError('compose destination must be writable');
        }
        src.pipe(dst);
        src.on('error', (err: Error) => {
            if (!dst.destroyed) dst.destroy(err);
        });
    }

    const first = streams[0];
    const last = streams[streams.length - 1];
    if (!isWritableLike(first)) {
        throw new TypeError('compose first stream must be writable');
    }
    const composed = new Duplex({
        read() {},
        write(chunk, encoding, callback) {
            const ok = first.write(chunk, encoding);
            if (!ok && typeof first.once === 'function') {
                first.once('drain', () => callback());
                return;
            }
            callback();
        },
        final(callback) {
            first.end();
            callback();
        },
    });

    last.on('data', (chunk: unknown) => {
        composed.push(chunk);
    });
    last.on('end', () => {
        composed.push(null);
    });
    last.on('error', (err: Error) => {
        composed.destroy(err);
    });

    return composed;
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

export function ReadableFrom(iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: ReadableOptions): Readable {
    return Readable.from(iterable, options);
}

export function addAbortSignal(signal: AbortSignal, stream: Stream): Stream {
    if (signal.aborted) {
        stream.destroy(createAbortError(signal.reason));
    } else {
        signal.addEventListener('abort', () => {
            stream.destroy(createAbortError(signal.reason));
        });
    }
    return stream;
}

/* Iterator helpers (map/filter/forEach/reduce/some/every/find/take/drop/flatMap/
 * iterator/compose) plus Duplex.from. Installed last, after every
 * flattenPrototype() call above: flatten copies parent properties down as own
 * properties, so installing earlier would leave Duplex.prototype holding a stale
 * copy of Readable's version rather than sharing one implementation.
 * Transform/PassThrough need no separate install — their prototypes are
 * Object.create(Duplex.prototype), and flatten never severs that chain, so they
 * inherit these through it. */
installStreamOperators({
    readableFrom: (src, options) => Readable.from(
        src,
        options as ReadableOptions | undefined,
    ) as unknown as OperatorStreamLike,
    makeDuplex: (options) => new Duplex(options as DuplexOptions) as unknown as OperatorStreamLike,
    isReadableLike,
    isWritableLike,
    asError,
    readablePrototype: Readable.prototype,
    duplexPrototype: Duplex.prototype,
    duplexConstructor: Duplex as unknown as { from?: unknown },
    asyncIteratorFactory: Readable.prototype[Symbol.asyncIterator] as unknown as
        (this: OperatorStreamLike) => AsyncIterableIterator<unknown>,
});
