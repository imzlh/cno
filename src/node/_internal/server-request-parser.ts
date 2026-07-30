const engine = import.meta.use('engine');
const http = import.meta.use('http');
const algorithm = import.meta.use('algorithm');

import {
    appendIncomingHeader,
    applyIncomingRequestLine,
    type IncomingMessageImpl,
} from '../http/server';
import { LLHTTP_METHODS } from '../http/constants';
import {
    buildNodeServerUrl,
    captureNodeNetworkCallFrames,
    nextNodeRequestId,
    normalizeHeaderRecord,
} from './network-debug';
import {
    completeIncomingRequest,
    pushIncomingRequestChunk,
} from './server-request-stream';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

function concatUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
    return algorithm.bytesConcat([a, b]) as Uint8Array;
}

export interface ParsedServerRequest {
    requestId: string;
    requestUrl: string;
    requestHeaders: Record<string, string>;
    requestCallFrames?: ReturnType<typeof captureNodeNetworkCallFrames>;
    postData: Uint8Array | null;
}

export interface ServerRequestParserOptions {
    createIncoming(): IncomingMessageImpl;
    protocol: 'http:' | 'https:';
    requestIdPrefix: string;
    onRequest(incoming: IncomingMessageImpl, meta: ParsedServerRequest): void;
    onParseError?(error: Error): void;
}

function toParserBuffer(chunk: Uint8Array): ArrayBuffer {
    const buffer = chunk.buffer instanceof SharedArrayBuffer
        ? new Uint8Array(chunk).buffer
        : chunk.buffer;
    return buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
}

function viewParserBuffer(buffer: CModuleHTTP.BufferSource): Uint8Array {
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    // Here, expect ArrayView<ArrayBuffer> that queued via `parser.execute()`
    return new Uint8Array<ArrayBuffer>(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}

export function createServerRequestParser(options: ServerRequestParserOptions): { feed(chunk: Uint8Array): void } {
    const parser = new http.Parser(http.REQUEST);
    let incoming: IncomingMessageImpl | null = null;
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
        applyIncomingRequestLine(
            currentIncoming,
            LLHTTP_METHODS[parser.state.method] || 'GET',
            currentIncoming.url || '/',
            `${parser.state.httpMajor}.${parser.state.httpMinor}`,
        );
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
        const chunk = viewParserBuffer(buf).slice(off, off + len);
        pushIncomingRequestChunk(getIncoming(), chunk);
    };
    parser.onMessageComplete = () => {
        const completedIncoming = getIncoming();
        completeIncomingRequest(completedIncoming);
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
            const buffered = pendingLeftover ? concatUint8(pendingLeftover, chunk) : chunk;
            pendingLeftover = null;
            const result = parser.execute(toParserBuffer(buffered));
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
