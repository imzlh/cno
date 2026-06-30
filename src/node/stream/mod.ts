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

// Stream base class

export class Stream extends EventEmitter {
    destroyed: boolean = false;
    // Track piped destinations for unpipe() support
    protected _pipedDestinations: Writable[] = [];

    pipe<T extends Writable>(destination: T, options?: PipeOptions): T {
        const src = this as any;
        let drained = true;

        // Track this destination for unpipe()
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
        };

        const cleanup = () => {
            this.removeListener('data', onData);
            destination.removeListener('drain', onDrain);
            this.removeListener('end', onEnd);
            this.removeListener('error', onError);
            this.removeListener('close', onClose);
            destination.removeListener('close', onDestClose);
        };

        const onError = (err: Error) => {
            cleanup();
            if (!destination.destroyed) destination.destroy(err);
        };

        const onClose = () => {
            if (!destination.destroyed) destination.destroy();
        };

        const onDestClose = () => {
            if (!src.destroyed) src.pause?.();
        };

        this.on('data', onData);
        destination.on('drain', onDrain);
        this.on('end', onEnd);
        this.on('error', onError);
        this.on('close', onClose);
        destination.on('close', onDestClose);

        (destination as any).__pipeCleanup = cleanup;

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

// Readable

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

    // Node.js compat: adding a 'data' listener auto-resumes the stream
    override on(event: string | symbol, fn: (...args: any[]) => void): this {
        super.on(event, fn);
        if (event === 'data') this.resume();
        return this;
    }

    override once(event: string | symbol, fn: (...args: any[]) => void): this {
        super.once(event, fn);
        if (event === 'data') this.resume();
        return this;
    }

    private _emitReadableEndIfNeeded(): void {
        const state = this._readableState;
        if (!state.ended || state.endEmitted || state.buffer.length > 0) return;
        state.endEmitted = true;
        this.readableEnded = true;
        this.emit('end');
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
                this._emitReadableEndIfNeeded();
                return null;
            }
            state.needReadable = true;
            return null;
        }

        const chunk = state.buffer.shift();
        this.readableLength = state.buffer.length;

        this._emitReadableEndIfNeeded();

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
            this._readAndResolve();
        }
        return this;
    }

    private _readAndResolve(): void {
        const state = this._readableState;
        if (!state.flowing) return;

        // Drain buffered data first
        while (state.flowing && state.buffer.length > 0) {
            const chunk = state.buffer.shift();
            this.readableLength = state.buffer.length;
            this.emit('data', chunk);
        }

        if (state.ended) {
            this._emitReadableEndIfNeeded();
            return;
        }

        if (state.flowing) {
            try {
                this._read(state.highWaterMark);
            } catch (err) {
                this.emit('error', err);
            }
        }
    }

    isPaused(): boolean {
        return this._readableState.flowing === false;
    }

    unpipe(destination?: Writable): this {
        const destinations = destination ? [destination] : [...this._pipedDestinations];
        for (const dest of destinations) {
            // Call the cleanup function set by pipe()
            const cleanup = (dest as any).__pipeCleanup;
            if (typeof cleanup === 'function') {
                cleanup();
                delete (dest as any).__pipeCleanup;
            }
            const idx = this._pipedDestinations.indexOf(dest);
            if (idx !== -1) this._pipedDestinations.splice(idx, 1);
        }
        return this;
    }

    unshift(chunk: any, encoding?: BufferEncoding): boolean {
        const state = this._readableState;
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding || state.defaultEncoding);
        }
        // Clear 'end' state since we're pushing data back
        if (state.endEmitted) {
            state.endEmitted = false;
            this.readableEnded = false;
            this.readable = true;
        }
        return this.push(chunk);
    }

    wrap(stream: any): this {
        // Wrap a legacy readable stream (EventEmitter with 'data'/'end'/'error')
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
    }

    push(chunk: any, encoding?: BufferEncoding): boolean {
        const state = this._readableState;

        if (chunk === null) {
            state.ended = true;
            if (state.flowing) this._emitReadableEndIfNeeded();
            return false;
        }

        if (state.flowing) {
            this.emit('data', chunk);
            queueMicrotask(() => this._readAndResolve());
            // Return true if buffer is below high water mark (producer can keep sending)
            return state.buffer.length < state.highWaterMark;
        }

        state.buffer.push(chunk);
        this.readableLength = state.buffer.length;

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
        state.buffer.length = 0;
        this.readableLength = 0;
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

// Writable

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
        awaitDrain: number;
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
            awaitDrain: 0,
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

        if (!state.writing) {
            this._writeBuffered();
        }

        return state.buffer.length < state.highWaterMark;
    }

    private _writeBuffered(): void {
        const state = this._writableState;
        if (state.writing || state.buffer.length === 0) return;

        state.writing = true;
        const { chunk, encoding, callback } = state.buffer[0];

        this._write(chunk, encoding, (err) => {
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
            } else {
                if (state.awaitDrain > 0) {
                    state.awaitDrain = 0;
                    this.emit('drain');
                }
            }
        });
    }

    private _doFinal(): void {
        const state = this._writableState;
        if (state.finished) return;

        const finish = () => {
            state.finished = true;
            this.writableFinished = true;
            this.emit('finish');
        };

        if (this._final) {
            this._final((err) => {
                if (err) {
                    this.emit('error', err);
                } else {
                    finish();
                }
            });
        } else {
            finish();
        }
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
            this.write(chunk, encoding as BufferEncoding);
        }

        if (state.ended) return this;

        state.ended = true;
        this.writableEnded = true;

        if (callback) {
            this.once('finish', callback);
        }

        if (state.writing || state.buffer.length > 0) {
            // Will call _doFinal after buffer drains in _writeBuffered
        } else {
            this._doFinal();
        }

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

