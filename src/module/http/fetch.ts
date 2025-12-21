/**
 * Fetch API 完整实现（重构版）
 * 符合 WHATWG Fetch Standard
 */

const engine = import.meta.use('engine');

import { connectionManager, Connection } from './connection';
import {
    HttpRequestBuilder,
    HttpResponseParser,
    type HttpMethod,
    isRedirect
} from './base';
import { Headers } from 'headers-polyfill';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/**
 * Request 类
 */
export class Request implements globalThis.Request {
    public readonly url: string;
    public readonly method: string;
    public readonly headers: Headers;
    public readonly body: ReadableStream | null;
    public bodyUsed: boolean = false;
    public readonly cache: RequestCache;
    public readonly credentials: RequestCredentials;
    public readonly destination: RequestDestination;
    public readonly integrity: string;
    public readonly keepalive: boolean;
    public readonly mode: RequestMode;
    public readonly redirect: RequestRedirect;
    public readonly referrer: string;
    public readonly referrerPolicy: ReferrerPolicy;
    public readonly signal: AbortSignal;

    public readonly isHistoryNavigation = false;
    public readonly isReloadNavigation = false;

    private _bodySource: BodyInit | null = null;
    private _bodyBuffer: Uint8Array | null = null;

    constructor(input: RequestInfo | URL, init?: RequestInit) {
        // 解析 input
        if (input instanceof URL) {
            this.url = input.toString();
            this.method = init?.method?.toUpperCase() || 'GET';
            this.headers = new Headers(init?.headers);
        } else if (typeof input === 'string') {
            this.url = input;
            this.method = init?.method?.toUpperCase() || 'GET';
            this.headers = new Headers(init?.headers);
        } else if (input instanceof Request) {
            this.url = input.url;
            this.method = init?.method?.toUpperCase() || input.method;
            this.headers = new Headers(init?.headers || input.headers);

            if (!init?.body && input.body && !input.bodyUsed) {
                this._bodySource = input._bodySource;
                this._bodyBuffer = input._bodyBuffer;
            }
        } else {
            throw new TypeError('Invalid input');
        }

        // 处理 body
        if (init?.body !== undefined && init?.body !== null) {
            this._bodySource = init.body;
        }

        // 设置其他属性
        this.cache = init?.cache || 'default';
        this.credentials = init?.credentials || 'same-origin';
        this.destination = '' as RequestDestination;
        this.integrity = init?.integrity || '';
        this.keepalive = init?.keepalive || false;
        this.mode = init?.mode || 'cors';
        this.redirect = init?.redirect || 'follow';
        this.referrer = init?.referrer || 'about:client';
        this.referrerPolicy = init?.referrerPolicy || '';
        this.signal = init?.signal ?? new AbortController().signal;

        // 创建可读流
        this.body = this._bodySource ? this.createBodyStream() : null;

        // 验证方法
        const methodsWithoutBody = ['GET', 'HEAD'];
        if (methodsWithoutBody.includes(this.method) && this.body) {
            throw new TypeError(`Request with ${this.method} method cannot have body`);
        }
    }

