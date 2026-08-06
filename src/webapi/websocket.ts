/**
 * WebSocket client and server (RFC 6455).
 * Includes frame parsing/building, masking/unmasking, ping/pong heartbeats, close handoff,
 * fragmented messages, and a WebSocketStream wrapper.
 */

import { HttpResponseParser } from "@cnojs/http/h1";
import { type ISocket } from "@cnojs/http/socket";
import { Headers } from "./headers";
import { assert } from "../utils/assert";
import { buildRequest, connectHttp, readHeaders } from "../utils/http";
import { bytesToArrayBuffer, concatChunks, toOwnedBytes, sanitizeSurrogates } from "../utils/bytes";
import { getTierLimits } from '../utils/memory-tier';
import { captureUserNetworkCallFrames, getWebSocketHook, type NetworkCallFrame, type NetworkSource, type WSFrameInfo } from '../utils/network-hooks';
import { CloseEvent, DOMException, ErrorEvent, MessageEvent } from "./events";

const engine = import.meta.use('engine');
const algo = import.meta.use('algorithm');
const crypto = import.meta.use('crypto');
const timers = import.meta.use('timers');
const textMod = import.meta.use('text');
const failWebSocket = Symbol('cno.failWebSocket');
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')?.get;
const dataViewByteOffsetGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')?.get;
const dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')?.get;
const blobSizeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get;
const blobArrayBuffer = Blob.prototype.arrayBuffer;

/** RFC 6455 requires invalid UTF-8 to fail the connection with status 1007. */
const decodeTextFrame = (payload: Uint8Array): string => new textMod.Decoder('utf-8', { fatal: true }).decode(payload);

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type IWSSocket = Omit<ISocket, 'serverHandshake' | 'alpnProtocol' | 'read'>;

let _wsIdCounter = 0;
const wsTs = () => Date.now() / 1000;

function emitWebSocketHookQuietly(callback: () => void): void {
    try {
        callback();
    } catch {
        // WebSocket hooks are CDP observers; user-visible flow must continue.
    }
}

function toError(error: unknown, fallback?: string): Error {
    if (engine.isError(error)) return error as Error;
    if (fallback !== undefined) return new Error(fallback);
    try { return new Error(String(error)); } catch { return new Error('WebSocket operation failed'); }
}

function applySlotGetter<T>(getter: ((this: unknown) => T) | undefined, value: object): T {
    if (!getter) throw new TypeError('Required WebSocket data slot is unavailable');
    return Reflect.apply(getter, value, []);
}

function getBlobSize(value: unknown): number | undefined {
    if (!value || typeof value !== 'object' || !blobSizeGetter) return undefined;
    try { return Reflect.apply(blobSizeGetter, value, []); } catch { return undefined; }
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
    if (!value || typeof value !== 'object') return false;
    if (engine.isDataView(value)) return true;
    if (!typedArrayBufferGetter) return false;
    try { Reflect.apply(typedArrayBufferGetter, value, []); return true; } catch { return false; }
}

function viewBytes(value: ArrayBufferView): Uint8Array {
    const isDataView = engine.isDataView(value);
    const buffer = isDataView
        ? applySlotGetter(dataViewBufferGetter, value)
        : applySlotGetter(typedArrayBufferGetter, value);
    const byteOffset = isDataView
        ? applySlotGetter(dataViewByteOffsetGetter, value)
        : applySlotGetter(typedArrayByteOffsetGetter, value);
    const byteLength = isDataView
        ? applySlotGetter(dataViewByteLengthGetter, value)
        : applySlotGetter(typedArrayByteLengthGetter, value);
    return toOwnedBytes(new Uint8Array(buffer, byteOffset, byteLength));
}

function closeConnectionQuietly(connection: { close(): void }): void {
    try {
        connection.close();
    } catch {
        // Closing is best-effort during terminal WebSocket state changes.
    }
}

function closeReadableControllerQuietly(controller: { close(): void }): void {
    try {
        controller.close();
    } catch {
        // The stream may already be closed by the WebSocket terminal event.
    }
}

function errorReadableControllerQuietly(controller: { error(error?: unknown): void }, error: Error): void {
    try {
        controller.error(error);
    } catch {
        // Preserve the original WebSocket error path.
    }
}

/**
 * Encode a Uint8Array slice to base64 for hook reporting.
 * Caps at HOOK_PAYLOAD_CAP bytes to avoid huge string allocations for large binary frames.
 */
function hookBase64(payload: Uint8Array): string {
    const src = payload.byteLength <= hookPayloadCap ? payload : payload.subarray(0, hookPayloadCap);
    // Use a dedicated ArrayBuffer copy so byteOffset is always 0.
    const buf = toOwnedBytes(src).buffer;
    return crypto.base64Encode(buf);
}

function captureWebSocketCallFrames(): NetworkCallFrame[] | undefined {
    return captureUserNetworkCallFrames();
}

function toWebSocketUrl(url: string): string {
    if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`;
    if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`;
    return url;
}

function normalizeClientWebSocketUrl(input: string | URL): string {
    const raw = String(input);
    const url = new URL(raw);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new DOMException(`The URL's scheme must be either 'ws' or 'wss'. '${url.protocol.slice(0, -1)}' is not allowed.`, 'SyntaxError');
    }
    if (raw.includes('#')) {
        throw new DOMException('WebSocket URL must not contain a fragment', 'SyntaxError');
    }
    return url.href;
}

function validateProtocols(protocols?: unknown): string[] {
    if (protocols === undefined || protocols === null) return [];
    let raw: unknown[];
    if (typeof protocols === 'string') {
        raw = [protocols];
    } else if (typeof protocols === 'object' || typeof protocols === 'function') {
        const iterator = Reflect.get(protocols, Symbol.iterator);
        if (typeof iterator !== 'function') return [];
        raw = Array.from(protocols as Iterable<unknown>);
    } else {
        return [];
    }
    // WebIDL types `protocols` as `USVString or sequence<USVString>`, so a failed
    // conversion to USVString is a TypeError, whereas a malformed or duplicated
    // token below is a SyntaxError DOMException. `String(sym)` is the one ToString
    // path that does NOT throw for a symbol -- it yields "Symbol(x)", which would
    // then fall through to the token regex and surface as the wrong error type.
    // Node v24 and Deno 2.9 both throw a plain TypeError here (OBSERVED).
    const list = raw.map((protocol) => {
        if (typeof protocol === 'symbol') {
            throw new TypeError('Cannot convert a Symbol value to a string');
        }
        return String(protocol);
    });
    const seen = new Set<string>();
    for (const protocol of list) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)) {
            throw new DOMException('Invalid Sec-WebSocket-Protocol value', 'SyntaxError');
        }
        if (seen.has(protocol)) {
            throw new DOMException(`The subprotocol '${protocol}' is duplicated`, 'SyntaxError');
        }
        seen.add(protocol);
    }
    return list;
}

function normalizeCloseCode(value: unknown): number {
    const code = Math.trunc(Number(value));
    if (code === WebSocketCloseCode.NORMAL || (code >= 3000 && code <= 4999)) return code;
    throw new DOMException('The close code must be 1000 or in the range 3000 to 4999', 'InvalidAccessError');
}

