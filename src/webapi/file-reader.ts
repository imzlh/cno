import { Buffer } from "node-buffer";
import { DOMException, EventTarget, ProgressEvent } from "./events";

type FileReaderHandler = ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null;

class FileReader extends EventTarget {
    static readonly EMPTY = 0;
    static readonly LOADING = 1;
    static readonly DONE = 2;

    readonly EMPTY = FileReader.EMPTY;
    readonly LOADING = FileReader.LOADING;
    readonly DONE = FileReader.DONE;

    error: DOMException | null = null;
    result: string | ArrayBuffer | null = null;
    readyState: 0 | 1 | 2 = FileReader.EMPTY;

    #activeRead = 0;
    #eventHandlers = new Map<string, { value: FileReaderHandler; listener: EventListener }>();

    get onabort() { return this.#getEventHandler('abort'); }
    set onabort(value: FileReaderHandler) { this.#setEventHandler('abort', value); }

    get onerror() { return this.#getEventHandler('error'); }
    set onerror(value: FileReaderHandler) { this.#setEventHandler('error', value); }

    get onload() { return this.#getEventHandler('load'); }
    set onload(value: FileReaderHandler) { this.#setEventHandler('load', value); }

    get onloadend() { return this.#getEventHandler('loadend'); }
    set onloadend(value: FileReaderHandler) { this.#setEventHandler('loadend', value); }

    get onloadstart() { return this.#getEventHandler('loadstart'); }
    set onloadstart(value: FileReaderHandler) { this.#setEventHandler('loadstart', value); }

    get onprogress() { return this.#getEventHandler('progress'); }
    set onprogress(value: FileReaderHandler) { this.#setEventHandler('progress', value); }

    abort(): void {
        if (this.readyState === FileReader.EMPTY) {
            this.result = null;
            return;
        }
        if (this.readyState === FileReader.DONE) return;

        this.#activeRead++;
        this.result = null;
        this.error = null;
        this.readyState = FileReader.DONE;
        this.#dispatchProgress('abort', false);
        this.#dispatchProgress('loadend', false);
    }

    readAsArrayBuffer(blob: Blob): void {
        this.#startRead(blob, async (source) => await source.arrayBuffer());
    }

    readAsBinaryString(blob: Blob): void {
        this.#startRead(blob, async (source) => {
            const bytes = new Uint8Array(await source.arrayBuffer());
            let out = '';
            for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
            return out;
        });
    }

    readAsDataURL(blob: Blob): void {
        this.#startRead(blob, async (source) => {
            const mediaType = source.type || 'application/octet-stream';
            const bytes = new Uint8Array(await source.arrayBuffer());
            return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
        });
    }

    readAsText(blob: Blob, encoding?: string): void {
        this.#startRead(blob, async (source) => {
            const buffer = await source.arrayBuffer();
            return new TextDecoder(encoding).decode(buffer);
        });
    }

    #getEventHandler(type: string): FileReaderHandler {
        return this.#eventHandlers.get(type)?.value ?? null;
    }

    #setEventHandler(type: string, value: FileReaderHandler): void {
        const previous = this.#eventHandlers.get(type);
        if (previous) this.removeEventListener(type, previous.listener);
        if (typeof value !== 'function') {
            this.#eventHandlers.delete(type);
            return;
        }

        const listener: EventListener = (event) => {
            if (event instanceof ProgressEvent) value.call(this, event);
        };
        this.#eventHandlers.set(type, { value, listener });
        this.addEventListener(type, listener);
    }

    #startRead(
        blob: Blob,
        convert: (source: Blob) => Promise<string | ArrayBuffer>
    ): void {
        if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob');
        if (this.readyState === FileReader.LOADING) {
            throw new DOMException('The object is already busy reading Blobs', 'InvalidStateError');
        }

        const readId = ++this.#activeRead;
        this.error = null;
        this.result = null;
        this.readyState = FileReader.LOADING;
        this.#dispatchProgress('loadstart', true, 0, blob.size);

        Promise.resolve().then(async () => {
            let result: string | ArrayBuffer;
            try {
                result = await convert(blob);
            } catch (error) {
                this.#failRead(readId, error);
                return;
            }

            if (!this.#isActive(readId)) return;

            this.#dispatchProgress('progress', true, blob.size, blob.size);
            if (!this.#isActive(readId)) return;

            this.result = result;
            this.readyState = FileReader.DONE;
            this.#dispatchProgress('load', true, blob.size, blob.size);
            if (this.#activeRead !== readId) return;

            this.#dispatchProgress('loadend', true, blob.size, blob.size);
        });
    }

    #isActive(readId: number): boolean {
        return this.#activeRead === readId && this.readyState === FileReader.LOADING;
    }

    #failRead(readId: number, error: unknown): void {
        if (!this.#isActive(readId)) return;

        const message = error instanceof Error ? error.message : String(error);
        this.error = error instanceof DOMException
            ? error
            : new DOMException(message, 'NotReadableError');
        this.result = null;
        this.readyState = FileReader.DONE;
        this.#dispatchProgress('error', false);
        if (this.#activeRead !== readId) return;
        this.#dispatchProgress('loadend', false);
    }

    #dispatchProgress(
        type: string,
        lengthComputable: boolean,
        loaded = 0,
        total = 0
    ): void {
        this.dispatchEvent(new ProgressEvent(type, {
            lengthComputable,
            loaded,
            total,
        }));
    }

    get [Symbol.toStringTag]() {
        return 'FileReader';
    }
}

Reflect.set(globalThis, 'FileReader', FileReader);