    private createBodyStream(): ReadableStream<Uint8Array> {
        const bodySource = this._bodySource!;
        if (bodySource instanceof ReadableStream)
            return bodySource as ReadableStream<Uint8Array>;

        return new ReadableStream({
            start: async (controller) => {
                try {
                    if (typeof bodySource === 'string') {
                        controller.enqueue(engine.encodeString(bodySource));
                    } else if (bodySource instanceof Uint8Array) {
                        controller.enqueue(bodySource as Uint8Array);
                    } else if (bodySource instanceof ArrayBuffer) {
                        controller.enqueue(new Uint8Array(bodySource));
                    } else if (bodySource instanceof Blob) {
                        const buffer = await bodySource.arrayBuffer();
                        controller.enqueue(new Uint8Array(buffer));
                    } else if (bodySource instanceof ReadableStream) {
                        const reader = bodySource.getReader();
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                controller.enqueue(value as Uint8Array);
                            }
                        } finally {
                            reader.releaseLock();
                        }
                    } else if (bodySource instanceof URLSearchParams) {
                        controller.enqueue(engine.encodeString(bodySource.toString()));
                    } else if (bodySource instanceof FormData) {
                        throw new Error('FormData not yet implemented');
                    } else {
                        controller.enqueue(engine.encodeString(JSON.stringify(bodySource)));
                    }
                    controller.close();
                } catch (err) {
                    controller.error(err);
                }
            }
        });
    }

    clone(): Request {
        if (this.bodyUsed) {
            throw new TypeError('Already read');
        }

        return new Request(this.url, {
            method: this.method,
            headers: this.headers,
            body: this._bodySource,
            cache: this.cache,
            credentials: this.credentials,
            integrity: this.integrity,
            keepalive: this.keepalive,
            mode: this.mode,
            redirect: this.redirect,
            referrer: this.referrer,
            referrerPolicy: this.referrerPolicy,
            signal: this.signal
        });
    }

    async getBodyBuffer(): Promise<Uint8Array | null> {
        if (this._bodyBuffer) return this._bodyBuffer;
        if (!this.body) return null;

        const chunks: Uint8Array[] = [];
        const reader = this.body.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        this._bodyBuffer = mergeChunks(chunks);
        return this._bodyBuffer;
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buffer = await this.getBodyBuffer();
        if (!buffer) throw new TypeError('Body is not yet available');
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }

    async bytes(): Promise<Uint8Array> {
        const buffer = await this.getBodyBuffer();
        if (!buffer) throw new TypeError('Body is not yet available');
        return buffer;
    }

    async blob(): Promise<Blob> {
        const buffer = await this.arrayBuffer();
        return new Blob([buffer]);
    }

    formData(): Promise<FormData> {
        throw new Error('FormData parsing not yet implemented');
    }

    async text(): Promise<string> {
        const buffer = await this.arrayBuffer();
        return engine.decodeString(new Uint8Array(buffer));
    }

    json(): Promise<any> {
        return this.text().then(JSON.parse);
    }
}

/**
 * Response 类
 */
export class Response implements globalThis.Response {
    public readonly type: ResponseType;
    public readonly url: string;
    public readonly redirected: boolean;
    public readonly status: number;
    public readonly ok: boolean;
    public readonly statusText: string;
    public readonly headers: Headers;
    public readonly body: ReadableStream<Uint8Array> | null;
    public bodyUsed: boolean = false;

    private _bodyBuffer: Uint8Array | null = null;

    constructor(body?: BodyInit | null, init?: ResponseInit) {
        this.status = init?.status || 200;
        this.statusText = init?.statusText || '';
        this.ok = this.status >= 200 && this.status < 300;
        this.type = 'default';
        this.url = '';
        this.redirected = false;

        if (init?.headers) {
            this.headers = new Headers();
            for (const [key, value] of (init.headers as any).entries()) {
                this.headers.set(key, value);
            }
        } else {
            this.headers = new Headers({
                'user-agent': 'circu.js/cno'
            });
        }

        this.body = (body !== undefined && body !== null)
            ? this.createBodyStream(body)
            : null;
    }

