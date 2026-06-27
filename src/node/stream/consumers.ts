import * as nodeBuffer from '../buffer';

const { Blob, Buffer } = nodeBuffer;

type Consumable = ReadableStream | NodeJS.ReadableStream | AsyncIterable<any>;

function isReadableStream(value: unknown): value is ReadableStream {
    return !!value && typeof (value as ReadableStream).getReader === 'function';
}

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
    return !!value && typeof (value as NodeJS.ReadableStream).on === 'function';
}

async function* readableStreamToAsyncIterable(stream: ReadableStream): AsyncIterableIterator<any> {
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

function toAsyncIterable(stream: Consumable): AsyncIterable<any> {
    if (isReadableStream(stream)) return readableStreamToAsyncIterable(stream);
    if (stream && typeof (stream as AsyncIterable<any>)[Symbol.asyncIterator] === 'function') {
        return stream as AsyncIterable<any>;
    }
    throw new TypeError('The "stream" argument must be a stream or async iterable');
}

async function chunkToBuffer(chunk: any): Promise<Uint8Array> {
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
                off?: (event: string, listener: (...args: any[]) => void) => void;
                removeListener?: (event: string, listener: (...args: any[]) => void) => void;
            };
            const cleanup = () => {
                off('data', onData);
                off('end', onEnd);
                off('error', onError);
            };
            const off = (event: string, listener: (...args: any[]) => void) => {
                if (typeof readable.off === 'function') readable.off(event, listener);
                else readable.removeListener?.(event, listener);
            };
            const onData = (chunk: any) => {
                void chunkToBuffer(chunk).then(
                    (buffer) => chunks.push(buffer),
                    (err) => {
                        cleanup();
                        reject(err);
                    },
                );
            };
            const onEnd = () => {
                cleanup();
                resolve(Buffer.concat(chunks));
            };
            const onError = (err: unknown) => {
                cleanup();
                reject(err);
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
    return (await readAll(stream)).toString('utf8');
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
