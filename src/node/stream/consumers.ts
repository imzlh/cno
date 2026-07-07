import * as nodeBuffer from '../buffer';

const engine = import.meta.use('engine');
const { Blob, Buffer } = nodeBuffer;

type Consumable = ReadableStream | NodeJS.ReadableStream | AsyncIterable<unknown>;
type NodeReadableListener = (...args: unknown[]) => void;

function isReadableStream(value: unknown): value is ReadableStream {
    return !!value && typeof (value as ReadableStream).getReader === 'function';
}

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
    return !!value && typeof (value as NodeJS.ReadableStream).on === 'function';
}

async function* readableStreamToAsyncIterable(stream: ReadableStream): AsyncIterableIterator<unknown> {
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

function toAsyncIterable(stream: Consumable): AsyncIterable<unknown> {
    if (isReadableStream(stream)) return readableStreamToAsyncIterable(stream);
    if (isAsyncIterable(stream)) return stream;
    throw new TypeError('The "stream" argument must be a stream or async iterable');
}

function isAsyncIterable(value: Consumable): value is AsyncIterable<unknown> {
    return typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
}

async function chunkToBuffer(chunk: unknown): Promise<Uint8Array> {
    if (typeof chunk === 'string') return Buffer.from(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (Blob && chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer());
    return Buffer.from(String(chunk));
}

async function readAll(stream: Consumable): Promise<InstanceType<typeof Buffer>> {
    if (isNodeReadableStream(stream) && !isReadableStream(stream)) {
        return await new Promise<InstanceType<typeof Buffer>>((resolve, reject) => {
            const chunks: Uint8Array[] = [];
            const readable = stream as NodeJS.ReadableStream & {
                resume?: () => void;
                off?: (event: string, listener: NodeReadableListener) => void;
                removeListener?: (event: string, listener: NodeReadableListener) => void;
            };
            let pending = Promise.resolve();
            let settled = false;
            const cleanup = () => {
                off('data', onData);
                off('end', onEnd);
                off('error', onError);
            };
            const fail = (err: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            const off = (event: string, listener: NodeReadableListener) => {
                if (typeof readable.off === 'function') readable.off(event, listener);
                else readable.removeListener?.(event, listener);
            };
            const onData = (chunk: unknown) => {
                pending = pending.then(async () => {
                    chunks.push(await chunkToBuffer(chunk));
                }, async () => {
                    chunks.push(await chunkToBuffer(chunk));
                });
                pending.catch(fail);
            };
            const onEnd = () => {
                cleanup();
                pending.then(() => {
                    if (settled) return;
                    settled = true;
                    resolve(Buffer.concat(chunks));
                }, fail);
            };
            const onError = (err: unknown) => {
                fail(err);
            };
            readable.on('data', onData);
            readable.on('end', onEnd);
            readable.on('error', onError);
            readable.resume?.();
        });
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of toAsyncIterable(stream)) {
        chunks.push(await chunkToBuffer(chunk));
    }
    return Buffer.concat(chunks);
}

export async function buffer(stream: Consumable): Promise<InstanceType<typeof Buffer>> {
    return await readAll(stream);
}

export async function arrayBuffer(stream: Consumable): Promise<ArrayBuffer> {
    const data = await readAll(stream);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

export async function text(stream: Consumable): Promise<string> {
    return engine.decodeString(await readAll(stream));
}

export async function json(stream: Consumable): Promise<unknown> {
    return JSON.parse(await text(stream));
}

export async function blob(stream: Consumable): Promise<Blob> {
    if (!Blob) throw new Error('Blob is not available in this runtime');
    return new Blob([await readAll(stream)]);
}

export default {
    arrayBuffer,
    blob,
    buffer,
    json,
    text,
};
