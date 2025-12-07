const ws = import.meta.use('ws')

type WS = globalThis.WebSocket;

// WebSocket 操作码
enum OpCode {
    CONTINUATION = 0x0,
    TEXT = 0x1,
    BINARY = 0x2,
    CLOSE = 0x8,
    PING = 0x9,
    PONG = 0xA
}

// WebSocket 帧解析器
class WebSocketFrameParser {
    private buffer = new Uint8Array(0);

    append(data: Uint8Array) {
        const newBuffer = new Uint8Array(this.buffer.length + data.length);
        newBuffer.set(this.buffer);
        newBuffer.set(data, this.buffer.length);
        this.buffer = newBuffer;
    }

    parseFrame(): { opcode: number; payload: Uint8Array<ArrayBuffer>; fin: boolean } | null {
        if (this.buffer.length < 2) return null;

        const fin = (this.buffer[0]! & 0x80) !== 0;
        const opcode = this.buffer[0]! & 0x0F;
        const masked = (this.buffer[1]! & 0x80) !== 0;
        let payloadLen = this.buffer[1]! & 0x7F;
        let offset = 2;

        if (payloadLen === 126) {
            if (this.buffer.length < 4) return null;
            payloadLen = (this.buffer[2]! << 8) | this.buffer[3]!;
            offset = 4;
        } else if (payloadLen === 127) {
            if (this.buffer.length < 10) return null;
            // 简化处理，不支持超大帧
            payloadLen = (this.buffer[6]! << 24) | (this.buffer[7]! << 16) |
                (this.buffer[8]! << 8) | this.buffer[9]!;
            offset = 10;
        }

        // 掩码
        let maskKey: Uint8Array | null = null;
        if (masked) {
            if (this.buffer.length < offset + 4) return null;
            maskKey = this.buffer.slice(offset, offset + 4);
            offset += 4;
        }

        // 检查是否有完整载荷
        if (this.buffer.length < offset + payloadLen) return null;

        // 提取载荷
        let payload = this.buffer.slice(offset, offset + payloadLen);

        // 解除掩码
        if (maskKey) {
            for (let i = 0; i < payload.length; i++) {
                payload[i]! ^= maskKey[i % 4]!;
            }
        }

        // 移除已处理的数据
        this.buffer = this.buffer.slice(offset + payloadLen);

        return { opcode, payload, fin };
    }

    clear() {
        this.buffer = new Uint8Array(0);
    }
}

// WebSocket 帧构建器
class WebSocketFrameBuilder {
    static build(opcode: OpCode, payload: Uint8Array, masked = false): Uint8Array {
        let headerSize = 2;
        const payloadLen = payload.length;

        // 计算头部大小
        if (payloadLen > 125) {
            headerSize += payloadLen > 65535 ? 8 : 2;
        }
        if (masked) headerSize += 4;

        const frame = new Uint8Array(headerSize + payloadLen);
        let offset = 0;

        // 第一个字节：FIN + opcode
        frame[offset++] = 0x80 | opcode;

        // 第二个字节：MASK + payload length
        if (payloadLen <= 125) {
            frame[offset++] = (masked ? 0x80 : 0) | payloadLen;
        } else if (payloadLen <= 65535) {
            frame[offset++] = (masked ? 0x80 : 0) | 126;
            frame[offset++] = (payloadLen >> 8) & 0xFF;
            frame[offset++] = payloadLen & 0xFF;
        } else {
            frame[offset++] = (masked ? 0x80 : 0) | 127;
            // 简化：只处理32位长度
            frame[offset++] = 0;
            frame[offset++] = 0;
            frame[offset++] = 0;
            frame[offset++] = 0;
            frame[offset++] = (payloadLen >> 24) & 0xFF;
            frame[offset++] = (payloadLen >> 16) & 0xFF;
            frame[offset++] = (payloadLen >> 8) & 0xFF;
            frame[offset++] = payloadLen & 0xFF;
        }

        // 掩码（服务端发送通常不需要掩码）
        if (masked) {
            const maskKey = crypto.getRandomValues(new Uint8Array(4));
            frame.set(maskKey, offset);
            offset += 4;

            for (let i = 0; i < payloadLen; i++) {
                frame[offset + i] = payload[i]! ^ maskKey[i % 4]!;
            }
        } else {
            frame.set(payload, offset);
        }

        return frame;
    }
}

