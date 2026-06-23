import { Headers } from "headers-polyfill";
import { DOMException } from "../events";
import { type FetchConnectionInfo } from "../../utils/network-hooks";
import { getTierLimits } from "../../utils/memory-tier";
import type { Request } from "./request";

const { maxPendingBodyBytes, streamHighWaterMark, hookPayloadCap } = getTierLimits();
export { maxPendingBodyBytes, streamHighWaterMark, hookPayloadCap };

export const curlMod = import.meta.use("curl");
export const asyncfs = import.meta.use("asyncfs");
export const os = import.meta.use("os");
export const engine = import.meta.use("engine");
export const { Decoder } = import.meta.use("text");

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

// Pre-compiled regexes (avoid recompilation in hot paths).
export const HTTP_LINE_RE = /^HTTP\//i;
export const TIMEOUT_ERR_RE = /\b(timed?\s*out|timeout)\b/i;
export const BOUNDARY_RE = /boundary=([^\s;]+)/i;
export const CHARSET_RE = /charset\s*=\s*["']?([^\s;'"]+)/i;
export const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

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

export interface CurlDebugTrace {
    requestHeadersText?: string;
    responseHeadersText?: string;
    debugStart?: number;
    headerOutStart?: number;
    dataOutStart?: number;
    headerInStart?: number;
    dataInStart?: number;
}

export function attachCurlDebugTrace(curl: CModuleCURL.CURL): CurlDebugTrace {
    const trace: CurlDebugTrace = {};
    curl.onDebug((type, data) => {
        const now = Date.now() / 1000;
        if (trace.debugStart == null) trace.debugStart = now;
        if (type === curlMod.CURLINFO_HEADER_OUT) {
            if (trace.headerOutStart == null) trace.headerOutStart = now;
            // Only decode if request header text is actually needed.
            if (trace.requestHeadersText == null) {
                trace.requestHeadersText = engine.decodeString(new Uint8Array(data));
            }
        } else if (type === curlMod.CURLINFO_HEADER_IN) {
            if (trace.headerInStart == null) trace.headerInStart = now;
            const text = engine.decodeString(new Uint8Array(data));
            trace.responseHeadersText = HTTP_LINE_RE.test(text) ? text : (trace.responseHeadersText ?? '') + text;
        } else if (type === curlMod.CURLINFO_DATA_OUT) {
            if (trace.dataOutStart == null) trace.dataOutStart = now;
        } else if (type === curlMod.CURLINFO_DATA_IN) {
            if (trace.dataInStart == null) trace.dataInStart = now;
        }
    });
    return trace;
}

export function buildConnectionInfo(curl: CModuleCURL.CURL, reqStartTime: number, trace?: CurlDebugTrace): FetchConnectionInfo | undefined {
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

export function getCurlPool(): CModuleCURL.ConnPool {
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

export function abortError(signal?: AbortSignal): any {
    return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export function timeoutError(): any {
    return new DOMException('The operation timed out', 'TimeoutError');
}

export function compressionAcceptEncoding(headers: Headers): string | undefined {
    const value = headers.get('accept-encoding');
    if (!value) return undefined;
    const trimmed = value.trim();
    // Only honour explicit "identity" (caller wants no compression).
    return trimmed === 'identity' ? 'identity' : undefined;
}

export function isCurlTimeoutError(err: any): boolean {
    return err?.code === 28 || TIMEOUT_ERR_RE.test(String(err?.message ?? err));
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal);
}


export function mergeChunks(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0]!;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total); let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return merged;
}

export function rawHeadersToHeaders(raw: string): Headers {
    const h = new Headers();
    for (const [k, v] of parseHeaders(raw)) h.append(k, v);
    return h;
}

/**
 * Parse raw HTTP headers into pairs. Single-pass with pre-compiled regex.
 */
export function parseHeaders(raw: string): Array<[string, string]> {
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
export function headersToArray(headers: Headers): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    headers.forEach((value: string, key: string) => { out.push([key, value]); });
    return out;
}

/**
 * Convert array of header pairs to Record for curl.setHeaders().
 * Note: duplicates are merged (last wins) — curl API limitation.
 */
