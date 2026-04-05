import { EventEmitter } from '../events';

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

// ============================================================================
// Stream 基类
// ============================================================================

export class Stream extends EventEmitter {
    destroyed: boolean = false;

    pipe<T extends Writable>(destination: T, options?: PipeOptions): T {
        this.on('data', (chunk) => {
            if (!destination.write(chunk)) {
                // @ts-ignore - pause may not exist on all streams
                this.pause?.();
            }
        });

        destination.on('drain', () => {
            // @ts-ignore - resume may not exist on all streams
            this.resume?.();
        });

        if (options?.end !== false) {
            this.on('end', () => {
                destination.end();
            });
        }

        this.on('error', (err) => {
            destination.emit('error', err);
        });

        return destination;
    }

    destroy(error?: Error | null): this {
        if (this.destroyed) return this;
        this.destroyed = true;
        if (error) {
            this.emit('error', error);
        }
        this.emit('close');
        return this;
    }
}

// ============================================================================
// Readable
// ============================================================================

export class Readable extends Stream {
    readable: boolean = true;
    readableEnded: boolean = false;
    readableFlowing: boolean | null = null;
    readableHighWaterMark: number;
    readableLength: number = 0;
    readableObjectMode: boolean;
    readableEncoding: BufferEncoding | null = null;
    readableAborted: boolean = false;
    readableDidRead: boolean = false;

    protected _readableState: {
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
    };

    constructor(options?: ReadableOptions) {
        super();
        this.readableObjectMode = options?.objectMode ?? false;
        this.readableHighWaterMark = options?.highWaterMark ?? (this.readableObjectMode ? 16 : 16384);

        this._readableState = {
            buffer: [],
            encoding: options?.encoding ?? null,
            objectMode: this.readableObjectMode,
            highWaterMark: this.readableHighWaterMark,
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
        };

        if (options?.read) {
            (this as any)._read = options.read;
        }
    }

    static from(iterable: Iterable<any> | AsyncIterable<any>, options?: ReadableOptions): Readable {
        const readable = new Readable(options);
        const iterator = (iterable as any)[Symbol.asyncIterator]?.() ?? (iterable as any)[Symbol.iterator]?.();

        readable._read = async () => {
            try {
                const { value, done } = await iterator.next();
                if (done) {
                    readable.push(null);
                } else {
                    readable.push(value);
                }
            } catch (err) {
                readable.destroy(err as Error);
            }
        };

        return readable;
    }

    read(n?: number): any {
        const state = this._readableState;

        if (state.buffer.length === 0) {
            if (state.ended) {
                return null;
            }
            state.needReadable = true;
            return null;
        }

        const chunk = state.buffer.shift();
        this.readableLength = state.buffer.length;

        if (state.ended && state.buffer.length === 0 && !state.endEmitted) {
            state.endEmitted = true;
            this.readableEnded = true;
            this.emit('end');
        }

        return chunk;
    }

    setEncoding(enc: BufferEncoding): this {
        this.readableEncoding = enc;
        return this;
    }

    pause(): this {
        const state = this._readableState;
        if (state.flowing !== false) {
            state.flowing = false;
            this.emit('pause');
        }
        return this;
    }

    resume(): this {
        const state = this._readableState;
        if (!state.flowing) {
            state.flowing = true;
            this.emit('resume');
            this._read(state.highWaterMark);
        }
        return this;
    }

    isPaused(): boolean {
        return this._readableState.flowing === false;
    }

    unpipe(destination?: Writable): this {
        return this;
    }

    unshift(chunk: any, encoding?: BufferEncoding): boolean {
        const state = this._readableState;
        state.buffer.unshift(chunk);
        return true;
    }

    wrap(stream: any): this {
        return this;
    }

    push(chunk: any, encoding?: BufferEncoding): boolean {
        const state = this._readableState;

        if (chunk === null) {
            state.ended = true;
            if (state.buffer.length === 0 && !state.endEmitted) {
                state.endEmitted = true;
                this.readableEnded = true;
                this.emit('end');
            }
            return false;
        }

        state.buffer.push(chunk);
        this.readableLength = state.buffer.length;

        if (state.flowing) {
            this.emit('data', chunk);
        }

        return state.buffer.length < state.highWaterMark;
    }

    _read(size: number): void {
        throw new Error('_read() must be implemented');
    }

    destroy(error?: Error | null): this {
        const state = this._readableState;
        if (state.destroyed) return this;
        state.destroyed = true;
        this.destroyed = true;
        if (error) {
            this.emit('error', error);
        }
        this.emit('close');
        return this;
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<any> {
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
    }
}

// ============================================================================
// Writable
// ============================================================================

export class Writable extends Stream {
    writable: boolean = true;
    writableEnded: boolean = false;
    writableFinished: boolean = false;
    writableHighWaterMark: number;
    writableLength: number = 0;
    writableObjectMode: boolean;
    writableCorked: number = 0;

    protected _writableState: {
        objectMode: boolean;
        highWaterMark: number;
        buffer: Array<{ chunk: any; encoding: BufferEncoding; callback: (error?: Error | null) => void }>;
        writing: boolean;
        corked: number;
        ended: boolean;
        finished: boolean;
        decodeStrings: boolean;
        defaultEncoding: BufferEncoding;
        destroyed: boolean;
    };

