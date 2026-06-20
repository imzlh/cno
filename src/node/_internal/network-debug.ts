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

export function concatChunks(chunks: Uint8Array[]): Uint8Array | undefined {
    if (chunks.length === 0) return undefined;
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
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
