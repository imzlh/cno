/**
 * CNO fetch + XMLHttpRequest — Web API HTTP client.
 *
 * Uses curl directly. AbortSignal directly cancels the underlying curl request.
 * No intermediate abstraction layer.
 */

import { Headers } from "headers-polyfill";
import { DOMException, EventTarget } from "./events";
import { version } from "../../package.json";

import { getFetchHook, getUserAgentOverride, getExtraHTTPHeaders, getFetchInterceptHook, getServeHook, captureUserNetworkCallFrames, type FetchConnectionInfo, type NetworkCallFrame } from '../utils/network-hooks';
import { type HttpClient } from '../deno/07_http';

const curlMod = import.meta.use("curl");
const asyncfs = import.meta.use("asyncfs");
const os = import.meta.use("os");
const engine = import.meta.use("engine");
const { Decoder } = import.meta.use("text");

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

// Shared decoder — safe because decode is stateless call → result.
const sharedDecoder = new Decoder();

// Pre-compiled regexes (avoid recompilation in hot paths).
const HTTP_LINE_RE = /^HTTP\//i;
const TIMEOUT_ERR_RE = /\b(timed?\s*out|timeout)\b/i;
const BOUNDARY_RE = /boundary=([^\s;]+)/i;
const CHARSET_RE = /charset\s*=\s*["']?([^\s;'"]+)/i;

// curl.getInfo() returns C module wrapper objects; structured clone (pipe) cannot
// serialize them — they become [object Object] or fail silently. Coerce every
// value to a JS primitive at the boundary.
function curlNum(curl: CModuleCURL.CURL, flag: number): number | undefined {
    const v = curl.getInfo(flag);
    return v != null ? Number(v) : undefined;
}
function curlStr(curl: CModuleCURL.CURL, flag: number): string | undefined {
    const v = curl.getInfo(flag);
    return v != null ? String(v) : undefined;
}

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

interface CurlDebugTrace {
    requestHeadersText?: string;
    responseHeadersText?: string;
    debugStart?: number;
    headerOutStart?: number;
    dataOutStart?: number;
    headerInStart?: number;
    dataInStart?: number;
}

function attachCurlDebugTrace(curl: CModuleCURL.CURL): CurlDebugTrace {
    const trace: CurlDebugTrace = {};
    curl.onDebug((type, data) => {
        const now = Date.now() / 1000;
        if (trace.debugStart == null) trace.debugStart = now;
        if (type === curlMod.CURLINFO_HEADER_OUT) {
            if (trace.headerOutStart == null) trace.headerOutStart = now;
            // Only decode if request header text is actually needed.
            if (trace.requestHeadersText == null) {
                trace.requestHeadersText = sharedDecoder.decode(new Uint8Array(data));
            }
        } else if (type === curlMod.CURLINFO_HEADER_IN) {
            if (trace.headerInStart == null) trace.headerInStart = now;
            const text = sharedDecoder.decode(new Uint8Array(data));
            trace.responseHeadersText = HTTP_LINE_RE.test(text) ? text : (trace.responseHeadersText ?? '') + text;
        } else if (type === curlMod.CURLINFO_DATA_OUT) {
            if (trace.dataOutStart == null) trace.dataOutStart = now;
        } else if (type === curlMod.CURLINFO_DATA_IN) {
            if (trace.dataInStart == null) trace.dataInStart = now;
        }
    });
    return trace;
}

