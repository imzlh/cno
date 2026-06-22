/**
 * Web Streams API implementation with ES2024
 * State machine based design with proper pull timing
 */

import { assert } from "../utils/assert";

const zlib = import.meta.use('zlib');

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
        void writer.closed.catch(() => {});
        void writer.ready.catch(() => {});

        if (signal?.aborted) {
            reader.releaseLock();
            writer.releaseLock();
            throw signal.reason;
        }

        let aborted = false;
        const abortState: { removeAbortListener?: () => void } = {};
        type AbortResult = { aborted: true; reason: any };
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

        try {
            while (!aborted) {
                const result = await Promise.race([reader.read(), abortPromise]);
                if ('aborted' in result) throw result.reason;

                if (result.done) {
                    if (!preventClose) await writer.close();
                    break;
                }

                const writeResult = await Promise.race([writer.write(result.value).then(() => null), abortPromise]);
                if (writeResult && 'aborted' in writeResult) throw writeResult.reason;
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
            async return(value?: any): Promise<IteratorResult<R>> {
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
            async throw(error?: any): Promise<IteratorResult<R>> {
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
        let writableRef: WritableStream<I>;

        this.readable = new ReadableStream<O>({
            start(c) {
                readableController = c;
                return transformer.start?.(c as any);
            },
            cancel: async (reason) => {
                await writableRef.abort(reason);
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
        let controller: any;

        this.readable = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            }
        }) as any;

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
        }) as any;
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
    private controller: any = null;

    constructor(label?: string, options?: TextDecoderOptions) {
        this.decoder = new TextDecoder(label, options);
        this.encoding = this.decoder.encoding;
        this.fatal = this.decoder.fatal;
        this.ignoreBOM = this.decoder.ignoreBOM;

        this.readable = new ReadableStream<string>({
            start: (c) => {
                this.controller = c;
            }
        }) as any;

        this.writable = new WritableStream<AllowSharedBufferSource>({
            write: (chunk) => {
                const decoded = this.decoder.decode(chunk as Uint8Array, { stream: true });
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
        }) as any;
    }
}

export class CompressionStream implements globalThis.CompressionStream {
    readonly readable: globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: globalThis.WritableStream<BufferSource>;

    private handle: CModuleZLib.Deflate;
    private controller: any = null;

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

        this.readable = new ReadableStream<Uint8Array>({
            start: (c) => {
                this.controller = c;
            }
        }) as any;

        this.writable = new WritableStream<BufferSource>({
            write: (chunk) => {
                const input = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk as Uint8Array;
                const output = this.handle.deflate(input);
                if (output && output.byteLength > 0) {
                    this.controller?.enqueue(new Uint8Array(output));
                }
            },
            close: () => {
                const output = this.handle.finish();
                if (output && output.byteLength > 0) {
                    this.controller?.enqueue(new Uint8Array(output));
                }
                this.controller?.close();
            },
            abort: (reason) => {
                this.controller?.error(reason);
            }
        }) as any;
    }
}

export class DecompressionStream implements globalThis.DecompressionStream {
    readonly readable: globalThis.ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: globalThis.WritableStream<BufferSource>;

    private handle: CModuleZLib.Inflate;
    private controller: any = null;

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

        this.readable = new ReadableStream<Uint8Array>({
            start: (c) => {
                this.controller = c;
            }
        }) as any;

        this.writable = new WritableStream<BufferSource>({
            write: (chunk) => {
                const input = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk as Uint8Array;
                const output = this.handle.inflate(input);
                if (output && output.byteLength > 0) {
                    this.controller?.enqueue(new Uint8Array(output));
                }
            },
            close: () => {
                this.controller?.close();
            },
            abort: (reason) => {
                this.controller?.error(reason);
            }
        }) as any;
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
