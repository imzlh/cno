import { arrayBufferBackedBytes, sanitizeSurrogates } from '../../utils/bytes';
import {
    readableStreamToBlob,
    readableStreamToBytes,
    readableStreamToJSON,
    readableStreamToText,
} from '../utils/streams';

const engine = import.meta.use('engine');
const PIPE_CHUNK_SIZE = 64 * 1024;
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

function closeQuietly(pipe: CModuleProcess.Pipe): void {
    try {
        pipe.close();
    } catch {
        // EOF, cancellation, and process teardown can all race to close a pipe.
    }
}

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

function inputBytes(value: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
    if (typeof value === 'string') {
        return arrayBufferBackedBytes(engine.encodeString(sanitizeSurrogates(value)));
    }
    const byteLength = rawBufferByteLength(value);
    const source = arrayBufferIsView(value)
        ? viewBytes(value)
        : byteLength === 0 ? emptyBytes : new Uint8Array(value as ArrayBufferLike, 0, byteLength);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
}

const readableStreamLocked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'locked')!.get!;

function assertReadableStream(value: unknown): asserts value is ReadableStream<unknown> {
    try {
        Reflect.apply(readableStreamLocked, value, []);
    } catch {
        const error = new TypeError('Value of "this" must be of type ReadableStream') as TypeError & { code: string };
        error.code = 'ERR_INVALID_THIS';
        throw error;
    }
}

const { blob, bytes, text, json } = {
    blob(this: unknown): Promise<Blob> {
        assertReadableStream(this);
        return readableStreamToBlob(this);
    },
    bytes(this: unknown): Promise<Uint8Array<ArrayBuffer>> {
        assertReadableStream(this);
        return readableStreamToBytes(this as ReadableStream<ArrayBufferView | ArrayBufferLike | string>);
    },
    text(this: unknown): Promise<string> {
        assertReadableStream(this);
        return readableStreamToText(this as ReadableStream<ArrayBufferView | ArrayBufferLike | string>);
    },
    json<T = unknown>(this: unknown): Promise<T> {
        assertReadableStream(this);
        return readableStreamToJSON(this as ReadableStream<ArrayBufferView | ArrayBufferLike | string>) as Promise<T>;
    },
};

type BunReadable = ReadableStream<Uint8Array<ArrayBuffer>> & {
    blob(): Promise<Blob>;
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
};

Object.defineProperties(ReadableStream.prototype, {
    blob: { value: blob, enumerable: true, writable: true, configurable: true },
    bytes: { value: bytes, enumerable: true, writable: true, configurable: true },
    json: { value: json, enumerable: true, writable: true, configurable: true },
    text: { value: text, enumerable: true, writable: true, configurable: true },
});

/**
 * Drain native output eagerly. Waiting on `exited` before reading stdout must
 * not deadlock when a child fills the kernel pipe.
 */
export function readablePipe(
    pipe: CModuleProcess.Pipe,
    countBytes?: (length: number) => void,
): BunReadable {
    let cancelled = false;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            void (async () => {
                try {
                    while (!cancelled) {
                        const buffer = new Uint8Array(PIPE_CHUNK_SIZE);
                        const length = await pipe.read(buffer);
                        if (length === 0) break;
                        countBytes?.(length);
                        if (!cancelled) controller.enqueue(buffer.slice(0, length));
                    }
                    closeQuietly(pipe);
                    if (!cancelled) controller.close();
                } catch (error) {
                    closeQuietly(pipe);
                    if (!cancelled) controller.error(error);
                }
            })();
        },
        cancel() {
            cancelled = true;
            closeQuietly(pipe);
        },
    }) as BunReadable;
}

/** A serialized Bun FileSink facade over a native child-stdin pipe. */
const fileSinkBrands = new WeakSet<object>();

