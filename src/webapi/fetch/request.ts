import { Headers } from "../headers";
import { type NetworkCallFrame } from "../../utils/network-hooks";
import { bytesToArrayBuffer } from "../../utils/bytes";
import { BOUNDARY_RE, Decoder, ensureFormDataContentType, isBodyIterable, isReadableStreamLike, iterableBodyToStream, mergeChunks, parseMultipart, parseUrlEncoded, serializeBody, serializeFormData } from "./helpers";

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

export class Request implements globalThis.Request {
    public readonly url: string;
    public readonly method: string;
    public readonly headers: Headers;
    public readonly body: ReadableStream<Uint8Array> | null;
    public bodyUsed: boolean = false;
    public readonly cache: RequestCache;
    public readonly credentials: RequestCredentials;
    public readonly destination: RequestDestination;
    public readonly integrity: string;
    public readonly keepalive: boolean;
    public readonly mode: RequestMode;
    public readonly redirect: RequestRedirect;
    public readonly referrer: string;
    public readonly referrerPolicy: ReferrerPolicy;
    public readonly signal: AbortSignal;
    public readonly isHistoryNavigation = false;
    public readonly isReloadNavigation = false;
    public readonly duplex: 'half' = 'half';
    private _bodySource: RequestBodySource = null;
    private _bodyBuffer: Uint8Array | null = null;
    private _initiatorCallFrames?: NetworkCallFrame[];
    private _formDataBoundary?: string;

    constructor(input: URL | string | Request, init?: RequestInit) {
        if (input instanceof URL) {
            this.url = input.href;
            this.method = requestInitMethod(init, 'GET');
            this.headers = new Headers(init?.headers);
        } else if (typeof input === 'string') {
            this.url = input;
            this.method = requestInitMethod(init, 'GET');
            this.headers = new Headers(init?.headers);
        } else if (input instanceof Request) {
            this.url = input.url;
            this.method = requestInitMethod(init, input.method);
            // init.headers fully replaces input.headers per spec
            this.headers = init?.headers !== undefined ? new Headers(init.headers) : new Headers(input.headers);
            if ((init?.body === undefined || init?.body === null) && input.body && !input.bodyUsed) {
                if (input._bodyBuffer !== null) {
                    this._bodyBuffer = input._bodyBuffer;
                    this._bodySource = input._bodyBuffer;
                } else {
                    const [original, clone] = input.body.tee();
                    const trackedOriginal = input.trackBodyStream(original);
                    Object.defineProperty(input, 'body', { value: trackedOriginal, writable: false, configurable: true });
                    input._bodySource = trackedOriginal;
                    this._bodySource = clone;
                }
            }
        } else {
            this.url = String(input);
            this.method = requestInitMethod(init, 'GET');
            this.headers = new Headers(init?.headers);
        }
        if (init?.body !== undefined && init?.body !== null) this._bodySource = init.body;
        const base = input instanceof Request ? input : undefined;
        this.cache = init?.cache || base?.cache || 'default';
        this.credentials = init?.credentials || base?.credentials || 'same-origin';
        this.destination = '' as RequestDestination;
        this.integrity = init?.integrity || base?.integrity || '';
        this.keepalive = init?.keepalive ?? base?.keepalive ?? false;
        this.mode = init?.mode || base?.mode || 'cors';
        this.redirect = init?.redirect || base?.redirect || 'follow';
        this.referrer = init?.referrer || base?.referrer || 'about:client';
        this.referrerPolicy = init?.referrerPolicy || base?.referrerPolicy || '';
        this.signal = followSignal(init?.signal ?? base?.signal);
        const inferredType = bodyContentType(this._bodySource);
        if (inferredType && !this.headers.has('content-type')) this.headers.set('content-type', inferredType);
        if (this._bodyBuffer == null) {
            const directBody = serializeBody(this._bodySource);
            if (directBody !== null) this._bodyBuffer = directBody;
        }
        if (this._bodySource instanceof FormData) {
            this._formDataBoundary = ensureFormDataContentType(this.headers);
        }
        this.body = this._bodySource !== null ? this.trackBodyStream(this.createBodyStream()) : null;
        if (['GET', 'HEAD'].includes(this.method) && this.body) throw new TypeError(`Request with ${this.method} method cannot have body`);
    }

    private createBodyStream(): ReadableStream<Uint8Array> {
        const s = this._bodySource;
        if (isReadableStreamLike(s)) return s;
        const data = this._bodyBuffer ?? serializeBody(s);
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
                    const buf = await serializeFormData(s, this._formDataBoundary);
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
        const markUsed = () => { this.bodyUsed = true; };
        const getReader = stream.getReader.bind(stream);
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
        if (this.bodyUsed) throw new TypeError('Already read');
        let clonedBody: RequestBodySource = this._bodyBuffer ?? this._bodySource;
        if (this.body && !this._bodyBuffer) {
            const [original, clone] = this.body.tee();
            const trackedOriginal = this.trackBodyStream(original);
            Object.defineProperty(this, 'body', { value: trackedOriginal, writable: false, configurable: true });
            this._bodySource = trackedOriginal;
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
        });
        cloned._initiatorCallFrames = this._initiatorCallFrames;
        return cloned;
    }

    setInitiatorCallFrames(callFrames: NetworkCallFrame[] | undefined): void {
        this._initiatorCallFrames = callFrames;
    }

    getInitiatorCallFrames(): NetworkCallFrame[] | undefined {
        return this._initiatorCallFrames;
    }

    getBufferedBody(): Uint8Array | null {
        return this._bodyBuffer;
    }

    async getBodyBuffer(): Promise<Uint8Array | null> {
        if (this.bodyUsed) throw new TypeError('Already read');
        this.bodyUsed = true;
        if (this._bodyBuffer) return this._bodyBuffer;
        if (!this.body) return null;
        const chunks: Uint8Array[] = [];
        const reader = this.body.getReader();
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
        this._bodyBuffer = mergeChunks(chunks);
        return this._bodyBuffer;
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
        if (this._bodySource instanceof FormData) return this._bodySource;
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
}
