import { Readable, Writable, Duplex } from './mod';
import * as nodeBuffer from '../buffer';

const { Buffer } = nodeBuffer;

function getGlobal(name: keyof typeof globalThis): any {
    return (globalThis as any)[name];
}

// Re-exports of Web Streams globals (for named imports)
export const ReadableStream = getGlobal('ReadableStream');
export const ReadableStreamDefaultReader = getGlobal('ReadableStreamDefaultReader');
export const ReadableStreamBYOBReader = getGlobal('ReadableStreamBYOBReader');
export const ReadableStreamBYOBRequest = getGlobal('ReadableStreamBYOBRequest');
export const ReadableByteStreamController = getGlobal('ReadableByteStreamController');
export const ReadableStreamDefaultController = getGlobal('ReadableStreamDefaultController');
export const TransformStream = getGlobal('TransformStream');
export const TransformStreamDefaultController = getGlobal('TransformStreamDefaultController');
export const WritableStream = getGlobal('WritableStream');
export const WritableStreamDefaultWriter = getGlobal('WritableStreamDefaultWriter');
export const WritableStreamDefaultController = getGlobal('WritableStreamDefaultController');
export const ByteLengthQueuingStrategy = getGlobal('ByteLengthQueuingStrategy');
export const CountQueuingStrategy = getGlobal('CountQueuingStrategy');
export const TextEncoderStream = getGlobal('TextEncoderStream');
export const TextDecoderStream = getGlobal('TextDecoderStream');
export const CompressionStream = getGlobal('CompressionStream');
export const DecompressionStream = getGlobal('DecompressionStream');

// ── Readable.fromWeb(readableStream, options?) ────────────────────────────────
// Converts a Web ReadableStream into a Node.js Readable

export function readableFromWeb(webStream: ReadableStream, options?: { encoding?: string; highWaterMark?: number; objectMode?: boolean }): Readable {
    const reader = webStream.getReader();
    const read = async (size: number) => {
        try {
            const { done, value } = await reader.read();
            if (done) {
                readable.push(null);
            } else {
                const chunk = options?.encoding && typeof value === 'string'
                    ? Buffer.from(value, options.encoding as BufferEncoding)
                    : value;
                readable.push(chunk);
            }
        } catch (err) {
            readable.destroy(err as Error);
        }
    };

    const readable = new Readable({
        highWaterMark: options?.highWaterMark,
        objectMode: options?.objectMode,
        read,
    });

    return readable;
}

// ── Readable.toWeb(readable) ──────────────────────────────────────────────────
// Converts a Node.js Readable into a Web ReadableStream

export function readableToWeb(readable: Readable): ReadableStream {
    const RS = getGlobal('ReadableStream') as typeof globalThis.ReadableStream;
    let iterator: AsyncIterator<any>;

    if (typeof (readable as any)[Symbol.asyncIterator] === 'function') {
        iterator = (readable as any)[Symbol.asyncIterator]();
    } else {
        iterator = (async function* () {
            while (true) {
                const chunk = readable.read();
                if (chunk === null) {
                    await new Promise<void>((resolve) => {
                        readable.once('readable', resolve);
                        readable.once('end', resolve);
                    });
                    const retry = readable.read();
                    if (retry === null) return;
                    yield retry;
                } else {
                    yield chunk;
                }
            }
        })();
    }

    return new RS({
        async pull(controller) {
            try {
                const { done, value } = await iterator.next();
                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            } catch (err) {
                controller.error(err);
            }
        },
        async cancel() {
            readable.destroy();
        },
    });
}

// ── Writable.fromWeb(writableStream, options?) ────────────────────────────────
// Converts a Web WritableStream into a Node.js Writable

export function writableFromWeb(webStream: WritableStream, options?: { decodeStrings?: boolean; highWaterMark?: number }): Writable {
    const writer = webStream.getWriter();

    const writable = new Writable({
        highWaterMark: options?.highWaterMark,
        write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            const data = chunk instanceof Uint8Array ? chunk : (options?.decodeStrings !== false ? Buffer.from(String(chunk), encoding) : chunk);
            writer.write(data).then(() => callback(), callback);
        },
        final(callback: (error?: Error | null) => void) {
            writer.close().then(() => callback(), callback);
        },
    });

    return writable;
}

// ── Writable.toWeb(writable) ──────────────────────────────────────────────────
// Converts a Node.js Writable into a Web WritableStream

export function writableToWeb(writable: Writable): WritableStream {
    const WS = getGlobal('WritableStream') as typeof WritableStream;
    return new WS({
        async write(chunk: Uint8Array) {
            await new Promise<void>((resolve, reject) => {
                if (!writable.write(chunk)) {
                    writable.once('drain', resolve);
                } else {
                    resolve();
                }
            });
        },
        async close() {
            await new Promise<void>((resolve) => {
                writable.end(resolve);
            });
        },
        abort(reason: any) {
            writable.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        },
    });
}

// ── Duplex.fromWeb(duplexStream, options?) ────────────────────────────────────
// Converts a Web TransformStream / {readable,writable} into a Node.js Duplex

export function duplexFromWeb(webDuplex: TransformStream | { readable: ReadableStream; writable: WritableStream }, options?: { allowHalfOpen?: boolean; highWaterMark?: number }): Duplex {
    let webReadable: ReadableStream;
    let webWritable: WritableStream;

    if (webDuplex instanceof TransformStream) {
        webReadable = webDuplex.readable;
        webWritable = webDuplex.writable;
    } else {
        webReadable = webDuplex.readable;
        webWritable = webDuplex.writable;
    }

    const reader = webReadable.getReader();
    const writer = webWritable.getWriter();

    const read = async (size: number) => {
        try {
            const { done, value } = await reader.read();
            if (done) {
                duplex.push(null);
            } else {
                duplex.push(value);
            }
        } catch (err) {
            duplex.destroy(err as Error);
        }
    };

    const duplex = new Duplex({
        allowHalfOpen: options?.allowHalfOpen,
        highWaterMark: options?.highWaterMark,
        read,
        write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            writer.write(chunk).then(() => callback(), callback);
        },
        final(callback: (error?: Error | null) => void) {
            writer.close().then(() => callback(), callback);
        },
    });

    return duplex;
}

export default {
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    ReadableStreamBYOBRequest,
    ReadableByteStreamController,
    ReadableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
    TextEncoderStream,
    TextDecoderStream,
    CompressionStream,
    DecompressionStream,
    readableFromWeb,
    readableToWeb,
    writableFromWeb,
    writableToWeb,
    duplexFromWeb,
};
