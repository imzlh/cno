import { Headers } from "headers-polyfill";
import { version } from "../../../package.json";
import { getFetchHook, getUserAgentOverride, getExtraHTTPHeaders, getFetchInterceptHook, captureUserNetworkCallFrames, getCurlInitHook, type NetworkCallFrame } from "../../utils/network-hooks";
import { type HttpClient } from "../../deno/07_http";
import { Request } from "./request";
import { Response } from "./response";
import { abortError, asyncfs, attachCurlDebugTrace, buildConnectionInfo, compressionAcceptEncoding, curlMod, engine, getCurlPool, isCurlTimeoutError, isNullBodyStatus, maxPendingBodyBytes, os, parseHeaders, prepareRequestBody, rawHeadersToHeaders, streamHighWaterMark, throwIfAborted, timeoutError, toCurlBody, truncateHookPostData } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

let _fetchIdCounter = 0;
function newRequestId(): string { return `fetch-${++_fetchIdCounter}`; }

/** Write a PEM string to a temp file and return its path. */
async function writeTempPem(name: string, pem: string) {
    const path = `${os.tmpDir}/ca-${name}-${Math.random().toString(36).slice(2, 8)}.pem`;
    const f = await asyncfs.open(path, 'w');
    await f.write(engine.encodeString(pem));
    f.close();
    return path;
}

