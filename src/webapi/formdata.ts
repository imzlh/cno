import { malloc } from "../utils/malloc";
import { Buffer } from "node-buffer";
import { bytesToArrayBuffer, sanitizeSurrogates } from "../utils/bytes";
import { basename } from "../utils/path";

const engine = import.meta.use('engine');
const textMod = import.meta.use('text');
const os = import.meta.use('os');
const asfs = import.meta.use('asyncfs');
const fs = import.meta.use('fs');

type FormDataEntryValue = globalThis.File | string;
type BlobPartSnapshot = Blob | Uint8Array<ArrayBuffer> | ArrayBuffer | string;

const nativeLineEnding = os.platform === 'windows' || os.platform === 'win32' ? '\r\n' : '\n';

function requireArguments(name: string, actual: number, required: number): void {
    if (actual >= required) return;
    throw new TypeError(`${name} requires ${required} argument${required === 1 ? '' : 's'}`);
}

// ==================== FormData ====================

class FormData implements globalThis.FormData {
    #entries: Array<[string, FormDataEntryValue]> = [];

    constructor(form?: unknown) {
        if (arguments.length !== 0) {
            throw new TypeError('FormData constructor: HTMLFormElement parsing not supported in CNO');
        }
    }

    append(name: string, value: string | Blob, filename?: string): void {
        requireArguments('FormData.append', arguments.length, 2);
        const key = String(name);

        if (value instanceof Blob) {
            const file = blobToFile(value, filename);
            this.#entries.push([key, file]);
        } else {
            if (arguments.length >= 3) throw new TypeError('FormData.append filename requires a Blob value');
            this.#entries.push([key, String(value)]);
        }
    }

    delete(name: string): void {
        requireArguments('FormData.delete', arguments.length, 1);
        const key = String(name);
        this.#entries = this.#entries.filter(([k]) => k !== key);
    }

    get(name: string): FormDataEntryValue | null {
        requireArguments('FormData.get', arguments.length, 1);
        const key = String(name);
        const entry = this.#entries.find(([k]) => k === key);
        return entry ? entry[1] : null;
    }

    getAll(name: string): FormDataEntryValue[] {
        requireArguments('FormData.getAll', arguments.length, 1);
        const key = String(name);
        return this.#entries
            .filter(([k]) => k === key)
            .map(([, v]) => v);
    }

    has(name: string): boolean {
        requireArguments('FormData.has', arguments.length, 1);
        const key = String(name);
        return this.#entries.some(([k]) => k === key);
    }

    set(name: string, value: string | Blob, filename?: string): void {
        requireArguments('FormData.set', arguments.length, 2);
        const key = String(name);

        let newValue: FormDataEntryValue;
        if (value instanceof Blob) {
            newValue = blobToFile(value, filename);
        } else {
            if (arguments.length >= 3) throw new TypeError('FormData.set filename requires a Blob value');
            newValue = String(value);
        }

        let found = false;
        this.#entries = this.#entries.filter(([k]) => {
            if (k === key) {
                if (!found) {
                    found = true;
                    return true;
                }
                return false;
            }
            return true;
        });

        if (found) {
            const index = this.#entries.findIndex(([k]) => k === key);
            this.#entries[index] = [key, newValue];
        } else {
            this.#entries.push([key, newValue]);
        }
    }

    forEach(
        callback: (value: FormDataEntryValue, key: string, parent: this) => void,
        thisArg?: unknown
    ): void {
        if (arguments.length < 1 || typeof callback !== 'function') {
            throw new TypeError('FormData.forEach requires a callback');
        }
        for (let i = 0; i < this.#entries.length; i++) {
            const [key, value] = this.#entries[i];
            callback.call(thisArg, value, key, this);
        }
    }

    *entries(): IterableIterator<[string, FormDataEntryValue]> {
        yield* this.#entries;
    }

    *keys(): IterableIterator<string> {
        for (const [key] of this.#entries) {
            yield key;
        }
    }

    *values(): IterableIterator<FormDataEntryValue> {
        for (const [, value] of this.#entries) {
            yield value;
        }
    }

    [Symbol.iterator](): IterableIterator<[string, FormDataEntryValue]> {
        return this.entries();
    }
    
    get [Symbol.toStringTag]() {
        return 'FormData';
    }
}

// ==================== Blob ====================

const denoCustomInspect = Symbol.for('Deno.customInspect');
export const blobBytesSymbol = Symbol.for('cno.blob.bytes');

class Blob implements globalThis.Blob {
    #parts: BlobPartSnapshot[];
    #type: string;
    #size: number;

