/**
 * Web Streams API implementation with ES2024
 * State machine based design with proper pull timing
 */

import { assert } from "../utils/assert";
import { getMemoryTier } from "../utils/memory-tier";

const zlib = import.meta.use('zlib');

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

const extractSizeAlgorithm = <T>(strategy: QueuingStrategy<T> | undefined): (chunk: T) => number => {
    return strategy?.size ?? (() => 1);
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

    constructor(source: UnderlyingSource<R>, strategy: QueuingStrategy<R>) {
        this.#source = source;
        this.#sizeAlgorithm = extractSizeAlgorithm(strategy);
        this.#highWaterMark = extractHighWaterMark(strategy, 1);
        const tier = getMemoryTier();
        this.#maxBackpressureSize = tier === 'low' ? 1 * 1024 * 1024 : tier === 'normal' ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
    }

    get desiredSize(): number | null {
        if (this.#state === 'closed' || this.#state === 'errored') return null;
        return this.#highWaterMark - this.#queueSize;
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
            const size = this.#sizeAlgorithm(chunk);
            if (this.#backpressureBufferSize + size > this.#maxBackpressureSize) {
                throw new TypeError('Backpressure buffer exceeded memory limit');
            }
            this.#backpressureBuffer.push({ chunk, size });
            this.#backpressureBufferSize += size;
            if (this.#onEnqueue) {
                notifyEnqueueQuietly(this.#onEnqueue);
            }
            return;
        }

        // Otherwise enqueue into the main queue.
        const size = this.#sizeAlgorithm(chunk);
        this.#queue.push({ chunk, size });
        this.#queueSize += size;
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
        const desiredSize = this.desiredSize;
        return desiredSize !== null && desiredSize > 0;
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

        await source?.cancel?.(reason);

        for (const read of this.#pendingReads) {
            read.resolve({ value: undefined, done: true });
        }
        this.#pendingReads = [];

        for (const cb of this.#closedCallbacks) {
            cb.resolve();
        }
        this.#closedCallbacks = [];
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
        strategy: QueuingStrategy<R> = {}
    ) {
        this.#controller = new ReadableStreamController(source, strategy);
        void this.#controller._start();
    }

    get locked(): boolean {
        return this.#reader !== null;
    }

    getReader(options: { mode: 'byob' }): ReadableStreamBYOBReader;
    getReader(options?: ReadableStreamGetReaderOptions): ReadableStreamDefaultReader<R>;
    getReader(options?: ReadableStreamGetReaderOptions): ReadableStreamReader<R> {
        assert(options?.mode != 'byob', "Byob mode is not supported");
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
        const pipePromise = this.pipeTo(transform.writable, options);
        void pipePromise.catch(() => {});
        let reader: globalThis.ReadableStreamDefaultReader<T>;

        const source: UnderlyingSource<T> = {
            start(controller) {
                const defaultController = controller as ReadableStreamDefaultController<T>;
                reader = transform.readable.getReader();
                void (async () => {
                    try {
                        for (;;) {
                            const result = await reader.read();
                            if (result.done) {
                                defaultController.close();
                                return;
                            }
                            defaultController.enqueue(result.value as T);
                        }
                    } catch (error) {
                        defaultController.error(error);
                    }
                })();
            },
            async cancel(reason) {
                await reader.cancel(reason);
                await pipePromise.catch(() => {});
            },
        };
        return new ReadableStream<T>(source) as globalThis.ReadableStream<T>;
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
            reader.releaseLock();
            writer.releaseLock();
            throw signal.reason;
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
                // If both branches are cancelled, cancel the underlying reader.
                if (!branches[0] && !branches[1]) {
                    return reader.cancel(reason);
                }
            }
        });

        return [createBranch(0), createBranch(1)];
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<R> {
        return this.values();
    }

    values(): AsyncIterableIterator<R> {
        const reader = this.getReader();
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
                    try {
                        await reader.cancel();
                    } finally {
                        release();
                    }
                }
                return { value, done: true };
            },
            async throw(error?: unknown): Promise<IteratorResult<R>> {
                if (!finished) {
                    finished = true;
                    try {
                        await reader.cancel(error);
                    } finally {
                        release();
                    }
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
    #state: 'writable' | 'closed' | 'erroring' | 'errored' = 'writable';
    #sink: UnderlyingSink<W>;
    #sizeAlgorithm: (chunk: W) => number;
    #highWaterMark: number;
    #queueSize = 0;
    #storedError: unknown = undefined;
    #abortController = new AbortController();
    #writeRequests: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];
    #closedCallbacks: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];
    #readyCallbacks: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];

    constructor(sink: UnderlyingSink<W>, strategy: QueuingStrategy<W>) {
        this.#sink = sink;
        this.#sizeAlgorithm = extractSizeAlgorithm(strategy);
        this.#highWaterMark = extractHighWaterMark(strategy, 1);

        Promise.resolve(sink.start?.(this))
            .catch(error => this.error(error));
    }

    get signal(): AbortSignal {
        return this.#abortController.signal;
    }

    error(e?: unknown): void {
        if (this.#state === 'closed' || this.#state === 'errored') return;

        this.#state = 'errored';
        this.#storedError = e;

        for (const req of this.#writeRequests) {
            queueMicrotask(() => req.reject(e));
        }
        this.#writeRequests = [];

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

    async #write(chunk: W): Promise<void> {
        if (this.#state !== 'writable') {
            throw new TypeError('Stream is not writable');
        }

        const size = this.#sizeAlgorithm(chunk);
        this.#queueSize += size;

        try {
            await this.#sink.write?.(chunk, this);
        } finally {
            this.#queueSize -= size;
            this.#updateReady();
        }
    }

    async #close(): Promise<void> {
        if (this.#state !== 'writable') {
            throw new TypeError('Stream is not writable');
        }

        this.#state = 'closed';
        await this.#sink.close?.();

        for (const cb of this.#closedCallbacks) {
            cb.resolve();
        }
        this.#closedCallbacks = [];
    }

    async #abort(reason?: unknown): Promise<void> {
        if (this.#state === 'closed') return;

        this.#abortController.abort(reason);
        this.#state = 'errored';
        this.#storedError = reason;

        await this.#sink.abort?.(reason);

        for (const cb of this.#closedCallbacks) {
            cb.reject(reason);
        }
        this.#closedCallbacks = [];
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

    constructor(stream: WritableStream<W>) {
        this.#stream = stream;

        const ready = Promise.withResolvers<void>();
        this.#readyPromise = ready.promise;
        void ready.promise.catch(() => {});
        stream._controller._addReadyCallback(ready.resolve, ready.reject);

        const closed = Promise.withResolvers<void>();
        this.#closedPromise = closed.promise;
        void closed.promise.catch(() => {});
        stream._controller._addClosedCallback(closed.resolve, closed.reject);
    }

    get closed(): Promise<void> {
        return this.#closedPromise;
    }

    get desiredSize(): number | null {
        if (!this.#stream) throw new TypeError('Writer is released');
        const state = this.#stream._controller._state;
        return state === 'writable' ? this.#stream._controller._getDesiredSize() : null;
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
        this.#stream._releaseLock();
        this.#stream = null;
    }

    async write(chunk: W): Promise<void> {
        if (!this.#stream) throw new TypeError('Writer is released');

        await this.ready;
        await this.#stream._controller._write(chunk);

        // Update ready promise
        const ready = Promise.withResolvers<void>();
        this.#readyPromise = ready.promise;
        void ready.promise.catch(() => {});
        this.#stream._controller._addReadyCallback(ready.resolve, ready.reject);
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
        let readableController: ReadableStreamDefaultController<O>;
        let transformController: TransformStreamDefaultController<O>;
        let writableRef: globalThis.WritableStream<I>;

        this.readable = new ReadableStream<O>({
            start(c) {
                readableController = c as ReadableStreamDefaultController<O>;
                transformController = {
                    get desiredSize() { return readableController.desiredSize; },
                    enqueue(chunk?: O) { readableController.enqueue(chunk as O); },
                    error(reason?: unknown) { readableController.error(reason); },
                    terminate() { readableController.close(); },
                };
                return transformer.start?.(transformController);
            },
            cancel: async (reason) => {
                await writableRef.abort(reason);
            }
        }, readableStrategy) as globalThis.ReadableStream<O>;

        this.writable = new WritableStream<I>({
            write: async (chunk) => {
                await transformer.transform?.(chunk, transformController);
            },
            close: async () => {
                await transformer.flush?.(transformController);
                readableController.close();
            },
            abort: async (reason) => {
                readableController.error(reason);
            }
        }, writableStrategy) as globalThis.WritableStream<I>;

        writableRef = this.writable;
    }
}

// QueuingStrategies
export class CountQueuingStrategy implements globalThis.CountQueuingStrategy {
    highWaterMark: number;

    constructor(init: { highWaterMark: number }) {
        this.highWaterMark = init.highWaterMark;
    }

    size(): number {
        return 1;
    }
}

export class ByteLengthQueuingStrategy implements globalThis.ByteLengthQueuingStrategy {
    highWaterMark: number;

    constructor(init: { highWaterMark: number }) {
        this.highWaterMark = init.highWaterMark;
    }

    size(chunk: ArrayBufferView): number {
        return chunk.byteLength;
    }
}

// TextEncoderStream
export class TextEncoderStream implements globalThis.TextEncoderStream {
    readonly encoding = 'utf-8';
    readonly readable: globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: globalThis.WritableStream<string>;

    constructor() {
        const encoder = new TextEncoder();
        let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
        let writableRef: globalThis.WritableStream<string>;

        this.readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(c) {
                controller = c as ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
            },
            cancel(reason) {
                return writableRef.abort(reason);
            }
        }) as globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;

        this.writable = new WritableStream<string>({
            write(chunk) {
                const encoded = encoder.encode(chunk);
                controller.enqueue(encoded);
            },
            close() {
                controller.close();
            },
            abort(reason) {
                controller.error(reason);
            }
        }) as globalThis.WritableStream<string>;
        writableRef = this.writable;
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
        let writableRef: globalThis.WritableStream<AllowSharedBufferSource>;

        this.readable = new ReadableStream<string>({
            start: (c) => {
                this.controller = c as ReadableStreamDefaultController<string>;
            },
            cancel(reason) {
                return writableRef.abort(reason);
            }
        }) as globalThis.ReadableStream<string>;

        this.writable = new WritableStream<AllowSharedBufferSource>({
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
        }) as globalThis.WritableStream<AllowSharedBufferSource>;
        writableRef = this.writable;
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
                const output = this.handle.inflate(chunk);
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
                    this.controller?.close();
                } catch (error) {
                    if (error instanceof Error && error.message.includes('already finished')) {
                        this.controller?.close();
                        return;
                    }
                    const reason = error instanceof TypeError
                        ? error
                        : new TypeError(error instanceof Error ? error.message : String(error));
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

// Export to global
Object.assign(globalThis, {
    ReadableStream,
    WritableStream,
    TransformStream,
    CountQueuingStrategy,
    ByteLengthQueuingStrategy,
    TextEncoderStream,
    TextDecoderStream,
    CompressionStream,
    DecompressionStream
});