function assertFileSink(value: unknown): void {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !fileSinkBrands.has(value)) {
        const error = new TypeError('Expected FileSink') as TypeError & { code: string };
        error.code = 'ERR_INVALID_THIS';
        throw error;
    }
}

function invalidSinkChunk(value: unknown): never {
    const error = new TypeError('write() expects a string, ArrayBufferView, or ArrayBuffer') as TypeError & { code: string };
    error.code = value === null || value === undefined ? 'ERR_STREAM_NULL_VALUES' : 'ERR_INVALID_ARG_TYPE';
    throw error;
}

export class FileSink {
    #pipe: CModuleProcess.Pipe;
    #queue: Promise<void> = Promise.resolve();
    #buffered = 0;
    #ended = false;

    constructor(pipe: CModuleProcess.Pipe) {
        this.#pipe = pipe;
        fileSinkBrands.add(this);
    }

    start(options?: { highWaterMark?: number }): void {
        assertFileSink(this);
        // Bun treats start() as an advisory hook and ignores every option value.
        void options;
    }

    write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): Promise<number> | true {
        assertFileSink(this);
        if (!isBufferInput(chunk)) invalidSinkChunk(chunk);
        const bytes = inputBytes(chunk);
        if (this.#ended) return true;
        this.#buffered += bytes.byteLength;
        const operation = this.#queue.then(async () => {
            let offset = 0;
            while (offset < bytes.byteLength) {
                const written = await this.#pipe.write(bytes.subarray(offset));
                if (written <= 0) throw new Error('FileSink write made no progress');
                offset += written;
            }
        });
        this.#queue = operation;
        return operation.then(() => bytes.byteLength);
    }

    flush(_wait?: boolean): Promise<number> | true {
        assertFileSink(this);
        if (this.#ended) return true;
        const count = this.#buffered;
        this.#buffered = 0;
        return this.#queue.then(() => count);
    }

    end(...args: [error?: Error | null]): Promise<number> | number {
        assertFileSink(this);
        if (this.#ended) return 0;
        // Bun accepts this argument as close metadata; it does not reject it.
        void args;
        this.#ended = true;
        const count = this.#buffered;
        this.#buffered = 0;

        const operation = this.#queue.then(async () => {
            try {
                await this.#pipe.shutdown();
            } finally {
                // The child must observe EOF even if shutdown races with teardown.
                closeQuietly(this.#pipe);
            }
        }, (queueError) => {
            closeQuietly(this.#pipe);
            throw queueError;
        });
        this.#queue = operation;
        return operation.then(() => count);
    }

    ref(): void {
        try { this.#pipe.ref(); } catch { /* closed */ }
    }

    unref(): void {
        try { this.#pipe.unref(); } catch { /* closed */ }
    }
}

const fileSinkConstructor = function FileSink(): never {
    const error = new TypeError('Illegal constructor') as TypeError & { code: string };
    error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
    throw error;
};
Object.defineProperty(fileSinkConstructor, 'prototype', { value: undefined });

const fileSinkPrototype = FileSink.prototype;
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

export function isBufferInput(value: unknown): value is string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView {
    return typeof value === 'string'
        || rawBufferByteLength(value) !== undefined
        || arrayBufferIsView(value);
}

export function copyInputBytes(value: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
    return inputBytes(value);
}

export async function pipeInput(source: ReadableStream<Uint8Array>, sink: FileSink): Promise<void> {
    const reader = source.getReader();
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (!(next.value instanceof Uint8Array)) {
                throw new TypeError('Bun.spawn stdin stream must contain Uint8Array chunks');
            }
            try {
                await sink.write(next.value);
            } catch (writeError) {
                // The child closed stdin early (EPIPE); that is not a spawn failure.
                await reader.cancel(writeError).catch(() => {});
                await Promise.resolve(sink.end()).catch(() => {});
                return;
            }
        }
        await sink.end();
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        await Promise.resolve(sink.end(error instanceof Error ? error : new Error(String(error)))).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
}
