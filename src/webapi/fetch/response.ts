import { Headers } from "../headers";
import { type NetworkCallFrame } from "../../utils/network-hooks";
import { bytesToArrayBuffer } from "../../utils/bytes";
import { bodyContentType, Decoder, ensureFormDataContentType, engine, isBodyIterable, isNullBodyStatus, isReadableStreamLike, iterableBodyToStream, parseFormData, readStreamBody, serializeBody, serializeFormData, teeUntracked, trackBodyStream } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type ResponseBodySource = BodyInit | ReadableStream<Uint8Array> | Uint8Array | null;
const allowSwitchingProtocols = Symbol('cno.response.switchingProtocols');
const setResponseMetadataToken = Symbol('cno.response.setMetadata');
type InternalResponseInit = ResponseInit & { [allowSwitchingProtocols]?: boolean };
export interface InternalResponseMetadata {
    type?: ResponseType;
    url?: string;
    redirected?: boolean;
}

interface ResponseState {
    type: ResponseType;
    url: string;
    redirected: boolean;
    status: number;
    ok: boolean;
    statusText: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
    bodyUsed: boolean;
    bodyBuffer: Uint8Array | null;
}

const responseState = Symbol('cno.response.state');

function normalizeStatusText(value: unknown): string {
    const text = String(value);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 0x0a || code === 0x0d || code > 0xff) throw new TypeError('Invalid statusText');
    }
    return text;
}

/** `ResponseInit.status` is WebIDL `unsigned short`: ToUint16 first, then range-check. */
function toUint16(value: unknown): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return ((Math.trunc(number) % 65536) + 65536) % 65536;
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
    declare [responseState]: ResponseState;

    get type(): ResponseType { return this[responseState].type; }
    get url(): string { return this[responseState].url; }
    get redirected(): boolean { return this[responseState].redirected; }
    get status(): number { return this[responseState].status; }
    get ok(): boolean { return this[responseState].ok; }
    get statusText(): string { return this[responseState].statusText; }
    get headers(): Headers { return this[responseState].headers; }
    get body(): ReadableStream<Uint8Array> | null { return this[responseState].body; }
    get bodyUsed(): boolean { return this[responseState].bodyUsed; }

    constructor(body?: unknown, init?: ResponseInit) {
        if (init !== undefined && init !== null && typeof init !== 'object') {
            throw new TypeError('Response init must be an object');
        }
        const rawStatus = init?.status === undefined ? 200 : init.status;
        const status = toUint16(rawStatus);
        const allow101 = status === 101 && (init as InternalResponseInit | undefined)?.[allowSwitchingProtocols] === true;
        if ((!allow101 && status < 200) || status > 599) {
            throw new RangeError(`Invalid response status: ${rawStatus}`);
        }
        if (body !== undefined && body !== null && isNullBodyStatus(status)) {
            throw new TypeError(`Response with status ${status} cannot have body`);
        }
        const state: ResponseState = {
            type: 'default',
            url: '',
            redirected: false,
            status,
            ok: status >= 200 && status < 300,
            statusText: init?.statusText === undefined ? '' : normalizeStatusText(init.statusText),
            headers: new Headers(init?.headers),
            body: null,
            bodyUsed: false,
            bodyBuffer: null,
        };
        // Fetch wrappers commonly proxy responses. A non-enumerable data slot is
        // forwarded by Proxy while native #private fields reject the proxy receiver.
        Object.defineProperty(this, responseState, { value: state });
        const inferredType = bodyContentType(body);
        if (inferredType && !state.headers.has('content-type')) state.headers.set('content-type', inferredType);
        const formDataBoundary = body instanceof FormData ? ensureFormDataContentType(state.headers) : undefined;
        state.body = (body !== undefined && body !== null) ? this.trackBodyStream(this.createBodyStream(body, formDataBoundary)) : null;
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
        return trackBodyStream(stream, () => { this[responseState].bodyUsed = true; });
    }

    clone(): Response {
        const state = this[responseState];
        if (state.bodyUsed) throw new TypeError('Already read');
        let clonedBody: ResponseBodySource = state.bodyBuffer;
        if (clonedBody === null && state.body) {
            // Clone pulls must only mark their own branch as used.
            const [s1, s2] = teeUntracked(state.body);
            state.body = this.trackBodyStream(s1);
            clonedBody = s2;
        }
        const r = new Response(clonedBody, {
            status: state.status === 0 ? 200 : state.status,
            statusText: state.statusText,
            headers: state.headers,
        });
        const clonedState = r[responseState];
        clonedState.status = state.status;
        clonedState.ok = state.ok;
        clonedState.type = state.type;
        clonedState.url = state.url;
        clonedState.redirected = state.redirected;
        setResponseInitiatorCallFrames(r, getResponseInitiatorCallFrames(this));
        return r;
    }

    async bytes(): Promise<Uint8Array> {
        const state = this[responseState];
        if (state.bodyUsed) throw new TypeError('Already read');
        state.bodyUsed = true;
        if (state.bodyBuffer) return state.bodyBuffer;
        if (!state.body) return new Uint8Array(0);

        state.bodyBuffer = await readStreamBody(state.body, { bodyKind: 'Response' });
        return state.bodyBuffer;
    }
    arrayBuffer(): Promise<ArrayBuffer> { return this.bytes().then(bytesToArrayBuffer); }
    async blob(): Promise<Blob> { return new Blob([await this.arrayBuffer()], { type: this.headers.get('content-type') || '' }); }
    async formData(): Promise<FormData> {
        const buf = await this.arrayBuffer();
        const bytes = new Uint8Array(buf);
        return parseFormData(bytes, this.headers.get('content-type') ?? '');
    }
    async json<T = unknown>(): Promise<T> { return JSON.parse(await this.text()); }
    /** Spec: always UTF-8, regardless of the content-type charset (only XHR honours charset). */
    async text(): Promise<string> {
        return new Decoder().decode(await this.arrayBuffer());
    }
    static error(): Response {
        const r = new Response(null);
        const state = r[responseState];
        state.status = 0;
        state.ok = false;
        state.type = 'error';
        Headers.setGuard(r.headers, 'immutable');
        return r;
    }

    static redirect(url: string, status: number = 302): Response {
        if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status');
        const rawUrl = String(url);
        if (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(rawUrl)) throw new TypeError(`Failed to parse URL from ${rawUrl}`);
        const location = new URL(rawUrl).href;
        const r = new Response(null, { status, headers: { Location: location } });
        Headers.setGuard(r.headers, 'immutable');
        return r;
    }

    static json(data: unknown, init?: ResponseInit): Response {
        const body = JSON.stringify(data);
        if (body === undefined) throw new TypeError('Value is not JSON serializable');
        const headers = new Headers(init?.headers);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
        return new Response(body, { ...init, headers });
    }

    [setResponseMetadataToken](metadata: InternalResponseMetadata): void {
        const state = this[responseState];
        if (metadata.type !== undefined) state.type = metadata.type;
        if (metadata.url !== undefined) state.url = metadata.url;
        if (metadata.redirected !== undefined) state.redirected = metadata.redirected;
    }

    get [Symbol.toStringTag](): string { return 'Response'; }
}

export function setResponseMetadata(response: Response, metadata: InternalResponseMetadata): void {
    response[setResponseMetadataToken](metadata);
}

export function createSwitchingProtocolsResponse(init: ResponseInit): Response {
    return new Response(null, { ...init, status: 101, [allowSwitchingProtocols]: true } as InternalResponseInit);
}
