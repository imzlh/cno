import { arrayBufferBackedBytes, sanitizeSurrogates } from '../utils/bytes';
import { basename, dirname, join, toFsPath } from '../utils/path';
import { ensureDirectory } from '../utils/fs-path';
import { filePathSink, type FileSink as BunFileSink } from './file-sink';
import { stdioDestination, type StdioFile } from './stdio';
import { stat as nodeStat, unlink as nodeUnlink } from '../node/fs/_promises';
import type { Stats } from '../node/fs/utils';

const fs = import.meta.use('fs');
const asyncfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');
const os = import.meta.use('os');
const algorithm = import.meta.use('algorithm');

const BUN_FILE_CHUNK_SIZE = 64 * 1024;
const MISSING_LAST_MODIFIED = 2 ** 52 - 1;
const filePaths = new WeakMap<BunFile, string>();
// Use the host's global Blob and its registered byte protocol. Importing
// webapi/formdata would bundle a second Blob into the payload, and that module
// overwrites globalThis.Blob/File/FormData when evaluated.
const blobBytesSymbol = Symbol.for('cno.blob.bytes');

// The shared Node Stats class also supports bigint stats; Bun.file.stat does not.
type BunFileStats = { [K in keyof Stats]: Stats[K] extends number | bigint ? number : Stats[K] };

export type BunFileWriteOptions = NonNullable<Parameters<typeof import('bun').write>[2]>;

export interface BunFileLike extends Blob {
    readonly name?: string;
    readonly lastModified: number;
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    json<T = unknown>(): Promise<T>;
    slice(begin?: number, end?: number, contentType?: string): BunFileLike;
    slice(begin?: number, contentType?: string): BunFileLike;
    slice(contentType?: string): BunFileLike;
    exists(): Promise<boolean>;
    stat(): Promise<BunFileStats>;
    unlink(): Promise<void>;
    delete(): Promise<void>;
    write(data: BunFileWriteInput, options?: { highWaterMark?: number }): Promise<number>;
    /** Incremental sink that truncates the file on first flush (BunFile.writer). */
    writer(options?: { highWaterMark?: number }): BunFileSink;
}

export type BunFileWriteInput = BunWriteInput | Request | ReadableStream;

export type BunWriteInput =
    | string
    | ArrayBufferView
    | ArrayBufferLike
    | Blob
    | Response
    | ReadableStream
    | BunFileLike;

interface FileRange {
    start: number;
    end: number;
}

interface FileSlice {
    begin: number;
    end?: number;
}

interface FileOptions {
    type?: string;
    inferType?: boolean;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true;
    return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
}

function isResponse(value: unknown): value is Response {
    return typeof Response !== 'undefined' && value instanceof Response;
}

function isReadableStream(value: unknown): value is ReadableStream {
    return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

function pathFromValue(value: unknown): string {
    if (typeof value === 'string') {
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^file:\/\//i.test(value)) {
            throw new TypeError('Bun.file only supports local filesystem paths and file URLs');
        }
        // Bun treats string inputs literally. Only actual URL objects are
        // decoded into filesystem paths.
        return value;
    }
    if (typeof URL !== 'undefined' && value instanceof URL) return toFsPath(value);
    throw new TypeError('Bun.file path must be a string or a local file URL');
}

function parseFileOptions(value: unknown): FileOptions {
    if (value === undefined) return {};
    if (!isObject(value) || Array.isArray(value)) {
        throw new TypeError('Bun.file options must be an object');
    }
    for (const key of Reflect.ownKeys(value)) {
        if (key !== 'type') {
            throw new TypeError(`Bun.file: unsupported option "${String(key)}"`);
        }
    }
    if (value.type !== undefined && typeof value.type !== 'string') {
        throw new TypeError('Bun.file: type must be a string');
    }
    return { type: value.type as string | undefined };
}

function normalizeContentType(value: string | undefined, path: string, inferType = true): string {
    const type = value === undefined || value === ''
        ? (inferType ? guessedContentType(path) : '')
        : value.toLowerCase();
    if (!/^[\x20-\x7e]*$/.test(type)) return '';
    if (!type.includes(';') && BUN_UTF8_TYPES.has(type)) {
        return `${type};charset=utf-8`;
    }
    return type;
}

const BUN_UTF8_TYPES = new Set([
    'application/json',
    'text/css',
    'text/html',
    'text/javascript',
    'text/plain',
]);

