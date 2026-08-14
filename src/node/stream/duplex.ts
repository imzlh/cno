/**
 * node:stream Duplex.
 *
 * Imports ./writable because Duplex.prototype's prototype IS Writable.prototype
 * (and initDuplex calls Writable), and ./readable for one reverse edge: the
 * Symbol.asyncIterator implementation is shared by reference with Readable's,
 * copied here after every prototype method is in place and before this file's
 * flattenPrototype() call, exactly as the single-file version did.
 */

import { StringDecoder } from '../string_decoder';
import { Writable } from './writable';
import { Readable } from './readable';
import {
    addReadableLength,
    asError,
    collectReadableToArray,
    createInvalidChunkError,
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
    Duplex as DuplexShape,
    DuplexConstructor,
    DuplexOptions,
    StreamListener,
} from './types';

export interface Duplex extends DuplexShape {}

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
