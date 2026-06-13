/**
 * CNO fetch + XMLHttpRequest — Web API HTTP client.
 *
 * Uses curl directly. AbortSignal directly cancels the underlying curl request.
 * No intermediate abstraction layer.
 */

import { Headers } from "headers-polyfill";
import { DOMException, EventTarget } from "./events";

const curlMod = import.meta.use("curl") as typeof CModuleCURL;
const engine = import.meta.use("engine");
const { Encoder, Decoder } = import.meta.use("text");

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

let curlPool: CModuleCURL.ConnPool | null = null;

function getCurlPool(): CModuleCURL.ConnPool {
    if (!curlPool) {
        curlPool = new curlMod.ConnPool({
            maxConnections: 64,
            maxConnectionsPerHost: 8,
            pipelining: true,
        });
    }
    return curlPool;
}

export function closeCurlPool(): void {
    const pool = curlPool;
    curlPool = null;
    pool?.close();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function abortError(signal?: AbortSignal): any {
    return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal);
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0]!;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total); let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return merged;
}

function rawHeadersToHeaders(raw: Array<[string, string]>): Headers {
    const h = new Headers();
    for (const [k, v] of raw) h.append(k, v);
    return h;
}

function parseHeaders(raw: string): Array<[string, string]> {
    let current: Array<[string, string]> = [];
    let last: [string, string] | null = null;
    for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        if (/^HTTP\//i.test(line)) { current = []; last = null; continue; }
        if ((line[0] === " " || line[0] === "\t") && last) { last[1] += " " + line.trim(); continue; }
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const header: [string, string] = [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        current.push(header); last = header;
    }
    return current;
}

/**
 * Convert Headers to array of pairs — preserves duplicate headers (e.g. Set-Cookie).
 */
function headersToArray(headers: Headers): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    headers.forEach((value: string, key: string) => { out.push([key, value]); });
    return out;
}

/**
 * Convert array of header pairs to Record for curl.setHeaders().
 * Note: duplicates are merged (last wins) — curl API limitation.
 */
function headersToRecord(headers: Array<[string, string]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of headers) out[k] = v;
    return out;
}

function responseBodyToBytes(body?: string | ArrayBuffer): Uint8Array {
    if (!body) return new Uint8Array(0);
    if (typeof body === "string") return engine.encodeString(body) as Uint8Array;
    return new Uint8Array(body) as Uint8Array;
}

function serializeBody(body: any): Uint8Array | null {
    if (body === null || body === undefined) return null;
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
    if (body instanceof ArrayBuffer) return new Uint8Array(body) as Uint8Array;
    if (typeof body === 'string') return engine.encodeString(body) as Uint8Array;
    if (body instanceof URLSearchParams) return engine.encodeString(body.toString()) as Uint8Array;
    if (body instanceof Blob) return null; // async, handled separately
    if (body instanceof FormData) return null; // async, handled separately
    return engine.encodeString(JSON.stringify(body)) as Uint8Array;
}

