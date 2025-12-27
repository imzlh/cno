/**
 * WebSocket 完整实现
 * 支持客户端和服务器模式，符合 RFC 6455
 */

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const timers = import.meta.use('timers');

import { connectionManager, Connection, type ConnectionLike } from './connection';
import { HttpRequestBuilder, HttpResponseParser } from './http';
import { Headers } from 'headers-polyfill';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/**
 * WebSocket 操作码
 */
export enum OpCode {
    CONTINUATION = 0x0,
    TEXT = 0x1,
    BINARY = 0x2,
    CLOSE = 0x8,
    PING = 0x9,
    PONG = 0xA
}

/**
 * WebSocket 就绪状态
 */
export enum WebSocketReadyState {
    CONNECTING = 0,
    OPEN = 1,
    CLOSING = 2,
    CLOSED = 3
}

/**
 * WebSocket 关闭码
 */
export enum WebSocketCloseCode {
    NORMAL = 1000,
    GOING_AWAY = 1001,
    PROTOCOL_ERROR = 1002,
    UNSUPPORTED_DATA = 1003,
    NO_STATUS = 1005,
    ABNORMAL = 1006,
    INVALID_PAYLOAD = 1007,
    POLICY_VIOLATION = 1008,
    MESSAGE_TOO_BIG = 1009,
    EXTENSION_REQUIRED = 1010,
    INTERNAL_ERROR = 1011,
    SERVICE_RESTART = 1012,
    TRY_AGAIN_LATER = 1013,
    BAD_GATEWAY = 1014,
    TLS_HANDSHAKE_FAIL = 1015
}

/**
 * WebSocket 帧
 */
interface WebSocketFrame {
    fin: boolean;
    opcode: OpCode;
    masked: boolean;
    payload: Uint8Array;
}

/**
 * WebSocket 事件映射
 */
interface WebSocketEventMap {
    open: Event;
    message: MessageEvent;
    error: ErrorEvent;
    close: CloseEvent;
}

/**
 * WebSocket 类
 */
export class WebSocket extends EventTarget implements globalThis.WebSocket {
    // 常量
    static readonly CONNECTING = WebSocketReadyState.CONNECTING;
    static readonly OPEN = WebSocketReadyState.OPEN;
    static readonly CLOSING = WebSocketReadyState.CLOSING;
    static readonly CLOSED = WebSocketReadyState.CLOSED;
    readonly CONNECTING = WebSocketReadyState.CONNECTING;
    readonly OPEN = WebSocketReadyState.OPEN;
    readonly CLOSING = WebSocketReadyState.CLOSING;
    readonly CLOSED = WebSocketReadyState.CLOSED;

    // 属性
    public readonly url: string;
    public readonly protocol: string = '';
    public readonly extensions: string = '';
    public binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';

    private _readyState: WebSocketReadyState = WebSocketReadyState.CONNECTING;
    private connection: ConnectionLike | null = null;
    private isClient: boolean;
    private receiveBuffer: Uint8Array[] = [];
    private fragments: Uint8Array[] = [];
    private fragmentOpcode: OpCode | null = null;
    private pingInterval: number | null = null;
    private pongTimeout: number | null = null;
    private closeCode: number = WebSocketCloseCode.NO_STATUS;
    private closeReason: string = '';

    // 事件处理器
    public onopen: ((this: globalThis.WebSocket, ev: Event) => any) | null = null;
    public onmessage: ((this: globalThis.WebSocket, ev: MessageEvent) => any) | null = null;
    public onerror: ((this: globalThis.WebSocket, ev: ErrorEvent | Event) => any) | null = null;
    public onclose: ((this: globalThis.WebSocket, ev: CloseEvent) => any) | null = null;

    // buffer 相关
    public bufferedAmount: number = 0;

    /**
     * 客户端构造函数
     */
    constructor(url: string, protocols?: string | string[]);

    /**
     * 服务器端构造函数（内部使用）
     */
    constructor(connection: ConnectionLike, isServer: true);

