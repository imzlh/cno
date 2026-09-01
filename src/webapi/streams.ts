/**
 * Web Streams API implementation with ES2024
 * State machine based design with proper pull timing
 */

import { getMemoryTier } from "../utils/memory-tier";

const zlib = import.meta.use('zlib');
const transformReadableDefault = Symbol('transformReadableDefault');

type ClosableHandle = { close?: () => void };

const validateHighWaterMark = (value: number | undefined): number => {
    const hwm = Number(value);
    if (Number.isNaN(hwm) || hwm < 0) {
        throw new RangeError('Invalid highWaterMark');
    }
    return hwm;
};

const extractHighWaterMark = (strategy: QueuingStrategy | undefined, defaultHWM: number): number => {
    return validateHighWaterMark(strategy?.highWaterMark ?? defaultHWM);
};

// WebIDL converts the QueuingStrategy dictionary before the extract steps run, so a
// present-but-not-callable `size` is a TypeError at construction rather than something
// that blows up later on the first enqueue. `undefined` means "absent" and takes the
// default; `null` is a failed callback conversion and throws, matching Node and Deno.
const extractSizeAlgorithm = <T>(strategy: QueuingStrategy<T> | undefined): (chunk: T) => number => {
    const size = strategy?.size;
    if (size === undefined) return () => 1;
    if (typeof size !== 'function') {
        throw new TypeError(
            "Failed to read the 'size' property from 'QueuingStrategy': the provided value is not a function"
        );
    }
    return size;
};

function closeHandle(handle: ClosableHandle | null): void {
    handle?.close?.();
}

function notifyEnqueueQuietly(callback: () => void): void {
    try {
        callback();
    } catch {
        // Backpressure callbacks are advisory; enqueue keeps its own state.
    }
}

// Array.shift() cannot distinguish an empty queue from a valid undefined chunk.
function shiftQueued<T>(queue: T[]): T {
    return queue.shift() as T;
}

