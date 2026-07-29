import type {
    FetchHook,
    NetworkCallFrame,
    ServeHook,
} from '../../utils/network-hooks';
import { viewToUint8Array } from './buffer';

const debug = import.meta.use('debug');

let nodeRequestSeq = 0;

type HeaderMap = Record<string, string | string[]>;

/** Minimal surface the shared response parser reads/writes on IncomingMessage. */
export interface ResponseParserMessage {
    statusCode?: number;
    statusMessage?: string;
    httpVersion: string;
    httpVersionMajor: number;
    httpVersionMinor: number;
    headers: HeaderMap | Record<string, string | string[] | undefined>;
    headersDistinct: Record<string, string[] | undefined> | HeaderMap;
    rawHeaders: string[];
    trailers: HeaderMap | Record<string, string | undefined>;
    trailersDistinct: Record<string, string[] | undefined> | HeaderMap;
    rawTrailers: string[];
    complete: boolean;
    push(chunk: unknown, encoding?: BufferEncoding): boolean;
}

export interface ResponseInformation {
    statusCode: number;
    statusMessage: string;
    httpVersion: string;
    httpVersionMajor: number;
    httpVersionMinor: number;
    headers: HeaderMap;
    headersDistinct: Record<string, string[]>;
    rawHeaders: string[];
}

export function nodeTs(): number {
    return Date.now() / 1000;
}

export function nextNodeRequestId(prefix: string): string {
    return `${prefix}-${++nodeRequestSeq}`;
}

export function captureNodeNetworkCallFrames(): NetworkCallFrame[] | undefined {
    try {
        const hooks = Reflect.get(debug, '__cnoNetworkHooks');
        if (!hooks || typeof hooks !== 'object') return undefined;
        const captureCallFrames = Reflect.get(hooks, 'captureCallFrames');
        return typeof captureCallFrames === 'function' ? captureCallFrames() : undefined;
    } catch {
        return undefined;
    }
}

export function getNodeFetchHook(): FetchHook | null {
    try {
        const hooks = Reflect.get(debug, '__cnoNetworkHooks');
        if (!hooks || typeof hooks !== 'object') return null;
        const getFetchHook = Reflect.get(hooks, 'getFetchHook');
        return typeof getFetchHook === 'function' ? getFetchHook() ?? null : null;
    } catch {
        return null;
    }
}

export function getNodeServeHook(): ServeHook | null {
    try {
        const hooks = Reflect.get(debug, '__cnoNetworkHooks');
        if (!hooks || typeof hooks !== 'object') return null;
        const getServeHook = Reflect.get(hooks, 'getServeHook');
        return typeof getServeHook === 'function' ? getServeHook() ?? null : null;
    } catch {
        return null;
    }
}

export function normalizeHeaderValue(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.map(item => String(item)).join(', ');
    return String(value);
}

export function normalizeHeaderRecord(headers: object): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        const normalized = normalizeHeaderValue(value);
        if (normalized !== undefined) out[key] = normalized;
    }
    return out;
}

export function headerEntriesToRecord(headers: Iterable<[string, string]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
}

export function toUint8Array(chunk: unknown, encodeString: (value: string) => Uint8Array): Uint8Array {
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === 'string') return encodeString(chunk);
    if (ArrayBuffer.isView(chunk)) {
        return viewToUint8Array(chunk);
    }
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    return encodeString(String(chunk ?? ''));
}

export function buildNodeUrl(protocol: string, host: string, path: string): string {
    return `${protocol}//${host}${path || '/'}`;
}

export function buildNodeServerUrl(
    protocol: 'http:' | 'https:',
    url: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    fallbackHost: string = '127.0.0.1',
): string {
    const host = normalizeHeaderValue(headers.host) || fallbackHost;
    const path = url && url.length > 0 ? url : '/';
    return buildNodeUrl(protocol, host, path);
}

// ── Shared HTTP response parser setup ─────────────────────────────────────────

const engine = import.meta.use('engine');
const httpNative = import.meta.use('http');

export interface ResponseParserContext<T extends ResponseParserMessage = ResponseParserMessage> {
    requestId: string;
    protocol: string;
    host: string;
    path: string;
    res: T;
    getHeaders: () => object;
    onResponse: (res: T) => void;
    onInformation?: (info: ResponseInformation) => void;
    onConnect?: (res: T) => void;
    onUpgrade?: (res: T) => void;
    onComplete: () => void;
    connectMode?: boolean;
    skipBody?: boolean;
}