    constructor(options?: WritableOptions) {
        super();
        this.writableObjectMode = options?.objectMode ?? false;
        this.writableHighWaterMark = options?.highWaterMark ?? (this.writableObjectMode ? 16 : 16384);

        this._writableState = {
            objectMode: this.writableObjectMode,
            highWaterMark: this.writableHighWaterMark,
            buffer: [],
            writing: false,
            corked: 0,
            ended: false,
            finished: false,
            decodeStrings: true,
            defaultEncoding: 'utf8',
            destroyed: false,
        };

        if (options?.write) {
            (this as any)._write = options.write;
        }
        if (options?.writev) {
            (this as any)._writev = options.writev;
        }
        if (options?.final) {
            (this as any)._final = options.final;
        }
    }

    write(chunk: any, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = 'utf8';
        }

        const state = this._writableState;

        if (state.ended) {
            this.emit('error', new Error('write after end'));
            return false;
        }

        state.buffer.push({ chunk, encoding: encoding as BufferEncoding, callback: callback ?? (() => {}) });
        this.writableLength = state.buffer.length;

        this._write(chunk, encoding as BufferEncoding, callback ?? (() => {}));

        return state.buffer.length < state.highWaterMark;
    }

    setDefaultEncoding(encoding: BufferEncoding): this {
        this._writableState.defaultEncoding = encoding;
        return this;
    }

    end(chunk?: any, encoding?: BufferEncoding | (() => void), callback?: () => void): this {
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
            this.write(chunk, encoding);
        }

        state.ended = true;
        this.writableEnded = true;

        if (callback) {
            this.once('finish', callback);
        }

        this._final?.((err) => {
            if (err) {
                this.emit('error', err);
            } else {
                state.finished = true;
                this.writableFinished = true;
                this.emit('finish');
            }
        }) ?? (() => {
            state.finished = true;
            this.writableFinished = true;
            this.emit('finish');
        })();

        return this;
    }

    cork(): void {
        this._writableState.corked++;
        this.writableCorked = this._writableState.corked;
    }

    uncork(): void {
        const state = this._writableState;
        if (state.corked > 0) {
            state.corked--;
            this.writableCorked = state.corked;
        }
    }

    protected _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        throw new Error('_write() must be implemented');
    }

    protected _writev?(chunks: Array<{ chunk: any; encoding: BufferEncoding }>, callback: (error?: Error | null) => void): void;

    protected _final?(callback: (error?: Error | null) => void): void;

    destroy(error?: Error | null): this {
        const state = this._writableState;
        if (state.destroyed) return this;
        state.destroyed = true;
        this.destroyed = true;
        if (error) {
            this.emit('error', error);
        }
        this.emit('close');
        return this;
    }
}

// ============================================================================
// Duplex
// ============================================================================

export class Duplex extends Writable {
    readable: boolean = true;
    readableEnded: boolean = false;
    readableFlowing: boolean | null = null;
    readableHighWaterMark: number;
    readableLength: number = 0;
    readableObjectMode: boolean;

    protected _readableState: any;

    constructor(options?: DuplexOptions) {
        super(options);
        this.readableObjectMode = options?.objectMode ?? false;
        this.readableHighWaterMark = options?.highWaterMark ?? (this.readableObjectMode ? 16 : 16384);

        this._readableState = {
            buffer: [],
            objectMode: this.readableObjectMode,
            highWaterMark: this.readableHighWaterMark,
            flowing: null,
            ended: false,
            endEmitted: false,
        };

        if (options?.read) {
            (this as any)._read = options.read;
        }
    }

    static fromSource(source: any): Duplex {
        return new Duplex();
    }
}

// ============================================================================
// Transform
// ============================================================================

export class Transform extends Duplex {
    constructor(options?: TransformOptions) {
        super(options);

        if (options?.transform) {
            (this as any)._transform = options.transform;
        }
        if (options?.flush) {
            (this as any)._flush = options.flush;
        }
    }

    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        throw new Error('_transform() must be implemented');
    }

    protected _flush?(callback: (error?: Error | null, data?: any) => void): void;

    push(chunk: any, encoding?: BufferEncoding): boolean {
        // @ts-ignore - push exists on Readable side of Duplex
        return super.push(chunk, encoding);
    }
}

// ============================================================================
// PassThrough
// ============================================================================

export class PassThrough extends Transform {
    constructor(options?: TransformOptions) {
        super(options);
    }

    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        callback(null, chunk);
    }
}

// ============================================================================
// 工厂函数
// ============================================================================

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

// ============================================================================
// promises
// ============================================================================

export namespace promises {
    export async function pipeline(...streams: (Stream | ((stream: Stream) => Stream) | { signal: AbortSignal })[]): Promise<void> {
        const actualStreams = streams.filter(s => s instanceof Stream) as Stream[];
        for (let i = 0; i < actualStreams.length - 1; i++) {
            // @ts-ignore - Stream pipe compatibility
            actualStreams[i].pipe(actualStreams[i + 1]);
        }
        return new Promise((resolve, reject) => {
            const last = actualStreams[actualStreams.length - 1];
            last.on('finish', resolve);
            last.on('error', reject);
        });
    }

    export async function finished(stream: Stream, options?: { error?: boolean; readable?: boolean; writable?: boolean; signal?: AbortSignal }): Promise<void> {
        return new Promise((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('finish', resolve);
            stream.on('error', reject);
        });
    }
}