    constructor(urlOrConnection: string | ConnectionLike, protocolsOrIsServer?: string | string[] | true) {
        super();

        if (typeof urlOrConnection === 'string') {
            // 客户端模式
            this.url = urlOrConnection;
            this.isClient = true;

            const protocols = protocolsOrIsServer as string | string[] | undefined;
            if (protocols) {
                this.protocol = Array.isArray(protocols) ? protocols[0] : protocols;
            }

            this.connectClient();
        } else {
            // 服务器模式
            this.url = '';
            this.isClient = false;
            this.connection = urlOrConnection;
            this._readyState = WebSocketReadyState.OPEN;

            // 立即开始接收数据
            this.startReceiving();
            this.startPingTimer();

            // 触发 open 事件
            queueMicrotask(() => {
                this.dispatchEvent(new Event('open'));
                if (this.onopen) this.onopen.call(this, new Event('open'));
            });
        }
    }

    /**
     * 就绪状态
     */
    get readyState(): WebSocketReadyState {
        return this._readyState;
    }

    /**
     * 客户端连接
     */
    private async connectClient(): Promise<void> {
        try {
            const url = new URL(this.url);
            const isSecure = url.protocol === 'wss:';
            const port = url.port ? parseInt(url.port) : (isSecure ? 443 : 80);

            // 获取连接
            this.connection = await connectionManager.acquire({
                hostname: url.hostname,
                port,
                protocol: isSecure ? 'https:' : 'http:',
                keepAlive: false // WebSocket 不使用连接池
            });

            // 发送握手请求
            await this.sendHandshake(url);

            // 等待握手响应
            await this.receiveHandshake();

            // 握手成功
            this._readyState = WebSocketReadyState.OPEN;
            this.startReceiving();
            this.startPingTimer();

            // 触发 open 事件
            this.dispatchEvent(new Event('open'));
            if (this.onopen) this.onopen.call(this, new Event('open'));

        } catch (err) {
            this._readyState = WebSocketReadyState.CLOSED;
            this.emitError(err as Error);
        }
    }

    /**
     * 发送握手请求
     */
    private async sendHandshake(url: URL): Promise<void> {
        const key = this.generateWebSocketKey();

        const headers = new Headers({
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key
        });

        if (this.protocol) {
            headers.set('Sec-WebSocket-Protocol', this.protocol);
        }

        const builder = new HttpRequestBuilder(url, {
            method: 'GET',
            headers
        });

        const request = builder.build();
        this.bufferedAmount += request.length;
        try{
            await this.connection!.write(request);
        }finally{
            this.bufferedAmount -= request.length;
        }
    }

    /**
     * 接收握手响应
     */
    private async receiveHandshake(): Promise<void> {
        const parser = new HttpResponseParser();
        let resolved = false;

        return new Promise((resolve, reject) => {
            parser.onHeadersComplete = (status, headers) => {
                if (status !== 101) {
                    reject(new Error(`WebSocket handshake failed: ${status}`));
                    return;
                }

                const upgrade = headers.get('upgrade')?.toLowerCase();
                const connection = headers.get('connection')?.toLowerCase();

                if (upgrade !== 'websocket' || !connection?.includes('upgrade')) {
                    reject(new Error('Invalid WebSocket handshake response'));
                    return;
                }

                // 验证 Sec-WebSocket-Accept（简化实现）
                const accept = headers.get('sec-websocket-accept');
                if (!accept) {
                    reject(new Error('Missing Sec-WebSocket-Accept header'));
                    return;
                }

                resolved = true;
                resolve();
            };

            parser.onError = (err) => {
                if (!resolved) reject(err);
            };

            // 读取响应
            (async () => {
                try {
                    while (!resolved && this.connection) {
                        const data = await this.connection.read();
                        if (!data) {
                            if (!resolved) reject(new Error('Connection closed during handshake'));
                            break;
                        }
                        parser.feed(data);
                    }
                } catch (err) {
                    if (!resolved) reject(err);
                }
            })();
        });
    }

    /**
     * 生成 WebSocket 密钥
     */
    private generateWebSocketKey(): string {
        const random = crypto.randomBytes(16);
        return crypto.base64Encode(random);
    }

    /**
     * 开始接收数据
     */
    private async startReceiving(): Promise<void> {
        try {
            while (this._readyState === WebSocketReadyState.OPEN && this.connection) {
                const data = await this.connection.read();

                if (!data || data.length === 0) {
                    // 连接关闭
                    this.handleClose(WebSocketCloseCode.ABNORMAL, 'Connection closed');
                    break;
                }

                this.receiveBuffer.push(data);
                this.processFrames();
            }
        } catch (err) {
            if (this._readyState !== WebSocketReadyState.CLOSED) {
                this.emitError(err as Error);
                this.close(WebSocketCloseCode.ABNORMAL, 'Read error');
            }
        }
    }