function isValidReceivedCloseCode(code: number): boolean {
    return code === 1000
        || code === 1001
        || code === 1002
        || code === 1003
        || (code >= 1007 && code <= 1014)
        || (code >= 3000 && code <= 4999);
}

function encodeCloseReason(reason: string): Uint8Array {
    const reasonBytes = reason ? engine.encodeString(sanitizeSurrogates(reason)) : new Uint8Array(0);
    if (reasonBytes.byteLength > 123) {
        throw new DOMException('The close reason must not be longer than 123 bytes', 'SyntaxError');
    }
    return reasonBytes;
}

function responseHeaderValues(headers: Array<[string, string]>, name: string): string[] {
    return headers.filter(([headerName]) => headerName === name).map(([, value]) => value.trim());
}

function responseHeaderHasToken(values: string[], token: string): boolean {
    const expected = token.toLowerCase();
    return values.some((value) => value.split(',').some((part) => part.trim().toLowerCase() === expected));
}

export enum OpCode {
    CONTINUATION = 0x0, TEXT = 0x1, BINARY = 0x2,
    CLOSE = 0x8, PING = 0x9, PONG = 0xA
}

export enum WebSocketReadyState {
    CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3
}

export enum WebSocketCloseCode {
    NORMAL = 1000, GOING_AWAY = 1001, PROTOCOL_ERROR = 1002, UNSUPPORTED_DATA = 1003,
    NO_STATUS = 1005, ABNORMAL = 1006, INVALID_PAYLOAD = 1007, POLICY_VIOLATION = 1008,
    MESSAGE_TOO_BIG = 1009, EXTENSION_REQUIRED = 1010, INTERNAL_ERROR = 1011,
    SERVICE_RESTART = 1012, TRY_AGAIN_LATER = 1013, BAD_GATEWAY = 1014,
    TLS_HANDSHAKE_FAIL = 1015
}

export interface ServerWebSocketMeta {
    source: NetworkSource;
    requestId: string;
    url: string;
    requestHeaders?: Array<[string, string]>;
    responseStatus?: number;
    responseHeaders?: Array<[string, string]>;
    callFrames?: NetworkCallFrame[];
}

type ServerWebSocketMetaSource = ServerWebSocketMeta | Promise<ServerWebSocketMeta | undefined> | undefined;

interface WebSocketFrame { fin: boolean; opcode: OpCode; masked: boolean; payload: Uint8Array; }
interface WebSocketEventMap { open: Event; message: MessageEvent; error: ErrorEvent; close: globalThis.CloseEvent; }

const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
// Fragment threshold for large sends.
// Only payloads exceeding this are split into multiple frames; the sole purpose
// is to prevent a single enormous frame from blocking PING/CLOSE frames in the
// send queue for too long.  8 MB - header (14 B) means almost nothing fragments
// in practice — the C wsMask implementation handles large payloads efficiently.
const SEND_FRAGMENT_SIZE = MAX_BUFFERED_AMOUNT - 14;

const { streamHighWaterMark: HIGH_WATER_MARK, hookPayloadCap } = getTierLimits();

class SendQueue {
    private queue: Array<{ data: Uint8Array; bufferedBytes: number; resolve: () => void; reject: (e: Error) => void }> = [];
    private pending = false;
    private connection: IWSSocket | null;
    private isClient: boolean;
    private onClose: () => void;
    private _bufferedAmount = 0;
    private queuedWireBytes = 0;
    get bufferedAmount() { return this._bufferedAmount; }

    constructor(connection: IWSSocket | null, isClient: boolean, onClose: () => void) {
        this.connection = connection; this.isClient = isClient; this.onClose = onClose;
    }

    reserveData(bytes: number): boolean {
        if (this._bufferedAmount + bytes > MAX_BUFFERED_AMOUNT) return false;
        this._bufferedAmount += bytes;
        return true;
    }

    releaseData(bytes: number): void {
        this._bufferedAmount = Math.max(0, this._bufferedAmount - bytes);
    }

    enqueue(data: Uint8Array, bufferedBytes = 0, precounted = false): Promise<void> {
        if ((!precounted && this._bufferedAmount + bufferedBytes > MAX_BUFFERED_AMOUNT)
            || this.queuedWireBytes + data.length > MAX_BUFFERED_AMOUNT) {
            if (precounted) this.releaseData(bufferedBytes);
            return Promise.reject(new Error('WebSocket buffer is full'));
        }
        if (!precounted) this._bufferedAmount += bufferedBytes;
        this.queuedWireBytes += data.length;
        return new Promise((resolve, reject) => {
            this.queue.push({ data, bufferedBytes, resolve, reject });
            if (this.connection) this.drain();
        });
    }

    setConnection(conn: IWSSocket): void { this.connection = conn; if (this.queue.length > 0) this.drain(); }

    private async drain(): Promise<void> {
        if (this.pending || !this.connection || this.queue.length === 0) return;
        this.pending = true;
        while (this.queue.length > 0 && this.connection) {
            const item = this.queue.shift();
            if (!item) break;
            try {
                await this.connection.write(item.data);
                this._bufferedAmount -= item.bufferedBytes; item.resolve();
                this.queuedWireBytes -= item.data.length;
            } catch (e) {
                this._bufferedAmount -= item.bufferedBytes; item.reject(toError(e));
                this.queuedWireBytes -= item.data.length;
                this.connection = null; this.onClose(); this.flushQueue(new Error('Connection closed')); return;
            }
        }
        this.pending = false;
    }

    private buildFrame(opcode: OpCode, payload: Uint8Array, fin: boolean, masked: boolean): Uint8Array {
        const payloadLength = payload.length;
        let headerLength = 2;
        if (payloadLength > 65535) headerLength += 8;
        else if (payloadLength > 125) headerLength += 2;
        if (masked) headerLength += 4;

        const frame = new Uint8Array(headerLength + payloadLength);
        let offset = 0;
        frame[offset++] = (fin ? 0x80 : 0) | opcode;

        let byte2 = masked ? 0x80 : 0;
        if (payloadLength <= 125) {
            byte2 |= payloadLength;
            frame[offset++] = byte2;
        }
        else if (payloadLength <= 65535) {
            byte2 |= 126;
            frame[offset++] = byte2;
            frame[offset++] = (payloadLength >> 8) & 0xFF;
            frame[offset++] = payloadLength & 0xFF;
        } else {
            byte2 |= 127;
            frame[offset++] = byte2;
            frame[offset++] = 0; frame[offset++] = 0; frame[offset++] = 0; frame[offset++] = 0;
            frame[offset++] = (payloadLength / 0x1000000) & 0xFF;
            frame[offset++] = (payloadLength / 0x10000) & 0xFF;
            frame[offset++] = (payloadLength / 0x100) & 0xFF;
            frame[offset++] = payloadLength & 0xFF;
        }

        if (masked) {
            const maskKey = new Uint8Array(4);
            crypto.randomFill(maskKey);
            frame.set(maskKey, offset); offset += 4;
            algo.wsMaskInto(payload, maskKey, frame, offset);
        } else { frame.set(payload, offset); }
        return frame;
    }

