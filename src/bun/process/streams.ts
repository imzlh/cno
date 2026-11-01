import { arrayBufferBackedBytes, sanitizeSurrogates } from '../../utils/bytes';
import type { BunProcessFileSink } from './types';

const engine = import.meta.use('engine');
const PIPE_CHUNK_SIZE = 64 * 1024;

function closeQuietly(pipe: CModuleProcess.Pipe): void {
    try {
        pipe.close();
    } catch {
        // EOF, cancellation, and process teardown can all race to close a pipe.
    }
}

function inputBytes(value: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
    if (typeof value === 'string') {
        return arrayBufferBackedBytes(engine.encodeString(sanitizeSurrogates(value)));
    }
    const source = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
}

async function consumeBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (!(next.value instanceof Uint8Array)) {
                throw new TypeError('Bun subprocess streams must contain Uint8Array chunks');
            }
            chunks.push(next.value);
            length += next.value.byteLength;
        }
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }

    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

type BunReadable = ReadableStream<Uint8Array<ArrayBuffer>> & {
    blob(): Promise<Blob>;
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
};

/**
 * Drain native output eagerly. Waiting on `exited` before reading stdout must
 * not deadlock when a child fills the kernel pipe.
 */
export function readablePipe(
    pipe: CModuleProcess.Pipe,
    countBytes?: (length: number) => void,
): BunReadable {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
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

    Object.defineProperties(stream, {
        blob: {
            value: async () => new Blob([await consumeBytes(stream)]),
            configurable: true,
        },
        bytes: {
            value: () => consumeBytes(stream),
            configurable: true,
        },
        text: {
            value: async () => engine.decodeString(await consumeBytes(stream)),
            configurable: true,
        },
        json: {
            value: async () => JSON.parse(engine.decodeString(await consumeBytes(stream))),
            configurable: true,
        },
    });
    return stream;
}

/** A serialized Bun FileSink facade over a native child-stdin pipe. */
export class FileSink implements BunProcessFileSink {
    #pipe: CModuleProcess.Pipe;
    #queue: Promise<void> = Promise.resolve();
    #buffered = 0;
    #ended = false;

    constructor(pipe: CModuleProcess.Pipe) {
        this.#pipe = pipe;
    }

    start(options?: { highWaterMark?: number }): void {
        if (options !== undefined && (typeof options !== 'object' || options === null)) {
            throw new TypeError('FileSink.start options must be an object');
        }
        const mark = options?.highWaterMark;
        if (mark !== undefined && (!Number.isFinite(mark) || mark < 0)) {
            throw new RangeError('FileSink highWaterMark must be a non-negative number');
        }
    }

    write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): Promise<number> {
        if (this.#ended) throw new Error('FileSink is already closed');
        if (typeof chunk !== 'string' && !ArrayBuffer.isView(chunk)
            && !(chunk instanceof ArrayBuffer)
            && !(typeof SharedArrayBuffer !== 'undefined' && chunk instanceof SharedArrayBuffer)) {
            throw new TypeError('FileSink.write expects a string or binary buffer');
        }
        const bytes = inputBytes(chunk);
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

    flush(): Promise<number> {
        const count = this.#buffered;
        this.#buffered = 0;
        return this.#queue.then(() => count);
    }

    end(error?: Error): Promise<number> {
        // Validate before touching state: a rejected argument must not leave the sink half-closed.
        if (error !== undefined && !(error instanceof Error)) {
            throw new TypeError('FileSink.end error must be an Error');
        }
        if (this.#ended) return Promise.resolve(0);
        this.#ended = true;
        const count = this.#buffered;
        this.#buffered = 0;

        const operation = this.#queue.then(async () => {
            try {
                if (error) throw error;
                await this.#pipe.shutdown();
            } finally {
                // The child must observe EOF on every path, including end(error).
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

export function isBufferInput(value: unknown): value is string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView {
    return typeof value === 'string'
        || value instanceof ArrayBuffer
        || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
        || ArrayBuffer.isView(value);
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
                await sink.end().catch(() => {});
                return;
            }
        }
        await sink.end();
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        await sink.end(error instanceof Error ? error : new Error(String(error))).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
}
