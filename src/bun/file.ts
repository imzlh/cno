import { arrayBufferBackedBytes, sanitizeSurrogates } from '../utils/bytes';
import { basename, dirname, join, toFsPath } from '../utils/path';
import { ensureDirectory } from '../utils/fs-path';
import { isBunBytePath } from './file-path';
import { fileDescriptorSink, filePathSink, type FileSink as BunFileSink } from './file-sink';
import { openReadableFile } from './opened-file';
import { stdioDestination, type StdioFile } from './stdio';
import { stat as nodeStat, unlink as nodeUnlink } from '../node/fs/_promises';
import { toNodeStat, validateFd, type Stats } from '../node/fs/utils';
import { wrapSync as wrapSyncFs } from '../node/fs/errno-fix';

const fs = import.meta.use('fs');
const asyncfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');
const os = import.meta.use('os');
const algorithm = import.meta.use('algorithm');

const BUN_FILE_CHUNK_SIZE = 64 * 1024;
const MISSING_LAST_MODIFIED = 2 ** 52 - 1;
type FileBacking =
    | { readonly kind: 'path'; readonly path: string }
    | { readonly kind: 'fd'; readonly fd: number };
const fileBackings = new WeakMap<BunFile, FileBacking>();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const arrayBufferIsView = ArrayBuffer.isView;
const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
const fileName = typeof File === 'function'
    ? Object.getOwnPropertyDescriptor(File.prototype, 'name')?.get
    : undefined;
const fileLastModified = typeof File === 'function'
    ? Object.getOwnPropertyDescriptor(File.prototype, 'lastModified')?.get
    : undefined;
const blobSlice = Blob.prototype.slice;
const blobStream = Blob.prototype.stream;
// Use the host's global Blob and its registered byte protocol. Importing
// webapi/formdata would bundle a second Blob into the payload, and that module
// overwrites globalThis.Blob/File/FormData when evaluated.
const blobBytesSymbol = Symbol.for('cno.blob.bytes');
const bunFileBodyStreamSymbol = Symbol('cno.bun-file.body-stream');
// Serve-route recognition protocol (serve-routes.ts): lets Bun.serve treat a
// BunFile as a static file target without importing this module there.
const bunFileServeSymbol = Symbol.for('cno.bun-file.serve-target');
const blobNames = new WeakMap<object, string>();

// The shared Node Stats class also supports bigint stats; Bun.file.stat does not.
type BunFileStats = { [K in keyof Stats]: Stats[K] extends number | bigint ? number : Stats[K] };

export type BunFileWriteOptions = NonNullable<Parameters<typeof import('bun').write>[2]>;

export interface BunFileLike extends Blob {
    readonly name?: string;
    readonly lastModified: number;
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    formData(): Promise<FormData>;
    json<T = unknown>(): Promise<T>;
    slice(begin?: number, end?: number, contentType?: string): BunFileLike;
    slice(begin?: number, contentType?: string): BunFileLike;
    slice(contentType?: string): BunFileLike;
    exists(): Promise<boolean>;
    stat(): Promise<BunFileStats>;
    unlink(): Promise<void>;
    delete(): Promise<void>;
    write(data: BunFileWriteInput, options?: { highWaterMark?: number }): Promise<number>;
    /** Incremental sink that opens immediately and overwrites from byte zero. */
    writer(options?: { highWaterMark?: number }): BunFileSink;
}

export type BunFileWriteInput = BunWriteInput | Request | ReadableStream;

export type BunWriteInput =
    | string
    | ArrayBufferView
    | ArrayBufferLike
    | Blob
    | Response
    | Request
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

/** Internal, realm-stable BunFile brand check for other Bun polyfills. */
export function isBunFile(value: unknown): value is BunFile {
    return isObject(value) && fileBackings.has(value as BunFile);
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
    return isBunBytePath(value) && !arrayBufferIsView(value);
}

function isResponse(value: unknown): value is Response {
    return typeof Response !== 'undefined' && value instanceof Response;
}