export function responseBodyToBytes(body?: string | ArrayBuffer): Uint8Array {
    if (!body) return new Uint8Array(0);
    if (typeof body === "string") return engine.encodeString(body);
    return new Uint8Array(body) as Uint8Array;
}

export function isReadableStreamLike(body: any): body is ReadableStream<Uint8Array> {
    return !!body && typeof body === 'object' && typeof body.getReader === 'function';
}

export function serializeBody(body: any): Uint8Array | null {
    if (body === null || body === undefined) return null;
    if (isReadableStreamLike(body)) return null;
    if (body instanceof Uint8Array) return body as Uint8Array;
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
    if (body instanceof ArrayBuffer) return new Uint8Array(body) as Uint8Array;
    if (typeof body === 'string') return engine.encodeString(body) as Uint8Array;
    if (body instanceof URLSearchParams) return engine.encodeString(body.toString()) as Uint8Array;
    if (body instanceof Blob) return null; // async, handled separately
    if (body instanceof FormData) return null; // async, handled separately
    return engine.encodeString(JSON.stringify(body)) as Uint8Array;
}

export function isNullBodyStatus(status: number): boolean {
    return NULL_BODY_STATUS.has(status);
}

function createMultipartBoundary(): string {
    return '----CNOFormBoundary' + Math.random().toString(36).slice(2);
}

export function ensureFormDataContentType(headers: Headers): string {
    const existing = headers.get('content-type');
    const existingBoundary = existing ? BOUNDARY_RE.exec(existing)?.[1] : undefined;
    if (existingBoundary) return existingBoundary;
    const boundary = createMultipartBoundary();
    if (!existing || /^multipart\/form-data\s*(?:;.*)?$/i.test(existing)) {
        headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    }
    return boundary;
}

export function truncateHookPostData(body?: Uint8Array | null): Uint8Array | null | undefined {
    if (!body) return body;
    
    if (body.byteLength > hookPayloadCap) {
        return new Uint8Array(body.subarray(0, hookPayloadCap));
    }
    return body;
}

export function toCurlBody(body: globalThis.Uint8Array<ArrayBufferLike>): Uint8Array | ArrayBuffer {
    return body.byteOffset === 0 && body.byteLength === body.buffer.byteLength
        ? body.buffer as ArrayBuffer
        : body as Uint8Array;
}

export type PreparedRequestBody =
    | { kind: 'none' }
    | { kind: 'buffer'; body: Uint8Array }
    | { kind: 'file'; path: string; size: number };

async function writeStreamToTempFile(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<{ path: string; size: number }> {
    const path = `${os.tmpDir}/fetch-body-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    const file = await asyncfs.open(path, 'w');
    const reader = stream.getReader();
    let size = 0;
    try {
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            let written = 0;
            size += value.byteLength;
            while (written < value.byteLength) {
                const n = await file.write(value.subarray(written));
                if (n == null) throw new Error('Failed to write temporary request body');
                written += n;
            }
        }
    } catch (err) {
        try { await file.close(); } catch {}
        await asyncfs.unlink(path).catch(() => {});
        throw err;
    } finally {
        reader.releaseLock();
    }
    await file.close();
    return { path, size };
}

export async function prepareRequestBody(request: Request): Promise<PreparedRequestBody> {
    const buffered = request.getBufferedBody();
    if (buffered) {
        request.bodyUsed = true;
        return { kind: 'buffer', body: buffered };
    }
    if (!request.body) return { kind: 'none' };
    request.bodyUsed = true;
    const streamed = await writeStreamToTempFile(request.body as ReadableStream<Uint8Array>, request.signal);
    return { kind: 'file', path: streamed.path, size: streamed.size };
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
// FormData serialization
// ---------------------------------------------------------------------------

export async function serializeFormData(fd: FormData, boundary: string = createMultipartBoundary()): Promise<Uint8Array> {
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

export function parseUrlEncoded(body: Uint8Array): FormData {
    const str = engine.decodeString(body);
    const params = new URLSearchParams(str);
    const fd = new FormData();
    for (const [key, value] of params) fd.append(key, value);
    return fd;
}

// Pre-built CRLF2 needle for parseMultipart (avoids per-call allocation).
const CRLF2 = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
const CRLF2_TABLE = buildKMPTable(CRLF2);

export function parseMultipart(body: Uint8Array, boundary: string): FormData {
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