function viewParserBuffer(buffer: CModuleHTTP.BufferSource): Uint8Array {
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function setupResponseParser<T extends ResponseParserMessage>(ctx: ResponseParserContext<T>) {
    const fetchHook = getNodeFetchHook();
    let finished = false;
    const finish = (success: boolean, errorText?: string) => {
        if (finished) return; finished = true;
        try { fetchHook?.onFinished?.({ requestId: ctx.requestId, timestamp: nodeTs(), success, errorText }); } catch {}
    };
    const parser = new httpNative.Parser(httpNative.RESPONSE);
    const res = ctx.res;
    let currentHeaderField = '';
    let currentHeaderValue = '';
    let currentHeaderPart: 'field' | 'value' | null = null;
    let currentStatusMessage = '';
    let currentHeaders: HeaderMap = {};
    let currentHeadersDistinct: Record<string, string[]> = {};
    let currentRawHeaders: string[] = [];
    let currentMessageInformational = false;
    let currentMessageConnect = false;
    let currentMessageUpgrade = false;
    let responseStarted = false;
    const pendingChunks: Uint8Array[] = [];

    const decode = (buf: CModuleHTTP.BufferSource, off: number, len: number) =>
        engine.decodeString(viewParserBuffer(buf).subarray(off, off + len));
    const resetMessageHeaders = () => {
        currentHeaderField = '';
        currentHeaderValue = '';
        currentHeaderPart = null;
        currentStatusMessage = '';
        currentHeaders = {};
        currentHeadersDistinct = {};
        currentRawHeaders = [];
    };
    const flushHeader = () => {
        if (!currentHeaderField) return;
        const lowerField = currentHeaderField.toLowerCase();
        const targetHeaders = (responseStarted ? res.trailers : currentHeaders) as HeaderMap;
        const targetDistinct = (responseStarted ? res.trailersDistinct : currentHeadersDistinct) as Record<string, string[]>;
        const targetRaw = responseStarted ? res.rawTrailers : currentRawHeaders;
        const existing = targetHeaders[lowerField];
        if (existing) {
            if (Array.isArray(existing)) existing.push(currentHeaderValue);
            else targetHeaders[lowerField] = [existing, currentHeaderValue];
        } else {
            targetHeaders[lowerField] = currentHeaderValue;
        }
        targetRaw.push(currentHeaderField, currentHeaderValue);
        (targetDistinct[lowerField] ??= []).push(currentHeaderValue);
        currentHeaderField = '';
        currentHeaderValue = '';
        currentHeaderPart = null;
    };

    parser.onStatus = (buf, off, len) => { currentStatusMessage += decode(buf, off, len); };
    parser.onHeaderField = (buf, off, len) => {
        if (currentHeaderPart === 'value') flushHeader();
        currentHeaderField += decode(buf, off, len);
        currentHeaderPart = 'field';
    };
    parser.onHeaderValue = (buf, off, len) => {
        currentHeaderValue += decode(buf, off, len);
        currentHeaderPart = 'value';
    };
    parser.onHeadersComplete = () => {
        flushHeader();
        const statusCode = parser.state.status;
        const httpVersion = `${parser.state.httpMajor}.${parser.state.httpMinor}`;
        const isUpgrade = statusCode === 101 || parser.state.upgrade;
        if (ctx.connectMode) {
            responseStarted = true;
            res.statusCode = statusCode;
            res.statusMessage = currentStatusMessage;
            res.httpVersion = httpVersion;
            res.httpVersionMajor = parser.state.httpMajor;
            res.httpVersionMinor = parser.state.httpMinor;
            res.headers = currentHeaders;
            res.headersDistinct = currentHeadersDistinct;
            res.rawHeaders = currentRawHeaders;
            currentMessageConnect = true;
            ctx.onConnect?.(res);
            return;
        }
        if (statusCode >= 100 && statusCode < 200 && statusCode !== 101) {
            currentMessageInformational = true;
            ctx.onInformation?.({
                statusCode,
                statusMessage: currentStatusMessage,
                httpVersion,
                httpVersionMajor: parser.state.httpMajor,
                httpVersionMinor: parser.state.httpMinor,
                headers: currentHeaders,
                headersDistinct: currentHeadersDistinct,
                rawHeaders: currentRawHeaders,
            });
            resetMessageHeaders();
            return;
        }

        responseStarted = true;
        res.statusCode = statusCode;
        res.statusMessage = currentStatusMessage;
        res.httpVersion = httpVersion;
        res.httpVersionMajor = parser.state.httpMajor;
        res.httpVersionMinor = parser.state.httpMinor;
        res.headers = currentHeaders;
        res.headersDistinct = currentHeadersDistinct;
        res.rawHeaders = currentRawHeaders;
        if (isUpgrade) {
            currentMessageUpgrade = true;
            ctx.onUpgrade?.(res);
            return;
        }
        ctx.onResponse(res);
        try { fetchHook?.onResponse?.({
            requestId: ctx.requestId, timestamp: nodeTs(),
            url: buildNodeUrl(ctx.protocol, ctx.host, ctx.path),
            status: res.statusCode ?? 0,
            headers: normalizeHeaderRecord(res.headers),
            requestHeaders: normalizeHeaderRecord(ctx.getHeaders()),
            resourceType: 'Fetch',
        }); } catch {}
        for (const chunk of pendingChunks) res.push(chunk);
        pendingChunks.length = 0;
        if (ctx.skipBody && !res.complete) {
            res.complete = true;
            res.push(null);
            finish(true);
            ctx.onComplete();
        }
    };
    parser.onBody = (buf, off, len) => {
        if (ctx.skipBody || currentMessageInformational || currentMessageConnect) return;
        const data = viewParserBuffer(buf).slice(off, off + len);
        try { fetchHook?.onData?.({ requestId: ctx.requestId, timestamp: nodeTs(), data }); } catch {}
        if (!responseStarted) pendingChunks.push(data);
        else res.push(data);
    };
    parser.onMessageComplete = () => {
        if (currentMessageInformational) {
            currentMessageInformational = false;
            return;
        }
        flushHeader();
        if (currentMessageConnect) {
            res.complete = true;
            return;
        }
        if (currentMessageUpgrade) {
            res.complete = true;
            return;
        }
        res.complete = true;
        res.push(null);
        finish(true);
        ctx.onComplete();
    };

    return { parser, res, finish, pendingChunks };
}