// Duplex

export class Duplex extends Writable {
    readable: boolean;
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

    constructor(options?: DuplexOptions) {
        super(options);
        this.readable = options?.readable ?? true;
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

    read(n?: number): any {
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
        this.readableLength = state.buffer.length;

        this._emitReadableEndIfNeeded();

        return chunk;
    }

    setEncoding(enc: BufferEncoding): this {
        this.readableEncoding = enc;
        return this;
    }

    pause(): this {
        if (!this.readable) return this;
        const state = this._readableState;
        if (state.flowing !== false) {
            state.flowing = false;
            this.emit('pause');
        }
        return this;
    }

    resume(): this {
        if (!this.readable) return this;
        const state = this._readableState;
        if (!state.flowing) {
            state.flowing = true;
            this.emit('resume');
            this._duplexReadAndResolve();
        }
        return this;
    }

    // Node.js compat: adding a 'data' listener auto-resumes the readable side
    override on(event: string | symbol, fn: (...args: any[]) => void): this {
        super.on(event, fn);
        if (event === 'data') this.resume();
        return this;
    }

    override once(event: string | symbol, fn: (...args: any[]) => void): this {
        super.once(event, fn);
        if (event === 'data') this.resume();
        return this;
    }

    private _emitReadableEndIfNeeded(): void {
        const state = this._readableState;
        if (!state.ended || state.endEmitted || state.buffer.length > 0) return;
        state.endEmitted = true;
        this.readableEnded = true;
        this.emit('end');
    }

    private _duplexReadAndResolve(): void {
        const state = this._readableState;
        if (!state.flowing) return;

        while (state.flowing && state.buffer.length > 0) {
            const chunk = state.buffer.shift();
            this.readableLength = state.buffer.length;
            this.emit('data', chunk);
        }

        if (state.ended) {
            this._emitReadableEndIfNeeded();
            return;
        }

        if (state.flowing) {
            try {
                this._read(state.highWaterMark);
            } catch (err) {
                this.emit('error', err);
            }
        }
    }

    isPaused(): boolean {
        return this._readableState.flowing === false;
    }

    unpipe(destination?: Writable): this {
        const destinations = destination ? [destination] : [...this._pipedDestinations];
        for (const dest of destinations) {
            const cleanup = (dest as any).__pipeCleanup;
            if (typeof cleanup === 'function') {
                cleanup();
                delete (dest as any).__pipeCleanup;
            }
            const idx = this._pipedDestinations.indexOf(dest);
            if (idx !== -1) this._pipedDestinations.splice(idx, 1);
        }
        return this;
    }

    unshift(chunk: any, encoding?: BufferEncoding): boolean {
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding || this._readableState.defaultEncoding);
        }
        return this.push(chunk);
    }

    push(chunk: any, encoding?: BufferEncoding): boolean {
        if (!this.readable) return false;
        const state = this._readableState;

        if (chunk === null) {
            state.ended = true;
            if (state.flowing) this._emitReadableEndIfNeeded();
            return false;
        }

        if (state.flowing) {
            this.emit('data', chunk);
            queueMicrotask(() => this._duplexReadAndResolve());
        } else {
            state.buffer.push(chunk);
        }
        this.readableLength = state.buffer.length;
        return state.buffer.length < state.highWaterMark;
    }

    protected _read(size: number): void {
        throw new Error('_read() is not implemented');
    }

    static fromSource(source: any): Duplex {
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
                } catch (err) { duplex.destroy(err as Error); }
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
    }

    destroy(error?: Error | null): this {
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
    }
}

// Transform

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

    protected override _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this._transform(chunk, encoding, (err, data) => {
            if (err) return callback(err);
            if (data !== undefined) this.push(data);
            callback();
        });
    }

    protected override _final(callback: (error?: Error | null) => void): void {
        if (this._flush) {
            this._flush((err, data) => {
                if (err) return callback(err);
                if (data !== undefined) this.push(data);
                callback();
            });
        } else {
            callback();
        }
    }
}

// PassThrough

export class PassThrough extends Transform {
    constructor(options?: TransformOptions) {
        super(options);
    }

    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        callback(null, chunk);
    }
}

// Stream static utilities (Node v18.1+)

export function isDisturbed(stream: any): boolean {
    if (stream instanceof Readable) return stream.readableEnded || stream.readableAborted || stream.destroyed;
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
    let pipelineFn: any;
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

// Factory functions

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
