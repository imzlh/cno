import { Readable, Writable } from './mod';

export const broadcastProtocol = Symbol.for('nodejs.stream.iter.broadcast');
export const drainableProtocol = Symbol.for('nodejs.stream.iter.drainable');
export const shareProtocol = Symbol.for('nodejs.stream.iter.share');
export const shareSyncProtocol = Symbol.for('nodejs.stream.iter.shareSync');
export const toAsyncStreamable = Symbol.for('nodejs.stream.iter.toAsyncStreamable');
export const toStreamable = Symbol.for('nodejs.stream.iter.toStreamable');

export type ByteReadableStream = AsyncIterable<Uint8Array[]>;
export type SyncByteReadableStream = Iterable<Uint8Array[]>;
export type Source = string | ArrayBufferLike | ArrayBufferView | Iterable<SyncSource> | AsyncIterable<Source>;
export type SyncSource = string | ArrayBufferLike | ArrayBufferView | Iterable<SyncSource>;
export type TransformResult = Source;
export type SyncTransformResult = SyncSource;

export interface ConsumeOptions {
    signal?: AbortSignal;
    limit?: number;
}

export interface ConsumeSyncOptions {
    limit?: number;
}

export interface TextConsumeOptions extends ConsumeOptions {
    encoding?: string;
}

export interface TextConsumeSyncOptions extends ConsumeSyncOptions {
    encoding?: string;
}

export interface PullOptions {
    signal?: AbortSignal;
}

export interface TransformCallbackOptions {
    signal: AbortSignal;
}

export interface StatelessTransformFn {
    (chunks: Uint8Array[] | null, options: TransformCallbackOptions): Promise<TransformResult | null> | TransformResult | null;
}

export interface SyncStatelessTransformFn {
    (chunks: Uint8Array[] | null): SyncTransformResult | null;
}

export interface StatefulTransform {
    transform(source: AsyncIterable<Uint8Array[] | null>, options: TransformCallbackOptions): AsyncIterable<TransformResult>;
}

export interface SyncStatefulTransform {
    transform(source: Iterable<Uint8Array[] | null>): Iterable<SyncTransformResult>;
}

export type Transform = StatelessTransformFn | StatefulTransform;
export type SyncTransform = SyncStatelessTransformFn | SyncStatefulTransform;

export interface PartialWriter {
    write(chunk: Uint8Array | string, options?: { signal?: AbortSignal }): Promise<void>;
    writev?(chunks: Array<Uint8Array | string>, options?: { signal?: AbortSignal }): Promise<void>;
    writeSync?(chunk: Uint8Array | string): boolean;
    writevSync?(chunks: Array<Uint8Array | string>): boolean;
    end?(options?: { signal?: AbortSignal }): Promise<number>;
    endSync?(): number;
    fail?(reason?: unknown): void;
}

export interface PartialSyncWriter {
    writeSync(chunk: Uint8Array | string): number;
    writevSync?(chunks: Array<Uint8Array | string>): number;
    endSync?(): number;
    fail?(reason?: unknown): void;
}

function abortError(reason?: unknown): Error & { code: string; cause?: unknown } {
    const error = new Error('The operation was aborted', reason === undefined ? undefined : { cause: reason }) as Error & {
        code: string;
        cause?: unknown;
    };
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal.reason);
}

function isView(value: unknown): value is ArrayBufferView {
    return ArrayBuffer.isView(value);
}