    /**
     * 处理接收到的帧
     */
    private processFrames(): void {
        while (this.receiveBuffer.length > 0) {
            const frame = this.parseFrame();
            if (!frame) break;

            this.handleFrame(frame);
        }
    }

    /**
     * 解析帧
     */
    private parseFrame(): WebSocketFrame | null {
        // 计算缓冲区总长度
        const totalLength = this.receiveBuffer.reduce((sum, buf) => sum + buf.length, 0);

        if (totalLength < 2) return null;

        // 合并缓冲区用于解析
        let buffer: Uint8Array;
        if (this.receiveBuffer.length === 1) {
            buffer = this.receiveBuffer[0];
        } else {
            buffer = new Uint8Array(totalLength);
            let offset = 0;
            for (const buf of this.receiveBuffer) {
                buffer.set(buf, offset);
                offset += buf.length;
            }
        }

        // 解析帧头
        const byte1 = buffer[0];
        const byte2 = buffer[1];

        const fin = (byte1 & 0x80) !== 0;
        const opcode = byte1 & 0x0F;
        const masked = (byte2 & 0x80) !== 0;
        let payloadLength = byte2 & 0x7F;

        let offset = 2;

        // 扩展载荷长度
        if (payloadLength === 126) {
            if (totalLength < 4) return null;
            payloadLength = (buffer[2] << 8) | buffer[3];
            offset = 4;
        } else if (payloadLength === 127) {
            if (totalLength < 10) return null;
            // 简化：不支持超过 2^32 的长度
            payloadLength = (buffer[6] << 24) | (buffer[7] << 16) | (buffer[8] << 8) | buffer[9];
            offset = 10;
        }

        // 掩码密钥
        let maskKey: Uint8Array | null = null;
        if (masked) {
            if (totalLength < offset + 4) return null;
            maskKey = buffer.slice(offset, offset + 4);
            offset += 4;
        }

        // 检查是否有完整的载荷
        if (totalLength < offset + payloadLength) return null;

        // 提取载荷
        let payload = buffer.slice(offset, offset + payloadLength);

        // 解除掩码
        if (masked && maskKey) {
            payload = this.unmask(payload, maskKey);
        }

        // 更新缓冲区
        const frameLength = offset + payloadLength;
        if (frameLength === totalLength) {
            this.receiveBuffer = [];
        } else {
            const remaining = buffer.slice(frameLength);
            this.receiveBuffer = [remaining];
        }

        return {
            fin,
            opcode,
            masked,
            payload
        };
    }

