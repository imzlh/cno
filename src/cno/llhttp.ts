const http = import.meta.use('http');
const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');

const METHODS: CNO.HttpMethod[] = [
    "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT",
    "OPTIONS", "TRACE", "COPY", "LOCK", "MKCOL", "MOVE",
    "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND",
    "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY",
    "CHECKOUT", "MERGE", "MSEARCH", "NOTIFY", "SUBSCRIBE",
    "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK",
];

const CRLF = new Uint8Array([0x0D, 0x0A]);

type HttpStreamMessage = CNO.HttpRequestMessage | CNO.HttpResponseMessage;

function toByteView(buf: CModuleHTTP.BufferSource): Uint8Array {
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    return new Uint8Array(new globalThis.Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

const decode = (buf: CModuleHTTP.BufferSource, off: number, len: number): string =>
    engine.decodeString(toByteView(buf).subarray(off, off + len));

function mapState(raw: CModuleHTTP.ParserState, parserType: 0 | 1): CNO.HttpParserState {
    return {
        type: parserType === 0 ? 'request' : 'response',
        httpMajor: raw.httpMajor,
        httpMinor: raw.httpMinor,
        statusCode: raw.status,
        method: METHODS[raw.method] ?? 'GET',
        upgrade: raw.upgrade,
        keepAlive: raw.keepAlive,
    };
}

function concat(...parts: Uint8Array[]): Uint8Array {
    return algorithm.bytesConcat(parts);
}

function encode(s: string): Uint8Array {
    return engine.encodeString(s);
}

// Low-level: event-driven parser

class LLHttpParser implements CNO.HttpParser {
    #parser: CModuleHTTP.Parser;
    #type: 0 | 1;
    #events: CNO.HttpParserEvents;

    constructor(type: 0 | 1, events: CNO.HttpParserEvents) {
        this.#type = type;
        this.#events = events;
        this.#parser = new http.Parser(type);
        this.#wire();
    }

    #wire(): void {
        const onUrl = this.#events.onUrl;
        if (onUrl) this.#parser.onUrl = (buf, off, len) => { onUrl(decode(buf, off, len)); };
        const onStatus = this.#events.onStatus;
        if (onStatus) this.#parser.onStatus = (buf, off, len) => { onStatus(decode(buf, off, len)); };
        const onHeaderField = this.#events.onHeaderField;
        if (onHeaderField) this.#parser.onHeaderField = (buf, off, len) => { onHeaderField(decode(buf, off, len)); };
        const onHeaderValue = this.#events.onHeaderValue;
        if (onHeaderValue) this.#parser.onHeaderValue = (buf, off, len) => { onHeaderValue(decode(buf, off, len)); };
        const onHeadersComplete = this.#events.onHeadersComplete;
        if (onHeadersComplete) this.#parser.onHeadersComplete = () => { onHeadersComplete(mapState(this.#parser.state, this.#type)); };
        const onBody = this.#events.onBody;
        if (onBody) this.#parser.onBody = (buf, off, len) => { onBody(toByteView(buf).slice(off, off + len)); };
        const onMessageComplete = this.#events.onMessageComplete;
        if (onMessageComplete) this.#parser.onMessageComplete = () => { onMessageComplete(); };
        const onChunkHeader = this.#events.onChunkHeader;
        if (onChunkHeader) this.#parser.onChunkHeader = () => { onChunkHeader(0); };
        const onChunkComplete = this.#events.onChunkComplete;
        if (onChunkComplete) this.#parser.onChunkComplete = () => { onChunkComplete(); };
    }

    execute(data: Uint8Array | ArrayBuffer): CNO.HttpParserResult {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const r = this.#parser.execute(buf);
        return { errno: r.errno, name: r.name, reason: r.reason, bytesConsumed: r.bytesConsumed };
    }

    finish(): CNO.HttpParserResult {
        const r = this.#parser.finish();
        return { errno: r.errno, name: r.name, reason: r.reason, bytesConsumed: 0 };
    }

    pause(): void { this.#parser.pause(); }
    resume(): void { this.#parser.resume(); }

    reset(type?: 'request' | 'response'): void {
        const t = type === 'response' ? 1 : 0;
        this.#type = t as 0 | 1;
        this.#parser.reset(t);
        this.#wire();
    }

    get state(): CNO.HttpParserState {
        return mapState(this.#parser.state, this.#type);
    }
}

function createRequestParser(events: CNO.HttpParserEvents): CNO.HttpParser {
    return new LLHttpParser(http.REQUEST, events);
}

function createResponseParser(events: CNO.HttpParserEvents): CNO.HttpParser {
    return new LLHttpParser(http.RESPONSE, events);
}

// High-level: StreamingHttpParser

class StreamingParser<T extends HttpStreamMessage> implements CNO.StreamingHttpParser {
    #parser: CModuleHTTP.Parser;
    #type: 0 | 1;
    #onMessage: (msg: T) => void;
    #onError?: (err: Error) => void;

    // Per-message accumulation
    #method: CNO.HttpMethod = 'GET';
    #url = '';
    #statusCode = 0;
    #statusText = '';
    #headerField = '';
    #headers = new Headers();
    #httpMajor = 1;
    #httpMinor = 1;
    #upgrade = false;
    #keepAlive = false;
    #bodyCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    #bodyStream: ReadableStream<Uint8Array> | null = null;
    #hasBody = false;
    #expectContinue = false;

    constructor(type: 0 | 1, onMessage: (msg: T) => void, onError?: (err: Error) => void) {
        this.#type = type;
        this.#onMessage = onMessage;
        this.#onError = onError;
        this.#parser = new http.Parser(type);
        this.#wire();
    }

    #resetAccum(): void {
        this.#method = 'GET';
        this.#url = '';
        this.#statusCode = 0;
        this.#statusText = '';
        this.#headerField = '';
        this.#headers = new Headers();
        this.#httpMajor = 1;
        this.#httpMinor = 1;
        this.#upgrade = false;
        this.#keepAlive = false;
        this.#bodyCtrl = null;
        this.#bodyStream = null;
        this.#hasBody = false;
        this.#expectContinue = false;
    }

    #wire(): void {
        if (this.#type === http.REQUEST) {
            this.#parser.onUrl = (buf, off, len) => { this.#url += decode(buf, off, len); };
        } else {
            this.#parser.onStatus = (buf, off, len) => { this.#statusText += decode(buf, off, len); };
        }

        this.#parser.onHeaderField = (buf, off, len) => {
            this.#headerField = decode(buf, off, len);
        };

        this.#parser.onHeaderValue = (buf, off, len) => {
            const value = decode(buf, off, len);
            this.#headers.append(this.#headerField, value);
        };

        this.#parser.onHeadersComplete = () => {
            const s = this.#parser.state;
            this.#httpMajor = s.httpMajor;
            this.#httpMinor = s.httpMinor;
            this.#upgrade = s.upgrade;
            this.#keepAlive = s.keepAlive;
            this.#expectContinue = this.#headers.get('expect')?.toLowerCase() === '100-continue';

            if (this.#type === http.REQUEST) {
                this.#method = METHODS[s.method] ?? 'GET';
            } else {
                this.#statusCode = s.status;
                if (!this.#statusText) this.#statusText = http.strstatus(this.#statusCode);
            }

            // Set up body stream if body is expected
            const cl = this.#headers.get('content-length');
            const te = this.#headers.get('transfer-encoding');
            if (cl !== null || te !== null || this.#upgrade) {
                this.#hasBody = true;
                this.#bodyStream = new ReadableStream<Uint8Array>({
                    start: (ctrl) => { this.#bodyCtrl = ctrl; }
                });
            }
        };

        this.#parser.onBody = (buf, off, len) => {
            if (this.#bodyCtrl) {
                this.#bodyCtrl.enqueue(toByteView(buf).slice(off, off + len));
            }
        };

        this.#parser.onMessageComplete = () => {
            if (this.#bodyCtrl) {
                this.#bodyCtrl.close();
                this.#bodyCtrl = null;
            }

            const httpVersion = `${this.#httpMajor}.${this.#httpMinor}`;
            let msg: HttpStreamMessage;

            if (this.#type === http.REQUEST) {
                msg = {
                    method: this.#method,
                    url: this.#url,
                    httpVersion,
                    headers: this.#headers,
                    body: this.#bodyStream,
                    upgrade: this.#upgrade,
                    keepAlive: this.#keepAlive,
                };
            } else {
                msg = {
                    statusCode: this.#statusCode,
                    statusText: this.#statusText,
                    httpVersion,
                    headers: this.#headers,
                    body: this.#bodyStream,
                    keepAlive: this.#keepAlive,
                };
            }

            this.#onMessage(msg as T);

            // Reset for next message on keep-alive
            if (this.#keepAlive) {
                this.#resetAccum();
                this.#parser.reset(this.#type);
                this.#wire();
            }
        };
    }

    feed(data: Uint8Array | ArrayBuffer): void {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const result = this.#parser.execute(buf);
        if (result.errno !== 0 && result.name !== 'HPE_PAUSED_UPGRADE') {
            this.#onError?.(new Error(`HTTP parse error: ${result.reason ?? result.name}`));
        }
    }

    pause(): void { this.#parser.pause(); }
    resume(): void { this.#parser.resume(); }

    reset(): void {
        this.#resetAccum();
        this.#parser.reset(this.#type);
        this.#wire();
    }

    get expectContinue(): boolean { return this.#expectContinue; }
}

function createRequestStreamParser(onMessage: (msg: CNO.HttpRequestMessage) => void, onError?: (err: Error) => void): CNO.StreamingHttpParser {
    return new StreamingParser<CNO.HttpRequestMessage>(http.REQUEST, onMessage, onError);
}

function createResponseStreamParser(onMessage: (msg: CNO.HttpResponseMessage) => void, onError?: (err: Error) => void): CNO.StreamingHttpParser {
    return new StreamingParser<CNO.HttpResponseMessage>(http.RESPONSE, onMessage, onError);
}

// One-shot parse

function parseRequest(data: Uint8Array | ArrayBuffer): CNO.HttpRequestMessage {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    let method: CNO.HttpMethod = 'GET';
    let url = '';
    let headerField = '';
    const headers = new Headers();
    let upgrade = false;
    let keepAlive = false;
    let httpMajor = 1;
    let httpMinor = 1;
    const bodyChunks: Uint8Array[] = [];

    const parser = new http.Parser(http.REQUEST);
    parser.onUrl = (b, off, len) => { url += decode(b, off, len); };
    parser.onHeaderField = (b, off, len) => { headerField = decode(b, off, len); };
    parser.onHeaderValue = (b, off, len) => { headers.append(headerField, decode(b, off, len)); };
    parser.onHeadersComplete = () => {
        const s = parser.state;
        method = METHODS[s.method] ?? 'GET';
        upgrade = s.upgrade;
        keepAlive = s.keepAlive;
        httpMajor = s.httpMajor;
        httpMinor = s.httpMinor;
    };
    parser.onBody = (b, off, len) => { bodyChunks.push(toByteView(b).slice(off, off + len)); };

    const result = parser.execute(buf);
    if (result.errno !== 0 && result.name !== 'HPE_PAUSED_UPGRADE') {
        throw new Error(`HTTP parse error: ${result.reason ?? result.name}`);
    }
    parser.finish();

    const body = bodyChunks.length > 0
        ? new ReadableStream({ start(c) { for (const ch of bodyChunks) c.enqueue(ch); c.close(); } })
        : null;

    return { method, url, httpVersion: `${httpMajor}.${httpMinor}`, headers, body, upgrade, keepAlive };
}

function parseResponse(data: Uint8Array | ArrayBuffer): CNO.HttpResponseMessage {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    let statusCode = 0;
    let statusText = '';
    let headerField = '';
    const headers = new Headers();
    let keepAlive = false;
    let httpMajor = 1;
    let httpMinor = 1;
    const bodyChunks: Uint8Array[] = [];

    const parser = new http.Parser(http.RESPONSE);
    parser.onStatus = (b, off, len) => { statusText += decode(b, off, len); };
    parser.onHeaderField = (b, off, len) => { headerField = decode(b, off, len); };
    parser.onHeaderValue = (b, off, len) => { headers.append(headerField, decode(b, off, len)); };
    parser.onHeadersComplete = () => {
        const s = parser.state;
        statusCode = s.status;
        keepAlive = s.keepAlive;
        httpMajor = s.httpMajor;
        httpMinor = s.httpMinor;
        if (!statusText) statusText = http.strstatus(statusCode);
    };
    parser.onBody = (b, off, len) => { bodyChunks.push(toByteView(b).slice(off, off + len)); };

    const result = parser.execute(buf);
    if (result.errno !== 0) {
        throw new Error(`HTTP parse error: ${result.reason ?? result.name}`);
    }
    parser.finish();

    const body = bodyChunks.length > 0
        ? new ReadableStream({ start(c) { for (const ch of bodyChunks) c.enqueue(ch); c.close(); } })
        : null;

    return { statusCode, statusText, httpVersion: `${httpMajor}.${httpMinor}`, headers, body, keepAlive };
}

// Format: structured data → raw HTTP bytes

function formatRequestHead(method: CNO.HttpMethod, url: string, headers: Headers, options?: CNO.HttpFormatOptions): Uint8Array {
    const ver = options?.httpVersion ?? '1.1';
    const line = `${method} ${url} HTTP/${ver}\r\n`;
    const parts: Uint8Array[] = [encode(line)];

    for (const [key, value] of headers) {
        parts.push(encode(`${key}: ${value}\r\n`));
    }

    parts.push(CRLF);
    return concat(...parts);
}

function formatResponseHead(statusCode: number, statusText: string, headers: Headers, options?: CNO.HttpFormatOptions): Uint8Array {
    const ver = options?.httpVersion ?? '1.1';
    const line = `HTTP/${ver} ${statusCode} ${statusText}\r\n`;
    const parts: Uint8Array[] = [encode(line)];

    for (const [key, value] of headers) {
        parts.push(encode(`${key}: ${value}\r\n`));
    }

    parts.push(CRLF);
    return concat(...parts);
}

function formatRequest(method: CNO.HttpMethod, url: string, headers: Headers, body?: Uint8Array | string, options?: CNO.HttpFormatOptions): Uint8Array {
    const h = new Headers(headers);
    const bodyBytes = body ? (typeof body === 'string' ? encode(body) : body) : undefined;

    if (bodyBytes && !h.has('content-length') && !h.has('transfer-encoding')) {
        h.set('Content-Length', String(bodyBytes.length));
    }

    const head = formatRequestHead(method, url, h, options);
    return bodyBytes ? concat(head, bodyBytes) : head;
}

function formatResponse(statusCode: number, statusText: string, headers: Headers, body?: Uint8Array | string, options?: CNO.HttpFormatOptions): Uint8Array {
    const h = new Headers(headers);
    const bodyBytes = body ? (typeof body === 'string' ? encode(body) : body) : undefined;

    if (bodyBytes && !h.has('content-length') && !h.has('transfer-encoding')) {
        h.set('Content-Length', String(bodyBytes.length));
    }

    const head = formatResponseHead(statusCode, statusText, h, options);
    return bodyBytes ? concat(head, bodyBytes) : head;
}

// Web API interop

function toWebRequest(msg: CNO.HttpRequestMessage, base?: string | URL): Request {
    const url = base ? new URL(msg.url, base).toString() : msg.url;
    return new Request(url, {
        method: msg.method,
        headers: msg.headers,
        body: msg.body,
    });
}

function toWebResponse(msg: CNO.HttpResponseMessage): Response {
    return new Response(msg.body, {
        status: msg.statusCode,
        statusText: msg.statusText,
        headers: msg.headers,
    });
}

function fromWebRequest(req: Request): CNO.HttpRequestMessage {
    return {
        method: req.method as CNO.HttpMethod,
        url: req.url,
        httpVersion: '1.1',
        headers: req.headers,
        body: req.body as ReadableStream<Uint8Array> | null,
        upgrade: false,
        keepAlive: true,
    };
}

async function fromWebResponse(res: Response): Promise<CNO.HttpResponseMessage> {
    return {
        statusCode: res.status,
        statusText: res.statusText,
        httpVersion: '1.1',
        headers: res.headers,
        body: res.body as ReadableStream<Uint8Array> | null,
        keepAlive: true,
    };
}

// Export to CNO namespace

Reflect.set(CNO, 'llhttp', {
    createRequestParser,
    createResponseParser,
    createRequestStreamParser,
    createResponseStreamParser,
    parseRequest,
    parseResponse,
    formatRequestHead,
    formatResponseHead,
    formatRequest,
    formatResponse,
    toWebRequest,
    toWebResponse,
    fromWebRequest,
    fromWebResponse,
    strerr: http.strerr,
    strstatus: http.strstatus,
    METHODS,
});
