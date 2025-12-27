/**
 * HTTP Server 完整实现
 * 支持 HTTP/1.1、Keep-Alive、WebSocket Upgrade
 */

const streams = import.meta.use('streams');
const ssl = import.meta.use('ssl');
const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const http = import.meta.use('http');
const timers = import.meta.use('timers');

import { WebSocket, createWebSocketFromConnection } from './websocket';
import { ConnectionState, type ConnectionLike } from './connection';
import { Request } from './fetch';
import { Headers } from 'headers-polyfill';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/**
 * 服务器请求
 */
export class ServerRequest extends Request {
    public readonly method: string;
    public readonly path: string;
    public readonly query: URLSearchParams;
    public readonly headers: Headers;
    public readonly httpVersion: string;
    public readonly socket: ServerSocket;
    public body: ReadableStream<Uint8Array> | null = null;
    
    private _bodyUsed: boolean = false;
    private _bodyChunks: Uint8Array[] = [];

    constructor(
        method: string,
        url: string,
        headers: Headers,
        httpVersion: string,
        socket: ServerSocket
    ) {
        super(url);
        this.method = method.toUpperCase();
        this.headers = headers;
        this.httpVersion = httpVersion;
        this.socket = socket;

        // 解析路径和查询参数
        const urlObj = new URL(url, `http://${headers.get('host') || 'localhost'}`);
        this.path = urlObj.pathname;
        this.query = urlObj.searchParams;
    }

    /**
     * 设置请求体流（内部使用）
     */
    _setBodyStream(stream: ReadableStream<Uint8Array>): void {
        this.body = stream;
    }

    /**
     * 添加 body 数据块（内部使用）
     */
    _addBodyChunk(chunk: Uint8Array): void {
        this._bodyChunks.push(chunk);
    }

    /**
     * 获取已缓存的 body 数据（内部使用）
     */
    _getBufferedBody(): Uint8Array {
        if (this._bodyChunks.length === 0) {
            return new Uint8Array(0);
        }

        if (this._bodyChunks.length === 1) {
            return this._bodyChunks[0];
        }

        const totalLength = this._bodyChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of this._bodyChunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return result;
    }

    async bytes(): Promise<globalThis.Uint8Array<ArrayBuffer>> {
        if (this._bodyUsed) {
            throw new TypeError('Body already used');
        }

        this._bodyUsed = true;

        if (!this.body) {
            const buffered = this._getBufferedBody();
            return buffered;
        }

        const reader = this.body.getReader();
        const chunks: Uint8Array[] = [...this._bodyChunks];

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        if (chunks.length === 0) {
            return new Uint8Array(0);
        }

        if (chunks.length === 1) {
            return chunks[0];
        }

        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return result;
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const bytes = await this.bytes();
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
}

/**
 * 服务器响应
 */
export class ServerResponse {
    private socket: ServerSocket;
    private statusCode: number = 200;
    private statusText: string = 'OK';
    private headers: Headers = new Headers();
    private headersSent: boolean = false;
    private finished: boolean = false;
    private chunkedEncoding: boolean = false;

    constructor(socket: ServerSocket) {
        this.socket = socket;
    }

    /**
     * 设置状态码
     */
    status(code: number, text?: string): this {
        if (this.headersSent) {
            throw new Error('Headers already sent');
        }

        this.statusCode = code;
        this.statusText = text || http.strstatus(code);
        return this;
    }

    /**
     * 设置头部
     */
    setHeader(name: string, value: string | string[]): this {
        if (this.headersSent) {
            throw new Error('Headers already sent');
        }

        if (Array.isArray(value)) {
            this.headers.delete(name);
            for (const v of value) {
                this.headers.append(name, v);
            }
        } else {
            this.headers.set(name, value);
        }

        return this;
    }

    /**
     * 获取头部
     */
    getHeader(name: string): string | null {
        return this.headers.get(name);
    }

    /**
     * 移除头部
     */
    removeHeader(name: string): this {
        if (this.headersSent) {
            throw new Error('Headers already sent');
        }

        this.headers.delete(name);
        return this;
    }

    /**
     * 发送头部
     */
    async writeHead(statusCode?: number, statusText?: string, headers?: Record<string, string>): Promise<void> {
        if (this.headersSent) {
            throw new Error('Headers already sent');
        }

        if (statusCode !== undefined) {
            this.statusCode = statusCode;
        }

        if (statusText !== undefined) {
            this.statusText = statusText;
        }

        if (headers) {
            for (const [key, value] of Object.entries(headers)) {
                this.headers.set(key, value);
            }
        }

        // 构建状态行
        let response = `HTTP/1.1 ${this.statusCode} ${this.statusText}\r\n`;

        // 添加头部
        response += this.headers.toString();

        // 结束头部
        response += '\r\n';

        // 发送
        await this.socket._write(engine.encodeString(response));
        this.headersSent = true;
    }