function directBytes(value: unknown): Uint8Array | null {
    if (typeof value === 'string') return Buffer.from(value);
    if (isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return new Uint8Array(value);
    return null;
}

function unsupported(name: string): never {
    throw Object.assign(new Error(`${name} is not supported by this runtime`), {
        code: 'ERR_METHOD_NOT_IMPLEMENTED',
    });
}

async function* flattenAsync(input: Source): AsyncGenerator<Uint8Array> {
    const bytes = directBytes(input);
    if (bytes) {
        yield bytes;
        return;
    }
    const asyncStreamable = input && Reflect.get(input, toAsyncStreamable);
    if (typeof asyncStreamable === 'function') {
        yield* flattenAsync(Reflect.apply(asyncStreamable, input, []) as Source);
        return;
    }
    const streamable = input && Reflect.get(input, toStreamable);
    if (typeof streamable === 'function') {
        yield* flattenAsync(Reflect.apply(streamable, input, []) as SyncSource);
        return;
    }
    if (input && typeof Reflect.get(input, Symbol.asyncIterator) === 'function') {
        for await (const item of input as AsyncIterable<Source>) yield* flattenAsync(item);
        return;
    }
    if (input && typeof Reflect.get(input, Symbol.iterator) === 'function') {
        for (const item of input as Iterable<SyncSource>) yield* flattenAsync(item);
        return;
    }
    throw new TypeError('The "input" argument must be a byte source');
}

function* flattenSync(input: SyncSource): Generator<Uint8Array> {
    const bytes = directBytes(input);
    if (bytes) {
        yield bytes;
        return;
    }
    const streamable = input && Reflect.get(input, toStreamable);
    if (typeof streamable === 'function') {
        yield* flattenSync(Reflect.apply(streamable, input, []) as SyncSource);
        return;
    }
    if (input && typeof Reflect.get(input, Symbol.iterator) === 'function') {
        for (const item of input as Iterable<SyncSource>) yield* flattenSync(item);
        return;
    }
    throw new TypeError('The "input" argument must be a synchronous byte source');
}

export async function* from(input: Source): AsyncGenerator<Uint8Array[]> {
    for await (const chunk of flattenAsync(input)) yield [chunk];
}

export function* fromSync(input: SyncSource): Generator<Uint8Array[]> {
    for (const chunk of flattenSync(input)) yield [chunk];
}

async function* ending(source: ByteReadableStream): AsyncGenerator<Uint8Array[] | null> {
    yield* source;
    yield null;
}

function* endingSync(source: SyncByteReadableStream): Generator<Uint8Array[] | null> {
    yield* source;
    yield null;
}

function stateful(transform: Transform | SyncTransform): transform is StatefulTransform | SyncStatefulTransform {
    return typeof transform === 'object' && transform !== null && typeof transform.transform === 'function';
}

function isTransform(value: unknown): value is Transform | SyncTransform {
    return typeof value === 'function' || stateful(value as Transform);
}

function applyTransform(source: ByteReadableStream, transform: Transform, signal: AbortSignal): ByteReadableStream {
    return (async function* () {
        if (stateful(transform)) {
            const output = (transform as StatefulTransform).transform(ending(source), { signal });
            for await (const result of output) yield* from(result);
            return;
        }
        for await (const batch of ending(source)) {
            throwIfAborted(signal);
            const result = await (transform as StatelessTransformFn)(batch, { signal });
            if (result !== null) yield* from(result);
        }
    })();
}

function applyTransformSync(source: SyncByteReadableStream, transform: SyncTransform): SyncByteReadableStream {
    return (function* () {
        if (stateful(transform)) {
            const output = (transform as SyncStatefulTransform).transform(endingSync(source));
            for (const result of output) yield* fromSync(result);
            return;
        }
        for (const batch of endingSync(source)) {
            const result = (transform as SyncStatelessTransformFn)(batch);
            if (result !== null) yield* fromSync(result);
        }
    })();
}

export function pull(source: Source, ...args: Array<Transform | PullOptions>): ByteReadableStream {
    let options: PullOptions = {};
    const tail = args[args.length - 1];
    if (tail && typeof tail === 'object' && !isTransform(tail)) options = args.pop() as PullOptions;
    for (const transform of args) {
        if (!isTransform(transform)) throw new TypeError('Each transform must be a function or stateful transform');
    }
    throwIfAborted(options.signal);
    const controller = new AbortController();
    let result: ByteReadableStream = from(source);
    for (const transform of args as Transform[]) result = applyTransform(result, transform, controller.signal);
    return (async function* () {
        const externalSignal = options.signal;
        const onAbort = () => controller.abort(externalSignal?.reason);
        externalSignal?.addEventListener('abort', onAbort, { once: true });
        try {
            throwIfAborted(externalSignal);
            for await (const batch of result) {
                throwIfAborted(controller.signal);
                yield batch;
            }
            throwIfAborted(controller.signal);
        } finally {
            externalSignal?.removeEventListener('abort', onAbort);
        }
    })();
}

export function pullSync(source: SyncSource, ...transforms: SyncTransform[]): SyncByteReadableStream {
    let result: SyncByteReadableStream = fromSync(source);
    for (const transform of transforms) {
        if (!isTransform(transform)) throw new TypeError('Each transform must be a function or stateful transform');
        result = applyTransformSync(result, transform);
    }
    return result;
}

function splitPipeArgs<T>(args: T[], isWriter: (value: T) => boolean): { transforms: T[]; writer: T; options: Record<string, unknown> } {
    let options: Record<string, unknown> = {};
    const tail = args[args.length - 1];
    if (tail && typeof tail === 'object' && !isWriter(tail) && !stateful(tail as Transform)) {
        options = args.pop() as Record<string, unknown>;
    }
    const writer = args.pop();
    if (!writer || !isWriter(writer)) throw new TypeError('The "writer" argument must implement the stream writer interface');
    return { transforms: args, writer, options };
}

export async function pipeTo(source: Source, ...args: Array<Transform | PartialWriter | { signal?: AbortSignal; preventClose?: boolean; preventFail?: boolean }>): Promise<number> {
    const { transforms, writer, options } = splitPipeArgs(args, value => typeof Reflect.get(value as object, 'write') === 'function');
    const output = pull(source, ...(transforms as Transform[]), { signal: options.signal as AbortSignal | undefined });
    let written = 0;
    try {
        for await (const batch of output) {
            if (writer.writev) await writer.writev(batch, { signal: options.signal as AbortSignal | undefined });
            else for (const chunk of batch) await writer.write(chunk, { signal: options.signal as AbortSignal | undefined });
            written += batch.reduce((total, chunk) => total + chunk.byteLength, 0);
        }
        if (options.preventClose !== true) await writer.end?.({ signal: options.signal as AbortSignal | undefined });
        return written;
    } catch (error) {
        if (options.preventFail !== true) writer.fail?.(error);
        throw error;
    }
}

export function pipeToSync(source: SyncSource, ...args: Array<SyncTransform | PartialSyncWriter | { preventClose?: boolean; preventFail?: boolean }>): number {
    const { transforms, writer, options } = splitPipeArgs(args, value => typeof Reflect.get(value as object, 'writeSync') === 'function');
    let written = 0;
    try {
        for (const batch of pullSync(source, ...(transforms as SyncTransform[]))) {
            if (writer.writevSync) writer.writevSync(batch);
            else for (const chunk of batch) writer.writeSync(chunk);
            written += batch.reduce((total, chunk) => total + chunk.byteLength, 0);
        }
        if (options.preventClose !== true) writer.endSync?.();
        return written;
    } catch (error) {
        if (options.preventFail !== true) writer.fail?.(error);
        throw error;
    }
}

function limitValue(limit?: number): number {
    if (limit === undefined) return Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('The "limit" option must be a non-negative safe integer');
    return limit;
}

export async function array(source: Source, options: ConsumeOptions = {}): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    const limit = limitValue(options.limit);
    let length = 0;
    for await (const batch of from(source)) {
        throwIfAborted(options.signal);
        for (const chunk of batch) {
            length += chunk.byteLength;
            if (length > limit) throw new RangeError('The stream exceeded the configured limit');
            chunks.push(chunk);
        }
    }
    return chunks;
}