function buildConnectionInfo(curl: CModuleCURL.CURL, reqStartTime: number, trace?: CurlDebugTrace): FetchConnectionInfo | undefined {
    try {
        const info = curl.getInfo();
        // Force C-wrapper values to JS primitives.
        const httpVersion   = Number(info.httpVersion  ?? 0);
        const totalTime     = Number(info.totalTime    ?? 0);
        const downloadSize  = Number(info.downloadSize ?? 0);

        // curl timing values are durations (seconds from request start).
        const dnsDur    = curlNum(curl, curlMod.CURLINFO_NAMELOOKUP_TIME);
        const connDur   = curlNum(curl, curlMod.CURLINFO_CONNECT_TIME);
        const sslDur    = curlNum(curl, curlMod.CURLINFO_APPCONNECT_TIME);
        const sendDur   = curlNum(curl, curlMod.CURLINFO_PRETRANSFER_TIME);
        const ttfbDur   = curlNum(curl, curlMod.CURLINFO_STARTTRANSFER_TIME);
        const totalDur  = curlNum(curl, curlMod.CURLINFO_TOTAL_TIME);
        const sizeDL    = curlNum(curl, curlMod.CURLINFO_SIZE_DOWNLOAD_T);
        const numConn   = curlNum(curl, curlMod.CURLINFO_NUM_CONNECTS);
        const sslVerify = curlNum(curl, curlMod.CURLINFO_SSL_VERIFYRESULT);
        const cType     = curlStr(curl, curlMod.CURLINFO_CONTENT_TYPE);
        const hdrSize   = curlNum(curl, curlMod.CURLINFO_HEADER_SIZE);
        const redirCnt  = curlNum(curl, curlMod.CURLINFO_REDIRECT_COUNT);
        const redirUrl  = curlStr(curl, curlMod.CURLINFO_REDIRECT_URL);
        return {
            remoteIPAddress: curlStr(curl, curlMod.CURLINFO_PRIMARY_IP),
            remotePort:      curlNum(curl, curlMod.CURLINFO_PRIMARY_PORT),
            httpVersion,
            totalTime,
            downloadSize,
            timing: {
                dnsEnd:    dnsDur  != null ? reqStartTime + dnsDur  : undefined,
                connectEnd: connDur != null ? reqStartTime + connDur : undefined,
                sslEnd:    sslDur  != null ? reqStartTime + sslDur  : undefined,
                sendEnd:   sendDur != null ? reqStartTime + sendDur : undefined,
                receiveHeadersStart: ttfbDur != null ? reqStartTime + ttfbDur : undefined,
                dnsDuration:   dnsDur  ?? undefined,
                connectDuration: connDur ?? undefined,
                sslDuration:   sslDur  ?? undefined,
                sendDuration:  sendDur ?? undefined,
                receiveHeadersDuration: ttfbDur ?? undefined,
                totalTime:     totalDur ?? undefined,
                sizeDownload:  sizeDL   ?? undefined,
                numConnects:   numConn  ?? undefined,
                sslVerifyResult: sslVerify ?? undefined,
                contentType:   cType    ?? undefined,
                headerSize:    hdrSize  ?? undefined,
                redirectCount: redirCnt ?? undefined,
                redirectUrl:   redirUrl ?? undefined,
                requestHeadersText: trace?.requestHeadersText,
                responseHeadersText: trace?.responseHeadersText,
                debugStart: trace?.debugStart,
                headerOutStart: trace?.headerOutStart,
                dataOutStart: trace?.dataOutStart,
                headerInStart: trace?.headerInStart,
                dataInStart: trace?.dataInStart,
            },
        };
    } catch { return undefined; }
}

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

function timeoutError(): any {
    return new DOMException('The operation timed out', 'TimeoutError');
}

function compressionAcceptEncoding(headers: Headers): string | undefined {
    const value = headers.get('accept-encoding');
    if (!value) return undefined;
    const trimmed = value.trim();
    // Only honour explicit "identity" (caller wants no compression).
    return trimmed === 'identity' ? 'identity' : undefined;
}

