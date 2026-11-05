/**
 * Bun's FileSink over a filesystem path or an owned descriptor. Writes buffer
 * in memory and `flush` commits them through the sync native fs binding; the
 * sink owns its file descriptor and `end()` is the only close path. ref/unref
 * are no-ops because plain files are not event-loop resources.
 */

import { arrayBufferBackedBytes, sanitizeSurrogates, toOwnedBytes } from '../utils/bytes';

const engine = import.meta.use('engine');
const fs = import.meta.use('fs');

const blobBytesSymbol = Symbol.for('cno.blob.bytes');

function chunkBytes(chunk: unknown): Uint8Array<ArrayBuffer> {
    if (typeof chunk === 'string') {
        return arrayBufferBackedBytes(engine.encodeString(sanitizeSurrogates(chunk)));
    }
    if (ArrayBuffer.isView(chunk)) {
        return toOwnedBytes(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    if (chunk instanceof ArrayBuffer) return toOwnedBytes(new Uint8Array(chunk));
    if (typeof SharedArrayBuffer !== 'undefined' && chunk instanceof SharedArrayBuffer) {
        return toOwnedBytes(new Uint8Array(chunk));
    }
    if (typeof Blob !== 'undefined' && chunk instanceof Blob) {
        const getBytes = Reflect.get(chunk, blobBytesSymbol);
        if (typeof getBytes !== 'function') throw new TypeError('Blob byte access is unavailable');
        return toOwnedBytes(Reflect.apply(getBytes, chunk, []) as Uint8Array);
    }
    throw new TypeError('FileSink.write expects a string or binary buffer');
}

interface SinkTarget {
    /** Returns the descriptor to write to, opening it on first use. */
    open(): number;
    /** Releases the descriptor; must tolerate being called once only. */
    close(fd: number): void;
}

function pathTarget(path: string): SinkTarget {
    return {
        open: () => fs.open(path, 'w', 0o664),
        close: fd => fs.close(fd),
    };
}

function fdTarget(fd: number): SinkTarget {
    return {
        open: () => fd,
        close: () => {
            // stdio descriptors are process-owned and never closed here.
        },
    };
}

interface AbandonedSink {
    target: SinkTarget;
    fd: number;
}

// A sink dropped without end() releases its descriptor at GC time, mirroring
// Bun's Drop: nothing is flushed, the fd is just closed.
const sinkFinalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry((abandoned: AbandonedSink) => {
        try {
            abandoned.target.close(abandoned.fd);
        } catch {
            // The descriptor may already be closed or invalidated.
        }
    })
    : undefined;

export class FileSink {
    readonly #target: SinkTarget;
    #pending: { chunk: Uint8Array<ArrayBuffer>; offset: number }[] = [];
    #buffered = 0;
    #fd: number | undefined;
    #ended = false;
    #highWaterMark: number | undefined;

    constructor(target: SinkTarget) {
        this.#target = target;
    }

    start(options?: { highWaterMark?: number }): void {
        if (options !== undefined && (typeof options !== 'object' || options === null)) {
            throw new TypeError('FileSink.start options must be an object');
        }
        const mark = options?.highWaterMark;
        if (mark !== undefined && (!Number.isFinite(mark) || mark < 0)) {
            throw new RangeError('FileSink highWaterMark must be a non-negative number');
        }
        this.#highWaterMark = mark;
    }

    write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer | Blob): number {
        if (this.#ended) throw new Error('FileSink is already closed');
        const bytes = chunkBytes(chunk);
        this.#pending.push({ chunk: bytes, offset: 0 });
        this.#buffered += bytes.byteLength;
        // Bun auto-flushes when the high water mark is reached. Without a
        // mark, data stays buffered until flush()/end().
        if (this.#highWaterMark !== undefined && this.#buffered >= this.#highWaterMark) {
            this.flush();
        }
        return bytes.byteLength;
    }

    flush(): number {
        if (this.#ended) throw new Error('FileSink is already closed');
        return this.#flushBuffered();
    }

    #flushBuffered(): number {
        if (this.#buffered === 0) return 0;
        const fd = this.#fd ?? (this.#fd = this.#openTracked());
        let flushed = 0;
        // Consume incrementally: a failed flush can be retried and resumes
        // from the partial-write offset instead of replaying earlier chunks.
        while (this.#pending.length > 0) {
            const head = this.#pending[0]!;
            while (head.offset < head.chunk.byteLength) {
                const written = fs.write(fd, head.chunk.subarray(head.offset));
                if (written <= 0) throw new Error('FileSink write made no progress');
                head.offset += written;
                this.#buffered -= written;
                flushed += written;
            }
            this.#pending.shift();
        }
        return flushed;
    }

    #openTracked(): number {
        const fd = this.#target.open();
        sinkFinalizer?.register(this, { target: this.#target, fd }, this);
        return fd;
    }

    end(error?: Error): number {
        if (error !== undefined && !(error instanceof Error)) {
            throw new TypeError('FileSink.end error must be an Error');
        }
        if (this.#ended) return 0;
        let flushed = 0;
        try {
            // end(error) discards the buffer; a plain end commits it first.
            if (error === undefined) flushed = this.#flushBuffered();
        } finally {
            // The fd must close on every path: end() is the only close.
            this.#ended = true;
            sinkFinalizer?.unregister(this);
            const fd = this.#fd;
            this.#fd = undefined;
            if (fd !== undefined) {
                try {
                    this.#target.close(fd);
                } catch {
                    // A closed or invalidated descriptor cannot be closed twice.
                }
            }
        }
        return flushed;
    }

    ref(): void {
        // Plain files and stdio descriptors are not event-loop resources.
    }

    unref(): void {
        // Plain files and stdio descriptors are not event-loop resources.
    }
}

/** A sink that truncates `path` on first flush and owns its descriptor. */
export function filePathSink(path: string): FileSink {
    return new FileSink(pathTarget(path));
}

/** A sink over an already-owned descriptor; closing is the caller's job. */
export function fileDescriptorSink(fd: number): FileSink {
    return new FileSink(fdTarget(fd));
}

export { chunkBytes as sinkChunkBytes };
