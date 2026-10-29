import type {
    StatefulTransform,
    SyncStatefulTransform,
    TransformCallbackOptions,
    TransformResult,
    SyncTransformResult,
} from '../stream/iter';
import {
    brotliCompressSync,
    brotliDecompressSync,
    deflateSync,
    gzipSync,
    inflateSync,
    gunzipSync,
} from './mod';
import type { BrotliOptions, ZlibOptions } from './constants';

type Batch = Uint8Array[] | null;
type SyncCodec = (input: Buffer, options?: any) => Uint8Array;

function abortError(reason?: unknown): Error & { code: string } {
    const error = new Error('The operation was aborted', reason === undefined ? undefined : { cause: reason }) as Error & { code: string };
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function unsupported(name: string): never {
    throw Object.assign(new Error(`${name} is not supported by this runtime`), {
        code: 'ERR_METHOD_NOT_IMPLEMENTED',
    });
}

function collectSync(source: Iterable<Batch>): Buffer {
    const chunks: Buffer[] = [];
    for (const batch of source) if (batch) {
        for (const chunk of batch) chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function collect(source: AsyncIterable<Batch>, signal: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const batch of source) {
        if (signal.aborted) {
            const error = new Error('The operation was aborted', { cause: signal.reason });
            error.name = 'AbortError';
            throw error;
        }
        if (batch) for (const chunk of batch) chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function transform(codec: SyncCodec, options?: object): StatefulTransform {
    return {
        async *transform(source: AsyncIterable<Batch>, context: TransformCallbackOptions): AsyncIterable<TransformResult> {
            const input = await collect(source, context.signal);
            if (context.signal.aborted) throw abortError(context.signal.reason);
            const output = codec(input, options);
            if (context.signal.aborted) throw abortError(context.signal.reason);
            yield output;
        },
    };
}

function transformSync(codec: SyncCodec, options?: object): SyncStatefulTransform {
    return {
        *transform(source: Iterable<Batch>): Iterable<SyncTransformResult> {
            yield codec(collectSync(source), options);
        },
    };
}

export function compressBrotli(options?: BrotliOptions): StatefulTransform { return transform(brotliCompressSync, options); }
export function compressBrotliSync(options?: BrotliOptions): SyncStatefulTransform { return transformSync(brotliCompressSync, options); }
export function compressDeflate(options?: ZlibOptions): StatefulTransform { return transform(deflateSync, options); }
export function compressDeflateSync(options?: ZlibOptions): SyncStatefulTransform { return transformSync(deflateSync, options); }
export function compressGzip(options?: ZlibOptions): StatefulTransform { return transform(gzipSync, options); }
export function compressGzipSync(options?: ZlibOptions): SyncStatefulTransform { return transformSync(gzipSync, options); }
export function decompressBrotli(options?: BrotliOptions): StatefulTransform { return transform(brotliDecompressSync, options); }
export function decompressBrotliSync(options?: BrotliOptions): SyncStatefulTransform { return transformSync(brotliDecompressSync, options); }
export function decompressDeflate(options?: ZlibOptions): StatefulTransform { return transform(inflateSync, options); }
export function decompressDeflateSync(options?: ZlibOptions): SyncStatefulTransform { return transformSync(inflateSync, options); }
export function decompressGzip(options?: ZlibOptions): StatefulTransform { return transform(gunzipSync, options); }
export function decompressGzipSync(options?: ZlibOptions): SyncStatefulTransform { return transformSync(gunzipSync, options); }

export function compressZstd(_options?: object): StatefulTransform { return unsupported('compressZstd'); }
export function compressZstdSync(_options?: object): SyncStatefulTransform { return unsupported('compressZstdSync'); }
export function decompressZstd(_options?: object): StatefulTransform { return unsupported('decompressZstd'); }
export function decompressZstdSync(_options?: object): SyncStatefulTransform { return unsupported('decompressZstdSync'); }
