import { utf8Decode } from '../../utils/bytes';

const engine = import.meta.use('engine');

type BinaryChunk = ArrayBufferView | ArrayBufferLike;
type StreamChunk = BinaryChunk | string;

function bytesOf(value: BinaryChunk): Uint8Array {
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
        return new Uint8Array(value);
    }
    throw new TypeError('Expected TypedArray');
}

export function concatArrayBuffers(buffers: BinaryChunk[], maxLength?: number, asUint8Array?: false): ArrayBuffer;
export function concatArrayBuffers(buffers: BinaryChunk[], maxLength: number, asUint8Array: true): Uint8Array<ArrayBuffer>;
export function concatArrayBuffers(buffers: BinaryChunk[], maxLength?: number, asUint8Array = false): ArrayBuffer | Uint8Array<ArrayBuffer> {
    if (typeof maxLength === 'number' && (Number.isNaN(maxLength) || maxLength < 0)) {
        throw new RangeError('Maximum length must be >= 0');
    }
    const chunks = (buffers ?? []).map(bytesOf);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const length = typeof maxLength === 'number' ? Math.min(total, Math.floor(maxLength)) : total;
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        const count = Math.min(chunk.byteLength, length - offset);
        result.set(chunk.subarray(0, count), offset);
        offset += count;
        if (offset === length) break;
    }
    return asUint8Array ? result : result.buffer;
}

async function readChunks<T>(stream: ReadableStream<T>): Promise<T[]> {
    const reader = stream.getReader();
    const chunks: T[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return chunks;
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
}

export function readableStreamToArray<T>(stream: ReadableStream<T>): Promise<T[]> {
    return readChunks(stream);
}

export async function readableStreamToBlob(stream: ReadableStream<StreamChunk>): Promise<Blob> {
    return new Blob([await readableStreamToArrayBuffer(stream)]);
}

export async function readableStreamToArrayBuffer(stream: ReadableStream<StreamChunk>): Promise<ArrayBuffer> {
    const chunks = await readChunks(stream);
    return concatArrayBuffers(chunks.map(chunk => typeof chunk === 'string' ? engine.encodeString(chunk) : bytesOf(chunk)));
}

export async function readableStreamToBytes(stream: ReadableStream<StreamChunk>): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await readableStreamToArrayBuffer(stream));
}

export async function readableStreamToText(stream: ReadableStream<StreamChunk>): Promise<string> {
    const chunks = await readChunks(stream);
    let result = '';
    let binary: Uint8Array[] = [];
    let firstRun = true;
    const flush = () => {
        if (binary.length) {
            let bytes = new Uint8Array(concatArrayBuffers(binary));
            if (firstRun) {
                // TextDecoder strips one leading BOM at the stream start; it
                // may span chunks because the run is concatenated first.
                if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
            }
            firstRun = false;
            // WHATWG replacement semantics for invalid sequences.
            result += utf8Decode(bytes);
            binary = [];
        }
    };
    for (const chunk of chunks) {
        if (typeof chunk === 'string') {
            flush();
            result += chunk;
        } else {
            binary.push(bytesOf(chunk));
        }
    }
    flush();
    return result;
}

export async function readableStreamToJSON(stream: ReadableStream<StreamChunk>): Promise<unknown> {
    return JSON.parse(await readableStreamToText(stream));
}

type FormBoundary = string | ArrayBufferView;

const CRLF = [13, 10];

function formError(message: string): TypeError {
    return new TypeError(`Invalid form data: ${message}`);
}

function matchesAt(data: Uint8Array, offset: number, pattern: Uint8Array): boolean {
    if (offset < 0 || offset + pattern.length > data.length) return false;
    for (let i = 0; i < pattern.length; i++) {
        if (data[offset + i] !== pattern[i]) return false;
    }
    return true;
}

function indexOfBytes(data: Uint8Array, pattern: Uint8Array, from: number): number {
    const first = pattern[0];
    for (let i = data.indexOf(first, from); i !== -1; i = data.indexOf(first, i + 1)) {
        if (matchesAt(data, i, pattern)) return i;
    }
    return -1;
}

