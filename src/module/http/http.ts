import { Headers } from "headers-polyfill";
import { assert } from "../../utils/assert";
import { version } from "../../../package.json"
import { StreamingDecompressor } from "./zlib";

const http = import.meta.use('http');
const engine = import.meta.use('engine');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/**
 * HTTP 方法
 */
export type HttpMethod =
    | 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
    | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE' | string;

/**
 * HTTP 请求构建器
 */
export class HttpRequestBuilder {
    private method: HttpMethod = 'GET';
    private url: URL;
    private headers: globalThis.Headers = new Headers();
    private body: Uint8Array | null = null;
    private useFullUrl: boolean = false;
    private httpVersion: string = '1.1';

    static DEFAULT_HEADER = {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-encoding": "gzip, deflate",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": "CNO/" + version
    }

    constructor(url: string | URL, options?: {
        method?: HttpMethod;
        headers?: HeadersInit;
        body?: BodyInit | null;
        proxy?: boolean;
        httpVersion?: string;
    }) {
        this.url = typeof url === 'string' ? new URL(url) : url;
        this.useFullUrl = options?.proxy || false;
        this.httpVersion = options?.httpVersion || '1.1';

        if (options?.method) {
            this.method = options.method.toUpperCase() as HttpMethod;
        }

        if (options?.headers) {
            this.headers = new Headers(options.headers);
        }

        if (options?.body !== undefined && options?.body !== null) {
            this.setBody(options.body);
        }
    }

    /**
     * 设置请求体
     */
    private setBody(body: BodyInit): void {
        if (body instanceof Uint8Array) {
            if (body.buffer instanceof SharedArrayBuffer)
                throw new Error('SharedArrayBuffer is not supported here');
            // @ts-ignore
            this.body = body;
        } else if (body instanceof ArrayBuffer) {
            this.body = new Uint8Array(body);
        } else if (body instanceof Blob) {
            throw new Error('Blob body requires async build(), use buildAsync()');
        } else if (body instanceof ReadableStream) {
            throw new Error('Stream body not supported in build(), use streaming API');
        } else if (typeof body === 'string') {
            this.body = engine.encodeString(body);
        } else if (body instanceof URLSearchParams) {
            this.body = engine.encodeString(body.toString());
            if (!this.headers.has('content-type')) {
                this.headers.set('content-type', 'application/x-www-form-urlencoded');
            }
        } else if (body instanceof FormData) {
            throw new Error('FormData requires async build(), use buildAsync()');
        } else {
            // 假设是 JSON 可序列化对象
            this.body = engine.encodeString(JSON.stringify(body));
            if (!this.headers.has('content-type')) {
                this.headers.set('content-type', 'application/json');
            }
        }
    }

    /**
     * 异步设置请求体（用于 Blob/FormData）
     */
    private async setBodyAsync(body: BodyInit): Promise<void> {
        if (body instanceof Blob) {
            const arrayBuffer = await body.arrayBuffer();
            this.body = new Uint8Array(arrayBuffer);
            if (!this.headers.has('content-type') && body.type) {
                this.headers.set('content-type', body.type);
            }
        } else if (body instanceof FormData) {
            const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
            const parts: Uint8Array[] = [];
            const encoder = new TextEncoder();

            for (const [key, value] of body as any) {
                let headers = `--${boundary}\r\n`;
                if (typeof value === 'string') {
                    headers += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
                    parts.push(encoder.encode(headers));
                    parts.push(encoder.encode(value));
                    parts.push(encoder.encode('\r\n'));
                } else if (value instanceof Blob) {
                    const fileName = (value as any).name || 'file';
                    headers += `Content-Disposition: form-data; name="${key}"; filename="${fileName}"\r\n`;
                    headers += `Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`;
                    parts.push(encoder.encode(headers));
                    const buffer = await value.arrayBuffer();
                    parts.push(new Uint8Array(buffer));
                    parts.push(encoder.encode('\r\n'));
                }
            }
            parts.push(encoder.encode(`--${boundary}--\r\n`));

            const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
            this.body = new Uint8Array(totalLength);
            let offset = 0;
            for (const part of parts) {
                this.body.set(part, offset);
                offset += part.length;
            }
            this.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
        } else {
            this.setBody(body);
        }
    }

