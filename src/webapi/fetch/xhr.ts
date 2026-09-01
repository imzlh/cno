import { DOMException, EventTarget, ProgressEvent } from "../events";
import { bytesToArrayBuffer } from "../../utils/bytes";
import { getFetchHook, getFetchInterceptHook, captureUserNetworkCallFrames, getCurlInitHook, type InterceptResult, type NetworkCallFrame } from "../../utils/network-hooks";
import { attachCurlDebugTrace, buildConnectionInfo, CHARSET_RE, type CurlDebugTrace, curlMod, Decoder, engine, getCurlPool, parseHeaders, responseBodyToBytes, serializeBody, toCurlBody, truncateHookPostData } from "./helpers";
import { isLocalFetchProtocol, loadLocalProtocol, type LocalProtocolResponse } from "./protocols";
import { clearReferenceIfCurrent } from "./reference";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

const crypto = import.meta.use('crypto');

let _xhrRequestIdCounter = 0;
function newRequestId(): string {
    return `fetch-${++_xhrRequestIdCounter}`;
}

function emitXhrNetworkHookQuietly(callback: () => void): void {
    try {
        callback();
    } catch {
        // Network hooks are CDP observers; XHR behavior must not depend on them.
    }
}

function abortCurlQuietly(curl: CModuleCURL.CURL): void {
    try {
        curl.abort();
    } catch {
        // Abort is best-effort once user code has requested XHR cancellation.
    }
}

const XHR_UNSENT = 0;
const XHR_OPENED = 1;
const XHR_HEADERS_RECEIVED = 2;
const XHR_LOADING = 3;
const XHR_DONE = 4;

type XMLHttpRequestResponseType = '' | 'arraybuffer' | 'blob' | 'document' | 'json' | 'text';
type XHREventType = 'readystatechange' | 'load' | 'error' | 'abort' | 'loadstart' | 'loadend' | 'progress' | 'timeout';
type XHREventHandler<T extends Event = Event> = ((this: XMLHttpRequest, ev: T) => unknown) | null;
const RESPONSE_TYPES = new Set(['', 'arraybuffer', 'blob', 'document', 'json', 'text']);
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
const METHOD_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function normalizeMethod(method: string): string {
    const raw = String(method);
    if (!METHOD_RE.test(raw)) throw new DOMException('Invalid HTTP method', 'SyntaxError');
    const normalized = raw.toUpperCase();
    if (FORBIDDEN_METHODS.has(normalized)) throw new DOMException('Forbidden HTTP method', 'SecurityError');
    return normalized;
}

export class XMLHttpRequest extends EventTarget {
    static readonly UNSENT = XHR_UNSENT;
    static readonly OPENED = XHR_OPENED;
    static readonly HEADERS_RECEIVED = XHR_HEADERS_RECEIVED;
    static readonly LOADING = XHR_LOADING;
    static readonly DONE = XHR_DONE;

    readonly UNSENT = XHR_UNSENT;
    readonly OPENED = XHR_OPENED;
    readonly HEADERS_RECEIVED = XHR_HEADERS_RECEIVED;
    readonly LOADING = XHR_LOADING;
    readonly DONE = XHR_DONE;

    readyState: number = XHR_UNSENT;
    status: number = 0;
    statusText: string = '';
    responseURL: string = '';
    timeout: number = 0;
    withCredentials: boolean = false;
    upload: EventTarget = new EventTarget();

    private _url: string = '';
    private _method: string = '';
    private _responseType: XMLHttpRequestResponseType = '';
    private _headers: Array<[string, string]> = [];
    private _responseHeaders: string = '';
    private _responseHeaderMap: Map<string, string> | null = null;
    private _response: unknown = null;
    private _responseText: string = '';
    private _aborted: boolean = false;
    private _curl: CModuleCURL.CURL | null = null;
    private _async: boolean = true;
    private _user: string | null = null;
    private _password: string | null = null;
    private _overrideMimeType: string | null = null;

    onreadystatechange: XHREventHandler = null;
    onload: XHREventHandler = null;
    onerror: XHREventHandler = null;
    onabort: XHREventHandler = null;
    onloadstart: XHREventHandler<ProgressEvent> = null;
    onloadend: XHREventHandler<ProgressEvent> = null;
    onprogress: XHREventHandler<ProgressEvent> = null;
    ontimeout: XHREventHandler<ProgressEvent> = null;

    private _eventHandler(type: Exclude<XHREventType, 'loadstart' | 'loadend' | 'progress' | 'timeout'>): XHREventHandler {
        switch (type) {
            case 'readystatechange': return this.onreadystatechange;
            case 'load': return this.onload;
            case 'error': return this.onerror;
            case 'abort': return this.onabort;
        }
    }

