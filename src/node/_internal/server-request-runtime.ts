import type { NetworkCallFrame, ServeHook } from '../../utils/network-hooks';
import type { OutgoingHttpHeaders } from '../http/types';

import { nodeTs } from './network-debug';
import { isTransportDisconnectError } from './errno';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type HeaderInput = OutgoingHttpHeaders | readonly string[];
type WriteCallback = (err?: Error | null) => void;

export interface RuntimeAdapter<TResponse extends RuntimeResponse> {
    writeHead: TResponse['writeHead'];
    flushHeaders: TResponse['flushHeaders'];
    write: TResponse['write'];
    end: TResponse['end'];
    abort?(err: unknown): void;
    readonly isAborted?: boolean;
    readonly isFinished?: boolean;
    readonly lastError?: Error | null;
}

interface RuntimeResponse {
    writableEnded: boolean;
    writableFinished: boolean;
    headersSent: boolean;
    writeHead(statusCode: number, statusMessageOrHeaders?: string | HeaderInput, headers?: HeaderInput): this;
    flushHeaders(): void;
    write(chunk: unknown, encodingOrCb?: BufferEncoding | WriteCallback, cb?: WriteCallback): boolean;
    end(chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    off(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

export interface RuntimeRequestMeta {
    requestId: string;
    timestamp: number;
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: Uint8Array | null;
    callFrames?: NetworkCallFrame[];
}

export interface RunServerRequestContext<TIncoming, TResponse extends RuntimeResponse> {
    listener: (req: TIncoming, res: TResponse) => unknown | Promise<unknown>;
    incoming: TIncoming;
    response: TResponse;
    adapter: RuntimeAdapter<TResponse>;
    serveHook?: ServeHook | null;
    request: RuntimeRequestMeta;
    onError(err: unknown): void;
}

export interface DispatchServerRequestContext<TIncoming, TResponse extends RuntimeResponse>
    extends Omit<RunServerRequestContext<TIncoming, TResponse>, 'request'>, RuntimeRequestMeta {}

/**
 * Watch response terminal events. Disconnect is a normal end-of-stream, not a
 * request failure — settle the waiter without rejecting.
 */
function observeServerResponse(response: RuntimeResponse): {
    observed: Promise<void>;
    getError: () => unknown;
    wasDisconnect: () => boolean;
} {
    let responseDoneError: unknown;
    let disconnect = false;
    let settled = false;
    const responseDone = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            response.off('finish', onFinish);
            response.off('error', onError);
            response.off('close', onClose);
        };
        const settleOk = (asDisconnect: boolean) => {
            if (settled) return;
            settled = true;
            if (asDisconnect) disconnect = true;
            cleanup();
            resolve();
        };
        const settleErr = (err: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };
        const onFinish = () => settleOk(false);
        const onError = (err: unknown) => {
            const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
            if (code === 'ERR_STREAM_WRITE_AFTER_END' && response.writableEnded) {
                return;
            }
            // Disconnect may arrive as 'error' after 'close' or alone — never fail the request.
            if (isTransportDisconnectError(err)) {
                settleOk(true);
                return;
            }
            settleErr(err);
        };
        // Peer close without finish (client abort mid-body). Real faults emit error first.
        const onClose = () => {
            if (response.writableFinished) return;
            settleOk(true);
        };
        response.on('finish', onFinish);
        response.on('error', onError);
        response.on('close', onClose);
    });
    const observed = responseDone.catch((err) => {
        responseDoneError = err;
    });
    return {
        observed,
        getError: () => responseDoneError,
        wasDisconnect: () => disconnect,
    };
}

function emitServeRequest(serveHook: ServeHook | null | undefined, request: RuntimeRequestMeta): void {
    try {
        serveHook?.onRequest?.(request);
    } catch {}
}

function emitServeFailure(serveHook: ServeHook | null | undefined, request: RuntimeRequestMeta, err: unknown): void {
    try {
        serveHook?.onFinished?.({
            requestId: request.requestId,
            timestamp: nodeTs(),
            success: false,
            errorText: errorMessage(err),
        });
    } catch {
        // Debug hooks must not affect request error handling.
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function writeInternalServerErrorQuietly(response: RuntimeResponse): void {
    try {
        response.writeHead(500);
    } catch {}
    try {
        response.end();
    } catch {}
}

function abortAdapterQuietly<TResponse extends RuntimeResponse>(adapter: RuntimeAdapter<TResponse>, err: unknown): void {
    try {
        adapter.abort?.(err);
    } catch {}
}

function bindServerResponseAdapter<TResponse extends RuntimeResponse>(response: TResponse, adapter: RuntimeAdapter<TResponse>): void {
    // writeHead/end are declared to return polymorphic `this`, which `.bind()`
    // erases. The bound adapter proxies to this same response, so the identity
    // holds at runtime even though TS cannot prove it.
    response.writeHead = adapter.writeHead.bind(adapter) as typeof response.writeHead;
    response.flushHeaders = adapter.flushHeaders.bind(adapter) as TResponse['flushHeaders'];
    response.write = adapter.write.bind(adapter) as TResponse['write'];
    response.end = adapter.end.bind(adapter) as typeof response.end;
}

export async function runServerRequest<TIncoming, TResponse extends RuntimeResponse>(
    ctx: RunServerRequestContext<TIncoming, TResponse>
): Promise<void> {
    emitServeRequest(ctx.serveHook, ctx.request);
    bindServerResponseAdapter(ctx.response, ctx.adapter);
    const responseDone = observeServerResponse(ctx.response);

    try {
        await ctx.listener(ctx.incoming, ctx.response);
        if (ctx.adapter.isAborted || responseDone.wasDisconnect()) {
            // Client left; request completed from the server's point of view.
            return;
        }
        if (!ctx.response.writableFinished) {
            await responseDone.observed;
            if (ctx.adapter.isAborted || responseDone.wasDisconnect()) return;
            const err = responseDone.getError();
            if (err !== undefined) {
                if (isTransportDisconnectError(err)) return;
                throw err;
            }
        }
    } catch (err) {
        // Listener threw, or a non-disconnect response fault.
        if (isTransportDisconnectError(err) || ctx.adapter.isAborted) {
            abortAdapterQuietly(ctx.adapter, err);
            return;
        }
        if (!ctx.response.headersSent) {
            // No response terminal yet — report failure here, then try a 500.
            emitServeFailure(ctx.serveHook, ctx.request, err);
            writeInternalServerErrorQuietly(ctx.response);
        } else if (!ctx.response.writableFinished) {
            // abort → enterFailed owns the single onFinished for this request.
            abortAdapterQuietly(ctx.adapter, err);
        } else {
            emitServeFailure(ctx.serveHook, ctx.request, err);
        }
        ctx.onError(err);
    }
}

export function dispatchServerRequest<TIncoming, TResponse extends RuntimeResponse>(
    ctx: DispatchServerRequestContext<TIncoming, TResponse>
): Promise<void> {
    return runServerRequest({
        listener: ctx.listener,
        incoming: ctx.incoming,
        response: ctx.response,
        adapter: ctx.adapter,
        serveHook: ctx.serveHook,
        request: {
            requestId: ctx.requestId,
            timestamp: ctx.timestamp,
            url: ctx.url,
            method: ctx.method,
            headers: ctx.headers,
            postData: ctx.postData,
            callFrames: ctx.callFrames,
        },
        onError: ctx.onError,
    });
}
