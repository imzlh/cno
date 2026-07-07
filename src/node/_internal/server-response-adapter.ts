const text = import.meta.use('text');
const engine = import.meta.use('engine');

import {
    nodeTs,
    normalizeHeaderRecord,
    toUint8Array,
} from './network-debug';
import type { OutgoingHttpHeaders } from '../http/types';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type HeaderInput = OutgoingHttpHeaders | readonly string[];

function encodeStringForEncoding(encoding?: string): (value: string) => Uint8Array {
    if (!encoding) return engine.encodeString;
    if (!text) throw new Error('text encoding module is not available');
    return (value: string) => new text.Encoder(encoding).encode(value);
}

export interface ResponseAdapterTarget {
    statusCode: number;
    statusMessage: string;
    sendDate: boolean;
    chunkedEncoding: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    finished: boolean;
    writableHighWaterMark: number;
    headersSent: boolean;
    hasHeader(name: string): boolean;
    setHeader(name: string, value: OutgoingHttpHeaders[string]): unknown;
    getHeaders(): OutgoingHttpHeaders;
    emit(event: string | symbol, ...args: unknown[]): boolean;
}

export interface ResponseAdapterServeHook {
    onResponse?(payload: {
        requestId: string;
        timestamp: number;
        url: string;
        status: number;
        statusText: string;
        headers: Record<string, string | string[]>;
    }): void;
    onData?(payload: {
        requestId: string;
        timestamp: number;
        data: Uint8Array;
    }): void;
    onFinished?(payload: {
        requestId: string;
        timestamp: number;
        success: boolean;
        errorText?: string;
    }): void;
}

export interface ResponseAdapterCloseSource {
    once(event: 'close', listener: () => void): unknown;
}

export interface ResponseAdapterTransport<TResponse extends ResponseAdapterTarget> {
    closeSource?: ResponseAdapterCloseSource | null;
    writeHead(response: TResponse, headers: Array<[string, string]>): Promise<void>;
    writeBody(response: TResponse, data: Uint8Array): Promise<void>;
    finish(response: TResponse): Promise<void>;
    abort?(response: TResponse, error: Error): void;
    normalizeError?(err: unknown): Error;
}

interface ResponseAdapterHelpers {
    isBodyForbiddenStatus(statusCode: number): boolean;
    createHeadersSentError(): Error & { code: string };
    createWriteAfterEndError(): Error & { code: string };
}

function emitServeFinishedQuietly(
    serveHook: ResponseAdapterServeHook | null | undefined,
    payload: Parameters<NonNullable<ResponseAdapterServeHook['onFinished']>>[0]
): void {
    try {
        serveHook?.onFinished?.(payload);
    } catch {
        // Debug hooks must not affect the HTTP response lifecycle.
    }
}

export class ServerResponseAdapter<TResponse extends ResponseAdapterTarget> {
    protected readonly response: TResponse;
    private readonly transport: ResponseAdapterTransport<TResponse>;
    private readonly serveHook: ResponseAdapterServeHook | null | undefined;
    private readonly helpers: ResponseAdapterHelpers;
    private readonly requestId: string;
    private readonly requestUrl: string;
    private readonly suppressBody: boolean;
    private queue: Promise<void> = Promise.resolve();
    private headWritten = false;
    private closed = false;
    private failed = false;
    private finished = false;
    private pendingBytes = 0;
    private needDrain = false;

    constructor(
        response: TResponse,
        transport: ResponseAdapterTransport<TResponse>,
        serveHook: ResponseAdapterServeHook | null | undefined,
        helpers: ResponseAdapterHelpers,
        requestId: string,
        requestUrl: string,
        suppressBody = false,
    ) {
        this.response = response;
        this.transport = transport;
        this.serveHook = serveHook;
        this.helpers = helpers;
        this.requestId = requestId;
        this.requestUrl = requestUrl;
        this.suppressBody = suppressBody;
        this.transport.closeSource?.once('close', () => {
            if (this.response.writableEnded && !this.failed) {
                return;
            }
            this.closed = true;
            if (!this.finished && !this.failed) {
                this.fail(Object.assign(new Error('socket closed before response finished'), {
                    code: 'ECONNRESET',
                    syscall: 'write',
                }));
            }
        });
    }

