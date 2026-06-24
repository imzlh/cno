import { DOMException, EventTarget } from "../events";
import { getFetchHook, getFetchInterceptHook, captureUserNetworkCallFrames, getCurlInitHook, type NetworkCallFrame } from "../../utils/network-hooks";
import { attachCurlDebugTrace, buildConnectionInfo, CHARSET_RE, type CurlDebugTrace, curlMod, Decoder, engine, getCurlPool, parseHeaders, responseBodyToBytes, serializeBody, toCurlBody, truncateHookPostData } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

let _xhrRequestIdCounter = 0;
function newRequestId(): string {
    return `fetch-${++_xhrRequestIdCounter}`;
}

const XHR_UNSENT = 0;
const XHR_OPENED = 1;
const XHR_HEADERS_RECEIVED = 2;
const XHR_LOADING = 3;
const XHR_DONE = 4;

type XMLHttpRequestResponseType = '' | 'arraybuffer' | 'blob' | 'document' | 'json' | 'text';

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
    responseType: XMLHttpRequestResponseType = '';
    upload: EventTarget = new EventTarget();

    private _url: string = '';
    private _method: string = '';
    private _headers: Array<[string, string]> = [];
    private _responseHeaders: string = '';
    private _responseHeaderMap: Map<string, string> | null = null;
    private _response: any = null;
    private _responseText: string = '';
    private _aborted: boolean = false;
    private _curl: CModuleCURL.CURL | null = null;
    private _async: boolean = true;
    private _user: string | null = null;
    private _password: string | null = null;

    onreadystatechange: ((this: XMLHttpRequest, ev: Event) => any) | null = null;
    onload: ((this: XMLHttpRequest, ev: Event) => any) | null = null;
    onerror: ((this: XMLHttpRequest, ev: Event) => any) | null = null;
    onabort: ((this: XMLHttpRequest, ev: Event) => any) | null = null;
    onloadstart: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null;
    onloadend: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null;
    onprogress: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null;
    ontimeout: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null;

    private _emit(type: string): void {
        const evt = new Event(type);
        const handler = (this as any)[`on${type}`];
        if (typeof handler === 'function') handler.call(this, evt);
        this.dispatchEvent(evt);
    }

    private _setState(state: number): void {
        this.readyState = state;
        this._emit('readystatechange');
    }

    open(method: string, url: string, async: boolean = true, user?: string | null, password?: string | null): void {
        this._method = method.toUpperCase();
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
        this.status = 0;
        this.statusText = '';
        this.readyState = XHR_OPENED;
    }

    setRequestHeader(name: string, value: string): void {
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

    overrideMimeType(_mime: string): void {
        // Not implemented
    }

    abort(): void {
        if (this.readyState === XHR_UNSENT || this.readyState === XHR_DONE) return;
        this._aborted = true;
        if (this._curl) {
            try { this._curl.abort(); } catch {}
        }
        this.readyState = XHR_DONE;
        this._emit('abort');
        this._emit('loadend');
    }

    send(body?: any): void {
        if (this.readyState !== XHR_OPENED) throw new DOMException('InvalidStateError', 'InvalidStateError');
        if (this._aborted) return;

        this._emit('loadstart');

        const curl = new curlMod.CURL(getCurlPool());
        getCurlInitHook()?.(curl);
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
            const credBytes = engine.encodeString(`${this._user}:${this._password ?? ''}`) as Uint8Array;
            let credStr = '';
            for (let i = 0; i < credBytes.length; i++) credStr += String.fromCharCode(credBytes[i]!);
            hdrs['Authorization'] = `Basic ${btoa(credStr)}`;
        }

        curl.setUrl(this._url)
            .setMethod(this._method)
            .setHeaders(hdrs)
            .setFollowRedirects(true)
            .setMaxRedirects(20);
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
                if (result?.action === 'fulfill') {
                    this._handleInterceptedFulfill(result as any);
                } else if (result?.action === 'fail') {
                    this.readyState = XHR_DONE;
                    this._emit('error');
                    this._emit('loadend');
                } else {
                    this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace);
                }
            }).catch(() => this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace));
        } else {
            this._doPerform(curl, netHook, reqId, hdrs, bodyBytes, reqCallFrames, curlTrace);
        }
    }

    private _doPerform(curl: CModuleCURL.CURL, netHook: ReturnType<typeof getFetchHook>, reqId: string, hdrs: Record<string, string>, bodyBytes: Uint8Array | null, reqCallFrames?: NetworkCallFrame[], curlTrace?: CurlDebugTrace): void {
        const ts = () => Date.now() / 1000;
        const reqStartTime = Date.now() / 1000;

        if (netHook) try {
            netHook.onRequest?.({ requestId: reqId, url: this._url, method: this._method, headers: hdrs, postData: truncateHookPostData(bodyBytes ?? null), callFrames: reqCallFrames, resourceType: 'XHR', timestamp: reqStartTime });
        } catch {}

        const handleDone = (response: CModuleCURL.Response): void => {
            if (this._aborted) return;
            const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);

            // Parse response headers for netHook
            const resHdrs: Record<string, string> = {};
            parseHeaders(response.headers).forEach(([k, v]) => { resHdrs[k] = v; });

            if (netHook) try {
                netHook.onResponse?.({
                    requestId: reqId, url: this._url, status: response.status,
                    headers: resHdrs, requestHeaders: hdrs, resourceType: 'XHR', connection: conn, timestamp: ts()
                });
                const bytes = responseBodyToBytes(response.body);
                netHook.onData?.({ requestId: reqId, data: bytes, timestamp: ts() });
                netHook.onFinished?.({ requestId: reqId, success: true, connection: conn, timestamp: ts() });
            } catch {}

            this._handleResponse(response);
        };

        if (this._async) {
            curl.perform().then(handleDone).catch(() => {
                if (this._aborted) return;
                if (netHook) try {
                    netHook.onFinished?.({ requestId: reqId, success: false, errorText: 'network error', timestamp: ts() });
                } catch {}
                this.readyState = XHR_DONE;
                this._emit('error');
                this._emit('loadend');
            }).finally(() => {
                this._curl = null;
            });
        } else {
            try {
                handleDone(curl.performSync());
            } catch {
                if (!this._aborted) {
                    if (netHook) try {
                        netHook.onFinished?.({ requestId: reqId, success: false, errorText: 'network error', timestamp: ts() });
                    } catch {}
                    this.readyState = XHR_DONE;
                    this._emit('error');
                    this._emit('loadend');
                }
            } finally {
                this._curl = null;
            }
        }
    }

    private _handleInterceptedFulfill(result: { responseCode: number; responseHeaders: Array<[string, string]>; body: Uint8Array }): void {
        const hdrs: string[] = [];
        for (const [k, v] of result.responseHeaders) hdrs.push(`${k}: ${v}`);
        this._responseHeaders = hdrs.join('\r\n');
        this._responseHeaderMap = null;
        this.status = result.responseCode;
        this.statusText = '';
        this.responseURL = this._url;
        const bytes = result.body;
        this._applyBody(bytes, result.responseHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1]);
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
        try { this.responseURL = this._curl?.getInfo(curlMod.CURLINFO_EFFECTIVE_URL) as string || this._url; } catch { this.responseURL = this._url; }

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
        switch (this.responseType) {
            case '':
            case 'text': {
                const m = contentType ? CHARSET_RE.exec(contentType) : null;
                this._responseText = new Decoder(m?.[1]).decode(bytes);
                this._response = this._responseText;
                break;
            }
            case 'json':
                try { this._response = JSON.parse(new Decoder(undefined).decode(bytes)); }
                catch { this._response = null; }
                break;
            case 'arraybuffer':
                this._response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                break;
            case 'blob':
                this._response = new Blob([bytes]);
                break;
            default: {
                const m = contentType ? CHARSET_RE.exec(contentType) : null;
                this._responseText = new Decoder(m?.[1]).decode(bytes);
                this._response = this._responseText;
            }
        }
    }

    get response(): any { return this._response; }
    get responseText(): string { return this._responseText; }
}
