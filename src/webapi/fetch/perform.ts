import { Headers } from "../headers";
import pkg from "../../../package.json";
import { getFetchHook, getUserAgentOverride, getExtraHTTPHeaders, getFetchInterceptHook, captureUserNetworkCallFrames, getCurlInitHook, type NetworkCallFrame, type InterceptResult } from "../../utils/network-hooks";
import { type HttpClient } from "../../deno/07_http";
import { Request } from "./request";
import { Response, setResponseMetadata } from "./response";
import { abortError, attachCurlDebugTrace, buildConnectionInfo, compressionAcceptEncoding, curlMod, engine, getCurlPool, isCurlTimeoutError, isNullBodyStatus, maxPendingBodyBytes, parseHeaders, prepareRequestBody, rawHeadersToHeaders, streamHighWaterMark, throwIfAborted, timeoutError, toCurlBody, truncateHookPostData } from "./helpers";
import { isLocalFetchProtocol, loadLocalProtocol } from "./protocols";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type CurlProxyType = NonNullable<Parameters<CModuleCURL.CURL['setProxy']>[1]>;
type RequestInput = ConstructorParameters<typeof Request>[0];
type FetchStreamController = ReadableStreamDefaultController<Uint8Array> & {
    _backpressured?: boolean;
    _onEnqueueCallback?: (() => void) | null;
    _onDequeueCallback?: (() => void) | null;
};
type BodyTerminal = { type: 'close' } | { type: 'error'; error: unknown };

const CURL_PROXY_TYPES = new Set<string>(['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h']);
const { version } = pkg as { version: string };

let _fetchIdCounter = 0;
function newRequestId(): string { return `fetch-${++_fetchIdCounter}`; }

function emitFetchHookQuietly(callback: () => void): void {
    try {
        callback();
    } catch {
        // Network hooks are debug observers; failures must not change fetch().
    }
}

function isCurlProxyType(value: string): value is CurlProxyType {
    return CURL_PROXY_TYPES.has(value);
}

function getCurlProxyType(protocol: string): CurlProxyType {
    const value = protocol.endsWith(':') ? protocol.slice(0, -1) : protocol;
    if (isCurlProxyType(value)) return value;
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
}

function isFollowedRedirect(status: number, rawHeaders: string): boolean {
    if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) return false;
    return parseHeaders(rawHeaders).some(([name, value]) => name === 'location' && value.length > 0);
}