// ReadableStream State Machine
class ReadableStreamController<R = unknown> implements globalThis.ReadableStreamDefaultController<R> {
    #state: 'readable' | 'closed' | 'errored' = 'readable';
    #source: UnderlyingSource<R> | null;
    #sizeAlgorithm: (chunk: R) => number;
    #highWaterMark: number;
    #queue: Array<{ chunk: R; size: number }> = [];
    #queueSize = 0;
    #started = false;
    #closeRequested = false;
    #pulling = false;
    #pullAgain = false;
    #storedError: unknown = undefined;
    #startPromise: Promise<void> | null = null;
    #pendingReads: Array<{
        resolve: (result: ReadableStreamReadResult<R>) => void;
        reject: (reason?: unknown) => void;
    }> = [];
    #closedCallbacks: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];
    #backpressureBuffer: Array<{ chunk: R; size: number }> = [];
    #backpressureBufferSize = 0;
    #maxBackpressureSize: number;
    #onEnqueue: (() => void) | null = null;
    #onDequeue: (() => void) | null = null;

    constructor(source: UnderlyingSource<R>, strategy: QueuingStrategy<R>, defaultHWM = 1) {
        this.#source = source;
        this.#sizeAlgorithm = extractSizeAlgorithm(strategy);
        this.#highWaterMark = extractHighWaterMark(strategy, defaultHWM);
        const tier = getMemoryTier();
        this.#maxBackpressureSize = tier === 'low' ? 1 * 1024 * 1024 : tier === 'normal' ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
    }

    get desiredSize(): number | null {
        if (this.#state === 'closed' || this.#state === 'errored') return null;
        // The side buffer holds chunks past the HWM (see `enqueue`), so it must be
        // charged here too: otherwise desiredSize floors at 0 and never reports the
        // negative pressure the spec uses to tell a producer to stop.
        return this.#highWaterMark - (this.#queueSize + this.#backpressureBufferSize);
    }

    enqueue(chunk: R): void {
        if (this.#state !== 'readable') {
            throw new TypeError('Stream is not readable');
        }
        if (this.#closeRequested) {
            throw new TypeError('Stream is closed');
        }

        // If there's a pending read, fulfill it directly — no queuing needed.
        if (this.#pendingReads.length > 0) {
            const read = shiftQueued(this.#pendingReads);
            read.resolve({ value: chunk, done: false });
            this.#callPullIfNeeded();
            return;
        }

        // Backpressure: if the queue already exceeds the high water mark,
        // buffer the chunk separately and notify the producer so it can
        // stop producing (e.g. pause curl). Chunks must remain lossless;
        // transport-level backpressure is responsible for stopping growth.
        if (this.#queueSize >= this.#highWaterMark && this.#highWaterMark > 0) {
            const size = this.#sizeAlgorithm2(chunk);
            if (this.#backpressureBufferSize + size > this.#maxBackpressureSize) {
                const err = new TypeError('Backpressure buffer exceeded memory limit');
                this.error(err);
                throw err;
            }
            this.#backpressureBuffer.push({ chunk, size });
            this.#backpressureBufferSize += size;
            if (this.#onEnqueue) {
                notifyEnqueueQuietly(this.#onEnqueue);
            }
            return;
        }

        // Otherwise enqueue into the main queue.
        const size = this.#sizeAlgorithm2(chunk);
        this.#queue.push({ chunk, size });
        this.#queueSize += size;
    }

    // A throwing (or junk-returning) `size()` must error the stream before the
    // throw escapes to the producer. Letting it propagate raw left the stream
    // 'readable' with no queue and no producer, so every later read() and the
    // `closed` promise stayed pending forever instead of rejecting.
    #sizeAlgorithm2(chunk: R): number {
        let size: number;
        try {
            size = Number(this.#sizeAlgorithm(chunk));
        } catch (error) {
            this.error(error);
            throw error;
        }
        if (!Number.isFinite(size) || size < 0) {
            const err = new RangeError('Chunk size must be a finite, non-negative number');
            this.error(err);
            throw err;
        }
        return size;
    }

    close(): void {
        if (this.#state !== 'readable') return;
        if (this.#closeRequested) return;

        this.#closeRequested = true;

        // Drain ALL remaining backpressure buffer chunks into the main queue
        // so they are delivered to the consumer before the stream finishes.
        // We bypass the HWM limit here — the producer is done, so there is
        // no risk of unbounded growth; we just need every last chunk reachable.
        while (this.#backpressureBuffer.length > 0) {
            const entry = shiftQueued(this.#backpressureBuffer);
            this.#queue.push(entry);
            this.#queueSize += entry.size;
        }
        // The bytes moved to #queue, so stop charging them to the side buffer too.
        this.#backpressureBufferSize = 0;

        // If queue is empty, finish immediately — any pending reads get done:true.
        // (This handles the case where close() is called from inside pull()
        //  while a pendingRead is waiting for that pull to enqueue something.)
        if (this.#queue.length === 0) {
            this.#finishClose();
        }
    }

    error(e: unknown): void {
        if (this.#state !== 'readable') return;

        this.#state = 'errored';
        this.#storedError = e;
        this.#queue = [];
        this.#queueSize = 0;
        this.#backpressureBuffer = [];
        this.#backpressureBufferSize = 0;
        this.#onEnqueue = null;

        // Reject all pending reads
        for (const read of this.#pendingReads) {
            queueMicrotask(() => read.reject(e));
        }
        this.#pendingReads = [];

        // Reject all closed promises
        for (const cb of this.#closedCallbacks) {
            queueMicrotask(() => cb.reject(e));
        }
        this.#closedCallbacks = [];
    }

    // Internal methods
    async #start(): Promise<void> {
        if (this.#started) return;
        if (this.#startPromise) return this.#startPromise;

        this.#startPromise = (async () => {
            try {
                await this.#source?.start?.(this);
                this.#started = true;
                this.#callPullIfNeeded();
            } catch (error) {
                this.error(error);
            } finally {
                this.#startPromise = null;
            }
        })();
        return this.#startPromise;
    }

    #read(): void {
        // State checks
        if (this.#state === 'closed') {
            const read = this.#pendingReads.shift();
            if (read) read.resolve({ value: undefined, done: true });
            return;
        }

        if (this.#state === 'errored') {
            const read = this.#pendingReads.shift();
            if (read) queueMicrotask(() => read.reject(this.#storedError));
            return;
        }

        // Try to dequeue
        if (this.#queue.length > 0) {
            const read = this.#pendingReads.shift();
            if (!read) return;
            const entry = shiftQueued(this.#queue);
            this.#queueSize -= entry.size;

            read.resolve({ value: entry.chunk, done: false });

            // Drain backpressure buffer now that queue has room.
            this.#drainBuffer();
            this.#onDequeue?.();

            // Check if we should close after dequeueing
            if (this.#closeRequested && this.#queue.length === 0 && this.#pendingReads.length === 0) {
                this.#finishClose();
            } else {
                this.#callPullIfNeeded();
            }
            return;
        }

        // Queue is empty, pull will be triggered after read is queued
        this.#callPullIfNeeded();
    }

    #drainBuffer(): void {
        while (this.#backpressureBuffer.length > 0 && this.#queueSize < this.#highWaterMark) {
            const entry = shiftQueued(this.#backpressureBuffer);
            this.#backpressureBufferSize -= entry.size;
            this.#queue.push(entry);
            this.#queueSize += entry.size;
        }
    }

    #callPullIfNeeded(): void {
        if (!this.#shouldPull()) return;

        if (this.#pulling) {
            this.#pullAgain = true;
            return;
        }

        this.#pulling = true;
        this.#pullAgain = false;

        Promise.resolve(this.#source?.pull?.(this))
            .then(() => {
                this.#pulling = false;
                if (this.#pullAgain) {
                    this.#callPullIfNeeded();
                }
            })
            .catch(error => {
                this.#pulling = false;
                this.error(error);
            });
    }

    #shouldPull(): boolean {
        if (this.#state !== 'readable') return false;
        if (!this.#started) return false;
        if (this.#closeRequested) return false;
        if (this.#pendingReads.length === 0) return false;
        // A pending read is demand even when HWM is zero. TransformStream uses
        // that zero default and would deadlock if pull were gated on desiredSize.
        return true;
    }

    async #cancel(reason?: unknown): Promise<void> {
        if (this.#state === 'closed') return;

        this.#state = 'closed';
        this.#queue = [];
        this.#queueSize = 0;
        this.#backpressureBuffer = [];
        this.#backpressureBufferSize = 0;
        this.#onEnqueue = null;
        this.#storedError = undefined;

        // Save source for cancel callback, then release it.
        const source = this.#source;
        this.#source = null;

        for (const read of this.#pendingReads) {
            read.resolve({ value: undefined, done: true });
        }
        this.#pendingReads = [];

        for (const cb of this.#closedCallbacks) {
            cb.resolve();
        }
        this.#closedCallbacks = [];

        await source?.cancel?.(reason);
    }

    #finishClose(): void {
        this.#state = 'closed';

        // Release all queued data so it can be GC'd.
        // close() already drained #backpressureBuffer into #queue before
        // calling us, so clearing both is safe — no data is lost.
        this.#queue = [];
        this.#queueSize = 0;
        this.#backpressureBuffer = [];
        this.#backpressureBufferSize = 0;
        this.#onEnqueue = null;
        this.#storedError = undefined;

        // Break the closure chain: the source captures the producer's entire
        // scope (curl handle, headers, hooks, etc.).  Once the stream is done
        // the source will never be called again, so we can release it.
        this.#source = null;

        // Resolve any pending reads with done
        for (const read of this.#pendingReads) {
            read.resolve({ value: undefined, done: true });
        }
        this.#pendingReads = [];

        // Resolve closed promises
        for (const cb of this.#closedCallbacks) {
            cb.resolve();
        }
        this.#closedCallbacks = [];
    }

    // Public API bridge for stream operations
    get _state() { return this.#state; }
    get _storedError() { return this.#storedError; }
    get _backpressured() { return this.#backpressureBuffer.length > 0; }

    set _onEnqueueCallback(fn: (() => void) | null) { this.#onEnqueue = fn; }
    set _onDequeueCallback(fn: (() => void) | null) { this.#onDequeue = fn; }

    _addPendingRead(resolve: (result: ReadableStreamReadResult<R>) => void, reject: (reason?: unknown) => void) {
        this.#pendingReads.push({ resolve, reject });
        this.#read();
    }

    _releasePendingReads(error: TypeError): void {
        for (const read of this.#pendingReads) {
            queueMicrotask(() => read.reject(error));
        }
        this.#pendingReads = [];
    }

    _addClosedCallback(resolve: () => void, reject: (reason?: unknown) => void) {
        if (this.#state === 'closed') {
            resolve();
        } else if (this.#state === 'errored') {
            queueMicrotask(() => reject(this.#storedError));
        } else {
            this.#closedCallbacks.push({ resolve, reject });
        }
    }

    _start() { return this.#start(); }
    _cancel(reason?: unknown) { return this.#cancel(reason); }
}

// ReadableStream
export class ReadableStream<R = unknown> implements globalThis.ReadableStream<R> {
    #controller: ReadableStreamController<R>;
    #reader: ReadableStreamDefaultReader<R> | null = null;

    static from<R>(iterable: AsyncIterable<R> | Iterable<R>): ReadableStream<R> {
        const value: unknown = iterable;
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
            throw new TypeError("Failed to execute 'ReadableStream.from': Argument 1 can not be converted to async iterable.");
        }

        const getAsyncIterator = Reflect.get(value, Symbol.asyncIterator);
        const getSyncIterator = Reflect.get(value, Symbol.iterator);
        if (typeof getAsyncIterator !== 'function' && typeof getSyncIterator !== 'function') {
            throw new TypeError("Failed to execute 'ReadableStream.from': Argument 1 can not be converted to async iterable.");
        }

        let iterator: Iterator<R> | AsyncIterator<R>;

        return new ReadableStream({
            start() {
                if (typeof getAsyncIterator === 'function') {
                    iterator = getAsyncIterator.call(value);
                } else if (typeof getSyncIterator === 'function') {
                    iterator = getSyncIterator.call(value);
                }
            },
            async pull(c) {
                const controller = c as ReadableStreamDefaultController<R>;
                try {
                    const result = await iterator.next();
                    if (result.done) {
                        controller.close();
                    } else {
                        controller.enqueue(result.value);
                    }
                } catch (error) {
                    controller.error(error);
                }
            },
            cancel() {
                iterator.return?.();
            }
        });
    }

    constructor(
        source: UnderlyingSource<R> = {},
        strategy: QueuingStrategy<R> = {},
        internalDefault?: typeof transformReadableDefault,
    ) {
        // `type` is a WebIDL enum: absent means a default stream, 'bytes' selects a byte
        // stream, and anything else is a TypeError *after* ToString, so
        // `{ toString: () => 'bytes' }` is accepted. Node and Deno both do this.
        const type = (source as { type?: unknown } | null)?.type;
        if (type !== undefined && String(type) !== 'bytes') {
            throw new TypeError(`Invalid type: ${String(type)}`);
        }
        const defaultHWM = internalDefault === transformReadableDefault ? 0 : 1;
        this.#controller = new ReadableStreamController(source, strategy, defaultHWM);
        void this.#controller._start();
    }

    get locked(): boolean {
        return this.#reader !== null;
    }

    getReader(options: { mode: 'byob' }): ReadableStreamBYOBReader;
    getReader(options?: ReadableStreamGetReaderOptions): ReadableStreamDefaultReader<R>;
    getReader(options?: ReadableStreamGetReaderOptions): ReadableStreamReader<R> {
        // `mode` is a WebIDL enum: anything other than undefined/'byob' is a
        // TypeError. 'byob' is unimplemented (no byte-stream controller), and requesting
        // it is a TypeError too — the spec's own error for byob on a non-byte stream —
        // not the bare Error that `assert` raises.
        const mode = options?.mode;
        if (mode !== undefined && mode !== 'byob') {
            throw new TypeError(`Invalid mode: ${String(mode)}`);
        }
        if (mode === 'byob') {
            throw new TypeError('Cannot get a BYOB reader for a non-byte stream');
        }
        if (this.locked) {
            throw new TypeError('Stream is already locked');
        }
        this.#reader = new ReadableStreamDefaultReader(this);
        this.#controller._start();
        return this.#reader as ReadableStreamReader<R>;
    }

    async cancel(reason?: unknown): Promise<void> {
        if (this.locked) {
            throw new TypeError('Stream is locked');
        }
        await this.#controller._cancel(reason);
    }

    pipeThrough<T>(
        transform: { writable: globalThis.WritableStream<R>; readable: globalThis.ReadableStream<T> },
        options?: { signal?: AbortSignal; preventClose?: boolean; preventAbort?: boolean; preventCancel?: boolean }
    ): globalThis.ReadableStream<T> {
        // Validate the pair up front: without this, `pipeThrough({})` returns
        // `undefined` instead of throwing, and the failure surfaces far away.
        if (transform === null || typeof transform !== 'object') {
            throw new TypeError('pipeThrough requires a { readable, writable } pair');
        }
        if (!(transform.writable instanceof WritableStream) || !(transform.readable instanceof ReadableStream)) {
            throw new TypeError('pipeThrough requires a { readable, writable } pair');
        }
        const pipePromise = this.pipeTo(transform.writable, options);
        void pipePromise.catch(() => {});
        return transform.readable;
    }

    async pipeTo(
        dest: globalThis.WritableStream<R>,
        options?: { signal?: AbortSignal; preventClose?: boolean; preventAbort?: boolean; preventCancel?: boolean }
    ): Promise<void> {
        const { preventClose = false, preventAbort = false, preventCancel = false, signal } = options ?? {};

        if (this.locked) throw new TypeError('Source is locked');
        if (dest.locked) throw new TypeError('Destination is locked');

        const reader = this.getReader();
        const writer = dest.getWriter();
        void reader.closed.catch(() => {});
        void writer.closed.catch(() => {});
        void writer.ready.catch(() => {});

        if (signal?.aborted) {
            const reason = signal.reason;
            try {
                if (!preventAbort) await writer.abort(reason);
                if (!preventCancel) await reader.cancel(reason);
            } finally {
                reader.releaseLock();
                writer.releaseLock();
            }
            throw reason;
        }

        let aborted = false;
        const abortState: { removeAbortListener?: () => void } = {};
        type AbortResult = { aborted: true; reason: unknown };
        type DestinationClosedResult = { destinationClosed: true };
        type DestinationErroredResult = { destinationErrored: true; reason: unknown };
        let abortPromise: Promise<AbortResult>;
        if (signal) {
            abortPromise = new Promise<AbortResult>((resolve) => {
                const onAbort = () => {
                    aborted = true;
                    resolve({ aborted: true, reason: signal.reason });
                };
                signal.addEventListener('abort', onAbort, { once: true });
                abortState.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
            });
        } else {
            abortPromise = new Promise<AbortResult>(() => { });
        }
        const destinationClosedPromise = writer.closed.then<DestinationClosedResult, DestinationErroredResult>(
            () => ({ destinationClosed: true }),
            (reason) => ({ destinationErrored: true, reason }),
        );

        try {
            while (!aborted) {
                const result = await Promise.race([reader.read(), abortPromise, destinationClosedPromise]);
                if ('aborted' in result) throw result.reason;
                if ('destinationErrored' in result) throw result.reason;
                if ('destinationClosed' in result) throw new TypeError('Destination stream closed');

                if (result.done) {
                    if (!preventClose) await writer.close();
                    break;
                }

                const writeResult = await Promise.race([
                    writer.write(result.value).then(() => null),
                    abortPromise,
                    destinationClosedPromise,
                ]);
                if (writeResult && 'aborted' in writeResult) throw writeResult.reason;
                if (writeResult && 'destinationErrored' in writeResult) throw writeResult.reason;
                if (writeResult && 'destinationClosed' in writeResult) throw new TypeError('Destination stream closed');
            }
        } catch (error) {
            if (!preventAbort) await writer.abort(error);
            if (!preventCancel) await reader.cancel(error);
            throw error;
        } finally {
            abortState.removeAbortListener?.();
            reader.releaseLock();
            writer.releaseLock();
        }
    }

    tee(): [globalThis.ReadableStream<R>, globalThis.ReadableStream<R>] {
        if (this.locked) {
            throw new TypeError('Cannot tee a locked stream');
        }

        const reader = this.getReader();
        const branches: [R[] | null, R[] | null] = [[], []];
        const pending: [
            ReadableStreamDefaultController<R> | null,
            ReadableStreamDefaultController<R> | null,
        ] = [null, null];
        let reading = false;
        let done = false;
        let error: unknown;
        const cancelReasons: [unknown, unknown] = [undefined, undefined];
        const branchCanceled: [boolean, boolean] = [false, false];
        const cancelResult = Promise.withResolvers<void>();
        /* The tee algorithm's cancel promise is rejected when the source errors
         * even if neither branch ever calls cancel(). Mark that internal promise
         * handled; branch readers still receive the original stream error. */
        void cancelResult.promise.catch(() => {});
        let cancelSettled = false;

        const resolveCancel = (): void => {
            if (cancelSettled) return;
            cancelSettled = true;
            cancelResult.resolve();
        };

        const rejectCancel = (reason: unknown): void => {
            if (cancelSettled) return;
            cancelSettled = true;
            cancelResult.reject(reason);
        };

        const flushBranch = (branchIndex: 0 | 1): void => {
            const controller = pending[branchIndex];
            if (!controller) return;
            const branch = branches[branchIndex];
            if (!branch) {
                pending[branchIndex] = null;
                return;
            }
            if (error !== undefined) {
                pending[branchIndex] = null;
                controller.error(error);
                return;
            }
            if (branch.length > 0) {
                pending[branchIndex] = null;
                controller.enqueue(shiftQueued(branch));
                return;
            }
            if (done) {
                pending[branchIndex] = null;
                controller.close();
            }
        };

        const hasPendingLiveBranch = (): boolean =>
            (pending[0] !== null && branches[0] !== null) ||
            (pending[1] !== null && branches[1] !== null);

        const pump = (): void => {
            flushBranch(0);
            flushBranch(1);
            if (reading || done || error !== undefined || !hasPendingLiveBranch()) return;

            reading = true;
            reader.read().then(({ done: readDone, value }) => {
                reading = false;
                if (readDone) {
                    done = true;
                    resolveCancel();
                } else {
                    if (branches[0]) branches[0].push(value);
                    if (branches[1]) branches[1].push(value);
                }
                flushBranch(0);
                flushBranch(1);
                pump();
            }, (err) => {
                reading = false;
                error = err;
                rejectCancel(err);
                flushBranch(0);
                flushBranch(1);
            });
        };

        const createBranch = (branchIndex: 0 | 1): globalThis.ReadableStream<R> => new ReadableStream<R>({
            pull(controller) {
                const defaultController = controller as ReadableStreamDefaultController<R>;
                pending[branchIndex] = defaultController;
                pump();
            },
            cancel(reason) {
                // Clear this branch's buffer so the live branch stops pushing into it.
                branches[branchIndex] = null;
                pending[branchIndex] = null;
                branchCanceled[branchIndex] = true;
                cancelReasons[branchIndex] = reason;
                // If both branches are cancelled, cancel the underlying reader.
                if (branchCanceled[0] && branchCanceled[1]) {
                    void reader.cancel(cancelReasons).then(resolveCancel, rejectCancel);
                }
                return cancelResult.promise;
            }
        });

        return [createBranch(0), createBranch(1)];
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<R> {
        return this.values();
    }

    values(options?: { preventCancel?: boolean }): AsyncIterableIterator<R> {
        const reader = this.getReader();
        const preventCancel = options?.preventCancel === true;
        let finished = false;
        let released = false;

        const release = () => {
            if (released) return;
            released = true;
            reader.releaseLock();
        };

        const iterator: AsyncIterableIterator<R> = {
            async next(): Promise<IteratorResult<R>> {
                if (finished) return { value: undefined, done: true };
                try {
                    const result = await reader.read();
                    if (result.done) {
                        finished = true;
                        release();
                        return { value: undefined, done: true };
                    }
                    return result;
                } catch (error) {
                    finished = true;
                    release();
                    throw error;
                }
            },
            async return(value?: R): Promise<IteratorResult<R>> {
                if (!finished) {
                    finished = true;
                    // Release synchronously: `cancel()` captures the stream before
                    // its first await, and QuickJS's for-await does not await this
                    // method on `break`, so a release behind the await would leave
                    // the stream locked for a whole macrotask.
                    const cancelled = preventCancel ? undefined : reader.cancel();
                    release();
                    await cancelled;
                }
                return { value, done: true };
            },
            async throw(error?: unknown): Promise<IteratorResult<R>> {
                if (!finished) {
                    finished = true;
                    const cancelled = reader.cancel(error);
                    release();
                    await cancelled;
                }
                throw error;
            },
            [Symbol.asyncIterator]() {
                return this;
            }
        };

        return iterator;
    }

    // Internal bridge
    get _controller() { return this.#controller; }
    _releaseLock() { this.#reader = null; }
}

Object.defineProperty(ReadableStream.prototype, Symbol.toStringTag, {
    value: 'ReadableStream',
    configurable: true,
});

// ReadableStreamDefaultReader
class ReadableStreamDefaultReader<R = unknown> implements globalThis.ReadableStreamDefaultReader<R> {
    #stream: ReadableStream<R> | null;
    #closedPromise: Promise<void>;
    #closedReject: (reason?: unknown) => void;

    constructor(stream: ReadableStream<R>) {
        this.#stream = stream;

        const { promise, resolve, reject } = Promise.withResolvers<void>();
        this.#closedPromise = promise;
        this.#closedReject = reject;
        void promise.catch(() => {});

        stream._controller._addClosedCallback(resolve, reject);
    }

    get closed(): Promise<void> {
        return this.#closedPromise;
    }

    async read(): Promise<ReadableStreamReadResult<R>> {
        if (!this.#stream) {
            throw new TypeError('Reader is released');
        }

        const { promise, resolve, reject } = Promise.withResolvers<ReadableStreamReadResult<R>>();
        this.#stream._controller._addPendingRead(resolve, reject);
        return promise;
    }

    async cancel(reason?: unknown): Promise<void> {
        if (!this.#stream) {
            throw new TypeError('Reader is released');
        }
        await this.#stream._controller._cancel(reason);
    }

    releaseLock(): void {
        if (!this.#stream) return;
        const error = new TypeError('Reader was released');
        this.#stream._controller._releasePendingReads(error);
        this.#closedReject(error);
        this.#stream._releaseLock();
        this.#stream = null;
    }
}

// WritableStream State Machine
class WritableStreamController<W = unknown> implements globalThis.WritableStreamDefaultController {
    #state: 'writable' | 'closing' | 'closed' | 'errored' = 'writable';
    #sink: UnderlyingSink<W>;
    #sizeAlgorithm: (chunk: W) => number;
    #highWaterMark: number;
    #queueSize = 0;
    #storedError: unknown = undefined;
    #abortController = new AbortController();
    #closedCallbacks: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];
    #readyCallbacks: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];
    #startPromise: Promise<void>;
    #operation: Promise<void> = Promise.resolve();
    #abortPromise: Promise<void> | null = null;

    constructor(sink: UnderlyingSink<W>, strategy: QueuingStrategy<W>) {
        this.#sink = sink;
        this.#sizeAlgorithm = extractSizeAlgorithm(strategy);
        this.#highWaterMark = extractHighWaterMark(strategy, 1);

        let startResult: void | PromiseLike<void>;
        try {
            startResult = sink.start?.(this);
            this.#startPromise = Promise.resolve(startResult).then(() => undefined).catch(error => {
                this.error(error);
                throw error;
            });
        } catch (error) {
            this.error(error);
            this.#startPromise = Promise.reject(error);
        }
        void this.#startPromise.catch(() => {});
    }

    get signal(): AbortSignal {
        return this.#abortController.signal;
    }

    error(e?: unknown): void {
        if (this.#state === 'closed' || this.#state === 'errored') return;

        this.#state = 'errored';
        this.#storedError = e;

        for (const cb of this.#closedCallbacks) {
            queueMicrotask(() => cb.reject(e));
        }
        this.#closedCallbacks = [];

        for (const cb of this.#readyCallbacks) {
            queueMicrotask(() => cb.reject(e));
        }
        this.#readyCallbacks = [];
    }

    #getDesiredSize(): number {
        return this.#highWaterMark - this.#queueSize;
    }

    #throwIfErrored(): void {
        if (this.#state === 'errored') throw this.#storedError;
    }

    async #write(chunk: W): Promise<void> {
        // An errored/aborted stream must reject with its stored reason — a generic
        // TypeError loses the cancel/abort cause the caller is branching on.
        if (this.#state === 'errored') throw this.#storedError;
        if (this.#state !== 'writable') {
            throw new TypeError('Stream is not writable');
        }

        const size = Number(this.#sizeAlgorithm(chunk));
        if (Number.isNaN(size) || size < 0) throw new RangeError('Invalid chunk size');
        this.#queueSize += size;

        const operation = this.#operation.then(async () => {
            await this.#startPromise;
            // Only errored/closed may drop a chunk. 'closing' must NOT: a write
            // accepted while writable is already queued ahead of the close
            // request, and close() flips the state synchronously — re-checking
            // for 'writable' here silently discarded every un-awaited write.
            if (this.#state === 'errored' || this.#state === 'closed') {
                throw this.#storedError ?? new TypeError('Stream is not writable');
            }
            try {
                await this.#sink.write?.(chunk, this);
            } catch (error) {
                this.error(error);
                throw error;
            }
        });
        this.#operation = operation.catch(() => {});

        return operation.finally(() => {
            this.#queueSize -= size;
            this.#updateReady();
        });
    }

    async #close(): Promise<void> {
        // Unlike `write`, an errored stream reports an invalid-state TypeError here
        // rather than the stored reason — verified against Node.
        if (this.#state !== 'writable') {
            throw new TypeError('Stream is not writable');
        }

        this.#state = 'closing';
        const operation = this.#operation.then(async () => {
            await this.#startPromise;
            this.#throwIfErrored();
            await this.#sink.close?.();
            this.#throwIfErrored();
            this.#state = 'closed';
            for (const cb of this.#closedCallbacks) cb.resolve();
            this.#closedCallbacks = [];
        }).catch(error => {
            this.error(error);
            throw error;
        });
        this.#operation = operation.catch(() => {});
        return operation;
    }

    async #abort(reason?: unknown): Promise<void> {
        if (this.#abortPromise) return this.#abortPromise;
        if (this.#state === 'closed') return;
        if (this.#state === 'errored') return;

        this.#abortController.abort(reason);
        this.#state = 'errored';
        this.#storedError = reason;
        for (const cb of this.#closedCallbacks) cb.reject(reason);
        this.#closedCallbacks = [];
        for (const cb of this.#readyCallbacks) cb.reject(reason);
        this.#readyCallbacks = [];

        this.#abortPromise = (async () => {
            await this.#operation.catch(() => {});
            await this.#sink.abort?.(reason);
        })();
        return this.#abortPromise;
    }

    #updateReady(): void {
        if (this.#getDesiredSize() > 0) {
            for (const cb of this.#readyCallbacks) {
                cb.resolve();
            }
            this.#readyCallbacks = [];
        }
    }

    #addReadyCallback(resolve: () => void, reject: (reason?: unknown) => void): void {
        if (this.#state === 'errored') {
            queueMicrotask(() => reject(this.#storedError));
        } else if (this.#state !== 'writable') {
            resolve();
        } else if (this.#getDesiredSize() > 0) {
            resolve();
        } else {
            this.#readyCallbacks.push({ resolve, reject });
        }
    }

    #addClosedCallback(resolve: () => void, reject: (reason?: unknown) => void): void {
        if (this.#state === 'closed') {
            resolve();
        } else if (this.#state === 'errored') {
            queueMicrotask(() => reject(this.#storedError));
        } else {
            this.#closedCallbacks.push({ resolve, reject });
        }
    }

    get _state() { return this.#state; }
    get _storedError() { return this.#storedError; }
    _write(chunk: W) { return this.#write(chunk); }
    _close() { return this.#close(); }
    _abort(reason?: unknown) { return this.#abort(reason); }
    _getDesiredSize() { return this.#getDesiredSize(); }
    _addReadyCallback(resolve: () => void, reject: (reason?: unknown) => void) { this.#addReadyCallback(resolve, reject); }
    _addClosedCallback(resolve: () => void, reject: (reason?: unknown) => void) { this.#addClosedCallback(resolve, reject); }
}

// WritableStream
export class WritableStream<W = unknown> implements globalThis.WritableStream<W> {
    #controller: WritableStreamController<W>;
    #writer: WritableStreamDefaultWriter<W> | null = null;

    constructor(sink: UnderlyingSink<W> = {}, strategy: QueuingStrategy<W> = {}) {
        this.#controller = new WritableStreamController(sink, strategy);
    }

    get locked(): boolean {
        return this.#writer !== null;
    }

    async abort(reason?: unknown): Promise<void> {
        if (this.locked) {
            throw new TypeError('Stream is locked');
        }
        await this.#controller._abort(reason);
    }

    async close(): Promise<void> {
        if (this.locked) {
            throw new TypeError('Stream is locked');
        }
        await this.#controller._close();
    }

    getWriter(): WritableStreamDefaultWriter<W> {
        if (this.locked) {
            throw new TypeError('Stream is already locked');
        }
        this.#writer = new WritableStreamDefaultWriter(this);
        return this.#writer;
    }

    get _controller() { return this.#controller; }
    _releaseLock() { this.#writer = null; }
}

// WritableStreamDefaultWriter
class WritableStreamDefaultWriter<W = unknown> implements globalThis.WritableStreamDefaultWriter<W> {
    #stream: WritableStream<W> | null;
    #readyPromise: Promise<void>;
    #closedPromise: Promise<void>;
    #readyReject: (reason?: unknown) => void;
    #closedReject: (reason?: unknown) => void;

    constructor(stream: WritableStream<W>) {
        this.#stream = stream;

        const ready = Promise.withResolvers<void>();
        this.#readyPromise = ready.promise;
        this.#readyReject = ready.reject;
        void ready.promise.catch(() => {});
        stream._controller._addReadyCallback(ready.resolve, ready.reject);

        const closed = Promise.withResolvers<void>();
        this.#closedPromise = closed.promise;
        this.#closedReject = closed.reject;
        void closed.promise.catch(() => {});
        stream._controller._addClosedCallback(closed.resolve, closed.reject);
    }

    get closed(): Promise<void> {
        return this.#closedPromise;
    }

    get desiredSize(): number | null {
        if (!this.#stream) throw new TypeError('Writer is released');
        const state = this.#stream._controller._state;
        if (state === 'errored' || state === 'closed') return null;
        return state === 'closing' ? 0 : this.#stream._controller._getDesiredSize();
    }

    get ready(): Promise<void> {
        return this.#readyPromise;
    }

    async abort(reason?: unknown): Promise<void> {
        if (!this.#stream) throw new TypeError('Writer is released');
        await this.#stream._controller._abort(reason);
    }

    async close(): Promise<void> {
        if (!this.#stream) throw new TypeError('Writer is released');
        await this.#stream._controller._close();
    }

    releaseLock(): void {
        if (!this.#stream) return;
        const error = new TypeError('Writer was released');
        this.#readyReject(error);
        this.#closedReject(error);

        const ready = Promise.reject<void>(error);
        void ready.catch(() => {});
        this.#readyPromise = ready;

        const closed = Promise.reject<void>(error);
        void closed.catch(() => {});
        this.#closedPromise = closed;

        this.#stream._releaseLock();
        this.#stream = null;
    }

    write(chunk: W): Promise<void> {
        if (!this.#stream) return Promise.reject(new TypeError('Writer is released'));

        // The chunk must be enqueued *now*, not after `ready` settles: `ready` and
        // `desiredSize` are the backpressure signal, so gating the enqueue on them
        // makes the queue accounting lag a microtask and `ready` never go pending.
        // Ordering is still guaranteed — the controller serialises writes itself.
        const stream = this.#stream;
        const write = stream._controller._write(chunk);
        void write.catch(() => {});
        const ready = Promise.withResolvers<void>();
        this.#readyPromise = ready.promise;
        this.#readyReject = ready.reject;
        void ready.promise.catch(() => {});
        stream._controller._addReadyCallback(ready.resolve, ready.reject);
        return write;
    }
}

// TransformStream
export class TransformStream<I = unknown, O = unknown> implements globalThis.TransformStream<I, O> {
    readonly readable: globalThis.ReadableStream<O>;
    readonly writable: globalThis.WritableStream<I>;

    constructor(
        transformer: Transformer<I, O> = {},
        writableStrategy: QueuingStrategy<I> = {},
        readableStrategy: QueuingStrategy<O> = {}
    ) {
        // ReadableStream invokes source.start() synchronously before its first
        // await, so this is assigned before the constructor reads it below.
        let readableController!: ReadableStreamDefaultController<O>;
        let transformController: TransformStreamDefaultController<O>;
        let writableRef: WritableStream<I>;
        let startError: unknown;
        let started = false;
        let backpressured = false;
        let releaseBackpressure = () => {};
        let backpressureChange = Promise.resolve();

        const setBackpressure = (): void => {
            if (backpressured) return;
            backpressured = true;
            const change = Promise.withResolvers<void>();
            releaseBackpressure = change.resolve;
            backpressureChange = change.promise;
        };
        const clearBackpressure = (): void => {
            if (!backpressured) return;
            backpressured = false;
            releaseBackpressure();
        };
        const waitForBackpressure = (signal: AbortSignal): Promise<void> => {
            if (!backpressured) return Promise.resolve();
            if (signal.aborted) return Promise.reject(signal.reason);
            return new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    signal.removeEventListener('abort', onAbort);
                    reject(signal.reason);
                };
                signal.addEventListener('abort', onAbort, { once: true });
                backpressureChange.then(() => {
                    signal.removeEventListener('abort', onAbort);
                    resolve();
                });
            });
        };

        // A byte-oriented TransformStream is not implementable here, and the spec
        // requires a RangeError rather than silently ignoring the request.
        for (const key of ['readableType', 'writableType'] as const) {
            if (Reflect.get(transformer, key) !== undefined) {
                throw new RangeError(`Invalid ${key}`);
            }
        }

        this.readable = new ReadableStream<O>({
            start(c) {
                readableController = c as ReadableStreamDefaultController<O>;
                transformController = {
                    get desiredSize() { return readableController.desiredSize; },
                    enqueue(chunk?: O) { readableController.enqueue(chunk as O); },
                    error(reason?: unknown) {
                        clearBackpressure();
                        readableController.error(reason);
                        writableRef?._controller.error(reason);
                    },
                    // Spec: terminate closes the readable AND errors the writable,
                    // so a later write() rejects instead of being silently accepted.
                    terminate() {
                        clearBackpressure();
                        readableController.close();
                        writableRef?._controller.error(new TypeError('Stream is terminated'));
                    },
                };
                started = true;
                // ReadableStream swallows a start() rejection into its own error
                // state; the TransformStream constructor must rethrow it instead.
                try {
                    return transformer.start?.(transformController);
                } catch (error) {
                    startError = error;
                    throw error;
                }
            },
            pull() {
                clearBackpressure();
            },
            // Error the writable through its internal controller: the public
            // abort() rejects while a pipeTo writer holds the lock, which would
            // strand the producer instead of propagating the cancel upstream.
            cancel: async (reason) => {
                clearBackpressure();
                await writableRef._controller._abort(reason);
            }
        }, readableStrategy, transformReadableDefault) as globalThis.ReadableStream<O>;
        const readable = this.readable as ReadableStream<O>;
        readable._controller._onDequeueCallback = () => {
            if ((readableController.desiredSize ?? 0) > 0) clearBackpressure();
        };
        if ((readableController.desiredSize ?? 0) <= 0) setBackpressure();

        const writable = new WritableStream<I>({
            write: async (chunk, controller) => {
                // No `transform` means the identity transform — the chunk must be
                // enqueued, not dropped. And a throwing transform has to error the
                // *readable* too: erroring only the writable leaves every consumer
                // waiting on a read that can never settle.
                try {
                    await waitForBackpressure(controller.signal);
                    if (controller.signal.aborted) throw controller.signal.reason;
                    if (transformer.transform) await transformer.transform(chunk, transformController);
                    else readableController.enqueue(chunk as unknown as O);
                    if ((readableController.desiredSize ?? 0) <= 0) setBackpressure();
                } catch (error) {
                    readableController.error(error);
                    throw error;
                }
            },
            close: async () => {
                try {
                    await transformer.flush?.(transformController);
                } catch (error) {
                    readableController.error(error);
                    throw error;
                }
                readableController.close();
            },
            abort: async (reason) => {
                clearBackpressure();
                readableController.error(reason);
            }
        }, writableStrategy);
        this.writable = writable as globalThis.WritableStream<I>;

        writableRef = writable;
        if (started && startError !== undefined) throw startError;
    }
}

// QueuingStrategies
// Per spec both members are *readonly attributes* on the prototype (not own data
// properties and not a plain `size` method), `highWaterMark` is a required dictionary
// member, and the accessors are brand-checked. `size` is one shared function per class:
// Node and Deno both report `a.size === b.size` across instances.
const countSizeFunction = function size(): number {
    return 1;
};
const byteSizeFunction = function size(chunk: ArrayBufferView): number {
    return chunk.byteLength;
};

// `highWaterMark` is an unrestricted double, so -1/NaN/Infinity are stored as-is here
// and only rejected later by validateHighWaterMark when a stream actually uses them.
const extractStrategyInit = (init: unknown, className: string): number => {
    if (init === null || typeof init !== 'object') {
        throw new TypeError(`Failed to construct '${className}': the 'init' argument must be an object`);
    }
    const highWaterMark = (init as { highWaterMark?: unknown }).highWaterMark;
    if (highWaterMark === undefined) {
        throw new TypeError(
            `Failed to construct '${className}': required member 'highWaterMark' is undefined`
        );
    }
    return Number(highWaterMark);
};

export class CountQueuingStrategy implements globalThis.CountQueuingStrategy {
    #highWaterMark: number;

    constructor(init: { highWaterMark: number }) {
        this.#highWaterMark = extractStrategyInit(init, 'CountQueuingStrategy');
    }

    get highWaterMark(): number {
        if (!(#highWaterMark in this)) throw new TypeError('Illegal invocation');
        return this.#highWaterMark;
    }

    get size(): (chunk: unknown) => number {
        if (!(#highWaterMark in this)) throw new TypeError('Illegal invocation');
        return countSizeFunction;
    }
}

export class ByteLengthQueuingStrategy implements globalThis.ByteLengthQueuingStrategy {
    #highWaterMark: number;

    constructor(init: { highWaterMark: number }) {
        this.#highWaterMark = extractStrategyInit(init, 'ByteLengthQueuingStrategy');
    }

    get highWaterMark(): number {
        if (!(#highWaterMark in this)) throw new TypeError('Illegal invocation');
        return this.#highWaterMark;
    }

    get size(): (chunk: ArrayBufferView) => number {
        if (!(#highWaterMark in this)) throw new TypeError('Illegal invocation');
        return byteSizeFunction;
    }
}

// WebIDL attributes are enumerable; class getters default to enumerable:false.
for (const [Ctor, tag] of [
    [CountQueuingStrategy, 'CountQueuingStrategy'],
    [ByteLengthQueuingStrategy, 'ByteLengthQueuingStrategy']
] as const) {
    for (const key of ['highWaterMark', 'size'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
        if (descriptor) Object.defineProperty(Ctor.prototype, key, { ...descriptor, enumerable: true });
    }
    Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: tag, configurable: true });
}

// TextEncoderStream
export class TextEncoderStream implements globalThis.TextEncoderStream {
    readonly encoding = 'utf-8';
    readonly readable: globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: globalThis.WritableStream<string>;

    constructor() {
        const encoder = new TextEncoder();
        let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
        let writableRef: WritableStream<string>;
        // A surrogate pair may straddle a chunk boundary. Encoding each chunk
        // independently turned both halves into U+FFFD and silently destroyed
        // the character, so a trailing high surrogate is held for the next chunk.
        let pendingHigh = '';

        this.readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(c) {
                controller = c as ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
            },
            // Internal controller, not the public abort(): a pipeTo writer holds
            // the lock, so abort() would throw and strand the producer.
            cancel(reason) {
                return writableRef._controller._abort(reason);
            }
        }) as globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;

        const writable = new WritableStream<string>({
            write(chunk) {
                let s = pendingHigh + String(chunk);
                pendingHigh = '';
                // Hold back a lone trailing high surrogate; its low half, if any,
                // arrives in the next chunk.
                const last = s.charCodeAt(s.length - 1);
                if (s.length > 0 && last >= 0xd800 && last <= 0xdbff) {
                    pendingHigh = s.slice(-1);
                    s = s.slice(0, -1);
                }
                if (s.length === 0) return;
                controller.enqueue(encoder.encode(s));
            },
            close() {
                // An unpaired high surrogate at end of stream is a replacement char.
                if (pendingHigh) {
                    const tail = encoder.encode(pendingHigh);
                    pendingHigh = '';
                    controller.enqueue(tail);
                }
                controller.close();
            },
            abort(reason) {
                controller.error(reason);
            }
        });
        this.writable = writable as globalThis.WritableStream<string>;
        writableRef = writable;
    }
}

// TextDecoderStream
export class TextDecoderStream implements globalThis.TextDecoderStream {
    readonly encoding: string;
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;
    readonly readable: globalThis.ReadableStream<string>;
    readonly writable: globalThis.WritableStream<AllowSharedBufferSource>;

    private decoder: TextDecoder;
    private controller: ReadableStreamDefaultController<string> | null = null;

    constructor(label?: string, options?: TextDecoderOptions) {
        this.decoder = new TextDecoder(label, options);
        this.encoding = this.decoder.encoding;
        this.fatal = this.decoder.fatal;
        this.ignoreBOM = this.decoder.ignoreBOM;
        let writableRef: WritableStream<AllowSharedBufferSource>;

        this.readable = new ReadableStream<string>({
            start: (c) => {
                this.controller = c as ReadableStreamDefaultController<string>;
            },
            // Internal controller, not the public abort(): a pipeTo writer holds
            // the lock, so abort() would throw and strand the producer.
            cancel(reason) {
                return writableRef._controller._abort(reason);
            }
        }) as globalThis.ReadableStream<string>;

        const writable = new WritableStream<AllowSharedBufferSource>({
            write: (chunk) => {
                const decoded = this.decoder.decode(chunk, { stream: true });
                if (decoded) {
                    this.controller?.enqueue(decoded);
                }
            },
            close: () => {
                const decoded = this.decoder.decode();
                if (decoded) {
                    this.controller?.enqueue(decoded);
                }
                this.controller?.close();
            },
            abort: (reason) => {
                this.controller?.error(reason);
            }
        });
        this.writable = writable as globalThis.WritableStream<AllowSharedBufferSource>;
        writableRef = writable;
    }
}

export class CompressionStream implements globalThis.CompressionStream {
    readonly readable: globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: globalThis.WritableStream<BufferSource>;

    private handle: CModuleZLib.Deflate | null;
    private controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | null = null;

    constructor(format: CompressionFormat) {
        if (format !== 'gzip' && format !== 'deflate' && format !== 'deflate-raw') {
            throw new TypeError(`Unsupported compression format: ${format}`);
        }

        if (format === 'gzip') {
            this.handle = zlib.createGzip(zlib.DEFAULT_COMPRESSION, zlib.DEFAULT_STRATEGY, 8);
        } else if (format === 'deflate') {
            this.handle = zlib.createDeflate(zlib.DEFAULT_COMPRESSION, zlib.DEFAULT_STRATEGY, 8);
        } else if (format === 'deflate-raw') {
            this.handle = zlib.createDeflateRaw(zlib.DEFAULT_COMPRESSION, zlib.DEFAULT_STRATEGY, 8);
        } else {
            throw new TypeError(`Unsupported compression format: ${format}`);
        }

        this.readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start: (c) => {
                this.controller = c as ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
            }
        }) as globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;

        this.writable = new WritableStream<BufferSource>({
            write: (chunk) => {
                if (!this.handle) throw new TypeError('CompressionStream is closed');
                const output = this.handle.deflate(chunk);
                if (output && output.byteLength > 0) {
                    this.controller?.enqueue(new Uint8Array(output));
                }
            },
            close: () => {
                if (!this.handle) return;
                const output = this.handle.finish();
                if (output && output.byteLength > 0) {
                    this.controller?.enqueue(new Uint8Array(output));
                }
                this.controller?.close();
                closeHandle(this.handle as ClosableHandle);
                this.handle = null;
            },
            abort: (reason) => {
                this.controller?.error(reason);
                closeHandle(this.handle as ClosableHandle | null);
                this.handle = null;
            }
        }) as globalThis.WritableStream<BufferSource>;
    }
}

// A finished inflate handle reports "already finished" rather than succeeding; both
// mean the member completed, so only *other* failures indicate truncated input.
const isAlreadyFinished = (error: unknown): boolean =>
    error instanceof Error && /already finished/i.test(error.message);

const asDecompressError = (error: unknown): TypeError =>
    error instanceof TypeError
        ? error
        : new TypeError(error instanceof Error ? error.message : String(error));

export class DecompressionStream implements globalThis.DecompressionStream {
    readonly readable: globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: globalThis.WritableStream<BufferSource>;

    private handle: CModuleZLib.Inflate | null;
    private controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | null = null;
    private wroteInput = false;

    constructor(format: CompressionFormat) {
        if (format !== 'gzip' && format !== 'deflate' && format !== 'deflate-raw') {
            throw new TypeError(`Unsupported decompression format: ${format}`);
        }

        if (format === 'gzip') {
            this.handle = zlib.createGunzip();
        } else if (format === 'deflate') {
            this.handle = zlib.createInflate();
        } else if (format === 'deflate-raw') {
            this.handle = zlib.createInflateRaw();
        } else {
            throw new TypeError(`Unsupported decompression format: ${format}`);
        }

        this.readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start: (c) => {
                this.controller = c as ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
            }
        }) as globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;

        this.writable = new WritableStream<BufferSource>({
            write: (chunk) => {
                if (!this.handle) throw new TypeError('DecompressionStream is closed');
                if (chunk.byteLength > 0) this.wroteInput = true;
                let output: ArrayBuffer;
                try {
                    output = this.handle.inflate(chunk);
                } catch (error) {
                    // Corrupt input. The readable must be errored too: erroring only the
                    // writable left every consumer of `readable` awaiting a chunk that
                    // never arrived, so a garbage body hung instead of rejecting.
                    const reason = asDecompressError(error);
                    this.controller?.error(reason);
                    closeHandle(this.handle as ClosableHandle | null);
                    this.handle = null;
                    throw reason;
                }
                if (output && output.byteLength > 0) {
                    this.controller?.enqueue(new Uint8Array(output));
                }
            },
            close: () => {
                if (!this.handle) return;
                try {
                    if (!this.wroteInput) {
                        throw new TypeError('corrupt gzip stream does not have a matching checksum');
                    }
                    // `inflate()` returns partial output for input that stops mid-member
                    // without reporting anything, so ask the handle to finish: only
                    // success or "already finished" means the stream really ended.
                    let tail: ArrayBuffer | undefined;
                    try {
                        tail = this.handle.finish();
                    } catch (error) {
                        if (!isAlreadyFinished(error)) {
                            throw new TypeError('unexpected end of file');
                        }
                    }
                    if (tail && tail.byteLength > 0) {
                        this.controller?.enqueue(new Uint8Array(tail));
                    }
                    this.controller?.close();
                } catch (error) {
                    if (isAlreadyFinished(error)) {
                        this.controller?.close();
                        return;
                    }
                    const reason = asDecompressError(error);
                    this.controller?.error(reason);
                    throw reason;
                } finally {
                    closeHandle(this.handle as ClosableHandle | null);
                    this.handle = null;
                }
            },
            abort: (reason) => {
                this.controller?.error(reason);
                closeHandle(this.handle as ClosableHandle | null);
                this.handle = null;
            }
        }) as globalThis.WritableStream<BufferSource>;
    }
}

// Export to global. The reader/writer/controller constructors are part of the
// observable surface (`instanceof`, `constructor.name`); only the BYOB trio is
// absent because there is no byte-stream controller behind it.
Object.assign(globalThis, {
    ReadableStream,
    WritableStream,
    TransformStream,
    CountQueuingStrategy,
    ByteLengthQueuingStrategy,
    TextEncoderStream,
    TextDecoderStream,
    CompressionStream,
    DecompressionStream,
    ReadableStreamDefaultReader,
    ReadableStreamDefaultController: ReadableStreamController,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController: WritableStreamController
});