    /**
     * 构建 HTTP 请求（同步）
     */
    build(): Uint8Array {
        // 设置默认头部
        if (!this.headers.has('host')) {
            this.headers.set('host', this.url.host);
        }

        if (this.body && !this.headers.has('content-length')) {
            this.headers.set('content-length', String(this.body.length));
        }

        for (const [key, value] of Object.entries(HttpRequestBuilder.DEFAULT_HEADER)) {
            if (!this.headers.has(key)) {
                this.headers.set(key, value);
            }
        }

        // 构建请求行
        const path = this.useFullUrl
            ? this.url.toString()  // Full URL for proxy
            : this.url.pathname + this.url.search;
        let request = `${this.method} ${path} HTTP/${this.httpVersion}\r\n`;

        // 添加头部
        for (const [key, value] of this.headers) {
            if (key && value) request += `${key}: ${value}\r\n`;
        }

        // 结束头部
        request += '\r\n';

        // 转换为字节
        const headerBytes = engine.encodeString(request);

        // 如果有请求体，合并
        if (this.body) {
            const combined = new Uint8Array(headerBytes.length + this.body.length);
            combined.set(headerBytes, 0);
            combined.set(this.body, headerBytes.length);
            return combined;
        }

        return headerBytes;
    }

    /**
     * 构建 HTTP 请求（异步，支持 Blob/FormData）
     */
    async buildAsync(body?: BodyInit): Promise<Uint8Array> {
        if (body !== undefined) {
            await this.setBodyAsync(body);
        }
        return this.build();
    }

    /**
     * 获取头部
     */
    getHeaders(): globalThis.Headers {
        return this.headers;
    }

    /**
     * 获取请求体
     */
    getBody(): Uint8Array | null {
        return this.body;
    }
}

/**
 * HTTP 响应解析器
 */
export class HttpResponseParser {
    private parser: CModuleHTTP.Parser;
    private statusCode: number = 0;
    private statusText: string = '';
    private headers: globalThis.Headers = new Headers();
    private bodyChunks: Uint8Array[] = [];
    private currentHeaderField: string = '';
    private completed: boolean = false;
    private headersComplete: boolean = false;
    private decompressor: StreamingDecompressor | null = null;

    // 回调钩子
    public onHeadersComplete?: (statusCode: number, headers: globalThis.Headers) => void;
    public onData?: (chunk: Uint8Array) => void;
    public onComplete?: () => void;
    public onError?: (error: Error) => void;

    constructor() {
        this.parser = new http.Parser(http.RESPONSE);
        this.setupCallbacks();
    }

    /**
     * 设置解析器回调
     */
    private setupCallbacks(): void {
        // 状态行
        this.parser.onStatus = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            this.statusText = engine.decodeString(view);
        };

        // 头部字段名
        this.parser.onHeaderField = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            this.currentHeaderField = engine.decodeString(view).toLowerCase();
        };

        // 头部值
        this.parser.onHeaderValue = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            const value = engine.decodeString(view);
            this.headers.append(this.currentHeaderField, value);
            this.currentHeaderField = '';
        };

        // 头部完成
        this.parser.onHeadersComplete = () => {
            // update status
            this.statusCode = this.parser.state.status;
            this.headersComplete = true;
            if(!this.statusText) {
                this.statusText = http.strstatus(this.statusCode);
            }

            // 根据 Content-Encoding 创建解压器
            const ce = this.headers.get('content-encoding');
            if (ce) {
                this.decompressor = new StreamingDecompressor(ce);
            }

            this.onHeadersComplete?.(this.statusCode, this.headers);
        };

        // 响应体数据
        this.parser.onBody = (buf, off, len) => {
            let view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            // 透明解压
            if (this.decompressor?.isActive) {
                view = this.decompressor.decompress(view);
            }
            if(!this.onData) this.bodyChunks.push(view);    // 缓存
            this.onData?.(view);
        };

        // 消息完成
        this.parser.onMessageComplete = () => {
            this.completed = true;
            this.onComplete?.();
        };
    }

    /**
     * 喂入数据
     */
    feed(data: Uint8Array): void {
        try {
            // 传ArrayBuffer，匹配callback断言
            const result = this.parser.execute(data.buffer.slice(data.byteOffset, data.length + data.byteOffset));
            if (result.errno !== 0) {
                const error = new Error(`HTTP parse error: ${result.reason}`);
                if (this.onError) {
                    this.onError(error);
                } else {
                    throw error;
                }
            }
        } catch (err) {
            if (this.onError) {
                this.onError(err as Error);
            } else {
                throw err;
            }
        }
    }

    /**
     * 获取状态码
     */
    getStatusCode(): number {
        assert(this.statusCode, "Response not completed");
        return this.statusCode;
    }

    /**
     * 获取状态文本
     */
    getStatusText(): string {
        assert(this.statusCode, "Response not completed");
        return this.statusText || "Unknown";
    }

    /**
     * 获取头部
     */
    getHeaders(): globalThis.Headers {
        assert(this.statusCode, "Response not completed");
        return this.headers;
    }

    getBodyChunks(): Uint8Array[] {
        const t = this.bodyChunks;
        this.bodyChunks = [];
        return t;
    }

    /**
     * 检查是否完成
     */
    get isCompleted(): boolean {
        return this.completed;
    }

    /**
     * 检查头部是否完成
     */
    get isHeadersComplete(): boolean {
        return this.headersComplete;
    }

    /**
     * 重置解析器
     */
    reset(): void {
        this.parser.reset(http.RESPONSE);
        this.statusCode = 0;
        this.statusText = '';
        this.headers = new Headers();
        this.bodyChunks = [];
        this.currentHeaderField = '';
        this.completed = false;
        this.headersComplete = false;
        this.decompressor = null;

        // 重置回调
        this.onComplete = this.onData =
        this.onError = this.onHeadersComplete = undefined;
    }
}

