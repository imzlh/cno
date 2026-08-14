/**
 * node:stream Writable.
 *
 * The write-queue helpers shared with Duplex live in ./_shared;
 * createAlreadyFinishedError / createEndAfterDestroyError stay here because
 * end() is their only caller.
 */

import { Stream } from './base';
import {
    asError,
    createDestroyedError,
    createInvalidChunkError,
    createNullWriteError,
    createWriteAfterEndError,
    defaultHighWaterMark,
    deferTick,
    flattenPrototype,
    isConstructCallTarget,
    maybeAutoDestroy,
    queueSynchronousWriteCallbacks,
    runStreamDestroy,
    settleEndCallbacks,
    updateWritableLength,
    writableErrorOrDestroy,
} from './_shared';
import type {
    DuplexOptions,
    Writable as WritableShape,
    WritableConstructor,
    WritableOptions,
} from './types';

export interface Writable extends WritableShape {}

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
