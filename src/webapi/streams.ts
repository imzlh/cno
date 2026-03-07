/**
 * Web Streams API implementation with ES2024
 * State machine based design with proper pull timing
 */

import { assert } from "../utils/assert";

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

// ReadableStream State Machine
class ReadableStreamController<R = any> implements globalThis.ReadableStreamDefaultController<R> {
    #state: 'readable' | 'closed' | 'errored' = 'readable';
    #source: UnderlyingSource<R>;
    #sizeAlgorithm: (chunk: R) => number;
    #highWaterMark: number;
    #queue: Array<{ chunk: R; size: number }> = [];
    #queueSize = 0;
    #started = false;
    #closeRequested = false;
    #pulling = false;
    #pullAgain = false;
    #storedError: any = undefined;
    #pendingReads: Array<{
        resolve: (result: ReadableStreamReadResult<R>) => void;
        reject: (reason: any) => void;
    }> = [];
    #closedCallbacks: Array<{ resolve: () => void; reject: (e: any) => void }> = [];

    constructor(source: UnderlyingSource<R>, strategy: QueuingStrategy<R>) {
        this.#source = source;
        this.#sizeAlgorithm = extractSizeAlgorithm(strategy);
        this.#highWaterMark = extractHighWaterMark(strategy, 1);
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

        // If there's a pending read, fulfill it directly
        if (this.#pendingReads.length > 0) {
            const read = this.#pendingReads.shift()!;
            read.resolve({ value: chunk, done: false });
            this.#callPullIfNeeded();
            return;
        }

        // Otherwise enqueue
        const size = this.#sizeAlgorithm(chunk);
        this.#queue.push({ chunk, size });
        this.#queueSize += size;
    }

    close(): void {
        if (this.#state !== 'readable') return;
        if (this.#closeRequested) return;

        this.#closeRequested = true;

        // If queue is empty, finish immediately — any pending reads get done:true.
        // (This handles the case where close() is called from inside pull()
        //  while a pendingRead is waiting for that pull to enqueue something.)
        if (this.#queue.length === 0) {
            this.#finishClose();
        }
    }

    error(e: any): void {
        if (this.#state !== 'readable') return;

        this.#state = 'errored';
        this.#storedError = e;
        this.#queue = [];
        this.#queueSize = 0;

        // Reject all pending reads
        for (const read of this.#pendingReads) {
            read.reject(e);
        }
        this.#pendingReads = [];

        // Reject all closed promises
        for (const cb of this.#closedCallbacks) {
            cb.reject(e);
        }
        this.#closedCallbacks = [];
    }

    // Internal methods
    async #start(): Promise<void> {
        if (this.#started) return;
        this.#started = true;

        try {
            await this.#source.start?.(this);
            this.#callPullIfNeeded();
        } catch (error) {
            this.error(error);
        }
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
            if (read) read.reject(this.#storedError);
            return;
        }

        // Try to dequeue
        if (this.#queue.length > 0) {
            const entry = this.#queue.shift()!;
            this.#queueSize -= entry.size;

            const read = this.#pendingReads.shift()!;
            read.resolve({ value: entry.chunk, done: false });

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

    #callPullIfNeeded(): void {
        if (!this.#shouldPull()) return;

        if (this.#pulling) {
            this.#pullAgain = true;
            return;
        }

        this.#pulling = true;
        this.#pullAgain = false;

        Promise.resolve(this.#source.pull?.(this))
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
        return this.desiredSize! > 0;
    }

    async #cancel(reason?: any): Promise<void> {
        if (this.#state === 'closed') return;

        this.#state = 'closed';
        this.#queue = [];
        this.#queueSize = 0;

        await this.#source.cancel?.(reason);

        for (const cb of this.#closedCallbacks) {
            cb.resolve();
        }
        this.#closedCallbacks = [];
    }

    #finishClose(): void {
        this.#state = 'closed';

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

    _addPendingRead(resolve: any, reject: any) {
        this.#pendingReads.push({ resolve, reject });
        this.#read();
    }

    _addClosedCallback(resolve: any, reject: any) {
        if (this.#state === 'closed') {
            resolve();
        } else if (this.#state === 'errored') {
            reject(this.#storedError);
        } else {
            this.#closedCallbacks.push({ resolve, reject });
        }
    }

    _start() { return this.#start(); }
    _cancel(reason?: any) { return this.#cancel(reason); }
}

// ReadableStream
export class ReadableStream<R = any> implements globalThis.ReadableStream<R> {
    #controller: ReadableStreamController<R>;
    #reader: ReadableStreamDefaultReader<R> | null = null;

    static from<R>(iterable: AsyncIterable<R> | Iterable<R>): ReadableStream<R> {
        let iterator: Iterator<R> | AsyncIterator<R>;

        return new ReadableStream({
            start() {
                // @ts-ignore
                if (iterable[Symbol.asyncIterator]) {
                    // @ts-ignore
                    iterator = iterable[Symbol.asyncIterator]();
                    // @ts-ignore
                } else if (iterable[Symbol.iterator]) {
                    // @ts-ignore
                    iterator = iterable[Symbol.iterator]();
                } else {
                    throw new TypeError('Object is not iterable');
                }
            },
            async pull(c) {
                try {
                    const result = await iterator.next();
                    if (result.done) {
                        c.close();
                    } else {
                        c.enqueue(result.value as any);
                    }
                } catch (error) {
                    c.error(error);
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
    }

    get locked(): boolean {
        return this.#reader !== null;
    }

    // @ts-ignore - byob is not supported
    getReader(type?: 'byob' | 'default'): ReadableStreamDefaultReader<R> {
        assert(type != 'byob', "Byob mode is not supported");
        if (this.locked) {
            throw new TypeError('Stream is already locked');
        }
        this.#reader = new ReadableStreamDefaultReader(this);
        this.#controller._start();
        return this.#reader;
    }

    async cancel(reason?: any): Promise<void> {
        if (this.locked) {
            throw new TypeError('Stream is locked');
        }
        await this.#controller._cancel(reason);
    }

    pipeThrough<T>(
        transform: { writable: globalThis.WritableStream<R>; readable: globalThis.ReadableStream<T> },
        options?: { signal?: AbortSignal; preventClose?: boolean; preventAbort?: boolean; preventCancel?: boolean }
    ): globalThis.ReadableStream<T> {
        this.pipeTo(transform.writable, options);
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

        let aborted = false;
        const abortPromise = signal ?
            new Promise<never>((_, reject) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(signal.reason);
                });
            }) : new Promise<never>(() => { });

        try {
            while (!aborted) {
                const result = await Promise.race([reader.read(), abortPromise]);

                if (result.done) {
                    if (!preventClose) await writer.close();
                    break;
                }

                await writer.write(result.value);
            }
        } catch (error) {
            if (!preventAbort) await writer.abort(error);
            if (!preventCancel) await reader.cancel(error);
            throw error;
        } finally {
            reader.releaseLock();
            writer.releaseLock();
        }
    }

    tee(): [globalThis.ReadableStream<R>, globalThis.ReadableStream<R>] {
        if (this.locked) {
            throw new TypeError('Cannot tee a locked stream');
        }

        const reader = this.getReader();
        const branches: [R[], R[]] = [[], []];
        let reading = false;

        // @ts-ignore
        const createBranch = (branchIndex: 0 | 1): globalThis.ReadableStream => new ReadableStream<R>({
            async pull(controller) {
                // If this branch has queued chunks, dequeue
                if (branches[branchIndex].length > 0) {
                    controller.enqueue(branches[branchIndex].shift() as any);
                    return;
                }

                // If already reading, wait
                if (reading) return;

                reading = true;
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        return;
                    }

                    // Enqueue to both branches
                    branches[0].push(value);
                    branches[1].push(value);

                    // Dequeue from this branch
                    controller.enqueue(branches[branchIndex].shift() as any);
                } finally {
                    reading = false;
                }
            },
            cancel(reason) {
                return reader.cancel(reason);
            }
        });

        return [createBranch(0), createBranch(1)];
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<R> {
        return this.values();
    }

    async* values(): AsyncIterableIterator<R> {
        const reader = this.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                yield value;
            }
        } finally {
            reader.releaseLock();
        }
    }

    // Internal bridge
    get _controller() { return this.#controller; }
    _releaseLock() { this.#reader = null; }
}

// ReadableStreamDefaultReader
class ReadableStreamDefaultReader<R = any> implements globalThis.ReadableStreamDefaultReader<R> {
    #stream: ReadableStream<R> | null;
    #closedPromise: Promise<void>;

    constructor(stream: ReadableStream<R>) {
        this.#stream = stream;

        const { promise, resolve, reject } = Promise.withResolvers<void>();
        this.#closedPromise = promise;

        // @ts-ignore
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
        // @ts-ignore
        this.#stream._controller._addPendingRead(resolve, reject);
        return promise;
    }

    async cancel(reason?: any): Promise<void> {
        if (!this.#stream) {
            throw new TypeError('Reader is released');
        }
        // @ts-ignore
        await this.#stream._controller._cancel(reason);
    }

    releaseLock(): void {
        if (!this.#stream) return;
        // @ts-ignore
        this.#stream._releaseLock();
        this.#stream = null;
    }
}

// WritableStream State Machine
class WritableStreamController implements globalThis.WritableStreamDefaultController {
    #state: 'writable' | 'closed' | 'erroring' | 'errored' = 'writable';
    #sink: UnderlyingSink;
    #sizeAlgorithm: (chunk: any) => number;
    #highWaterMark: number;
    #queueSize = 0;
    #storedError: any = undefined;
    #abortController = new AbortController();
    #writeRequests: Array<{ resolve: () => void; reject: (e: any) => void }> = [];
    #closedCallbacks: Array<{ resolve: () => void; reject: (e: any) => void }> = [];
    #readyCallbacks: Array<{ resolve: () => void; reject: (e: any) => void }> = [];

    constructor(sink: UnderlyingSink, strategy: QueuingStrategy) {
        this.#sink = sink;
        this.#sizeAlgorithm = extractSizeAlgorithm(strategy);
        this.#highWaterMark = extractHighWaterMark(strategy, 1);

        Promise.resolve(sink.start?.(this))
            .catch(error => this.error(error));
    }

    get signal(): AbortSignal {
        return this.#abortController.signal;
    }

    error(e: any): void {
        if (this.#state === 'closed' || this.#state === 'errored') return;

        this.#state = 'errored';
        this.#storedError = e;

        for (const req of this.#writeRequests) {
            req.reject(e);
        }
        this.#writeRequests = [];

        for (const cb of this.#closedCallbacks) {
            cb.reject(e);
        }
        this.#closedCallbacks = [];

        for (const cb of this.#readyCallbacks) {
            cb.reject(e);
        }
        this.#readyCallbacks = [];
    }

    #getDesiredSize(): number {
        return this.#highWaterMark - this.#queueSize;
    }

    async #write(chunk: any): Promise<void> {
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

    async #abort(reason?: any): Promise<void> {
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

    #addReadyCallback(resolve: any, reject: any): void {
        if (this.#state === 'errored') {
            reject(this.#storedError);
        } else if (this.#getDesiredSize() > 0) {
            resolve();
        } else {
            this.#readyCallbacks.push({ resolve, reject });
        }
    }

    #addClosedCallback(resolve: any, reject: any): void {
        if (this.#state === 'closed') {
            resolve();
        } else if (this.#state === 'errored') {
            reject(this.#storedError);
        } else {
            this.#closedCallbacks.push({ resolve, reject });
        }
    }

    get _state() { return this.#state; }
    get _storedError() { return this.#storedError; }
    _write(chunk: any) { return this.#write(chunk); }
    _close() { return this.#close(); }
    _abort(reason?: any) { return this.#abort(reason); }
    _getDesiredSize() { return this.#getDesiredSize(); }
    _addReadyCallback(resolve: any, reject: any) { this.#addReadyCallback(resolve, reject); }
    _addClosedCallback(resolve: any, reject: any) { this.#addClosedCallback(resolve, reject); }
}

// WritableStream
export class WritableStream<W = any> implements globalThis.WritableStream<W> {
    #controller: WritableStreamController;
    #writer: WritableStreamDefaultWriter | null = null;

    constructor(sink: UnderlyingSink<W> = {}, strategy: QueuingStrategy<W> = {}) {
        this.#controller = new WritableStreamController(sink, strategy);
    }

    get locked(): boolean {
        return this.#writer !== null;
    }

    async abort(reason?: any): Promise<void> {
        // @ts-ignore
        await this.#controller._abort(reason);
    }

    async close(): Promise<void> {
        if (this.locked) {
            throw new TypeError('Stream is locked');
        }
        // @ts-ignore
        await this.#controller._close();
    }

    getWriter(): WritableStreamDefaultWriter {
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
class WritableStreamDefaultWriter implements globalThis.WritableStreamDefaultWriter {
    #stream: WritableStream | null;
    #readyPromise: Promise<void>;
    #closedPromise: Promise<void>;

    constructor(stream: WritableStream) {
        this.#stream = stream;

        const ready = Promise.withResolvers<void>();
        this.#readyPromise = ready.promise;
        // @ts-ignore
        stream._controller._addReadyCallback(ready.resolve, ready.reject);

        const closed = Promise.withResolvers<void>();
        this.#closedPromise = closed.promise;
        // @ts-ignore
        stream._controller._addClosedCallback(closed.resolve, closed.reject);
    }

    get closed(): Promise<void> {
        return this.#closedPromise;
    }

    get desiredSize(): number | null {
        if (!this.#stream) throw new TypeError('Writer is released');
        // @ts-ignore
        const state = this.#stream._controller._state;
        // @ts-ignore
        return state === 'writable' ? this.#stream._controller._getDesiredSize() : null;
    }

    get ready(): Promise<void> {
        return this.#readyPromise;
    }

    async abort(reason?: any): Promise<void> {
        if (!this.#stream) throw new TypeError('Writer is released');
        // @ts-ignore
        await this.#stream._controller._abort(reason);
    }

    async close(): Promise<void> {
        if (!this.#stream) throw new TypeError('Writer is released');
        // @ts-ignore
        await this.#stream._controller._close();
    }

    releaseLock(): void {
        if (!this.#stream) return;
        // @ts-ignore
        this.#stream._releaseLock();
        this.#stream = null;
    }

    async write(chunk: any): Promise<void> {
        if (!this.#stream) throw new TypeError('Writer is released');

        await this.ready;
        // @ts-ignore
        await this.#stream._controller._write(chunk);

        // Update ready promise
        const ready = Promise.withResolvers<void>();
        this.#readyPromise = ready.promise;
        // @ts-ignore
        this.#stream._controller._addReadyCallback(ready.resolve, ready.reject);
    }
}

// TransformStream
export class TransformStream<I = any, O = any> implements globalThis.TransformStream<I, O> {
    // @ts-ignore
    readonly readable: ReadableStream<O>;
    readonly writable: WritableStream<I>;

    constructor(
        transformer: Transformer<I, O> = {},
        writableStrategy: QueuingStrategy<I> = {},
        readableStrategy: QueuingStrategy<O> = {}
    ) {
        let readableController: any;

        this.readable = new ReadableStream<O>({
            start(c) {
                readableController = c;
                return transformer.start?.(c as any);
            },
            cancel: async (reason) => {
                await this.writable.abort(reason);
            }
        }, readableStrategy);

        this.writable = new WritableStream<I>({
            write: async (chunk) => {
                await transformer.transform?.(chunk, readableController);
            },
            close: async () => {
                await transformer.flush?.(readableController);
                readableController.close();
            },
            abort: async (reason) => {
                readableController.error(reason);
            }
        }, writableStrategy);
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

// Export to global
if (typeof globalThis !== 'undefined') {
    Object.assign(globalThis, {
        ReadableStream,
        WritableStream,
        TransformStream,
        CountQueuingStrategy,
        ByteLengthQueuingStrategy
    });
}