    private flushQueue(error: Error): void {
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item) break;
            this._bufferedAmount -= item.bufferedBytes;
            this.queuedWireBytes -= item.data.length;
            item.reject(error);
        }
    }

    /**
     * Fragment a large data message and enqueue each fragment so the total
     * bufferedAmount at any moment is at most FRAGMENT_SIZE + existing queue.
     * All fragments are pushed synchronously before drain() runs, so no other
     * concurrent send can interleave frames within this message.
     */
	enqueueData(opcode: OpCode, payload: Uint8Array, precounted = false): Promise<void> {
		if (payload.length <= SEND_FRAGMENT_SIZE)
            return this.enqueue(this.buildFrame(opcode, payload, true, this.isClient), payload.length, precounted);

        if (!precounted && this._bufferedAmount + payload.length > MAX_BUFFERED_AMOUNT)
            return Promise.reject(new Error('WebSocket buffer is full'));

        // Push all frames synchronously — drain() runs asynchronously later, so
        // the entire set is in the queue before any frame is written.
        const promises: Promise<void>[] = [];
        let offset = 0;
        let firstFrame = true;
        const frames: Array<{ frame: Uint8Array; payloadLength: number }> = [];
        let wireBytes = 0;
        while (offset < payload.length) {
            const end = Math.min(offset + SEND_FRAGMENT_SIZE, payload.length);
            const chunk = payload.subarray(offset, end);
            const fin = end === payload.length;
            const frameOpcode = firstFrame ? opcode : OpCode.CONTINUATION;
            const frame = this.buildFrame(frameOpcode, chunk, fin, this.isClient);
            frames.push({ frame, payloadLength: chunk.length });
            wireBytes += frame.length;
            offset = end;
            firstFrame = false;
        }
        if (this.queuedWireBytes + wireBytes > MAX_BUFFERED_AMOUNT) {
            if (precounted) this.releaseData(payload.length);
            return Promise.reject(new Error('WebSocket buffer is full'));
        }
        if (!precounted) this._bufferedAmount += payload.length;
        for (const { frame, payloadLength } of frames) {
            this.queuedWireBytes += frame.length;
            promises.push(new Promise((resolve, reject) => {
                this.queue.push({ data: frame, bufferedBytes: payloadLength, resolve, reject });
            }));
        }
        if (this.connection) this.drain();
        // Observe every fragment promise. Returning only the final one leaves
        // earlier write failures as unhandled rejections when the queue aborts.
        return Promise.all(promises).then(() => undefined);
    }

    close(): void { this.connection = null; this.flushQueue(new Error('WebSocket closed')); }
    buildControlFrame(opcode: OpCode, payload: Uint8Array): Uint8Array { return this.buildFrame(opcode, payload, true, this.isClient); }

    get [Symbol.toStringTag]() {
        return 'SendQueue';
    }
}

export class WebSocket extends EventTarget implements globalThis.WebSocket {
    static readonly CONNECTING = WebSocketReadyState.CONNECTING;
    static readonly OPEN = WebSocketReadyState.OPEN;
    static readonly CLOSING = WebSocketReadyState.CLOSING;
    static readonly CLOSED = WebSocketReadyState.CLOSED;
    readonly CONNECTING = WebSocketReadyState.CONNECTING;
    readonly OPEN = WebSocketReadyState.OPEN;
    readonly CLOSING = WebSocketReadyState.CLOSING;
    readonly CLOSED = WebSocketReadyState.CLOSED;

    public url: string;
    public protocol: string = '';
    public extensions: string = '';
    private _binaryType: 'blob' | 'arraybuffer' = 'blob';

    public get binaryType(): 'blob' | 'arraybuffer' { return this._binaryType; }
    public set binaryType(value: 'blob' | 'arraybuffer') {
        if (value === 'blob' || value === 'arraybuffer') this._binaryType = value;
    }

    private _readyState: WebSocketReadyState = WebSocketReadyState.CONNECTING;
    private connection: IWSSocket | null = null;
    private isClient: boolean;
    // Receive-side buffer: chunks are appended; _rxOffset tracks bytes consumed in chunks[0].
    // The buffer is merged lazily — only when a complete frame cannot be parsed from
    // the existing chunks. After merging, the remainder is kept as a single subarray
    // (zero-copy view) to avoid repeated allocations.
    private _rxChunks: Uint8Array[] = [];
    private _rxOffset = 0;   // bytes already consumed from _rxChunks[0]
    private _rxTotal = 0;    // total unconsumed bytes across all chunks
    private fragments: Uint8Array[] = [];
    private fragmentOpcode: OpCode | null = null;
    private _fragmentBytes = 0;
    private pingInterval: number | null = null;
    private pongTimeout: number | null = null;
    private _wsKey: string = '';
    private _initiatorCallFrames?: NetworkCallFrame[];
    private closeCode: number = WebSocketCloseCode.NO_STATUS;
    private closeReason: string = '';
    private _closeTimer: number | null = null;
    private _failed = false;
    private _failureError: Error | null = null;
    private _closeReceived = false;
    private _closeSendPromise: Promise<void> | null = null;
    private _openEventPending = false;
    private _deferredReadFailure: Error | null = null;
    private sendQueue: SendQueue;
    private dataSendChain: Promise<void> = Promise.resolve();
    private _netRequestId: string = '';
    private _serverMeta?: ServerWebSocketMeta;
    private _serverHandshakeEmitted = false;
    private requestedProtocols: string[] = [];

    public onopen: ((this: globalThis.WebSocket, ev: globalThis.Event) => unknown) | null = null;
    public onmessage: ((this: globalThis.WebSocket, ev: globalThis.MessageEvent) => unknown) | null = null;
    public onerror: ((this: globalThis.WebSocket, ev: globalThis.ErrorEvent | Event) => unknown) | null = null;
    public onclose: ((ev: globalThis.CloseEvent) => unknown) | null = null;

    get bufferedAmount(): number { return this.sendQueue.bufferedAmount; }
    get readyState(): WebSocketReadyState { return this._readyState; }

    [failWebSocket](error: Error): void {
        this.handleConnectionFailure(error);
    }

    private emitOpen(): void {
        const event = new Event('open');
        this.dispatchEvent(event);
        this.onopen?.(event);
    }

    private scheduleOpen(): void {
        this._openEventPending = true;
        timers.setTimeout(() => {
            this._openEventPending = false;
            if (this._readyState === WebSocketReadyState.OPEN) this.emitOpen();
            if (this._rxTotal > 0 && this._readyState !== WebSocketReadyState.CLOSED) this.processFrames();
            const failure = this._deferredReadFailure;
            this._deferredReadFailure = null;
            if (failure && this._readyState !== WebSocketReadyState.CLOSED) this.handleConnectionFailure(failure);
        }, 0);
    }

