import { EventEmitter } from '../events';
import { StringDecoder } from '../string_decoder';

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
}

export interface WritableOptions extends StreamOptions {
    write?: (chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) => void;
    writev?: (chunks: Array<{ chunk: unknown; encoding: BufferEncoding }>, callback: (error?: Error | null) => void) => void;
    final?: (callback: (error?: Error | null) => void) => void;
}

export interface DuplexOptions extends ReadableOptions, WritableOptions {
    allowHalfOpen?: boolean;
    readable?: boolean;
    writable?: boolean;
}

export interface TransformOptions extends DuplexOptions {
    transform?: (chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void) => void;
    flush?: (callback: (error?: Error | null, data?: unknown) => void) => void;
}

export interface PipeOptions {
    end?: boolean;
}

function isAsyncIterable(value: Iterable<unknown> | AsyncIterable<unknown>): value is AsyncIterable<unknown> {
    return typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
}

function isIterable(value: Iterable<unknown> | AsyncIterable<unknown>): value is Iterable<unknown> {
    return typeof Reflect.get(value, Symbol.iterator) === 'function';
}

function normalizeChunk(chunk: unknown, objectMode: boolean, encoding: BufferEncoding | undefined, defaultEncoding: BufferEncoding): unknown {
    if (objectMode || chunk === null) return chunk;
    if (typeof chunk === 'string') return Buffer.from(chunk, encoding || defaultEncoding);
    if (chunk instanceof Uint8Array && !(chunk instanceof Buffer)) return Buffer.from(chunk);
    return chunk;
}

function createWriteAfterEndError(): Error & { code: string } {
    return Object.assign(new Error('write after end'), {
        code: 'ERR_STREAM_WRITE_AFTER_END',
    });
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
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

export interface Stream extends EventEmitter {
    destroyed: boolean;
    _pipedDestinations: Writable[];
    pipe<T extends Writable>(destination: T, options?: PipeOptions): T;
    destroy(error?: Error | null): this;
}

export interface StreamConstructor {
    new (): Stream;
    (): Stream;
    prototype: Stream;
}

function initStream(self: Stream): void {
    EventEmitter.call(self);
    if (typeof self.destroyed !== 'boolean') self.destroyed = false;
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

    return destination;
};

Stream.prototype.destroy = function destroy(this: Stream, error?: Error | null): Stream {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) {
        this.emit('error', error);
    }
    this.emit('close');
    return this;
};

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
};

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

function invokeReadableRead(target: { _readableState: ReadableState; _read(size: number): void; emit(event: string, error: unknown): void }): void {
    const state = target._readableState;
    if (state.destroyed || (!state.flowing && !state.readableListening) || state.ended || state.reading) return;
    state.reading = true;
    try {
        target._read(state.highWaterMark);
    } catch (err) {
        state.reading = false;
        target.emit('error', err);
    }
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
        if (decoded.length === 0) return state.buffer.length < state.highWaterMark;
        chunk = decoded;
    }
    state.buffer.unshift(chunk);
    stream.readableLength = state.buffer.length;
    if (!state.flowing || state.readableListening) stream.emit('readable');
    return state.buffer.length < state.highWaterMark;
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
    toArray(): Promise<unknown[]>;
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
    self.readableFlowing = null;
    self.readableObjectMode = options?.objectMode ?? false;
    self.readableHighWaterMark = options?.highWaterMark ?? defaultHighWaterMark(self.readableObjectMode);
    self.readableLength = 0;
    self.readableEncoding = null;
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
        decoder: null,
        disturbed: false,
    };

    if (options?.read) {
        self._read = options.read;
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
        if (state.buffer.length > 0 || state.ended) this.emit('readable');
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
        if (state.buffer.length > 0 || state.ended) this.emit('readable');
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
    this.emit('end');
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
    readable._read = async () => {
        if (reading || ended) return;
        reading = true;
        try {
            const { value, done } = await iterator.next();
            if (done) {
                ended = true;
                readable.push(null);
            } else {
                readable.push(value);
            }
        } catch (err) {
            readable.destroy(err instanceof Error ? err : new Error(String(err)));
        } finally {
            reading = false;
        }
    };

    return readable;
};