function getEffectiveUrl(curl: CModuleCURL.CURL, fallback: string): string {
    const value = curl.getInfo(curlMod.CURLINFO_EFFECTIVE_URL);
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function abortCurlQuietly(curl: CModuleCURL.CURL): void {
    try {
        curl.abort();
    } catch {
        // Abort is best-effort once the request has been short-circuited.
    }
}

function pauseCurlRecvQuietly(curl: CModuleCURL.CURL): boolean {
    try {
        curl.pauseRecv();
        return true;
    } catch {
        return false;
    }
}

function resumeCurlRecvQuietly(curl: CModuleCURL.CURL): boolean {
    try {
        curl.resumeRecv();
        return true;
    } catch {
        return false;
    }
}

function readFinalUrl(curl: CModuleCURL.CURL, fallback: string): string {
    try {
        return getEffectiveUrl(curl, fallback);
    } catch {
        return fallback;
    }
}

function toRequestInput(input: unknown): RequestInput {
    if (input instanceof URL || input instanceof Request || typeof input === 'string') return input;
    return String(input);
}

function clearCurlProxy(curl: CModuleCURL.CURL): void {
    curl.setOpt(curlMod.CURLOPT_PROXY, null);
    curl.setOpt(curlMod.CURLOPT_PROXYTYPE, curlMod.CURLPROXY_HTTP);
    curl.setOpt(curlMod.CURLOPT_PROXYUSERNAME, null);
    curl.setOpt(curlMod.CURLOPT_PROXYPASSWORD, null);
    curl.setOpt(curlMod.CURLOPT_NOPROXY, null);
}

/** Apply Deno.HttpClient proxy + mTLS settings without touching the filesystem. */
function applyClientToCurl(curl: CModuleCURL.CURL, client: HttpClient, url: URL): void {
    const opts = client.options;
    const proxy = opts.proxy;
    if (proxy) {
        clearCurlProxy(curl);
        if (client.shouldUseProxy(url)) {
            const proxyUrl = client.getProxyUrl();
            if (proxyUrl) {
                curl.setProxy(proxyUrl.href, getCurlProxyType(proxyUrl.protocol));
                if (proxy.basicAuth) {
                    curl.setOpt(curlMod.CURLOPT_PROXYUSERNAME, proxy.basicAuth.username);
                    curl.setOpt(curlMod.CURLOPT_PROXYPASSWORD, proxy.basicAuth.password);
                }
            }
        }
    }

    if (opts.caCerts?.length) {
        const option = curlMod.CURLOPT_CAINFO_BLOB;
        if (typeof option !== 'number') throw new Error('custom CA certificates require libcurl with CAINFO_BLOB support');
        curl.setOpt(option, engine.encodeString(opts.caCerts.join('\n')));
    }
    if (opts.cert) {
        const option = curlMod.CURLOPT_SSLCERT_BLOB;
        if (typeof option !== 'number') throw new Error('client certificates require libcurl with SSLCERT_BLOB support');
        curl.setOpt(option, engine.encodeString(opts.cert));
    }
    if (opts.key) {
        const option = curlMod.CURLOPT_SSLKEY_BLOB;
        if (typeof option !== 'number') throw new Error('client keys require libcurl with SSLKEY_BLOB support');
        curl.setOpt(option, engine.encodeString(opts.key));
    }
}

const CURL_INTERNAL_HEADERS = [
    'accept-encoding',
    'connection',
    'content-length',
    'date',
    'host',
    'pragma',
    'proxy-connection',
]
function filterHeaders(headers: Headers): void {
    for (const name of CURL_INTERNAL_HEADERS) headers.delete(name);
}


const inFlightFetchFrames = new Set<Promise<unknown>>();
// ----------------------------------------------------------------------------
export async function performFetch(request: Request, url: URL): Promise<Response> {
    throwIfAborted(request.signal);
    const localResponse = await loadLocalProtocol(url, request.url);
    if (localResponse) {
        const response = new Response(localResponse.body, {
            status: localResponse.status,
            statusText: localResponse.status === 200 ? 'OK' : '',
            headers: localResponse.headers,
        });
        setResponseMetadata(response, { url: localResponse.url, type: 'basic' });
        return response;
    }
    const preparedBody = await prepareRequestBody(request);
    const body = preparedBody.kind === 'buffer' ? preparedBody.body : null;
    throwIfAborted(request.signal);

    const curl = new curlMod.CURL(getCurlPool());

    // If a Deno.HttpClient is attached, apply its proxy/SSL config to curl
    // instead of reimplementing HTTP on a raw socket.
    const client = (await import('../../deno/07_http')).getRequestClient(request);
    const configureRequestNetwork = (target: URL) => {
        getCurlInitHook()?.(curl, target);
        if (client) applyClientToCurl(curl, client, target);
    };
    const abortCurl = () => {
        abortCurlQuietly(curl);
    };
    const netHook = getFetchHook();
    const curlTrace = netHook ? attachCurlDebugTrace(curl) : undefined;
    const interceptHook = getFetchInterceptHook();
    const requestId = (netHook || interceptHook) ? newRequestId() : '';
    const ts = () => Date.now() / 1000;
    const reqCallFrames = (netHook || interceptHook) ? request.getInitiatorCallFrames() : undefined;

    // Build final headers: request headers + extra CDP headers + UA override
    const finalHeaders = new Headers(request.headers);
    const extraHdrs = getExtraHTTPHeaders();
    for (const [k, v] of Object.entries(extraHdrs))
        finalHeaders.set(k, v);

    const uaOverride = getUserAgentOverride();
    if (uaOverride)
        finalHeaders.set('User-Agent', uaOverride);
    else if (!finalHeaders.has('User-Agent'))
        finalHeaders.set('User-Agent', `cno/${version}`);

    // Read accept-encoding BEFORE filterHeaders strips it.
    const acceptEncoding = compressionAcceptEncoding(finalHeaders);

    // referrer → Referer header (only if not already set by caller)
    if (!finalHeaders.has('Referer') && request.referrer && request.referrer !== 'no-referrer' && request.referrer !== 'about:client') {
        try {
            const refUrl = new URL(request.referrer);
            if (refUrl.protocol === 'http:' || refUrl.protocol === 'https:') {
                finalHeaders.set('Referer', refUrl.href);
            }
        } catch { /* invalid referrer, skip */ }
    }

    // filter headers managed internally by curl
    filterHeaders(finalHeaders);

    // Merge duplicate headers (curl setHeaders only accepts Record<string,string>).
    // HTTP/1.1 §3.2.2: field values with the same name may be combined with ", ".
    // Exception: Cookie uses "; " per RFC 6265 §5.4.
    const objHeaders: Record<string, string> = {};
    for (const [k, v] of finalHeaders.entries()) {
        if (k in objHeaders) {
            objHeaders[k] += (k === 'cookie' ? '; ' : ', ') + v;
        } else {
            objHeaders[k] = v;
        }
    }
    curl.setUrl(url.href)
        .setMethod(request.method)
        .setHeaders(objHeaders);
    configureRequestNetwork(url);
    curl.setOpt(curlMod.CURLOPT_AUTOREFERER, 1);  // update Referer to the Location URL on each redirect hop
    curl.setAcceptEncoding(acceptEncoding);
    // Default timeouts (ms): bound a hung upstream so a single fetch can't block forever.
    curl.setConnectTimeout(15000);

    // redirect mode
    if (request.redirect === 'error' || request.redirect === 'manual') {
        curl.setFollowRedirects(false);
    } else {
        curl.setFollowRedirects(true);
        curl.setMaxRedirects(20);
    }

    if (preparedBody.kind === 'buffer' && body && body.length > 0) {
        curl.setBody(toCurlBody(body));
    }

    // AbortSignal directly cancels the underlying curl request
    let abortHandler: (() => void) | null = null;
    if (request.signal) {
        abortHandler = () => {
            const err = abortError(request.signal);
            headersDone.reject(err);
            errorBody(err);
            abortCurl();
        };
        if (request.signal.aborted) {
            abortCurl();
            throw abortError(request.signal);
        }
        request.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const removeAbortHandler = () => {
        if (abortHandler && request.signal) {
            request.signal.removeEventListener('abort', abortHandler);
            abortHandler = null;
        }
    };

    // Resolve immediately when headers arrive; stream body via ReadableStream.
    const headersDone = Promise.withResolvers<{ status: number; headers: string }>();
    inFlightFetchFrames.add(headersDone.promise);
    let streamController: FetchStreamController | null = null;
    let bodyCanceled = false;
    let bodyTerminal: BodyTerminal | null = null;
    const pendingBodyChunks: Uint8Array[] = [];
    let pendingBodySize = 0;

    let curlRecvPaused = false;

    const pauseCurlRecv = () => {
        if (curlRecvPaused || bodyCanceled || bodyTerminal) return;
        if (pauseCurlRecvQuietly(curl)) {
            curlRecvPaused = true;
        }
    };

    const resumeCurlRecv = () => {
        if (!curlRecvPaused || bodyCanceled || bodyTerminal) return;
        if (resumeCurlRecvQuietly(curl)) {
            curlRecvPaused = false;
        }
    };

    const shiftPendingBodyChunk = (): Uint8Array | undefined => {
        const chunk = pendingBodyChunks.shift();
        if (chunk) pendingBodySize -= chunk.byteLength;
        return chunk;
    };

    const shouldPauseCurlRecv = (): boolean => {
        if (bodyCanceled || bodyTerminal) return false;
        if (!streamController) return pendingBodySize >= maxPendingBodyBytes;
        return pendingBodySize >= maxPendingBodyBytes || !!streamController._backpressured;
    };

    const syncCurlBackpressure = () => {
        if (shouldPauseCurlRecv()) pauseCurlRecv();
        else resumeCurlRecv();
    };

    const flushPendingBodyChunks = () => {
        if (!streamController) return;
        while (pendingBodyChunks.length > 0) {
            if (streamController._backpressured) break;
            const chunk = shiftPendingBodyChunk();
            if (!chunk) break;
            try {
                streamController.enqueue(chunk);
            } catch {
                bodyCanceled = true;
                break;
            }
        }
        syncCurlBackpressure();
        if (bodyTerminal?.type === 'close' && pendingBodyChunks.length === 0 && !bodyCanceled) {
            streamController._onDequeueCallback = null;
            streamController.close();
        }
    };

    const enqueueBodyChunk = (chunk: Uint8Array): void => {
        if (bodyCanceled || bodyTerminal) return;
        if (!streamController || streamController._backpressured) {
            pendingBodyChunks.push(chunk);
            pendingBodySize += chunk.byteLength;
            syncCurlBackpressure();
            return;
        }
        try {
            streamController.enqueue(chunk);
        } catch {
            bodyCanceled = true;
            return;
        }
        syncCurlBackpressure();
    };

    const closeBody = () => {
        if (bodyCanceled || bodyTerminal) return;
        resumeCurlRecv();
        bodyTerminal = { type: 'close' };
        if (!streamController) {
            return;
        }
        flushPendingBodyChunks();
    };

    const errorBody = (error: unknown) => {
        if (bodyCanceled || bodyTerminal) return;
        resumeCurlRecv();
        pendingBodyChunks.length = 0;
        pendingBodySize = 0;
        if (!streamController) {
            bodyTerminal = { type: 'error', error };
            return;
        }
        streamController._onDequeueCallback = null;
        streamController.error(error);
        bodyTerminal = { type: 'error', error };
    };

    const startBody = (controller: ReadableStreamDefaultController<Uint8Array>) => {
        const fetchController = controller as FetchStreamController;
        streamController = fetchController;
        fetchController._onEnqueueCallback = syncCurlBackpressure;
        fetchController._onDequeueCallback = flushPendingBodyChunks;
        if (bodyTerminal?.type === 'error') {
            pendingBodyChunks.length = 0;
            pendingBodySize = 0;
            controller.error(bodyTerminal.error);
        } else {
            flushPendingBodyChunks();
            syncCurlBackpressure();
        }
    };

    // The interceptor runs before curl.perform(). If it rejects, there is no
    // perform() finally block to release the global in-flight marker or the
    // AbortSignal listener. Keep this cleanup idempotent so every early exit
    // releases the request-owned state exactly once.
    const cleanupBeforePerform = () => {
        inFlightFetchFrames.delete(headersDone.promise);
        removeAbortHandler();
        pendingBodyChunks.length = 0;
        pendingBodySize = 0;
        abortCurl();
    };

    const followingRedirects = request.redirect !== 'error' && request.redirect !== 'manual';
    let didRedirect = false;
    let waitingForFinalHeaders = false; // true between a redirect hop and the final onHeadersComplete

    curl.onHeadersComplete((status, headers) => {
        const isRedirectStatus = isFollowedRedirect(status, headers);

        // When curl follows redirects, onHeadersComplete fires for each hop.
        // Skip intermediate redirect responses entirely — the netHook and
        // headersDone should only see the FINAL response.
        if (isRedirectStatus && followingRedirects) {
            didRedirect = true;
            waitingForFinalHeaders = true;
            // Discard any body chunks accumulated from the redirect response
            // so the body stream and netHook only contain the final response.
            pendingBodyChunks.length = 0;
            pendingBodySize = 0;
            return;
        }

        // Drop any leftover redirect-hop body before the final response starts.
        if (waitingForFinalHeaders) {
            pendingBodyChunks.length = 0;
            pendingBodySize = 0;
        }
        waitingForFinalHeaders = false;

        // Parse headers into object only for the final response.
        if (netHook) {
            const hdrs: Record<string, string> = {};
            for (const [k, v] of parseHeaders(headers)) hdrs[k] = v;
            emitFetchHookQuietly(() => {
                netHook.onResponse?.({
                    requestId, url: url.href, status, headers: hdrs,
                    requestHeaders: objHeaders,
                    resourceType: 'Fetch',
                    connection: buildConnectionInfo(curl, reqStartTime, curlTrace), timestamp: ts()
                });
            });
        }

        headersDone.resolve({ status, headers });
    });

    curl.onData((chunk: ArrayBuffer) => {
        // Drop redirect body data (e.g. 302 HTML page) entirely: no netHook
        // emission and no buffering into the final response body.
        if (waitingForFinalHeaders) return false;
        const chunkView = new Uint8Array(chunk);
        const chunkBytes = new Uint8Array(chunkView.byteLength);
        chunkBytes.set(chunkView);
        if (netHook) {
            const hookBytes = new Uint8Array(chunkBytes.byteLength);
            hookBytes.set(chunkBytes);
            emitFetchHookQuietly(() => {
                netHook.onData?.({ requestId, data: hookBytes, timestamp: ts() });
            });
        }
        enqueueBodyChunk(chunkBytes);
        return false;
    });

    // CDP Fetch interception: pause request before sending, let DevTools
    // modify/fulfill/fail it. Must happen after all curl options are configured
    // and after AbortSignal is wired, but before perform().
    if (interceptHook?.onRequest) {
        let result: InterceptResult | null;
        try {
            result = await interceptHook.onRequest({
                requestId, url: url.href, method: request.method,
                headers: objHeaders, postData: truncateHookPostData(body ?? null),
                callFrames: reqCallFrames, resourceType: 'Fetch',
            });
        } catch (error) {
            cleanupBeforePerform();
            throw error;
        }
        if (result) {
            if (result.action === 'fulfill') {
                removeAbortHandler();
                abortCurl();
                inFlightFetchFrames.delete(headersDone.promise);
                const resHeaders = new Headers();
                for (const [k, v] of result.responseHeaders) resHeaders.set(k, v);
                return new Response(result.body, { status: result.responseCode, headers: resHeaders });
            }
            if (result.action === 'fail') {
                removeAbortHandler();
                abortCurl();
                inFlightFetchFrames.delete(headersDone.promise);
                throw new TypeError(`Request blocked: ${result.reason}`);
            }
            // action === 'continue': apply modifications to the already-configured curl handle
            try {
                if (result.url) {
                    curl.setUrl(result.url);
                    configureRequestNetwork(new URL(result.url, url));
                }
                if (result.method) curl.setMethod(result.method);
                if (result.headers) curl.setHeaders(result.headers);
                if (result.postData) curl.setBody(toCurlBody(result.postData));
            } catch (error) {
                cleanupBeforePerform();
                throw error;
            }
        }
    }

    // call hook
    const reqStartTime = Date.now() / 1000;  // absolute start for timing delta calc
    if (netHook) {
        emitFetchHookQuietly(() => {
            netHook.onRequest?.({
                requestId, url: url.href, method: request.method,
                headers: objHeaders, postData: truncateHookPostData(body ?? null), callFrames: reqCallFrames, resourceType: 'Fetch', timestamp: reqStartTime
            });
        });
    }

    // perform() runs in background; we await headers independently
    let performPromise: Promise<unknown>;
    try {
        performPromise = curl.perform().then(
            () => {
                closeBody();
                if (netHook) {
                    const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);
                    emitFetchHookQuietly(() => {
                        netHook.onFinished?.({ requestId, success: true, connection: conn, timestamp: ts() });
                    });
                }
            },
            (err: Error) => {
                const fetchErr = isCurlTimeoutError(err) ? timeoutError() : err;
                headersDone.reject(fetchErr);
                errorBody(fetchErr);
                if (netHook) {
                    const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);
                    emitFetchHookQuietly(() => {
                        netHook.onFinished?.({ requestId, success: false, errorText: fetchErr.message, connection: conn, timestamp: ts() });
                    });
                }
            }
        ).finally(() => {
            inFlightFetchFrames.delete(headersDone.promise);
            removeAbortHandler();
            curlRecvPaused = false;
        });
    } catch (error) {
        cleanupBeforePerform();
        throw error;
    }

    try {
        const { status, headers: rawHeaders } = await headersDone.promise;
        throwIfAborted(request.signal);

        const responseHeaders = rawHeadersToHeaders(rawHeaders);
        const isRedirect = isFollowedRedirect(status, rawHeaders);

        if (request.redirect === 'error' && isRedirect) {
            abortCurl();
            throw new TypeError(`Request redirect mode is "error" but received redirect ${status}`);
        }

        // highWaterMark scaled to available RAM via memory-tier (16 KB – 256 KB).
        // ByteLengthQueuingStrategy counts actual byte sizes of Uint8Array chunks.
        const bodyStream = isNullBodyStatus(status) || request.method === 'HEAD' ? null : new ReadableStream<Uint8Array>({
            start: startBody,
            pull() {
                flushPendingBodyChunks();
                syncCurlBackpressure();
            },
            cancel() {
                bodyCanceled = true;
                if (streamController) streamController._onDequeueCallback = null;
                pendingBodyChunks.length = 0;
                pendingBodySize = 0;
                abortCurl();
            }
        }, new ByteLengthQueuingStrategy({ highWaterMark: streamHighWaterMark }));

        const result = new Response(bodyStream, { status, headers: responseHeaders });
        const finalUrl = readFinalUrl(curl, url.href);
        setResponseMetadata(result, {
            url: finalUrl,
            redirected: didRedirect || finalUrl !== url.href,
            type: 'basic',
        });
        return result;
    } catch (err) {
        abortCurl();
        // drain so perform() settles and we don't leak the handle
        await performPromise.catch(() => {});
        if (request.signal?.aborted) throw abortError(request.signal);
        if (isCurlTimeoutError(err)) throw timeoutError();
        throw err;
    }
}

