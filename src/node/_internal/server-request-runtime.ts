import type { NetworkCallFrame, ServeHook } from '../../utils/network-hooks';
import type { OutgoingHttpHeaders } from '../http/types';

import { nodeTs } from './network-debug';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type HeaderInput = OutgoingHttpHeaders | readonly string[];
type WriteCallback = (err?: Error | null) => void;

export interface RuntimeAdapter<TResponse> {
    writeHead: TResponse['writeHead'];
    flushHeaders: TResponse['flushHeaders'];
    write: TResponse['write'];
    end: TResponse['end'];
    abort?(err: unknown): void;
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

function observeServerResponse(response: RuntimeResponse): { observed: Promise<void>; getError: () => unknown } {
    let responseDoneError: unknown;
    const responseDone = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            response.off('finish', onFinish);
            response.off('error', onError);
        };
        const onFinish = () => {
            cleanup();
            resolve();
        };
        const onError = (err: unknown) => {
            const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
            if (code === 'ERR_STREAM_WRITE_AFTER_END' && response.writableEnded) {
                return;
            }
            cleanup();
            reject(err);
        };
        response.on('finish', onFinish);
        response.on('error', onError);
    });
    const observed = responseDone.catch((err) => {
        responseDoneError = err;
    });
    return {
        observed,
        getError: () => responseDoneError,
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

function abortAdapterQuietly<TResponse>(adapter: RuntimeAdapter<TResponse>, err: unknown): void {
    try {
        adapter.abort?.(err);
    } catch {}
}

function bindServerResponseAdapter<TResponse extends RuntimeResponse>(response: TResponse, adapter: RuntimeAdapter<TResponse>): void {
    response.writeHead = adapter.writeHead.bind(adapter) as TResponse['writeHead'];
    response.flushHeaders = adapter.flushHeaders.bind(adapter) as TResponse['flushHeaders'];
    response.write = adapter.write.bind(adapter) as TResponse['write'];
    response.end = adapter.end.bind(adapter) as TResponse['end'];
}

export async function runServerRequest<TIncoming, TResponse extends RuntimeResponse>(
    ctx: RunServerRequestContext<TIncoming, TResponse>
): Promise<void> {
    emitServeRequest(ctx.serveHook, ctx.request);
    bindServerResponseAdapter(ctx.response, ctx.adapter);
    const responseDone = observeServerResponse(ctx.response);

    try {
        await ctx.listener(ctx.incoming, ctx.response);
        if (!ctx.response.writableFinished) {
            await responseDone.observed;
            const err = responseDone.getError();
            if (err !== undefined) throw err;
        }
    } catch (err) {
        emitServeFailure(ctx.serveHook, ctx.request, err);
        if (!ctx.response.headersSent) {
            writeInternalServerErrorQuietly(ctx.response);
        } else if (!ctx.response.writableFinished) {
            abortAdapterQuietly(ctx.adapter, err);
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
