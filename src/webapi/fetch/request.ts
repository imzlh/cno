import { Headers } from "../headers";
import { type NetworkCallFrame } from "../../utils/network-hooks";
import { bytesToArrayBuffer } from "../../utils/bytes";
import { BOUNDARY_RE, Decoder, ensureFormDataContentType, isBodyIterable, isReadableStreamLike, iterableBodyToStream, markRequestBodyUsed, mergeChunks, parseMultipart, parseUrlEncoded, rememberRawGetReader, serializeBody, serializeFormData, teeUntracked } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type RequestBodySource = BodyInit | ReadableStream<Uint8Array> | Uint8Array | null;

const METHOD_SEPARATORS = '()<>@,;:\\"/[]?={}';
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);

function isMethodTokenCode(code: number): boolean {
    return code > 0x20 && code < 0x7f && METHOD_SEPARATORS.indexOf(String.fromCharCode(code)) === -1;
}

function normalizeRequestMethod(value: unknown): string {
    const method = String(value);
    if (method.length === 0) throw new TypeError(`'${method}' is not a valid HTTP method`);
    for (let i = 0; i < method.length; i++) {
        if (!isMethodTokenCode(method.charCodeAt(i))) {
            throw new TypeError(`'${method}' is not a valid HTTP method`);
        }
    }

    const upper = method.toUpperCase();
    if (FORBIDDEN_METHODS.has(upper)) throw new TypeError(`'${method}' HTTP method is unsupported.`);
    return NORMALIZED_METHODS.has(upper) ? upper : method;
}

function requestInitMethod(init: RequestInit | undefined, fallback: string): string {
    return init && 'method' in init && init.method !== undefined
        ? normalizeRequestMethod(init.method)
        : fallback;
}

function bodyContentType(body: unknown): string | undefined {
    if (body === null || body === undefined) return undefined;
    if (body instanceof URLSearchParams) return 'application/x-www-form-urlencoded;charset=UTF-8';
    if (body instanceof Blob) return body.type || undefined;
    if (body instanceof FormData || isReadableStreamLike(body) || isBodyIterable(body)) return undefined;
    if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return undefined;
    return 'text/plain;charset=UTF-8';
}

function followSignal(source: AbortSignal | null | undefined): AbortSignal {
    const controller = new AbortController();
    if (!source) return controller.signal;
    if (source.aborted) {
        controller.abort(source.reason);
    } else {
        source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
    }
    return controller.signal;
}

/**
 * Spec: the Request constructor parses `input` as a URL and throws on failure.
 * The URL polyfill deliberately maps bare paths (`/foo`, `C:/x`) to `file:` for
 * path-to-URL conversion, so the scheme is required explicitly here.
 */
function parseRequestUrl(value: string): string {
    if (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) throw new TypeError(`Failed to parse URL from ${value}`);
    try {
        return new URL(value).href;
    } catch {
        throw new TypeError(`Failed to parse URL from ${value}`);
    }
}

export class Request implements globalThis.Request {
    #url!: string;
    #method!: string;
    #headers!: Headers;
    #body: ReadableStream<Uint8Array> | null = null;
    #bodyUsed = false;
    #cache!: RequestCache;
    #credentials!: RequestCredentials;
    #integrity!: string;
    #keepalive!: boolean;
    #mode!: RequestMode;
    #redirect!: RequestRedirect;
    #referrer!: string;
    #referrerPolicy!: ReferrerPolicy;
    #signal!: AbortSignal;
    #bodySource: RequestBodySource = null;
    #bodyBuffer: Uint8Array | null = null;
    #initiatorCallFrames?: NetworkCallFrame[];
    #formDataBoundary?: string;

