/**
 * WebSocket client and server (RFC 6455).
 * Includes frame parsing/building, masking/unmasking, ping/pong heartbeats, close handoff,
 * fragmented messages, and a WebSocketStream wrapper.
 */

import { HttpResponseParser } from "@cnojs/http/h1";
import { Headers } from "headers-polyfill";
import { assert } from "../utils/assert";
import { type ISocket } from "@cnojs/http/socket"
import { connectTcp, buildRequest, readHeaders } from "../utils/http"
import { CloseEvent, ErrorEvent, MessageEvent } from "./events";
import { getWebSocketHook, type WSFrameInfo } from '../utils/network-hooks';

const engine = import.meta.use('engine');
const algo = import.meta.use('algorithm');
const crypto = import.meta.use('crypto');
const timers = import.meta.use('timers');
const streams = import.meta.use('streams');
const ssl = import.meta.use('ssl');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type IWSSocket = Omit<ISocket, 'serverHandshake' | 'alpnProtocol' | 'read'>;

let _wsIdCounter = 0;
const wsTs = () => Date.now() / 1000;

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

interface WebSocketFrame { fin: boolean; opcode: OpCode; masked: boolean; payload: Uint8Array; }
interface WebSocketEventMap { open: Event; message: MessageEvent; error: ErrorEvent; close: globalThis.CloseEvent; }