    constructor(url: string | URL, protocols?: string | string[]);
    constructor(connection: Promise<IWSSocket>, isServer: true);
    constructor(connection: Promise<IWSSocket>, isServer: true, serverMeta?: ServerWebSocketMetaSource);
    constructor(urlOrConnection: string | URL | Promise<IWSSocket>, protocolsOrIsServer?: string | string[] | true, serverMeta?: ServerWebSocketMetaSource) {
        super();
        const isServerConnection = protocolsOrIsServer === true && engine.isPromise(urlOrConnection);
        if (!isServerConnection) {
            this.url = normalizeClientWebSocketUrl(urlOrConnection as string | URL); this.isClient = true;
            this.sendQueue = new SendQueue(null, true, () => this.handleConnectionFailure(new Error('Connection closed')));
            const protocols = validateProtocols(protocolsOrIsServer === true ? undefined : protocolsOrIsServer);
            this.requestedProtocols = protocols;
            this.connectClient();
        } else {
            const syncServerMeta = serverMeta && typeof (serverMeta as Promise<ServerWebSocketMeta | undefined>).then !== 'function'
                ? serverMeta as ServerWebSocketMeta
                : undefined;
            const serverMetaReady = serverMeta && typeof (serverMeta as Promise<ServerWebSocketMeta | undefined>).then === 'function'
                ? (serverMeta as Promise<ServerWebSocketMeta | undefined>).then(meta => {
                    if (!meta) return;
                    this._serverMeta = meta;
                    if (!this.url) this.url = toWebSocketUrl(meta.url);
                    if (!this._netRequestId) this._netRequestId = meta.requestId;
                    if (!this._initiatorCallFrames) this._initiatorCallFrames = meta.callFrames;
                }).catch(() => {})
                : Promise.resolve();
            this.url = syncServerMeta?.url ? toWebSocketUrl(syncServerMeta.url) : ''; this.isClient = false;
            this._serverMeta = syncServerMeta;
            this._netRequestId = syncServerMeta?.requestId ?? '';
            this._initiatorCallFrames = syncServerMeta?.callFrames;
            this.sendQueue = new SendQueue(null, false, () => this.handleConnectionFailure(new Error('Connection closed')));
            this._readyState = WebSocketReadyState.CONNECTING;
            (urlOrConnection as Promise<IWSSocket>).then(conn => {
                serverMetaReady.then(() => {
                if (this._readyState !== WebSocketReadyState.CONNECTING) {
                    closeConnectionQuietly(conn);
                    return;
                }
                this._readyState = WebSocketReadyState.OPEN; this.connection = conn; this.sendQueue.setConnection(conn);
                this.emitServerHandshakeEvents();
                this.scheduleOpen();
                this.startReceiving();
                });
            }).catch(err => { this.handleConnectionFailure(toError(err, 'Connection failed')); });
        }
    }

    private async connectClient(): Promise<void> {
        try {
            const url = new URL(this.url);

            const wsHook = getWebSocketHook();
            if (wsHook) {
                this._netRequestId = `ws-${++_wsIdCounter}`;
                this._initiatorCallFrames = captureWebSocketCallFrames();
            }

            const connection = await connectHttp(url);
            if (this._readyState !== WebSocketReadyState.CONNECTING) {
                closeConnectionQuietly(connection.socket);
                return;
            }
            this.connection = connection.socket;

            await this.sendHandshake(url, connection.requestTarget, connection.proxyAuthorization);
            await this.receiveHandshake();
            if (this._readyState !== WebSocketReadyState.CONNECTING) {
                closeConnectionQuietly(connection.socket);
                this.connection = null;
                return;
            }

            this._readyState = WebSocketReadyState.OPEN;
            this.sendQueue = new SendQueue(this.connection, true, () => this.handleConnectionFailure(new Error('Connection closed')));
            this.scheduleOpen();
            this.startReceiving();
            this.startPingTimer();
        } catch (err) { this.handleConnectionFailure(toError(err)); }
    }

    private async sendHandshake(url: URL, requestTarget?: string, proxyAuthorization?: string): Promise<void> {
        assert(this.connection, "Connection is not established");
        this._wsKey = this.generateWebSocketKey();
        const headers = new Headers({
            'Upgrade': 'websocket', 'Connection': 'Upgrade',
            'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': this._wsKey
        });
        if (this.requestedProtocols.length > 0) {
            headers.set('Sec-WebSocket-Protocol', this.requestedProtocols.join(', '));
        }
        if (proxyAuthorization) headers.set('Proxy-Authorization', proxyAuthorization);
        if (this._netRequestId) {
            const wsHook = getWebSocketHook();
            if (wsHook) {
                emitWebSocketHookQuietly(() => {
                    wsHook.onCreated?.({
                        source: 'fetch',
                        requestId: this._netRequestId,
                        url: url.href,
                        requestHeaders: Array.from(headers.entries()),
                        callFrames: this._initiatorCallFrames,
                        timestamp: wsTs(),
                    });
                });
            }
        }
        await this.connection.write(buildRequest({ method: 'GET', url, headers, requestTarget }));
    }

    private async receiveHandshake(): Promise<void> {
        assert(this.connection, "Connection is not established");
        const parser = new HttpResponseParser();
        const { status, headers, leftover } = await readHeaders(this.connection, parser);

        if (status !== 101) throw new Error(`WebSocket handshake failed: ${status}`);
        const upgrade = responseHeaderValues(headers, 'upgrade');
        const connection = responseHeaderValues(headers, 'connection');
        if (!responseHeaderHasToken(upgrade, 'websocket') || !responseHeaderHasToken(connection, 'upgrade')) {
            throw new Error('Invalid WebSocket handshake response');
        }
        const accepts = responseHeaderValues(headers, 'sec-websocket-accept');
        if (accepts.length === 0) throw new Error('Missing Sec-WebSocket-Accept header');
        if (accepts.length !== 1 || accepts[0] !== this.computeAcceptKey(this._wsKey)) {
            throw new Error('Invalid Sec-WebSocket-Accept header');
        }

        const negotiatedHeaders = responseHeaderValues(headers, 'sec-websocket-protocol');
        if (negotiatedHeaders.length > 1 || negotiatedHeaders[0]?.includes(',')) {
            throw new Error('Server selected multiple WebSocket subprotocols');
        }
        const negotiated = negotiatedHeaders[0] ?? '';
        if (negotiated && !this.requestedProtocols.includes(negotiated)) {
            throw new Error('Server selected an unsupported WebSocket subprotocol');
        }
        this.protocol = negotiated;
        const extensions = responseHeaderValues(headers, 'sec-websocket-extensions');
        if (extensions.length > 0) {
            // This implementation never offers extensions, so the server cannot
            // unilaterally activate one in its response.
            throw new Error('Server selected an unsolicited WebSocket extension');
        }
        this.extensions = '';

        if (this._netRequestId) {
            const wsHook = getWebSocketHook();
            if (wsHook) {
                emitWebSocketHookQuietly(() => {
                    wsHook.onHandshake?.({ source: 'fetch', requestId: this._netRequestId, status, headers, timestamp: wsTs() });
                });
            }
        }
        if (leftover && leftover.byteLength > 0) {
            this._rxChunks.push(leftover);
            this._rxTotal += leftover.byteLength;
        }
    }

    private generateWebSocketKey(): string {
        const key = new Uint8Array(16);
        crypto.randomFill(key);
        return crypto.base64Encode(key);
    }
    private computeAcceptKey(key: string): string { return crypto.base64Encode(crypto.sha1(engine.encodeString(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))); }