class WebSocket extends EventTarget implements WS {
    #ws: CModuleWS.WebSocket | null = null;
    #pipe: CModuleStreams.Pipe | null = null;
    #isServerMode = false;
    #frameParser: WebSocketFrameParser | null = null;
    #onopen: ((ev: Event) => any) | null = null;
    #onclose: ((ev: CloseEvent) => any) | null = null;
    #onerror: ((ev: Event) => any) | null = null;
    #onmessage: ((ev: MessageEvent) => any) | null = null;
    #binaryType: BinaryType = 'arraybuffer';
    #protocol: string | null = null;
    #readyState = 0; // CONNECTING
    #messageFragments: Uint8Array[] = [];
    #currentMessageOpcode: number | null = null;

    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly url: string;

    OPEN: number = 1;
    CLOSING: number = 2;
    CLOSED: number = 3;
    CONNECTING: number = 0;

    static createWebSocketFromPipe(pipe: Promise<CModuleStreams.Pipe>, url = 'ws://localhost'): WebSocket {
        const socket: WebSocket = Object.create(WebSocket.prototype);
        // @ts-ignore
        socket.url = url;
        // @ts-ignore
        socket.bufferedAmount = 0;
        // @ts-ignore
        socket.extensions = '';
        socket.OPEN = 1;
        socket.CLOSING = 2;
        socket.CLOSED = 3;
        socket.CONNECTING = 0;

        // 调用 EventTarget 构造函数
        EventTarget.call(socket);

        // 初始化私有字段
        socket.#ws = null;
        socket.#pipe = null;
        socket.#isServerMode = false;
        socket.#frameParser = null;
        socket.#onopen = null;
        socket.#onclose = null;
        socket.#onerror = null;
        socket.#onmessage = null;
        socket.#binaryType = 'arraybuffer';
        socket.#protocol = null;
        socket.#readyState = 0;
        socket.#messageFragments = [];
        socket.#currentMessageOpcode = null;

        // 初始化服务端模式
        socket.#initServerMode(pipe);

        return socket;
    };

