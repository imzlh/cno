import { Readable, Writable } from '../stream';
import { arrayBufferBackedBytes } from '../_internal/buffer';
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
    const e = new TypeError(`The "${name}" argument must be of type number. Received ${describeValue(value)}`);
    Reflect.set(e, 'code', 'ERR_INVALID_ARG_TYPE');
    throw e;
}

function outOfRange(name: string, constraint: string, value: unknown): never {
    const shown = typeof value === 'number' ? formatNumber(value) : String(value);
    const e = new RangeError(`The value of "${name}" is out of range. It must be ${constraint}. Received ${shown}`);
    Reflect.set(e, 'code', 'ERR_OUT_OF_RANGE');
    throw e;
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
        const e = new TypeError(`The property 'options.highWaterMark' is invalid. Received ${shown}`);
        Reflect.set(e, 'code', 'ERR_INVALID_ARG_VALUE');
        throw e;
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

export class ReadStream extends Readable {
    bytesRead = 0;
    path: PathLike;
    pending: boolean;
    fd: number | null;

    private readonly flags: string | number;
    private readonly mode?: Mode;
    private readonly autoClose: boolean;
    private readonly start?: number;
    private readonly end?: number;
    private readonly ownedHandle: { fd: number; close(): Promise<void> } | null;
    private handle: CModuleAsyncFS.FileHandle | null = null;
    private position: number | null;
    private openPromise: Promise<void> | null = null;
    private openFailed = false;

    constructor(path: PathLike, options: ReadStreamOptions = {}) {
        const start = validatePosition('start', options.start);
        const end = validatePosition('end', options.end);
        if (start !== undefined && end !== undefined && start > end) {
            outOfRange('start', `<= "end" (here: ${end})`, start);
        }
        const highWaterMark = validateHighWaterMark(options.highWaterMark);

        super({
            highWaterMark,
            encoding: options.encoding,
            emitClose: options.emitClose,
            // Node ties 'close' emission and teardown to autoClose: with
            // autoClose:false the stream is never auto-destroyed.
            autoDestroy: options.autoClose !== false,
        });
        this.path = path;
        this.flags = options.flags ?? 'r';
        this.mode = options.mode;
        this.autoClose = options.autoClose !== false;
        this.start = start;
        this.end = end;
        this.ownedHandle = isFileHandleLike(options.fd) ? options.fd : null;
        this.fd = this.ownedHandle ? this.ownedHandle.fd : (options.fd as number | undefined) ?? null;
        this.pending = this.fd === null;
        // default to offset 0 when only `end` is given so the end bound applies
        this.position = start ?? (end !== undefined ? 0 : null);

        if (this.fd === null) {
            void this.ensureOpen().catch((err) => {
                this.openFailed = true;
                if (!this.destroyed) this.destroy(asFsError(err, 'open', pathToString(this.path)));
            });
        } else {
            queueMicrotask(() => {
                if (this.destroyed) return;
                this.emit('open', this.fd);
                this.emit('ready');
            });
        }
    }

    close(callback?: (err?: NodeJS.ErrnoException | null) => void): void {
        if (callback) {
            if (this.closed) queueMicrotask(() => callback(null));
            else this.once('close', () => callback(null));
        }
        this.destroy();
    }

    /**
     * Single-flight open. The previous code tracked a `queuedRead` flag and
     * re-entered `doRead()` from the open callback; when a consumer attached one
     * macrotask late the read request landed while `reading` was still true, the
     * re-entry was dropped, and the stream hung forever with zero bytes and no
     * 'end'. Reads now await this promise instead.
     */
    private ensureOpen(): Promise<void> {
        if (this.openPromise) return this.openPromise;
        const pathStr = pathToString(this.path);
        this.openPromise = asfs.open(pathStr, parseFlags(this.flags), modeToNumber(this.mode)).then(
            (handle: CModuleAsyncFS.FileHandle) => {
                if (this.destroyed) {
                    try { handle.close(); } catch { /* already torn down */ }
                    return;
                }
                this.handle = handle;
                this.fd = handle.fileno();
                this.pending = false;
                this.emit('open', this.fd);
                this.emit('ready');
            },
        );
        return this.openPromise;
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
        const finish = () => {
            try {
                if (this.handle) {
                    this.handle.close();
                    this.handle = null;
                } else if (this.ownedHandle) {
                    // Close the FileHandle, not the bare fd, so the handle knows.
                    void this.ownedHandle.close().catch(() => { /* already closed */ });
                } else if (this.fd !== null && this.autoClose) {
                    fs.close(this.fd);
                }
            } catch { /* best-effort cleanup */ }
            callback(error);
        };
        // An open in flight must settle first or its handle leaks.
        if (this.openPromise && this.handle === null && this.fd === null) {
            this.openPromise.then(finish, finish);
            return;
        }
        finish();
    }

    private async readChunk(size: number): Promise<Uint8Array<ArrayBuffer> | null> {
        if (this.handle === null && this.fd === null) {
            await this.ensureOpen();
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

export class WriteStream extends Writable {
    bytesWritten = 0;
    path: PathLike;
    pending: boolean;
    fd: number | null;

    private readonly flags: string | number;
    private readonly mode?: Mode;
    private readonly autoClose: boolean;
    private readonly ownedHandle: { fd: number; close(): Promise<void> } | null;
    private handle: CModuleAsyncFS.FileHandle | null = null;
    private position: number | null;
    private openPromise: Promise<void> | null = null;
    private openFailed = false;

    constructor(path: PathLike, options: WriteStreamOptions = {}) {
        const start = validatePosition('start', options.start);
        const highWaterMark = validateHighWaterMark(options.highWaterMark);

        super({
            highWaterMark,
            emitClose: options.emitClose,
            autoDestroy: options.autoClose !== false,
        });
        this.path = path;
        this.flags = options.flags ?? 'w';
        this.mode = options.mode;
        this.autoClose = options.autoClose !== false;
        this.ownedHandle = isFileHandleLike(options.fd) ? options.fd : null;
        this.fd = this.ownedHandle ? this.ownedHandle.fd : (options.fd as number | undefined) ?? null;
        this.pending = this.fd === null;
        this.position = start ?? null;
        if (options.encoding) this.setDefaultEncoding(options.encoding);

        if (this.fd === null) {
            void this.ensureOpen().catch((err) => {
                this.openFailed = true;
                if (!this.destroyed) this.destroy(asFsError(err, 'open', pathToString(this.path)));
            });
        } else {
            queueMicrotask(() => {
                if (this.destroyed) return;
                this.emit('open', this.fd);
                this.emit('ready');
            });
        }
    }

    close(callback?: (err?: NodeJS.ErrnoException | null) => void): void {
        if (callback) {
            if (this.closed) queueMicrotask(() => callback(null));
            else this.once('close', () => callback(null));
        }
        this.end();
    }

    private ensureOpen(): Promise<void> {
        if (this.openPromise) return this.openPromise;
        const pathStr = pathToString(this.path);
        this.openPromise = asfs.open(pathStr, parseFlags(this.flags), modeToNumber(this.mode)).then(
            (handle: CModuleAsyncFS.FileHandle) => {
                if (this.destroyed) {
                    try { handle.close(); } catch { /* already torn down */ }
                    return;
                }
                this.handle = handle;
                this.fd = handle.fileno();
                this.pending = false;
                this.emit('open', this.fd);
                this.emit('ready');
            },
        );
        return this.openPromise;
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
        const finish = () => {
            try {
                if (this.handle) {
                    this.handle.close();
                    this.handle = null;
                } else if (this.ownedHandle) {
                    // Close the FileHandle, not the bare fd, so the handle knows.
                    void this.ownedHandle.close().catch(() => { /* already closed */ });
                } else if (this.fd !== null && this.autoClose) {
                    fs.close(this.fd);
                }
            } catch { /* best-effort cleanup */ }
            callback(error);
        };
        if (this.openPromise && this.handle === null && this.fd === null) {
            this.openPromise.then(finish, finish);
            return;
        }
        finish();
    }

    private async writeChunk(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
        if (this.handle === null && this.fd === null) {
            await this.ensureOpen();
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

export function createReadStream(path: PathLike, options?: ReadStreamOptions): ReadStream {
    return new ReadStream(path, options);
}

export function createWriteStream(path: PathLike, options?: WriteStreamOptions): WriteStream {
    return new WriteStream(path, options);
}
