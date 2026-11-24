import { Readable, Writable } from '../stream';
import { createDestroyedError, deferTick } from '../stream/_shared';
import { arrayBufferBackedBytes } from '../_internal/buffer';
import { withCode } from '../_internal/errors';
import { toErrnoException } from '../_internal/errno';
import { errnoCode } from '../../utils/errno';
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
type FileHandleLike = { fd: number; close(): Promise<void> };

function invalidFd(value: unknown): never {
    throw withCode(
        new TypeError(`The "fd" argument must be of type number or an instance of FileHandle. Received ${describeValue(value)}`),
        'ERR_INVALID_ARG_TYPE',
    );
}

function normalizeFdOption(fd: unknown): { fd: number | null; ownedHandle: FileHandleLike | null } {
    if (fd == null) return { fd: null, ownedHandle: null };
    if (typeof fd === 'number') return { fd: validateFd(fd), ownedHandle: null };
    if (typeof fd === 'object' && fd !== null) {
        const candidate = fd as { fd?: unknown; close?: unknown };
        const rawFd = candidate.fd;
        const close = candidate.close;
        if (typeof rawFd === 'number' && typeof close === 'function') {
            return { fd: validateFd(rawFd), ownedHandle: fd as FileHandleLike };
        }
    }
    return invalidFd(fd);
}

function validateFd(fd: number): number {
    if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) {
        outOfRange('fd', '>= 0 && <= 2147483647', fd);
    }
    return fd;
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
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
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

type FileStreamOpen = {
    promise: Promise<void> | null;
    waiters: Array<{ resolve(): void; reject(error: unknown): void }>;
};

type FileStreamState = {
    ownedHandle: FileHandleLike | null;
    handle: CModuleAsyncFS.FileHandle | null;
    openPath: string | null;
    position: number | null;
    open: FileStreamOpen | null;
    ioPromise: Promise<unknown> | null;
    openFailed: boolean;
    closeRequested: boolean;
    closeResult: { error: Error | null } | null;
    closeCallbacks: Set<(error: Error | null) => void>;
};

type FileStream = ReadStream | WriteStream;
const fileStreamStates = new WeakMap<FileStream, FileStreamState>();

function fileStreamState(stream: FileStream): FileStreamState {
    const state = fileStreamStates.get(stream);
    if (!state) throw new Error('File stream state was not initialized');
    return state;
}

function pathForError(path: PathLike | null | undefined): string | undefined {
    if (path == null) return undefined;
    try {
        return pathToString(path);
    } catch {
        // A descriptor-backed stream may legally carry an ignored path value.
        // Do not replace the real I/O error with a second path conversion error.
        return undefined;
    }
}