    /**
     * 写入数据
     */
    async write(chunk: string | Uint8Array | ArrayBuffer): Promise<void> {
        if (this.finished) {
            throw new Error('Response already finished');
        }

        // 自动发送头部
        if (!this.headersSent) {
            // 检查是否需要 chunked 编码
            if (!this.headers.has('content-length') && !this.headers.has('transfer-encoding')) {
                this.chunkedEncoding = true;
                this.headers.set('transfer-encoding', 'chunked');
            }

            await this.writeHead();
        }

        // 转换数据
        let data: Uint8Array;
        if (typeof chunk === 'string') {
            data = engine.encodeString(chunk);
        } else if (chunk instanceof ArrayBuffer) {
            data = new Uint8Array(chunk);
        } else {
            data = chunk;
        }

        // Chunked 编码
        if (this.chunkedEncoding) {
            const chunkSize = data.length.toString(16);
            await this.socket._write(engine.encodeString(`${chunkSize}\r\n`));
            await this.socket._write(data);
            await this.socket._write(engine.encodeString('\r\n'));
        } else {
            await this.socket._write(data);
        }
    }

    /**
     * 结束响应
     */
    async end(chunk?: string | Uint8Array | ArrayBuffer): Promise<void> {
        if (this.finished) {
            return;
        }

        if (chunk !== undefined) {
            await this.write(chunk);
        } else if (!this.headersSent) {
            // 没有 body，发送头部
            if (!this.headers.has('content-length')) {
                this.headers.set('content-length', '0');
            }
            await this.writeHead();
        }

        // Chunked 编码结束标记
        if (this.chunkedEncoding) {
            await this.socket._write(engine.encodeString('0\r\n\r\n'));
        }

        this.finished = true;
    }

    /**
     * 发送 JSON
     */
    async json(data: any): Promise<void> {
        const body = JSON.stringify(data);

        this.setHeader('content-type', 'application/json');
        this.setHeader('content-length', String(engine.encodeString(body).length));

        await this.writeHead();
        await this.write(body);
        await this.end();
    }

    /**
     * 发送文本
     */
    async text(data: string): Promise<void> {
        const body = engine.encodeString(data);

        this.setHeader('content-type', 'text/plain; charset=utf-8');
        this.setHeader('content-length', String(body.length));

        await this.writeHead();
        await this.write(body);
        await this.end();
    }

    /**
     * 发送 HTML
     */
    async html(data: string): Promise<void> {
        const body = engine.encodeString(data);

        this.setHeader('content-type', 'text/html; charset=utf-8');
        this.setHeader('content-length', String(body.length));

        await this.writeHead();
        await this.write(body);
        await this.end();
    }

    /**
     * 重定向
     */
    async redirect(url: string, statusCode: number = 302): Promise<void> {
        this.status(statusCode);
        this.setHeader('location', url);
        this.setHeader('content-length', '0');
        await this.writeHead();
        await this.end();
    }

    /**
     * Upgrade 到 WebSocket
     */
    async upgrade(): Promise<WebSocket> {
        if (this.headersSent) {
            throw new Error('Headers already sent');
        }

        const req = this.socket._currentRequest;
        if (!req) {
            throw new Error('No request available');
        }

        // 验证 WebSocket 握手
        const upgrade = req.headers.get('upgrade')?.toLowerCase();
        const connection = req.headers.get('connection')?.toLowerCase();
        const wsKey = req.headers.get('sec-websocket-key');
        const wsVersion = req.headers.get('sec-websocket-version');

        if (upgrade !== 'websocket' || !connection?.includes('upgrade')) {
            throw new Error('Not a WebSocket upgrade request');
        }

        if (wsVersion !== '13') {
            throw new Error('Unsupported WebSocket version');
        }

        if (!wsKey) {
            throw new Error('Missing Sec-WebSocket-Key');
        }

        // 计算 Sec-WebSocket-Accept
        const magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
        const hash = crypto.sha1(engine.encodeString(wsKey + magic));
        const accept = crypto.base64Encode(hash);

        // 发送握手响应
        this.status(101, 'Switching Protocols');
        this.setHeader('upgrade', 'websocket');
        this.setHeader('connection', 'Upgrade');
        this.setHeader('sec-websocket-accept', accept);

        // 协议协商
        const protocols = req.headers.get('sec-websocket-protocol');
        if (protocols) {
            // TODO: 用户回调判断可用协议
            const protocol = protocols.split(',')[0].trim();
            this.setHeader('sec-websocket-protocol', protocol);
        }

        await this.writeHead();
        this.finished = true;

        // 创建 WebSocket
        const connection2 = this.socket._getConnection();
        const ws = createWebSocketFromConnection(connection2);

        return ws;
    }
}

/**
 * 服务器 Socket 包装
 */
class ServerSocket {
    private connection: CModuleStreams.TCP;
    public _currentRequest: ServerRequest | null = null;