    constructor(
        url: string | URL,
        popt?: string | string[] | WebSocketOptions
    ) {
        super();
        this.url = typeof url === 'string' ? url : url.href;

        let protocol = null;
        if (typeof popt === 'string')
            protocol = popt;
        else if (Array.isArray(popt))
            protocol = popt.join(',');
        else if (popt?.protocols)
            if (Array.isArray(popt.protocols))
                protocol = popt.protocols.join(',');
            else
                protocol = popt.protocols;

        const url2 = typeof url == 'string' ? url : url.href;
        this.#ws = new ws.WebSocket(url2, protocol);

        // 绑定客户端模式事件
        this.#ws.onopen = (protocols) => {
            this.#protocol = protocols;
            this.#readyState = this.OPEN;
            const ev = new Event('open');
            this.dispatchEvent(ev);
            if (this.#onopen) this.#onopen(ev);
        };
        this.#ws.onclose = () => {
            this.#readyState = this.CLOSED;
            const ev = new CloseEvent('close', { code: 1000, reason: 'Closed by client' });
            this.dispatchEvent(ev);
            if (this.#onclose) this.#onclose(ev);
        };
        this.#ws.onerror = (errev) => {
            const ev = new Event('error');
            this.dispatchEvent(ev);
            if (this.#onerror) this.#onerror(ev);

            this.#readyState = this.CLOSED;
            const ev2 = new CloseEvent('close', errev);
            this.dispatchEvent(ev2);
            if (this.#onclose) this.#onclose(ev2);
        };
        this.#ws.onmessage = (data) => {
            let data2: Blob | ArrayBuffer | string = data;
            if (typeof data == 'object' && this.#binaryType == 'blob') {
                data2 = new Blob([data]);
            }
            const ev = new MessageEvent('message', { data: data2 });
            this.dispatchEvent(ev);
            if (this.#onmessage) this.#onmessage(ev);
        };
    }

    get protocol() {
        return this.#protocol ?? '';
    }

    get binaryType() {
        return this.#binaryType;
    }

    set binaryType(value: BinaryType) {
        this.#binaryType = value;
    }

    get onopen() {
        return this.#onopen;
    }

    set onopen(value: ((ev: Event) => any) | null) {
        this.#onopen = value;
    }

    get onclose() {
        return this.#onclose;
    }

    set onclose(value: ((ev: CloseEvent) => any) | null) {
        this.#onclose = value;
    }

    get onerror() {
        return this.#onerror;
    }

    set onerror(value: ((ev: Event) => any) | null) {
        this.#onerror = value;
    }

    get onmessage() {
        return this.#onmessage;
    }

    set onmessage(value: ((ev: MessageEvent) => any) | null) {
        this.#onmessage = value;
    }

    get readyState() {
        if (this.#isServerMode) {
            return this.#readyState;
        }
        return this.#ws?.readyState ?? this.CLOSED;
    }

    async send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (this.#isServerMode && this.#pipe) {
            // 服务端模式
            let payload: Uint8Array;
            let opcode: OpCode;

            if (typeof data === 'string') {
                payload = new TextEncoder().encode(data);
                opcode = OpCode.TEXT;
            } else if (data instanceof ArrayBuffer) {
                payload = new Uint8Array(data);
                opcode = OpCode.BINARY;
            } else if (data instanceof Blob) {
                payload = new Uint8Array(await data.arrayBuffer());
                opcode = OpCode.BINARY;
            } else if (ArrayBuffer.isView(data)) {
                payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                opcode = OpCode.BINARY;
            } else {
                throw new Error('Unsupported data type');
            }

            const frame = WebSocketFrameBuilder.build(opcode, payload, false);
            await this.#pipe.write(frame);
        } else if (this.#ws) {
            // 客户端模式
            if (typeof data === 'string')
                return this.#ws.sendText(data);

            if (data instanceof ArrayBuffer)
                return this.#ws.sendBinary(data);
            if (data instanceof Blob)
                return this.#ws.sendBinary(await data.arrayBuffer());
            if (ArrayBuffer.isView(data))
                return this.#ws.sendBinary(data.buffer as ArrayBuffer);

            throw new Error('Unsupported data type');
        }
    }

