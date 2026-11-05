/**
 * Bun.stdin/stdout/stderr as BunFile-like handles over the process stdio
 * descriptors. I/O is synchronous through the native fs binding; FileSink
 * (`writer()`) and non-blocking stdin are not part of this subset.
 */

import { concatChunks } from '../utils/bytes';
import { fileDescriptorSink, sinkChunkBytes, type FileSink } from './file-sink';

const engine = import.meta.use('engine');
const fs = import.meta.use('fs');

const STDIO_CHUNK_SIZE = 64 * 1024;

function inputToBytes(value: unknown): Uint8Array<ArrayBuffer> {
    // The sink chunk converter covers strings, buffers, and Blobs; the stdio
    // error label is the only difference from the file sink.
    try {
        return sinkChunkBytes(value);
    } catch (error) {
        if (error instanceof TypeError) {
            throw new TypeError('Bun.write: unsupported input type for a stdio file');
        }
        throw error;
    }
}

function readAllSync(fd: number): Uint8Array<ArrayBuffer> {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    while (true) {
        const buffer = new Uint8Array(STDIO_CHUNK_SIZE);
        const count = fs.read(fd, buffer);
        if (count <= 0) break;
        chunks.push(buffer.slice(0, count));
    }
    return concatChunks(chunks);
}

/** A fixed-descriptor file handle backing Bun.stdin/stdout/stderr. */
export class StdioFile {
    readonly #fd: number;
    readonly #readable: boolean;
    readonly #label: string;

    constructor(fd: number, label: string, readable: boolean) {
        this.#fd = fd;
        this.#label = label;
        this.#readable = readable;
    }

    async write(data: string | ArrayBufferView | ArrayBufferLike | Blob): Promise<number> {
        if (this.#readable) {
            throw new TypeError(`Bun.${this.#label} is not writable`);
        }
        const bytes = inputToBytes(data);
        let written = 0;
        while (written < bytes.byteLength) {
            const count = fs.write(this.#fd, bytes.subarray(written));
            if (count <= 0) throw new Error(`Bun.${this.#label}: write failed`);
            written += count;
        }
        return written;
    }

    async text(): Promise<string> {
        return engine.decodeString(this.#readBytes());
    }

    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
        return this.#readBytes();
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        return this.#readBytes().buffer;
    }

    async json<T = unknown>(): Promise<T> {
        return JSON.parse(await this.text()) as T;
    }

    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        if (!this.#readable) {
            throw new TypeError(`Bun.${this.#label} is not readable`);
        }
        const fd = this.#fd;
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
            pull(controller) {
                const buffer = new Uint8Array(STDIO_CHUNK_SIZE);
                const count = fs.read(fd, buffer);
                if (count <= 0) {
                    controller.close();
                    return;
                }
                controller.enqueue(buffer.slice(0, count));
            },
        });
    }

    async exists(): Promise<boolean> {
        return true;
    }

    /**
     * Incremental sink over the fixed descriptor; end() flushes but never
     * closes the process-owned fd.
     */
    writer(options?: { highWaterMark?: number }): FileSink {
        if (this.#readable) {
            throw new TypeError(`Bun.${this.#label} is not writable`);
        }
        const sink = fileDescriptorSink(this.#fd);
        sink.start(options);
        return sink;
    }

    #readBytes(): Uint8Array<ArrayBuffer> {
        if (!this.#readable) {
            throw new TypeError(`Bun.${this.#label} is not readable`);
        }
        return readAllSync(this.#fd);
    }
}

/** The stdio file a value refers to, or undefined for ordinary destinations. */
export function stdioDestination(value: unknown): StdioFile | undefined {
    return value instanceof StdioFile ? value : undefined;
}

export const stdout = new StdioFile(1, 'stdout', false);
export const stderr = new StdioFile(2, 'stderr', false);
export const stdin = new StdioFile(0, 'stdin', true);