// ---------------------------------------------------------------------------
// Request (Web API)
// ---------------------------------------------------------------------------

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

    constructor(input: any, init?: any) {
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
        this.cache = init?.cache || 'default'; this.credentials = init?.credentials || 'same-origin';
        this.destination = '' as RequestDestination; this.integrity = init?.integrity || '';
        this.keepalive = init?.keepalive || false; this.mode = init?.mode || 'cors';
        this.redirect = init?.redirect || 'follow'; this.referrer = init?.referrer || 'about:client';
        this.referrerPolicy = init?.referrerPolicy || ''; this.signal = init?.signal ?? new AbortController().signal;
        this.body = this._bodySource ? this.createBodyStream() : null;
        if (['GET', 'HEAD'].includes(this.method) && this.body) throw new TypeError(`Request with ${this.method} method cannot have body`);
    }

    private createBodyStream(): ReadableStream<Uint8Array> {
        const s = this._bodySource;
        if (s instanceof ReadableStream) return s as ReadableStream<Uint8Array>;
        const data = serializeBody(s);
        if (data !== null) { const cap = data; return new ReadableStream({ start(c: any) { c.enqueue(cap); c.close(); } }); }
        if (s instanceof Blob) return new ReadableStream({ pull: async (c: any) => { c.enqueue(new Uint8Array(await s.arrayBuffer())); c.close(); } });
        if (s instanceof FormData) return new ReadableStream({ start: async (c: any) => { const buf = await serializeFormData(s); c.enqueue(buf); c.close(); } });
        return new ReadableStream({ start(c: any) { c.close(); } });
    }

    clone(): Request {
        if (this.bodyUsed) throw new TypeError('Already read');
        return new Request(this.url, { method: this.method, headers: this.headers, body: this._bodySource, cache: this.cache, credentials: this.credentials, integrity: this.integrity, keepalive: this.keepalive, mode: this.mode, redirect: this.redirect, referrer: this.referrer, referrerPolicy: this.referrerPolicy, signal: this.signal });
    }

    async getBodyBuffer(): Promise<Uint8Array | null> {
        if (this._bodyBuffer) return this._bodyBuffer;
        if (!this.body) return null;
        this.bodyUsed = true;
        const chunks: Uint8Array[] = [];
        const reader = this.body.getReader();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); } }
        finally { reader.releaseLock(); }
        this._bodyBuffer = mergeChunks(chunks);
        return this._bodyBuffer;
    }

    async arrayBuffer(): Promise<ArrayBuffer> { const b = await this.getBodyBuffer(); if (!b) throw new TypeError('Body not available'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    async bytes(): Promise<Uint8Array> { const b = await this.getBodyBuffer(); if (!b) throw new TypeError('Body not available'); return b; }
    async blob(): Promise<Blob> { return new Blob([await this.arrayBuffer()], { type: this.headers.get('content-type') || 'application/octet-stream' }); }
    async formData(): Promise<FormData> { throw new Error('FormData parsing not yet implemented'); }
    async text(): Promise<string> { return engine.decodeString(new Uint8Array(await this.arrayBuffer())); }
    async json<T = any>(): Promise<T> { return JSON.parse(await this.text()); }
}

// ---------------------------------------------------------------------------
// FormData serialization
// ---------------------------------------------------------------------------

async function serializeFormData(fd: FormData): Promise<Uint8Array> {
    const boundary = '----CNOFormBoundary' + Math.random().toString(36).slice(2);
    const parts: Uint8Array[] = [];
    const entries: Array<[string, FormDataEntryValue]> = [];
    fd.forEach((value, key) => { entries.push([key, value]); });
    for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i]!;
        let header = `--${boundary}\r\nContent-Disposition: form-data; name="${key}"`;
        if (value instanceof Blob) {
            const filename = (value as File).name || 'blob';
            header += `; filename="${filename}"\r\nContent-Type: ${value.type || 'application/octet-stream'}`;
        }
        header += '\r\n\r\n';
        parts.push(engine.encodeString(header) as Uint8Array);
        if (value instanceof Blob) {
            parts.push(new Uint8Array(await value.arrayBuffer()));
        } else {
            parts.push(engine.encodeString(value) as Uint8Array);
        }
        parts.push(engine.encodeString('\r\n') as Uint8Array);
    }
    parts.push(engine.encodeString(`--${boundary}--\r\n`) as Uint8Array);
    return mergeChunks(parts);
}


// ---------------------------------------------------------------------------
// Response (Web API)
// ---------------------------------------------------------------------------

export class Response implements globalThis.Response {
    public readonly type: ResponseType; public readonly url: string; public readonly redirected: boolean;
    public readonly status: number; public readonly ok: boolean; public readonly statusText: string;
    public readonly headers: Headers; public readonly body: ReadableStream<Uint8Array> | null;
    public bodyUsed: boolean = false;
    private _bodyBuffer: Uint8Array | null = null;

    constructor(body?: any, init?: any) {
        this.status = init?.status || 200; this.statusText = init?.statusText || '';
        this.ok = this.status >= 200 && this.status < 300; this.type = 'default'; this.url = ''; this.redirected = false;
        if (init?.headers) {
            this.headers = new Headers();
            const entries = init.headers instanceof Headers
                ? headersToArray(init.headers)
                : (Reflect.getPrototypeOf(init.headers) === Object.prototype ? Object.entries(init.headers) : init.headers);
            for (const [k, v] of entries as any) this.headers.set(k, v);
        } else {
            this.headers = new Headers({ 'user-agent': 'cnojs/http' });
        }
        this.body = (body !== undefined && body !== null) ? this.createBodyStream(body) : null;
    }