    private startReceiving(): void {
        if (!this.connection) return;
        const conn = this.connection;
        conn.onReadable(data => {
            if (data === null) {
                const failure = new Error('Connection closed');
                if (this._openEventPending && this._readyState === WebSocketReadyState.OPEN) {
                    this._deferredReadFailure = failure;
                    return;
                }
                return this.handleConnectionFailure(failure);
            }
            if (data.length === 0 || this._closeReceived || this._readyState === WebSocketReadyState.CLOSED) return;
            this._rxChunks.push(data);
            this._rxTotal += data.length;
            if (this._openEventPending && this._readyState === WebSocketReadyState.OPEN) return;
            this.processFrames();
        });
        if (this._rxTotal > 0 && !this._openEventPending) queueMicrotask(() => this.processFrames());
    }

    private processFrames(): void {
        while (this._rxTotal > 0 && !this._closeReceived && this._readyState !== WebSocketReadyState.CLOSED) {
            const frame = this.parseFrame();
            if (!frame) break;
            this.handleFrame(frame);
        }
    }

    /**
     * Merge all pending chunks into one flat Uint8Array and reset the chunk list.
     * Called only when multiple chunks are present — avoids allocation when there is
     * already exactly one chunk (the common case for small frames).
     */
    private _rxMerge(): Uint8Array {
        const chunks = this._rxOffset > 0 ? this._rxChunks.slice() : this._rxChunks;
        if (this._rxOffset > 0) {
            const first = chunks[0];
            assert(first, 'WebSocket receive buffer is empty');
            chunks[0] = first.subarray(this._rxOffset);
        }
        const merged = concatChunks(chunks);
        this._rxChunks = [merged];
        this._rxOffset = 0;
        return merged;
    }

    private parseFrame(): WebSocketFrame | null {
        if (this._rxTotal < 2) return null;

        // Ensure we have a single flat view for header inspection.
        // For the common path (one chunk already flat) this is a free subarray.
        let buffer: Uint8Array;
        if (this._rxChunks.length === 1) {
            const first = this._rxChunks[0];
            assert(first, 'WebSocket receive buffer is empty');
            buffer = first;
            if (this._rxOffset > 0) buffer = buffer.subarray(this._rxOffset);
        } else {
            buffer = this._rxMerge();
        }

        const byte1 = buffer[0], byte2 = buffer[1];
        if (byte1 === undefined || byte2 === undefined) return null;
        const fin    = (byte1 & 0x80) !== 0;
        const opcode =  byte1 & 0x0F;
        const masked = (byte2 & 0x80) !== 0;
        let payloadLength = byte2 & 0x7F;
        let offset = 2;
        const isControl = (opcode & 0x08) !== 0;
        const knownOpcode = opcode === OpCode.CONTINUATION
            || opcode === OpCode.TEXT
            || opcode === OpCode.BINARY
            || opcode === OpCode.CLOSE
            || opcode === OpCode.PING
            || opcode === OpCode.PONG;

        if ((byte1 & 0x70) !== 0 || !knownOpcode || (isControl && !fin) || masked === this.isClient) {
            this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Invalid WebSocket frame');
            return null;
        }
        if (isControl && payloadLength > 125) {
            this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Invalid control frame');
            return null;
        }

        if (payloadLength === 126) {
            if (this._rxTotal < 4) return null;
            const lenHi = buffer[2], lenLo = buffer[3];
            if (lenHi === undefined || lenLo === undefined) return null;
            payloadLength = (lenHi << 8) | lenLo;
            if (payloadLength < 126) {
                this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Non-minimal payload length');
                return null;
            }
            offset = 4;
        } else if (payloadLength === 127) {
            if (this._rxTotal < 10) return null;
            const h0 = buffer[2], h1 = buffer[3], h2 = buffer[4], h3 = buffer[5];
            const h4 = buffer[6], h5 = buffer[7], h6 = buffer[8], h7 = buffer[9];
            if (
                h0 === undefined || h1 === undefined || h2 === undefined || h3 === undefined
                || h4 === undefined || h5 === undefined || h6 === undefined || h7 === undefined
            ) return null;
            if ((h0 & 0x80) !== 0) {
                this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Invalid payload length');
                return null;
            }
            if ((h0 | h1 | h2 | h3) !== 0) { this.failConnection(WebSocketCloseCode.MESSAGE_TOO_BIG, 'Frame payload too large'); return null; }
            payloadLength = h4 * 0x1000000 + h5 * 0x10000
                          + h6 * 0x100     + h7;
            if (payloadLength <= 65535) {
                this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Non-minimal payload length');
                return null;
            }
            offset = 10;
        }
        if (payloadLength > MAX_BUFFERED_AMOUNT) {
            this.failConnection(WebSocketCloseCode.MESSAGE_TOO_BIG, 'Frame payload too large');
            return null;
        }

        let maskKey: Uint8Array | null = null;
        if (masked) {
            if (this._rxTotal < offset + 4) return null;
            // subarray — zero-copy view for the 4-byte mask key
            maskKey = buffer.subarray(offset, offset + 4);
            offset += 4;
        }
        if (this._rxTotal < offset + payloadLength) return null;

        const frameLength = offset + payloadLength;

        // payload: subarray (zero-copy) before masking; wsMask (C) produces the
        // unmasked result as a new Uint8Array — unavoidable for correctness.
        let payload = buffer.subarray(offset, offset + payloadLength);
        if (masked && maskKey && payload.length > 0) payload = toOwnedBytes(algo.wsMask(payload, maskKey));

        // Advance cursor: keep the remainder as a subarray — no copy.
        if (frameLength === this._rxTotal) {
            this._rxChunks = [];
            this._rxOffset = 0;
        } else {
            this._rxChunks = [buffer.subarray(frameLength)];
            this._rxOffset = 0;
        }
        this._rxTotal -= frameLength;

        return { fin, opcode, masked, payload };
    }

    private handleFrame(frame: WebSocketFrame): void {
        switch (frame.opcode) {
            case OpCode.TEXT: case OpCode.BINARY:
                if (this.fragmentOpcode !== null) {
                    this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Expected continuation frame');
                    return;
                }
                if (frame.fin) this.emitMessage(frame.opcode, frame.payload);
                else {
                    this.fragmentOpcode = frame.opcode;
                    this.fragments = [frame.payload];
                    this._fragmentBytes = frame.payload.length;
                }
                break;
            case OpCode.CONTINUATION:
                if (this.fragmentOpcode === null) {
                    this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Unexpected continuation frame');
                    return;
                }
                this._fragmentBytes = (this._fragmentBytes ?? 0) + frame.payload.length;
                if (this._fragmentBytes > MAX_BUFFERED_AMOUNT) {
                    this.failConnection(WebSocketCloseCode.MESSAGE_TOO_BIG, 'Message too large');
                    return;
                }
                this.fragments.push(frame.payload);
                if (frame.fin) {
                    const combined = concatChunks(this.fragments);
                    this.emitMessage(this.fragmentOpcode, combined);
                    this.fragmentOpcode = null;
                    this.fragments = [];
                    this._fragmentBytes = 0;
                }
                break;
            case OpCode.CLOSE: this.handleCloseFrame(frame.payload); break;
            case OpCode.PING: this.sendPong(frame.payload); break;
            case OpCode.PONG: this.handlePong(); break;
            default: this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Unknown opcode');
        }
    }