function percentDecode(input: Uint8Array): Uint8Array {
    const out = new Uint8Array(input.length);
    const hex = (byte: number) => byte >= 48 && byte <= 57 ? byte - 48
        : byte >= 65 && byte <= 70 ? byte - 55
        : byte >= 97 && byte <= 102 ? byte - 87 : -1;
    let length = 0;
    for (let i = 0; i < input.length; i++) {
        const byte = input[i];
        if (byte === 0x25 && i + 2 < input.length && hex(input[i + 1]) >= 0 && hex(input[i + 2]) >= 0) {
            out[length++] = hex(input[i + 1]) * 16 + hex(input[i + 2]);
            i += 2;
        } else {
            out[length++] = byte === 0x2b ? 0x20 : byte;
        }
    }
    return out.subarray(0, length);
}

// WHATWG application/x-www-form-urlencoded parser, operating on bytes.
function parseUrlEncoded(data: Uint8Array, form: FormData): void {
    let start = 0;
    while (start <= data.length) {
        let end = data.indexOf(0x26, start);
        if (end === -1) end = data.length;
        if (end > start) {
            const pair = data.subarray(start, end);
            const eq = pair.indexOf(0x3d);
            const name = eq === -1 ? pair : pair.subarray(0, eq);
            const value = eq === -1 ? pair.subarray(0, 0) : pair.subarray(eq + 1);
            form.append(engine.decodeString(percentDecode(name)), engine.decodeString(percentDecode(value)));
        }
        start = end + 1;
    }
}

function boundaryBytes(boundary: FormBoundary): Uint8Array {
    const bytes = typeof boundary === 'string' ? engine.encodeString(boundary) : bytesOf(boundary);
    if (bytes.length === 0) throw new TypeError('Multipart boundary must not be empty');
    if (bytes.includes(13) || bytes.includes(10)) throw new TypeError('Multipart boundary must not contain line breaks');
    return bytes;
}

interface DelimiterMatch {
    /** Index of the CRLF preceding the delimiter, or -1 for a delimiter at offset 0. */
    bodyEnd: number;
    final: boolean;
    /** Offset of the first byte after the delimiter line. */
    next: number;
}

// Checks what follows "--boundary": either "--" (close) or optional
// whitespace and CRLF. Anything else means the text only looked like a delimiter.
function afterDelimiter(data: Uint8Array, offset: number): { final: boolean; next: number } | undefined {
    if (data[offset] === 0x2d && data[offset + 1] === 0x2d) return { final: true, next: offset + 2 };
    let i = offset;
    while (data[i] === 0x20 || data[i] === 0x09) i++;
    if (data[i] === 13 && data[i + 1] === 10) return { final: false, next: i + 2 };
    return undefined;
}

function findDelimiter(data: Uint8Array, delimiter: Uint8Array, from: number, atStart: boolean): DelimiterMatch | undefined {
    if (atStart && matchesAt(data, 0, delimiter)) {
        const tail = afterDelimiter(data, delimiter.length);
        if (tail) return { bodyEnd: -1, ...tail };
    }
    const crlfDelimiter = new Uint8Array(delimiter.length + 2);
    crlfDelimiter.set(CRLF);
    crlfDelimiter.set(delimiter, 2);
    for (let at = indexOfBytes(data, crlfDelimiter, from); at !== -1; at = indexOfBytes(data, crlfDelimiter, at + 1)) {
        const tail = afterDelimiter(data, at + crlfDelimiter.length);
        if (tail) return { bodyEnd: at, ...tail };
    }
    return undefined;
}