function isRequest(value: unknown): value is Request {
    return typeof Request !== 'undefined' && value instanceof Request;
}

function isReadableStream(value: unknown): value is ReadableStream {
    return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

function assertBlobReceiver(value: unknown): asserts value is Blob {
    Reflect.apply(blobSize, value, []);
}

function isBlob(value: unknown): value is Blob {
    try {
        assertBlobReceiver(value);
        return true;
    } catch {
        return false;
    }
}

function blobInputStream(value: Blob): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (isBunFile(value)) {
        return Reflect.apply(BunFile.prototype[bunFileBodyStreamSymbol], value, []);
    }
    return Reflect.apply(blobStream, value, []);
}

function borrowedBodyStream(fd: number): ReadableStream<Uint8Array<ArrayBuffer>> {
    let cancelled = false;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
            if (cancelled) return;
            try {
                const buffer = new Uint8Array(BUN_FILE_CHUNK_SIZE);
                const count = wrapSyncFs(() => fs.read(fd, buffer), 'read', `fd:${fd}`);
                if (count <= 0) controller.close();
                else controller.enqueue(buffer.slice(0, count));
            } catch (error) {
                controller.error(error);
            }
        },
        cancel() {
            cancelled = true;
        },
    });
}

function stringifyWriteInput(value: unknown): string {
    try {
        return String(value);
    } catch (error) {
        // The runtime Blob polyfill's toString has a private-slot check, while
        // Bun stringifies forged/proxied Blob-tagged objects generically.
        if (isObject(value) && Object.prototype.toString.call(value) === '[object Blob]') return '[object Blob]';
        throw error;
    }
}

