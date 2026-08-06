import { decodeBuffer, pathToString, type PathLike } from './utils';

import { nsfs, nsasfs } from './syspath';
const fs = nsfs;
const asfs = nsasfs;

interface OpenAsBlobOptions {
    type?: string;
}

interface FileSnapshot {
    ctime: number;
    dev: number;
    ino: number;
    mtime: number;
    size: number;
}

function snapshot(stat: CModuleFS.Stats): FileSnapshot {
    return {
        ctime: stat.ctim.getTime(),
        dev: stat.dev,
        ino: stat.ino,
        mtime: stat.mtim.getTime(),
        size: stat.size,
    };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
    return left.ctime === right.ctime && left.dev === right.dev && left.ino === right.ino &&
        left.mtime === right.mtime && left.size === right.size;
}

function notReadableError(): DOMException {
    return new DOMException('The blob could not be read', 'NotReadableError');
}

function normalizeSliceIndex(value: number | undefined, size: number, fallback: number): number {
    if (value === undefined) return fallback;
    const integer = Number.isNaN(value) ? 0 : Math.trunc(value);
    if (integer < 0) return Math.max(size + integer, 0);
    return Math.min(integer, size);
}

function normalizeBlobType(value: string): string {
    const type = value.toLowerCase();
    return /^[\x20-\x7e]*$/.test(type) ? type : '';
}

class FileBackedBlob extends Blob {
    readonly #end: number;
    readonly #fileSnapshot: FileSnapshot;
    readonly #path: string;
    readonly #start: number;
    readonly #type: string;

    constructor(path: string, fileSnapshot: FileSnapshot, type: string, start = 0, end = fileSnapshot.size) {
        super([]);
        this.#path = path;
        this.#fileSnapshot = fileSnapshot;
        this.#type = type;
        this.#start = start;
        this.#end = end;
    }

    get size(): number { return this.#end - this.#start; }
    get type(): string { return this.#type; }

    slice(start?: number, end?: number, contentType = ''): Blob {
        const relativeStart = normalizeSliceIndex(start, this.size, 0);
        const relativeEnd = normalizeSliceIndex(end, this.size, this.size);
        const span = Math.max(relativeEnd - relativeStart, 0);
        const absoluteStart = this.#start + relativeStart;
        return new FileBackedBlob(
            this.#path,
            this.#fileSnapshot,
            normalizeBlobType(String(contentType)),
            absoluteStart,
            absoluteStart + span,
        );
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const bytes = await this.#read();
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return copy.buffer;
    }

    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
        return new Uint8Array(await this.arrayBuffer());
    }

    async text(): Promise<string> {
        return decodeBuffer(await this.#read(), 'utf8');
    }

    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream({
            start: async controller => {
                try {
                    controller.enqueue(new Uint8Array(await this.arrayBuffer()));
                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            },
        });
    }

    async #read(): Promise<Uint8Array<ArrayBuffer>> {
        try {
            if (!sameSnapshot(this.#fileSnapshot, snapshot(fs.stat(this.#path)))) throw notReadableError();
            const bytes = await asfs.readFile(this.#path);
            if (!sameSnapshot(this.#fileSnapshot, snapshot(fs.stat(this.#path)))) throw notReadableError();
            return bytes.slice(this.#start, this.#end);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'NotReadableError') throw error;
            throw notReadableError();
        }
    }
}

export function openAsBlob(path: PathLike, options: OpenAsBlobOptions = {}): Promise<Blob> {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        const error = new TypeError('The "options" argument must be of type object.');
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
        throw error;
    }
    const type = options.type || '';
    if (typeof type !== 'string') {
        const error = new TypeError('The "options.type" property must be of type string.');
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
        throw error;
    }
    const pathString = pathToString(path);
    let stat: CModuleFS.Stats;
    try {
        stat = fs.stat(pathString);
    } catch {
        const error = new TypeError('Unable to open file as blob');
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_VALUE');
        throw error;
    }
    return Promise.resolve(new FileBackedBlob(pathString, snapshot(stat), type));
}