    /**
     * 处理帧
     */
    private handleFrame(frame: WebSocketFrame): void {
        switch (frame.opcode) {
            case OpCode.TEXT:
            case OpCode.BINARY:
                if (frame.fin) {
                    // 完整消息
                    this.emitMessage(frame.opcode, frame.payload);
                } else {
                    // 分片开始
                    this.fragmentOpcode = frame.opcode;
                    this.fragments = [frame.payload];
                }
                break;

            case OpCode.CONTINUATION:
                if (this.fragmentOpcode === null) {
                    this.close(WebSocketCloseCode.PROTOCOL_ERROR, 'Unexpected continuation frame');
                    return;
                }

                this.fragments.push(frame.payload);

                if (frame.fin) {
                    // 分片结束
                    const totalLength = this.fragments.reduce((sum, f) => sum + f.length, 0);
                    const combined = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const fragment of this.fragments) {
                        combined.set(fragment, offset);
                        offset += fragment.length;
                    }

                    this.emitMessage(this.fragmentOpcode, combined);
                    this.fragmentOpcode = null;
                    this.fragments = [];
                }
                break;

            case OpCode.CLOSE:
                this.handleCloseFrame(frame.payload);
                break;

            case OpCode.PING:
                this.sendPong(frame.payload);
                break;

            case OpCode.PONG:
                this.handlePong();
                break;

            default:
                this.close(WebSocketCloseCode.PROTOCOL_ERROR, 'Unknown opcode');
        }
    }

    /**
     * 发送消息
     */
    public send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
        if (this._readyState !== WebSocketReadyState.OPEN) {
            throw new Error('WebSocket is not open');
        }

        if (typeof data === 'string') {
            const payload = engine.encodeString(data);
            this.sendFrame(OpCode.TEXT, payload, true);
        } else if (data instanceof Blob) {
            // 异步处理 Blob
            data.arrayBuffer().then(buffer => {
                const payload = new Uint8Array(buffer);
                this.sendFrame(OpCode.BINARY, payload, true);
            });
        } else {
            // @ts-ignore
            const payload: Uint8Array = data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            this.sendFrame(OpCode.BINARY, payload, true);
        }
    }

    /**
     * 发送帧
     */
    private async sendFrame(opcode: OpCode, payload: Uint8Array, fin: boolean = true): Promise<void> {
        if (!this.connection) return;

        const masked = this.isClient;
        const frame = this.buildFrame(opcode, payload, fin, masked);

        try {
            this.bufferedAmount += frame.length;
            await this.connection.write(frame);
        } catch (err) {
            this.emitError(err as Error);
            this.close(WebSocketCloseCode.ABNORMAL, 'Write error');
        } finally {
            this.bufferedAmount -= frame.length;
        }
    }

    /**
     * 构建帧
     */
    private buildFrame(opcode: OpCode, payload: Uint8Array, fin: boolean, masked: boolean): Uint8Array {
        const payloadLength = payload.length;
        let headerLength = 2;

        // 计算头部长度
        if (payloadLength > 65535) {
            headerLength += 8;
        } else if (payloadLength > 125) {
            headerLength += 2;
        }

        if (masked) {
            headerLength += 4;
        }

        const frame = new Uint8Array(headerLength + payloadLength);
        let offset = 0;

        // 字节 1: FIN + RSV + Opcode
        frame[offset++] = (fin ? 0x80 : 0) | opcode;

        // 字节 2: MASK + Payload length
        let byte2 = masked ? 0x80 : 0;

        if (payloadLength <= 125) {
            byte2 |= payloadLength;
            frame[offset++] = byte2;
        } else if (payloadLength <= 65535) {
            byte2 |= 126;
            frame[offset++] = byte2;
            frame[offset++] = (payloadLength >> 8) & 0xFF;
            frame[offset++] = payloadLength & 0xFF;
        } else {
            byte2 |= 127;
            frame[offset++] = byte2;
            // 简化：只支持 32 位长度
            frame[offset++] = 0;
            frame[offset++] = 0;
            frame[offset++] = 0;
            frame[offset++] = 0;
            frame[offset++] = (payloadLength >> 24) & 0xFF;
            frame[offset++] = (payloadLength >> 16) & 0xFF;
            frame[offset++] = (payloadLength >> 8) & 0xFF;
            frame[offset++] = payloadLength & 0xFF;
        }

        // 掩码密钥
        if (masked) {
            const maskKey = new Uint8Array(crypto.randomBytes(4));
            frame.set(maskKey, offset);
            offset += 4;

            // 应用掩码
            const maskedPayload = this.mask(payload, maskKey);
            frame.set(maskedPayload, offset);
        } else {
            frame.set(payload, offset);
        }

        return frame;
    }

    /**
     * 应用掩码
     */
    private mask(data: Uint8Array, maskKey: Uint8Array): Uint8Array {
        const masked = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            masked[i] = data[i] ^ maskKey[i % 4];
        }
        return masked;
    }

    /**
     * 解除掩码
     */
    private unmask(data: Uint8Array, maskKey: Uint8Array): Uint8Array {
        return this.mask(data, maskKey); // 掩码是可逆的
    }

    /**
     * 关闭连接
     */
    public close(code: number = WebSocketCloseCode.NORMAL, reason: string = ''): void {
        if (this._readyState === WebSocketReadyState.CLOSING ||
            this._readyState === WebSocketReadyState.CLOSED) {
            return;
        }

        this._readyState = WebSocketReadyState.CLOSING;

        // 发送关闭帧
        const payload = new Uint8Array(2 + engine.encodeString(reason).length);
        payload[0] = (code >> 8) & 0xFF;
        payload[1] = code & 0xFF;
        if (reason) {
            payload.set(engine.encodeString(reason), 2);
        }

        this.sendFrame(OpCode.CLOSE, payload, true).then(() => {
            // 等待对方关闭帧或超时
            timers.setTimeout(() => {
                this.handleClose(code, reason);
            }, 1000);
        });
    }

    /**
     * 处理关闭帧
     */
    private handleCloseFrame(payload: Uint8Array): void {
        let code = WebSocketCloseCode.NO_STATUS;
        let reason = '';

        if (payload.length >= 2) {
            code = (payload[0] << 8) | payload[1];
            if (payload.length > 2) {
                reason = engine.decodeString(payload.slice(2));
            }
        }

        if (this._readyState === WebSocketReadyState.OPEN) {
            // 回复关闭帧
            const response = new Uint8Array(2);
            response[0] = (code >> 8) & 0xFF;
            response[1] = code & 0xFF;
            this.sendFrame(OpCode.CLOSE, response, true);
        }

        this.handleClose(code, reason);
    }

    /**
     * 处理连接关闭
     */
    private handleClose(code: number, reason: string): void {
        if (this._readyState === WebSocketReadyState.CLOSED) return;

        this._readyState = WebSocketReadyState.CLOSED;
        this.closeCode = code;
        this.closeReason = reason;

        this.stopPingTimer();

        if (this.connection) {
            try {
                this.connection.close();
            } catch (err) {
                // 忽略
            }
            this.connection = null;
        }

        // 触发 close 事件
        const event = new CloseEvent('close', {
            code,
            reason,
            wasClean: code === WebSocketCloseCode.NORMAL
        });

        this.dispatchEvent(event);
        if (this.onclose) this.onclose.call(this, event);
    }

    /**
     * 发送 Ping
     */
    private sendPing(): void {
        if (this._readyState === WebSocketReadyState.OPEN) {
            this.sendFrame(OpCode.PING, new Uint8Array(0), true);

            // 设置 Pong 超时
            this.pongTimeout = timers.setTimeout(() => {
                this.close(WebSocketCloseCode.ABNORMAL, 'Ping timeout');
            }, 5000);
        }
    }

    /**
     * 发送 Pong
     */
    private sendPong(payload: Uint8Array): void {
        if (this._readyState === WebSocketReadyState.OPEN) {
            this.sendFrame(OpCode.PONG, payload, true);
        }
    }

    /**
     * 处理 Pong
     */
    private handlePong(): void {
        if (this.pongTimeout !== null) {
            timers.clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    /**
     * 启动 Ping 定时器
     */
    private startPingTimer(): void {
        this.pingInterval = timers.setInterval(() => {
            this.sendPing();
        }, 30000); // 每 30 秒 ping 一次
    }

    /**
     * 停止 Ping 定时器
     */
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

    /**
     * 触发消息事件
     */
    private emitMessage(opcode: OpCode, payload: Uint8Array): void {
        let data: any;

        if (opcode === OpCode.TEXT) {
            data = engine.decodeString(payload);
        } else {
            data = this.binaryType === 'arraybuffer'
                ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
                : new Blob([payload]);
        }

        const event = new MessageEvent('message', { data });
        this.dispatchEvent(event);
        if (this.onmessage) this.onmessage.call(this, event);
    }

    /**
     * 触发错误事件
     */
    private emitError(error: Error): void {
        const event = new ErrorEvent('error', { error, message: error.message });
        this.dispatchEvent(event);
        if (this.onerror) this.onerror.call(this, event);
    }

    /**
     * 添加事件监听器（类型安全）
     */
    addEventListener<K extends keyof WebSocketEventMap>(
        type: K,
        listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any,
        options?: boolean | AddEventListenerOptions
    ): void {
        super.addEventListener(type, listener as any, options);
    }

    /**
     * 移除事件监听器（类型安全）
     */
    removeEventListener<K extends keyof WebSocketEventMap>(
        type: K,
        listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any,
        options?: boolean | EventListenerOptions
    ): void {
        super.removeEventListener(type, listener as any, options);
    }
}

/**
 * 从服务器端连接创建 WebSocket（用于 HTTP 服务器的 upgrade）
 */
export function createWebSocketFromConnection(connection: ConnectionLike): WebSocket {
    return new WebSocket(connection, true);
}

Reflect.set(globalThis, 'WebSocket', WebSocket);