    private enqueue<T>(op: () => Promise<T>): Promise<T> {
        const next = this.queue.then(async () => {
            if (this.closed || this.failed) {
                throw Object.assign(new Error('socket closed before response write completed'), {
                    code: 'ECONNRESET',
                    syscall: 'write',
                });
            }
            return op();
        }, async () => {
            if (this.closed || this.failed) {
                throw Object.assign(new Error('socket closed before response write completed'), {
                    code: 'ECONNRESET',
                    syscall: 'write',
                });
            }
            return op();
        });
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }

    private shouldSuppressBody(): boolean {
        return this.suppressBody || this.helpers.isBodyForbiddenStatus(this.response.statusCode);
    }

    private normalizeHeadersInput(headers?: HeaderInput): void {
        if (!headers) return;
        if (Array.isArray(headers)) {
            for (let i = 0; i < headers.length; i += 2) {
                this.response.setHeader(String(headers[i]), String(headers[i + 1]));
            }
            return;
        }
        for (const [key, value] of Object.entries(headers)) {
            if (value !== undefined) this.response.setHeader(key, value);
        }
    }

    private ensureImplicitHeaders(): void {
        if (!this.response.hasHeader('date') && this.response.sendDate) {
            this.response.setHeader('Date', new Date().toUTCString());
        }

        if (
            !this.shouldSuppressBody() &&
            !this.response.hasHeader('content-length') &&
            !this.response.hasHeader('transfer-encoding')
        ) {
            this.response.chunkedEncoding = true;
            this.response.setHeader('Transfer-Encoding', 'chunked');
        }
    }

    private collectHeaders(): Array<[string, string]> {
        const allHeaders: Array<[string, string]> = [];
        for (const [key, value] of Object.entries(this.response.getHeaders())) {
            if (Array.isArray(value)) {
                for (const item of value) allHeaders.push([key, String(item)]);
            } else {
                allHeaders.push([key, String(value)]);
            }
        }
        return allHeaders;
    }

    private fail(err: unknown, callback?: (err?: Error | null) => void): void {
        const error = this.transport.normalizeError?.(err) ?? (err instanceof Error ? err : new Error(String(err)));
        if (this.failed) {
            callback?.(error);
            return;
        }
        this.closed = true;
        this.failed = true;
        if (!this.response.writableEnded) this.response.writableEnded = true;
        this.abortTransportQuietly(error);
        this.response.emit('close');
        emitServeFinishedQuietly(this.serveHook, {
            requestId: this.requestId,
            timestamp: nodeTs(),
            success: false,
            errorText: String(error.message ?? error),
        });
        this.response.emit('error', error);
        callback?.(error);
    }

    private abortTransportQuietly(error: Error): void {
        try {
            this.transport.abort?.(this.response, error);
        } catch {
            // The response is already failing; surface the original error.
        }
    }

    private settleWrite(byteLength: number): void {
        this.pendingBytes -= byteLength;
        if (this.needDrain && this.pendingBytes <= 0) {
            this.needDrain = false;
            this.response.emit('drain');
        }
    }

    writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | HeaderInput,
        headers?: HeaderInput,
    ): TResponse {
        if (this.headWritten || this.response.headersSent) {
            throw this.helpers.createHeadersSentError();
        }

        this.response.statusCode = statusCode;
        if (typeof statusMessageOrHeaders === 'string') {
            this.response.statusMessage = statusMessageOrHeaders;
        }

        if (typeof statusMessageOrHeaders === 'object' && statusMessageOrHeaders !== null) {
            this.normalizeHeadersInput(statusMessageOrHeaders);
        } else {
            this.normalizeHeadersInput(headers);
        }

        this.ensureImplicitHeaders();

        const outHeaders = this.collectHeaders();
        this.response.headersSent = true;
        this.headWritten = true;

        try {
            this.serveHook?.onResponse?.({
                requestId: this.requestId,
                timestamp: nodeTs(),
                url: this.requestUrl,
                status: this.response.statusCode,
                statusText: this.response.statusMessage,
                headers: normalizeHeaderRecord(this.response.getHeaders()),
            });
        } catch {}

        this.enqueue(() => this.transport.writeHead(this.response, outHeaders))
            .catch((err) => this.fail(err));

        return this.response;
    }

    flushHeaders(): void {
        if (this.response.headersSent) return;
        this.ensureImplicitHeaders();
        this.writeHead(this.response.statusCode, this.response.statusMessage);
    }

    write(
        chunk: unknown,
        encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
        cb?: (err?: Error | null) => void,
    ): boolean {
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
        if (this.response.writableEnded) {
            const err = this.helpers.createWriteAfterEndError();
            callback?.(err);
            queueMicrotask(() => this.response.emit('error', err));
            return false;
        }
        if (!this.response.headersSent) {
            this.ensureImplicitHeaders();
            this.writeHead(this.response.statusCode, this.response.statusMessage);
        }

        try {
            const encodeString = encodeStringForEncoding(encoding);
            const data = toUint8Array(chunk, encodeString);
            if (this.shouldSuppressBody()) {
                callback?.();
                return true;
            }
            this.pendingBytes += data.byteLength;
            this.enqueue(async () => {
                try { this.serveHook?.onData?.({ requestId: this.requestId, timestamp: nodeTs(), data }); } catch {}
                await this.transport.writeBody(this.response, data);
            }).then(() => {
                this.settleWrite(data.byteLength);
                callback?.();
            }, (err) => {
                this.settleWrite(data.byteLength);
                this.fail(err, callback);
            });
        } catch (err) {
            this.fail(err, callback);
        }

        const ok = this.pendingBytes < this.response.writableHighWaterMark;
        if (!ok) this.needDrain = true;
        return ok;
    }

    end(chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): TResponse {
        let callback: (() => void) | undefined;
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = undefined;
        } else if (typeof encodingOrCb === 'function') {
            callback = encodingOrCb;
        } else {
            callback = cb;
        }

        if (this.response.writableEnded) {
            callback?.();
            return this.response;
        }

        this.response.writableEnded = true;

        if (chunk === undefined && !this.response.headersSent) {
            if (
                !this.shouldSuppressBody() &&
                !this.response.hasHeader('content-length') &&
                !this.response.hasHeader('transfer-encoding')
            ) {
                this.response.setHeader('Content-Length', '0');
            }
            this.writeHead(this.response.statusCode, this.response.statusMessage);
        } else if (chunk !== undefined && !this.response.headersSent) {
            const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
            const encodeString = encodeStringForEncoding(encoding);
            const data = toUint8Array(chunk, encodeString);
            if (
                !this.shouldSuppressBody() &&
                !this.response.hasHeader('content-length') &&
                !this.response.hasHeader('transfer-encoding')
            ) {
                this.response.setHeader('Content-Length', String(data.byteLength));
            }
            this.writeHead(this.response.statusCode, this.response.statusMessage);
            chunk = data;
        }

        this.enqueue(async () => {
            if (chunk !== undefined && !this.shouldSuppressBody()) {
                const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
                const encodeString = encodeStringForEncoding(encoding);
                const data = chunk instanceof Uint8Array ? chunk : toUint8Array(chunk, encodeString);
                try { this.serveHook?.onData?.({ requestId: this.requestId, timestamp: nodeTs(), data }); } catch {}
                await this.transport.writeBody(this.response, data);
            }
            await this.transport.finish(this.response);
        }).then(() => {
            this.finished = true;
            this.response.finished = true;
            this.response.writableFinished = true;
            emitServeFinishedQuietly(this.serveHook, { requestId: this.requestId, timestamp: nodeTs(), success: true });
            this.response.emit('finish');
            callback?.();
        }, (err) => {
            this.fail(err, callback as ((err?: Error | null) => void) | undefined);
        });

        return this.response;
    }

    abort(err: unknown): void {
        this.enqueue(async () => {
            const error = this.transport.normalizeError?.(err) ?? (err instanceof Error ? err : new Error(String(err)));
            this.abortTransportQuietly(error);
            this.fail(error);
        }).catch((error) => this.fail(error));
    }
}
