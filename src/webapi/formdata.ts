import { malloc } from "../utils/malloc";
import { Buffer } from "node-buffer";

const engine = import.meta.use('engine');
const asfs = import.meta.use('asyncfs');
const fs = import.meta.use('fs');

type FormDataEntryValue = globalThis.File | string;

// ==================== FormData ====================

class FormData implements globalThis.FormData {
    #entries: Array<[string, FormDataEntryValue]> = [];

    constructor(form?: any) {
        if (form) {
            throw new Error('HTMLFormElement parsing not supported in CNO');
        }
    }

    append(name: string, value: string | Blob, filename?: string): void {
        const key = String(name);

        if (value instanceof Blob) {
            const file = blobToFile(value, filename);
            this.#entries.push([key, file]);
        } else {
            this.#entries.push([key, String(value)]);
        }
    }

    delete(name: string): void {
        const key = String(name);
        this.#entries = this.#entries.filter(([k]) => k !== key);
    }

    get(name: string): FormDataEntryValue | null {
        const key = String(name);
        const entry = this.#entries.find(([k]) => k === key);
        return entry ? entry[1] : null;
    }

    getAll(name: string): FormDataEntryValue[] {
        const key = String(name);
        return this.#entries
            .filter(([k]) => k === key)
            .map(([, v]) => v);
    }

    has(name: string): boolean {
        const key = String(name);
        return this.#entries.some(([k]) => k === key);
    }

    set(name: string, value: string | Blob, filename?: string): void {
        const key = String(name);

        const newValue: FormDataEntryValue = value instanceof Blob
            ? blobToFile(value, filename)
            : String(value);

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
        thisArg?: any
    ): void {
        for (const [key, value] of this.#entries) {
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

class Blob implements globalThis.Blob {
    #parts: Array<BufferSource | globalThis.Blob | string>;
    #type: string;
    #size: number;

    constructor(
        blobParts?: BlobPart[],
        options?: BlobPropertyBag
    ) {
        this.#parts = blobParts ? [...blobParts] : [];
        this.#type = normalizeType(options?.type ?? '');
        this.#size = calculateSize(this.#parts);
    }

    get size(): number {
        return this.#size;
    }

    get type(): string {
        return this.#type;
    }

    slice(start?: number, end?: number, contentType?: string): globalThis.Blob {
        const relativeStart = start === undefined ? 0 : normalizeIndex(start, this.#size);
        const relativeEnd = end === undefined ? this.#size : normalizeIndex(end, this.#size);
        const span = Math.max(relativeEnd - relativeStart, 0);

        const buffer = this.#toBuffer();
        const sliced = new Uint8Array(buffer.buffer, buffer.byteOffset + relativeStart, span);

        return new Blob([new Uint8Array(sliced)], { type: contentType ?? '' });
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buffer = this.#toBuffer();
        return buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength
        ) as ArrayBuffer;
    }

    bytes(): Promise<Uint8Array<ArrayBuffer>> {
        return Promise.resolve(new Uint8Array(this.#toBuffer()));
    }

    async text(): Promise<string> {
        const buffer = this.#toBuffer();
        return buffer.toString('utf-8');
    }

    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        const buffer = this.#toBuffer();

        return new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(buffer));
                controller.close();
            }
        });
    }

    #toBuffer(): Buffer {
        const chunks: Uint8Array[] = [];

        for (const part of this.#parts) {
            if (typeof part === 'string') {
                chunks.push(engine.encodeString(part));
            } else if (part instanceof Blob) {
                chunks.push(part.#toBuffer() as Uint8Array);
            } else if (ArrayBuffer.isView(part)) {
                chunks.push(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
            } else if (part instanceof ArrayBuffer) {
                chunks.push(new Uint8Array(part));
            }
        }

        return Buffer.concat(chunks);
    }

    get [Symbol.toStringTag]() {
        return 'Blob';
    }

    toString() {
        return `Blob { size: ${this.#size}, type: "${this.#type}" }`
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
        super(fileBits, options);
        this.#name = String(fileName);
        this.#lastModified = options?.lastModified ?? Date.now();
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

    static async fromPath(path: string, options?: {
        type?: string;
        name?: string;
    }): Promise<File> {
        const buffer = await asfs.readFile(path);
        const fileName = options?.name ?? path.split('/').pop() ?? 'file';

        let lastModified = Date.now();
        try {
            const stats = await asfs.stat(path);
            lastModified = stats.mtime?.getTime() ?? Date.now();
        } catch {
        }

        const file = new File(
            [buffer.buffer as ArrayBuffer],
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
        const fileName = options?.name ?? path.split('/').pop() ?? 'file';
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
                        const readed = await fileHandle!.read(buf);
                        if (!readed) {
                            controller.close();
                            fileHandle!.close();
                            fileHandle = undefined;
                            return;
                        }
                        controller.enqueue(buf.slice(0, readed));
                    } catch (error) {
                        controller.error(error);
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
        return filename ? new File([blob], filename, { type: blob.type }) : blob;
    }

    return new File(
        [blob],
        filename ?? 'blob',
        { type: blob.type }
    );
};

const normalizeType = (type: string): string => {
    const normalized = String(type).toLowerCase();
    // Type must be ASCII and match pattern
    if (!/^[\x20-\x7E]*$/.test(normalized)) {
        return '';
    }
    return normalized;
};

const calculateSize = (parts: Array<BufferSource | globalThis.Blob | string>): number => {
    let size = 0;

    for (const part of parts) {
        if (typeof part === 'string') {
            size += Buffer.byteLength(part, 'utf-8');
        } else if (part instanceof Blob) {
            size += part.size;
        } else if (ArrayBuffer.isView(part)) {
            size += part.byteLength;
        } else if (part instanceof ArrayBuffer) {
            size += part.byteLength;
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