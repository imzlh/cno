import { Readable, Writable } from '../stream';
import { arrayBufferBackedBytes } from '../_internal/buffer';
import { withCode } from '../_internal/errors';
import { toErrnoException } from '../_internal/errno';
import { modeToNumber, parseFlags, pathToString, toUint8Array, type Mode, type PathLike } from './utils';

import { nsfs, nsasfs } from './syspath';
const fs = nsfs;
const asfs = nsasfs;

type FsChunk = string | Uint8Array | ArrayBuffer;

export interface ReadStreamOptions {
    flags?: string | number;
    encoding?: BufferEncoding;
    fd?: number | { fd: number; close(): Promise<void> };
    mode?: Mode;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    end?: number;
    highWaterMark?: number;
    signal?: AbortSignal;
}

export interface WriteStreamOptions {
    flags?: string | number;
    encoding?: BufferEncoding;
    fd?: number | { fd: number; close(): Promise<void> };
    mode?: Mode;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    highWaterMark?: number;
    signal?: AbortSignal;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Node accepts a FileHandle as `options.fd` (that is how
 * `filehandle.createReadStream()` is built). Such a stream reads through the
 * handle's fd but closes the *handle* on teardown, so `handle.closed` stays
 * truthful and the fd is released exactly once.
 */
type FdOption = number | { fd: number; close(): Promise<void> };

function isFileHandleLike(fd: FdOption | null | undefined): fd is { fd: number; close(): Promise<void> } {
    return typeof fd === 'object' && fd !== null && typeof (fd as { fd?: unknown }).fd === 'number';
}

/** Node prints large numbers in ERR_OUT_OF_RANGE with `_` separators. */
function formatNumber(value: number): string {
    if (!Number.isInteger(value) || Math.abs(value) < 1000) return String(value);
    const negative = value < 0;
    const digits = String(Math.abs(value));
    let grouped = '';
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) grouped += '_';
        grouped += digits[i];
    }
    return (negative ? '-' : '') + grouped;
}

function describeValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'string') return `type string ('${String(value)}')`;
    if (type === 'number' || type === 'boolean' || type === 'bigint') return `type ${type} (${String(value)})`;
    if (type === 'symbol') return `type symbol (${String(value)})`;
    if (type === 'function') return 'type function';
    return 'an instance of Object';
}

function invalidArgType(name: string, value: unknown): never {
    throw withCode(
        new TypeError(`The "${name}" argument must be of type number. Received ${describeValue(value)}`),
        'ERR_INVALID_ARG_TYPE',
    );
}

function outOfRange(name: string, constraint: string, value: unknown): never {
    const shown = typeof value === 'number' ? formatNumber(value) : String(value);
    throw withCode(
        new RangeError(`The value of "${name}" is out of range. It must be ${constraint}. Received ${shown}`),
        'ERR_OUT_OF_RANGE',
    );
}

/**
 * Node validates `start`/`end` in the fs stream constructor, before any I/O.
 * Without this a negative `start` reached `pread()` as a huge unsigned offset
 * and a 26-byte file yielded 27 bytes with a duplicated tail byte, so bad input
 * produced silently corrupt data instead of a throw.
 */
function validatePosition(name: string, value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number') invalidArgType(name, value);
    if (!Number.isInteger(value)) outOfRange(name, 'an integer', value);
    if (value < 0 || value > MAX_SAFE) outOfRange(name, `>= 0 && <= ${MAX_SAFE}`, value);
    return value;
}

function validateHighWaterMark(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
        const shown = typeof value === 'string' ? `'${value}'` : String(value);
        throw withCode(
            new TypeError(`The property 'options.highWaterMark' is invalid. Received ${shown}`),
            'ERR_INVALID_ARG_VALUE',
        );
    }
    return value;
}

function chunkToBytes(chunk: FsChunk, encoding?: BufferEncoding): Uint8Array<ArrayBuffer> {
    if (typeof chunk === 'string') return toUint8Array(chunk, encoding ?? 'utf8');
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    return arrayBufferBackedBytes(chunk);
}

function asFsError(error: unknown, syscall: string, path?: string): Error {
    if (error instanceof Error && typeof Reflect.get(error, 'code') === 'string') return error;
    // asyncfs rejects with a numeric UV code; without this every stream 'error'
    // carried `code: -4058` instead of 'ENOENT' and no library could match it.
    return toErrnoException(error, syscall, path) as Error;
}

/**
 * Is `value` an object already linked to `prototype`? That is node's test for
 * "was I called with new / applied onto a real instance", and it must use
 * isPrototypeOf rather than an exact-prototype check so ES5 subclasses -- whose
 * instances sit one link further down -- are adopted too.
 */