export function arraySync(source: SyncSource, options: ConsumeSyncOptions = {}): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    const limit = limitValue(options.limit);
    let length = 0;
    for (const batch of fromSync(source)) for (const chunk of batch) {
        length += chunk.byteLength;
        if (length > limit) throw new RangeError('The stream exceeded the configured limit');
        chunks.push(chunk);
    }
    return chunks;
}

function concat(chunks: Uint8Array[]): Buffer {
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

function plainBytes(chunks: Uint8Array[]): Uint8Array {
    const buffer = concat(chunks);
    const result = new Uint8Array(buffer.byteLength);
    result.set(buffer);
    return result;
}

export async function bytes(source: Source, options?: ConsumeOptions): Promise<Uint8Array> {
    return plainBytes(await array(source, options));
}

export function bytesSync(source: SyncSource, options?: ConsumeSyncOptions): Uint8Array {
    return plainBytes(arraySync(source, options));
}

export async function text(source: Source, options: TextConsumeOptions = {}): Promise<string> {
    return concat(await array(source, options)).toString(options.encoding as BufferEncoding | undefined);
}

export function textSync(source: SyncSource, options: TextConsumeSyncOptions = {}): string {
    return concat(arraySync(source, options)).toString(options.encoding as BufferEncoding | undefined);
}

export async function arrayBuffer(source: Source, options?: ConsumeOptions): Promise<ArrayBuffer> {
    const value = await bytes(source, options);
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export function arrayBufferSync(source: SyncSource, options?: ConsumeSyncOptions): ArrayBuffer {
    const value = bytesSync(source, options);
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export function tap(callback: StatelessTransformFn): StatelessTransformFn {
    return async (chunks, options) => {
        await callback(chunks, options);
        return chunks;
    };
}

export function tapSync(callback: SyncStatelessTransformFn): SyncStatelessTransformFn {
    return chunks => {
        callback(chunks);
        return chunks;
    };
}

const readableAdapters = new WeakMap<object, ByteReadableStream>();
const writableAdapters = new WeakMap<object, PartialWriter>();

export function fromReadable(readable: NodeJS.ReadableStream): ByteReadableStream {
    if (!readable || (typeof readable !== 'object' && typeof readable !== 'function')) {
        throw new TypeError('The "readable" argument must be a readable stream');
    }
    const key = readable as object;
    const cached = readableAdapters.get(key);
    if (cached) return cached;
    const adapter = from(readable as unknown as AsyncIterable<Source>);
    readableAdapters.set(key, adapter);
    return adapter;
}

export function fromWritable(writable: NodeJS.WritableStream, _options: { backpressure?: string } = {}): PartialWriter {
    if (!writable || typeof writable.write !== 'function') {
        throw new TypeError('The "writable" argument must be a writable stream');
    }
    const key = writable as object;
    const cached = writableAdapters.get(key);
    if (cached) return cached;
    const adapter: PartialWriter = {
        async write(chunk): Promise<void> {
            await new Promise<void>((resolve, reject) => {
                writable.write(chunk, (error?: Error | null) => error ? reject(error) : resolve());
            });
        },
        async writev(chunks): Promise<void> {
            for (const chunk of chunks) await adapter.write(chunk);
        },
        writeSync: () => false,
        writevSync: () => false,
        async end(): Promise<number> {
            await new Promise<void>((resolve, reject) => {
                writable.once?.('error', reject);
                writable.end(resolve);
            });
            return 0;
        },
        endSync: () => -1,
        fail(reason): void {
            (writable as NodeJS.WritableStream & { destroy?: (error?: Error) => void }).destroy?.(
                reason instanceof Error ? reason : new Error(String(reason)),
            );
        },
    };
    writableAdapters.set(key, adapter);
    return adapter;
}

export function toReadable(source: Source, options: { highWaterMark?: number; signal?: AbortSignal } = {}): InstanceType<typeof Readable> {
    async function* chunks(): AsyncGenerator<Uint8Array> {
        for await (const batch of from(source)) {
            throwIfAborted(options.signal);
            yield* batch;
        }
    }
    return Readable.from(chunks(), { objectMode: false, highWaterMark: options.highWaterMark });
}

export function toReadableSync(source: SyncSource, options: { highWaterMark?: number } = {}): InstanceType<typeof Readable> {
    function* chunks(): Generator<Uint8Array> {
        for (const batch of fromSync(source)) yield* batch;
    }
    return Readable.from(chunks(), { objectMode: false, highWaterMark: options.highWaterMark });
}

export function toWritable(writer: PartialWriter): InstanceType<typeof Writable> {
    return new Writable({
        highWaterMark: Number.MAX_SAFE_INTEGER,
        write(chunk, _encoding, callback): void {
            Promise.resolve(writer.write(chunk as Uint8Array)).then(() => callback(), callback);
        },
        final(callback): void {
            Promise.resolve(writer.end?.()).then(() => callback(), callback);
        },
        destroy(error, callback): void {
            if (error) writer.fail?.(error);
            callback(error);
        },
    });
}

export function ondrain(value: unknown): Promise<boolean> | null {
    const fn = value && Reflect.get(value, drainableProtocol);
    return typeof fn === 'function' ? Reflect.apply(fn, value, []) : null;
}

export function push(..._args: unknown[]): never { return unsupported('push'); }
export function merge(..._args: unknown[]): never { return unsupported('merge'); }
export function broadcast(..._args: unknown[]): never { return unsupported('broadcast'); }
export function share(..._args: unknown[]): never { return unsupported('share'); }
export function shareSync(..._args: unknown[]): never { return unsupported('shareSync'); }
export function duplex(..._args: unknown[]): never { return unsupported('duplex'); }
