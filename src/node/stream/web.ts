import { Readable, Writable, Duplex } from './mod';
import * as nodeBuffer from '../buffer';

const { Buffer } = nodeBuffer;

function getGlobal<K extends keyof typeof globalThis>(name: K): (typeof globalThis)[K] {
    return Reflect.get(globalThis, name) as (typeof globalThis)[K];
}

interface AsyncIterableReadable {
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
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

export function readableFromWeb(webStream: ReadableStream, options?: { encoding?: BufferEncoding; highWaterMark?: number; objectMode?: boolean }): Readable {
    const reader = webStream.getReader();
    const read = async (size: number) => {
        try {
            const { done, value } = await reader.read();
            if (done) {
                readable.push(null);
            } else {
                const chunk = options?.encoding && typeof value === 'string'
                    ? Buffer.from(value, options.encoding)
                    : value;
                readable.push(chunk);
            }
        } catch (err) {
            readable.destroy(asError(err));
        }
    };

    const readable = new Readable({
        highWaterMark: options?.highWaterMark,
        objectMode: options?.objectMode,
        read,
        // Destroying the Node stream must release the underlying web source,
        // otherwise the ReadableStream stays locked and its producer leaks.
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
            const finish = () => callback(error);
            try {
                reader.cancel(error ?? undefined).then(finish, finish);
            } catch {
                finish();
            }
        },
    });

    return readable;
}

// ── Readable.toWeb(readable) ──────────────────────────────────────────────────
// Converts a Node.js Readable into a Web ReadableStream

export function readableToWeb(readable: Readable): ReadableStream {
    const RS = getGlobal('ReadableStream') as typeof globalThis.ReadableStream;
    let iterator: AsyncIterator<unknown>;

    const getAsyncIterator = Reflect.get(readable, Symbol.asyncIterator);
    if (typeof getAsyncIterator === 'function') {
        iterator = getAsyncIterator.call(readable);
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
        write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
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

    // The web stream owns this writable now, and its errors are reported through
    // the writer's promises. Node emits 'error' asynchronously, so without a
    // permanent sink the error would land after the per-write listener is gone
    // and crash the process as an unhandled 'error' event.
    writable.on('error', () => {});

    // Rejects as soon as the Node writable errors or closes early, so a web
    // writer never waits on a stream that can no longer make progress.
    const guard = <T>(body: (resolve: () => void, reject: (err: Error) => void) => void): Promise<T | void> =>
        new Promise<void>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                writable.removeListener('error', onError);
                writable.removeListener('close', onClose);
            };
            const ok = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };
            const fail = (err: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            function onError(err: unknown) { fail(asError(err)); }
            function onClose() {
                fail(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
            }
            writable.on('error', onError);
            writable.on('close', onClose);

            const existing = Reflect.get(writable, 'errored');
            if (existing != null) { fail(asError(existing)); return; }
            if (writable.destroyed) { onClose(); return; }

            body(ok, fail);
        });

    return new WS({
        write(chunk: Uint8Array) {
            return guard((resolve, reject) => {
                const drained = writable.write(chunk, (err?: Error | null) => {
                    if (err) reject(asError(err));
                });
                if (drained) resolve();
                else writable.once('drain', resolve);
            });
        },
        close() {
            return guard((resolve) => {
                writable.end(() => resolve());
            });
        },
        abort(reason: unknown) {
            writable.destroy(asError(reason));
        },
    });
}

// ── Duplex.toWeb(duplex) ──────────────────────────────────────────────────────
// Converts a Node.js Duplex into { readable, writable } Web stream pair

export function duplexToWeb(duplex: Duplex): { readable: ReadableStream; writable: WritableStream } {
    return {
        readable: readableToWeb(duplex as unknown as Readable),
        writable: writableToWeb(duplex as unknown as Writable),
    };
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
            duplex.destroy(asError(err));
        }
    };

    const duplex = new Duplex({
        allowHalfOpen: options?.allowHalfOpen,
        highWaterMark: options?.highWaterMark,
        read,
        write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
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
    duplexToWeb,
};
