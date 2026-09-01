const engine = import.meta.use('engine');
const http = import.meta.use('http');
const algorithm = import.meta.use('algorithm');

import { LLHTTP_METHODS } from '../http/constants';
import {
    appendIncomingHeader,
    type IncomingRequestTarget,
} from './server-request-stream';

import {
    buildNodeServerUrl,
    captureNodeNetworkCallFrames,
    nextNodeRequestId,
    normalizeHeaderRecord,
} from './network-debug';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export interface ParsedServerRequest {
    requestId: string;
    requestUrl: string;
    requestHeaders: Record<string, string>;
    requestCallFrames?: ReturnType<typeof captureNodeNetworkCallFrames>;
    postData: Uint8Array | null;
}

export interface ServerRequestParserOptions<TIncoming extends IncomingRequestTarget = IncomingRequestTarget> {
    createIncoming(): TIncoming;
    protocol: 'http:' | 'https:';
    requestIdPrefix: string;
    onRequest(incoming: TIncoming, meta: ParsedServerRequest): void;
    onParseError?(error: Error): void;
}

function viewParserBuffer(buffer: CModuleHTTP.BufferSource): Uint8Array {
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    // Here, expect ArrayView<ArrayBuffer> that queued via `parser.execute()`
    return new Uint8Array<ArrayBuffer>(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}

export function createServerRequestParser<TIncoming extends IncomingRequestTarget>(
    options: ServerRequestParserOptions<TIncoming>,
): { feed(chunk: Uint8Array): void } {
    const parser = new http.Parser(http.REQUEST);
    let incoming: TIncoming | null = null;
    let currentHeaderField = '';
    let currentHeaderValue = '';
    let currentHeaderPart: 'field' | 'value' | null = null;
    let pendingLeftover: Uint8Array | null = null;

    const decode = (buf: CModuleHTTP.BufferSource, off: number, len: number) =>
        engine.decodeString(viewParserBuffer(buf).subarray(off, off + len));
    const getIncoming = () => {
        if (!incoming) incoming = options.createIncoming();
        return incoming;
    };
    const flushHeader = () => {
        if (!currentHeaderField) return;
        appendIncomingHeader(getIncoming(), currentHeaderField, currentHeaderValue);
        currentHeaderField = '';
        currentHeaderValue = '';
        currentHeaderPart = null;
    };

    parser.onUrl = (buf, off, len) => {
        getIncoming().url = decode(buf, off, len);
    };
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
        const currentIncoming = getIncoming();
        currentIncoming.method = LLHTTP_METHODS[parser.state.method] || 'GET';
        currentIncoming.url ||= '/';
        currentIncoming.httpVersion = `${parser.state.httpMajor}.${parser.state.httpMinor}`;
        currentIncoming.httpVersionMajor = parser.state.httpMajor;
        currentIncoming.httpVersionMinor = parser.state.httpMinor;
        const requestHeaders = normalizeHeaderRecord(currentIncoming.headers);
        options.onRequest(currentIncoming, {
            requestId: nextNodeRequestId(options.requestIdPrefix),
            requestUrl: buildNodeServerUrl(options.protocol, currentIncoming.url, requestHeaders),
            requestHeaders,
            requestCallFrames: captureNodeNetworkCallFrames(),
            postData: null,
        });
    };
    parser.onBody = (buf, off, len) => {
        getIncoming().push(viewParserBuffer(buf).slice(off, off + len));
    };
    parser.onMessageComplete = () => {
        const completedIncoming = getIncoming();
        completedIncoming.complete = true;
        completedIncoming.push(null);
        incoming = null;
        currentHeaderField = '';
        currentHeaderValue = '';
        currentHeaderPart = null;
    };

    return {
        feed(chunk: Uint8Array): void {
            // Prepend any bytes the parser could not consume on the previous call
            // (a chunk that contained the tail of one request and the head of the
            // next). Without this, coalesced/co-parsed bytes are silently dropped.
            const buffered = pendingLeftover
                ? algorithm.bytesConcat([pendingLeftover, chunk]) as Uint8Array
                : chunk;
            pendingLeftover = null;
            const buffer = buffered.buffer instanceof SharedArrayBuffer
                ? new Uint8Array(buffered).buffer
                : buffered.buffer;
            const result = parser.execute(buffer.slice(buffered.byteOffset, buffered.byteOffset + buffered.byteLength));
            if (result.errno !== 0) {
                const consumed = Number(result.bytesConsumed ?? buffered.byteLength);
                if (Number.isFinite(consumed) && consumed >= 0 && consumed < buffered.byteLength) {
                    pendingLeftover = buffered.subarray(consumed);
                }
                if (result.name !== 'HPE_PAUSED_UPGRADE' && result.name !== 'HPE_PAUSED') {
                    options.onParseError?.(new Error(`HTTP parse error: ${result.reason}`));
                }
            }
        },
    };
}