    private _progressHandler(type: 'loadstart' | 'loadend' | 'progress' | 'timeout'): XHREventHandler<ProgressEvent> {
        switch (type) {
            case 'loadstart': return this.onloadstart;
            case 'loadend': return this.onloadend;
            case 'progress': return this.onprogress;
            case 'timeout': return this.ontimeout;
        }
    }

    private _emit(type: XHREventType): void {
        if (type === 'loadstart' || type === 'loadend' || type === 'progress' || type === 'timeout') {
            const evt = new ProgressEvent(type);
            this._progressHandler(type)?.call(this, evt);
            this.dispatchEvent(evt);
            return;
        }
        const evt = new Event(type);
        this._eventHandler(type)?.call(this, evt);
        this.dispatchEvent(evt);
    }

    private _setState(state: number): void {
        this.readyState = state;
        this._emit('readystatechange');
    }

    get responseType(): XMLHttpRequestResponseType {
        return this._responseType;
    }

    set responseType(value: XMLHttpRequestResponseType) {
        if (this.readyState === XHR_LOADING || this.readyState === XHR_DONE || (this.readyState === XHR_OPENED && this._curl !== null)) {
            throw new DOMException('InvalidStateError', 'InvalidStateError');
        }
        const next = String(value);
        if (!RESPONSE_TYPES.has(next)) {
            throw new TypeError(`Invalid XMLHttpRequest responseType: ${next}`);
        }
        this._responseType = next as XMLHttpRequestResponseType;
    }

    open(method: string, url: string, async: boolean = true, user?: string | null, password?: string | null): void {
        this._method = normalizeMethod(method);
        this._url = url;
        this._async = async;
        this._user = user ?? null;
        this._password = password ?? null;
        this._aborted = false;
        this._curl = null;
        this._response = null;
        this._responseText = '';
        this._responseHeaders = '';
        this._responseHeaderMap = null;
        this._headers = [];
        this._overrideMimeType = null;
        this.status = 0;
        this.statusText = '';
        this._setState(XHR_OPENED);
    }

    setRequestHeader(name: string, value: string): void {
        if (this.readyState !== XHR_OPENED) throw new DOMException('InvalidStateError', 'InvalidStateError');
        // Reject CRLF/NUL to match fetch() header validation (prevents request smuggling).
        for (const c of [name, value]) {
            for (let i = 0; i < c.length; i++) {
                const code = c.charCodeAt(i);
                if (code === 0x00 || code === 0x0a || code === 0x0d || code > 0xff) {
                    throw new TypeError('Invalid header name or value');
                }
            }
        }
        this._headers.push([name, value]);
    }

    getResponseHeader(name: string): string | null {
        const lower = name.toLowerCase();
        if (this._responseHeaderMap == null) {
            const map = new Map<string, string>();
            for (const line of this._responseHeaders.split(/\r?\n/)) {
                const colon = line.indexOf(':');
                if (colon > 0) map.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
            }
            this._responseHeaderMap = map;
        }
        return this._responseHeaderMap.get(lower) ?? null;
    }

    getAllResponseHeaders(): string {
        return this._responseHeaders;
    }

    overrideMimeType(mime: string): void {
        if (this.readyState === XHR_LOADING || this.readyState === XHR_DONE) {
            throw new DOMException('InvalidStateError', 'InvalidStateError');
        }
        this._overrideMimeType = String(mime);
    }

    private _releaseCurl(curl: CModuleCURL.CURL): void {
        this._curl = clearReferenceIfCurrent(this._curl, curl);
    }

    abort(): void {
        if (this.readyState === XHR_UNSENT || this.readyState === XHR_DONE) return;
        this._aborted = true;
        const curl = this._curl;
        if (curl) {
            abortCurlQuietly(curl);
            this._releaseCurl(curl);
        }
        this.readyState = XHR_DONE;
        this._emit('abort');
        this._emit('loadend');
    }

