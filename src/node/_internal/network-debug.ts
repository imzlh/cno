import type {
    FetchHook,
    NetworkCallFrame,
    ServeHook,
} from '../../utils/network-hooks';

const debug = import.meta.use('debug') as {
    __cnoNetworkHooks?: {
        getFetchHook?: () => FetchHook | null;
        getServeHook?: () => ServeHook | null;
        captureCallFrames?: () => NetworkCallFrame[] | undefined;
    };
};

let nodeRequestSeq = 0;

type HeaderValue = number | string | string[] | readonly string[] | undefined;

export function nodeTs(): number {
    return Date.now() / 1000;
}

export function nextNodeRequestId(prefix: string): string {
    return `${prefix}-${++nodeRequestSeq}`;
}

export function captureNodeNetworkCallFrames(): NetworkCallFrame[] | undefined {
    try {
        return debug.__cnoNetworkHooks?.captureCallFrames?.();
    } catch {
        return undefined;
    }
}

export function getNodeFetchHook(): FetchHook | null {
    try {
        return debug.__cnoNetworkHooks?.getFetchHook?.() ?? null;
    } catch {
        return null;
    }
}

export function getNodeServeHook(): ServeHook | null {
    try {
        return debug.__cnoNetworkHooks?.getServeHook?.() ?? null;
    } catch {
        return null;
    }
}

export function normalizeHeaderValue(value: HeaderValue): string | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.map(item => String(item)).join(', ');
    return String(value);
}

export function normalizeHeaderRecord(headers: Record<string, HeaderValue>): Record<string, string> {
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
        return new Uint8Array(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
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

export interface ResponseParserContext {
    requestId: string;
    protocol: string;
    host: string;
    path: string;
    res: any;  // IncomingMessageImpl or compatible (must have push())
    getHeaders: () => Record<string, any>;
    onResponse: (res: any) => void;
    onComplete: () => void;
    skipBody?: boolean;
}

export function setupResponseParser(ctx: ResponseParserContext) {
    const fetchHook = getNodeFetchHook();
    let finished = false;
    const finish = (success: boolean, errorText?: string) => {
        if (finished) return; finished = true;
        try { fetchHook?.onFinished?.({ requestId: ctx.requestId, timestamp: nodeTs(), success, errorText }); } catch {}
    };
    const parser = new httpNative.Parser(httpNative.RESPONSE);
    const res = ctx.res;
    let currentHeaderField = '';
    const pendingChunks: Uint8Array[] = [];

    const decode = (buf: any, off: number, len: number) =>
        engine.decodeString(new Uint8Array(buf as ArrayBuffer).slice(off, off + len));

    parser.onStatus = (buf: any, off: number, len: number) => { res.statusMessage = decode(buf, off, len); };
    parser.onHeaderField = (buf: any, off: number, len: number) => { currentHeaderField = decode(buf, off, len).toLowerCase(); };
    parser.onHeaderValue = (buf: any, off: number, len: number) => {
        const value = decode(buf, off, len);
        const existing = res.headers[currentHeaderField];
        if (existing) {
            if (Array.isArray(existing)) existing.push(value);
            else res.headers[currentHeaderField] = [existing, value];
        } else { res.headers[currentHeaderField] = value; }
        res.rawHeaders.push(currentHeaderField, value);
        (res.headersDistinct[currentHeaderField] ??= []).push(value);
    };
    parser.onHeadersComplete = () => {
        res.statusCode = parser.state.status;
        res.httpVersion = `${parser.state.httpMajor}.${parser.state.httpMinor}`;
        res.httpVersionMajor = parser.state.httpMajor;
        res.httpVersionMinor = parser.state.httpMinor;
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
            res.push(null);
            res.complete = true;
            finish(true);
            ctx.onComplete();
        }
    };
    parser.onBody = (buf: any, off: number, len: number) => {
        if (ctx.skipBody) return;
        const data = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
        try { fetchHook?.onData?.({ requestId: ctx.requestId, timestamp: nodeTs(), data }); } catch {}
        if (res.statusCode === 0) pendingChunks.push(data);
        else res.push(data);
    };
    parser.onMessageComplete = () => {
        res.push(null); res.complete = true;
        finish(true);
        ctx.onComplete();
    };

    return { parser, res, finish, pendingChunks };
}