function guessedContentType(path: string): string {
    const name = basename(path).toLowerCase();
    const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.') + 1) : '';
    const types: Record<string, string> = {
        css: 'text/css;charset=utf-8',
        csv: 'text/csv;charset=utf-8',
        htm: 'text/html;charset=utf-8',
        html: 'text/html;charset=utf-8',
        js: 'text/javascript;charset=utf-8',
        json: 'application/json;charset=utf-8',
        mjs: 'text/javascript;charset=utf-8',
        svg: 'image/svg+xml',
        txt: 'text/plain;charset=utf-8',
        ts: 'text/typescript;charset=utf-8',
        xml: 'application/xml;charset=utf-8',
        wasm: 'application/wasm',
        webmanifest: 'application/manifest+json;charset=utf-8',
        zip: 'application/zip',
        gz: 'application/gzip',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        avif: 'image/avif',
        pdf: 'application/pdf',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
        webm: 'video/webm',
    };
    return types[ext] ?? 'application/octet-stream';
}

function toInteger(value: unknown): number {
    const number = Number(value);
    if (Number.isNaN(number) || number === 0) return 0;
    // Blob.slice arguments are [Clamp]: infinities saturate instead of becoming 0.
    return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number)));
}

function relativeIndex(value: number, length: number): number {
    return value < 0 ? Math.max(length + value, 0) : Math.min(value, length);
}

function normalizeRange(start: number | undefined, end: number | undefined, length: number): FileRange {
    const begin = relativeIndex(start ?? 0, length);
    const finish = end === undefined ? length : relativeIndex(end, length);
    return { start: begin, end: Math.max(begin, finish) };
}

function closeQuietly(handle: CModuleAsyncFS.FileHandle | undefined): Promise<void> {
    if (!handle) return Promise.resolve();
    return handle.close().catch(() => {});
}

function concatenate(chunks: Uint8Array<ArrayBuffer>[], length: number): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function toArrayBufferBytes(value: ArrayBufferView | ArrayBufferLike): Uint8Array<ArrayBuffer> {
    const copy = (bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> => {
        const output = new Uint8Array(new ArrayBuffer(bytes.byteLength));
        output.set(bytes);
        return output;
    };

    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView & {
            buffer: ArrayBufferLike;
            byteOffset: number;
            byteLength: number;
        };
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        return copy(bytes);
    }
    const bytes = new Uint8Array(value);
    return copy(bytes);
}

function bytePathError(message: string, code: 'ERR_INVALID_ARG_TYPE' | 'ERR_INVALID_ARG_VALUE'): TypeError {
    return Object.assign(new TypeError(message), { code });
}

function validateWriteOptions(value: unknown): BunFileWriteOptions {
    if (value === undefined) return {};
    if (!isObject(value) || Array.isArray(value)) {
        throw new TypeError('Bun.write options must be an object');
    }
    for (const key of Reflect.ownKeys(value)) {
        if (key !== 'mode' && key !== 'createPath') {
            throw new TypeError(`Bun.write: unsupported option "${String(key)}"`);
        }
    }
    if (value.createPath !== undefined && typeof value.createPath !== 'boolean') {
        throw new TypeError('Bun.write: createPath must be a boolean');
    }
    if (value.mode !== undefined && (
        typeof value.mode !== 'number' ||
        !Number.isSafeInteger(value.mode) ||
        value.mode < 0 ||
        value.mode > 0o777
    )) {
        throw new RangeError('Bun.write: mode must be an integer from 0 through 0o777');
    }
    return {
        mode: value.mode as number | undefined,
        createPath: value.createPath as boolean | undefined,
    };
}

/** A lazy, path-backed Blob. Reads own and close their descriptor. */
export class BunFile extends Blob implements BunFileLike {
    #path: string;
    #contentType: string;
    #slices: readonly FileSlice[];

    constructor(path: string, options: FileOptions = {}, slices: readonly FileSlice[] = []) {
        super([]);
        this.#path = path;
        this.#contentType = normalizeContentType(options.type, path, options.inferType ?? true);
        this.#slices = slices;
        filePaths.set(this, path);
    }

    get name(): string {
        return this.#path;
    }

    get type(): string {
        return this.#contentType;
    }

    get size(): number {
        try {
            const range = this.#resolveRange(fs.stat(this.#path).size);
            return range.end - range.start;
        } catch {
            return 0;
        }
    }