function isFsConstructCallTarget(value: unknown, prototype: object): boolean {
    return !!value
        && (typeof value === 'object' || typeof value === 'function')
        && prototype.isPrototypeOf(value as object);
}

// Shared lifecycle helpers need a mutable view of the classes' private fields.
type FileStreamInternals = {
    path: PathLike;
    pending: boolean;
    fd: number | null;
    flags: string | number;
    mode?: Mode;
    autoClose: boolean;
    ownedHandle: { fd: number; close(): Promise<void> } | null;
    handle: CModuleAsyncFS.FileHandle | null;
    position: number | null;
    openPromise: Promise<void> | null;
    openFailed: boolean;
};

type ReadStreamInternals = FileStreamInternals & {
    bytesRead: number;
    start?: number;
    end?: number;
};

type FileStream = ReadStream | WriteStream;

// Reads, writes and teardown all wait for the same in-flight open.
function ensureFileStreamOpen(stream: FileStream): Promise<void> {
    const state = stream as unknown as FileStreamInternals;
    if (state.openPromise) return state.openPromise;
    const path = pathToString(stream.path);
    state.openPromise = asfs.open(path, parseFlags(state.flags), modeToNumber(state.mode)).then(handle => {
        if (stream.destroyed) {
            try { handle.close(); } catch { /* already torn down */ }
            return;
        }
        state.handle = handle;
        stream.fd = handle.fileno();
        stream.pending = false;
        stream.emit('open', stream.fd);
        stream.emit('ready');
    });
    return state.openPromise;
}

function openFileStream(stream: FileStream): void {
    const state = stream as unknown as FileStreamInternals;
    if (stream.fd === null) {
        void ensureFileStreamOpen(stream).catch((error: unknown) => {
            state.openFailed = true;
            if (!stream.destroyed) stream.destroy(asFsError(error, 'open', pathToString(stream.path)));
        });
    } else {
        queueMicrotask(() => {
            if (stream.destroyed) return;
            stream.emit('open', stream.fd);
            stream.emit('ready');
        });
    }
}

function destroyFileStream(stream: FileStream, error: Error | null, callback: (err?: Error | null) => void): void {
    const state = stream as unknown as FileStreamInternals;
    const finish = () => {
        try {
            if (state.handle) {
                state.handle.close();
                state.handle = null;
            } else if (state.ownedHandle) {
                // Close the FileHandle, not the bare fd, so the handle knows.
                void state.ownedHandle.close().catch(() => { /* already closed */ });
            } else if (stream.fd !== null && state.autoClose) {
                fs.close(stream.fd);
            }
        } catch { /* best-effort cleanup */ }
        callback(error);
    };
    // An open in flight must settle first or its handle leaks.
    if (state.openPromise && state.handle === null && stream.fd === null) {
        state.openPromise.then(finish, finish);
    } else {
        finish();
    }
}

/**
 * The Readable options ReadStream passes up. Split out of the constructor so the
 * ES5-callable facade below can hand the same options to `Readable.call`.
 */
function readableOptionsFor(options: ReadStreamOptions) {
    return {
        highWaterMark: validateHighWaterMark(options.highWaterMark),
        encoding: options.encoding,
        emitClose: options.emitClose,
        // Node ties 'close' emission and teardown to autoClose: with
        // autoClose:false the stream is never auto-destroyed.
        autoDestroy: options.autoClose !== false,
    };
}

// Initialize the caller's object in place: the pending open must capture the
// same instance the ES5-callable constructor returns, never a throwaway copy.
function initReadStreamState(self: ReadStream, path: PathLike, options: ReadStreamOptions): void {
    const start = validatePosition('start', options.start);
    const end = validatePosition('end', options.end);
    if (start !== undefined && end !== undefined && start > end) {
        outOfRange('start', `<= "end" (here: ${end})`, start);
    }

    const target = self as unknown as ReadStreamInternals;
    target.path = path;
    target.flags = options.flags ?? 'r';
    target.mode = options.mode;
    target.autoClose = options.autoClose !== false;
    target.start = start;
    target.end = end;
    target.bytesRead = 0;
    target.handle = null;
    target.openPromise = null;
    target.openFailed = false;
    target.ownedHandle = isFileHandleLike(options.fd) ? options.fd : null;
    target.fd = target.ownedHandle ? target.ownedHandle.fd : (options.fd as number | undefined) ?? null;
    target.pending = target.fd === null;
    // default to offset 0 when only `end` is given so the end bound applies
    target.position = start ?? (end !== undefined ? 0 : null);

    openFileStream(self);
}