/**
 * 解析 URL
 */
export function parseURL(url: string, base?: string): URL {
    try {
        return new URL(url, base);
    } catch (err) {
        throw new Error(`Invalid URL: ${url}`);
    }
}

/**
 * 规范化 HTTP 方法
 */
export function normalizeMethod(method: string): HttpMethod {
    const normalized = method.toUpperCase();
    const validMethods: HttpMethod[] = [
        'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
        'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'
    ];

    if (!validMethods.includes(normalized as HttpMethod)) {
        return method as HttpMethod;
    }

    return normalized as HttpMethod;
}

/**
 * 解析 Content-Type
 */
export function parseContentType(contentType: string): {
    type: string;
    parameters: Map<string, string>;
} {
    const parts = contentType.split(';').map(p => p.trim());
    const type = parts[0]!.toLowerCase();
    const parameters = new Map<string, string>();

    for (let i = 1; i < parts.length; i++) {
        const [key, value] = parts[i]!.split('=').map(p => p.trim());
        if (key && value) {
            parameters.set(key.toLowerCase(), value.replace(/^["']|["']$/g, ''));
        }
    }

    return { type, parameters };
}

/**
 * 判断状态码是否表示重定向
 */
export function isRedirect(statusCode: number): boolean {
    return statusCode >= 300 && statusCode < 400;
}

/**
 * 判断状态码是否表示成功
 */
export function isSuccess(statusCode: number): boolean {
    return statusCode >= 200 && statusCode < 300;
}

/**
 * 判断是否需要请求体
 */
export function methodHasBody(method: HttpMethod): boolean {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

const STATUS_TEXT_MAP: Record<number, string> = {
    100: 'Continue',
    101: 'Switching Protocols',
    102: 'Processing',
    103: 'Early Hints',
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    203: 'Non-Authoritative Information',
    204: 'No Content',
    205: 'Reset Content',
    206: 'Partial Content',
    207: 'Multi-Status',
    208: 'Already Reported',
    226: 'IM Used',
    300: 'Multiple Choices',
    301: 'Moved Permanently',
    302: 'Found',
    303: 'See Other',
    304: 'Not Modified',
    305: 'Use Proxy',
    306: 'Unused',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    407: 'Proxy Authentication Required',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    411: 'Length Required',
    412: 'Precondition Failed',
    413: 'Payload Too Large',
    414: 'URI Too Long',
    415: 'Unsupported Media Type',
    416: 'Range Not Satisfiable',
    417: 'Expectation Failed',
    418: 'I\'m a teapot',
    421: 'Misdirected Request',
    422: 'Unprocessable Entity',
    423: 'Locked',
    424: 'Failed Dependency',
    425: 'Too Early',
    426: 'Upgrade Required',
    428: 'Precondition Required',
    429: 'Too Many Requests',
    431: 'Request Header Fields Too Large',
    451: 'Unavailable For Legal Reasons',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
    505: 'HTTP Version Not Supported',
    506: 'Variant Also Negotiates',
    507: 'Insufficient Storage',
    508: 'Loop Detected',
    509: 'Bandwidth Limit Exceeded',
    510: 'Not Extended',
    511: 'Network Authentication Required',
};

export function strstatus(code: number): string {
    return STATUS_TEXT_MAP[code] ?? `Status ${code}`;
}