function isCurlTimeoutError(err: any): boolean {
    return err?.code === 28 || TIMEOUT_ERR_RE.test(String(err?.message ?? err));
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

function rawHeadersToHeaders(raw: string): Headers {
    const h = new Headers();
    for (const [k, v] of parseHeaders(raw)) h.append(k, v);
    return h;
}

/**
 * Parse raw HTTP headers into pairs. Single-pass with pre-compiled regex.
 */
function parseHeaders(raw: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    let last: [string, string] | null = null;
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line) continue;
        if (HTTP_LINE_RE.test(line)) { out.length = 0; last = null; continue; }
        const ch = line.charCodeAt(0);
        // continuation line (starts with space or tab)
        if ((ch === 0x20 || ch === 0x09) && last) { last[1] += " " + line.trim(); continue; }
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const header: [string, string] = [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        out.push(header); last = header;
    }
    return out;
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
// KMP byte-pattern search — O(n+m) instead of O(n×m)
// ---------------------------------------------------------------------------

function buildKMPTable(needle: Uint8Array): Int32Array {
    const m = needle.length;
    const table = new Int32Array(m);
    let j = 0;
    for (let i = 1; i < m; i++) {
        while (j > 0 && needle[i] !== needle[j]) j = table[j - 1]!;
        if (needle[i] === needle[j]) j++;
        table[i] = j;
    }
    return table;
}

function kmpSearch(haystack: Uint8Array, needle: Uint8Array, from: number, table: Int32Array): number {
    const n = haystack.length;
    const m = needle.length;
    if (m === 0) return from;
    let j = 0;
    for (let i = from; i < n; i++) {
        while (j > 0 && haystack[i] !== needle[j]) j = table[j - 1]!;
        if (haystack[i] === needle[j]) j++;
        if (j === m) return i - m + 1;
    }
    return -1;
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
    private _initiatorCallFrames?: NetworkCallFrame[];

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
    async text(): Promise<string> { return sharedDecoder.decode(new Uint8Array(await this.arrayBuffer())); }
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

function parseUrlEncoded(body: Uint8Array): FormData {
    const str = engine.decodeString(body);
    const params = new URLSearchParams(str);
    const fd = new FormData();
    for (const [key, value] of params) fd.append(key, value);
    return fd;
}

// Pre-built CRLF2 needle for parseMultipart (avoids per-call allocation).
const CRLF2 = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
const CRLF2_TABLE = buildKMPTable(CRLF2);

function parseMultipart(body: Uint8Array, boundary: string): FormData {
    const fd = new FormData();
    const delimiter = engine.encodeString(`\r\n--${boundary}`) as Uint8Array;
    const firstBnd = engine.encodeString(`--${boundary}`) as Uint8Array;
    const delimTable = buildKMPTable(delimiter);
    const firstTable = buildKMPTable(firstBnd);
    let pos = 0;

    // Find first boundary (may or may not have leading CRLF).
    pos = kmpSearch(body, firstBnd, 0, firstTable);
    if (pos < 0) return fd;
    pos += firstBnd.length;

    while (pos < body.length) {
        // Skip CRLF after boundary.
        if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
        // End boundary check (--).
        if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;

        // Parse part headers until blank line.
        const hdrEnd = kmpSearch(body, CRLF2, pos, CRLF2_TABLE);
        if (hdrEnd < 0) break;
        const hdrStr = engine.decodeString(body.subarray(pos, hdrEnd));
        pos = hdrEnd + 4;

        // Extract name and filename from Content-Disposition.
        const nameMatch = hdrStr.match(/name="([^"]+)"/);
        const filenameMatch = hdrStr.match(/filename="([^"]+)"/);
        const ctMatch = hdrStr.match(/Content-Type:\s*(.+)/i);
        const name = nameMatch?.[1] ?? '';

        // Find next boundary.
        const nextBnd = kmpSearch(body, delimiter, pos, delimTable);
        if (nextBnd < 0) break;
        // Body is everything before the CRLF that precedes the boundary.
        const partBody = body.subarray(pos, nextBnd);
        pos = nextBnd + delimiter.length;

        if (filenameMatch) {
            const ct = ctMatch?.[1]?.trim() || 'application/octet-stream';
            const blob = new Blob([partBody], { type: ct });
            // File polyfill: Blob + name.
            Object.defineProperty(blob, 'name', { value: filenameMatch[1] });
            fd.append(name, blob as any, filenameMatch[1]);
        } else {
            fd.append(name, engine.decodeString(partBody));
        }
    }
    return fd;
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
        if (init?.headers) {
            this.headers = new Headers();
            const entries = init.headers instanceof Headers
                ? headersToArray(init.headers)
                : (Reflect.getPrototypeOf(init.headers) === Object.prototype ? Object.entries(init.headers) : init.headers);
            for (const [k, v] of entries as any) this.headers.set(k, v);
        } else {
            this.headers = new Headers();
        }
        this.body = (body !== undefined && body !== null) ? this.createBodyStream(body) : null;
        if (getServeHook()) {
            setResponseInitiatorCallFrames(this, captureUserNetworkCallFrames());
        }
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
    static error(): Response { const r = new Response(null, { status: 0, statusText: '' }); Object.defineProperty(r, 'type', { value: 'error' }); return r; }
    static redirect(url: string, status: number = 302): Response { if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status'); const r = new Response(null, { status, headers: { Location: url } }); Object.defineProperty(r, 'type', { value: 'default' }); return r; }
    static json(data: any, init?: any): Response { const body = JSON.stringify(data); const headers = new Headers(init?.headers); if (!headers.has('content-type')) headers.set('content-type', 'application/json'); return new Response(body, { ...init, headers }); }
}

// ---------------------------------------------------------------------------
// fetch() — curl-backed, AbortSignal directly cancels curl
// ---------------------------------------------------------------------------

let _fetchIdCounter = 0;
function newRequestId(): string { return `fetch-${++_fetchIdCounter}`; }

/** Write a PEM string to a temp file and return its path. */
async function writeTempPem(name: string, pem: string) {
    const path = `${os.tmpDir}/ca-${name}-${Math.random().toString(36).slice(2, 8)}.pem`;
    const f = await asyncfs.open(path, 'w');
    await f.write(engine.encodeString(pem));
    f.close();
    return path;
}

/** Apply Deno.HttpClient proxy + mTLS settings to a curl handle. Returns temp PEM paths to delete after use. */
async function applyClientToCurl(curl: CModuleCURL.CURL, client: HttpClient): Promise<string[]> {
    const tempFiles: string[] = [];
    const proxyUrl = client.getProxyUrl();
    if (proxyUrl) {
        if (!['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(proxyUrl.protocol))
            throw new Error(`Unsupported proxy protocol: ${proxyUrl.protocol}`);
        curl.setProxy(proxyUrl.href, proxyUrl.protocol as any);
    }
    // mTLS: HttpClient stores PEM strings; curl needs file paths.
    const opts = client.options;
    if (opts.caCerts?.length) {
        const caPem = opts.caCerts.join('\n');
        const p = await writeTempPem('ca', caPem);
        tempFiles.push(p);
        curl.setCABundle(p);
    }
    if (opts.cert) {
        const p = await writeTempPem('cert', opts.cert);
        tempFiles.push(p);
        curl.setOpt(curlMod.CURLOPT_SSLCERT, p);
    }
    if (opts.key) {
        const p = await writeTempPem('key', opts.key);
        tempFiles.push(p);
        curl.setOpt(curlMod.CURLOPT_SSLKEY, p);
    }
    return tempFiles;
}

const CURL_INTERNAL_HEADERS = [
    'accept-encoding',
    'connection',
    'content-length',
    'date',
    'host',
    'pragma',
    'proxy-connection',
]
function filterHeaders(headers: Headers): void {
    for (const name of CURL_INTERNAL_HEADERS) headers.delete(name);
}

async function performFetch(request: Request, url: URL): Promise<Response> {
    throwIfAborted(request.signal);
    const body = await request.getBodyBuffer();
    throwIfAborted(request.signal);

    const curl = new curlMod.CURL(getCurlPool());

    // If a Deno.HttpClient is attached, apply its proxy/SSL config to curl
    // instead of reimplementing HTTP on a raw socket.
    const client = (await import('../deno/07_http')).getRequestClient(request);
    let tempPemFiles: string[] = [];
    if (client) {
        tempPemFiles = await applyClientToCurl(curl, client);
    }
    const netHook = getFetchHook();
    const curlTrace = netHook ? attachCurlDebugTrace(curl) : undefined;
    const interceptHook = getFetchInterceptHook();
    const requestId = (netHook || interceptHook) ? newRequestId() : '';
    const ts = () => Date.now() / 1000;
    const reqCallFrames = netHook ? request.getInitiatorCallFrames() : undefined;

    // Build final headers: request headers + extra CDP headers + UA override
    const finalHeaders = new Headers(request.headers);
    const extraHdrs = getExtraHTTPHeaders();
    for (const [k, v] of Object.entries(extraHdrs))
        finalHeaders.set(k, v);

    const uaOverride = getUserAgentOverride();
    if (uaOverride)
        finalHeaders.set('User-Agent', uaOverride);
    else if (!finalHeaders.has('User-Agent'))
        finalHeaders.set('User-Agent', `cno/${version}`);

    // Read accept-encoding BEFORE filterHeaders strips it.
    const acceptEncoding = compressionAcceptEncoding(finalHeaders);

    // referrer → Referer header (only if not already set by caller)
    if (!finalHeaders.has('Referer') && request.referrer && request.referrer !== 'no-referrer' && request.referrer !== 'about:client') {
        try {
            const refUrl = new URL(request.referrer);
            if (refUrl.protocol === 'http:' || refUrl.protocol === 'https:') {
                finalHeaders.set('Referer', refUrl.href);
            }
        } catch { /* invalid referrer, skip */ }
    }

    // filter headers managed internally by curl
    filterHeaders(finalHeaders);

    // Merge duplicate headers (curl setHeaders only accepts Record<string,string>).
    // HTTP/1.1 §3.2.2: field values with the same name may be combined with ", ".
    // Exception: Cookie uses "; " per RFC 6265 §5.4.
    const objHeaders: Record<string, string> = {};
    for (const [k, v] of finalHeaders.entries()) {
        if (k in objHeaders) {
            objHeaders[k] += (k === 'cookie' ? '; ' : ', ') + v;
        } else {
            objHeaders[k] = v;
        }
    }
    curl.setUrl(url.href)
        .setMethod(request.method)
        .setHeaders(objHeaders);
    curl.setOptByName('AUTOREFERER', 1);  // update Referer to the Location URL on each redirect hop
    curl.setAcceptEncoding(acceptEncoding);

    // redirect mode
    if (request.redirect === 'error' || request.redirect === 'manual') {
        curl.setFollowRedirects(false);
    } else {
        curl.setFollowRedirects(true);
        curl.setMaxRedirects(20);
    }

    if (body && body.length > 0) {
        curl.setBody(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
    }

    // AbortSignal directly cancels the underlying curl request
    let abortHandler: (() => void) | null = null;
    if (request.signal) {
        abortHandler = () => {
            const err = abortError(request.signal);
            headersDone.reject(err);
            errorBody(err);
            try { curl.abort(); } catch {}
        };
        if (request.signal.aborted) {
            curl.abort();
            throw abortError(request.signal);
        }
        request.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const removeAbortHandler = () => {
        if (abortHandler && request.signal) {
            request.signal.removeEventListener('abort', abortHandler);
            abortHandler = null;
        }
    };

    // Resolve as soon as headers arrive; stream body via ReadableStream.
    const headersDone = Promise.withResolvers<{ status: number; headers: string }>();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let bodyCanceled = false;
    let bodyTerminal: { type: 'close' } | { type: 'error'; error: any } | null = null;
    const pendingBodyChunks: Uint8Array[] = [];

    const enqueueBodyChunk = (chunk: Uint8Array): boolean => {
        if (bodyCanceled || bodyTerminal) return true;
        if (!streamController) {
            pendingBodyChunks.push(chunk);
            return false;
        }
        try {
            streamController.enqueue(chunk);
            return false;
        } catch {
            bodyCanceled = true;
            return true;
        }
    };

    const closeBody = () => {
        if (bodyCanceled || bodyTerminal) return;
        if (!streamController) {
            bodyTerminal = { type: 'close' };
            return;
        }
        streamController.close();
        bodyTerminal = { type: 'close' };
    };

    const errorBody = (error: any) => {
        if (bodyCanceled || bodyTerminal) return;
        if (!streamController) {
            bodyTerminal = { type: 'error', error };
            return;
        }
        streamController.error(error);
        bodyTerminal = { type: 'error', error };
    };

    const startBody = (controller: ReadableStreamDefaultController<Uint8Array>) => {
        streamController = controller;
        while (pendingBodyChunks.length > 0) {
            controller.enqueue(pendingBodyChunks.shift()!);
        }
        if (bodyTerminal?.type === 'close') controller.close();
        else if (bodyTerminal?.type === 'error') controller.error(bodyTerminal.error);
    };

    const followingRedirects = request.redirect !== 'error' && request.redirect !== 'manual';
    let didRedirect = false;
    let waitingForFinalHeaders = false; // true between a redirect hop and the final onHeadersComplete

    curl.onHeadersComplete((status, headers) => {
        const isRedirectStatus = status >= 300 && status < 400;

        // When curl follows redirects, onHeadersComplete fires for each hop.
        // Skip intermediate redirect responses entirely — the netHook and
        // headersDone should only see the FINAL response.
        if (isRedirectStatus && followingRedirects) {
            didRedirect = true;
            waitingForFinalHeaders = true;
            // Discard any body chunks accumulated from the redirect response
            // so the body stream and netHook only contain the final response.
            pendingBodyChunks.length = 0;
            return;
        }

        waitingForFinalHeaders = false;

        // Parse headers into object only for the final response.
        if (netHook) {
            const hdrs: Record<string, string> = {};
            for (const [k, v] of parseHeaders(headers)) hdrs[k] = v;
            try {
                netHook.onResponse?.({
                    requestId, url: url.href, status, headers: hdrs,
                    requestHeaders: objHeaders,
                    resourceType: 'Fetch',
                    connection: buildConnectionInfo(curl, reqStartTime, curlTrace), timestamp: ts()
                });
            } catch {}
        }

        headersDone.resolve({ status, headers });
    });

    curl.onData((chunk: ArrayBuffer) => {
        // Skip netHook emission for redirect body data (e.g. 302 HTML page).
        if (!waitingForFinalHeaders && netHook) {
            try { netHook.onData?.({ requestId, data: new Uint8Array(chunk), timestamp: ts() }); } catch {}
        }
        return enqueueBodyChunk(new Uint8Array(chunk));
    });

    // CDP Fetch interception: pause request before sending, let DevTools
    // modify/fulfill/fail it. Must happen after all curl options are configured
    // and after AbortSignal is wired, but before perform().
    if (interceptHook?.onRequest) {
        const result = await interceptHook.onRequest({
            requestId, url: url.href, method: request.method,
            headers: objHeaders, postData: body ?? null, resourceType: 'Fetch',
        });
        if (result) {
            if (result.action === 'fulfill') {
                removeAbortHandler();
                try { curl.abort(); } catch {}
                const resHeaders = new Headers();
                for (const [k, v] of result.responseHeaders) resHeaders.set(k, v);
                return new Response(result.body, { status: result.responseCode, headers: resHeaders });
            }
            if (result.action === 'fail') {
                removeAbortHandler();
                try { curl.abort(); } catch {}
                throw new TypeError(`Request blocked: ${result.reason}`);
            }
            // action === 'continue': apply modifications to the already-configured curl handle
            if (result.url) curl.setUrl(result.url);
            if (result.method) curl.setMethod(result.method);
            if (result.headers) curl.setHeaders(result.headers);
            if (result.postData) curl.setBody(
                result.postData.buffer.slice(result.postData.byteOffset, result.postData.byteOffset + result.postData.byteLength) as ArrayBuffer
            );
        }
    }

    // call hook
    const reqStartTime = Date.now() / 1000;  // absolute start for timing delta calc
    if (netHook) try {
        netHook.onRequest?.({
            requestId, url: url.href, method: request.method,
            headers: objHeaders, postData: body ?? null, callFrames: reqCallFrames, resourceType: 'Fetch', timestamp: reqStartTime
        });
    } catch {}

    // perform() runs in background; we await headers independently
    const performPromise = curl.perform().then(
        () => {
            closeBody();
            if (netHook) {
                const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);
                try { netHook.onFinished?.({ requestId, success: true, connection: conn, timestamp: ts() }); } catch {}
            }
        },
        (err: Error) => {
            const fetchErr = isCurlTimeoutError(err) ? timeoutError() : err;
            headersDone.reject(fetchErr);
            errorBody(fetchErr);
            if (netHook) {
                const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);
                try { netHook.onFinished?.({ requestId, success: false, errorText: fetchErr.message, connection: conn, timestamp: ts() }); } catch {}
            }
        }
    ).finally(() => {
        removeAbortHandler();
        for (const p of tempPemFiles) asyncfs.unlink(p).catch(() => {});
    });

    try {
        const { status, headers: rawHeaders } = await headersDone.promise;
        throwIfAborted(request.signal);

        const responseHeaders = rawHeadersToHeaders(rawHeaders);
        const isRedirect = status >= 300 && status < 400;

        if (request.redirect === 'error' && isRedirect) {
            curl.abort();
            throw new TypeError(`Request redirect mode is "error" but received redirect ${status}`);
        }

        const bodyStream = new ReadableStream<Uint8Array>({
            start: startBody,
            cancel() {
                bodyCanceled = true;
                pendingBodyChunks.length = 0;
                try { curl.abort(); } catch {}
            }
        });

        const result = new Response(bodyStream, { status, headers: responseHeaders });
        let finalUrl = url.href;
        try { finalUrl = curl.getInfo(curlMod.CURLINFO_EFFECTIVE_URL) as string || url.href; } catch {}
        Object.defineProperty(result, 'url', { value: finalUrl });
        Object.defineProperty(result, 'redirected', { value: didRedirect || isRedirect || finalUrl !== url.href });
        return result;
    } catch (err) {
        curl.abort();
        // drain so perform() settles and we don't leak the handle
        await performPromise.catch(() => {});
        if (request.signal?.aborted) throw abortError(request.signal);
        if (isCurlTimeoutError(err)) throw timeoutError();
        throw err;
    }
}

export async function fetchAsync(input: any, init?: any, initiatorCallFrames?: NetworkCallFrame[]): Promise<Response> {
    if (input instanceof URL) input = input.href;
    const request = new Request(input, init);
    request.setInitiatorCallFrames(initiatorCallFrames);
    throwIfAborted(request.signal);
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`Unsupported protocol: ${url.protocol}`);
    return performFetch(request, url);
}

function fetch(input: any, init?: any): Promise<Response> {
    const initiatorCallFrames = getFetchHook() ? captureUserNetworkCallFrames() : undefined;
    return fetchAsync(input, init, initiatorCallFrames);
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
    private _responseHeaderMap: Map<string, string> | null = null;
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
        this._responseHeaderMap = null;
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
        if (this._responseHeaderMap == null) {
            const map = new Map<string, string>();
            for (const line of this._responseHeaders.split(/\r?\n/)) {
                const colon = line.indexOf(':');
                if (colon > 0) map.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
            }
            this._responseHeaderMap = map;
        }
        return this._responseHeaderMap.get(lower) ?? null;
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
        const netHook = getFetchHook();
        const curlTrace = netHook ? attachCurlDebugTrace(curl) : undefined;
        const interceptHook = getFetchInterceptHook();
        const reqId = (netHook || interceptHook) ? newRequestId() : '';
        const reqCallFrames = netHook ? captureUserNetworkCallFrames() : undefined;
        const hdrs: Record<string, string> = {};
        for (const [k, v] of this._headers) {
            const lk = k.toLowerCase();
            if (lk in hdrs) {
                hdrs[lk] += (lk === 'cookie' ? '; ' : ', ') + v;
            } else {
                hdrs[lk] = v;
            }
        }

        // Basic auth from open() user/password — UTF-8 encode then base64 (RFC 7617)
        if (this._user !== null) {
            const credBytes = engine.encodeString(`${this._user}:${this._password ?? ''}`) as Uint8Array;
            let credStr = '';
            for (let i = 0; i < credBytes.length; i++) credStr += String.fromCharCode(credBytes[i]!);
            hdrs['Authorization'] = `Basic ${btoa(credStr)}`;
        }

        curl.setUrl(this._url)
            .setMethod(this._method)
            .setHeaders(hdrs)
            .setFollowRedirects(true)
            .setMaxRedirects(20);
        const xhrAE = hdrs['accept-encoding'];
        curl.setAcceptEncoding(xhrAE === 'identity' ? 'identity' : undefined);

        if (this.timeout > 0) {
            curl.setTimeout(this.timeout);
            curl.setConnectTimeout(this.timeout);
            curl.setLowSpeedLimit(1, Math.max(1, Math.ceil(this.timeout / 1000)));
        }

        const bodyBytes = (body !== undefined && body !== null) ? serializeBody(body) : null;
        if (bodyBytes) {
            curl.setBody(bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer);
        }

        // CDP Fetch interception
        if (interceptHook?.onRequest) {
            interceptHook.onRequest({
                requestId: reqId, url: this._url, method: this._method,
                headers: hdrs, postData: bodyBytes ?? null, resourceType: 'XHR',
            }).then(result => {
                if (result?.action === 'fulfill') {
                    this._handleInterceptedFulfill(result as any);
                } else if (result?.action === 'fail') {
                    this.readyState = XHR_DONE;
                    this._emit('error');
                    this._emit('loadend');
                } else {
                    this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace);
                }
            }).catch(() => this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace));
        } else {
            this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace);
        }
    }

    private _doPerform(curl: CModuleCURL.CURL, netHook: ReturnType<typeof getFetchHook>, reqId: string, hdrs: Record<string, string>, bodyBytes: Uint8Array | null, reqCallFrames?: NetworkCallFrame[], curlTrace?: CurlDebugTrace): void {
        const ts = () => Date.now() / 1000;
        const reqStartTime = Date.now() / 1000;

        if (netHook) try {
            netHook.onRequest?.({ requestId: reqId, url: this._url, method: this._method, headers: hdrs, postData: bodyBytes ?? null, callFrames: reqCallFrames, resourceType: 'XHR', timestamp: reqStartTime });
        } catch {}

        const handleDone = (response: CModuleCURL.Response): void => {
            if (this._aborted) return;
            const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);

            // Parse response headers for netHook
            const resHdrs: Record<string, string> = {};
            parseHeaders(response.headers).forEach(([k, v]) => { resHdrs[k] = v; });

            if (netHook) try {
                netHook.onResponse?.({
                    requestId: reqId, url: this._url, status: response.status,
                    headers: resHdrs, requestHeaders: hdrs, resourceType: 'XHR', connection: conn, timestamp: ts()
                });
                const bytes = responseBodyToBytes(response.body);
                netHook.onData?.({ requestId: reqId, data: bytes, timestamp: ts() });
                netHook.onFinished?.({ requestId: reqId, success: true, connection: conn, timestamp: ts() });
            } catch {}

            this._handleResponse(response);
        };

        if (this._async) {
            curl.perform().then(handleDone).catch(() => {
                if (this._aborted) return;
                if (netHook) try {
                    netHook.onFinished?.({ requestId: reqId, success: false, errorText: 'network error', timestamp: ts() });
                } catch {}
                this.readyState = XHR_DONE;
                this._emit('error');
                this._emit('loadend');
            });
        } else {
            try {
                handleDone(curl.performSync());
            } catch {
                if (!this._aborted) {
                    if (netHook) try {
                        netHook.onFinished?.({ requestId: reqId, success: false, errorText: 'network error', timestamp: ts() });
                    } catch {}
                    this.readyState = XHR_DONE;
                    this._emit('error');
                    this._emit('loadend');
                }
            }
        }
    }

    private _handleInterceptedFulfill(result: { responseCode: number; responseHeaders: Array<[string, string]>; body: Uint8Array }): void {
        const hdrs: string[] = [];
        for (const [k, v] of result.responseHeaders) hdrs.push(`${k}: ${v}`);
        this._responseHeaders = hdrs.join('\r\n');
        this._responseHeaderMap = null;
        this.status = result.responseCode;
        this.statusText = '';
        this.responseURL = this._url;
        const bytes = result.body;
        this._applyBody(bytes, result.responseHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1]);
        this._setState(XHR_LOADING);
        this._setState(XHR_DONE);
        this._emit('progress');
        this._emit('load');
        this._emit('loadend');
    }

    private _handleResponse(response: CModuleCURL.Response): void {
        this.status = response.status;
        this.statusText = '';
        this._responseHeaders = response.headers;
        this._responseHeaderMap = null;
        try { this.responseURL = this._curl?.getInfo(curlMod.CURLINFO_EFFECTIVE_URL) as string || this._url; } catch { this.responseURL = this._url; }

        this._setState(XHR_HEADERS_RECEIVED);

        const bytes = responseBodyToBytes(response.body);
        this._applyBody(bytes, this.getResponseHeader('content-type') ?? undefined);

        this._setState(XHR_LOADING);
        this._setState(XHR_DONE);
        this._emit('progress');
        this._emit('load');
        this._emit('loadend');
    }

    private _applyBody(bytes: Uint8Array, contentType?: string): void {
        switch (this.responseType) {
            case '':
            case 'text': {
                const m = contentType ? CHARSET_RE.exec(contentType) : null;
                this._responseText = new Decoder(m?.[1]).decode(bytes);
                this._response = this._responseText;
                break;
            }
            case 'json':
                try { this._response = JSON.parse(new Decoder(undefined).decode(bytes)); }
                catch { this._response = null; }
                break;
            case 'arraybuffer':
                this._response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                break;
            case 'blob':
                this._response = new Blob([bytes]);
                break;
            default: {
                const m = contentType ? CHARSET_RE.exec(contentType) : null;
                this._responseText = new Decoder(m?.[1]).decode(bytes);
                this._response = this._responseText;
            }
        }
    }

    get response(): any { return this._response; }
    get responseText(): string { return this._responseText; }
}

// ---------------------------------------------------------------------------
// Register globals
// ---------------------------------------------------------------------------

Reflect.set(globalThis, 'fetch', fetch);
Reflect.set(globalThis, 'Response', Response);
Reflect.set(globalThis, 'Request', Request);
Reflect.set(globalThis, 'XMLHttpRequest', XMLHttpRequest);
