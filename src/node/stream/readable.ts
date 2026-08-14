/**
 * node:stream Readable.
 *
 * The readable-state machinery itself lives in ./_shared because Duplex drives
 * the same helpers; this file is the Readable constructor, its prototype, and
 * Readable.from.
 */

import { StringDecoder } from '../string_decoder';
import { Stream } from './base';
import {
    addReadableLength,
    collectReadableToArray,
    createInvalidChunkError,
    createNullWriteError,
    decoderBytes,
    defaultHighWaterMark,
    deferTick,
    flattenPrototype,
    invokeReadableRead,
    isAsyncIterable,
    isConstructCallTarget,
    isIterable,
    maybeAutoDestroy,
    normalizeChunk,
    readReadableData,
    readableChunkLength,
    runStreamDestroy,
    scheduleReadableEmit,
    scheduleReadableFlow,
    subtractReadableLength,
    unpipeDestinations,
    unshiftReadableChunk,
    updateReadableLength,
} from './_shared';
import type {
    Readable as ReadableShape,
    ReadableConstructor,
    ReadableOptions,
    ReadableWrappedSource,
    StreamListener,
    Writable,
} from './types';

export interface Readable extends ReadableShape {}

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