    private createBodyStream(bodyInit: any): ReadableStream<Uint8Array> {
        if (bodyInit instanceof ReadableStream) return bodyInit as ReadableStream<Uint8Array>;
        const data = serializeBody(bodyInit);
        if (data !== null) { if (!this.headers.has('content-length')) this.headers.set('content-length', String(data.length)); const cap = data; return new ReadableStream({ start(c: any) { c.enqueue(cap); c.close(); } }); }
        if (bodyInit instanceof Blob) return new ReadableStream({ start: async (c: any) => { const r = new Uint8Array(await bodyInit.arrayBuffer()); if (!this.headers.has('content-length')) this.headers.set('content-length', String(r.length)); c.enqueue(r); c.close(); } });
        if (bodyInit instanceof FormData) return new ReadableStream({ start: async (c: any) => { const r = await serializeFormData(bodyInit); if (!this.headers.has('content-length')) this.headers.set('content-length', String(r.length)); c.enqueue(r); c.close(); } });
        return new ReadableStream({ start: async (c: any) => { const r = engine.encodeString(JSON.stringify(bodyInit)) as Uint8Array; if (!this.headers.has('content-length')) this.headers.set('content-length', String(r.length)); c.enqueue(r); c.close(); } });
    }

    clone(): Response {
        if (this.bodyUsed) throw new TypeError('Already read');
        let clonedBody: any = this._bodyBuffer;
        if (clonedBody === null && this.body) { const [s1, s2] = this.body.tee(); Object.defineProperty(this, 'body', { value: s1, writable: false, configurable: true }); clonedBody = s2; }
        const r = new Response(clonedBody, { status: this.status, statusText: this.statusText, headers: this.headers });
        Object.defineProperty(r, 'type', { value: this.type }); Object.defineProperty(r, 'url', { value: this.url }); Object.defineProperty(r, 'redirected', { value: this.redirected });
        return r;
    }