    send(body?: BodyInit | null): void {
        if (this.readyState !== XHR_OPENED) throw new DOMException('InvalidStateError', 'InvalidStateError');
        if (this._aborted) return;

        this._emit('loadstart');

        let parsedUrl: URL | null = null;
        try {
            parsedUrl = new URL(this._url);
        } catch {}
        if (parsedUrl) {
            const localPromise = loadLocalProtocol(parsedUrl, this._url);
            localPromise.then((response) => {
                if (this._aborted || !response) return;
                this._handleLocalResponse(response);
            }).catch(() => {
                if (this._aborted) return;
                this.readyState = XHR_DONE;
                this._emit('error');
                this._emit('loadend');
            });
            if (isLocalFetchProtocol(parsedUrl.protocol)) return;
        }

        const curl = new curlMod.CURL(getCurlPool());
        this._curl = curl;
        const netHook = getFetchHook();
        const curlTrace = netHook ? attachCurlDebugTrace(curl) : undefined;
        const interceptHook = getFetchInterceptHook();
        const reqId = (netHook || interceptHook) ? newRequestId() : '';
        const reqCallFrames = netHook ? captureUserNetworkCallFrames() : undefined;
        const hdrs: Record<string, string> = {};
        for (const [k, v] of this._headers) {
            const lk = k.toLowerCase();
            if (lk in hdrs) {
                hdrs[lk] += (lk === 'cookie' ? '; ' : ', ') + v;
            } else {
                hdrs[lk] = v;
            }
        }

        // Basic auth from open() user/password — UTF-8 encode then base64 (RFC 7617)
        if (this._user !== null) {
            hdrs['Authorization'] = `Basic ${crypto.base64Encode(engine.encodeString(`${this._user}:${this._password ?? ''}`))}`;
        }

        curl.setUrl(this._url)
            .setMethod(this._method)
            .setHeaders(hdrs)
            .setFollowRedirects(true)
            .setMaxRedirects(20);
        if (parsedUrl) getCurlInitHook()?.(curl, parsedUrl);
        const xhrAE = hdrs['accept-encoding'];
        curl.setAcceptEncoding(xhrAE === 'identity' ? 'identity' : undefined);

        if (this.timeout > 0) {
            curl.setTimeout(this.timeout);
            curl.setConnectTimeout(this.timeout);
            curl.setLowSpeedLimit(1, Math.max(1, Math.ceil(this.timeout / 1000)));
        }

        const bodyBytes = (body !== undefined && body !== null) ? serializeBody(body) : null;
        if (bodyBytes) {
            curl.setBody(toCurlBody(bodyBytes));
        }

        // CDP Fetch interception
        if (interceptHook?.onRequest) {
            interceptHook.onRequest({
                requestId: reqId, url: this._url, method: this._method,
                headers: hdrs, postData: truncateHookPostData(bodyBytes ?? null), resourceType: 'XHR',
            }).then(result => {
                if (this._aborted) {
                    this._releaseCurl(curl);
                    return;
                }
                if (result?.action === 'fulfill') {
                    this._releaseCurl(curl);
                    this._handleInterceptedFulfill(result);
                } else if (result?.action === 'fail') {
                    this._releaseCurl(curl);
                    this.readyState = XHR_DONE;
                    this._emit('error');
                    this._emit('loadend');
                } else {
                    this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace);
                }
            }).catch(() => {
                if (this._aborted) {
                    this._releaseCurl(curl);
                    return;
                }
                this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace);
            });
        } else {
            this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace);
        }
    }

    private _doPerform(curl: CModuleCURL.CURL, netHook: ReturnType<typeof getFetchHook>, reqId: string, hdrs: Record<string, string>, bodyBytes: Uint8Array | null, reqCallFrames?: NetworkCallFrame[], curlTrace?: CurlDebugTrace): void {
        const ts = () => Date.now() / 1000;
        const reqStartTime = Date.now() / 1000;

        if (netHook) {
            emitXhrNetworkHookQuietly(() => {
                netHook.onRequest?.({ requestId: reqId, url: this._url, method: this._method, headers: hdrs, postData: truncateHookPostData(bodyBytes ?? null), callFrames: reqCallFrames, resourceType: 'XHR', timestamp: reqStartTime });
            });
        }

        const handleDone = (response: CModuleCURL.Response): void => {
            if (this._aborted) return;
            const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);

            // Parse response headers for netHook
            const resHdrs: Record<string, string> = {};
            parseHeaders(response.headers).forEach(([k, v]) => { resHdrs[k] = v; });

            if (netHook) {
                emitXhrNetworkHookQuietly(() => {
                    netHook.onResponse?.({
                        requestId: reqId, url: this._url, status: response.status,
                        headers: resHdrs, requestHeaders: hdrs, resourceType: 'XHR', connection: conn, timestamp: ts()
                    });
                    const bytes = responseBodyToBytes(response.body);
                    netHook.onData?.({ requestId: reqId, data: bytes, timestamp: ts() });
                    netHook.onFinished?.({ requestId: reqId, success: true, connection: conn, timestamp: ts() });
                });
            }

            this._handleResponse(response);
        };

        if (this._async) {
            curl.perform().then(handleDone).catch(() => {
                if (this._aborted) return;
                if (netHook) {
                    emitXhrNetworkHookQuietly(() => {
                        netHook.onFinished?.({ requestId: reqId, success: false, errorText: 'network error', timestamp: ts() });
                    });
                }
                this.readyState = XHR_DONE;
                this._emit('error');
                this._emit('loadend');
            }).finally(() => {
                this._releaseCurl(curl);
            });
        } else {
            try {
                handleDone(curl.performSync());
            } catch {
                if (!this._aborted) {
                    if (netHook) {
                        emitXhrNetworkHookQuietly(() => {
                            netHook.onFinished?.({ requestId: reqId, success: false, errorText: 'network error', timestamp: ts() });
                        });
                    }
                    this.readyState = XHR_DONE;
                    this._emit('error');
                    this._emit('loadend');
                }
            } finally {
                this._curl = null;
            }
        }
    }

    private _handleInterceptedFulfill(result: Extract<InterceptResult, { action: 'fulfill' }>): void {
        const hdrs: string[] = [];
        for (const [k, v] of result.responseHeaders) hdrs.push(`${k}: ${v}`);
        this._responseHeaders = hdrs.join('\r\n');
        this._responseHeaderMap = null;
        this.status = result.responseCode;
        this.statusText = '';
        this.responseURL = this._url;
        const bytes: Uint8Array = new globalThis.Uint8Array(result.body.byteLength);
        bytes.set(result.body);
        this._setState(XHR_HEADERS_RECEIVED);
        this._applyBody(bytes, result.responseHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1]);
        this._setState(XHR_LOADING);
        this._setState(XHR_DONE);
        this._emit('progress');
        this._emit('load');
        this._emit('loadend');
    }

    private _handleLocalResponse(response: LocalProtocolResponse): void {
        const hdrs: string[] = [];
        for (const [k, v] of response.headers) hdrs.push(`${k}: ${v}`);
        this.status = response.status;
        this.statusText = '';
        this.responseURL = response.url;
        this._responseHeaders = hdrs.join('\r\n');
        this._responseHeaderMap = null;
        this._setState(XHR_HEADERS_RECEIVED);
        this._applyBody(response.body, response.headers.get('content-type') ?? undefined);
        this._setState(XHR_LOADING);
        this._setState(XHR_DONE);
        this._emit('progress');
        this._emit('load');
        this._emit('loadend');
    }

    private _handleResponse(response: CModuleCURL.Response): void {
        this.status = response.status;
        this.statusText = '';
        this._responseHeaders = response.headers;
        this._responseHeaderMap = null;
        try {
            const responseURL = this._curl?.getInfo(curlMod.CURLINFO_EFFECTIVE_URL);
            this.responseURL = typeof responseURL === 'string' && responseURL.length > 0 ? responseURL : this._url;
        } catch {
            this.responseURL = this._url;
        }

        this._setState(XHR_HEADERS_RECEIVED);

        const bytes = responseBodyToBytes(response.body);
        this._applyBody(bytes, this.getResponseHeader('content-type') ?? undefined);

        this._setState(XHR_LOADING);
        this._setState(XHR_DONE);
        this._emit('progress');
        this._emit('load');
        this._emit('loadend');
    }

    private _applyBody(bytes: Uint8Array, contentType?: string): void {
        const effectiveContentType = this._overrideMimeType ?? contentType;
        switch (this._responseType) {
            case '':
            case 'text': {
                const m = effectiveContentType ? CHARSET_RE.exec(effectiveContentType) : null;
                this._responseText = new Decoder(m?.[1]).decode(bytes);
                this._response = this._responseText;
                break;
            }
            case 'json':
                try {
                    this._response = JSON.parse(new Decoder(undefined).decode(bytes));
                } catch {
                    this._response = null;
                }
                break;
            case 'arraybuffer':
                this._response = bytesToArrayBuffer(bytes);
                break;
            case 'blob':
                this._response = new Blob([bytes], effectiveContentType ? { type: effectiveContentType.split(';', 1)[0].trim() } : undefined);
                break;
            default: {
                const m = effectiveContentType ? CHARSET_RE.exec(effectiveContentType) : null;
                this._responseText = new Decoder(m?.[1]).decode(bytes);
                this._response = this._responseText;
            }
        }
    }

    get response(): unknown { return this._response; }
    get responseText(): string {
        if (this._responseType !== '' && this._responseType !== 'text') {
            throw new DOMException('InvalidStateError', 'InvalidStateError');
        }
        return this._responseText;
    }
}
