import { Headers } from "headers-polyfill";
import { type NetworkCallFrame } from "../../utils/network-hooks";
import { BOUNDARY_RE, CHARSET_RE, Decoder, ensureFormDataContentType, engine, headersToArray, isNullBodyStatus, isReadableStreamLike, mergeChunks, parseMultipart, parseUrlEncoded, serializeBody, serializeFormData } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

const responseInitiatorCallFramesSymbol = Symbol.for('cno.response.initiatorCallFrames');
export function setResponseInitiatorCallFrames(
    response: globalThis.Response,
    callFrames: NetworkCallFrame[] | undefined,
): void {
    if (!callFrames || callFrames.length === 0) return;
    Reflect.set(response as object, responseInitiatorCallFramesSymbol, callFrames);
}

export function getResponseInitiatorCallFrames(
    response: globalThis.Response | null | undefined,
): NetworkCallFrame[] | undefined {
    if (!response) return undefined;
    return Reflect.get(response as object, responseInitiatorCallFramesSymbol) as NetworkCallFrame[] | undefined;
}

export class Response implements globalThis.Response {
    public readonly type: ResponseType; public readonly url: string; public readonly redirected: boolean;
    public readonly status: number; public readonly ok: boolean; public readonly statusText: string;
    public readonly headers: Headers; public readonly body: ReadableStream<Uint8Array> | null;
    public bodyUsed: boolean = false;
    private _bodyBuffer: Uint8Array | null = null;

    constructor(body?: any, init?: any) {
        const status = init?.status ?? 200;
        if ((status < 200 && status !== 101) || status > 599) throw new RangeError(`Invalid response status: ${status}`);
        if (body !== undefined && body !== null && isNullBodyStatus(status)) {
            throw new TypeError(`Response with status ${status} cannot have body`);
        }
        this.status = status; this.statusText = init?.statusText || '';
        this.ok = this.status >= 200 && this.status < 300; this.type = 'default'; this.url = ''; this.redirected = false;
        if (init?.headers) {
            this.headers = new Headers();
            const entries = init.headers instanceof Headers
                ? headersToArray(init.headers)
                : (Reflect.getPrototypeOf(init.headers) === Object.prototype ? Object.entries(init.headers) : init.headers);
            for (const [k, v] of entries as any) this.headers.set(k, v);
        } else {
            this.headers = new Headers();
        }
        const formDataBoundary = body instanceof FormData ? ensureFormDataContentType(this.headers) : undefined;
        this.body = (body !== undefined && body !== null) ? this.createBodyStream(body, formDataBoundary) : null;
    }

    private createBodyStream(bodyInit: any, formDataBoundary?: string): ReadableStream<Uint8Array> {
        if (isReadableStreamLike(bodyInit)) return bodyInit as ReadableStream<Uint8Array>;
        const data = serializeBody(bodyInit);
        if (data !== null) { if (!this.headers.has('content-length')) this.headers.set('content-length', String(data.length)); const cap = data; return new ReadableStream({ start(c: any) { c.enqueue(cap); c.close(); } }); }
        if (bodyInit instanceof Blob) return new ReadableStream({ start: async (c: any) => { const r = new Uint8Array(await bodyInit.arrayBuffer()); if (!this.headers.has('content-length')) this.headers.set('content-length', String(r.length)); c.enqueue(r); c.close(); } });
        if (bodyInit instanceof FormData) return new ReadableStream({ start: async (c: any) => { const r = await serializeFormData(bodyInit, formDataBoundary); if (!this.headers.has('content-length')) this.headers.set('content-length', String(r.length)); c.enqueue(r); c.close(); } });
        return new ReadableStream({ start: async (c: any) => { const r = engine.encodeString(JSON.stringify(bodyInit)) as Uint8Array; if (!this.headers.has('content-length')) this.headers.set('content-length', String(r.length)); c.enqueue(r); c.close(); } });
    }

    clone(): Response {
        if (this.bodyUsed) throw new TypeError('Already read');
        let clonedBody: any = this._bodyBuffer;
        if (clonedBody === null && this.body) { const [s1, s2] = this.body.tee(); Object.defineProperty(this, 'body', { value: s1, writable: false, configurable: true }); clonedBody = s2; }
        const r = new Response(clonedBody, { status: this.status, statusText: this.statusText, headers: this.headers });
        Object.defineProperty(r, 'type', { value: this.type });
        Object.defineProperty(r, 'url', { value: this.url });
        Object.defineProperty(r, 'redirected', { value: this.redirected });
        Object.defineProperty(r, 'ok', { value: this.ok });
        setResponseInitiatorCallFrames(r, getResponseInitiatorCallFrames(this));
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
    async formData(): Promise<FormData> {
        const buf = await this.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const ct = this.headers.get('content-type') ?? '';
        if (ct.includes('multipart/form-data')) {
            const m = BOUNDARY_RE.exec(ct);
            if (!m) throw new TypeError('Missing multipart boundary');
            return parseMultipart(bytes, m[1]!);
        }
        if (ct.includes('application/x-www-form-urlencoded')) return parseUrlEncoded(bytes);
        throw new TypeError(`Unsupported content type for formData(): ${ct}`);
    }
    async json<T = any>(): Promise<T> { return JSON.parse(await this.text()); }
    async text(): Promise<string> {
        const buf = await this.arrayBuffer();
        const ct = this.headers.get('content-type') ?? '';
        const m = CHARSET_RE.exec(ct);
        return new Decoder(m?.[1]).decode(buf);
    }
    static error(): Response { const r = new Response(null); Object.defineProperty(r, 'status', { value: 0 }); Object.defineProperty(r, 'ok', { value: false }); Object.defineProperty(r, 'type', { value: 'error' }); return r; }
    static redirect(url: string, status: number = 302): Response { if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status'); const r = new Response(null, { status, headers: { Location: url } }); Object.defineProperty(r, 'type', { value: 'default' }); return r; }
    static json(data: any, init?: any): Response { const body = JSON.stringify(data); const headers = new Headers(init?.headers); if (!headers.has('content-type')) headers.set('content-type', 'application/json'); return new Response(body, { ...init, headers }); }
}
