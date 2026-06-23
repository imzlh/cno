import { Headers } from "headers-polyfill";
import { type NetworkCallFrame } from "../../utils/network-hooks";
import { BOUNDARY_RE, Decoder, ensureFormDataContentType, engine, isReadableStreamLike, mergeChunks, parseMultipart, parseUrlEncoded, serializeBody, serializeFormData } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export class Request implements globalThis.Request {
    public readonly url: string;
    public readonly method: string;
    public readonly headers: Headers;
    public readonly body: ReadableStream | null;
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
    private _bodySource: any = null;
    private _bodyBuffer: Uint8Array | null = null;
    private _initiatorCallFrames?: NetworkCallFrame[];
    private _formDataBoundary?: string;

    constructor(input: URL | string | Request, init?: RequestInit) {
        if (input instanceof URL) {
            this.url = input.href;
            this.method = init?.method?.toUpperCase() || 'GET';
            this.headers = new Headers(init?.headers);
        } else if (typeof input === 'string') {
            this.url = input;
            this.method = init?.method?.toUpperCase() || 'GET';
            this.headers = new Headers(init?.headers);
        } else if (input instanceof Request) {
            this.url = input.url;
            this.method = init?.method?.toUpperCase() || input.method;
            // init.headers fully replaces input.headers per spec
            this.headers = init?.headers !== undefined ? new Headers(init.headers) : new Headers(input.headers);
            if (!init?.body && input.body && !input.bodyUsed) {
                this._bodySource = input._bodySource;
                this._bodyBuffer = input._bodyBuffer;
            }
        } else throw new TypeError('Invalid input:' + input);
        if (init?.body !== undefined && init?.body !== null) this._bodySource = init.body;
        const base = input instanceof Request ? input : undefined;
        this.cache = init?.cache || base?.cache || 'default'; this.credentials = init?.credentials || base?.credentials || 'same-origin';
        this.destination = '' as RequestDestination; this.integrity = init?.integrity || base?.integrity || '';
        this.keepalive = init?.keepalive ?? base?.keepalive ?? false; this.mode = init?.mode || base?.mode || 'cors';
        this.redirect = init?.redirect || base?.redirect || 'follow'; this.referrer = init?.referrer || base?.referrer || 'about:client';
        this.referrerPolicy = init?.referrerPolicy || base?.referrerPolicy || ''; this.signal = init?.signal ?? base?.signal ?? new AbortController().signal;
        if (this._bodyBuffer == null) {
            const directBody = serializeBody(this._bodySource);
            if (directBody !== null) this._bodyBuffer = directBody;
        }
        if (this._bodySource instanceof FormData) {
            this._formDataBoundary = ensureFormDataContentType(this.headers);
        }
        this.body = this._bodySource ? this.createBodyStream() : null;
        if (['GET', 'HEAD'].includes(this.method) && this.body) throw new TypeError(`Request with ${this.method} method cannot have body`);
    }

    private createBodyStream(): ReadableStream<Uint8Array> {
        const s = this._bodySource;
        if (isReadableStreamLike(s)) return s as ReadableStream<Uint8Array>;
        const data = this._bodyBuffer ?? serializeBody(s);
        if (data !== null) { const cap = data; return new ReadableStream({ start(c: any) { c.enqueue(cap); c.close(); } }); }
        if (s instanceof Blob) return new ReadableStream({ pull: async (c: any) => { c.enqueue(new Uint8Array(await s.arrayBuffer())); c.close(); } });
        if (s instanceof FormData) return new ReadableStream({ start: async (c: any) => { const buf = await serializeFormData(s, this._formDataBoundary); c.enqueue(buf); c.close(); } });
        return new ReadableStream({ start(c: any) { c.close(); } });
    }

    clone(): Request {
        if (this.bodyUsed) throw new TypeError('Already read');
        const cloned = new Request(this.url, { method: this.method, headers: this.headers, body: this._bodySource, cache: this.cache, credentials: this.credentials, integrity: this.integrity, keepalive: this.keepalive, mode: this.mode, redirect: this.redirect, referrer: this.referrer, referrerPolicy: this.referrerPolicy, signal: this.signal });
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
        try { while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); } }
        finally { reader.releaseLock(); }
        this._bodyBuffer = mergeChunks(chunks);
        return this._bodyBuffer;
    }

    async arrayBuffer(): Promise<ArrayBuffer> { const b = await this.getBodyBuffer(); if (!b) return new ArrayBuffer(0); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    async bytes(): Promise<Uint8Array> { const b = await this.getBodyBuffer(); if (!b) return new Uint8Array(0); return b; }
    async blob(): Promise<Blob> { return new Blob([await this.arrayBuffer()], { type: this.headers.get('content-type') || 'application/octet-stream' }); }
    async formData(): Promise<FormData> {
        if (this._bodySource instanceof FormData) return this._bodySource;
        const buf = await this.getBodyBuffer();
        if (!buf) throw new TypeError('Request body is empty');
        const ct = this.headers.get('content-type') ?? '';
        if (ct.includes('multipart/form-data')) {
            const m = BOUNDARY_RE.exec(ct);
            if (!m) throw new TypeError('Missing multipart boundary');
            return parseMultipart(buf, m[1]!);
        }
        if (ct.includes('application/x-www-form-urlencoded')) return parseUrlEncoded(buf);
        throw new TypeError(`Unsupported content type for formData(): ${ct}`);
    }
    async text(): Promise<string> { return new Decoder().decode(new Uint8Array(await this.arrayBuffer())); }
    async json<T = any>(): Promise<T> { return JSON.parse(await this.text()); }
}