    get url(): string { return this.#url; }
    get method(): string { return this.#method; }
    get headers(): Headers { return this.#headers; }
    get body(): ReadableStream<Uint8Array> | null { return this.#body; }
    get bodyUsed(): boolean { return this.#bodyUsed; }
    get cache(): RequestCache { return this.#cache; }
    get credentials(): RequestCredentials { return this.#credentials; }
    get destination(): RequestDestination { return '' as RequestDestination; }
    get integrity(): string { return this.#integrity; }
    get keepalive(): boolean { return this.#keepalive; }
    get mode(): RequestMode { return this.#mode; }
    get redirect(): RequestRedirect { return this.#redirect; }
    get referrer(): string { return this.#referrer; }
    get referrerPolicy(): ReferrerPolicy { return this.#referrerPolicy; }
    get signal(): AbortSignal { return this.#signal; }
    get isHistoryNavigation(): boolean { return false; }
    get isReloadNavigation(): boolean { return false; }
    get duplex(): 'half' { return 'half'; }

    constructor(input: URL | string | Request, init?: RequestInit) {
        if (input instanceof URL) {
            this.#url = input.href;
            this.#method = requestInitMethod(init, 'GET');
            this.#headers = new Headers(init?.headers);
        } else if (typeof input === 'string') {
            this.#url = parseRequestUrl(input);
            this.#method = requestInitMethod(init, 'GET');
            this.#headers = new Headers(init?.headers);
        } else if (input instanceof Request) {
            this.#url = input.url;
            this.#method = requestInitMethod(init, input.method);
            // init.headers fully replaces input.headers per spec
            this.#headers = init?.headers !== undefined ? new Headers(init.headers) : new Headers(input.headers);
            if ((init?.body === undefined || init?.body === null) && input.body && !input.bodyUsed) {
                if (input.#bodyBuffer !== null) {
                    this.#bodyBuffer = input.#bodyBuffer;
                    this.#bodySource = input.#bodyBuffer;
                } else {
                    const [original, clone] = input.body.tee();
                    const trackedOriginal = input.trackBodyStream(original);
                    input.#body = trackedOriginal;
                    input.#bodySource = trackedOriginal;
                    this.#bodySource = clone;
                }
            } else if ((init?.body === undefined || init?.body === null) && input.bodyUsed) {
                throw new TypeError('Cannot construct a Request with a Request object that has already been used.');
            }
        } else {
            this.#url = parseRequestUrl(String(input));
            this.#method = requestInitMethod(init, 'GET');
            this.#headers = new Headers(init?.headers);
        }
        if (init?.body !== undefined && init?.body !== null) this.#bodySource = init.body;
        const explicitDuplex = (init as (RequestInit & { duplex?: unknown }) | undefined)?.duplex;
        if (explicitDuplex !== undefined && explicitDuplex !== 'half') {
            throw new TypeError(`${String(explicitDuplex)} is not an accepted duplex value; expected "half"`);
        }
        if ((isReadableStreamLike(init?.body) || isBodyIterable(init?.body)) && explicitDuplex !== 'half') {
            throw new TypeError('RequestInit: duplex option is required when sending a body.');
        }
        const base = input instanceof Request ? input : undefined;
        this.#cache = init?.cache || base?.cache || 'default';
        this.#credentials = init?.credentials || base?.credentials || 'same-origin';
        this.#integrity = init?.integrity || base?.integrity || '';
        this.#keepalive = init?.keepalive ?? base?.keepalive ?? false;
        this.#mode = init?.mode || base?.mode || 'cors';
        this.#redirect = init?.redirect || base?.redirect || 'follow';
        this.#referrer = init?.referrer || base?.referrer || 'about:client';
        this.#referrerPolicy = init?.referrerPolicy || base?.referrerPolicy || '';
        this.#signal = followSignal(init?.signal ?? base?.signal);
        const inferredType = bodyContentType(this.#bodySource);
        if (inferredType && !this.#headers.has('content-type')) this.#headers.set('content-type', inferredType);
        if (this.#bodyBuffer == null) {
            const directBody = serializeBody(this.#bodySource);
            if (directBody !== null) this.#bodyBuffer = directBody;
        }
        if (this.#bodySource instanceof FormData) {
            this.#formDataBoundary = ensureFormDataContentType(this.#headers);
        }
        this.#body = this.#bodySource !== null ? this.trackBodyStream(this.createBodyStream()) : null;
        if (['GET', 'HEAD'].includes(this.#method) && this.#body) throw new TypeError(`Request with ${this.#method} method cannot have body`);
    }

    private createBodyStream(): ReadableStream<Uint8Array> {
        const s = this.#bodySource;
        if (isReadableStreamLike(s)) return s;
        const data = this.#bodyBuffer ?? serializeBody(s);
        if (data !== null) {
            const cap = data;
            return new ReadableStream({
                start(c: ReadableStreamDefaultController<Uint8Array>) {
                    c.enqueue(cap);
                    c.close();
                },
            });
        }
        if (s instanceof Blob) {
            return new ReadableStream({
                pull: async (c: ReadableStreamDefaultController<Uint8Array>) => {
                    c.enqueue(new Uint8Array(await s.arrayBuffer()));
                    c.close();
                },
            });
        }
        if (s instanceof FormData) {
            return new ReadableStream({
                start: async (c: ReadableStreamDefaultController<Uint8Array>) => {
                    const buf = await serializeFormData(s, this.#formDataBoundary);
                    c.enqueue(buf);
                    c.close();
                },
            });
        }
        if (isBodyIterable(s)) return iterableBodyToStream(s);
        return new ReadableStream({
            start(c: ReadableStreamDefaultController<Uint8Array>) {
                c.close();
            },
        });
    }

    private trackBodyStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
        const markUsed = () => { this.#bodyUsed = true; };
        const getReader = stream.getReader.bind(stream);
        // Keep the unpatched method for clone(): tee() acquires its source reader
        // through this public property, so without this the clone's pulls would run
        // THIS request's markUsed. See rememberRawGetReader in ./helpers.
        rememberRawGetReader(stream, getReader);
        stream.getReader = ((options?: ReadableStreamGetReaderOptions) => {
            const reader = getReader(options) as ReadableStreamDefaultReader<Uint8Array>;
            const read = reader.read.bind(reader);
            const cancel = reader.cancel.bind(reader);
            reader.read = () => {
                markUsed();
                return read();
            };
            reader.cancel = (reason?: unknown) => {
                markUsed();
                return cancel(reason);
            };
            return reader;
        }) as typeof stream.getReader;
        const cancel = stream.cancel.bind(stream);
        stream.cancel = (reason?: unknown) => {
            markUsed();
            return cancel(reason);
        };
        return stream;
    }

    clone(): Request {
        if (this.#bodyUsed) throw new TypeError('Already read');
        let clonedBody: RequestBodySource = this.#bodyBuffer ?? this.#bodySource;
        if (this.#body && !this.#bodyBuffer) {
            // teeUntracked, not this.body.tee() -- see the matching comment in
            // Response.clone(). A serialisable body is buffered at construction and
            // never reaches here, which is why this defect was invisible for
            // strings and only showed on a ReadableStream body.
            const [original, clone] = teeUntracked(this.#body);
            const trackedOriginal = this.trackBodyStream(original);
            this.#body = trackedOriginal;
            this.#bodySource = trackedOriginal;
            clonedBody = clone;
        }
        const cloned = new Request(this.url, {
            method: this.method,
            headers: this.headers,
            body: clonedBody,
            cache: this.cache,
            credentials: this.credentials,
            integrity: this.integrity,
            keepalive: this.keepalive,
            mode: this.mode,
            redirect: this.redirect,
            referrer: this.referrer,
            referrerPolicy: this.referrerPolicy,
            signal: this.signal,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        cloned.#initiatorCallFrames = this.#initiatorCallFrames;
        return cloned;
    }

    setInitiatorCallFrames(callFrames: NetworkCallFrame[] | undefined): void {
        this.#initiatorCallFrames = callFrames;
    }

    getInitiatorCallFrames(): NetworkCallFrame[] | undefined {
        return this.#initiatorCallFrames;
    }

    getBufferedBody(): Uint8Array | null {
        return this.#bodyBuffer;
    }

    async getBodyBuffer(): Promise<Uint8Array | null> {
        if (this.#bodyUsed) throw new TypeError('Already read');
        this.#bodyUsed = true;
        if (this.#bodyBuffer) return this.#bodyBuffer;
        if (!this.#body) return null;
        const chunks: Uint8Array[] = [];
        const reader = this.#body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!(value instanceof Uint8Array)) throw new TypeError('Request body stream chunks must be Uint8Array values');
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }
        this.#bodyBuffer = mergeChunks(chunks);
        return this.#bodyBuffer;
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const b = await this.getBodyBuffer();
        if (!b) return new ArrayBuffer(0);
        return bytesToArrayBuffer(b);
    }

    async bytes(): Promise<Uint8Array> {
        const b = await this.getBodyBuffer();
        if (!b) return new Uint8Array(0);
        return b;
    }
    async blob(): Promise<Blob> { return new Blob([await this.arrayBuffer()], { type: this.headers.get('content-type') || '' }); }
    async formData(): Promise<FormData> {
        if (this.#bodySource instanceof FormData) {
            if (this.#bodyUsed) throw new TypeError('Already read');
            this.#bodyUsed = true;
            return this.#bodySource;
        }
        const buf = await this.getBodyBuffer();
        if (!buf) throw new TypeError('Request body is empty');
        const ct = this.headers.get('content-type') ?? '';
        if (ct.includes('multipart/form-data')) {
            const m = BOUNDARY_RE.exec(ct);
            const boundary = m?.[1];
            if (!boundary) throw new TypeError('Missing multipart boundary');
            return parseMultipart(buf, boundary);
        }
        if (ct.includes('application/x-www-form-urlencoded')) return parseUrlEncoded(buf);
        throw new TypeError(`Unsupported content type for formData(): ${ct}`);
    }
    async text(): Promise<string> { return new Decoder().decode(new Uint8Array(await this.arrayBuffer())); }
    async json<T = unknown>(): Promise<T> { return JSON.parse(await this.text()); }

    /** Consuming an already-buffered upload still disturbs the Request even
     * though fetch does not need to read its public stream. */
    [markRequestBodyUsed](): void { this.#bodyUsed = true; }

    get [Symbol.toStringTag](): string { return 'Request'; }
}
