import { arrayBufferBackedBytes, sanitizeSurrogates, toOwnedBytes } from '../utils/bytes';

const engine = import.meta.use('engine');
const fs = import.meta.use('fs');

const FILE_SINK_BUFFER_SIZE = 4096;

type BrandGetter<T> = (this: unknown) => T;

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get! as BrandGetter<number>;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get as BrandGetter<number> | undefined
    : undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get! as BrandGetter<number>;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get! as BrandGetter<number>;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get! as BrandGetter<number>;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get! as BrandGetter<number>;
const arrayBufferIsView = ArrayBuffer.isView;
const emptyBytes = new Uint8Array();

function rawBufferByteLength(value: unknown): number | undefined {
    try {
        return Reflect.apply(arrayBufferByteLength, value, []);
    } catch {
        if (!sharedArrayBufferByteLength) return undefined;
        try {
            return Reflect.apply(sharedArrayBufferByteLength, value, []);
        } catch {
            return undefined;
        }
    }
}

function viewBytes(value: ArrayBufferView): Uint8Array<ArrayBufferLike> {
    try {
        const buffer = Reflect.apply(typedArrayBuffer, value, []);
        const byteOffset = Reflect.apply(typedArrayByteOffset, value, []);
        const byteLength = Reflect.apply(typedArrayByteLength, value, []);
        return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
    } catch {
        try {
            const buffer = Reflect.apply(dataViewBuffer, value, []);
            const byteOffset = Reflect.apply(dataViewByteOffset, value, []);
            const byteLength = Reflect.apply(dataViewByteLength, value, []);
            return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
        } catch {
            // Bun accepts detached and out-of-bounds views as empty writes.
            return emptyBytes;
        }
    }
}

function chunkBytes(chunk: unknown): Uint8Array<ArrayBuffer> {
    if (typeof chunk === 'string') {
        return arrayBufferBackedBytes(engine.encodeString(sanitizeSurrogates(chunk)));
    }
    if (arrayBufferIsView(chunk)) return toOwnedBytes(viewBytes(chunk));
    const byteLength = rawBufferByteLength(chunk);
    if (byteLength !== undefined) {
        return byteLength === 0
            ? new Uint8Array()
            : toOwnedBytes(new Uint8Array(chunk as ArrayBufferLike, 0, byteLength));
    }
    const error = new TypeError('write() expects a string, ArrayBufferView, or ArrayBuffer') as TypeError & { code: string };
    error.code = chunk === null || chunk === undefined ? 'ERR_STREAM_NULL_VALUES' : 'ERR_INVALID_ARG_TYPE';
    throw error;
}

interface SinkTarget {
    /** Returns the descriptor to write to, opening it on first use. */
    open(): number;
    /** Writes at the sink's current logical offset. */
    write(fd: number, bytes: Uint8Array): number;
    /** Releases the descriptor; must tolerate being called once only. */
    close(fd: number): void;
}

function pathTarget(path: string): SinkTarget {
    let position = 0;
    return {
        // Bun's FileSink overwrites from byte zero without truncating a longer
        // existing file. Create missing files, then reopen read/write.
        open() {
            if (!fs.exists(path)) fs.close(fs.open(path, 'w', 0o664));
            return fs.open(path, 'r+');
        },
        write(fd, bytes) {
            const written = fs.pwrite(fd, bytes, position);
            position += written;
            return written;
        },
        close: fd => fs.close(fd),
    };
}

