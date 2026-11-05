/**
 * Bun.stdin/stdout/stderr as BunFile-like handles over the process stdio
 * descriptors. Ordinary reads and writes reuse the runtime's shared stdio
 * streams so pipe I/O stays asynchronous and ordered with Deno/Node stdio.
 */

import { concatChunks } from '../utils/bytes';
import { fileDescriptorSink, sinkChunkBytes, type FileSink } from './file-sink';

const engine = import.meta.use('engine');
const streams = import.meta.use('streams');

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

async function readAll(stream: CModuleStreams.StdioStream): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    while (true) {
        const buffer = new Uint8Array(STDIO_CHUNK_SIZE);
        const count = await stream.read(buffer);
        if (count === null || count <= 0) break;
        chunks.push(buffer.slice(0, count));
    }
    return concatChunks(chunks);
}

/** A fixed-descriptor file handle backing Bun.stdin/stdout/stderr. */
export class StdioFile {
    readonly #fd: number;
    readonly #stream: CModuleStreams.StdioStream;
    readonly #readable: boolean;
    readonly #label: string;

    constructor(fd: number, stream: CModuleStreams.StdioStream, label: string, readable: boolean) {
        this.#fd = fd;
        this.#stream = stream;
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
            const count = await this.#stream.write(bytes.subarray(written));
            if (count <= 0) throw new Error(`Bun.${this.#label}: write failed`);
            written += count;
        }
        return written;
    }

    async text(): Promise<string> {
        return engine.decodeString(await this.#readBytes());
    }

    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
        return await this.#readBytes();
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        return (await this.#readBytes()).buffer;
    }

    async json<T = unknown>(): Promise<T> {
        return JSON.parse(await this.text()) as T;
    }

    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        if (!this.#readable) {
            throw new TypeError(`Bun.${this.#label} is not readable`);
        }
        return this.#stream.createReadStream() as ReadableStream<Uint8Array<ArrayBuffer>>;
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

    async #readBytes(): Promise<Uint8Array<ArrayBuffer>> {
        if (!this.#readable) {
            throw new TypeError(`Bun.${this.#label} is not readable`);
        }
        return await readAll(this.#stream);
    }
}

/** The stdio file a value refers to, or undefined for ordinary destinations. */
export function stdioDestination(value: unknown): StdioFile | undefined {
    return value instanceof StdioFile ? value : undefined;
}

export const stdout = new StdioFile(1, streams.stdout, 'stdout', false);
export const stderr = new StdioFile(2, streams.stderr, 'stderr', false);
export const stdin = new StdioFile(0, streams.stdin, 'stdin', true);