    get lastModified(): number {
        try {
            return fs.stat(this.#path).mtim?.getTime() ?? MISSING_LAST_MODIFIED;
        } catch {
            return MISSING_LAST_MODIFIED;
        }
    }

    /**
     * Incremental writer for this path. The sink opens (and truncates) the
     * file on its first flush and owns the descriptor until end().
     */
    writer(options?: { highWaterMark?: number }): BunFileSink {
        const sink = filePathSink(this.#path);
        sink.start(options);
        return sink;
    }

    #resolveRange(size: number): FileRange {
        let range = { start: 0, end: size };
        for (const slice of this.#slices) {
            const next = normalizeRange(slice.begin, slice.end, range.end - range.start);
            range = { start: range.start + next.start, end: range.start + next.end };
        }
        return range;
    }

    #needsSize(): boolean {
        return this.#slices.some(slice => slice.begin < 0 || (slice.end !== undefined && slice.end < 0));
    }

    // Cloning and object URLs need a synchronous snapshot, not an empty base Blob.
    // Construction stays lazy; only this explicit protocol hook performs sync I/O.
    [blobBytesSymbol](): Uint8Array<ArrayBuffer> {
        const fd = fs.open(this.#path, 'r');
        try {
            const stat = fs.fstat(fd);
            // procfs and FIFOs can report zero bytes while reads produce data.
            const unknownSize = stat.size === 0;
            const applySlices = unknownSize && this.#needsSize();
            const range = applySlices
                ? { start: 0, end: Infinity }
                : this.#resolveRange(unknownSize ? Infinity : stat.size);
            const seekable = stat.isFile && !unknownSize;
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            let position = seekable ? range.start : 0;
            let length = 0;
            while (position < range.end) {
                const buffer = new Uint8Array(Math.min(BUN_FILE_CHUNK_SIZE, range.end - position));
                const count = seekable ? fs.pread(fd, buffer, position) : fs.read(fd, buffer);
                if (count <= 0) break;
                const skip = Math.min(count, Math.max(0, range.start - position));
                position += count;
                if (skip < count) {
                    const chunk = buffer.slice(skip, count);
                    chunks.push(chunk);
                    length += chunk.byteLength;
                }
            }
            const bytes = concatenate(chunks, length);
            if (!applySlices) return bytes;
            const bounds = this.#resolveRange(bytes.byteLength);
            return bytes.slice(bounds.start, bounds.end);
        } finally {
            fs.close(fd);
        }
    }

    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
        const reader = this.stream().getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let length = 0;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                chunks.push(chunk.value);
                length += chunk.value.byteLength;
            }
            return concatenate(chunks, length);
        } catch (error) {
            await reader.cancel(error).catch(() => {});
            throw error;
        } finally {
            reader.releaseLock();
        }
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        return (await this.bytes()).buffer;
    }

    async text(): Promise<string> {
        const bytes = await this.bytes();
        const decoder = import.meta.use('text').Decoder;
        return new decoder().decode(bytes);
    }

    async json<T = unknown>(): Promise<T> {
        return JSON.parse(await this.text()) as T;
    }

    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        let handle: CModuleAsyncFS.FileHandle | undefined;
        let active: Promise<void> | undefined;
        let cancelled = false;
        let position = 0;
        let range: FileRange | undefined;
        let seekable = false;
        let buffered: Uint8Array<ArrayBuffer> | undefined;

        const close = async (): Promise<void> => {
            const opened = handle;
            handle = undefined;
            await closeQuietly(opened);
        };

        const open = async (): Promise<CModuleAsyncFS.FileHandle> => {
            if (handle) return handle;
            handle = await asyncfs.open(this.#path, 'r');
            const stat = await handle.stat();
            const unknownSize = stat.size === 0;
            seekable = stat.isFile && !unknownSize;
            if (unknownSize && this.#needsSize()) {
                // Negative bounds need the actual length, not a zero stat size.
                const chunks: Uint8Array<ArrayBuffer>[] = [];
                let length = 0;
                while (!cancelled) {
                    const chunk = new Uint8Array(BUN_FILE_CHUNK_SIZE);
                    const count = await handle.read(chunk);
                    if (count <= 0) break;
                    chunks.push(chunk.slice(0, count));
                    length += count;
                }
                const bytes = concatenate(chunks, length);
                const bounds = this.#resolveRange(length);
                buffered = bytes.slice(bounds.start, bounds.end);
                range = { start: 0, end: buffered.byteLength };
            } else {
                range = this.#resolveRange(unknownSize ? Infinity : stat.size);
            }
            position = seekable ? range.start : 0;
            return handle;
        };

        return new ReadableStream<Uint8Array<ArrayBuffer>>({
            pull(controller) {
                active = (async () => {
                    try {
                        const current = await open();
                        const bounds = range!;
                        while (!cancelled && position < bounds.end) {
                            const buffer = new Uint8Array(Math.min(BUN_FILE_CHUNK_SIZE, bounds.end - position));
                            const count = buffered
                                ? Math.min(buffer.byteLength, buffered.byteLength - position)
                                : await current.read(buffer, seekable ? position : undefined);
                            if (count <= 0) break;
                            const skip = Math.min(count, Math.max(0, bounds.start - position));
                            const chunk = buffered
                                ? buffered.slice(position + skip, position + count)
                                : buffer.slice(skip, count);
                            position += count;
                            if (cancelled) break;
                            if (chunk.byteLength > 0) {
                                controller.enqueue(chunk);
                                return;
                            }
                        }
                        await close();
                        if (!cancelled) controller.close();
                    } catch (error) {
                        await close();
                        if (!cancelled) controller.error(error);
                    }
                })();
                return active;
            },
            async cancel() {
                cancelled = true;
                await active;
                await close();
            },
        });
    }

    async exists(): Promise<boolean> {
        try {
            const stat = await asyncfs.stat(this.#path);
            return stat.isFile || stat.isFIFO;
        } catch {
            return false;
        }
    }

    stat(): Promise<BunFileStats> {
        return nodeStat(this.#path) as Promise<BunFileStats>;
    }

    unlink(): Promise<void> {
        return nodeUnlink(this.#path);
    }

    delete(): Promise<void> {
        return this.unlink();
    }

    slice(begin?: number, end?: number, contentType?: string): BunFile;
    slice(begin?: number, contentType?: string): BunFile;
    slice(contentType?: string): BunFile;
    slice(beginOrType?: number | string, endOrType?: number | string, type?: string): BunFile {
        let begin: number | undefined;
        let end: number | undefined;
        let contentType: string | undefined = type;
        if (typeof beginOrType === 'string') {
            contentType = beginOrType;
        } else {
            begin = beginOrType;
            if (typeof endOrType === 'string') contentType = endOrType;
            else end = endOrType;
        }

        if (contentType !== undefined && typeof contentType !== 'string') {
            throw new TypeError('Bun.file slice content type must be a string');
        }
        return new BunFile(
            this.#path,
            { type: contentType === undefined ? this.type : contentType, inferType: false },
            [...this.#slices, { begin: toInteger(begin ?? 0), end: end === undefined ? undefined : toInteger(end) }],
        );
    }

    async write(data: BunFileWriteInput, options?: { highWaterMark?: number }): Promise<number> {
        if (options != null && !isObject(options)) {
            throw new TypeError('Bun.file.write: options must be an object');
        }
        // Bun accepts but ignores unrecognized options on this method.
        if (typeof Request !== 'undefined' && data instanceof Request) {
            if (data.bodyUsed || data.body?.locked) throw new TypeError('Bun.file.write: Request body is already used or locked');
            return data.body ? writeStream(this.#path, data.body, {}) : write(this, '');
        }
        if (isReadableStream(data)) return writeStream(this.#path, data, {});
        if (data == null) throw new TypeError('Bun.file.write: missing input');
        if (typeof data !== 'string' && !ArrayBuffer.isView(data) && !isArrayBufferLike(data)
            && !(data instanceof Blob) && !isResponse(data)) {
            return write(this, String(data));
        }
        return write(this, data as BunWriteInput);
    }
}

function destinationPath(value: unknown): string {
    if (value instanceof BunFile) return filePaths.get(value)!;
    return pathFromValue(value);
}

async function inputBytes(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
    if (typeof value === 'string') {
        return arrayBufferBackedBytes(engine.encodeString(sanitizeSurrogates(value)));
    }
    if (ArrayBuffer.isView(value)) return toArrayBufferBytes(value);
    if (isArrayBufferLike(value)) return toArrayBufferBytes(value);
    if (isReadableStream(value)) {
        throw new TypeError('Bun.write: ReadableStream input is not supported by this runtime');
    }
    throw new TypeError('Bun.write: unsupported input type');
}

async function writeBytes(handle: CModuleAsyncFS.FileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<number> {
    let written = 0;
    while (written < bytes.byteLength) {
        const chunk = bytes.subarray(written, written + BUN_FILE_CHUNK_SIZE);
        const count = await handle.write(chunk);
        if (count <= 0) throw new Error('Bun.write: filesystem write made no progress');
        written += count;
    }
    return written;
}

async function writeStream(
    path: string,
    stream: ReadableStream,
    options: BunFileWriteOptions,
): Promise<number> {
    const reader = stream.getReader();
    let stage: CModuleAsyncFS.FileHandle | undefined;
    try {
        if (options.createPath !== false) await ensureDirectory(dirname(path));
        // A Response/Blob can indirectly read the destination. Stage to disk
        // before truncation, keeping memory bounded even for same-file copies.
        stage = await asyncfs.mkstemp(join(os.tmpDir, `cno-bun-write-${os.pid}-XXXXXX`));
        let written = 0;
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            const bytes = await inputBytes(next.value);
            written += await writeBytes(stage, bytes);
        }

        const destination = await asyncfs.open(path, 'w', options.mode);
        try {
            let position = 0;
            while (position < written) {
                const buffer = new Uint8Array(Math.min(BUN_FILE_CHUNK_SIZE, written - position));
                const count = await stage.read(buffer, position);
                if (count <= 0) throw new Error('Bun.write: staged input ended unexpectedly');
                await writeBytes(destination, buffer.subarray(0, count));
                position += count;
            }
        } finally {
            await destination.close();
        }
        return written;
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
        if (stage) {
            const stagePath = stage.path;
            await closeQuietly(stage);
            await asyncfs.unlink(stagePath).catch(() => {});
        }
    }
}

export async function write(
    destination: string | URL | BunFile | StdioFile,
    input: BunWriteInput,
    options?: BunFileWriteOptions,
): Promise<number> {
    const stdio = stdioDestination(destination);
    if (stdio) {
        // mode/createPath are file-path concepts; Bun ignores them for pipes.
        if (isResponse(input) || isReadableStream(input)) {
            throw new TypeError('Bun.write: Response and ReadableStream input is not supported for stdio files');
        }
        return stdio.write(input as string | ArrayBufferView | ArrayBufferLike | Blob);
    }
    const path = destinationPath(destination);
    const parsed = validateWriteOptions(options);
    if (isResponse(input)) {
        if (input.bodyUsed || input.body?.locked) throw new TypeError('Bun.write: Response body is already used or locked');
        if (input.body) return writeStream(path, input.body, parsed);
    } else if (input instanceof Blob) {
        return writeStream(path, input.stream(), parsed);
    } else if (isReadableStream(input)) {
        return writeStream(path, input, parsed);
    }
    const bytes = isResponse(input) ? new Uint8Array(0) : await inputBytes(input);

    if (parsed.createPath !== false) await ensureDirectory(dirname(path));
    const handle = await asyncfs.open(path, 'w', parsed.mode);
    try {
        return await writeBytes(handle, bytes);
    } finally {
        await handle.close();
    }
}

export function file(
    path: string | URL | ArrayBufferLike | Uint8Array<ArrayBufferLike> | DataView<ArrayBufferLike>,
    options?: BlobPropertyBag,
): BunFile {
    const parsed = parseFileOptions(options);
    if (path instanceof Uint8Array || path instanceof DataView || isArrayBufferLike(path)) {
        const bytes = toArrayBufferBytes(path);
        if (bytes.byteLength === 0) {
            throw bytePathError("Invalid path buffer: can't be empty", 'ERR_INVALID_ARG_TYPE');
        }
        if (bytes.includes(0)) {
            throw bytePathError(
                "The argument 'path' must be a string, Uint8Array, or URL without null bytes.",
                'ERR_INVALID_ARG_VALUE',
            );
        }
        // Host filesystem paths are strings, so arbitrary non-UTF-8 names cannot round-trip.
        // Native validation keeps the fatal-decode semantics without TextDecoder.
        if (!algorithm.bytesIsUtf8(bytes)) {
            throw bytePathError(
                'Bun.file byte paths must contain valid UTF-8 in this runtime.',
                'ERR_INVALID_ARG_VALUE',
            );
        }
        return new BunFile(engine.decodeString(bytes), parsed);
    }
    return new BunFile(pathFromValue(path), parsed);
}