    constructor(connection: CModuleStreams.TCP) {
        this.connection = connection;
    }

    /**
     * 写入数据（内部使用）
     */
    async _write(data: Uint8Array): Promise<void> {
        await this.connection.write(data);
    }

    /**
     * 获取底层连接（内部使用）
     */
    _getConnection(): ConnectionLike {
        // 包装为 Connection 接口
        return {
            socket: this.connection,
            sslPipe: null,
            state: ConnectionState.ACTIVE,
            lastUsed: Date.now(),
            requests: 0,

            async connect() { },
            async write(data: Uint8Array) {
                await this.socket.write(data);
            },
            async read(size?: number) {
                const buf = new Uint8Array(size || 16384);
                const n = await this.socket.read(buf);
                return n === null ? null : buf.slice(0, n);
            },
            markActive() { },
            markIdle() { },
            close() {
                this.socket.close();
            },
            isAvailable() { return false; },
            isClosed() { return false; },
        };
    }

    /**
     * 关闭连接
     */
    close(): void {
        try {
            this.connection.close();
        } catch (err) {
            // 忽略
        }
    }
}

/**
 * 请求处理器
 */
export type RequestHandler = (req: ServerRequest, res: ServerResponse) => void | Promise<void>;

/**
 * HTTP Server
 */
export class Server {
    private server: CModuleStreams.TCP | null = null;
    private handler: RequestHandler;
    private listening: boolean = false;
    private sslContext: CModuleSSL.Context | null = null;
    private connections: Set<ServerSocket> = new Set();
    private keepAliveTimeout: number = 5000;
    private maxRequestsPerConnection: number = 100;

    constructor(handler: RequestHandler) {
        this.handler = handler;
    }

    /**
     * 监听端口
     */
    listen(port: number, hostname: string = '0.0.0.0', options?: {
        keepAliveTimeout?: number;
        maxRequestsPerConnection?: number;
    }): void {
        if (this.listening) {
            throw new Error('Server already listening');
        }

        if (options?.keepAliveTimeout !== undefined) {
            this.keepAliveTimeout = options.keepAliveTimeout;
        }

        if (options?.maxRequestsPerConnection !== undefined) {
            this.maxRequestsPerConnection = options.maxRequestsPerConnection;
        }

        this.server = new streams.TCP();

        this.server.bind({ ip: hostname, port });
        this.server.listen(511);

        this.listening = true;

        // 开始接受连接
        this.acceptLoop();
    }

    /**
     * 监听 HTTPS
     */
    listenTLS(port: number, hostname: string = '0.0.0.0', options: {
        cert: string;
        key: string;
        keepAliveTimeout?: number;
        maxRequestsPerConnection?: number;
    }): void {
        if (this.listening) {
            throw new Error('Server already listening');
        }

        // 创建 SSL 上下文
        this.sslContext = new ssl.Context({
            mode: 'server',
            cert: options.cert,
            key: options.key
        });

        // 调用普通 listen
        this.listen(port, hostname, {
            keepAliveTimeout: options.keepAliveTimeout,
            maxRequestsPerConnection: options.maxRequestsPerConnection
        });
    }

    /**
     * 接受连接循环
     */
    private async acceptLoop(): Promise<void> {
        while (this.listening && this.server) {
            try {
                const conn = await this.server.accept();
                this.handleConnection(conn as CModuleStreams.TCP);
            } catch (err) {
                if (this.listening) {
                    console.error('Accept error:', err);
                }
                break;
            }
        }
    }

    /**
     * 处理连接
     */
    private async handleConnection(conn: CModuleStreams.TCP): Promise<void> {
        const socket = new ServerSocket(conn);
        this.connections.add(socket);

        try {
            // TODO: 如果需要 SSL，在这里进行 SSL 握手

            let requestCount = 0;
            let keepAlive = true;

            while (keepAlive && requestCount < this.maxRequestsPerConnection) {
                const result = await this.handleRequest(socket);

                if (!result) {
                    // 连接关闭或错误
                    break;
                }

                requestCount++;
                keepAlive = result.keepAlive;

                // Keep-Alive 超时
                if (keepAlive) {
                    const timeoutId = timers.setTimeout(() => {
                        socket.close();
                    }, this.keepAliveTimeout);

                    // 等待下一个请求（带超时）
                    const hasNextRequest = await Promise.race([
                        this.waitForData(conn, 100),
                        new Promise<boolean>(resolve => {
                            timers.setTimeout(() => resolve(false), this.keepAliveTimeout);
                        })
                    ]);

                    timers.clearTimeout(timeoutId);

                    if (!hasNextRequest) {
                        break;
                    }
                }
            }

        } catch (err) {
            console.error('Connection error:', err);
        } finally {
            socket.close();
            this.connections.delete(socket);
        }
    }

