/**
 * CNO secondary wrapping layer 鈥?Web API fetch/Request/Response.
 *
 * Maps WebAPI fetch/Request/Response onto @cnojs/http's curl-backed client.
 */

import { Headers } from "headers-polyfill";
import { fetchSync as httpFetchSync } from "@cnojs/http/client";
const engine = import.meta.use('engine');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export type ProgressCallback = (now: number, total: number) => void;

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

/* ================================================================== */
/* Request / Response (Web API)                                       */
/* ================================================================== */

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
        if (input instanceof URL) { this.url = input.href; this.method = init?.method?.toUpperCase() || 'GET'; this.headers = new Headers(init?.headers); }
        else if (typeof input === 'string') { this.url = input; this.method = init?.method?.toUpperCase() || 'GET'; this.headers = new Headers(init?.headers); }
        else if (input instanceof Request) { this.url = input.url; this.method = init?.method?.toUpperCase() || input.method; this.headers = new Headers(init?.headers || input.headers); if (!init?.body && input.body && !input.bodyUsed) { this._bodySource = input._bodySource; this._bodyBuffer = input._bodyBuffer; } }
        else throw new TypeError('Invalid input:' + input);
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
        let data: Uint8Array | null = null;
        if (typeof s === 'string') data = engine.encodeString(s);
        else if (s instanceof Uint8Array) data = s as Uint8Array;
        else if (s instanceof ArrayBuffer) data = new Uint8Array(s);
        else if (s instanceof URLSearchParams) data = engine.encodeString(s.toString());
        else if (s instanceof Blob) return new ReadableStream({ pull: async (c: any) => { c.enqueue(new Uint8Array(await s.arrayBuffer())); c.close(); } });
        else if (s instanceof FormData) throw new Error('FormData not yet implemented');
        else data = engine.encodeString(JSON.stringify(s));
        if (data !== null) { const cap = data; return new ReadableStream({ start(c: any) { c.enqueue(cap); c.close(); } }); }
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
    formData(): Promise<FormData> { throw new Error('FormData parsing not yet implemented'); }
    async text(): Promise<string> { return engine.decodeString(new Uint8Array(await this.arrayBuffer())); }
    async json<T = any>(): Promise<T> { return JSON.parse(await this.text()); }
}

export class Response implements globalThis.Response {
    public readonly type: ResponseType; public readonly url: string; public readonly redirected: boolean;
    public readonly status: number; public readonly ok: boolean; public readonly statusText: string;
    public readonly headers: Headers; public readonly body: ReadableStream<Uint8Array> | null;
    public bodyUsed: boolean = false;
    private _bodyBuffer: Uint8Array | null = null;

    constructor(body?: any, init?: any) {
        this.status = init?.status || 200; this.statusText = init?.statusText || '';
        this.ok = this.status >= 200 && this.status < 300; this.type = 'default'; this.url = ''; this.redirected = false;
        if (init?.headers) { this.headers = new Headers(); if (Reflect.getPrototypeOf(init.headers) === Object.prototype) init.headers = Object.entries(init.headers); for (const [k, v] of init.headers as any) this.headers.set(k, v); }
        else this.headers = new Headers({ 'user-agent': 'cnojs/http' });
        this.body = (body !== undefined && body !== null) ? this.createBodyStream(body) : null;
    }

    private createBodyStream(bodyInit: any): ReadableStream<Uint8Array> {
        if (bodyInit instanceof ReadableStream) return bodyInit as ReadableStream<Uint8Array>;
        let data: Uint8Array | null = null;
        if (typeof bodyInit === 'string') data = engine.encodeString(bodyInit);
        else if (bodyInit instanceof Uint8Array) data = bodyInit as Uint8Array;
        else if (bodyInit instanceof ArrayBuffer) data = new Uint8Array(bodyInit);
        else if (bodyInit instanceof URLSearchParams) { data = engine.encodeString(bodyInit.toString()); if (!this.headers.has('content-type')) this.headers.set('content-type', 'application/x-www-form-urlencoded'); }
        if (data !== null) { if (!this.headers.has('content-length')) this.headers.set('content-length', String(data.length)); const cap = data; return new ReadableStream({ start(c: any) { c.enqueue(cap); c.close(); } }); }
        return new ReadableStream({ start: async (c: any) => { try { let r: Uint8Array; if (bodyInit instanceof Blob) r = new Uint8Array(await bodyInit.arrayBuffer()); else if (bodyInit instanceof FormData) throw new Error('FormData not yet implemented'); else r = engine.encodeString(JSON.stringify(bodyInit)); if (!this.headers.has('content-length')) this.headers.set('content-length', String(r.length)); c.enqueue(r); c.close(); } catch (e) { c.error(e); } } });
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
    formData(): Promise<FormData> { throw new Error('FormData parsing not yet implemented'); }
    async json<T = any>(): Promise<T> { return JSON.parse(await this.text()); }
    async text(): Promise<string> { return engine.decodeString(new Uint8Array(await this.arrayBuffer())); }

    static error(): Response { const r = new Response(null, { status: 0, statusText: '' }); Object.defineProperty(r, 'type', { value: 'error' }); return r; }
    static redirect(url: string, status: number = 302): Response { if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status'); const r = new Response(null, { status, headers: { Location: url } }); Object.defineProperty(r, 'type', { value: 'default' }); return r; }
    static json(data: any, init?: any): Response { const body = JSON.stringify(data); const headers = new Headers(init?.headers); if (!headers.has('content-type')) headers.set('content-type', 'application/json'); return new Response(body, { ...init, headers }); }
}

/* ================================================================== */
/* Async fetch                                                        */
/* ================================================================== */

function headersToRecord(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value: string, key: string) => { out[key] = value; });
    return out;
}

async function performFetch(request: Request, url: URL): Promise<Response> {
    throwIfAborted(request.signal);
    const body = await request.getBodyBuffer();
    throwIfAborted(request.signal);

    try {
        const result = httpFetchSync(url.href, undefined, {
            method: request.method,
            headers: headersToRecord(request.headers),
            body,
            signal: request.signal,
        });
        throwIfAborted(request.signal);

        const response = new Response(result.body, {
            status: result.status,
            headers: rawHeadersToHeaders(result.headers),
        });
        Object.defineProperty(response, 'url', { value: url.href });
        Object.defineProperty(response, 'redirected', { value: false });
        return response;
    } catch (err) {
        if (request.signal?.aborted) throw abortError(request.signal);
        throw err;
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

Reflect.set(globalThis, 'fetch', fetchAsync);
Reflect.set(globalThis, 'Response', Response);
Reflect.set(globalThis, 'Request', Request);