/** Apply Deno.HttpClient proxy + mTLS settings to a curl handle. Returns temp PEM paths to delete after use. */
async function applyClientToCurl(curl: CModuleCURL.CURL, client: HttpClient): Promise<string[]> {
    const tempFiles: string[] = [];
    const proxyUrl = client.getProxyUrl();
    if (proxyUrl) {
        if (!['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(proxyUrl.protocol))
            throw new Error(`Unsupported proxy protocol: ${proxyUrl.protocol}`);
        curl.setProxy(proxyUrl.href, proxyUrl.protocol as any);
    }
    // mTLS: HttpClient stores PEM strings; curl needs file paths.
    const opts = client.options;
    if (opts.caCerts?.length) {
        const caPem = opts.caCerts.join('\n');
        const p = await writeTempPem('ca', caPem);
        tempFiles.push(p);
        curl.setCABundle(p);
    }
    if (opts.cert) {
        const p = await writeTempPem('cert', opts.cert);
        tempFiles.push(p);
        curl.setOpt(curlMod.CURLOPT_SSLCERT, p);
    }
    if (opts.key) {
        const p = await writeTempPem('key', opts.key);
        tempFiles.push(p);
        curl.setOpt(curlMod.CURLOPT_SSLKEY, p);
    }
    return tempFiles;
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
    const preparedBody = await prepareRequestBody(request);
    const body = preparedBody.kind === 'buffer' ? preparedBody.body : null;
    throwIfAborted(request.signal);

    const curl = new curlMod.CURL(getCurlPool());
    getCurlInitHook()?.(curl);

    // If a Deno.HttpClient is attached, apply its proxy/SSL config to curl
    // instead of reimplementing HTTP on a raw socket.
    const client = (await import('../../deno/07_http')).getRequestClient(request);
    let tempPemFiles: string[] = [];
    let tempBodyFile: string | null = preparedBody.kind === 'file' ? preparedBody.path : null;
    if (client) {
        tempPemFiles = await applyClientToCurl(curl, client);
    }
    const netHook = getFetchHook();
    const curlTrace = netHook ? attachCurlDebugTrace(curl) : undefined;
    const interceptHook = getFetchInterceptHook();
    const requestId = (netHook || interceptHook) ? newRequestId() : '';
    const ts = () => Date.now() / 1000;
    const reqCallFrames = netHook ? request.getInitiatorCallFrames() : undefined;

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
    curl.setOpt(curlMod.CURLOPT_AUTOREFERER, 1);  // update Referer to the Location URL on each redirect hop
    curl.setAcceptEncoding(acceptEncoding);

    // redirect mode
    if (request.redirect === 'error' || request.redirect === 'manual') {
        curl.setFollowRedirects(false);
    } else {
        curl.setFollowRedirects(true);
        curl.setMaxRedirects(20);
    }

    if (preparedBody.kind === 'buffer' && body && body.length > 0) {
        curl.setBody(toCurlBody(body));
    } else if (preparedBody.kind === 'file') {
        curl.setUploadFile(preparedBody.path);
        if (request.method === 'POST') {
            curl.setMethod('POST');
            curl.setOpt(curlMod.CURLOPT_POSTFIELDSIZE_LARGE, preparedBody.size);
        } else if (request.method !== 'PUT') {
            curl.setMethod(request.method);
        }
    }

    // AbortSignal directly cancels the underlying curl request
    let abortHandler: (() => void) | null = null;
    if (request.signal) {
        abortHandler = () => {
            const err = abortError(request.signal);
            headersDone.reject(err);
            errorBody(err);
            try { curl.abort(); } catch {}
        };
        if (request.signal.aborted) {
            curl.abort();
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

    // Resolve as soon as headers arrive; stream body via ReadableStream.
    const headersDone = Promise.withResolvers<{ status: number; headers: string }>();
    inFlightFetchFrames.add(headersDone.promise);
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let bodyCanceled = false;
    let bodyTerminal: { type: 'close' } | { type: 'error'; error: any } | null = null;
    const pendingBodyChunks: Uint8Array[] = [];
    let pendingBodySize = 0;

    let curlRecvPaused = false;

    const pauseCurlRecv = () => {
        if (curlRecvPaused || bodyCanceled || bodyTerminal) return;
        try {
            curl.pauseRecv();
            curlRecvPaused = true;
        } catch {}
    };

    const resumeCurlRecv = () => {
        if (!curlRecvPaused || bodyCanceled || bodyTerminal) return;
        try {
            curl.resumeRecv();
            curlRecvPaused = false;
        } catch {}
    };

    const shiftPendingBodyChunk = (): Uint8Array | undefined => {
        const chunk = pendingBodyChunks.shift();
        if (chunk) pendingBodySize -= chunk.byteLength;
        return chunk;
    };

    const shouldPauseCurlRecv = (): boolean => {
        if (bodyCanceled || bodyTerminal) return false;
        if (!streamController) return pendingBodySize >= maxPendingBodyBytes;
        return pendingBodySize >= maxPendingBodyBytes || !!(streamController as any)._backpressured;
    };

    const syncCurlBackpressure = () => {
        if (shouldPauseCurlRecv()) pauseCurlRecv();
        else resumeCurlRecv();
    };

    const flushPendingBodyChunks = () => {
        if (!streamController) return;
        while (pendingBodyChunks.length > 0) {
            if ((streamController as any)._backpressured) break;
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
    };

    const enqueueBodyChunk = (chunk: Uint8Array): void => {
        if (bodyCanceled || bodyTerminal) return;
        if (!streamController || (streamController as any)._backpressured) {
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
        if (!streamController) {
            bodyTerminal = { type: 'close' };
            return;
        }
        flushPendingBodyChunks();
        streamController.close();
        bodyTerminal = { type: 'close' };
    };

    const errorBody = (error: any) => {
        if (bodyCanceled || bodyTerminal) return;
        resumeCurlRecv();
        if (!streamController) {
            bodyTerminal = { type: 'error', error };
            return;
        }
        streamController.error(error);
        bodyTerminal = { type: 'error', error };
    };

    const startBody = (controller: ReadableStreamDefaultController<Uint8Array>) => {
        streamController = controller;
        (controller as any)._onEnqueueCallback = syncCurlBackpressure;
        flushPendingBodyChunks();
        if (bodyTerminal?.type === 'close') controller.close();
        else if (bodyTerminal?.type === 'error') controller.error(bodyTerminal.error);
        else syncCurlBackpressure();
    };

    const followingRedirects = request.redirect !== 'error' && request.redirect !== 'manual';
    let didRedirect = false;
    let waitingForFinalHeaders = false; // true between a redirect hop and the final onHeadersComplete

    curl.onHeadersComplete((status, headers) => {
        const isRedirectStatus = status >= 300 && status < 400;

        // When curl follows redirects, onHeadersComplete fires for each hop.
        // Skip intermediate redirect responses entirely — the netHook and
        // headersDone should only see the FINAL response.
        if (isRedirectStatus && followingRedirects) {
            didRedirect = true;
            waitingForFinalHeaders = true;
            // Discard any body chunks accumulated from the redirect response
            // so the body stream and netHook only contain the final response.
            pendingBodyChunks.length = 0;
            return;
        }

        waitingForFinalHeaders = false;

        // Parse headers into object only for the final response.
        if (netHook) {
            const hdrs: Record<string, string> = {};
            for (const [k, v] of parseHeaders(headers)) hdrs[k] = v;
            try {
                netHook.onResponse?.({
                    requestId, url: url.href, status, headers: hdrs,
                    requestHeaders: objHeaders,
                    resourceType: 'Fetch',
                    connection: buildConnectionInfo(curl, reqStartTime, curlTrace), timestamp: ts()
                });
            } catch {}
        }

        headersDone.resolve({ status, headers });
    });

    curl.onData((chunk: ArrayBuffer) => {
        const chunkView = new Uint8Array(chunk);
        const chunkBytes = new Uint8Array(chunkView.byteLength);
        chunkBytes.set(chunkView);
        // Skip netHook emission for redirect body data (e.g. 302 HTML page).
        if (!waitingForFinalHeaders && netHook) {
            const hookBytes = new Uint8Array(chunkBytes.byteLength);
            hookBytes.set(chunkBytes);
            try { netHook.onData?.({ requestId, data: hookBytes, timestamp: ts() }); } catch {}
        }
        enqueueBodyChunk(chunkBytes);
        return false;
    });

    // CDP Fetch interception: pause request before sending, let DevTools
    // modify/fulfill/fail it. Must happen after all curl options are configured
    // and after AbortSignal is wired, but before perform().
    if (interceptHook?.onRequest) {
        const result = await interceptHook.onRequest({
            requestId, url: url.href, method: request.method,
            headers: objHeaders, postData: truncateHookPostData(body ?? null), resourceType: 'Fetch',
        });
        if (result) {
            if (result.action === 'fulfill') {
                removeAbortHandler();
                try { curl.abort(); } catch {}
                const resHeaders = new Headers();
                for (const [k, v] of result.responseHeaders) resHeaders.set(k, v);
                return new Response(result.body, { status: result.responseCode, headers: resHeaders });
            }
            if (result.action === 'fail') {
                removeAbortHandler();
                try { curl.abort(); } catch {}
                throw new TypeError(`Request blocked: ${result.reason}`);
            }
            // action === 'continue': apply modifications to the already-configured curl handle
            if (result.url) curl.setUrl(result.url);
            if (result.method) curl.setMethod(result.method);
            if (result.headers) curl.setHeaders(result.headers);
            if (result.postData) curl.setBody(toCurlBody(result.postData));
        }
    }

    // call hook
    const reqStartTime = Date.now() / 1000;  // absolute start for timing delta calc
    if (netHook) try {
        netHook.onRequest?.({
            requestId, url: url.href, method: request.method,
            headers: objHeaders, postData: truncateHookPostData(body ?? null), callFrames: reqCallFrames, resourceType: 'Fetch', timestamp: reqStartTime
        });
    } catch {}

    // perform() runs in background; we await headers independently
    const performPromise = curl.perform().then(
        () => {
            closeBody();
            if (netHook) {
                const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);
                try { netHook.onFinished?.({ requestId, success: true, connection: conn, timestamp: ts() }); } catch {}
            }
        },
        (err: Error) => {
            const fetchErr = isCurlTimeoutError(err) ? timeoutError() : err;
            headersDone.reject(fetchErr);
            errorBody(fetchErr);
            if (netHook) {
                const conn = buildConnectionInfo(curl, reqStartTime, curlTrace);
                try { netHook.onFinished?.({ requestId, success: false, errorText: fetchErr.message, connection: conn, timestamp: ts() }); } catch {}
            }
        }
    ).finally(() => {
        inFlightFetchFrames.delete(headersDone.promise);
        removeAbortHandler();
        for (const p of tempPemFiles) asyncfs.unlink(p).catch(() => {});
        if (tempBodyFile) asyncfs.unlink(tempBodyFile).catch(() => {});
        curlRecvPaused = false;
        // Keep pre-read body chunks alive until a reader attaches. Clearing them
        // here races with lazy consumers like response.text()/json().
        if (streamController) {
            pendingBodyChunks.length = 0;
            pendingBodySize = 0;
            streamController = null;
        }
    });

    try {
        const { status, headers: rawHeaders } = await headersDone.promise;
        throwIfAborted(request.signal);

        const responseHeaders = rawHeadersToHeaders(rawHeaders);
        const isRedirect = status >= 300 && status < 400;

        if (request.redirect === 'error' && isRedirect) {
            curl.abort();
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
                pendingBodyChunks.length = 0;
                pendingBodySize = 0;
                try { curl.abort(); } catch {}
            }
        }, new ByteLengthQueuingStrategy({ highWaterMark: streamHighWaterMark }));

        const result = new Response(bodyStream, { status, headers: responseHeaders });
        let finalUrl = url.href;
        try { finalUrl = curl.getInfo(curlMod.CURLINFO_EFFECTIVE_URL) as string || url.href; } catch {}
        Object.defineProperty(result, 'url', { value: finalUrl });
        Object.defineProperty(result, 'redirected', { value: didRedirect || isRedirect || finalUrl !== url.href });
        return result;
    } catch (err) {
        curl.abort();
        // drain so perform() settles and we don't leak the handle
        await performPromise.catch(() => {});
        if (request.signal?.aborted) throw abortError(request.signal);
        if (isCurlTimeoutError(err)) throw timeoutError();
        throw err;
    }
}

export async function fetchAsync(input: any, init?: any, initiatorCallFrames?: NetworkCallFrame[]): Promise<Response> {
    if (input instanceof URL) input = input.href;
    const request = new Request(input, init);
    request.setInitiatorCallFrames(initiatorCallFrames);
    throwIfAborted(request.signal);
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`Unsupported protocol: ${url.protocol}`);
    return performFetch(request, url);
}

export function fetch(input: any, init?: any): Promise<Response> {
    const initiatorCallFrames = getFetchHook() ? captureUserNetworkCallFrames() : undefined;
    return fetchAsync(input, init, initiatorCallFrames);
}
