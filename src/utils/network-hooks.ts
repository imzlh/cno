/**
 * Network hooks for CDP Network domain.
 * Setters are called by the debug session's Network domain to observe fetch/WebSocket traffic.
 * This module is imported by fetch.ts and websocket.ts; the hook functions themselves are
 * never invoked until a setter registers them.
 */

const debug = import.meta.use('debug');
const HOOK_OFFSET = 2;

// ---- User-Agent / Extra headers override (applied to all fetch requests) ---

let _userAgentOverride: string | null = null;
let _extraHTTPHeaders: Record<string, string> = {};

export function setUserAgentOverride(ua: string | null): void { _userAgentOverride = ua; }
export function getUserAgentOverride(): string | null { return _userAgentOverride; }
export function setExtraHTTPHeaders(headers: Record<string, string>): void { _extraHTTPHeaders = headers; }
export function getExtraHTTPHeaders(): Record<string, string> { return _extraHTTPHeaders; }

// ---- CurlInit hook (applied to every CURL handle before perform) -----------

export { type CurlInitHook, setCurlInitHook, getCurlInitHook } from '../../../cts/src/utils/curl';

// ---- Fetch hooks -----------------------------------------------------------

export interface NetworkCallFrame {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
}

export type NetworkSource = 'fetch' | 'serve';

const INTERNAL_FRAME_PREFIXES = ['<core>', '<devtools>', '<compiled>', '<eval>', 'node:'];
const INTERNAL_NETWORK_FRAME_RE = /(?:webapi[\\/])?fetch\.ts|(?:webapi[\\/])?websocket\.ts|deno[\\/]08_serve\.ts|network-hooks\.ts|captureNetworkCallFrames|captureServeCallFrames|captureWebSocketCallFrames|performFetch|fetchAsync|_doPerform|Hooks\.installNetwork/;

function frameFunctionName(func: unknown): string {
    if (!func) return '';
    if (typeof func === 'object' || typeof func === 'function') {
        const name = Reflect.get(func, 'name');
        if (typeof name === 'string' && name) return name;
    }
    const text = String(func);
    return text.match(/^\[class ([^\]]+)\]$/)?.[1]
        ?? text.match(/^\[Function: ([^\]]+)\]$/)?.[1]
        ?? '';
}

function isInternalNetworkCallFrame(file: string, functionName: string): boolean {
    if (!file) return true;
    for (const prefix of INTERNAL_FRAME_PREFIXES) {
        if (file.startsWith(prefix)) return true;
    }
    return INTERNAL_NETWORK_FRAME_RE.test(`${file} ${functionName}`);
}

export function captureUserNetworkCallFrames(): NetworkCallFrame[] | undefined {
    const frames: NetworkCallFrame[] = [];
    try {
        const depth = debug.getStackDepth();
        for (let level = HOOK_OFFSET; level < Math.min(depth, 64); level++) {
            const info = debug.getFrameInfo(level);
            if (!info) continue;

            const file = info.file ?? '';
            const functionName = frameFunctionName(info.func);
            if(isInternalNetworkCallFrame(file, functionName)) continue;

            frames.push({
                functionName,
                scriptId: file,
                url: file,
                lineNumber: Math.max(0, (info.line ?? 1) - 1),
                columnNumber: Math.max(0, (info.column ?? 1) - 1),
            });
        }
    } catch {}
    return frames.length > 0 ? frames : undefined;
}

export interface FetchRequestInfo {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: Uint8Array | null;  // raw request body bytes
    callFrames?: NetworkCallFrame[];
    resourceType?: 'Fetch' | 'XHR';
    timestamp: number;
}

export interface FetchResponseInfo {
    requestId: string;
    url: string;                             // request URL
    status: number;
    headers: Record<string, string>;
    requestHeaders?: Record<string, string>; // headers that were sent
    resourceType?: 'Fetch' | 'XHR';
    connection?: FetchConnectionInfo;        // curl timing available at response time
    timestamp: number;
}

export interface FetchDataInfo {
    requestId: string;
    data: Uint8Array;
    timestamp: number;
}

export interface FetchFinishedInfo {
    requestId: string;
    success: boolean;
    errorText?: string;
    connection?: FetchConnectionInfo;  // post-request metadata from curl
    timestamp: number;
}

export interface FetchConnectionInfo {
    remoteIPAddress?: string;   // CURLINFO_PRIMARY_IP
    remotePort?: number;        // CURLINFO_PRIMARY_PORT
    httpVersion?: number;       // 1=1.0, 2=1.1, 3=2.0
    totalTime?: number;         // seconds
    downloadSize?: number;      // bytes
    timing?: {
        dnsEnd?: number;
        connectEnd?: number;
        sslEnd?: number;
        sendEnd?: number;
        receiveHeadersStart?: number;  // STARTTRANSFER_TIME = TTFB
        /** Phase durations (seconds) from curl. Used to derive per-phase start times. */
        dnsDuration?: number;
        connectDuration?: number;
        sslDuration?: number;
        sendDuration?: number;
        receiveHeadersDuration?: number;
        /** CURLINFO_TOTAL_TIME — full request lifetime incl. body download (seconds). */
        totalTime?: number;
        /** CURLINFO_SIZE_DOWNLOAD_T — actual bytes received over the wire. */
        sizeDownload?: number;
        /** CURLINFO_NUM_CONNECTS — new connections opened (0 = reused). */
        numConnects?: number;
        /** CURLINFO_SSL_VERIFYRESULT — 0 = cert OK. */
        sslVerifyResult?: number;
        /** CURLINFO_CONTENT_TYPE — Content-Type from response. */
        contentType?: string;
        /** CURLINFO_HEADER_SIZE — response header bytes. */
        headerSize?: number;
        /** CURLINFO_REDIRECT_COUNT — number of redirects followed. */
        redirectCount?: number;
        /** CURLINFO_REDIRECT_URL — redirect target URL. */
        redirectUrl?: string;
        requestHeadersText?: string;
        responseHeadersText?: string;
        debugStart?: number;
        headerOutStart?: number;
        dataOutStart?: number;
        headerInStart?: number;
        dataInStart?: number;
    };
}