class ReadStreamClass extends Readable {
    bytesRead = 0;
    // Initialized by initReadStreamState, including the ES5-callable path.
    path!: PathLike;
    pending!: boolean;
    fd!: number | null;

    private readonly flags!: string | number;
    private readonly mode?: Mode;
    private readonly autoClose!: boolean;
    private readonly start?: number;
    private readonly end?: number;
    private readonly ownedHandle!: { fd: number; close(): Promise<void> } | null;
    private handle: CModuleAsyncFS.FileHandle | null = null;
    private position!: number | null;
    private openPromise: Promise<void> | null = null;
    private openFailed = false;

    constructor(path: PathLike, options: ReadStreamOptions = {}) {
        super(readableOptionsFor(options));
        initReadStreamState(this, path, options);
    }

    close(callback?: (err?: NodeJS.ErrnoException | null) => void): void {
        if (callback) {
            if (this.closed) queueMicrotask(() => callback(null));
            else this.once('close', () => callback(null));
        }
        this.destroy();
    }

    override _read(size: number): void {
        void this.readChunk(size).then(
            (chunk) => {
                if (this.destroyed) return;
                if (chunk === null) {
                    this.push(null);
                    return;
                }
                this.push(chunk);
            },
            (err) => {
                // A failed open already destroys from the constructor; a second
                // destroy(err) here emitted 'error' twice.
                if (this.openFailed || this.destroyed) return;
                this.destroy(asFsError(err, 'read', pathToString(this.path)));
            },
        );
    }

    override _destroy(error: Error | null, callback: (err?: Error | null) => void): void {
        destroyFileStream(this, error, callback);
    }

    private async readChunk(size: number): Promise<Uint8Array<ArrayBuffer> | null> {
        if (this.handle === null && this.fd === null) {
            await ensureFileStreamOpen(this);
            if (this.destroyed) return null;
        }

        const budget = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
        const remaining = this.end !== undefined && this.position !== null
            ? this.end - this.position + 1
            : budget;
        const length = Math.min(budget, remaining);
        if (length <= 0) return null;

        const buffer = new Uint8Array(length);
        let bytesRead: number;
        if (this.handle) {
            // native read() treats explicit null as offset 0, not "current offset" — omit the arg instead
            bytesRead = this.position === null
                ? await this.handle.read(buffer)
                : await this.handle.read(buffer, this.position);
        } else if (this.fd !== null) {
            bytesRead = this.position === null
                ? fs.read(this.fd, buffer)
                : fs.pread(this.fd, buffer, this.position);
        } else {
            return null;
        }

        if (bytesRead <= 0) return null;
        this.bytesRead += bytesRead;
        if (this.position !== null) this.position += bytesRead;
        return buffer.subarray(0, bytesRead);
    }
}

// Libraries such as graceful-fs subclass through ReadStream.apply(this, args).
// The callable facade adopts prototype-linked receivers and shares the class
// prototype so inherited methods and instanceof work on both construction paths.
export type ReadStream = ReadStreamClass;

type ReadStreamConstructor = {
    new (path: PathLike, options?: ReadStreamOptions): ReadStream;
    (path: PathLike, options?: ReadStreamOptions): ReadStream;
    readonly prototype: ReadStream;
};

export const ReadStream = function ReadStream(this: unknown, path: PathLike, options: ReadStreamOptions = {}) {
    const target = isFsConstructCallTarget(this, ReadStream.prototype)
        ? (this as ReadStream)
        : (Object.create(ReadStream.prototype) as ReadStream);
    // Readable is itself ES5-callable and adopts a prototype-linked `this`, so
    // this sets up readable state on `target` rather than a throwaway object.
    (Readable as unknown as (this: unknown, options?: unknown) => void).call(target, readableOptionsFor(options));
    initReadStreamState(target, path, options);
    return target;
} as unknown as ReadStreamConstructor;

Object.setPrototypeOf(ReadStream, Readable);
// The class owns the shared prototype, so give it the public constructor name.
Object.defineProperty(ReadStreamClass, 'name', { value: 'ReadStream', configurable: true });
Object.defineProperty(ReadStream, 'prototype', {
    value: ReadStreamClass.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
});

function writableOptionsFor(options: WriteStreamOptions) {
    return {
        highWaterMark: validateHighWaterMark(options.highWaterMark),
        emitClose: options.emitClose,
        autoDestroy: options.autoClose !== false,
    };
}

type WriteStreamInternals = FileStreamInternals & {
    bytesWritten: number;
};