    constructor(
        blobParts?: BlobPart[] | Iterable<BlobPart> | null,
        options?: BlobPropertyBag
    ) {
        const endings = normalizeEndings(options?.endings ?? 'transparent');
        if (blobParts === null) throw new TypeError('Blob parts must be a sequence');
        if (blobParts === undefined) {
            this.#parts = [];
        } else {
            // A bare string is iterable but is NOT a BlobPart sequence: WebIDL rejects
            // it, and accepting it silently turns `new Blob('ab')` into two parts.
            if (typeof blobParts === 'string') throw new TypeError('Blob parts must be a sequence');
            const iterator = Reflect.get(Object(blobParts), Symbol.iterator);
            if (typeof iterator !== 'function') throw new TypeError('Blob parts must be a sequence');
            this.#parts = Array.from(blobParts, (part) => snapshotBlobPart(part, endings));
        }
        // `?? ''` would swallow an explicit null, which WebIDL stringifies to "null".
        this.#type = normalizeType(options?.type === undefined ? '' : options.type);
        this.#size = calculateSize(this.#parts);
    }

    get size(): number {
        return this.#size;
    }

    get type(): string {
        return this.#type;
    }

    slice(start?: number, end?: number, contentType?: string): globalThis.Blob {
        // `start`/`end` are WebIDL `long long`: NaN and +/-Infinity become 0 *before*
        // the relative-index clamp, so `slice(7, Infinity)` is empty, not the tail.
        const relativeStart = start === undefined ? 0 : normalizeIndex(toLongLong(start), this.#size);
        const relativeEnd = end === undefined ? this.#size : normalizeIndex(toLongLong(end), this.#size);
        const span = Math.max(relativeEnd - relativeStart, 0);

        const buffer = this.#toBuffer();
        const sliced = new Uint8Array(buffer.buffer, buffer.byteOffset + relativeStart, span);

        return new Blob([sliced], { type: contentType ?? '' });
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buffer = this.#toBuffer();
        return bytesToArrayBuffer(buffer);
    }

    bytes(): Promise<Uint8Array<ArrayBuffer>> {
        return Promise.resolve(new Uint8Array(this.#toBuffer()));
    }

    [blobBytesSymbol](): Uint8Array<ArrayBuffer> {
        return new Uint8Array(this.#toBuffer());
    }

    async text(): Promise<string> {
        const buffer = this.#toBuffer();
        // Spec requires UTF-8 decode (U+FFFD for malformed input); engine.decodeString
        // is WTF-8-tolerant and would leak a lone surrogate back out.
        return new textMod.Decoder().decode(buffer);
    }

    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        const buffer = this.#toBuffer();

        return new ReadableStream({
            start(controller) {
                // An empty Blob must close with no chunk at all; enqueuing a
                // zero-length one makes the first read report `done: false`.
                if (buffer.byteLength > 0) controller.enqueue(new Uint8Array(buffer));
                controller.close();
            }
        });
    }

    #toBuffer(): Buffer {
        const chunks: Uint8Array[] = [];

        for (const part of this.#parts) {
            if (part instanceof Blob) chunks.push(part.#toBuffer());
            else chunks.push(blobPartBytes(part));
        }

        return Buffer.concat(chunks);
    }

    get [Symbol.toStringTag]() {
        return 'Blob';
    }

    toString() {
        return `Blob { size: ${this.#size}, type: "${this.#type}" }`
    }

    [denoCustomInspect]() {
        if (!(this instanceof Blob)) return 'Blob { }';
        return this.toString();
    }
}

// ==================== File ====================

const filePathStore = new WeakMap<File, string>();

class File extends Blob implements globalThis.File {
    #name: string;
    #lastModified: number;

    constructor(
        fileBits: BlobPart[],
        fileName: string,
        options?: FilePropertyBag
    ) {
        requireArguments('File.constructor', arguments.length, 2);
        super(fileBits, options);
        this.#name = String(fileName);
        // WebIDL `long long`: a Date (or any object) must be coerced to a number,
        // otherwise `lastModified` hands back the Date itself.
        this.#lastModified = options?.lastModified === undefined
            ? Date.now()
            : toLongLong(Number(options.lastModified));
    }

    get name(): string {
        return this.#name;
    }

    get lastModified(): number {
        return this.#lastModified;
    }

    get webkitRelativePath(): string {
        return '';
    }

    get [Symbol.toStringTag]() {
        return 'File';
    }

    toString() {
        return `File { name: "${this.#name}", size: ${this.size}, type: "${this.type}" }`
    }

    [denoCustomInspect]() {
        return this.toString();
    }

    static async fromPath(path: string, options?: {
        type?: string;
        name?: string;
    }): Promise<File> {
        const buffer = await asfs.readFile(path);
        const fileName = (options?.name ?? basename(path)) || 'file';

        let lastModified = Date.now();
        try {
            const stats = await asfs.stat(path);
            lastModified = stats.mtim?.getTime() ?? Date.now();
        } catch {
        }

        const filePart = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
            ? buffer
            : buffer.slice();
        const file = new File(
            [filePart],
            fileName,
            {
                type: options?.type ?? guessContentType(fileName),
                lastModified
            }
        );

        filePathStore.set(file, path);

        return file;
    }

    static fromPathLazy(path: string, options?: {
        type?: string;
        name?: string;
    }): globalThis.File {
        const fileName = (options?.name ?? basename(path)) || 'file';
        const file = new File(
            [],
            fileName,
            {
                type: options?.type ?? guessContentType(fileName),
                lastModified: Date.now()
            }
        );

        filePathStore.set(file, path);

        file.arrayBuffer = async () => {
            const loaded = await File.fromPath(path, options);
            return loaded.arrayBuffer();
        };

        file.text = async () => {
            const loaded = await File.fromPath(path, options);
            return loaded.text();
        };

        let fileHandle:CModuleAsyncFS.FileHandle | undefined;
        file.stream = () => {
            return new ReadableStream({
                async start(controller) {
                    try{
                        fileHandle = await asfs.open(path, 'r');
                    } catch (error) {
                        controller.error(error);
                        return;
                    }
                },
                async pull(controller) {
                    const buf = malloc(controller);
                    try {
                        const handle = fileHandle;
                        if (!handle) throw new Error('file stream was pulled before open');
                        const readed = await handle.read(buf);
                        if (!readed) {
                            controller.close();
                            handle.close();
                            fileHandle = undefined;
                            return;
                        }
                        controller.enqueue(buf.slice(0, readed));
                    } catch (error) {
                        controller.error(error);
                    }
                },
                cancel() {
                    if (fileHandle) {
                        fileHandle.close();
                        fileHandle = undefined;
                    }
                },
            });
        };

        return file;
    }
}

// ==================== Helper Functions ====================

const blobToFile = (blob: Blob, filename?: string): globalThis.File => {
    if (blob instanceof File) {
        return filename !== undefined ? new File([blob], filename, { type: blob.type }) : blob;
    }

    return new File(
        [blob],
        filename ?? 'blob',
        { type: blob.type }
    );
};

const normalizeType = (type: unknown): string => {
    const normalized = String(type).toLowerCase();
    // Type must be ASCII and match pattern
    if (!/^[\x20-\x7E]*$/.test(normalized)) {
        return '';
    }
    return normalized;
};

const normalizeEndings = (endings: unknown): EndingType => {
    const value = String(endings);
    if (value === 'transparent' || value === 'native') return value;
    throw new TypeError(`Invalid Blob endings: ${value}`);
};

const normalizeLineEndings = (value: string): string => {
    return value.replace(/\r\n|\r|\n/g, nativeLineEnding);
};

const snapshotBlobPart = (part: unknown, endings: EndingType): BlobPartSnapshot => {
    if (part instanceof Blob) return part;
    if (ArrayBuffer.isView(part)) {
        return new Uint8Array(part.buffer, part.byteOffset, part.byteLength).slice();
    }
    if (part instanceof ArrayBuffer) return part.slice(0);
    const string = String(part);
    return endings === 'native' ? normalizeLineEndings(string) : string;
};

const blobPartBytes = (part: Exclude<BlobPartSnapshot, Blob>): Uint8Array => {
    // Blob parts are UTF-8 encoded: lone surrogates become U+FFFD, not WTF-8.
    if (typeof part === 'string') return engine.encodeString(sanitizeSurrogates(part));
    if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    if (part instanceof ArrayBuffer) return new Uint8Array(part);
    return engine.encodeString(sanitizeSurrogates(String(part)));
};

const calculateSize = (parts: BlobPartSnapshot[]): number => {
    let size = 0;

    for (const part of parts) {
        if (part instanceof Blob) {
            size += part.size;
        } else if (ArrayBuffer.isView(part)) {
            size += part.byteLength;
        } else if (part instanceof ArrayBuffer) {
            size += part.byteLength;
        } else {
            size += Buffer.byteLength(String(part), 'utf-8');
        }
    }

    return size;
};

const normalizeIndex = (index: number, length: number): number => {
    const num = Number(index);
    if (num < 0) {
        return Math.max(length + num, 0);
    }
    return Math.min(num, length);
};

/** WebIDL `long long` coercion: NaN and +/-Infinity are 0, finite values truncate. */
const toLongLong = (value: number): number => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : 0;
};

const guessContentType = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
        'txt': 'text/plain',
        'html': 'text/html',
        'css': 'text/css',
        'js': 'text/javascript',
        'json': 'application/json',
        'xml': 'application/xml',
        'pdf': 'application/pdf',
        'zip': 'application/zip',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'mp3': 'audio/mpeg',
        'mp4': 'video/mp4',
        'webm': 'video/webm'
    };
    return types[ext ?? ''] ?? 'application/octet-stream';
};

// esbuild renames classes that collide with globals (Blob→_Blob, File→_File).
// Force the correct .name so constructor.name checks pass.
Object.defineProperty(Blob, 'name', { value: 'Blob', configurable: true });
Object.defineProperty(File, 'name', { value: 'File', configurable: true });

Reflect.set(globalThis, 'FormData', FormData);
Reflect.set(globalThis, 'Blob', Blob);
Reflect.set(globalThis, 'File', File);

export {
    FormData,
    Blob,
    File
};