export type FetchHook = {
    onRequest?(info: FetchRequestInfo): void;
    onResponse?(info: FetchResponseInfo): void;
    onData?(info: FetchDataInfo): void;
    onFinished?(info: FetchFinishedInfo): void;
};

let fetchHook: FetchHook | null = null;

export function setFetchHook(hook: FetchHook | null): void {
    fetchHook = hook;
}

export function getFetchHook(): FetchHook | null {
    return fetchHook;
}

// ---- Deno.serve hooks ------------------------------------------------------

export interface ServeRequestInfo {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: Uint8Array | null;
    callFrames?: NetworkCallFrame[];
    timestamp: number;
}

export interface ServeResponseInfo {
    requestId: string;
    url: string;
    status: number;
    statusText?: string;
    headers: Record<string, string>;
    timestamp: number;
}

export interface ServeDataInfo {
    requestId: string;
    data: Uint8Array;
    timestamp: number;
}

export interface ServeFinishedInfo {
    requestId: string;
    success: boolean;
    errorText?: string;
    timestamp: number;
}

export type ServeHook = {
    onRequest?(info: ServeRequestInfo): void;
    onResponse?(info: ServeResponseInfo): void;
    onData?(info: ServeDataInfo): void;
    onFinished?(info: ServeFinishedInfo): void;
};

let serveHook: ServeHook | null = null;

export function setServeHook(hook: ServeHook | null): void {
    serveHook = hook;
}

export function getServeHook(): ServeHook | null {
    return serveHook;
}

// ---- WebSocket hooks -------------------------------------------------------

export interface WSCreatedInfo {
    source: NetworkSource;
    requestId: string;
    url: string;
    requestHeaders?: Array<[string, string]>;
    callFrames?: NetworkCallFrame[];
    timestamp: number;
}

export interface WSHandshakeInfo {
    source: NetworkSource;
    requestId: string;
    status: number;
    headers: Array<[string, string]>;
    timestamp: number;
}

export interface WSFrameInfo {
    source: NetworkSource;
    requestId: string;
    opcode: number;
    masked: boolean;
    payloadData: string;  // base64 for binary, utf8 string for text
    payloadLength: number;
    timestamp: number;
}

export interface WSClosedInfo {
    source: NetworkSource;
    requestId: string;
    code: number;
    reason: string;
    timestamp: number;
}

export type WebSocketHook = {
    onCreated?(info: WSCreatedInfo): void;
    onHandshake?(info: WSHandshakeInfo): void;
    onFrameReceived?(info: WSFrameInfo): void;
    onFrameSent?(info: WSFrameInfo): void;
    onClosed?(info: WSClosedInfo): void;
};

let wsHook: WebSocketHook | null = null;

export function setWebSocketHook(hook: WebSocketHook | null): void {
    wsHook = hook;
}

export function getWebSocketHook(): WebSocketHook | null {
    return wsHook;
}

// ---- Fetch intercept hook (CDP Fetch domain) --------------------------------
// Unlike FetchHook (observation only), this hook can pause, modify, fulfill, or
// fail requests before they reach the network. Used by CDP Fetch domain.

export interface FetchInterceptInfo {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: Uint8Array | null;  // raw request body bytes
    resourceType?: string;         // "Fetch", "XHR", "Document", etc.
}

export type InterceptResult = {
    action: 'continue';       // proceed with (optionally modified) request
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: Uint8Array;
} | {
    action: 'fulfill';        // return synthetic response
    responseCode: number;
    responseHeaders: Array<[string, string]>;
    body: Uint8Array;
} | {
    action: 'fail';           // abort with error
    reason: string;           // "BlockedByClient", "ConnectionRefused", etc.
};

export type FetchInterceptHook = {
    onRequest?(info: FetchInterceptInfo): Promise<InterceptResult | null>;
};

const fetchInterceptHookSymbol = Symbol.for('cno.fetchInterceptHook');
let fetchInterceptHook: FetchInterceptHook | null = null;

export function setFetchInterceptHook(hook: FetchInterceptHook | null): void {
    fetchInterceptHook = hook;
    Reflect.set(globalThis, fetchInterceptHookSymbol, hook);
}

export function getFetchInterceptHook(): FetchInterceptHook | null {
    return (Reflect.get(globalThis, fetchInterceptHookSymbol) as FetchInterceptHook | null | undefined) ?? fetchInterceptHook;
}