function initWriteStreamState(self: WriteStream, path: PathLike, options: WriteStreamOptions): void {
    const start = validatePosition('start', options.start);

    const target = self as unknown as WriteStreamInternals;
    target.path = path;
    target.flags = options.flags ?? 'w';
    target.mode = options.mode;
    target.autoClose = options.autoClose !== false;
    target.bytesWritten = 0;
    target.handle = null;
    target.openPromise = null;
    target.openFailed = false;
    target.ownedHandle = isFileHandleLike(options.fd) ? options.fd : null;
    target.fd = target.ownedHandle ? target.ownedHandle.fd : (options.fd as number | undefined) ?? null;
    target.pending = target.fd === null;
    target.position = start ?? null;
    if (options.encoding) self.setDefaultEncoding(options.encoding);

    openFileStream(self);
}

class WriteStreamClass extends Writable {
    bytesWritten = 0;
    path!: PathLike;
    pending!: boolean;
    fd!: number | null;

    private readonly flags!: string | number;
    private readonly mode?: Mode;
    private readonly autoClose!: boolean;
    private readonly ownedHandle!: { fd: number; close(): Promise<void> } | null;
    private handle: CModuleAsyncFS.FileHandle | null = null;
    private position!: number | null;
    private openPromise: Promise<void> | null = null;
    private openFailed = false;

    constructor(path: PathLike, options: WriteStreamOptions = {}) {
        super(writableOptionsFor(options));
        initWriteStreamState(this, path, options);
    }

    close(callback?: (err?: NodeJS.ErrnoException | null) => void): void {
        if (callback) {
            if (this.closed) queueMicrotask(() => callback(null));
            else this.once('close', () => callback(null));
        }
        this.end();
    }

    override _write(chunk: FsChunk, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const bytes = chunkToBytes(chunk, encoding);
        this.writeChunk(bytes).then(
            () => callback(),
            (err) => {
                // The constructor's destroy already reported an open failure;
                // reporting it again here emitted 'error' twice.
                if (this.openFailed) {
                    callback();
                    return;
                }
                callback(asFsError(err, 'write', pathToString(this.path)));
            },
        );
    }

    /**
     * Node closes the fd from _destroy (reached via autoDestroy after 'finish'),
     * not from _final. Destroying here emitted 'close' before 'finish'.
     */
    override _destroy(error: Error | null, callback: (err?: Error | null) => void): void {
        destroyFileStream(this, error, callback);
    }

    private async writeChunk(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
        if (this.handle === null && this.fd === null) {
            await ensureFileStreamOpen(this);
            if (this.destroyed) return;
        }

        let offset = 0;
        while (offset < chunk.length) {
            const part = offset === 0 ? chunk : chunk.subarray(offset);
            let written: number;
            if (this.handle) {
                // native write() treats explicit null as offset 0, not "current offset" — omit the arg instead
                written = this.position === null
                    ? await this.handle.write(part)
                    : await this.handle.write(part, this.position + offset);
            } else if (this.fd !== null) {
                written = this.position === null
                    ? fs.write(this.fd, part)
                    : fs.pwrite(this.fd, part, this.position + offset);
            } else {
                return;
            }
            if (written <= 0) throw new Error('write returned no bytes');
            offset += written;
            this.bytesWritten += written;
        }
        if (this.position !== null) this.position += offset;
    }
}

/** ES5-callable `fs.WriteStream`; see the ReadStream facade above for why. */
export type WriteStream = WriteStreamClass;

type WriteStreamConstructor = {
    new (path: PathLike, options?: WriteStreamOptions): WriteStream;
    (path: PathLike, options?: WriteStreamOptions): WriteStream;
    readonly prototype: WriteStream;
};

export const WriteStream = function WriteStream(this: unknown, path: PathLike, options: WriteStreamOptions = {}) {
    const target = isFsConstructCallTarget(this, WriteStream.prototype)
        ? (this as WriteStream)
        : (Object.create(WriteStream.prototype) as WriteStream);
    (Writable as unknown as (this: unknown, options?: unknown) => void).call(target, writableOptionsFor(options));
    initWriteStreamState(target, path, options);
    return target;
} as unknown as WriteStreamConstructor;

Object.setPrototypeOf(WriteStream, Writable);
Object.defineProperty(WriteStreamClass, 'name', { value: 'WriteStream', configurable: true });
Object.defineProperty(WriteStream, 'prototype', {
    value: WriteStreamClass.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
});

export function createReadStream(path: PathLike, options?: ReadStreamOptions): ReadStream {
    return new ReadStream(path, options);
}

export function createWriteStream(path: PathLike, options?: WriteStreamOptions): WriteStream {
    return new WriteStream(path, options);
}