    async bytes(): Promise<Uint8Array> {
        if (this.bodyUsed) throw new TypeError('Already read'); this.bodyUsed = true;
        if (this._bodyBuffer) return this._bodyBuffer; if (!this.body) return new Uint8Array(0);
        const chunks: Uint8Array[] = []; const reader = this.body.getReader();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); } } finally { reader.releaseLock(); }
        this._bodyBuffer = mergeChunks(chunks); return this._bodyBuffer;
    }
    arrayBuffer(): Promise<ArrayBuffer> { return this.bytes().then((b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
    async blob(): Promise<Blob> { return new Blob([await this.arrayBuffer()], { type: this.headers.get('content-type') || 'application/octet-stream' }); }
    async formData(): Promise<FormData> { throw new Error('FormData parsing not yet implemented'); }
    async json<T = any>(): Promise<T> { return JSON.parse(await this.text()); }
    async text(): Promise<string> {
        const buf = await this.arrayBuffer();
        const ct = this.headers.get('content-type') ?? '';
        const m = ct.match(/charset\s*=\s*["']?([^\s;'"]+)/i);
        return new Decoder(m?.[1]).decode(buf);
    }
    static error(): Response { const r = new Response(null, { status: 0, statusText: '' }); Object.defineProperty(r, 'type', { value: 'error' }); return r; }
    static redirect(url: string, status: number = 302): Response { if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status'); const r = new Response(null, { status, headers: { Location: url } }); Object.defineProperty(r, 'type', { value: 'default' }); return r; }
    static json(data: any, init?: any): Response { const body = JSON.stringify(data); const headers = new Headers(init?.headers); if (!headers.has('content-type')) headers.set('content-type', 'application/json'); return new Response(body, { ...init, headers }); }
}

// ---------------------------------------------------------------------------
// fetch() — curl-backed, AbortSignal directly cancels curl
// ---------------------------------------------------------------------------

async function performFetch(request: Request, url: URL): Promise<Response> {
    throwIfAborted(request.signal);
    const body = await request.getBodyBuffer();
    throwIfAborted(request.signal);

    const curl = new curlMod.CURL(getCurlPool());

    curl.setUrl(url.href)
        .setMethod(request.method)
        .setHeaders(headersToRecord(headersToArray(request.headers)));

    // redirect mode
    if (request.redirect === 'error' || request.redirect === 'manual') {
        curl.setFollowRedirects(false);
    } else {
        curl.setFollowRedirects(true);
        curl.setMaxRedirects(20);
    }

    // referrer → Referer header
    if (request.referrer && request.referrer !== 'no-referrer' && request.referrer !== 'about:client') {
        try {
            const refUrl = new URL(request.referrer);
            if (refUrl.protocol === 'http:' || refUrl.protocol === 'https:') {
                curl.setReferer(refUrl.href);
            }
        } catch { /* invalid referrer, skip */ }
    }

    if (body && body.length > 0) {
        curl.setBody(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
    }

    // AbortSignal directly cancels the underlying curl request
    let abortHandler: (() => void) | null = null;
    if (request.signal) {
        abortHandler = () => { try { curl.abort(); } catch {} };
        if (request.signal.aborted) {
            curl.abort();
            throw abortError(request.signal);
        }
        request.signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Resolve as soon as headers arrive; stream body via ReadableStream.
    const headersDone = Promise.withResolvers<{ status: number; headers: string }>();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    curl.onHeadersComplete((status, headers) => {
        headersDone.resolve({ status, headers });
    });

    curl.onData((chunk: ArrayBuffer) => {
        streamController?.enqueue(new Uint8Array(chunk));
        return false; // don't abort
    });

    // perform() runs in background; we await headers independently
    const performPromise = curl.perform().then(
        () => { streamController?.close(); },
        (err: Error) => { streamController?.error(err); }
    );

    try {
        const { status, headers: rawHeaders } = await headersDone.promise;
        throwIfAborted(request.signal);

        const responseHeaders = rawHeadersToHeaders(parseHeaders(rawHeaders));
        const isRedirect = status >= 300 && status < 400;

        if (request.redirect === 'error' && isRedirect) {
            curl.abort();
            throw new TypeError(`Request redirect mode is "error" but received redirect ${status}`);
        }

        const bodyStream = new ReadableStream<Uint8Array>({
            start(controller) { streamController = controller; },
            cancel() { try { curl.abort(); } catch {} }
        });

        const result = new Response(bodyStream, { status, headers: responseHeaders });
        Object.defineProperty(result, 'url', { value: url.href });
        Object.defineProperty(result, 'redirected', { value: isRedirect });
        return result;
    } catch (err) {
        curl.abort();
        // drain so perform() settles and we don't leak the handle
        await performPromise.catch(() => {});
        if (request.signal?.aborted) throw abortError(request.signal);
        throw err;
    } finally {
        if (abortHandler && request.signal) {
            request.signal.removeEventListener('abort', abortHandler);
        }
    }
}

export async function fetchAsync(input: any, init?: any): Promise<Response> {
    if (input instanceof URL) input = input.href;
    const request = new Request(input, init);
    throwIfAborted(request.signal);
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`Unsupported protocol: ${url.protocol}`);
    return performFetch(request, url);
}

// ---------------------------------------------------------------------------
// XMLHttpRequest — XHR polyfill backed by curl
// ---------------------------------------------------------------------------

const XHR_UNSENT = 0;
const XHR_OPENED = 1;
const XHR_HEADERS_RECEIVED = 2;
const XHR_LOADING = 3;
const XHR_DONE = 4;

type XMLHttpRequestResponseType = '' | 'arraybuffer' | 'blob' | 'document' | 'json' | 'text';

export class XMLHttpRequest extends EventTarget {
    static readonly UNSENT = XHR_UNSENT;
    static readonly OPENED = XHR_OPENED;
    static readonly HEADERS_RECEIVED = XHR_HEADERS_RECEIVED;
    static readonly LOADING = XHR_LOADING;
    static readonly DONE = XHR_DONE;

    readonly UNSENT = XHR_UNSENT;
    readonly OPENED = XHR_OPENED;
    readonly HEADERS_RECEIVED = XHR_HEADERS_RECEIVED;
    readonly LOADING = XHR_LOADING;
    readonly DONE = XHR_DONE;

    readyState: number = XHR_UNSENT;
    status: number = 0;
    statusText: string = '';
    responseURL: string = '';
    timeout: number = 0;
    withCredentials: boolean = false;
    responseType: XMLHttpRequestResponseType = '';
    upload: EventTarget = new EventTarget();

    private _url: string = '';
    private _method: string = '';
    private _headers: Array<[string, string]> = [];
    private _responseHeaders: string = '';
    private _response: any = null;
    private _responseText: string = '';
    private _aborted: boolean = false;
    private _curl: CModuleCURL.CURL | null = null;
    private _async: boolean = true;
    private _user: string | null = null;
    private _password: string | null = null;

    onreadystatechange: ((this: XMLHttpRequest, ev: Event) => any) | null = null;
    onload: ((this: XMLHttpRequest, ev: Event) => any) | null = null;
    onerror: ((this: XMLHttpRequest, ev: Event) => any) | null = null;
    onabort: ((this: XMLHttpRequest, ev: Event) => any) | null = null;
    onloadstart: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null;
    onloadend: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null;
    onprogress: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null;
    ontimeout: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null;

    private _emit(type: string): void {
        const evt = new Event(type);
        const handler = (this as any)[`on${type}`];
        if (typeof handler === 'function') handler.call(this, evt);
        this.dispatchEvent(evt);
    }

    private _setState(state: number): void {
        this.readyState = state;
        this._emit('readystatechange');
    }

    open(method: string, url: string, async: boolean = true, user?: string | null, password?: string | null): void {
        this._method = method.toUpperCase();
        this._url = url;
        this._async = async;
        this._user = user ?? null;
        this._password = password ?? null;
        this._aborted = false;
        this._curl = null;
        this._response = null;
        this._responseText = '';
        this._responseHeaders = '';
        this._headers = [];
        this.status = 0;
        this.statusText = '';
        this.readyState = XHR_OPENED;
    }

    setRequestHeader(name: string, value: string): void {
        this._headers.push([name, value]);
    }

    getResponseHeader(name: string): string | null {
        const lower = name.toLowerCase();
        for (const line of this._responseHeaders.split(/\r?\n/)) {
            const colon = line.indexOf(':');
            if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === lower) {
                return line.slice(colon + 1).trim();
            }
        }
        return null;
    }

    getAllResponseHeaders(): string {
        return this._responseHeaders;
    }

    overrideMimeType(_mime: string): void {
        // Not implemented
    }

    abort(): void {
        if (this.readyState === XHR_UNSENT || this.readyState === XHR_DONE) return;
        this._aborted = true;
        if (this._curl) {
            try { this._curl.abort(); } catch {}
        }
        this.readyState = XHR_DONE;
        this._emit('abort');
        this._emit('loadend');
    }

    send(body?: any): void {
        if (this.readyState !== XHR_OPENED) throw new DOMException('InvalidStateError', 'InvalidStateError');
        if (this._aborted) return;

        this._emit('loadstart');

        const curl = new curlMod.CURL(getCurlPool());
        this._curl = curl;

        // Build headers from setRequestHeader calls
        const headers: Array<[string, string]> = [...this._headers];

        // withCredentials: send cookies via Cookie header
        if (this.withCredentials) {
            // Cookies would need a cookie jar; placeholder for now
        }

        // Basic auth from open() user/password
        if (this._user !== null) {
            const auth = engine.encodeString(`${this._user}:${this._password ?? ''}`);
            // Base64 encode
            const b64 = btoa(String.fromCharCode(...auth));
            headers.push(['Authorization', `Basic ${b64}`]);
        }

        curl.setUrl(this._url)
            .setMethod(this._method)
            .setHeaders(headersToRecord(headers))
            .setFollowRedirects(true)
            .setMaxRedirects(20);

        if (this.timeout > 0) {
            curl.setTimeout(this.timeout);
            curl.setConnectTimeout(this.timeout);
        }

        if (body !== undefined && body !== null) {
            const data = serializeBody(body);
            if (data) {
                curl.setBody(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
            }
        }

        this._setState(XHR_HEADERS_RECEIVED);

        if (this._async) {
            curl.perform().then(response => {
                if (this._aborted) return;
                this._handleResponse(response);
            }).catch(() => {
                if (this._aborted) return;
                this.readyState = XHR_DONE;
                this._emit('error');
                this._emit('loadend');
            });
        } else {
            // Synchronous mode
            try {
                const response = curl.performSync();
                if (!this._aborted) {
                    this._handleResponse(response);
                }
            } catch {
                if (!this._aborted) {
                    this.readyState = XHR_DONE;
                    this._emit('error');
                    this._emit('loadend');
                }
            }
        }
    }

    private _handleResponse(response: CModuleCURL.Response): void {
        this.status = response.status;
        this.statusText = '';
        this._responseHeaders = response.headers;
        this.responseURL = this._url;

        const bytes = responseBodyToBytes(response.body);

        switch (this.responseType) {
            case '':
            case 'text':
                this._responseText = engine.decodeString(bytes);
                this._response = this._responseText;
                break;
            case 'json':
                try { this._response = JSON.parse(engine.decodeString(bytes)); }
                catch { this._response = null; }
                break;
            case 'arraybuffer':
                this._response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                break;
            case 'blob':
                this._response = new Blob([bytes]);
                break;
            default:
                this._responseText = engine.decodeString(bytes);
                this._response = this._responseText;
        }

        this._setState(XHR_LOADING);
        this._setState(XHR_DONE);
        this._emit('progress');
        this._emit('load');
        this._emit('loadend');
    }

    get response(): any { return this._response; }
    get responseText(): string { return this._responseText; }
}

// ---------------------------------------------------------------------------
// Register globals
// ---------------------------------------------------------------------------

Reflect.set(globalThis, 'fetch', fetchAsync);
Reflect.set(globalThis, 'Response', Response);
Reflect.set(globalThis, 'Request', Request);
Reflect.set(globalThis, 'XMLHttpRequest', XMLHttpRequest);