    /**
     * 等待数据可用
     */
    private async waitForData(conn: CModuleStreams.TCP, timeout: number): Promise<boolean> {
        try {
            const buf = new Uint8Array(1);

            // 非阻塞检查
            conn.setBlocking(false);
            const n = await Promise.race([
                conn.read(buf),
                new Promise<null>(resolve => timers.setTimeout(() => resolve(null), timeout))
            ]);
            conn.setBlocking(true);

            return n !== null && n > 0;
        } catch (err) {
            return false;
        }
    }

    /**
     * 处理单个请求
     */
    private async handleRequest(socket: ServerSocket): Promise<{ keepAlive: boolean } | null> {
        const parser = new http.Parser(http.REQUEST);

        let method = '';
        let url = '';
        let httpMajor = 1;
        let httpMinor = 1;
        let headersComplete = false;
        const headers = new Headers();
        let currentHeaderField = '';

        // 设置解析器回调
        parser.onUrl = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            url += engine.decodeString(view);
        };

        parser.onHeaderField = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            currentHeaderField = engine.decodeString(view).toLowerCase();
        };

        parser.onHeaderValue = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            const value = engine.decodeString(view);
            headers.append(currentHeaderField, value);
        };

        parser.onHeadersComplete = () => {
            method = http.strstatus(parser.state.method) || 'GET';
            httpMajor = parser.state.httpMajor;
            httpMinor = parser.state.httpMinor;
            headersComplete = true;
        };

        try {
            // 读取请求头
            while (!headersComplete) {
                const buf = new Uint8Array(16384);
                const n = await socket._getConnection().socket.read(buf);

                if (n === null) {
                    return null;
                }

                const data = buf.slice(0, n);
                const result = parser.execute(data);

                if (result.errno !== 0) {
                    console.error('Parse error:', result.reason);
                    return null;
                }
            }

            // 创建请求对象
            const request = new ServerRequest(
                method,
                url,
                headers,
                `${httpMajor}.${httpMinor}`,
                socket
            );

            socket._currentRequest = request;

            // 创建响应对象
            const response = new ServerResponse(socket);

            // 处理请求体
            const contentLength = headers.get('content-length');
            const transferEncoding = headers.get('transfer-encoding');

            if (contentLength || transferEncoding?.toLowerCase().includes('chunked')) {
                // 创建 body 流
                const bodyStream = new ReadableStream<Uint8Array>({
                    start: async (controller) => {
                        try {
                            let remaining = contentLength ? parseInt(contentLength) : Infinity;

                            parser.onBody = (buf, off, len) => {
                                const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
                                request._addBodyChunk(view);
                                controller.enqueue(view);
                                remaining -= len;
                            };

                            parser.onMessageComplete = () => {
                                controller.close();
                            };

                            // 继续读取 body
                            while (!parser.state.eof && remaining > 0) {
                                const buf = new Uint8Array(Math.min(16384, remaining));
                                const n = await socket._getConnection().socket.read(buf);

                                if (n === null) break;

                                const data = buf.slice(0, n);
                                parser.execute(data);

                                if (contentLength) {
                                    remaining -= n;
                                }
                            }

                            if (!parser.state.eof) {
                                controller.close();
                            }
                        } catch (err) {
                            controller.error(err);
                        }
                    }
                });

                request._setBodyStream(bodyStream);
            }

            // 调用处理器
            await this.handler(request, response);

            // 确保响应已结束
            if (!response['finished']) {
                await response.end();
            }

            // 检查 Keep-Alive
            const connection = headers.get('connection')?.toLowerCase();
            const keepAlive = connection === 'keep-alive' ||
                (httpMajor === 1 && httpMinor === 1 && connection !== 'close');

            return { keepAlive };

        } catch (err) {
            console.error('Request handler error:', err);

            // 发送 500 错误
            try {
                const response = new ServerResponse(socket);
                await response.status(500).text('Internal Server Error');
            } catch (e) {
                // 忽略
            }

            return null;
        }
    }

    /**
     * 关闭服务器
     */
    close(): void {
        if (!this.listening) {
            return;
        }

        this.listening = false;

        // 关闭所有连接
        for (const socket of this.connections) {
            socket.close();
        }
        this.connections.clear();

        // 关闭服务器
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    /**
     * 获取服务器地址
     */
    address(): { ip: string; port: number } | null {
        if (!this.server) {
            return null;
        }

        return this.server.getsockname();
    }
}

/**
 * 创建 HTTP 服务器
 */
export function createServer(handler: RequestHandler): Server {
    return new Server(handler);
}