function pathFromValue(value: unknown): string {
    if (typeof value === 'string') {
        if (value.includes('\0')) {
            throw bytePathError(
                "The argument 'path' must be a string, Uint8Array, or URL without null bytes.",
                'ERR_INVALID_ARG_VALUE',
            );
        }
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^file:\/\//i.test(value)) {
            throw new TypeError('Bun.file only supports local filesystem paths and file URLs');
        }
        // Bun treats string inputs literally. Only actual URL objects are
        // decoded into filesystem paths.
        return value;
    }
    if (typeof URL !== 'undefined' && value instanceof URL) return pathFromValue(toFsPath(value));
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
        ? (inferType ? guessedContentType(path) : (path === '' ? 'application/octet-stream' : ''))
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

    if (arrayBufferIsView(value)) {
        let buffer: ArrayBufferLike;
        let byteOffset: number;
        let byteLength: number;
        try {
            buffer = Reflect.apply(typedArrayBuffer, value, []);
        } catch {
            buffer = Reflect.apply(dataViewBuffer, value, []);
            try {
                byteOffset = Reflect.apply(dataViewByteOffset, value, []);
                byteLength = Reflect.apply(dataViewByteLength, value, []);
            } catch {
                // Bun treats detached and out-of-bounds DataViews as empty inputs.
                return new Uint8Array(0);
            }
            if (byteLength === 0) return new Uint8Array(0);
            return copy(new Uint8Array(buffer, byteOffset, byteLength));
        }
        byteOffset = Reflect.apply(typedArrayByteOffset, value, []);
        byteLength = Reflect.apply(typedArrayByteLength, value, []);
        if (byteLength === 0) return new Uint8Array(0);
        const bytes = new Uint8Array(buffer, byteOffset, byteLength);
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

/** A lazy filesystem Blob. Path descriptors are owned; fd backings are borrowed. */
export class BunFile extends Blob implements BunFileLike {
    #backing: FileBacking;
    #contentType: string;
    #slices: readonly FileSlice[];

    constructor(backing: FileBacking, options: FileOptions = {}, slices: readonly FileSlice[] = []) {
        super([]);
        this.#backing = backing;
        this.#contentType = normalizeContentType(
            options.type,
            backing.kind === 'path' ? backing.path : '',
            backing.kind === 'path' && (options.inferType ?? true),
        );
        this.#slices = slices;
        fileBackings.set(this, backing);
    }

    get name(): string | undefined {
        if (blobNames.has(this)) return blobNames.get(this)!;
        const backing = fileBackings.get(this);
        if (backing?.kind === 'path') return backing.path;
        if (backing?.kind === 'fd') return undefined;
        assertBlobReceiver(this);
        return fileName && this instanceof File
            ? Reflect.apply(fileName, this, []) as string
            : undefined;
    }

    set name(value: string) {
        assertBlobReceiver(this);
        blobNames.set(this, String(value));
    }

    get type(): string {
        return this.#contentType;
    }

    get size(): number {
        try {
            const stat = this.#statSync();
            if (this.#backing.kind === 'fd' && !stat.isFile && !this.#hasSlices()) return Infinity;
            const range = this.#resolveRange(stat.size);
            return range.end - range.start;
        } catch {
            return 0;
        }
    }

    get lastModified(): number {
        const backing = fileBackings.get(this);
        if (backing === undefined) {
            assertBlobReceiver(this);
            return fileLastModified && this instanceof File
                ? Reflect.apply(fileLastModified, this, []) as number
                : MISSING_LAST_MODIFIED;
        }
        try {
            return this.#statSync().mtim?.getTime() ?? MISSING_LAST_MODIFIED;
        } catch {
            return MISSING_LAST_MODIFIED;
        }
    }

    /**
     * Incremental writer for this path. The sink opens immediately, overwrites
     * from byte zero without truncating a longer file, and owns the descriptor.
     */
    writer(options?: { highWaterMark?: number }): BunFileSink {
        if (options !== undefined && options !== null && !isObject(options)) {
            throw new TypeError('options must be an object or undefined');
        }
        const sink = this.#backing.kind === 'path'
            ? filePathSink(this.#backing.path)
            : fileDescriptorSink(this.#backing.fd);
        sink.start(options);
        return sink;
    }

    #statSync(): CModuleFS.Stats {
        return this.#backing.kind === 'path'
            ? fs.stat(this.#backing.path)
            : fs.fstat(this.#backing.fd);
    }

    #hasSlices(): boolean {
        return this.#slices.length > 0;
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
        if (this.#backing.kind === 'fd') {
            return this.#readBorrowedSync();
        }
        const fd = fs.open(this.#backing.path, 'r');
        try {
            const stat = fs.fstat(fd);
            let positional = stat.isFile && Number.isSafeInteger(stat.size) && stat.size >= 0;
            let sizeKnown = false;
            if (positional) {
                const byte = new Uint8Array(1);
                try {
                    sizeKnown = stat.size === 0
                        ? fs.pread(fd, byte, 0) === 0
                        : fs.pread(fd, byte, stat.size - 1) === 1 && fs.pread(fd, byte, stat.size) === 0;
                } catch {
                    positional = false;
                }
            }

            let actualSize: number | undefined;
            if (!sizeKnown && positional && this.#needsSize()) {
                const buffer = new Uint8Array(BUN_FILE_CHUNK_SIZE);
                actualSize = 0;
                while (true) {
                    const count = fs.pread(fd, buffer, actualSize);
                    if (count <= 0) break;
                    actualSize += count;
                    if (!Number.isSafeInteger(actualSize)) {
                        throw new RangeError('Bun.file source is too large to address safely');
                    }
                }
            } else if (!sizeKnown && !positional && this.#needsSize()) {
                throw new TypeError('Cannot resolve a negative Bun.file slice on a non-seekable source');
            }

            const range = this.#resolveRange(sizeKnown ? stat.size : actualSize ?? Infinity);
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            let position = positional ? range.start : 0;
            let length = 0;
            while (position < range.end) {
                const buffer = new Uint8Array(Math.min(BUN_FILE_CHUNK_SIZE, range.end - position));
                const count = positional ? fs.pread(fd, buffer, position) : fs.read(fd, buffer);
                if (count <= 0) break;
                const skip = Math.min(count, Math.max(0, range.start - position));
                position += count;
                if (skip < count) {
                    const chunk = buffer.slice(skip, count);
                    chunks.push(chunk);
                    length += chunk.byteLength;
                }
            }
            return concatenate(chunks, length);
        } finally {
            fs.close(fd);
        }
    }

    [bunFileBodyStreamSymbol](): ReadableStream<Uint8Array<ArrayBuffer>> {
        if (this.#backing.kind === 'path') return this.stream();
        if (this.#hasSlices()) {
            throw new TypeError(
                'Reading a sliced Bun.file(fd) as a body is unsupported because this runtime cannot seek a borrowed descriptor',
            );
        }
        return borrowedBodyStream(this.#backing.fd);
    }

    #readBorrowedSync(): Uint8Array<ArrayBuffer> {
        if (this.#hasSlices()) {
            throw new TypeError(
                'Reading a sliced Bun.file(fd) as a body is unsupported because this runtime cannot seek a borrowed descriptor',
            );
        }
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let length = 0;
        while (true) {
            const buffer = new Uint8Array(BUN_FILE_CHUNK_SIZE);
            const count = wrapSyncFs(
                () => fs.read(this.#backing.fd, buffer),
                'read',
                `fd:${this.#backing.fd}`,
            );
            if (count <= 0) break;
            const chunk = buffer.slice(0, count);
            chunks.push(chunk);
            length += count;
        }
        return concatenate(chunks, length);
    }

    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
        if (this.#backing.kind === 'fd') return this.#readBorrowedSync();
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

    formData(): Promise<FormData> {
        // Response owns the runtime's MIME dispatch and multipart parser. A new
        // wrapper per call keeps path-backed files repeatable, unlike Body mixins.
        return new Response(this).formData();
    }

    async json<T = unknown>(): Promise<T> {
        return JSON.parse(await this.text()) as T;
    }

    stream(_chunkSize?: number): ReadableStream<Uint8Array<ArrayBuffer>> {
        const backing = fileBackings.get(this);
        if (!backing) {
            return Reflect.apply(blobStream, this, arguments) as ReadableStream<Uint8Array<ArrayBuffer>>;
        }
        if (backing.kind === 'fd') return this.#borrowedStream();
        const source = this;
        let opened: Awaited<ReturnType<typeof openReadableFile>> | undefined;
        let active: Promise<void> | undefined;
        let cancelled = false;
        let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;

        const close = async (): Promise<void> => {
            await opened?.close();
        };

        return new ReadableStream<Uint8Array<ArrayBuffer>>({
            pull(controller) {
                active = (async () => {
                    try {
                        if (!reader) {
                            opened = await openReadableFile(backing.path);
                            const size = opened.sizeKnown
                                ? opened.stat.size
                                : source.#needsSize() ? await opened.measure(() => cancelled) : Infinity;
                            const range = source.#resolveRange(size);
                            reader = opened.stream(range.start, range.end).getReader();
                        }
                        const next = await reader.read();
                        if (cancelled) return;
                        if (next.done) controller.close();
                        else controller.enqueue(next.value);
                    } catch (error) {
                        await close();
                        if (!cancelled) controller.error(error);
                    }
                })();
                return active;
            },
            async cancel() {
                cancelled = true;
                await reader?.cancel().catch(() => {});
                await active;
                await close();
            },
        });
    }

    #borrowedStream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        const fd = this.#backing.kind === 'fd' ? this.#backing.fd : -1;
        let range: FileRange | undefined;
        let position = 0;
        let cancelled = false;
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
            pull: controller => {
                if (cancelled) return;
                try {
                    if (!range) {
                        const stat = wrapSyncFs(() => fs.fstat(fd), 'fstat', `fd:${fd}`);
                        range = this.#resolveRange(stat.size);
                        position = range.start;
                    }
                    if (position >= range.end) {
                        controller.close();
                        return;
                    }
                    const buffer = new Uint8Array(Math.min(BUN_FILE_CHUNK_SIZE, range.end - position));
                    const count = wrapSyncFs(() => fs.pread(fd, buffer, position), 'read', `fd:${fd}`);
                    if (count <= 0) {
                        controller.close();
                        return;
                    }
                    position += count;
                    controller.enqueue(buffer.slice(0, count));
                } catch (error) {
                    controller.error(error);
                }
            },
            cancel() {
                cancelled = true;
            },
        });
    }

    exists(): Promise<boolean> {
        const backing = fileBackings.get(this);
        if (backing === undefined) {
            assertBlobReceiver(this);
            return Promise.resolve(true);
        }
        if (backing.kind === 'fd') {
            try {
                const stat = fs.fstat(backing.fd);
                return Promise.resolve(stat.isFile || stat.isFIFO);
            } catch {
                return Promise.resolve(false);
            }
        }
        return asyncfs.stat(backing.path).then(
            stat => stat.isFile || stat.isFIFO,
            () => false,
        );
    }

    stat(): Promise<BunFileStats> {
        if (this.#backing.kind === 'path') return nodeStat(this.#backing.path) as Promise<BunFileStats>;
        try {
            const fd = this.#backing.fd;
            return Promise.resolve(toNodeStat(wrapSyncFs(() => fs.fstat(fd), 'fstat', `fd:${fd}`)) as BunFileStats);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    unlink(): Promise<void> {
        if (this.#backing.kind === 'path') return nodeUnlink(this.#backing.path);
        const error = Object.assign(
            new TypeError('Is not possible to unlink a file descriptor'),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
        // Bun 1.4.4 resolves this Error value instead of rejecting it.
        return Promise.resolve(error as unknown as void);
    }

    delete(): Promise<void> {
        return this.unlink();
    }

    slice(begin?: number, end?: number, contentType?: string): BunFile;
    slice(begin?: number, contentType?: string): BunFile;
    slice(contentType?: string): BunFile;
    slice(beginOrType?: number | string, endOrType?: number | string, type: string | undefined = undefined): BunFile {
        if (!fileBackings.has(this)) {
            return Reflect.apply(blobSlice, this, arguments) as BunFile;
        }
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
        if (this.#backing.kind === 'fd' && (
            (begin !== undefined && Number.isFinite(begin) && begin < 0) ||
            (end !== undefined && Number.isFinite(end) && end < 0)
        )) {
            throw new TypeError('Negative slices of Bun.file(fd) are unsupported by this runtime');
        }
        return new BunFile(
            this.#backing,
            { type: contentType === undefined ? this.type : contentType, inferType: false },
            [...this.#slices, { begin: toInteger(begin ?? 0), end: end === undefined ? undefined : toInteger(end) }],
        );
    }

    /**
     * Serve-route protocol hook: describes this file as a static route target
     * (see serve-routes.ts). The existence probe is a synchronous stat so the
     * route table can decide 404 behavior at registration time.
     */
    [bunFileServeSymbol](): { path: string; exists: boolean; contentType: string; stream(): ReadableStream<Uint8Array<ArrayBuffer>> } {
        if (this.#backing.kind === 'fd') {
            throw new TypeError('Bun.file(fd) cannot be used as a static path route');
        }
        let exists = false;
        try {
            const stat = fs.stat(this.#backing.path);
            exists = stat.isFile === true || stat.isFIFO === true;
        } catch {
            exists = false;
        }
        return { path: this.#backing.path, exists, contentType: this.#contentType, stream: () => this.stream() };
    }

    async write(data: BunFileWriteInput, options?: { highWaterMark?: number }): Promise<number> {
        if (options != null && !isObject(options)) {
            throw new TypeError('Bun.file.write: options must be an object');
        }
        // Bun accepts but ignores unrecognized options on this method.
        if (typeof Request !== 'undefined' && data instanceof Request) {
            if (data.bodyUsed || data.body?.locked) throw new TypeError('Bun.file.write: Request body is already used or locked');
            if (data.body) {
                return this.#backing.kind === 'path'
                    ? writeStream(this.#backing.path, data.body, {})
                    : writeBorrowedStream(this.#backing.fd, data.body);
            }
            return write(this, '');
        }
        if (isReadableStream(data)) {
            return this.#backing.kind === 'path'
                ? writeStream(this.#backing.path, data, {})
                : writeBorrowedStream(this.#backing.fd, data);
        }
        if (data == null) throw new TypeError('Bun.file.write: missing input');
        if (typeof data !== 'string' && !arrayBufferIsView(data) && !isArrayBufferLike(data)
            && !isBlob(data) && !isResponse(data)) {
            return write(this, stringifyWriteInput(data));
        }
        return write(this, data as BunWriteInput);
    }
}

for (const property of [
    'name', 'type', 'size', 'lastModified',
    'slice', 'stream', 'bytes', 'arrayBuffer', 'text', 'formData', 'json',
    'exists', 'stat', 'unlink', 'delete', 'write', 'writer',
] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(BunFile.prototype, property)!;
    Object.defineProperty(BunFile.prototype, property, {
        ...descriptor,
        enumerable: true,
        configurable: false,
    });
}

function destinationPath(value: unknown): string {
    if (isBunFile(value)) {
        const backing = fileBackings.get(value)!;
        if (backing.kind === 'fd') {
            throw new TypeError('Bun.file(fd) is not a path destination');
        }
        return backing.path;
    }
    return pathFromValue(value);
}

async function inputBytes(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
    if (typeof value === 'string') {
        return arrayBufferBackedBytes(engine.encodeString(sanitizeSurrogates(value)));
    }
    if (arrayBufferIsView(value)) return toArrayBufferBytes(value);
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

function writeBorrowedBytes(fd: number, bytes: Uint8Array<ArrayBuffer>): number {
    let written = 0;
    while (written < bytes.byteLength) {
        const count = wrapSyncFs(
            () => fs.write(fd, bytes.subarray(written, written + BUN_FILE_CHUNK_SIZE)),
            'write',
            `fd:${fd}`,
        );
        if (count <= 0) throw new Error('Bun.write: filesystem write made no progress');
        written += count;
    }
    return written;
}

async function writeBorrowedStream(fd: number, stream: ReadableStream): Promise<number> {
    const reader = stream.getReader();
    let written = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            written += writeBorrowedBytes(fd, await inputBytes(next.value));
        }
        return written;
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
}

async function writeAliasedBorrowedStream(fd: number, stream: ReadableStream): Promise<number> {
    const reader = stream.getReader();
    let stage: CModuleAsyncFS.FileHandle | undefined;
    try {
        // Reading and writing the same open description interleaves its shared
        // offset. Stage first so inputs larger than one chunk are not skipped.
        stage = await asyncfs.mkstemp(join(os.tmpDir, `cno-bun-write-${os.pid}-XXXXXX`));
        let written = 0;
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            written += await writeBytes(stage, await inputBytes(next.value));
        }
        let position = 0;
        while (position < written) {
            const buffer = new Uint8Array(Math.min(BUN_FILE_CHUNK_SIZE, written - position));
            const count = await stage.read(buffer, position);
            if (count <= 0) throw new Error('Bun.write: staged input ended unexpectedly');
            writeBorrowedBytes(fd, buffer.subarray(0, count));
            position += count;
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

/**
 * Stream a Request body into a fixed stdio descriptor chunk by chunk. Unlike
 * file destinations there is no staging file or truncation: each read chunk is
 * written through immediately, and a mid-stream failure cancels the body.
 */
async function writeStdioStream(stdio: StdioFile, stream: ReadableStream): Promise<number> {
    const reader = stream.getReader();
    let written = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            written += await stdio.write(value as string | ArrayBufferView | ArrayBufferLike | Blob);
        }
        return written;
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
}

export async function write(
    destination: string | URL | BunFile | StdioFile,
    input: BunWriteInput,
    options?: BunFileWriteOptions,
): Promise<number> {
    const stdio = stdioDestination(destination);
    if (stdio) {
        if (isRequest(input)) {
            if (input.bodyUsed || input.body?.locked) {
                throw new TypeError('Bun.write: Request body is already used or locked');
            }
            // Bodyless Requests truncate files; for pipes they simply write nothing.
            if (!input.body) return 0;
            return writeStdioStream(stdio, input.body);
        }
        // mode/createPath are file-path concepts; Bun ignores them for pipes.
        if (isResponse(input) || isReadableStream(input)) {
            throw new TypeError('Bun.write: Response and ReadableStream input is not supported for stdio files');
        }
        return stdio.write(input as string | ArrayBufferView | ArrayBufferLike | Blob);
    }
    const backing = isBunFile(destination) ? fileBackings.get(destination)! : undefined;
    if (backing?.kind === 'fd') {
        // mode/createPath are path concepts; Bun ignores them for a borrowed fd.
        if (isResponse(input) || isRequest(input)) {
            const name = isRequest(input) ? 'Request' : 'Response';
            if (input.bodyUsed || input.body?.locked) {
                throw new TypeError(`Bun.write: ${name} body is already used or locked`);
            }
            return input.body ? writeBorrowedStream(backing.fd, input.body) : 0;
        }
        if (isBlob(input)) {
            const source = isBunFile(input) ? fileBackings.get(input) : undefined;
            if (source?.kind === 'fd' && source.fd === backing.fd) {
                return writeAliasedBorrowedStream(backing.fd, blobInputStream(input));
            }
            return writeBorrowedStream(backing.fd, blobInputStream(input));
        }
        if (isReadableStream(input)) return writeBorrowedStream(backing.fd, input);
        const bytes = await inputBytes(
            typeof input === 'object' && input !== null && !arrayBufferIsView(input) && !isArrayBufferLike(input)
                ? stringifyWriteInput(input)
                : input,
        );
        return writeBorrowedBytes(backing.fd, bytes);
    }
    const path = destinationPath(destination);
    const parsed = validateWriteOptions(options);
    if (isResponse(input) || isRequest(input)) {
        const name = isRequest(input) ? 'Request' : 'Response';
        if (input.bodyUsed || input.body?.locked) {
            throw new TypeError(`Bun.write: ${name} body is already used or locked`);
        }
        if (input.body) return writeStream(path, input.body, parsed);
    } else if (isBlob(input)) {
        return writeStream(path, blobInputStream(input), parsed);
    } else if (isReadableStream(input)) {
        return writeStream(path, input, parsed);
    }
    const bytes = isResponse(input) || isRequest(input)
        ? new Uint8Array(0)
        : await inputBytes(
            typeof input === 'object' && input !== null && !arrayBufferIsView(input) && !isArrayBufferLike(input)
                ? stringifyWriteInput(input)
                : input,
        );

    if (parsed.createPath !== false) await ensureDirectory(dirname(path));
    const handle = await asyncfs.open(path, 'w', parsed.mode);
    try {
        return await writeBytes(handle, bytes);
    } finally {
        await handle.close();
    }
}

export function file(
    path: string | URL | number | ArrayBufferLike | Uint8Array<ArrayBufferLike> | DataView<ArrayBufferLike>,
    options?: BlobPropertyBag,
): BunFile {
    const parsed = parseFileOptions(options);
    if (typeof path === 'number') {
        validateFd(path);
        return new BunFile({ kind: 'fd', fd: path }, parsed);
    }
    if (isBunBytePath(path)) {
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
        return new BunFile({ kind: 'path', path: engine.decodeString(bytes) }, parsed);
    }
    return new BunFile({ kind: 'path', path: pathFromValue(path) }, parsed);
}