function fdTarget(fd: number): SinkTarget {
    return {
        open: () => fd,
        write: (targetFd, bytes) => fs.write(targetFd, bytes),
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

const fileSinkBrands = new WeakSet<object>();

function assertFileSink(value: unknown): void {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !fileSinkBrands.has(value)) {
        const error = new TypeError('Expected FileSink') as TypeError & { code: string };
        error.code = 'ERR_INVALID_THIS';
        throw error;
    }
}

class FileSinkImpl {
    readonly #target: SinkTarget;
    readonly #buffer = new Uint8Array(FILE_SINK_BUFFER_SIZE);
    #buffered = 0;
    #bufferOffset = 0;
    #pending: Uint8Array<ArrayBuffer> | undefined;
    #pendingOffset = 0;
    #fd: number | undefined;
    #ended = false;

    constructor(target: SinkTarget, open = false) {
        this.#target = target;
        fileSinkBrands.add(this);
        if (open) this.#fd = this.#openTracked();
    }

    start(options?: { highWaterMark?: number } | null): void {
        assertFileSink(this);
        // Bun's sink.start() is an advisory reconfiguration hook. It accepts
        // any value and does not discard already buffered data.
        void options;
    }

    write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): number | true {
        assertFileSink(this);
        // Native Bun validates the chunk before consulting the closed state.
        const bytes = chunkBytes(chunk);
        if (this.#ended) return true;
        let flushed = 0;
        if (this.#pending || this.#bufferOffset > 0) flushed = this.#flushBuffered();
        if (bytes.byteLength === 0) return flushed;
        if (this.#buffered + bytes.byteLength < FILE_SINK_BUFFER_SIZE) {
            this.#buffer.set(bytes, this.#buffered);
            this.#buffered += bytes.byteLength;
            return flushed + bytes.byteLength;
        }
        this.#pending = bytes;
        return flushed + this.#flushBuffered();
    }

    flush(_wait?: boolean): number | true {
        assertFileSink(this);
        if (this.#ended) return true;
        return this.#flushBuffered();
    }

    #flushBuffered(): number {
        if (this.#buffered === 0 && !this.#pending) return 0;
        const fd = this.#fd ?? (this.#fd = this.#openTracked());
        let flushed = 0;
        // Retain offsets across failed writes so a retry never replays bytes.
        while (this.#bufferOffset < this.#buffered) {
            const written = this.#target.write(fd, this.#buffer.subarray(this.#bufferOffset, this.#buffered));
            if (written <= 0) throw new Error('FileSink write made no progress');
            this.#bufferOffset += written;
            flushed += written;
        }
        this.#bufferOffset = 0;
        this.#buffered = 0;
        const pending = this.#pending;
        if (pending) {
            while (this.#pendingOffset < pending.byteLength) {
                const written = this.#target.write(fd, pending.subarray(this.#pendingOffset));
                if (written <= 0) throw new Error('FileSink write made no progress');
                this.#pendingOffset += written;
                flushed += written;
            }
            this.#pending = undefined;
            this.#pendingOffset = 0;
        }
        return flushed;
    }

    #openTracked(): number {
        const fd = this.#target.open();
        sinkFinalizer?.register(this, { target: this.#target, fd }, this);
        return fd;
    }

    end(...args: [error?: Error | null]): number {
        assertFileSink(this);
        if (this.#ended) return 0;
        void args;
        let flushed = 0;
        try {
            // Bun currently flushes pending file data even when an error value
            // is supplied; the optional argument is metadata for pipe sinks.
            flushed = this.#flushBuffered();
        } finally {
            // The fd must close on every path: end() is the only close.
            this.#ended = true;
            sinkFinalizer?.unregister(this);
            const fd = this.#fd;
            this.#fd = undefined;
            this.#pending = undefined;
            this.#pendingOffset = 0;
            this.#buffered = 0;
            this.#bufferOffset = 0;
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

// Native FileSink objects expose a built-in-style, illegal constructor rather
// than the implementation class used to allocate them.
const fileSinkConstructor = function FileSink(): never {
    const error = new TypeError('Illegal constructor') as TypeError & { code: string };
    error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
    throw error;
};
Object.defineProperty(fileSinkConstructor, 'prototype', { value: undefined });

const fileSinkPrototype = FileSinkImpl.prototype;
Object.defineProperty(fileSinkPrototype, 'constructor', {
    value: fileSinkConstructor,
    writable: true,
    configurable: true,
});
for (const name of ['start', 'write', 'flush', 'end', 'ref', 'unref'] as const) {
    Object.defineProperty(fileSinkPrototype, name, {
        value: fileSinkPrototype[name],
        enumerable: true,
        writable: false,
        configurable: false,
    });
}
Object.defineProperty(fileSinkPrototype, Symbol.toStringTag, {
    value: 'FileSink',
    configurable: true,
});

export type FileSink = FileSinkImpl;

/** A sink that opens `path` eagerly and owns its descriptor. */
export function filePathSink(path: string): FileSink {
    // Bun.file(path).writer() creates a missing file immediately, before the
    // first write or flush, while preserving an existing file's contents.
    return new FileSinkImpl(pathTarget(path), true);
}

/** A sink over an already-owned descriptor; closing is the caller's job. */
export function fileDescriptorSink(fd: number): FileSink {
    return new FileSinkImpl(fdTarget(fd));
}

export { chunkBytes as sinkChunkBytes };