const HIGH_WATER_MARK = 64 * 1024;
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;

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
            const item = this.queue.shift()!;
            try {
                await this.connection.write(item.data);
                this._bufferedAmount -= item.data.length; item.resolve();
            } catch (e) {
                this._bufferedAmount -= item.data.length; item.reject(e as Error);
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
        if (payloadLength <= 125) { byte2 |= payloadLength; frame[offset++] = byte2; }
        else if (payloadLength <= 65535) {
            byte2 |= 126; frame[offset++] = byte2;
            frame[offset++] = (payloadLength >> 8) & 0xFF; frame[offset++] = payloadLength & 0xFF;
        } else {
            byte2 |= 127; frame[offset++] = byte2;
            frame[offset++] = 0; frame[offset++] = 0; frame[offset++] = 0; frame[offset++] = 0;
            frame[offset++] = (payloadLength / 0x1000000) & 0xFF;
            frame[offset++] = (payloadLength / 0x10000) & 0xFF;
            frame[offset++] = (payloadLength / 0x100) & 0xFF;
            frame[offset++] = payloadLength & 0xFF;
        }

        if (masked) {
            const maskKey = new Uint8Array(crypto.randomBytes(4));
            frame.set(maskKey, offset); offset += 4;
            const maskbuf = algo.ws_mask(payload, maskKey);
            frame.set(maskbuf, offset); offset += payloadLength;
        } else { frame.set(payload, offset); }
        return frame;
    }

    private flushQueue(error: Error): void {
        while (this.queue.length > 0) { const item = this.queue.shift()!; this._bufferedAmount -= item.data.length; item.reject(error); }
    }

    /**
     * Fragment a large data message and enqueue each fragment so the total
     * bufferedAmount at any moment is at most FRAGMENT_SIZE + existing queue.
     * All fragments are pushed synchronously before drain() runs, so no other
     * concurrent send can interleave frames within this message.
     */
    enqueueData(opcode: OpCode, payload: Uint8Array): Promise<void> {
        const FRAGMENT_SIZE = 65536;
        if (payload.length <= FRAGMENT_SIZE)
            return this.enqueue(this.buildFrame(opcode, payload, true, this.isClient));

        if (this._bufferedAmount + payload.length > MAX_BUFFERED_AMOUNT)
            return Promise.reject(new Error('WebSocket buffer is full'));

        // Push all frames synchronously — drain() runs asynchronously later, so
        // the entire set is in the queue before any frame is written.
        const promises: Promise<void>[] = [];
        let offset = 0;
        let firstFrame = true;
        while (offset < payload.length) {
            const end = Math.min(offset + FRAGMENT_SIZE, payload.length);
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
        return promises[promises.length - 1]!;
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

    public readonly url: string;
    public readonly protocol: string = '';
    public readonly extensions: string = '';
    public binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';

    private _readyState: WebSocketReadyState = WebSocketReadyState.CONNECTING;
    private connection: IWSSocket | null = null;
    private isClient: boolean;
    private receiveBuffer: Uint8Array[] = [];
    private fragments: Uint8Array[] = [];
    private fragmentOpcode: OpCode | null = null;
    private pingInterval: number | null = null;
    private pongTimeout: number | null = null;
    private _wsKey: string = '';
    private closeCode: number = WebSocketCloseCode.NO_STATUS;
    private closeReason: string = '';
    private _closeTimer: number | null = null;
    private sendQueue: SendQueue;
    private _netRequestId: string = '';

    public onopen: ((this: globalThis.WebSocket, ev: globalThis.Event) => any) | null = null;
    public onmessage: ((this: globalThis.WebSocket, ev: globalThis.MessageEvent) => any) | null = null;
    public onerror: ((this: globalThis.WebSocket, ev: globalThis.ErrorEvent | Event) => any) | null = null;
    public onclose: ((ev: globalThis.CloseEvent) => any) | null = null;

    get bufferedAmount(): number { return this.sendQueue.bufferedAmount; }
    get readyState(): WebSocketReadyState { return this._readyState; }

    constructor(url: string, protocols?: string | string[]);
    constructor(connection: Promise<IWSSocket>, isServer: true);
    constructor(urlOrConnection: string | Promise<IWSSocket>, protocolsOrIsServer?: string | string[] | true) {
        super();
        if (typeof urlOrConnection === 'string') {
            this.url = urlOrConnection; this.isClient = true;
            this.sendQueue = new SendQueue(null, true, () => this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed'));
            const protocols = protocolsOrIsServer as string | string[] | undefined;
            if (protocols) this.protocol = Array.isArray(protocols) ? protocols[0]! : protocols;
            this.connectClient();
        } else {
            this.url = ''; this.isClient = false;
            this.sendQueue = new SendQueue(null, false, () => this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed'));
            this._readyState = WebSocketReadyState.CONNECTING;
            urlOrConnection.then(conn => {
                if (this._readyState === WebSocketReadyState.CLOSED) return;
                this._readyState = WebSocketReadyState.OPEN; this.connection = conn; this.sendQueue.setConnection(conn);
                this.dispatchEvent(new Event('open')); this.onopen?.(new Event('open'));
                queueMicrotask(() => { this.startReceiving();
                    // Server-side sockets don't initiate pings — the client
                    // (e.g. Chrome DevTools) manages its own heartbeat.
                    if (this.isClient) this.startPingTimer();
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
                try { wsHook.onCreated?.({ requestId: this._netRequestId, url: this.url, timestamp: wsTs() }); } catch {}
            }

            this.connection = await connectTcp(url);

            await this.sendHandshake(url);
            await this.receiveHandshake();

            this._readyState = WebSocketReadyState.OPEN;
            this.sendQueue = new SendQueue(this.connection, true, () => this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed'));
            this.startReceiving(); this.startPingTimer();
            this.dispatchEvent(new Event('open')); this.onopen?.(new Event('open'));
        } catch (err) { this._readyState = WebSocketReadyState.CLOSED; this.emitError(err as Error); }
    }

    private async sendHandshake(url: URL): Promise<void> {
        assert(this.connection, "Connection is not established");
        this._wsKey = this.generateWebSocketKey();
        const headers = new Headers({
            'Upgrade': 'websocket', 'Connection': 'Upgrade',
            'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': this._wsKey
        });
        if (this.protocol) headers.set('Sec-WebSocket-Protocol', this.protocol);
        await this.connection.write(buildRequest({ method: 'GET', url, headers }));
    }

    private async receiveHandshake(): Promise<void> {
        assert(this.connection, "Connection is not established");
        const parser = new HttpResponseParser();
        const { status, headers } = await readHeaders(this.connection, parser);

        if (status !== 101) throw new Error(`WebSocket handshake failed: ${status}`);
        const upgrade = headers.find(([n]) => n === 'upgrade')?.[1]?.toLowerCase();
        const connection = headers.find(([n]) => n === 'connection')?.[1]?.toLowerCase();
        if (upgrade !== 'websocket' || !connection?.includes('upgrade')) throw new Error('Invalid WebSocket handshake response');
        const accept = headers.find(([n]) => n === 'sec-websocket-accept')?.[1];
        if (!accept) throw new Error('Missing Sec-WebSocket-Accept header');
        if (accept !== this.computeAcceptKey(this._wsKey)) throw new Error('Invalid Sec-WebSocket-Accept header');

        if (this._netRequestId) {
            const wsHook = getWebSocketHook();
            if (wsHook) try { wsHook.onHandshake?.({ requestId: this._netRequestId, status, headers, timestamp: wsTs() }); } catch {}
        }
    }

    private generateWebSocketKey(): string { return crypto.base64Encode(crypto.randomBytes(16)); }
    private computeAcceptKey(key: string): string { return crypto.base64Encode(crypto.sha1(engine.encodeString(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))); }

    private startReceiving(): void {
        if (!this.connection) return;
        const conn = this.connection;
        conn.onReadable(data => {
            if (data === null) return this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed');
            if (data.length === 0) return;
            this.receiveBuffer.push(data); this.processFrames();
        });
    }

    private processFrames(): void {
        while (this.receiveBuffer.length > 0) { const frame = this.parseFrame(); if (!frame) break; this.handleFrame(frame); }
    }

    private parseFrame(): WebSocketFrame | null {
        const totalLength = this.receiveBuffer.reduce((sum, buf) => sum + buf.length, 0);
        if (totalLength < 2) return null;

        let buffer: Uint8Array;
        if (this.receiveBuffer.length === 1) buffer = this.receiveBuffer[0]!;
        else { buffer = new Uint8Array(totalLength); let o = 0; for (const buf of this.receiveBuffer) { buffer.set(buf, o); o += buf.length; } }

        const byte1 = buffer[0]!, byte2 = buffer[1]!;
        const fin = (byte1 & 0x80) !== 0;
        const opcode = byte1 & 0x0F;
        const masked = (byte2 & 0x80) !== 0;
        let payloadLength = byte2 & 0x7F;
        let offset = 2;

        if (payloadLength === 126) { if (totalLength < 4) return null; payloadLength = (buffer[2]! << 8) | buffer[3]!; offset = 4; }
        else if (payloadLength === 127) {
            if (totalLength < 10) return null;
            const highBits = buffer[2]! * 0x1000000 + buffer[3]! * 0x10000 + buffer[4]! * 0x100 + buffer[5]!;
            if (highBits !== 0) { this.close(WebSocketCloseCode.MESSAGE_TOO_BIG, 'Frame payload too large'); return null; }
            payloadLength = buffer[6]! * 0x1000000 + buffer[7]! * 0x10000 + buffer[8]! * 0x100 + buffer[9]!; offset = 10;
        }

        let maskKey: Uint8Array | null = null;
        if (masked) { if (totalLength < offset + 4) return null; maskKey = buffer.slice(offset, offset + 4); offset += 4; }
        if (totalLength < offset + payloadLength) return null;

        let payload = buffer.slice(offset, offset + payloadLength);
        if (masked && maskKey && payload.length > 0) payload = algo.ws_mask(payload, maskKey);

        const frameLength = offset + payloadLength;
        if (frameLength === totalLength) this.receiveBuffer = [];
        else this.receiveBuffer = [buffer.slice(frameLength)];

        return { fin, opcode, masked, payload };
    }

    private handleFrame(frame: WebSocketFrame): void {
        switch (frame.opcode) {
            case OpCode.TEXT: case OpCode.BINARY:
                if (frame.fin) this.emitMessage(frame.opcode, frame.payload);
                else { this.fragmentOpcode = frame.opcode; this.fragments = [frame.payload]; }
                break;
            case OpCode.CONTINUATION:
                if (this.fragmentOpcode === null) { this.close(WebSocketCloseCode.PROTOCOL_ERROR, 'Unexpected continuation frame'); return; }
                this.fragments.push(frame.payload);
                if (frame.fin) {
                    const totalLength = this.fragments.reduce((sum, f) => sum + f.length, 0);
                    const combined = new Uint8Array(totalLength); let o = 0;
                    for (const f of this.fragments) { combined.set(f, o); o += f.length; }
                    this.emitMessage(this.fragmentOpcode, combined);
                    this.fragmentOpcode = null; this.fragments = [];
                }
                break;
            case OpCode.CLOSE: this.handleCloseFrame(frame.payload); break;
            case OpCode.PING: this.sendPong(frame.payload); break;
            case OpCode.PONG: this.handlePong(); break;
            default: this.close(WebSocketCloseCode.PROTOCOL_ERROR, 'Unknown opcode');
        }
    }

    public send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
        if (this._readyState !== WebSocketReadyState.OPEN) throw new Error('WebSocket is not open');
        if (typeof data === 'string') {
            this.sendFrame(OpCode.TEXT, engine.encodeString(data)).catch(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Send failed'); });
        } else if (data instanceof Blob) {
            data.arrayBuffer().then(buf => { this.sendFrame(OpCode.BINARY, new Uint8Array(buf)).catch(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Send failed'); }); })
                .catch(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Blob conversion failed'); });
        } else {
            const payload: Uint8Array = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
            this.sendFrame(OpCode.BINARY, payload).catch(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Send failed'); });
        }
    }

    private async sendFrame(opcode: OpCode, payload: Uint8Array): Promise<void> {
        if (this._readyState !== WebSocketReadyState.OPEN) throw new Error('WebSocket is not open');
        if (this._netRequestId && (opcode === OpCode.TEXT || opcode === OpCode.BINARY)) {
            const wsHook = getWebSocketHook();
            if (wsHook) {
                const frame: WSFrameInfo = {
                    requestId: this._netRequestId, opcode, masked: true,
                    payloadData: opcode === OpCode.TEXT ? engine.decodeString(payload) : crypto.base64Encode(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer),
                    payloadLength: payload.byteLength, timestamp: wsTs(),
                };
                try { wsHook.onFrameSent?.(frame); } catch {}
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
        if (this._readyState === WebSocketReadyState.CLOSING || this._readyState === WebSocketReadyState.CLOSED) return;
        this._readyState = WebSocketReadyState.CLOSING;
        const payload = new Uint8Array(2 + engine.encodeString(reason).length);
        payload[0] = (code >> 8) & 0xFF; payload[1] = code & 0xFF;
        if (reason) payload.set(engine.encodeString(reason), 2);
        this.sendFrame(OpCode.CLOSE, payload).then(() => {
            this._closeTimer = timers.setTimeout(() => { this._closeTimer = null; this.handleClose(code, reason); }, 1000);
        }).catch(() => { this.handleClose(code, reason); });
    }

    private handleCloseFrame(payload: Uint8Array): void {
        let code = WebSocketCloseCode.NO_STATUS; let reason = '';
        if (payload.length >= 2) { code = (payload[0]! << 8) | payload[1]!; if (payload.length > 2) reason = engine.decodeString(payload.slice(2)); }
        if (this._readyState === WebSocketReadyState.OPEN) { const r = new Uint8Array(2); r[0] = (code >> 8) & 0xFF; r[1] = code & 0xFF; this.sendFrame(OpCode.CLOSE, r).catch(() => { }); }
        this.handleClose(code, reason);
    }

    private handleClose(code: number, reason: string): void {
        if (this._readyState === WebSocketReadyState.CLOSED) return;
        if (this._closeTimer !== null) { timers.clearTimeout(this._closeTimer); this._closeTimer = null; }
        this._readyState = WebSocketReadyState.CLOSED; this.closeCode = code; this.closeReason = reason;
        this.stopPingTimer(); this.sendQueue.close();
        if (this.connection) { try { this.connection.close(); } catch { } this.connection = null; }

        if (this._netRequestId) {
            const wsHook = getWebSocketHook();
            if (wsHook) try { wsHook.onClosed?.({ requestId: this._netRequestId, code, reason, timestamp: wsTs() }); } catch {}
            this._netRequestId = '';
        }

        const event = new CloseEvent('close', { code, reason, wasClean: code === WebSocketCloseCode.NORMAL }, true);
        this.dispatchEvent(event); this.onclose?.(event);
    }

    private sendPong(payload: Uint8Array): void { if (this._readyState === WebSocketReadyState.OPEN) this.sendFrame(OpCode.PONG, payload).catch(() => { }); }
    private handlePong(): void { if (this.pongTimeout !== null) { timers.clearTimeout(this.pongTimeout); this.pongTimeout = null; } }

    private startPingTimer(): void {
        this.pingInterval = timers.setInterval(() => {
            if (this._readyState === WebSocketReadyState.OPEN) {
                this.sendFrame(OpCode.PING, new Uint8Array(0)).catch(() => { });
                this.pongTimeout = timers.setTimeout(() => { this.close(WebSocketCloseCode.ABNORMAL, 'Ping timeout'); }, 5000);
            }
        }, 30000);
    }

    private stopPingTimer(): void {
        if (this.pingInterval !== null) { timers.clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.pongTimeout !== null) { timers.clearTimeout(this.pongTimeout); this.pongTimeout = null; }
    }

    private emitMessage(opcode: OpCode, payload: Uint8Array): void {
        let data: any;
        if (opcode === OpCode.TEXT) data = engine.decodeString(payload);
        else data = this.binaryType === 'arraybuffer' ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : new Blob([payload]);

        if (this._netRequestId) {
            const wsHook = getWebSocketHook();
            if (wsHook) {
                const frame: WSFrameInfo = {
                    requestId: this._netRequestId, opcode, masked: false,
                    payloadData: opcode === OpCode.TEXT ? engine.decodeString(payload) : crypto.base64Encode(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer),
                    payloadLength: payload.byteLength, timestamp: wsTs(),
                };
                try { wsHook.onFrameReceived?.(frame); } catch {}
            }
        }

        const event = new MessageEvent('message', { data }, true);
        this.dispatchEvent(event); this.onmessage?.(event);
    }

    private emitError(error: Error): void {
        const event = new ErrorEvent('error', { error, message: error.message }, true);
        this.dispatchEvent(event); this.onerror?.(event);
    }

    addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: any, options?: boolean | AddEventListenerOptions): void {
        super.addEventListener(type, listener as any, options);
    }
    removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: any, options?: boolean | EventListenerOptions): void {
        super.removeEventListener(type, listener as any, options);
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
    private _openedResolve!: (value: WebSocketStreamConnection) => void;
    private _openedReject: ((reason: Error) => void) | null = null;
    private _closedResolve!: (value: { closeCode: number; reason: string }) => void;

    constructor(url: string | URL, options?: WebSocketStreamOptions) {
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
                } catch (err) { this.ws.close(WebSocketCloseCode.ABNORMAL, 'Message processing failed'); }
            }
        });
        this.ws.addEventListener('close', (e: globalThis.CloseEvent) => {
            if (this.readableController) { try { this.readableController.close(); } catch { } this.readableController = null; }
            this._closedResolve({ closeCode: e.code, reason: e.reason });
        });
        this.ws.addEventListener('error', (e: ErrorEvent) => {
            const error = new Error('WebSocket connection failed');
            if (this._openedReject) { this._openedReject(error); this._openedReject = null; }
            if (this.readableController) { try { this.readableController.error(error); } catch { } this.readableController = null; }
        });
    }

    get binaryType(): 'blob' | 'arraybuffer' { return this.ws.binaryType; }
    set binaryType(value: 'blob' | 'arraybuffer') { this.ws.binaryType = value; }
    get bufferedAmount(): number { return this.ws.bufferedAmount; }
    get extensions(): string { return this.ws.extensions; }
    get protocol(): string { return this.ws.protocol; }
    get readyState(): WebSocketReadyState { return this.ws.readyState; }
    get url(): string { return this.ws.url; }

    opened: Promise<WebSocketStreamConnection> = new Promise((resolve, reject) => { this._openedResolve = resolve; this._openedReject = reject; });
    get closed(): Promise<{ closeCode: number; reason: string }> { return new Promise(resolve => { this._closedResolve = resolve; }); }

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
                if (self.ws.readyState !== WebSocketReadyState.OPEN) { controller.error(new Error('WebSocket is not open')); return; }
                self.ws.send(chunk as any);
                while (self.ws.bufferedAmount > HIGH_WATER_MARK) await new Promise(resolve => timers.setTimeout(resolve as any, 16));
            },
            close() { self.close(); },
            abort(reason) { self.close({ reason: String(reason) }); }
        }, { highWaterMark: HIGH_WATER_MARK });
    }
    
    get [Symbol.toStringTag]() {
        return 'WebSocketStream';
    }
}

export function createWebSocketFromConnection(connection: Promise<IWSSocket>): WebSocket {
    return new WebSocket(connection, true);
}

Reflect.set(globalThis, 'WebSocket', WebSocket);
Reflect.set(globalThis, 'WebSocketStream', WebSocketStream);