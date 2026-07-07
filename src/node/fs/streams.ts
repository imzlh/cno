import { Readable, Writable } from '../stream';
import { arrayBufferBackedBytes } from '../_internal/buffer';
import { decodeBuffer, modeToNumber, parseFlags, pathToString, toUint8Array, type Mode, type PathLike } from './utils';

const fs = import.meta.use('fs');
const asfs = import.meta.use('asyncfs');

type FsChunk = string | Uint8Array | ArrayBuffer;

export interface ReadStreamOptions {
    flags?: string | number;
    encoding?: BufferEncoding;
    fd?: number;
    mode?: Mode;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    end?: number;
    highWaterMark?: number;
}

export interface WriteStreamOptions {
    flags?: string | number;
    encoding?: BufferEncoding;
    fd?: number;
    mode?: Mode;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    highWaterMark?: number;
}

function chunkToBytes(chunk: FsChunk, encoding?: BufferEncoding): Uint8Array<ArrayBuffer> {
    if (typeof chunk === 'string') return toUint8Array(chunk, encoding ?? 'utf8');
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    return arrayBufferBackedBytes(chunk);
}

function maybeDecode(chunk: Uint8Array<ArrayBuffer>, encoding?: BufferEncoding | null): Uint8Array | string {
    return encoding ? decodeBuffer(chunk, encoding) : chunk;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function closeHandleQuietly(handle: CModuleAsyncFS.FileHandle): void {
    try {
        handle.close();
    } catch {
        // The stream has already closed; this close is best-effort cleanup.
    }
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
    private handle: CModuleAsyncFS.FileHandle | null = null;
    private reading = false;
    private closed = false;
    private opening = false;
    private queuedRead = false;
    private position: number | null;

    constructor(path: PathLike, options: ReadStreamOptions = {}) {
        super({ highWaterMark: options.highWaterMark, encoding: options.encoding });
        this.path = path;
        this.flags = options.flags ?? 'r';
        this.mode = options.mode;
        this.autoClose = options.autoClose !== false;
        this.start = options.start;
        this.end = options.end;
        this.fd = options.fd ?? null;
        this.pending = this.fd === null;
        this.position = this.start ?? null;
        this.readableEncoding = options.encoding ?? null;
        this._read = this.doRead.bind(this);
        if (this.fd === null) {
            this.open();
        } else {
            queueMicrotask(() => {
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

    override destroy(error?: Error | null): this {
        if (this.closed) return this;
        this.closed = true;

        try {
            if (this.handle) {
                this.handle.close();
                this.handle = null;
            } else if (this.fd !== null && this.autoClose) {
                fs.close(this.fd);
            }
        } catch {}

        return super.destroy(error);
    }

    private open(): void {
        if (this.opening || this.closed || this.fd !== null) return;
        this.opening = true;
        const pathStr = pathToString(this.path);
        void asfs.open(pathStr, parseFlags(this.flags), modeToNumber(this.mode)).then(
            (handle: CModuleAsyncFS.FileHandle) => {
                if (this.closed) {
                    closeHandleQuietly(handle);
                    return;
                }
                this.handle = handle;
                this.fd = handle.fileno();
                this.pending = false;
                this.opening = false;
                this.emit('open', this.fd);
                this.emit('ready');
                if (this.queuedRead) {
                    this.queuedRead = false;
                    this.doRead(this.readableHighWaterMark);
                }
            },
            (err: unknown) => {
                this.opening = false;
                this.destroy(asError(err));
            },
        );
    }

    private doRead(size: number): void {
        if (this.closed || this.reading) return;
        if (this.end !== undefined && this.position !== null && this.position > this.end) {
            this.push(null);
            if (this.autoClose) this.close();
            return;
        }

        this.reading = true;
        void this.readChunk(size).then(
            (chunk) => {
                this.reading = false;
                if (this.closed) return;
                if (chunk === null) {
                    this.push(null);
                    if (this.autoClose) this.close();
                    return;
                }
                if (chunk === undefined) return;
                this.push(maybeDecode(chunk, this.readableEncoding));
            },
            (err) => {
                this.reading = false;
                this.destroy(asError(err));
            },
        );
    }

    private async readChunk(size: number): Promise<Uint8Array<ArrayBuffer> | null | undefined> {
        if (this.handle) {
            const remaining = this.end !== undefined && this.position !== null
                ? this.end - this.position + 1
                : size;
            if (remaining <= 0) return null;
            const buffer = new Uint8Array(Math.max(1, Math.min(size, remaining)));
            // native read() treats explicit null as offset 0, not "current offset" — omit the arg instead
            const bytesRead = this.position === null
                ? await this.handle.read(buffer)
                : await this.handle.read(buffer, this.position);
            if (bytesRead <= 0) return null;
            this.bytesRead += bytesRead;
            if (this.position !== null) this.position += bytesRead;
            return buffer.subarray(0, bytesRead);
        }

        if (this.fd !== null) {
            const remaining = this.end !== undefined && this.position !== null
                ? this.end - this.position + 1
                : size;
            if (remaining <= 0) return null;
            const buffer = new Uint8Array(Math.max(1, Math.min(size, remaining)));
            const bytesRead = this.position === null
                ? fs.read(this.fd, buffer)
                : fs.pread(this.fd, buffer, this.position);
            if (bytesRead <= 0) return null;
            this.bytesRead += bytesRead;
            if (this.position !== null) this.position += bytesRead;
            return buffer.subarray(0, bytesRead);
        }

        this.queuedRead = true;
        this.open();
        return undefined;
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
    private handle: CModuleAsyncFS.FileHandle | null = null;
    private closed = false;
    private opening = false;
    private position: number | null;

    constructor(path: PathLike, options: WriteStreamOptions = {}) {
        super({ highWaterMark: options.highWaterMark });
        this.path = path;
        this.flags = options.flags ?? 'w';
        this.mode = options.mode;
        this.autoClose = options.autoClose !== false;
        this.fd = options.fd ?? null;
        this.pending = this.fd === null;
        this.position = options.start ?? null;
        if (options.encoding) this.setDefaultEncoding(options.encoding);
        if (this.fd === null) {
            this.open();
        } else {
            queueMicrotask(() => {
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

    override destroy(error?: Error | null): this {
        if (this.closed) return this;
        this.closed = true;

        try {
            if (this.handle) {
                this.handle.close();
                this.handle = null;
            } else if (this.fd !== null && this.autoClose) {
                fs.close(this.fd);
            }
        } catch {}

        return super.destroy(error);
    }

    override _write(chunk: FsChunk, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const bytes = chunkToBytes(chunk, encoding);
        this.writeChunk(bytes).then(
            () => callback(),
            (err) => callback(asError(err)),
        );
    }

    override _final(callback: (error?: Error | null) => void): void {
        try {
            if (this.autoClose) this.destroy();
            callback();
        } catch (err) {
            callback(asError(err));
        }
    }

    private open(): void {
        if (this.opening || this.closed || this.fd !== null) return;
        this.opening = true;
        const pathStr = pathToString(this.path);
        void asfs.open(pathStr, parseFlags(this.flags), modeToNumber(this.mode)).then(
            (handle: CModuleAsyncFS.FileHandle) => {
                if (this.closed) {
                    closeHandleQuietly(handle);
                    return;
                }
                this.handle = handle;
                this.fd = handle.fileno();
                this.pending = false;
                this.opening = false;
                this.emit('open', this.fd);
                this.emit('ready');
            },
            (err: unknown) => {
                this.opening = false;
                this.destroy(asError(err));
            },
        );
    }

    private async writeChunk(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
        if (this.handle) {
            let offset = 0;
            while (offset < chunk.length) {
                const part = offset === 0 ? chunk : chunk.subarray(offset);
                // native write() treats explicit null as offset 0, not "current offset" — omit the arg instead
                const written = this.position === null
                    ? await this.handle.write(part)
                    : await this.handle.write(part, this.position + offset);
                if (written <= 0) throw new Error('write returned no bytes');
                offset += written;
                this.bytesWritten += written;
            }
            if (this.position !== null) this.position += offset;
            return;
        }

        if (this.fd !== null) {
            let offset = 0;
            while (offset < chunk.length) {
                const part = offset === 0 ? chunk : chunk.subarray(offset);
                const written = this.position === null
                    ? fs.write(this.fd, part)
                    : fs.pwrite(this.fd, part, this.position + offset);
                if (written <= 0) throw new Error('write returned no bytes');
                offset += written;
                this.bytesWritten += written;
            }
            if (this.position !== null) this.position += offset;
            return;
        }

        if (!this.opening) this.open();
        await new Promise<void>((resolve, reject) => {
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };
            const cleanup = () => {
                this.off('ready', onReady);
                this.off('error', onError);
            };
            this.once('ready', onReady);
            this.once('error', onError);
        });

        return this.writeChunk(chunk);
    }
}

export function createReadStream(path: PathLike, options?: ReadStreamOptions): ReadStream {
    return new ReadStream(path, options);
}

export function createWriteStream(path: PathLike, options?: WriteStreamOptions): WriteStream {
    return new WriteStream(path, options);
}