    public send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
        if (this._readyState === WebSocketReadyState.CONNECTING) {
            throw new DOMException('Sent before connected.', 'InvalidStateError');
        }
        if (this._readyState !== WebSocketReadyState.OPEN) return;
        const blobSize = getBlobSize(data);
        if (blobSize !== undefined) {
            this.queueData(OpCode.BINARY, blobSize, async () => {
                const buffer = await Reflect.apply(blobArrayBuffer, data, []) as ArrayBuffer;
                return new Uint8Array(buffer);
            });
        } else if (engine.isArrayBuffer(data)) {
            const payload = toOwnedBytes(new Uint8Array(data as ArrayBuffer));
            this.queueData(OpCode.BINARY, payload.length, () => payload);
        } else if (isArrayBufferView(data)) {
            const payload = viewBytes(data);
            this.queueData(OpCode.BINARY, payload.length, () => payload);
        } else {
            if (typeof data === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
            const text = sanitizeSurrogates(String(data));
            // RFC 6455 text frames must be valid UTF-8, so WTF-8 is not an option.
            const payload = engine.encodeString(text);
            this.queueData(OpCode.TEXT, payload.length, () => payload);
        }
    }

    private queueData(opcode: OpCode, byteLength: number, payload: () => Uint8Array | Promise<Uint8Array>): void {
        if (!this.sendQueue.reserveData(byteLength)) {
            queueMicrotask(() => this.handleConnectionFailure(new Error('WebSocket buffer is full')));
            return;
        }
        const task = this.dataSendChain.then(async () => {
            if (!this.canSendQueuedData()) {
                this.sendQueue.releaseData(byteLength);
                return;
            }
            let bytes: Uint8Array;
            try { bytes = await payload(); }
            catch (error) {
                this.sendQueue.releaseData(byteLength);
                if (!this.canSendQueuedData()) return;
                throw toError(error, 'WebSocket data conversion failed');
            }
            if (!this.canSendQueuedData()) {
                this.sendQueue.releaseData(byteLength);
                return;
            }
            await this.sendFrame(opcode, bytes, true);
        });
        this.dataSendChain = task.catch(error => {
            this.handleConnectionFailure(toError(error, 'WebSocket send failed'));
        });
    }

    private canSendQueuedData(): boolean {
        return !this._closeReceived && !this._failed
            && (this._readyState === WebSocketReadyState.OPEN || this._readyState === WebSocketReadyState.CLOSING);
    }

    private async sendFrame(opcode: OpCode, payload: Uint8Array, precounted = false): Promise<void> {
        // A CLOSE frame is sent *while* readyState is already CLOSING (RFC 6455
        // §5.5.1 requires the closing handshake), so only data frames need OPEN.
        const isData = opcode === OpCode.TEXT || opcode === OpCode.BINARY;
        const okState = opcode === OpCode.CLOSE
            ? (this._readyState === WebSocketReadyState.OPEN || this._readyState === WebSocketReadyState.CLOSING)
            : this._readyState === WebSocketReadyState.OPEN
                || (isData && precounted && this._readyState === WebSocketReadyState.CLOSING
                    && !this._closeReceived && !this._failed);
        if (!okState) {
            if (precounted) this.sendQueue.releaseData(payload.length);
            throw new Error('WebSocket is not open');
        }
        let handedToQueue = false;
        try {
            if (this._netRequestId && (opcode === OpCode.TEXT || opcode === OpCode.BINARY)) {
                const wsHook = getWebSocketHook();
                if (wsHook) {
                    const hookPayload = opcode === OpCode.TEXT
                        ? decodeTextFrame(payload)
                        : hookBase64(payload);
                    const frame: WSFrameInfo = {
                        source: this.isClient ? 'fetch' : 'serve',
                        requestId: this._netRequestId, opcode, masked: this.isClient,
                        payloadData: hookPayload,
                        payloadLength: payload.byteLength, timestamp: wsTs(),
                    };
                    emitWebSocketHookQuietly(() => { wsHook.onFrameSent?.(frame); });
                }
            }
            // Data frames may be fragmented; control frames (PING/PONG/CLOSE) must not.
            const queued = isData
                ? this.sendQueue.enqueueData(opcode, payload, precounted)
                : this.sendQueue.enqueue(this.sendQueue.buildControlFrame(opcode, payload));
            handedToQueue = true;
            await queued;
        } catch (error) {
            if (precounted && !handedToQueue) this.sendQueue.releaseData(payload.length);
            throw error;
        }
    }

    public close(code: number = WebSocketCloseCode.NORMAL, reason: string = ''): void {
        const normalizedCode = normalizeCloseCode(code);
        const normalizedReason = sanitizeSurrogates(String(reason));
        const reasonBytes = encodeCloseReason(normalizedReason);
        if (this._readyState === WebSocketReadyState.CONNECTING) {
            this._readyState = WebSocketReadyState.CLOSING;
            // Failing a connection queues the error/close tasks. It must not put
            // a CLOSE frame into a send queue that has no socket yet.
            timers.setTimeout(() => {
                if (this._readyState === WebSocketReadyState.CLOSING) {
                    this.handleConnectionFailure(new Error('WebSocket closed while connecting'));
                }
            }, 0);
            return;
        }
        this.initiateClose(normalizedCode, normalizedReason, reasonBytes);
    }

    /** Protocol-generated close codes are not subject to the public API's code allow-list. */
    private initiateClose(code: number, reason: string, reasonBytes = encodeCloseReason(reason)): void {
        if (this._readyState === WebSocketReadyState.CLOSING || this._readyState === WebSocketReadyState.CLOSED) return;
        this._readyState = WebSocketReadyState.CLOSING;
        const payload = new Uint8Array(2 + reasonBytes.length);
        payload[0] = (code >> 8) & 0xFF; payload[1] = code & 0xFF;
        if (reasonBytes.length > 0) payload.set(reasonBytes, 2);
        this.queueCloseFrame(payload).then(() => {
            // A timeout means the peer never completed the closing handshake.
            if (this._readyState === WebSocketReadyState.CLOSING) {
                this._closeTimer = timers.setTimeout(() => {
                    this._closeTimer = null;
                    this.handleConnectionFailure(new Error('WebSocket closing handshake timed out'));
                }, 1000);
            }
        }).catch(() => { this.handleConnectionFailure(new Error('WebSocket close frame could not be sent')); });
    }

    private queueCloseFrame(payload: Uint8Array): Promise<void> {
        if (this._closeSendPromise) return this._closeSendPromise;
        this._closeSendPromise = this.dataSendChain.then(() => {
            if (this._readyState !== WebSocketReadyState.CLOSING) {
                throw new Error('WebSocket is not closing');
            }
            return this.sendFrame(OpCode.CLOSE, payload);
        });
        return this._closeSendPromise;
    }

