/**
 * node:stream — every interface and type used across the split.
 *
 * Type-only: this file has no runtime side effects and imports nothing but
 * types, which is what keeps the dependency graph a DAG. The six *shape*
 * interfaces here (Stream/Readable/Writable/Duplex/Transform/PassThrough) are
 * internal: each impl file re-declares the public name as
 * `export interface X extends XShape {}` next to its `export const X`, so the
 * merged type+value pair that mod.ts publishes stays one name with two meanings
 * exactly as it was before the split. Re-exporting these shapes from mod.ts
 * would be a duplicate identifier.
 */

import type { EventEmitter } from '../events';
import type { StringDecoder } from '../string_decoder';

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

export type NextTickHost = { nextTick?: (callback: () => void, ...args: unknown[]) => void };

export type DestroyStateLike = { destroyed: boolean; emitClose: boolean; closed: boolean };
export type DestroyHookHost = Stream & {
    _destroy?(error: Error | null, callback: (error?: Error | null) => void): void;
};

export type PipeCleanupEntry = { source: Stream; cleanup: (emitUnpipe?: boolean) => void };
export type PipeTrackedWritable = Writable & { __pipeCleanups?: PipeCleanupEntry[] };
export type MaybePausable = { pause?: () => unknown; resume?: () => unknown; destroyed?: boolean };
export type StreamListener = (...args: unknown[]) => void;
export type ReadableWrappedSource = EventEmitter & MaybePausable;

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
export type BaseStreamState = DestroyStateLike;

export type ReadableState = {
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

export type ReadableTarget = {
    _readableState: ReadableState;
    readableLength: number;
    readableDidRead: boolean;
    _read(size: number): void;
    _emitReadableEndIfNeeded(): void;
    emit(event: string, ...args: unknown[]): boolean;
};

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

export type WritableState = {
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

export interface Transform extends Duplex {
    _transform(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void): void;
    _flush?(callback: (error?: Error | null, data?: unknown) => void): void;
}

export interface TransformConstructor {
    new (options?: TransformOptions): Transform;
    (options?: TransformOptions): Transform;
    prototype: Transform;
}

export interface PassThrough extends Transform {}

export interface PassThroughConstructor {
    new (options?: TransformOptions): PassThrough;
    (options?: TransformOptions): PassThrough;
    prototype: PassThrough;
}