/**
 * Attach an `init.client` (Deno.HttpClient) to the request so performFetch applies
 * its proxy/CA/mTLS settings.
 *
 * The option used to be dropped on the floor: `Request` does not retain unknown
 * init keys, and nothing in the tree ever called `setRequestClient`, so every
 * caller that configured a proxy, pinned a CA or supplied a client certificate got
 * a default connection and no indication that it had happened. Silently ignoring a
 * security-relevant option is the defect, so a non-HttpClient value is rejected
 * rather than ignored.
 *
 * Measured against Deno 2.9.3: `fetch(url, { client: {} })` rejects with
 * `TypeError: Failed to construct 'Request': Argument 2 \`client\` must be a
 * Deno.HttpClient` — duck-typed objects are refused too — while `null` and
 * `undefined` mean "no client". A client attached to a Request also survives
 * `fetch(new Request(rq))`, which the carry-over below preserves.
 */
async function attachRequestClient(request: Request, init: RequestInit | undefined, input: unknown): Promise<void> {
    const client = (init as { client?: unknown } | undefined)?.client;
    // Import only when a client is actually in play: the common path must not pay
    // for loading the Deno http module on every fetch.
    if ((client === undefined || client === null) && !(input instanceof Request)) return;
    const http = await import('../../deno/07_http');
    if (client === undefined || client === null) {
        // Carry a client forward off an input Request, matching Deno.
        if (input instanceof Request) {
            const inherited = http.getRequestClient(input);
            if (inherited) http.setRequestClient(request, inherited);
        }
        return;
    }
    if (!(client instanceof http.HttpClient)) {
        throw new TypeError("Failed to construct 'Request': Argument 2 `client` must be a Deno.HttpClient");
    }
    http.setRequestClient(request, client);
}

export async function fetchAsync(input: unknown, init?: RequestInit, initiatorCallFrames?: NetworkCallFrame[]): Promise<Response> {
    if (input instanceof URL) input = input.href;
    const request = new Request(toRequestInput(input), init);
    await attachRequestClient(request, init, input);
    request.setInitiatorCallFrames(initiatorCallFrames);
    throwIfAborted(request.signal);
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && !isLocalFetchProtocol(url.protocol)) throw new TypeError(`Unsupported protocol: ${url.protocol}`);
    return performFetch(request, url);
}

export function fetch(input: unknown, init?: RequestInit): Promise<Response> {
    const initiatorCallFrames = (getFetchHook() || getFetchInterceptHook()) ? captureUserNetworkCallFrames() : undefined;
    return fetchAsync(input, init, initiatorCallFrames);
}