    private failConnection(code: number, reason: string): void {
        // Once a frame has made the connection fail, none of the bytes already
        // buffered beside it may be interpreted as a fresh frame. In particular,
        // retaining a rejected header would parse it again when the peer's CLOSE
        // response arrives and would abort an otherwise valid close handshake.
        this._rxChunks = [];
        this._rxOffset = 0;
        this._rxTotal = 0;
        this._failed = true;
        const failure = this._failureError ?? new Error(reason || 'WebSocket protocol error');
        this._failureError = failure;
        if (this._readyState === WebSocketReadyState.OPEN) {
            this._readyState = WebSocketReadyState.CLOSING;
            const reasonBytes = encodeCloseReason(reason);
            const payload = new Uint8Array(2 + reasonBytes.length);
            payload[0] = (code >> 8) & 0xff;
            payload[1] = code & 0xff;
            payload.set(reasonBytes, 2);
            const finish = () => this.handleConnectionFailure(failure);
            this._closeTimer = timers.setTimeout(() => {
                this._closeTimer = null;
                finish();
            }, 1000);
            // The protocol close code is sent on the wire, but a failed WebSocket
            // connection is exposed to script as the reserved code 1006.
            this.sendFrame(OpCode.CLOSE, payload).then(finish, finish);
        } else if (this._readyState === WebSocketReadyState.CLOSING) {
            // A malformed peer frame cannot complete an in-flight close
            // handshake. Do not let initiateClose() silently ignore it.
            this.handleConnectionFailure(failure);
        }
    }

    private handleConnectionFailure(error: Error): void {
        if (this._readyState === WebSocketReadyState.CLOSED) return;
        this.handleClose(WebSocketCloseCode.ABNORMAL, '', false, error);
    }

    private handleCloseFrame(payload: Uint8Array): void {
        let code = WebSocketCloseCode.NO_STATUS; let reason = '';
        if (payload.length === 1) {
            this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Invalid close payload');
            return;
        }
        if (payload.length >= 2) {
            const codeHi = payload[0], codeLo = payload[1];
            if (codeHi !== undefined && codeLo !== undefined) code = (codeHi << 8) | codeLo;
            if (!isValidReceivedCloseCode(code)) {
                this.failConnection(WebSocketCloseCode.PROTOCOL_ERROR, 'Invalid close code');
                return;
            }
            if (payload.length > 2) {
                try {
                    reason = decodeTextFrame(payload.slice(2));
                } catch {
                    this.failConnection(WebSocketCloseCode.INVALID_PAYLOAD, 'Invalid UTF-8');
                    return;
                }
            }
        }
        // RFC 6455: after receiving CLOSE, discard any further data. This also
        // prevents a data frame coalesced after CLOSE in the same socket read
        // from being delivered while the echo write is still pending.
        this._closeReceived = true;
        this._rxChunks = [];
        this._rxOffset = 0;
        this._rxTotal = 0;
        if (this._readyState === WebSocketReadyState.OPEN) {
            this._readyState = WebSocketReadyState.CLOSING;
            // The echo must reach the wire before handleClose() destroys the
            // socket, so tear down only after the write settles.
            this.queueCloseFrame(payload)
                .then(() => { this.handleClose(code, reason, true); })
                .catch(() => { this.handleConnectionFailure(new Error('WebSocket close response could not be sent')); });
            return;
        }
        if (this._failed) {
            this.handleConnectionFailure(this._failureError ?? new Error('WebSocket protocol error'));
        } else {
            // CLOSING does not prove that our CLOSE reached the wire: it can
            // still be queued behind application data when the peer's arrives.
            this.queueCloseFrame(payload)
                .then(() => { this.handleClose(code, reason, true); })
                .catch(() => { this.handleConnectionFailure(new Error('WebSocket close response could not be sent')); });
        }
    }

    private handleClose(code: number, reason: string, cleanHandshake = false, failureError?: Error): void {
        if (this._readyState === WebSocketReadyState.CLOSED) return;
        if (code === WebSocketCloseCode.ABNORMAL && !failureError) {
            failureError = new Error(reason || 'WebSocket connection failed');
        }
        if (this._closeTimer !== null) {
            timers.clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }
        this._readyState = WebSocketReadyState.CLOSED;
        this.closeCode = code;
        this.closeReason = reason;
        this.stopPingTimer();
        this.sendQueue.close();
        if (this.connection) {
            closeConnectionQuietly(this.connection);
            this.connection = null;
        }
        // Release accumulated fragment data so it can be GC'd.
        this.fragments = [];
        this.fragmentOpcode = null;

        if (this._netRequestId) {
            const wsHook = getWebSocketHook();
            if (wsHook) {
                emitWebSocketHookQuietly(() => {
                    wsHook.onClosed?.({ source: this.isClient ? 'fetch' : 'serve', requestId: this._netRequestId, code, reason, timestamp: wsTs() });
                });
            }
            this._netRequestId = '';
        }

        // wasClean reflects whether the closing handshake completed, not which
        // code was used: close(3001) or a peer's 1001 is still a clean close.
        // Message delivery and connection-close notifications use the same task
        // queue. A data frame preceding CLOSE in one read must be observed first.
        timers.setTimeout(() => {
            if (failureError) {
                try { this.emitError(failureError); } catch { /* event handlers cannot suppress close */ }
            }
            const event = new CloseEvent('close', { code, reason, wasClean: cleanHandshake }, true);
            this.dispatchEvent(event);
            this.onclose?.(event);
        }, 0);
    }