    private createBodyStream(bodyInit: BodyInit): ReadableStream<Uint8Array> {
        if (bodyInit instanceof ReadableStream)
            return bodyInit as ReadableStream<Uint8Array>;
        
        return new ReadableStream({
            start: async (controller) => {
                try {
                    if (typeof bodyInit === 'string') {
                        controller.enqueue(engine.encodeString(bodyInit));
                    } else if (bodyInit instanceof Uint8Array) {
                        controller.enqueue(bodyInit as Uint8Array);
                    } else if (bodyInit instanceof ArrayBuffer) {
                        controller.enqueue(new Uint8Array(bodyInit));
                    } else if (bodyInit instanceof Blob) {
                        const buffer = await bodyInit.arrayBuffer();
                        controller.enqueue(new Uint8Array(buffer));
                    } else if (bodyInit instanceof ReadableStream) {
                        const reader = bodyInit.getReader();
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                controller.enqueue(value as Uint8Array);
                            }
                        } finally {
                            reader.releaseLock();
                        }
                    } else if (bodyInit instanceof URLSearchParams) {
                        controller.enqueue(engine.encodeString(bodyInit.toString()));
                    } else if (bodyInit instanceof FormData) {
                        throw new Error('FormData not yet implemented');
                    } else {
                        controller.enqueue(engine.encodeString(JSON.stringify(bodyInit)));
                    }
                    controller.close();
                } catch (err) {
                    controller.error(err);
                }
            }
        });
    }

    clone(): Response {
        if (this.bodyUsed) {
            throw new TypeError('Already read');
        }

        const response = new Response(this._bodyBuffer, {
            status: this.status,
            statusText: this.statusText,
            headers: this.headers
        });

        Object.defineProperty(response, 'type', { value: this.type });
        Object.defineProperty(response, 'url', { value: this.url });
        Object.defineProperty(response, 'redirected', { value: this.redirected });

        return response;
    }

    async bytes(): Promise<Uint8Array> {
        if (this.bodyUsed) throw new TypeError('Already read');
        this.bodyUsed = true;

        if (this._bodyBuffer) return this._bodyBuffer;
        if (!this.body) return new Uint8Array(0);

        const chunks: Uint8Array[] = [];
        const reader = this.body.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        this._bodyBuffer = mergeChunks(chunks);
        return this._bodyBuffer;
    }

    arrayBuffer(): Promise<ArrayBuffer> {
        return this.bytes().then(buffer =>
            buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        );
    }

    async blob(): Promise<Blob> {
        const buffer = await this.arrayBuffer();
        const contentType = this.headers.get('content-type') || 'application/octet-stream';
        return new Blob([buffer], { type: contentType });
    }

    formData(): Promise<FormData> {
        throw new Error('FormData parsing not yet implemented');
    }

    async json<T = any>(): Promise<T> {
        const text = await this.text();
        return JSON.parse(text);
    }

    async text(): Promise<string> {
        const buffer = await this.arrayBuffer();
        return engine.decodeString(new Uint8Array(buffer));
    }

    static error(): Response {
        const response = new Response(null, { status: 0, statusText: '' });
        Object.defineProperty(response, 'type', { value: 'error' });
        return response;
    }

    static redirect(url: string, status: number = 302): Response {
        if (![301, 302, 303, 307, 308].includes(status)) {
            throw new RangeError('Invalid redirect status');
        }

        const response = new Response(null, {
            status,
            headers: { Location: url }
        });

        Object.defineProperty(response, 'type', { value: 'default' });
        return response;
    }

    static json(data: any, init?: ResponseInit): Response {
        const body = JSON.stringify(data);
        const headers = new Headers(init?.headers);

        if (!headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }

        return new Response(body, { ...init, headers });
    }
}

/**
 * 工具函数：合并数据块
 */
function mergeChunks(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return result;
}

/**
 * HTTP 响应上下文
 */
interface FetchContext {
    request: Request;
    url: URL;
    connection: Connection;
    parser: HttpResponseParser;
    aborted: boolean;
}

/**
 * 创建响应体流
 */
function createResponseBodyStream(ctx: FetchContext): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start: async (controller) => {
            try {
                if (ctx.aborted) {
                    controller.close();
                    return;
                }

                // 设置数据和完成回调
                ctx.parser.onData = (chunk) => {
                    if (!ctx.aborted) {
                        controller.enqueue(chunk);
                    }
                };
                
                // 输出已缓存的 body 数据
                const existingBody = ctx.parser.getBodyChunks();
                for (const chunk of existingBody) {
                    controller.enqueue(chunk);
                }

                // 检查是否已完成
                if (ctx.parser.isCompleted()) {
                    controller.close();
                    releaseConnection(ctx);
                    return;
                }

                ctx.parser.onComplete = () => {
                    controller.close();
                    releaseConnection(ctx);
                };

                ctx.parser.onError = (err) => {
                    if (!ctx.aborted) {
                        controller.error(err);
                    }
                };
            } catch (err) {
                if (!ctx.aborted) {
                    controller.error(err);
                }
            }
        },

        async pull(controller) {
            if (ctx.aborted) {
                controller.close();
                return;
            }
            await readBody(ctx);
        },

        cancel: () => {
            ctx.aborted = true;
            if (ctx.connection) {
                ctx.connection.close();
            }
        }
    });
}

/**
 * 读取响应头部
 */
async function readHeaders(ctx: FetchContext): Promise<void> {
    while (!ctx.parser.isHeadersComplete() && !ctx.aborted) {
        const data = await ctx.connection.read();
        if (!data || data.length === 0) break;
        ctx.parser.feed(data);
    }
}