// Header parameters, e.g. `form-data; name="a"; filename="b"`. Quoted values end
// at the next quote: browsers escape quotes as %22 and do not use backslashes.
function parseHeaderParams(value: string): { type: string; params: Map<string, string> } {
    const params = new Map<string, string>();
    const semicolon = value.indexOf(';');
    const type = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
    let i = semicolon === -1 ? value.length : semicolon + 1;
    while (i < value.length) {
        while (i < value.length && (value[i] === ';' || value[i] === ' ' || value[i] === '\t')) i++;
        const nameStart = i;
        while (i < value.length && value[i] !== '=' && value[i] !== ';') i++;
        const name = value.slice(nameStart, i).trim().toLowerCase();
        let parsed = '';
        if (value[i] === '=') {
            i++;
            while (value[i] === ' ' || value[i] === '\t') i++;
            if (value[i] === '"') {
                const close = value.indexOf('"', i + 1);
                if (close === -1) throw formError('unterminated quoted parameter');
                parsed = value.slice(i + 1, close);
                i = close + 1;
                while (i < value.length && value[i] !== ';') i++;
            } else {
                const end = value.indexOf(';', i);
                parsed = value.slice(i, end === -1 ? value.length : end).trim();
                i = end === -1 ? value.length : end;
            }
        }
        if (name && !params.has(name)) params.set(name, parsed);
    }
    return { type, params };
}

const unescapeFormName = (value: string) => value.replace(/%(0A|0D|22)/g, (_, code: string) =>
    code === '0A' ? '\n' : code === '0D' ? '\r' : '"');

function parseMultipart(data: Uint8Array, boundary: Uint8Array, form: FormData): void {
    const delimiter = new Uint8Array(boundary.length + 2);
    delimiter.fill(0x2d, 0, 2);
    delimiter.set(boundary, 2);
    let current = findDelimiter(data, delimiter, 0, true);
    if (!current) throw formError('multipart boundary not found');
    const headerEnd = new Uint8Array([13, 10, 13, 10]);
    while (!current.final) {
        const partStart = current.next;
        const following = findDelimiter(data, delimiter, partStart, false);
        if (!following) throw formError('multipart body is not terminated');
        const part = data.subarray(partStart, following.bodyEnd);
        const split = indexOfBytes(part, headerEnd, 0);
        if (split === -1) throw formError('multipart part has no header block');
        let disposition: ReturnType<typeof parseHeaderParams> | undefined;
        let contentType = 'text/plain';
        for (const line of engine.decodeString(part.subarray(0, split)).split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon === -1) throw formError('malformed multipart header');
            const header = line.slice(0, colon).trim().toLowerCase();
            const headerValue = line.slice(colon + 1).trim();
            if (header === 'content-disposition' && !disposition) disposition = parseHeaderParams(headerValue);
            else if (header === 'content-type') contentType = headerValue;
        }
        if (!disposition || disposition.type !== 'form-data' || !disposition.params.has('name')) {
            throw formError('multipart part requires Content-Disposition: form-data with a name');
        }
        const name = unescapeFormName(disposition.params.get('name')!);
        const body = part.subarray(split + headerEnd.length);
        const filename = disposition.params.get('filename');
        if (filename === undefined) {
            form.append(name, engine.decodeString(body));
        } else {
            form.append(name, new Blob([body.slice()], { type: contentType }), unescapeFormName(filename));
        }
        current = following;
    }
}

/**
 * Consumes a stream into the current realm's FormData. Without a boundary the
 * bytes are parsed as application/x-www-form-urlencoded; with one (excluding the
 * leading dashes) they are parsed as multipart/form-data.
 */
export async function readableStreamToFormData(
    stream: ReadableStream<string | ArrayBufferView>,
    multipartBoundaryExcludingDashes?: FormBoundary,
): Promise<FormData> {
    if (typeof FormData !== 'function') throw new TypeError('FormData is not available');
    const boundary = multipartBoundaryExcludingDashes == null ? undefined : boundaryBytes(multipartBoundaryExcludingDashes);
    const data = new Uint8Array(await readableStreamToArrayBuffer(stream));
    const form = new FormData();
    if (boundary) parseMultipart(data, boundary, form);
    else parseUrlEncoded(data, form);
    return form;
}
