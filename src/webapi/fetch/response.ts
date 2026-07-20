import { Headers } from "../headers";
import { type NetworkCallFrame } from "../../utils/network-hooks";
import { bytesToArrayBuffer } from "../../utils/bytes";
import { BOUNDARY_RE, CHARSET_RE, Decoder, ensureFormDataContentType, engine, isBodyIterable, isNullBodyStatus, isReadableStreamLike, iterableBodyToStream, mergeChunks, parseMultipart, parseUrlEncoded, serializeBody, serializeFormData } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type ResponseBodySource = BodyInit | ReadableStream<Uint8Array> | Uint8Array | null;
const allowSwitchingProtocols = Symbol('cno.response.switchingProtocols');
type InternalResponseInit = ResponseInit & { [allowSwitchingProtocols]?: boolean };

function normalizeStatusText(value: unknown): string {
    const text = String(value);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 0x0a || code === 0x0d || code > 0xff) throw new TypeError('Invalid statusText');
    }
    return text;
}

function bodyContentType(body: unknown): string | undefined {
    if (body === null || body === undefined) return undefined;
    if (body instanceof URLSearchParams) return 'application/x-www-form-urlencoded;charset=UTF-8';
    if (body instanceof Blob) return body.type || undefined;
    if (body instanceof FormData || isReadableStreamLike(body) || isBodyIterable(body)) return undefined;
    if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return undefined;
    return 'text/plain;charset=UTF-8';
}

const responseInitiatorCallFrames = new WeakMap<globalThis.Response, NetworkCallFrame[]>();
export function setResponseInitiatorCallFrames(
    response: globalThis.Response,
    callFrames: NetworkCallFrame[] | undefined,
): void {
    if (!callFrames || callFrames.length === 0) return;
    responseInitiatorCallFrames.set(response, callFrames);
}