/**
 * 读取响应体
 */
async function readBody(ctx: FetchContext): Promise<void> {
    const data = await ctx.connection.read();
    if (!data || data.length === 0) return;
    ctx.parser.feed(data);
}

/**
 * 释放连接
 */
function releaseConnection(ctx: FetchContext): void {
    const { url, connection } = ctx;
    const port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);

    connectionManager.release({
        hostname: url.hostname,
        port,
        protocol: url.protocol as 'http:' | 'https:'
    }, connection);
    ctx.parser.reset();
}

/**
 * 执行 Fetch 请求（核心逻辑）
 */
async function performFetch(
    request: Request,
    url: URL,
    redirectCount: number = 0
): Promise<Response> {
    if (redirectCount > 20) {
        throw new TypeError('Too many redirects');
    }

    // 获取连接
    const port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);
    const connection = await connectionManager.acquire({
        hostname: url.hostname,
        port,
        protocol: url.protocol as 'http:' | 'https:',
        keepAlive: request.keepalive,
        timeout: 30000
    });

    try {
        // 发送请求
        await sendRequest(request, url, connection);

        // 创建解析上下文
        const ctx: FetchContext = {
            request,
            url,
            connection,
            parser: new HttpResponseParser(),
            aborted: false
        };

        // 设置 AbortSignal 处理
        const abortHandler = () => {
            ctx.aborted = true;
        };

        if (request.signal) {
            request.signal.addEventListener('abort', abortHandler);
        }

        // 解析响应头部
        await readHeaders(ctx);

        if (ctx.aborted) {
            throw new DOMException('The operation was aborted', 'AbortError');
        }

        const statusCode = ctx.parser.getStatusCode();
        const statusText = ctx.parser.getStatusText();
        const headers = ctx.parser.getHeaders();

        // 处理重定向
        if (request.redirect === 'follow' && isRedirect(statusCode)) {
            const location = headers.get('location');

            if (location) {
                releaseConnection(ctx);

                if (request.signal) {
                    request.signal.removeEventListener('abort', abortHandler);
                }

                return handleRedirect(request, url, location, statusCode, redirectCount);
            }
        }
        
        // 创建响应体流
        const bodyStream = createResponseBodyStream(ctx);
        const response = new Response(bodyStream, {
            status: statusCode,
            statusText,
            headers
        });

        Object.defineProperty(response, 'url', { value: url.toString() });
        Object.defineProperty(response, 'redirected', { value: redirectCount > 0 });

        return response;

    } catch (err) {
        releaseConnection({ url, connection } as any);
        throw err;
    }
}

/**
 * 发送 HTTP 请求
 */
async function sendRequest(request: Request, url: URL, connection: Connection): Promise<void> {
    const bodyBuffer = await request.getBodyBuffer();

    const builder = new HttpRequestBuilder(url, {
        method: request.method as HttpMethod,
        headers: request.headers as any,
        body: bodyBuffer
    });

    const requestBytes = builder.build();
    await connection.write(requestBytes);
}

/**
 * 处理重定向
 */
async function handleRedirect(
    request: Request,
    url: URL,
    location: string,
    statusCode: number,
    redirectCount: number
): Promise<Response> {
    const redirectUrl = new URL(location, url);

    // 处理重定向方法
    let redirectMethod = request.method;
    if (statusCode === 303 ||
        ((statusCode === 301 || statusCode === 302) && request.method === 'POST')) {
        redirectMethod = 'GET';
    }

    // 创建重定向请求
    const redirectRequest = new Request(redirectUrl.toString(), {
        method: redirectMethod,
        headers: request.headers,
        body: redirectMethod === 'GET' ? null : (request as any)._bodySource,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        signal: request.signal
    });

    return performFetch(redirectRequest, redirectUrl, redirectCount + 1);
}

/**
 * Fetch 入口函数
 */
export async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (input instanceof URL) {
        input = input.toString();
    }

    const request = new Request(input, init);

    if (request.signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
    }

    const url = new URL(request.url);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new TypeError(`Unsupported protocol: ${url.protocol}`);
    }

    return performFetch(request, url);
}

// 全局导出
Reflect.set(globalThis, 'fetch', fetch);
Reflect.set(globalThis, 'Response', Response);
Reflect.set(globalThis, 'Request', Request);