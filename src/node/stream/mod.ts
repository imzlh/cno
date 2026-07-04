import { EventEmitter } from '../events';
import { StringDecoder } from '../string_decoder';

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
    write?: (chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) => void;
    writev?: (chunks: Array<{ chunk: any; encoding: BufferEncoding }>, callback: (error?: Error | null) => void) => void;
    final?: (callback: (error?: Error | null) => void) => void;
}

export interface DuplexOptions extends ReadableOptions, WritableOptions {
    allowHalfOpen?: boolean;
    readable?: boolean;
    writable?: boolean;
}

export interface TransformOptions extends DuplexOptions {
    transform?: (chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void) => void;
    flush?: (callback: (error?: Error | null, data?: any) => void) => void;
}

export interface PipeOptions {
    end?: boolean;
}

function normalizeChunk(chunk: any, objectMode: boolean, encoding: BufferEncoding | undefined, defaultEncoding: BufferEncoding): any {
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
        && prototype.isPrototypeOf(value as object);
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

function initStream(self: any): void {
    EventEmitter.call(self);
    if (typeof self.destroyed !== 'boolean') self.destroyed = false;
    if (!Array.isArray(self._pipedDestinations)) self._pipedDestinations = [];
}

export const Stream: StreamConstructor = function Stream(this: any) {
    const target = isConstructCallTarget(this, Stream.prototype)
        ? this
        : Object.create(Stream.prototype);
    initStream(target);
    return target;
} as StreamConstructor;

Object.setPrototypeOf(Stream, EventEmitter);
Stream.prototype = Object.create(EventEmitter.prototype);

Stream.prototype.pipe = function pipe<T extends Writable>(this: Stream, destination: T, options?: PipeOptions): T {
    const src = this as any;
    let drained = true;

    this._pipedDestinations.push(destination);

    const onData = (chunk: any) => {
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
        const cleanups = (destination as any).__pipeCleanups as Array<{ source: Stream; cleanup: (emitUnpipe?: boolean) => void }> | undefined;
        const entryIndex = cleanups?.findIndex(entry => entry.source === this && entry.cleanup === cleanup) ?? -1;
        const wasPiped = entryIndex !== -1;
        this.removeListener('data', onData);
        destination.removeListener('drain', onDrain);
        this.removeListener('end', onEnd);
        this.removeListener('close', onClose);
        destination.removeListener('close', onDestClose);
        if (wasPiped) {
            cleanups!.splice(entryIndex, 1);
            if (cleanups!.length === 0) delete (destination as any).__pipeCleanups;
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

    const cleanups = ((destination as any).__pipeCleanups ??= []) as Array<{ source: Stream; cleanup: (emitUnpipe?: boolean) => void }>;
    cleanups.push({ source: this, cleanup });
    destination.emit('pipe', this);

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
    buffer: any[];
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
    decoder: any;
    encoding: BufferEncoding | null;
    disturbed: boolean;
};

function scheduleReadableFlow(target: { _readableState: ReadableState }, resume: () => void): void {
    const state = target._readableState;
    if (state.resumeScheduled) return;
    state.resumeScheduled = true;
    queueMicrotask(() => {
        state.resumeScheduled = false;
        resume();
    });
}

function invokeReadableRead(target: { _readableState: ReadableState; _read(size: number): void; emit(event: string, error: unknown): void }): void {
    const state = target._readableState;
    if (!state.flowing || state.ended || state.reading) return;
    state.reading = true;
    try {
        target._read(state.highWaterMark);
    } catch (err) {
        state.reading = false;
        target.emit('error', err);
    }
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
    read(n?: number): any;
    setEncoding(enc: BufferEncoding): this;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    unpipe(destination?: Writable): this;
    unshift(chunk: any, encoding?: BufferEncoding): boolean;
    wrap(stream: any): this;
    push(chunk: any, encoding?: BufferEncoding): boolean;
    [Symbol.asyncIterator](): AsyncIterableIterator<any>;
}

export interface ReadableConstructor {
    new (options?: ReadableOptions): Readable;
    (options?: ReadableOptions): Readable;
    prototype: Readable;
    from(iterable: Iterable<any> | AsyncIterable<any>, options?: ReadableOptions): Readable;
}

function initReadable(self: any, options?: ReadableOptions): void {
    Stream.call(self);
    self.readable = true;
    self.readableEnded = false;
    self.readableFlowing = null;
    self.readableObjectMode = options?.objectMode ?? false;
    self.readableHighWaterMark = options?.highWaterMark ?? (self.readableObjectMode ? 16 : 16384);
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

export const Readable: ReadableConstructor = function Readable(this: any, options?: ReadableOptions) {
    const target = isConstructCallTarget(this, Readable.prototype)
        ? this
        : Object.create(Readable.prototype);
    initReadable(target, options);
    return target;
} as ReadableConstructor;

Object.setPrototypeOf(Readable, Stream);
Readable.prototype = Object.create(Stream.prototype);

Readable.prototype.on = function on(this: Readable, event: string | symbol, fn: (...args: any[]) => void): Readable {
    Stream.prototype.on.call(this, event, fn);
    if (event === 'data') this.resume();
    return this;
};

Readable.prototype.once = function once(this: Readable, event: string | symbol, fn: (...args: any[]) => void): Readable {
    Stream.prototype.once.call(this, event, fn);
    if (event === 'data') this.resume();
    return this;
};

Readable.prototype._emitReadableEndIfNeeded = function _emitReadableEndIfNeeded(this: Readable): void {
    const state = this._readableState;
    if (!state.ended || state.endEmitted || state.buffer.length > 0) return;
    state.endEmitted = true;
    this.readableEnded = true;
    this.emit('end');
};

Readable.from = function from(iterable: Iterable<any> | AsyncIterable<any>, options?: ReadableOptions): Readable {
    const readable = new Readable({ objectMode: true, ...options });
    const iterator = (iterable as any)?.[Symbol.asyncIterator]?.() ?? (iterable as any)?.[Symbol.iterator]?.();
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
            readable.destroy(err as Error);
        } finally {
            reading = false;
            if (!ended && readable._readableState.flowing && readable._readableState.buffer.length === 0) {
                scheduleReadableFlow(readable, () => readable._readAndResolve());
            }
        }
    };

    return readable;
};

Readable.prototype.read = function read(this: Readable, n?: number): any {
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

    this._emitReadableEndIfNeeded();

    return chunk;
};

Readable.prototype.setEncoding = function setEncoding(this: Readable, enc: BufferEncoding): Readable {
    this.readableEncoding = enc;
    const state = this._readableState;
    state.encoding = enc;
    state.decoder = new StringDecoder(enc);
    const decoded: any[] = [];
    for (const chunk of state.buffer) {
        if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
            const out = state.decoder.write(chunk);
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
    if (!state.flowing) {
        state.flowing = true;
        this.emit('resume');
        // Defer like Node's nextTick, else pipe()'s own 'end' listener (added
        // right after this.on('data',...)) isn't registered yet when it fires.
        scheduleReadableFlow(this, () => this._readAndResolve());
    }
    return this;
};

Readable.prototype._readAndResolve = function _readAndResolve(this: Readable): void {
    const state = this._readableState;
    if (!state.flowing) return;

    while (state.flowing && state.buffer.length > 0) {
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
        const cleanups = (dest as any).__pipeCleanups as Array<{ source: Stream; cleanup: (emitUnpipe?: boolean) => void }> | undefined;
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

Readable.prototype.unshift = function unshift(this: Readable, chunk: any, encoding?: BufferEncoding): boolean {
    const state = this._readableState;
    if (typeof chunk === 'string') {
        chunk = Buffer.from(chunk, encoding || state.defaultEncoding);
    }
    if (state.endEmitted) {
        state.endEmitted = false;
        this.readableEnded = false;
        this.readable = true;
    }
    return this.push(chunk);
};

Readable.prototype.wrap = function wrap(this: Readable, stream: any): Readable {
    if (stream && typeof stream.on === 'function') {
        stream.on('data', (chunk: any) => {
            if (!this.push(chunk)) {
                stream.pause && stream.pause();
            }
        });
        stream.on('end', () => { this.push(null); });
        stream.on('error', (err: Error) => { this.destroy(err); });
        if (stream.resume) stream.resume();
    }
    return this;
};

Readable.prototype.push = function push(this: Readable, chunk: any, encoding?: BufferEncoding): boolean {
    const state = this._readableState;
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
            if (state.flowing) this._emitReadableEndIfNeeded();
            return false;
        }
    }

    chunk = normalizeChunk(chunk, state.objectMode, encoding, state.defaultEncoding);
    if (state.decoder && (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        chunk = state.decoder.write(chunk);
        if (chunk.length === 0) return state.buffer.length < state.highWaterMark;
    }

    if (state.flowing) {
        state.disturbed = true;
        this.readableDidRead = true;
        this.emit('data', chunk);
        scheduleReadableFlow(this, () => this._readAndResolve());
        return state.buffer.length < state.highWaterMark;
    }

    state.buffer.push(chunk);
    this.readableLength = state.buffer.length;

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

Readable.prototype[Symbol.asyncIterator] = function asyncIterator(this: Readable): AsyncIterableIterator<any> {
    const readable = this;
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next() {
            return new Promise((resolve, reject) => {
                const onData = (chunk: any) => {
                    cleanup();
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
    } as AsyncIterableIterator<any>;
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
    buffer: Array<{ chunk: any; encoding: BufferEncoding; callback: (error?: Error | null) => void }>;
    writing: boolean;
    corked: number;
    ended: boolean;
    finished: boolean;
    finalCalled: boolean;
    decodeStrings: boolean;
    defaultEncoding: BufferEncoding;
    destroyed: boolean;
    awaitDrain: number;
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
    _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void;
    _writev?(chunks: Array<{ chunk: any; encoding: BufferEncoding }>, callback: (error?: Error | null) => void): void;
    _final?(callback: (error?: Error | null) => void): void;
    _writeBuffered(): void;
    _doFinal(): void;
    write(chunk: any, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean;
    setDefaultEncoding(encoding: BufferEncoding): this;
    end(chunk?: any, encoding?: BufferEncoding | (() => void), callback?: () => void): this;
    cork(): void;
    uncork(): void;
}

export interface WritableConstructor {
    new (options?: WritableOptions): Writable;
    (options?: WritableOptions): Writable;
    prototype: Writable;
}

function initWritable(self: any, options?: WritableOptions): void {
    Stream.call(self);
    self.writable = true;
    self.writableEnded = false;
    self.writableFinished = false;
    self.writableObjectMode = options?.objectMode ?? false;
    self.writableHighWaterMark = options?.highWaterMark ?? (self.writableObjectMode ? 16 : 16384);
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

export const Writable: WritableConstructor = function Writable(this: any, options?: WritableOptions) {
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
    chunk: any,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
): boolean {
    if (typeof encoding === 'function') {
        callback = encoding;
        encoding = 'utf8';
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
        chunk = Buffer.from(chunk, (encoding as BufferEncoding) || state.defaultEncoding);
        encoding = 'buffer' as BufferEncoding;
    }

    state.buffer.push({ chunk, encoding: (encoding as BufferEncoding) ?? 'utf8', callback: callback ?? (() => {}) });
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
            this.emit('error', err);
            callback(err);
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
        onWrite(err as Error);
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
            onFinal(err as Error);
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
    chunk?: any,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void
): Writable {
    if (typeof chunk === 'function') {
        callback = chunk;
        chunk = null;
        encoding = undefined;
    } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
    }

    const state = this._writableState;

    if (chunk !== null && chunk !== undefined) {
        this.write(chunk, encoding as BufferEncoding);
    }

    if (state.ended) return this;

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

Writable.prototype._write = function _write(this: Writable, chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
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
    this.emit('close');
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
    read(n?: number): any;
    setEncoding(enc: BufferEncoding): this;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    unpipe(destination?: Writable): this;
    unshift(chunk: any, encoding?: BufferEncoding): boolean;
    push(chunk: any, encoding?: BufferEncoding): boolean;
}

export interface DuplexConstructor {
    new (options?: DuplexOptions): Duplex;
    (options?: DuplexOptions): Duplex;
    prototype: Duplex;
    fromSource(source: any): Duplex;
}

function initDuplex(self: any, options?: DuplexOptions): void {
    Writable.call(self, options);
    self.readable = options?.readable ?? true;
    self.readableEnded = false;
    self.readableFlowing = null;
    self.readableObjectMode = options?.objectMode ?? false;
    self.readableHighWaterMark = options?.highWaterMark ?? (self.readableObjectMode ? 16 : 16384);
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

export const Duplex: DuplexConstructor = function Duplex(this: any, options?: DuplexOptions) {
    const target = isConstructCallTarget(this, Duplex.prototype)
        ? this
        : Object.create(Duplex.prototype);
    initDuplex(target, options);
    return target;
} as DuplexConstructor;

Object.setPrototypeOf(Duplex, Writable);
Duplex.prototype = Object.create(Writable.prototype);

Duplex.prototype.read = function read(this: Duplex, n?: number): any {
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
    this._emitReadableEndIfNeeded();
    return chunk;
};

Duplex.prototype.setEncoding = function setEncoding(this: Duplex, enc: BufferEncoding): Duplex {
    this.readableEncoding = enc;
    const state = this._readableState;
    state.encoding = enc;
    state.decoder = new StringDecoder(enc);
    const decoded: any[] = [];
    for (const chunk of state.buffer) {
        if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
            const out = state.decoder.write(chunk);
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
    if (!state.flowing) {
        state.flowing = true;
        this.emit('resume');
        // Same deferral as Readable.prototype.resume — see comment there.
        scheduleReadableFlow(this, () => this._duplexReadAndResolve());
    }
    return this;
};

Duplex.prototype.on = function on(this: Duplex, event: string | symbol, fn: (...args: any[]) => void): Duplex {
    Writable.prototype.on.call(this, event, fn);
    if (event === 'data') this.resume();
    return this;
};

Duplex.prototype.once = function once(this: Duplex, event: string | symbol, fn: (...args: any[]) => void): Duplex {
    Writable.prototype.once.call(this, event, fn);
    if (event === 'data') this.resume();
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
    if (!state.flowing) return;

    while (state.flowing && state.buffer.length > 0) {
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
        const cleanups = (dest as any).__pipeCleanups as Array<{ source: Stream; cleanup: (emitUnpipe?: boolean) => void }> | undefined;
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

Duplex.prototype.unshift = function unshift(this: Duplex, chunk: any, encoding?: BufferEncoding): boolean {
    if (typeof chunk === 'string') {
        chunk = Buffer.from(chunk, encoding || this._readableState.defaultEncoding);
    }
    return this.push(chunk);
};

Duplex.prototype.push = function push(this: Duplex, chunk: any, encoding?: BufferEncoding): boolean {
    if (!this.readable) return false;
    const state = this._readableState;
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
            if (state.flowing) this._emitReadableEndIfNeeded();
            return false;
        }
    }

    chunk = normalizeChunk(chunk, state.objectMode, encoding, state.defaultEncoding);
    if (state.decoder && (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        chunk = state.decoder.write(chunk);
        if (chunk.length === 0) return state.buffer.length < state.highWaterMark;
    }

    if (state.flowing) {
        state.disturbed = true;
        this.readableDidRead = true;
        this.emit('data', chunk);
        scheduleReadableFlow(this, () => this._duplexReadAndResolve());
    } else {
        state.buffer.push(chunk);
    }
    this.readableLength = state.buffer.length;
    return state.buffer.length < state.highWaterMark;
};

Duplex.prototype._read = function _read(this: Duplex, size: number): void {
    throw new Error('_read() is not implemented');
};

Duplex.fromSource = function fromSource(source: any): Duplex {
    if (source && typeof source[Symbol.asyncIterator] === 'function') {
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
                duplex.destroy(err as Error);
            }
        })();
        return duplex;
    }
    if (source && typeof source[Symbol.iterator] === 'function') {
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

Duplex.prototype.destroy = function destroy(this: Duplex, error?: Error | null): Duplex {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    const state = this._readableState;
    state.buffer.length = 0;
    this.readableLength = 0;
    if (error) {
        this.emit('error', error);
    }
    this.emit('close');
    return this;
};

Object.defineProperty(Duplex.prototype, 'constructor', {
    value: Duplex,
    writable: true,
    configurable: true,
});

flattenPrototype(Duplex.prototype);

export interface Transform extends Duplex {
    _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void;
    _flush?(callback: (error?: Error | null, data?: any) => void): void;
}

export interface TransformConstructor {
    new (options?: TransformOptions): Transform;
    (options?: TransformOptions): Transform;
    prototype: Transform;
}

function initTransform(self: any, options?: TransformOptions): void {
    Duplex.call(self, options);
    if (options?.transform) {
        self._transform = options.transform;
    }
    if (options?.flush) {
        self._flush = options.flush;
    }
}

export const Transform: TransformConstructor = function Transform(this: any, options?: TransformOptions) {
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
    chunk: any,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: any) => void
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
    chunk: any,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
): void {
    let called = false;
    const onTransform = (err?: Error | null, data?: any) => {
        if (called) return;
        called = true;
        if (err) return callback(err);
        if (data !== undefined) this.push(data);
        callback();
    };
    try {
        this._transform(chunk, encoding, onTransform);
    } catch (err) {
        onTransform(err as Error);
    }
};

Transform.prototype._final = function _final(this: Transform, callback: (error?: Error | null) => void): void {
    let called = false;
    const done = (err?: Error | null, data?: any) => {
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
            done(err as Error);
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

export const PassThrough: PassThroughConstructor = function PassThrough(this: any, options?: TransformOptions) {
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
    chunk: any,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: any) => void
): void {
    callback(null, chunk);
};

Object.defineProperty(PassThrough.prototype, 'constructor', {
    value: PassThrough,
    writable: true,
    configurable: true,
});

flattenPrototype(PassThrough.prototype);

export function isDisturbed(stream: any): boolean {
    if (stream?._readableState) {
        return !!stream._readableState.disturbed || stream.readableEnded || stream.readableAborted || stream.destroyed;
    }
    if (stream instanceof Writable) return stream.writableEnded || stream.writableFinished || stream.destroyed;
    return !!(stream && stream.destroyed);
}

export function isErrored(stream: any): boolean {
    if (!stream) return false;
    if (stream instanceof Readable) return !stream.readable;
    if (stream instanceof Writable) return !stream.writable;
    return false;
}

export function isReadable(stream: any): boolean {
    if (stream instanceof Readable) return stream.readable && !stream.readableEnded;
    return false;
}

export function compose(...streams: any[]): any {
    if (streams.length < 2) throw new TypeError('compose requires at least two streams');
    for (let i = 0; i < streams.length - 1; i++) {
        const src = streams[i];
        const dst = streams[i + 1];
        src.pipe(dst);
        src.on('error', (err: Error) => {
            if (!dst.destroyed) dst.destroy(err);
        });
    }
    return streams[streams.length - 1];
}

export function ReadableFrom(iterable: Iterable<any> | AsyncIterable<any>, options?: ReadableOptions): Readable {
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