    close(code?: number, reason?: string): void {
        if (this.#isServerMode && this.#pipe) {
            this.#readyState = this.CLOSING;
            // 发送关闭帧
            const payload = new Uint8Array(2 + (reason?.length || 0));
            const actualCode = code ?? 1000;
            payload[0] = (actualCode >> 8) & 0xFF;
            payload[1] = actualCode & 0xFF;
            if (reason) {
                const reasonBytes = new TextEncoder().encode(reason);
                payload.set(reasonBytes, 2);
            }
            const frame = WebSocketFrameBuilder.build(OpCode.CLOSE, payload, false);
            this.#pipe.write(frame).then(() => {
                this.#pipe?.close();
                this.#readyState = this.CLOSED;
            }).catch(() => {
                this.#pipe?.close();
                this.#readyState = this.CLOSED;
            });
        } else if (this.#ws) {
            this.#ws.close(code, reason);
        }
    }

    // 服务端模式初始化
    async #initServerMode(pipe: Promise<CModuleStreams.Pipe>) {
        this.#isServerMode = true;
        this.#frameParser = new WebSocketFrameParser();
        this.#readyState = this.OPEN;

        this.#pipe = await pipe;
        this.#readLoop();

        // open event
        setTimeout(() => {
            const ev = new Event('open');
            this.dispatchEvent(ev);
            if (this.#onopen) this.#onopen(ev);
        }, 0);
    }

    async #readLoop() {
        const buffer = new Uint8Array(4096);

        try {
            while (this.#pipe && this.#readyState !== this.CLOSED) {
                const nread = await this.#pipe.read(buffer);

                if (nread === null || nread === 0) {
                    // 连接关闭
                    this.#handleConnectionClose();
                    break;
                }

                this.#frameParser!.append(buffer.slice(0, nread));

                // 处理所有可用的帧
                let frame;
                while ((frame = this.#frameParser!.parseFrame()) !== null) {
                    this.#handleFrame(frame);
                }
            }
        } catch (error) {
            this.#handleError(error);
        }
    }

    #handleFrame(frame: { opcode: number; payload: Uint8Array<ArrayBuffer>; fin: boolean }) {
        switch (frame.opcode) {
            case OpCode.TEXT:
            case OpCode.BINARY:
                if (!frame.fin) {
                    // 分片消息的开始
                    this.#currentMessageOpcode = frame.opcode;
                    this.#messageFragments.push(frame.payload);
                } else if (this.#currentMessageOpcode !== null) {
                    // 错误：收到新消息但之前的消息未完成
                    this.close(1002, 'Protocol error');
                } else {
                    // 完整消息
                    this.#dispatchMessage(frame.opcode, frame.payload);
                }
                break;

            case OpCode.CONTINUATION:
                if (this.#currentMessageOpcode === null) {
                    // 错误：没有进行中的消息
                    this.close(1002, 'Protocol error');
                } else {
                    this.#messageFragments.push(frame.payload);
                    if (frame.fin) {
                        // 消息完成
                        const totalLen = this.#messageFragments.reduce((sum, f) => sum + f.length, 0);
                        const combined = new Uint8Array(totalLen);
                        let offset = 0;
                        for (const fragment of this.#messageFragments) {
                            combined.set(fragment, offset);
                            offset += fragment.length;
                        }
                        this.#dispatchMessage(this.#currentMessageOpcode, combined);
                        this.#messageFragments = [];
                        this.#currentMessageOpcode = null;
                    }
                }
                break;

            case OpCode.CLOSE:
                // 处理关闭帧
                let code = 1000;
                let reason = '';
                if (frame.payload.length >= 2) {
                    code = (frame.payload[0]! << 8) | frame.payload[1]!;
                    if (frame.payload.length > 2) {
                        reason = new TextDecoder().decode(frame.payload.slice(2));
                    }
                }
                this.#handleConnectionClose(code, reason);
                break;

            case OpCode.PING:
                // 响应 PONG
                const pongFrame = WebSocketFrameBuilder.build(OpCode.PONG, frame.payload, false);
                this.#pipe?.write(pongFrame).catch(() => { });
                break;

            case OpCode.PONG:
                // 忽略 PONG（如果需要可以添加心跳检测）
                break;

            default:
                // 未知操作码
                this.close(1002, 'Protocol error');
                break;
        }
    }

    #dispatchMessage(opcode: number, payload: Uint8Array<ArrayBuffer>) {
        let data: string | ArrayBuffer | Blob;

        if (opcode === OpCode.TEXT) {
            data = new TextDecoder().decode(payload);
        } else {
            if (this.#binaryType === 'blob') {
                data = new Blob([payload]);
            } else {
                data = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
            }
        }

        const ev = new MessageEvent('message', { data });
        this.dispatchEvent(ev);
        if (this.#onmessage) this.#onmessage(ev);
    }

    #handleConnectionClose(code = 1000, reason = '') {
        if (this.#readyState === this.CLOSED) return;

        this.#readyState = this.CLOSED;
        const ev = new CloseEvent('close', { code, reason });
        this.dispatchEvent(ev);
        if (this.#onclose) this.#onclose(ev);

        this.#pipe?.close();
    }

    #handleError(error: any) {
        const ev = new Event('error');
        this.dispatchEvent(ev);
        if (this.#onerror) this.#onerror(ev);

        this.#handleConnectionClose(1006, 'Abnormal closure');
    }
}

Reflect.set(globalThis, 'WebSocket', WebSocket);

export default WebSocket;