    private sendPong(payload: Uint8Array): void {
        if (this._readyState === WebSocketReadyState.OPEN) {
            this.sendFrame(OpCode.PONG, payload).catch(() => {});
        }
    }
    private handlePong(): void {
        if (this.pongTimeout !== null) {
            timers.clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    private startPingTimer(): void {
        this.pingInterval = timers.setInterval(() => {
            if (this._readyState === WebSocketReadyState.OPEN) {
                this.sendFrame(OpCode.PING, new Uint8Array(0)).catch(() => {});
                this.pongTimeout = timers.setTimeout(() => {
                    this.handleConnectionFailure(new Error('WebSocket ping timed out'));
                }, 5000);
            }
        }, 30000);
    }

    private stopPingTimer(): void {
        if (this.pingInterval !== null) {
            timers.clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.pongTimeout !== null) {
            timers.clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    private emitMessage(opcode: OpCode, payload: Uint8Array): void {
        let data: string | ArrayBuffer | Blob;
        if (opcode === OpCode.TEXT) {
            try {
                data = decodeTextFrame(payload);
            } catch {
                this.failConnection(WebSocketCloseCode.INVALID_PAYLOAD, 'Invalid UTF-8');
                return;
            }
        }
        else data = this.binaryType === 'arraybuffer' ? bytesToArrayBuffer(payload) : new Blob([payload]);

        if (this._netRequestId) {
            const wsHook = getWebSocketHook();
            if (wsHook) {
                const hookPayload = opcode === OpCode.TEXT
                    ? decodeTextFrame(payload)
                    : hookBase64(payload);
                const frame: WSFrameInfo = {
                    source: this.isClient ? 'fetch' : 'serve',
                    requestId: this._netRequestId, opcode, masked: !this.isClient,
                    payloadData: hookPayload,
                    payloadLength: payload.byteLength, timestamp: wsTs(),
                };
                emitWebSocketHookQuietly(() => {
                    wsHook.onFrameReceived?.(frame);
                });
            }
        }

        timers.setTimeout(() => {
            const event = new MessageEvent('message', { data }, true);
            this.dispatchEvent(event); this.onmessage?.(event);
        }, 0);
    }

    private emitError(error: Error): void {
        const event = new ErrorEvent('error', { error, message: error.message }, true);
        this.dispatchEvent(event); this.onerror?.(event);
    }

    private emitServerHandshakeEvents(): void {
        const meta = this._serverMeta;
        const wsHook = getWebSocketHook();
        if (!meta || !wsHook || !this._netRequestId || this._serverHandshakeEmitted) return;
        this._serverHandshakeEmitted = true;
        emitWebSocketHookQuietly(() => {
            wsHook.onCreated?.({
                source: meta.source,
                requestId: this._netRequestId,
                url: toWebSocketUrl(meta.url),
                requestHeaders: meta.requestHeaders,
                callFrames: meta.callFrames,
                timestamp: wsTs(),
            });
        });
        if (meta.responseStatus != null && meta.responseHeaders) {
            const responseStatus = meta.responseStatus;
            const responseHeaders = meta.responseHeaders;
            emitWebSocketHookQuietly(() => {
                wsHook.onHandshake?.({
                    source: meta.source,
                    requestId: this._netRequestId,
                    status: responseStatus,
                    headers: responseHeaders,
                    timestamp: wsTs(),
                });
            });
        }
    }

    addEventListener<K extends keyof WebSocketEventMap>(
        type: K,
        listener: ((this: WebSocket, ev: WebSocketEventMap[K]) => void) | EventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void {
        super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
    }
    removeEventListener<K extends keyof WebSocketEventMap>(
        type: K,
        listener: ((this: WebSocket, ev: WebSocketEventMap[K]) => void) | EventListenerObject | null,
        options?: boolean | EventListenerOptions
    ): void {
        super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
    }

    get [Symbol.toStringTag]() {
        return 'WebSocket';
    }
}

export interface WebSocketStreamOptions { protocols?: string | string[]; }
export interface WebSocketStreamConnection { readable: ReadableStream<Uint8Array | string>; writable: WritableStream<Uint8Array | string>; extensions: string; protocol: string; }

export class WebSocketStream {
    private ws: WebSocket;
    private readableController: ReadableStreamController<string | Uint8Array> | null = null;
    private messageChain: Promise<void> = Promise.resolve();
    private messageError: Error | null = null;
    private _openedResolve: (value: WebSocketStreamConnection) => void = () => {};
    private _openedReject: ((reason: Error) => void) | null = null;
    private _closedResolve: (value: { closeCode: number; reason: string }) => void = () => {};
    private _closedReject: (reason: Error) => void = () => {};
    readonly opened: Promise<WebSocketStreamConnection>;
    readonly closed: Promise<{ closeCode: number; reason: string }>;

    constructor(url: string | URL, options?: WebSocketStreamOptions) {
        this.opened = new Promise((resolve, reject) => { this._openedResolve = resolve; this._openedReject = reject; });
        this.closed = new Promise((resolve, reject) => {
            this._closedResolve = resolve;
            this._closedReject = reject;
        });
        void this.closed.catch(() => {});
        this.ws = new WebSocket(typeof url === 'string' ? url : url.toString(), options?.protocols);
        this.ws.binaryType = 'arraybuffer';
        this.setupEventHandlers();
    }

    private setupEventHandlers(): void {
        this.ws.addEventListener('open', () => {
            this._openedResolve({
                readable: this.createReadableStream(), writable: this.createWritableStream(),
                extensions: this.ws.extensions, protocol: this.ws.protocol
            });
            this._openedReject = null;
        });
        this.ws.addEventListener('message', (event: MessageEvent) => {
            const data = event.data;
            this.messageChain = this.messageChain.then(async () => {
                const controller = this.readableController as unknown as { enqueue(chunk: string | Uint8Array): void } | null;
                if (!controller || this.messageError) return;
                if (typeof data === 'string') controller.enqueue(data);
                else if (engine.isArrayBuffer(data)) controller.enqueue(new Uint8Array(data as ArrayBuffer));
                else if (getBlobSize(data) !== undefined) {
                    const buffer = await Reflect.apply(blobArrayBuffer, data, []) as ArrayBuffer;
                    controller.enqueue(new Uint8Array(buffer));
                }
            }).catch(err => {
                const error = toError(err, 'Message processing failed');
                this.messageError = error;
                if (this.readableController) {
                    errorReadableControllerQuietly(this.readableController, error);
                    this.readableController = null;
                }
                this.ws[failWebSocket](error);
            });
        });
        this.ws.addEventListener('close', (e: globalThis.CloseEvent) => {
            void this.messageChain.then(() => {
                if (this.readableController) {
                    if (this.messageError) errorReadableControllerQuietly(this.readableController, this.messageError);
                    else closeReadableControllerQuietly(this.readableController);
                    this.readableController = null;
                }
                if (this.messageError) this._closedReject(this.messageError);
                else if (e.wasClean) this._closedResolve({ closeCode: e.code, reason: e.reason });
                else this._closedReject(new Error('WebSocket connection closed abnormally'));
                this._closedResolve = () => {};
                this._closedReject = () => {};
            });
        });
        this.ws.addEventListener('error', () => {
            const error = new Error('WebSocket connection failed');
            if (this._openedReject) {
                this._openedReject(error);
                this._openedReject = null;
            }
            if (this.readableController) {
                errorReadableControllerQuietly(this.readableController, error);
                this.readableController = null;
            }
        });
    }

    get binaryType(): 'blob' | 'arraybuffer' { return this.ws.binaryType; }
    set binaryType(value: 'blob' | 'arraybuffer') { this.ws.binaryType = value; }
    get bufferedAmount(): number { return this.ws.bufferedAmount; }
    get extensions(): string { return this.ws.extensions; }
    get protocol(): string { return this.ws.protocol; }
    get readyState(): WebSocketReadyState { return this.ws.readyState; }
    get url(): string { return this.ws.url; }

    close(closeInfo?: { closeCode?: number; reason?: string }): void {
        this.ws.close(closeInfo?.closeCode ?? WebSocketCloseCode.NORMAL, closeInfo?.reason ?? '');
    }

    private createReadableStream(): ReadableStream<Uint8Array | string> {
        const self = this;
        return new ReadableStream<Uint8Array | string>({
            start(controller) { self.readableController = controller; },
            pull() { },
            cancel(reason) { self.close({ reason: String(reason) }); }
        }, { highWaterMark: HIGH_WATER_MARK });
    }

    private createWritableStream(): WritableStream<Uint8Array | string> {
        const self = this;
        return new WritableStream<Uint8Array | string>({
            async write(chunk, controller) {
                if (self.ws.readyState !== WebSocketReadyState.OPEN) {
                    controller.error(new Error('WebSocket is not open'));
                    return;
                }
                self.ws.send(chunk);
                while (self.ws.bufferedAmount > HIGH_WATER_MARK) await new Promise<void>(resolve => timers.setTimeout(resolve, 16));
            },
            close() { self.close(); },
            abort(reason) { self.close({ reason: String(reason) }); }
        }, { highWaterMark: HIGH_WATER_MARK });
    }

    get [Symbol.toStringTag]() {
        return 'WebSocketStream';
    }
}

export function createWebSocketFromConnection(connection: Promise<IWSSocket>, serverMeta?: ServerWebSocketMetaSource): WebSocket {
    return new WebSocket(connection, true, serverMeta);
}

Reflect.set(globalThis, 'WebSocket', WebSocket);
Reflect.set(globalThis, 'WebSocketStream', WebSocketStream);