export function getResponseInitiatorCallFrames(
    response: globalThis.Response | null | undefined,
): NetworkCallFrame[] | undefined {
    if (!response) return undefined;
    return responseInitiatorCallFrames.get(response);
}

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

    constructor(body?: unknown, init?: ResponseInit) {
        if (init !== undefined && init !== null && typeof init !== 'object') {
            throw new TypeError('Response init must be an object');
        }
        const rawStatus = init?.status === undefined ? 200 : init.status;
        const status = Number(rawStatus);
        const allow101 = status === 101 && (init as InternalResponseInit | undefined)?.[allowSwitchingProtocols] === true;
        if (!Number.isFinite(status) || Math.trunc(status) !== status || (!allow101 && status < 200) || status > 599) {
            throw new RangeError(`Invalid response status: ${rawStatus}`);
        }
        if (body !== undefined && body !== null && isNullBodyStatus(status)) {
            throw new TypeError(`Response with status ${status} cannot have body`);
        }
        this.status = status;
        this.statusText = init?.statusText === undefined ? '' : normalizeStatusText(init.statusText);
        this.ok = this.status >= 200 && this.status < 300;
        this.type = 'default';
        this.url = '';
        this.redirected = false;
        this.headers = new Headers(init?.headers);
        const inferredType = bodyContentType(body);
        if (inferredType && !this.headers.has('content-type')) this.headers.set('content-type', inferredType);
        const formDataBoundary = body instanceof FormData ? ensureFormDataContentType(this.headers) : undefined;
        this.body = (body !== undefined && body !== null) ? this.trackBodyStream(this.createBodyStream(body, formDataBoundary)) : null;
    }

    private createBodyStream(bodyInit: unknown, formDataBoundary?: string): ReadableStream<Uint8Array> {
        if (isReadableStreamLike(bodyInit)) return bodyInit;
        const data = serializeBody(bodyInit);
        if (data !== null) {
            const cap = data;
            return new ReadableStream({
                start(c: ReadableStreamDefaultController<Uint8Array>) {
                    c.enqueue(cap);
                    c.close();
                },
            });
        }
        if (bodyInit instanceof Blob) {
            return new ReadableStream({
                start: async (c: ReadableStreamDefaultController<Uint8Array>) => {
                    const r = new Uint8Array(await bodyInit.arrayBuffer());
                    c.enqueue(r);
                    c.close();
                },
            });
        }
        if (bodyInit instanceof FormData) {
            return new ReadableStream({
                start: async (c: ReadableStreamDefaultController<Uint8Array>) => {
                    const r = await serializeFormData(bodyInit, formDataBoundary);
                    c.enqueue(r);
                    c.close();
                },
            });
        }
        if (isBodyIterable(bodyInit)) return iterableBodyToStream(bodyInit);
        return new ReadableStream({
            start: async (c: ReadableStreamDefaultController<Uint8Array>) => {
                const r = engine.encodeString(String(bodyInit));
                c.enqueue(r);
                c.close();
            },
        });
    }

    private trackBodyStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
        const markUsed = () => { this.bodyUsed = true; };
        const getReader = stream.getReader.bind(stream);
        stream.getReader = ((options?: ReadableStreamGetReaderOptions) => {
            const reader = getReader(options) as ReadableStreamDefaultReader<Uint8Array>;
            const read = reader.read.bind(reader);
            const cancel = reader.cancel.bind(reader);
            reader.read = () => {
                markUsed();
                return read();
            };
            reader.cancel = (reason?: unknown) => {
                markUsed();
                return cancel(reason);
            };
            return reader;
        }) as typeof stream.getReader;
        const cancel = stream.cancel.bind(stream);
        stream.cancel = (reason?: unknown) => {
            markUsed();
            return cancel(reason);
        };
        return stream;
    }

    clone(): Response {
        if (this.bodyUsed) throw new TypeError('Already read');
        let clonedBody: ResponseBodySource = this._bodyBuffer;
        if (clonedBody === null && this.body) {
            const [s1, s2] = this.body.tee();
            Object.defineProperty(this, 'body', {
                value: this.trackBodyStream(s1),
                writable: false,
                configurable: true,
            });
            clonedBody = s2;
        }
        const r = new Response(clonedBody, { status: this.status, statusText: this.statusText, headers: this.headers });
        Object.defineProperty(r, 'type', { value: this.type });
        Object.defineProperty(r, 'url', { value: this.url });
        Object.defineProperty(r, 'redirected', { value: this.redirected });
        Object.defineProperty(r, 'ok', { value: this.ok });
        setResponseInitiatorCallFrames(r, getResponseInitiatorCallFrames(this));
        return r;
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
                if (!(value instanceof Uint8Array)) throw new TypeError('Response body stream chunks must be Uint8Array values');
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }
        this._bodyBuffer = mergeChunks(chunks);
        return this._bodyBuffer;
    }
    arrayBuffer(): Promise<ArrayBuffer> { return this.bytes().then(bytesToArrayBuffer); }
    async blob(): Promise<Blob> { return new Blob([await this.arrayBuffer()], { type: this.headers.get('content-type') || '' }); }
    async formData(): Promise<FormData> {
        const buf = await this.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const ct = this.headers.get('content-type') ?? '';
        if (ct.includes('multipart/form-data')) {
            const m = BOUNDARY_RE.exec(ct);
            const boundary = m?.[1];
            if (!boundary) throw new TypeError('Missing multipart boundary');
            return parseMultipart(bytes, boundary);
        }
        if (ct.includes('application/x-www-form-urlencoded')) return parseUrlEncoded(bytes);
        throw new TypeError(`Unsupported content type for formData(): ${ct}`);
    }
    async json<T = unknown>(): Promise<T> { return JSON.parse(await this.text()); }
    async text(): Promise<string> {
        const buf = await this.arrayBuffer();
        const ct = this.headers.get('content-type') ?? '';
        const m = CHARSET_RE.exec(ct);
        return new Decoder(m?.[1]).decode(buf);
    }
    static error(): Response {
        const r = new Response(null);
        Object.defineProperty(r, 'status', { value: 0 });
        Object.defineProperty(r, 'ok', { value: false });
        Object.defineProperty(r, 'type', { value: 'error' });
        return r;
    }

    static redirect(url: string, status: number = 302): Response {
        if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status');
        const rawUrl = String(url);
        if (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(rawUrl)) throw new TypeError(`Failed to parse URL from ${rawUrl}`);
        const location = new URL(rawUrl).href;
        const r = new Response(null, { status, headers: { Location: location } });
        Object.defineProperty(r, 'type', { value: 'default' });
        return r;
    }

    static json(data: unknown, init?: ResponseInit): Response {
        const body = JSON.stringify(data);
        if (body === undefined) throw new TypeError('Value is not JSON serializable');
        const headers = new Headers(init?.headers);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
        return new Response(body, { ...init, headers });
    }
}

export function createSwitchingProtocolsResponse(init: ResponseInit): Response {
    return new Response(null, { ...init, status: 101, [allowSwitchingProtocols]: true } as InternalResponseInit);
}