Readable.prototype.read = function read(this: Readable, n?: number): unknown {
    const state = this._readableState;

    if (state.buffer.length === 0) {
        if (state.ended) {
            this._emitReadableEndIfNeeded();
            return null;
        }
        state.needReadable = true;
        return null;
    }

    const chunk = state.buffer.shift();
    state.disturbed = true;
    this.readableDidRead = true;
    this.readableLength = state.buffer.length;
    emitDataAfterRead(this, chunk);

    this._emitReadableEndIfNeeded();

    return chunk;
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
    state.buffer = decoded;
    this.readableLength = state.buffer.length;
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
        this.readableLength = state.buffer.length;
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

Readable.prototype.unpipe = function unpipe(this: Readable, destination?: Writable): Readable {
    const destinations = destination ? [destination] : [...this._pipedDestinations];
    for (const dest of destinations) {
        const cleanups = (dest as PipeTrackedWritable).__pipeCleanups;
        const entry = cleanups?.find(item => item.source === this);
        if (entry) {
            entry.cleanup(true);
        } else {
            const idx = this._pipedDestinations.indexOf(dest);
            if (idx !== -1) this._pipedDestinations.splice(idx, 1);
        }
    }
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

    if (chunk === null) {
        if (state.decoder) {
            const trailing = state.decoder.end();
            state.decoder = null;
            if (trailing) {
                chunk = trailing;
            } else {
                state.ended = true;
                if (state.flowing) this._emitReadableEndIfNeeded();
                return false;
            }
        } else {
            state.ended = true;
            if (!state.flowing && state.readableListening) this.emit('readable');
            if (state.flowing) this._emitReadableEndIfNeeded();
            return false;
        }
    }

    chunk = normalizeChunk(chunk, state.objectMode, encoding, state.defaultEncoding);
    const bytes = decoderBytes(chunk);
    if (state.decoder && bytes) {
        const decoded = state.decoder.write(bytes);
        if (decoded.length === 0) return state.buffer.length < state.highWaterMark;
        chunk = decoded;
    }

    if (state.flowing && !state.readableListening) {
        state.disturbed = true;
        this.readableDidRead = true;
        this.emit('data', chunk);
        if (!state.destroyed) scheduleReadableFlow(this, () => this._readAndResolve());
        return state.buffer.length < state.highWaterMark;
    }

    state.buffer.push(chunk);
    this.readableLength = state.buffer.length;
    this.emit('readable');

    return state.buffer.length < state.highWaterMark;
};

Readable.prototype._read = function _read(this: Readable, size: number): void {
    throw new Error('_read() must be implemented');
};

Readable.prototype.destroy = function destroy(this: Readable, error?: Error | null): Readable {
    const state = this._readableState;
    if (state.destroyed) return this;
    state.destroyed = true;
    this.destroyed = true;
    state.buffer.length = 0;
    this.readableLength = 0;
    if (error) {
        this.emit('error', error);
    }
    this.emit('close');
    return this;
};

Readable.prototype.toArray = function toArray(this: Readable): Promise<unknown[]> {
    return collectReadableToArray(this);
};

Readable.prototype[Symbol.asyncIterator] = function asyncIterator(this: Readable): AsyncIterableIterator<unknown> {
    const readable = this;
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next() {
            const buffered = readable.read();
            if (buffered !== null) {
                readable.pause();
                return { done: false, value: buffered };
            }
            if (readable.readableEnded) {
                return { done: true, value: undefined };
            }
            return new Promise((resolve, reject) => {
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
                const cleanup = () => {
                    readable.off('data', onData);
                    readable.off('end', onEnd);
                    readable.off('error', onError);
                };

                readable.on('data', onData);
                readable.on('end', onEnd);
                readable.on('error', onError);
                readable.resume();
            });
        },
        async return() {
            readable.pause();
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
    finalCalled: boolean;
    decodeStrings: boolean;
    defaultEncoding: BufferEncoding;
    destroyed: boolean;
    awaitDrain: number;
    emitClose: boolean;
    autoDestroy: boolean;
};

export interface Writable extends Stream {
    writable: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    writableHighWaterMark: number;
    writableLength: number;
    writableObjectMode: boolean;
    writableCorked: number;
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

function initWritable(self: Writable, options?: WritableOptions): void {
    Stream.call(self);
    self.writable = true;
    self.writableEnded = false;
    self.writableFinished = false;
    self.writableObjectMode = options?.objectMode ?? false;
    self.writableHighWaterMark = options?.highWaterMark ?? defaultHighWaterMark(self.writableObjectMode);
    self.writableLength = 0;
    self.writableCorked = 0;
    self._writableState = {
        objectMode: self.writableObjectMode,
        highWaterMark: self.writableHighWaterMark,
        buffer: [],
        writing: false,
        corked: 0,
        ended: false,
        finished: false,
        finalCalled: false,
        decodeStrings: true,
        defaultEncoding: 'utf8',
        destroyed: false,
        awaitDrain: 0,
        emitClose: options?.emitClose ?? true,
        autoDestroy: options?.autoDestroy ?? false,
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

    if (state.ended) {
        const err = createWriteAfterEndError();
        callback?.(err);
        queueMicrotask(() => this.emit('error', err));
        return false;
    }

    if (chunk === null && !state.objectMode) {
        throw new TypeError('May not write null values to stream');
    }

    if (!state.objectMode && state.decodeStrings && typeof chunk === 'string') {
        chunk = Buffer.from(chunk, writeEncoding ?? state.defaultEncoding);
        writeEncoding = 'binary';
    }

    state.buffer.push({ chunk, encoding: writeEncoding ?? 'utf8', callback: callback ?? (() => {}) });
    this.writableLength = state.buffer.length;

    if (!state.writing && state.corked === 0) {
        this._writeBuffered();
    }

    const ok = state.buffer.length < state.highWaterMark;
    // 'drain' only fires (in _writeBuffered below) if this is armed — else
    // a paused pipe() source waits forever for a 'drain' that never comes.
    if (!ok) state.awaitDrain = 1;
    return ok;
};

Writable.prototype._writeBuffered = function _writeBuffered(this: Writable): void {
    const state = this._writableState;
    if (state.writing || state.buffer.length === 0 || state.corked > 0) return;

    state.writing = true;
    const { chunk, encoding, callback } = state.buffer[0];

    let called = false;
    const onWrite = (err?: Error | null) => {
        if (called) return;
        called = true;
        state.writing = false;
        state.buffer.shift();
        this.writableLength = state.buffer.length;

        if (err) {
            // Callback first: emit('error') with no listener throws on EE and
            // would otherwise swallow the write callback forever.
            callback(err);
            try {
                this.emit('error', err);
            } catch {
                // No listener / listener threw — fault already delivered to cb.
            }
            return;
        }

        callback();

        if (state.buffer.length > 0) {
            this._writeBuffered();
        } else if (state.ended && !state.finished) {
            this._doFinal();
        } else if (state.awaitDrain > 0) {
            state.awaitDrain = 0;
            this.emit('drain');
        }
    };

    try {
        this._write(chunk, encoding, onWrite);
    } catch (err) {
        onWrite(asError(err));
    }
};

Writable.prototype._doFinal = function _doFinal(this: Writable): void {
    const state = this._writableState;
    if (state.finished || state.finalCalled) return;
    state.finalCalled = true;

    const finish = () => {
        if (state.finished) return;
        state.finished = true;
        this.writableFinished = true;
        this.emit('finish');
        if (state.autoDestroy) {
            this.destroy();
        }
    };

    if (this._final) {
        let called = false;
        const onFinal = (err?: Error | null) => {
            if (called) return;
            called = true;
            if (err) {
                this.emit('error', err);
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

    if (chunk !== null && chunk !== undefined) {
        this.write(chunk, typeof encoding === 'string' ? encoding : undefined);
    }

    if (state.ended) {
        if (callback) {
            if (state.finished) queueMicrotask(callback);
            else this.once('finish', callback);
        }
        return this;
    }

    state.ended = true;
    this.writableEnded = true;

    if (callback) {
        this.once('finish', callback);
    }

    if (!state.writing && state.buffer.length === 0) {
        this._doFinal();
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
    if (error) {
        this.emit('error', error);
    }
    if (state.emitClose) this.emit('close');
    return this;
};

Object.defineProperty(Writable.prototype, 'constructor', {
    value: Writable,
    writable: true,
    configurable: true,
});

flattenPrototype(Writable.prototype);

export interface Duplex extends Writable {
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
    toArray(): Promise<unknown[]>;
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
}

export interface DuplexConstructor {
    new (options?: DuplexOptions): Duplex;
    (options?: DuplexOptions): Duplex;
    prototype: Duplex;
    fromSource(source: Iterable<unknown> | AsyncIterable<unknown>): Duplex;
}

function initDuplex(self: Duplex, options?: DuplexOptions): void {
    Writable.call(self, options);
    self.readable = options?.readable ?? true;
    self.readableEnded = false;
    self.readableFlowing = null;
    self.readableObjectMode = options?.objectMode ?? false;
    self.readableHighWaterMark = options?.highWaterMark ?? defaultHighWaterMark(self.readableObjectMode);
    self.readableLength = 0;
    self.readableEncoding = null;
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
        decoder: null,
        disturbed: false,
    };

    if (options?.read) {
        self._read = options.read;
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
    if (!this.readable) return null;
    const state = this._readableState;

    if (state.buffer.length === 0) {
        if (state.ended) {
            this._emitReadableEndIfNeeded();
            return null;
        }
        state.needReadable = true;
        return null;
    }

    const chunk = state.buffer.shift();
    state.disturbed = true;
    this.readableDidRead = true;
    this.readableLength = state.buffer.length;
    emitDataAfterRead(this, chunk);
    this._emitReadableEndIfNeeded();
    return chunk;
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
    state.buffer = decoded;
    this.readableLength = state.buffer.length;
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
        if (state.buffer.length > 0 || state.ended) this.emit('readable');
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
        if (state.buffer.length > 0 || state.ended) this.emit('readable');
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
    this.emit('end');
};

Duplex.prototype._duplexReadAndResolve = function _duplexReadAndResolve(this: Duplex): void {
    const state = this._readableState;
    if (state.destroyed || !state.flowing) return;

    while (!state.destroyed && state.flowing && state.buffer.length > 0) {
        let chunk = state.buffer.shift();
        state.disturbed = true;
        this.readableDidRead = true;
        this.readableLength = state.buffer.length;
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

Duplex.prototype.unpipe = function unpipe(this: Duplex, destination?: Writable): Duplex {
    const destinations = destination ? [destination] : [...this._pipedDestinations];
    for (const dest of destinations) {
        const cleanups = (dest as PipeTrackedWritable).__pipeCleanups;
        const entry = cleanups?.find(item => item.source === this);
        if (entry) {
            entry.cleanup(true);
        } else {
            const idx = this._pipedDestinations.indexOf(dest);
            if (idx !== -1) this._pipedDestinations.splice(idx, 1);
        }
    }
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

    if (chunk === null) {
        if (state.decoder) {
            const trailing = state.decoder.end();
            state.decoder = null;
            if (trailing) {
                chunk = trailing;
            } else {
                state.ended = true;
                if (state.flowing) this._emitReadableEndIfNeeded();
                return false;
            }
        } else {
            state.ended = true;
            if (!state.flowing && state.readableListening) this.emit('readable');
            if (state.flowing) this._emitReadableEndIfNeeded();
            return false;
        }
    }

    chunk = normalizeChunk(chunk, state.objectMode, encoding, state.defaultEncoding);
    const bytes = decoderBytes(chunk);
    if (state.decoder && bytes) {
        const decoded = state.decoder.write(bytes);
        if (decoded.length === 0) return state.buffer.length < state.highWaterMark;
        chunk = decoded;
    }

    if (state.flowing && !state.readableListening) {
        state.disturbed = true;
        this.readableDidRead = true;
        this.emit('data', chunk);
        if (!state.destroyed) scheduleReadableFlow(this, () => this._duplexReadAndResolve());
    } else {
        state.buffer.push(chunk);
    }
    this.readableLength = state.buffer.length;
    if (!state.flowing) this.emit('readable');
    return state.buffer.length < state.highWaterMark;
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
    this.readable = false;
    this.writable = false;
    const state = this._readableState;
    state.destroyed = true;
    state.buffer.length = 0;
    this.readableLength = 0;
    if (error) {
        this.emit('error', error);
    }
    this.emit('close');
    return this;
};

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

Transform.prototype._read = function _read(this: Transform, _size: number): void {
    // Transform/PassThrough readable output is driven by writes into the
    // transform, so a default no-op read keeps the readable side from
    // throwing when consumers switch into flowing mode before any chunks land.
};

Transform.prototype._write = function _write(
    this: Transform,
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
): void {
    let called = false;
    const onTransform = (err?: Error | null, data?: unknown) => {
        if (called) return;
        called = true;
        if (err) return callback(err);
        if (data !== undefined) this.push(data);
        callback();
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
    if (isWritableLike(stream)) return stream.writableEnded || stream.writableFinished || stream.destroyed;
    return false;
}

export function isErrored(stream: unknown): boolean {
    if (isReadableLike(stream)) return !stream.readable;
    if (isWritableLike(stream)) return !stream.writable;
    return false;
}

export function isReadable(stream: unknown): boolean {
    return isReadableLike(stream) && stream.readable === true && !stream.readableEnded && !stream.destroyed;
}

export function isWritable(stream: unknown): boolean {
    return isWritableLike(stream) && stream.writable === true && !stream.writableEnded && !stream.destroyed;
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
        stream.destroy(new Error('aborted'));
    } else {
        signal.addEventListener('abort', () => {
            stream.destroy(new Error('aborted'));
        });
    }
    return stream;
}
