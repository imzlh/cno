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
import { bytesToArrayBuffer, concatChunks, toOwnedBytes } from "../utils/bytes";
import { getTierLimits } from '../utils/memory-tier';
import { captureUserNetworkCallFrames, getWebSocketHook, type NetworkCallFrame, type NetworkSource, type WSFrameInfo } from '../utils/network-hooks';
import { CloseEvent, DOMException, ErrorEvent, MessageEvent } from "./events";

const engine = import.meta.use('engine');
const algo = import.meta.use('algorithm');
const crypto = import.meta.use('crypto');
const timers = import.meta.use('timers');

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

function toError(error: unknown, fallback = String(error)): Error {
    return error instanceof Error ? error : new Error(fallback);
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

function validateProtocols(protocols?: string | string[]): string[] {
    if (protocols === undefined) return [];
    const list = (Array.isArray(protocols) ? protocols : [protocols]).map((protocol) => String(protocol));
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

function validateCloseCode(code: number): void {
    if (code === WebSocketCloseCode.NORMAL || (code >= 3000 && code <= 4999)) return;
    throw new DOMException('The close code must be 1000 or in the range 3000 to 4999', 'InvalidAccessError');
}

function encodeCloseReason(reason: string): Uint8Array {
    const reasonBytes = reason ? engine.encodeString(reason) : new Uint8Array(0);
    if (reasonBytes.byteLength > 123) {
        throw new DOMException('The close reason must not be longer than 123 bytes', 'SyntaxError');
    }
    return reasonBytes;
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
    private queue: Array<{ data: Uint8Array; resolve: () => void; reject: (e: Error) => void }> = [];
    private pending = false;
    private connection: IWSSocket | null;
    private isClient: boolean;
    private onClose: () => void;
    private _bufferedAmount = 0;
    get bufferedAmount() { return this._bufferedAmount; }

    constructor(connection: IWSSocket | null, isClient: boolean, onClose: () => void) {
        this.connection = connection; this.isClient = isClient; this.onClose = onClose;
    }

    enqueue(data: Uint8Array): Promise<void> {
        if (this._bufferedAmount + data.length > MAX_BUFFERED_AMOUNT)
            return Promise.reject(new Error('WebSocket buffer is full'));
        this._bufferedAmount += data.length;
        return new Promise((resolve, reject) => {
            this.queue.push({ data, resolve, reject });
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
                this._bufferedAmount -= item.data.length; item.resolve();
            } catch (e) {
                this._bufferedAmount -= item.data.length; item.reject(toError(e));
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
            this._bufferedAmount -= item.data.length;
            item.reject(error);
        }
    }

    /**
     * Fragment a large data message and enqueue each fragment so the total
     * bufferedAmount at any moment is at most FRAGMENT_SIZE + existing queue.
     * All fragments are pushed synchronously before drain() runs, so no other
     * concurrent send can interleave frames within this message.
     */
	enqueueData(opcode: OpCode, payload: Uint8Array): Promise<void> {
		if (payload.length <= SEND_FRAGMENT_SIZE)
            return this.enqueue(this.buildFrame(opcode, payload, true, this.isClient));

        if (this._bufferedAmount + payload.length > MAX_BUFFERED_AMOUNT)
            return Promise.reject(new Error('WebSocket buffer is full'));

        // Push all frames synchronously — drain() runs asynchronously later, so
        // the entire set is in the queue before any frame is written.
        const promises: Promise<void>[] = [];
        let offset = 0;
        let firstFrame = true;
        while (offset < payload.length) {
            const end = Math.min(offset + SEND_FRAGMENT_SIZE, payload.length);
            const chunk = payload.subarray(offset, end);
            const fin = end === payload.length;
            const frameOpcode = firstFrame ? opcode : OpCode.CONTINUATION;
            const frame = this.buildFrame(frameOpcode, chunk, fin, this.isClient);
            this._bufferedAmount += frame.length;
            promises.push(new Promise((resolve, reject) => {
                this.queue.push({ data: frame, resolve, reject });
            }));
            offset = end;
            firstFrame = false;
        }
        if (this.connection) this.drain();
        const lastPromise = promises[promises.length - 1];
        return lastPromise ?? Promise.resolve();
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
    private pingInterval: number | null = null;
    private pongTimeout: number | null = null;
    private _wsKey: string = '';
    private _initiatorCallFrames?: NetworkCallFrame[];
    private closeCode: number = WebSocketCloseCode.NO_STATUS;
    private closeReason: string = '';
    private _closeTimer: number | null = null;
    private sendQueue: SendQueue;
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

    private emitOpen(): void {
        const event = new Event('open');
        this.dispatchEvent(event);
        this.onopen?.(event);
    }

    private scheduleOpen(): void {
        timers.setTimeout(() => {
            if (this._readyState !== WebSocketReadyState.OPEN) return;
            this.emitOpen();
        }, 0);
    }

    constructor(url: string | URL, protocols?: string | string[]);
    constructor(connection: Promise<IWSSocket>, isServer: true);
    constructor(connection: Promise<IWSSocket>, isServer: true, serverMeta?: ServerWebSocketMetaSource);
    constructor(urlOrConnection: string | URL | Promise<IWSSocket>, protocolsOrIsServer?: string | string[] | true, serverMeta?: ServerWebSocketMetaSource) {
        super();
        if (typeof urlOrConnection === 'string' || urlOrConnection instanceof URL) {
            this.url = normalizeClientWebSocketUrl(urlOrConnection); this.isClient = true;
            this.sendQueue = new SendQueue(null, true, () => this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed'));
            const protocols = validateProtocols(
                typeof protocolsOrIsServer === 'string' || Array.isArray(protocolsOrIsServer)
                    ? protocolsOrIsServer
                    : undefined
            );
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
            this.sendQueue = new SendQueue(null, false, () => this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed'));
            this._readyState = WebSocketReadyState.CONNECTING;
            urlOrConnection.then(conn => {
                serverMetaReady.then(() => {
                if (this._readyState === WebSocketReadyState.CLOSED) return;
                this._readyState = WebSocketReadyState.OPEN; this.connection = conn; this.sendQueue.setConnection(conn);
                this.emitServerHandshakeEvents();
                this.scheduleOpen();
                this.startReceiving();
                });
            }).catch(err => {
                this._readyState = WebSocketReadyState.CLOSED;
                this.emitError(err instanceof Error ? err : new Error('Connection failed'));
            });
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
            this.connection = connection.socket;

            await this.sendHandshake(url, connection.requestTarget, connection.proxyAuthorization);
            await this.receiveHandshake();

            this._readyState = WebSocketReadyState.OPEN;
            this.sendQueue = new SendQueue(this.connection, true, () => this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed'));
            this.scheduleOpen();
            this.startReceiving();
            this.startPingTimer();
        } catch (err) { this._readyState = WebSocketReadyState.CLOSED; this.emitError(toError(err)); }
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
        const upgrade = headers.find(([n]) => n === 'upgrade')?.[1]?.toLowerCase();
        const connection = headers.find(([n]) => n === 'connection')?.[1]?.toLowerCase();
        if (upgrade !== 'websocket' || !connection?.includes('upgrade')) throw new Error('Invalid WebSocket handshake response');
        const accept = headers.find(([n]) => n === 'sec-websocket-accept')?.[1];
        if (!accept) throw new Error('Missing Sec-WebSocket-Accept header');
        if (accept !== this.computeAcceptKey(this._wsKey)) throw new Error('Invalid Sec-WebSocket-Accept header');

        const negotiated = headers.find(([n]) => n === 'sec-websocket-protocol')?.[1]?.trim() ?? '';
        if (negotiated && !this.requestedProtocols.includes(negotiated)) {
            throw new Error('Server selected an unsupported WebSocket subprotocol');
        }
        this.protocol = negotiated;
        this.extensions = headers.find(([n]) => n === 'sec-websocket-extensions')?.[1]?.trim() ?? '';

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
            if (data === null) return this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed');
            if (data.length === 0) return;
            this._rxChunks.push(data);
            this._rxTotal += data.length;
            this.processFrames();
        });
        if (this._rxTotal > 0) queueMicrotask(() => this.processFrames());
    }

    private processFrames(): void {
        while (this._rxTotal > 0) {
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

        if (payloadLength === 126) {
            if (this._rxTotal < 4) return null;
            const lenHi = buffer[2], lenLo = buffer[3];
            if (lenHi === undefined || lenLo === undefined) return null;
            payloadLength = (lenHi << 8) | lenLo;
            offset = 4;
        } else if (payloadLength === 127) {
            if (this._rxTotal < 10) return null;
            const h0 = buffer[2], h1 = buffer[3], h2 = buffer[4], h3 = buffer[5];
            const h4 = buffer[6], h5 = buffer[7], h6 = buffer[8], h7 = buffer[9];
            if (
                h0 === undefined || h1 === undefined || h2 === undefined || h3 === undefined
                || h4 === undefined || h5 === undefined || h6 === undefined || h7 === undefined
            ) return null;
            if ((h0 | h1 | h2 | h3) !== 0) { this.close(WebSocketCloseCode.MESSAGE_TOO_BIG, 'Frame payload too large'); return null; }
            payloadLength = h4 * 0x1000000 + h5 * 0x10000
                          + h6 * 0x100     + h7;
            offset = 10;
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
                if (frame.fin) this.emitMessage(frame.opcode, frame.payload);
                else { this.fragmentOpcode = frame.opcode; this.fragments = [frame.payload]; }
                break;
            case OpCode.CONTINUATION:
                if (this.fragmentOpcode === null) {
                    this.close(WebSocketCloseCode.PROTOCOL_ERROR, 'Unexpected continuation frame');
                    return;
                }
                this.fragments.push(frame.payload);
                if (frame.fin) {
                    const combined = concatChunks(this.fragments);
                    this.emitMessage(this.fragmentOpcode, combined);
                    this.fragmentOpcode = null;
                    this.fragments = [];
                }
                break;
            case OpCode.CLOSE: this.handleCloseFrame(frame.payload); break;
            case OpCode.PING: this.sendPong(frame.payload); break;
            case OpCode.PONG: this.handlePong(); break;
            default: this.close(WebSocketCloseCode.PROTOCOL_ERROR, 'Unknown opcode');
        }
    }

    public send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
        if (this._readyState === WebSocketReadyState.CONNECTING) {
            throw new DOMException('Sent before connected.', 'InvalidStateError');
        }
        if (this._readyState !== WebSocketReadyState.OPEN) return;
        if (typeof data === 'string') {
            this.sendFrame(OpCode.TEXT, engine.encodeString(data)).catch(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Send failed'); });
        } else if (data instanceof Blob) {
            data.arrayBuffer().then(buf => { this.sendFrame(OpCode.BINARY, new Uint8Array(buf)).catch(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Send failed'); }); })
                .catch(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Blob conversion failed'); });
        } else {
            const payload: Uint8Array = data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : toOwnedBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            this.sendFrame(OpCode.BINARY, payload).catch(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Send failed'); });
        }
    }

    private async sendFrame(opcode: OpCode, payload: Uint8Array): Promise<void> {
        if (this._readyState !== WebSocketReadyState.OPEN) throw new Error('WebSocket is not open');
        if (this._netRequestId && (opcode === OpCode.TEXT || opcode === OpCode.BINARY)) {
            const wsHook = getWebSocketHook();
            if (wsHook) {
                const hookPayload = opcode === OpCode.TEXT
                    ? engine.decodeString(payload)
                    : hookBase64(payload);
                const frame: WSFrameInfo = {
                    source: this.isClient ? 'fetch' : 'serve',
                    requestId: this._netRequestId, opcode, masked: this.isClient,
                    payloadData: hookPayload,
                    payloadLength: payload.byteLength, timestamp: wsTs(),
                };
                emitWebSocketHookQuietly(() => {
                    wsHook.onFrameSent?.(frame);
                });
            }
        }
        // Data frames may be fragmented; control frames (PING/PONG/CLOSE) must not.
        const isData = opcode === OpCode.TEXT || opcode === OpCode.BINARY;
        if (isData) {
            await this.sendQueue.enqueueData(opcode, payload);
        } else {
            await this.sendQueue.enqueue(this.sendQueue.buildControlFrame(opcode, payload));
        }
    }

    public close(code: number = WebSocketCloseCode.NORMAL, reason: string = ''): void {
        validateCloseCode(code);
        const reasonBytes = encodeCloseReason(reason);
        if (this._readyState === WebSocketReadyState.CLOSING || this._readyState === WebSocketReadyState.CLOSED) return;
        this._readyState = WebSocketReadyState.CLOSING;
        const payload = new Uint8Array(2 + reasonBytes.length);
        payload[0] = (code >> 8) & 0xFF; payload[1] = code & 0xFF;
        if (reasonBytes.length > 0) payload.set(reasonBytes, 2);
        this.sendFrame(OpCode.CLOSE, payload).then(() => {
            this._closeTimer = timers.setTimeout(() => { this._closeTimer = null; this.handleClose(code, reason); }, 1000);
        }).catch(() => { this.handleClose(code, reason); });
    }

    private handleCloseFrame(payload: Uint8Array): void {
        let code = WebSocketCloseCode.NO_STATUS; let reason = '';
        if (payload.length >= 2) {
            const codeHi = payload[0], codeLo = payload[1];
            if (codeHi !== undefined && codeLo !== undefined) code = (codeHi << 8) | codeLo;
            if (payload.length > 2) reason = engine.decodeString(payload.slice(2));
        }
        if (this._readyState === WebSocketReadyState.OPEN) {
            const response = new Uint8Array(2);
            response[0] = (code >> 8) & 0xFF;
            response[1] = code & 0xFF;
            this.sendFrame(OpCode.CLOSE, response).catch(() => {});
        }
        this.handleClose(code, reason);
    }

    private handleClose(code: number, reason: string): void {
        if (this._readyState === WebSocketReadyState.CLOSED) return;
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

        const event = new CloseEvent('close', { code, reason, wasClean: code === WebSocketCloseCode.NORMAL }, true);
        this.dispatchEvent(event);
        this.onclose?.(event);
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
                    this.close(WebSocketCloseCode.ABNORMAL, 'Ping timeout');
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
        if (opcode === OpCode.TEXT) data = engine.decodeString(payload);
        else data = this.binaryType === 'arraybuffer' ? bytesToArrayBuffer(payload) : new Blob([payload]);

        if (this._netRequestId) {
            const wsHook = getWebSocketHook();
            if (wsHook) {
                const hookPayload = opcode === OpCode.TEXT
                    ? engine.decodeString(payload)
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
    private _openedResolve: (value: WebSocketStreamConnection) => void = () => {};
    private _openedReject: ((reason: Error) => void) | null = null;
    private _closedResolve: (value: { closeCode: number; reason: string }) => void = () => {};
    readonly opened: Promise<WebSocketStreamConnection>;
    readonly closed: Promise<{ closeCode: number; reason: string }>;

    constructor(url: string | URL, options?: WebSocketStreamOptions) {
        this.opened = new Promise((resolve, reject) => { this._openedResolve = resolve; this._openedReject = reject; });
        this.closed = new Promise(resolve => { this._closedResolve = resolve; });
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
        });
        this.ws.addEventListener('message', async (event: MessageEvent) => {
            if (this.readableController) {
                try {
                    const data = event.data;
                    if (typeof data === 'string') this.readableController.enqueue(engine.encodeString(data));
                    else if (data instanceof ArrayBuffer) this.readableController.enqueue(new Uint8Array(data));
                    else if (data instanceof Blob) this.readableController.enqueue(new Uint8Array(await data.arrayBuffer()));
                } catch (err) {
                    this.ws.close(WebSocketCloseCode.ABNORMAL, 'Message processing failed');
                }
            }
        });
        this.ws.addEventListener('close', (e: globalThis.CloseEvent) => {
            if (this.readableController) {
                closeReadableControllerQuietly(this.readableController);
                this.readableController = null;
            }
            this._closedResolve({ closeCode: e.code, reason: e.reason });
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