function requirePath(path: PathLike | null | undefined): string {
    if (path == null) {
        throw withCode(
            new TypeError('The "path" argument must be supplied when no file descriptor is provided.'),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    return pathToString(path);
}

function prematureCloseError(): Error & { code: 'ERR_STREAM_PREMATURE_CLOSE' } {
    return Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' as const });
}

function normalizeReadError(error: unknown, path: string | undefined): NodeJS.ErrnoException {
    const normalized = toErrnoException(error, 'read', path);
    if (normalized.code !== 'ENOTSUP' || path === undefined) return normalized;
    try {
        if (!fs.stat(path).isDirectory) return normalized;
    } catch {
        return normalized;
    }
    const directoryErrno = errnoCode('EISDIR');
    if (directoryErrno === undefined) return normalized;
    const directoryError = Object.assign(new Error(normalized.message), { code: directoryErrno });
    return toErrnoException(directoryError, 'read', path);
}

// Reads, writes and teardown all wait for the same in-flight open.
function ensureFileStreamOpen(stream: FileStream): Promise<void> {
    const state = fileStreamState(stream);
    if (state.open) {
        const open = state.open;
        return open.promise ?? new Promise<void>((resolve, reject) => {
            open.waiters.push({ resolve, reject });
        });
    }
    const open: FileStreamOpen = { promise: null, waiters: [] };
    state.open = open;
    open.promise = new Promise<CModuleAsyncFS.FileHandle>((resolve, reject) => {
        deferTick(() => {
            try {
                const path = state.openPath ?? requirePath(stream.path);
                resolve(asfs.open(path, parseFlags(stream.flags), modeToNumber(stream.mode)));
            } catch (error) {
                reject(error);
            }
        });
    }).then(async handle => {
        // With autoClose enabled, a destroyed stream does not publish a late
        // open. With autoClose disabled, destroy waits for open and owns the
        // resulting descriptor, so preserve the open/ready-before-close order.
        if (stream.destroyed && stream.autoClose) {
            try {
                await handle.close();
            } catch {
                // _destroy owns the public close result; this is best-effort
                // cleanup for a handle that was never published.
            }
            return;
        }
        state.handle = handle;
        stream.fd = handle.fileno();
        stream.pending = false;
        stream.emit('open', stream.fd);
        stream.emit('ready');
    });
    for (const waiter of open.waiters) {
        void open.promise.then(waiter.resolve, waiter.reject);
    }
    open.waiters.length = 0;
    return open.promise;
}

function openFileStream(stream: FileStream): void {
    const state = fileStreamState(stream);
    if (stream.fd === null) {
        void ensureFileStreamOpen(stream).catch((error: unknown) => {
            state.openFailed = true;
            if (state.ioPromise || stream instanceof WriteStream && stream._writableState.finalCalled) return;
            failFileStream(stream, toErrnoException(error, 'open', pathForError(stream.path)));
        });
    }
}

function detachFileStreamHandle(stream: FileStream): void {
    const state = fileStreamState(stream);
    if (stream.autoClose || !state.handle) return;
    stream.fd = state.handle.detach();
    state.handle = null;
}

function failFileStream(stream: FileStream, error: Error): void {
    if (stream.destroyed) return;
    if (stream.autoClose) {
        stream.destroy(error);
        return;
    }
    try {
        detachFileStreamHandle(stream);
    } catch (closeError) {
        stream.destroy(toErrnoException(closeError, 'close', pathForError(stream.path)));
        return;
    }
    stream.errored = error;
    deferTick(() => {
        if (!stream.destroyed) stream.emit('error', error);
    });
}

function addFileStreamCloseCallback(stream: FileStream, callback: (error?: NodeJS.ErrnoException | null) => void): void {
    const state = fileStreamState(stream);
    const result = state.closeResult;
    if (result) {
        deferTick(() => callback(result.error));
        return;
    }
    const finish = (error: Error | null) => {
        stream.removeListener('error', onError);
        state.closeCallbacks.delete(finish);
        callback(error);
    };
    const onError = () => {
        if (state.closeResult) finish(state.closeResult.error);
    };
    state.closeCallbacks.add(finish);
    stream.on('error', onError);
}

function destroyFileStream(stream: FileStream, error: Error | null, callback: (err?: Error | null) => void): void {
    const state = fileStreamState(stream);
    const complete = (closeError: Error | null) => {
        state.closeResult = { error: closeError };
        callback(closeError);
        deferTick(() => {
            for (const closeCallback of state.closeCallbacks) closeCallback(closeError);
        });
    };
    const finish = (pendingError?: Error) => {
        const finalError = error ?? pendingError ?? null;
        const handle = state.handle;
        const ownedHandle = state.ownedHandle;
        const fd = stream.fd;
        state.handle = null;
        state.ownedHandle = null;
        stream.fd = null;
        stream.pending = true;
        try {
            if (handle) {
                void handle.close().then(
                    () => complete(finalError),
                    closeError => complete(finalError ?? toErrnoException(closeError, 'close', pathForError(stream.path))),
                );
            } else if (ownedHandle) {
                // Close the FileHandle, not the bare fd, so the handle knows.
                void ownedHandle.close().then(
                    () => complete(finalError),
                    closeError => complete(finalError ?? toErrnoException(closeError, 'close', pathForError(stream.path))),
                );
            } else {
                if (fd !== null) fs.close(fd);
                complete(finalError);
            }
        } catch (closeError) {
            complete(finalError ?? toErrnoException(closeError, 'close', pathForError(stream.path)));
        }
    };
    // An open in flight must settle first or its handle leaks.
    const pendingOperation = state.ioPromise
        ?? (stream.fd === null && !state.openFailed && state.open ? ensureFileStreamOpen(stream) : null);
    if (pendingOperation) {
        void pendingOperation.then(
            () => finish(),
            pendingError => finish(toErrnoException(
                pendingError,
                state.openFailed ? 'open' : stream instanceof ReadStream ? 'read' : 'write',
                pathForError(stream.path),
            )),
        );
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
function initReadStreamState(self: ReadStream, path: PathLike | null | undefined, options: ReadStreamOptions): void {
    const pathValue = path == null ? undefined : path;
    if (pathValue === undefined && options.fd == null) {
        throw withCode(
            new TypeError('The "path" argument must be of type string or an instance of Buffer or URL.'),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    // Validate path-like values synchronously, matching Node's constructor
    // contract. A path is ignored when an fd is supplied, including the
    // descriptor-backed factories which intentionally pass undefined.
    const resolvedPath = pathValue !== undefined && options.fd == null
        ? pathToString(pathValue)
        : null;
    const start = validatePosition('start', options.start);
    const end = options.end === Infinity ? Infinity : validatePosition('end', options.end);
    if (start !== undefined && end !== undefined && start > end) {
        outOfRange('start', `<= "end" (here: ${end})`, start);
    }

    const fdOption = normalizeFdOption(options.fd);
    self.path = pathValue;
    self.bytesRead = 0;
    self.fd = fdOption.fd;
    self.pending = self.fd === null;
    if (self.pending) {
        self.flags = options.flags ?? 'r';
        self.mode = options.mode ?? 0o666;
    }
    self.start = start;
    self.end = end ?? Infinity;
    fileStreamStates.set(self, {
        handle: null,
        openPath: resolvedPath,
        open: null,
        ioPromise: null,
        openFailed: false,
        closeRequested: false,
        closeResult: null,
        closeCallbacks: new Set(),
        ownedHandle: fdOption.ownedHandle,
        position: start ?? null,
    });

    openFileStream(self);
}

class ReadStreamClass extends Readable {
    bytesRead = 0;
    // Initialized by initReadStreamState, including the ES5-callable path.
    path!: PathLike | undefined;
    pending!: boolean;
    fd!: number | null;
    flags?: string | number;
    mode?: Mode;
    start?: number;
    end!: number;

    constructor(path: PathLike, options: ReadStreamOptions = {}) {
        super(readableOptionsFor(options));
        initReadStreamState(this, path, options);
    }

    get autoClose(): boolean {
        return this._readableState.autoDestroy;
    }

    set autoClose(value: boolean) {
        this._readableState.autoDestroy = value;
        if (!value && this.readableEnded) detachFileStreamHandle(this);
    }

    close(callback?: (err?: NodeJS.ErrnoException | null) => void): void {
        fileStreamState(this).closeRequested = true;
        if (callback) {
            addFileStreamCloseCallback(this, error => {
                callback(error ?? this.errored ?? (this.readableEnded ? null : prematureCloseError()));
            });
        }
        this.destroy();
    }

    override _read(size: number): void {
        const state = fileStreamState(this);
        const operation = this.readChunk(size);
        state.ioPromise = operation;
        void operation.then(
            (chunk) => {
                if (state.ioPromise === operation) state.ioPromise = null;
                if (this.destroyed) return;
                if (chunk === null) {
                    try {
                        detachFileStreamHandle(this);
                    } catch (error) {
                        this.destroy(toErrnoException(error, 'close', pathForError(this.path)));
                        return;
                    }
                    this.push(null);
                    return;
                }
                this.push(chunk);
            },
            (err) => {
                if (state.ioPromise === operation) state.ioPromise = null;
                if (this.destroyed) return;
                this._readableState.reading = false;
                const path = pathForError(this.path);
                failFileStream(this, normalizeReadError(err, path));
            },
        );
    }

    override _destroy(error: Error | null, callback: (err?: Error | null) => void): void {
        destroyFileStream(this, error, callback);
    }

    private async readChunk(size: number): Promise<Uint8Array<ArrayBuffer> | null> {
        const state = fileStreamState(this);
        if (state.handle === null && this.fd === null) {
            await ensureFileStreamOpen(this);
            if (this.destroyed) return null;
        }

        const budget = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
        const remaining = this.end - (state.position ?? this.bytesRead) + 1;
        const length = Math.min(budget, remaining);
        if (length <= 0) return null;

        const buffer = new Uint8Array(length);
        let bytesRead: number | null;
        if (state.handle) {
            // native read() treats explicit null as offset 0, not "current offset" — omit the arg instead
            const position = state.position;
            bytesRead = position === null
                ? await state.handle.read(buffer)
                : await state.handle.read(buffer, position);
        } else if (this.fd !== null) {
            bytesRead = state.position === null
                ? fs.read(this.fd, buffer)
                : fs.pread(this.fd, buffer, state.position);
        } else {
            return null;
        }

        if (bytesRead === null || bytesRead <= 0) return null;
        this.bytesRead += bytesRead;
        if (state.position !== null) state.position += bytesRead;
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

function initializeReadStream(target: ReadStream, path: PathLike | null | undefined, options: ReadStreamOptions): ReadStream {
    (Readable as unknown as (this: unknown, options?: unknown) => void).call(target, readableOptionsFor(options));
    initReadStreamState(target, path, options);
    return target;
}

export const ReadStream = function ReadStream(this: unknown, path: PathLike, options: ReadStreamOptions = {}) {
    const target = isFsConstructCallTarget(this, ReadStream.prototype)
        ? (this as ReadStream)
        : (Object.create(ReadStream.prototype) as ReadStream);
    // Readable is itself ES5-callable and adopts a prototype-linked `this`, so
    // this sets up readable state on `target` rather than a throwaway object.
    return initializeReadStream(target, path, options);
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

function initWriteStreamState(self: WriteStream, path: PathLike | null | undefined, options: WriteStreamOptions): void {
    const pathValue = path == null ? undefined : path;
    if (pathValue === undefined && options.fd == null) {
        throw withCode(
            new TypeError('The "path" argument must be of type string or an instance of Buffer or URL.'),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    const resolvedPath = pathValue !== undefined && options.fd == null ? pathToString(pathValue) : null;
    const start = validatePosition('start', options.start);

    const fdOption = normalizeFdOption(options.fd);
    self.path = pathValue;
    self.bytesWritten = 0;
    self.fd = fdOption.fd;
    self.pending = self.fd === null;
    if (self.pending) {
        self.flags = options.flags ?? 'w';
        self.mode = options.mode ?? 0o666;
    }
    self.start = start;
    fileStreamStates.set(self, {
        handle: null,
        openPath: resolvedPath,
        open: null,
        ioPromise: null,
        openFailed: false,
        closeRequested: false,
        closeResult: null,
        closeCallbacks: new Set(),
        ownedHandle: fdOption.ownedHandle,
        position: start ?? null,
    });
    if (options.encoding) self.setDefaultEncoding(options.encoding);

    openFileStream(self);
}

class WriteStreamClass extends Writable {
    bytesWritten = 0;
    path!: PathLike | undefined;
    pending!: boolean;
    fd!: number | null;
    flags?: string | number;
    mode?: Mode;
    start?: number;

    constructor(path: PathLike, options: WriteStreamOptions = {}) {
        super(writableOptionsFor(options));
        initWriteStreamState(this, path, options);
    }

    get autoClose(): boolean {
        return this._writableState.autoDestroy;
    }

    set autoClose(value: boolean) {
        this._writableState.autoDestroy = value;
        if (!value && this.writableFinished) detachFileStreamHandle(this);
    }

    close(callback?: (err?: NodeJS.ErrnoException | null) => void): void {
        fileStreamState(this).closeRequested = true;
        if (callback) addFileStreamCloseCallback(this, callback);
        if (this.writableFinished) this.destroy();
        else this.once('finish', () => this.destroy());
        this.end();
    }

    override _write(chunk: FsChunk, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const state = fileStreamState(this);
        const bytes = chunkToBytes(chunk, encoding);
        const operation = this.writeChunk(bytes);
        state.ioPromise = operation;
        operation.then(
            () => {
                if (state.ioPromise === operation) state.ioPromise = null;
                callback(this.destroyed ? createDestroyedError() : undefined);
            },
            (err) => {
                if (state.ioPromise === operation) state.ioPromise = null;
                try {
                    if (!this.destroyed) detachFileStreamHandle(this);
                } catch (closeError) {
                    callback(toErrnoException(closeError, 'close', pathForError(this.path)));
                    return;
                }
                callback(toErrnoException(err, state.openFailed ? 'open' : 'write', pathForError(this.path)));
            },
        );
    }

    override _final(callback: (error?: Error | null) => void): void {
        const state = fileStreamState(this);
        const finish = () => {
            try {
                if (!state.closeRequested) detachFileStreamHandle(this);
                callback();
            } catch (error) {
                callback(toErrnoException(error, 'close', pathForError(this.path)));
            }
        };
        if (state.open) {
            void ensureFileStreamOpen(this).then(finish, error => {
                callback(toErrnoException(error, 'open', pathForError(this.path)));
            });
        } else {
            finish();
        }
    }

    /**
     * Node closes the fd from _destroy (reached via autoDestroy after 'finish'),
     * not from _final. Destroying here emitted 'close' before 'finish'.
     */
    override _destroy(error: Error | null, callback: (err?: Error | null) => void): void {
        destroyFileStream(this, error, callback);
    }

    private async writeChunk(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
        const state = fileStreamState(this);
        if (state.handle === null && this.fd === null) {
            await ensureFileStreamOpen(this);
            if (this.destroyed) return;
        }

        let offset = 0;
        while (offset < chunk.length) {
            const part = offset === 0 ? chunk : chunk.subarray(offset);
            let written: number;
            if (state.handle) {
                // native write() treats explicit null as offset 0, not "current offset" — omit the arg instead
                written = state.position === null
                    ? await state.handle.write(part)
                    : await state.handle.write(part, state.position + offset);
            } else if (this.fd !== null) {
                written = state.position === null
                    ? fs.write(this.fd, part)
                    : fs.pwrite(this.fd, part, state.position + offset);
            } else {
                return;
            }
            if (this.destroyed) throw createDestroyedError();
            if (written <= 0) throw new Error('write returned no bytes');
            offset += written;
            this.bytesWritten += written;
        }
        if (state.position !== null) state.position += offset;
    }
}

/** ES5-callable `fs.WriteStream`; see the ReadStream facade above for why. */
export type WriteStream = WriteStreamClass;

type WriteStreamConstructor = {
    new (path: PathLike, options?: WriteStreamOptions): WriteStream;
    (path: PathLike, options?: WriteStreamOptions): WriteStream;
    readonly prototype: WriteStream;
};

function initializeWriteStream(target: WriteStream, path: PathLike | null | undefined, options: WriteStreamOptions): WriteStream {
    (Writable as unknown as (this: unknown, options?: unknown) => void).call(target, writableOptionsFor(options));
    initWriteStreamState(target, path, options);
    return target;
}

export const WriteStream = function WriteStream(this: unknown, path: PathLike, options: WriteStreamOptions = {}) {
    const target = isFsConstructCallTarget(this, WriteStream.prototype)
        ? (this as WriteStream)
        : (Object.create(WriteStream.prototype) as WriteStream);
    return initializeWriteStream(target, path, options);
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

export function createReadStreamFromHandle(
    handle: FileHandleLike,
    options: Omit<ReadStreamOptions, 'fd'> = {},
): ReadStream {
    const target = Object.create(ReadStream.prototype) as ReadStream;
    return initializeReadStream(target, undefined, { ...options, fd: handle });
}

export function createWriteStreamFromHandle(
    handle: FileHandleLike,
    options: Omit<WriteStreamOptions, 'fd'> = {},
): WriteStream {
    const target = Object.create(WriteStream.prototype) as WriteStream;
    return initializeWriteStream(target, undefined, { ...options, fd: handle });
}
