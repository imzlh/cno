const text = import.meta.use('text');
const engine = import.meta.use('engine');

import {
    nodeTs,
    normalizeHeaderRecord,
    toUint8Array,
} from './network-debug';
import { isTransportDisconnectError } from './errno';
import type { OutgoingHttpHeaders } from '../http/types';
import { STATUS_CODES } from '../http/constants';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type HeaderInput = OutgoingHttpHeaders | readonly string[];

function reasonPhrase(code: number, explicit?: string): string {
    if (explicit) return explicit;
    return STATUS_CODES[code] ?? 'unknown';
}

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
    shouldKeepAlive?: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    finished: boolean;
    writableHighWaterMark: number;
    headersSent: boolean;
    hasHeader(name: string): boolean;
    setHeader(name: string, value: OutgoingHttpHeaders[string]): unknown;
    getHeader?(name: string): OutgoingHttpHeaders[string] | undefined;
    getHeaders(): OutgoingHttpHeaders;
    emit(event: string | symbol, ...args: unknown[]): boolean;
    listenerCount?(event: string | symbol): number;
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

/** open → finished | aborted (peer gone) | failed (real fault) */
type ResponseTerminal = 'open' | 'finished' | 'aborted' | 'failed';

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

function emitResponseErrorQuietly(response: ResponseAdapterTarget, error: Error): void {
    // Peer disconnect is terminal for the response stream, not a server fault.
    // Only surface 'error' when the app opted in with a listener — matching Node
    // (unhandled 'error' would throw and poison the request loop).
    const count = typeof response.listenerCount === 'function'
        ? response.listenerCount('error')
        : 0;
    if (count <= 0) return;
    try {
        response.emit('error', error);
    } catch {
        // Listener threw; response is already terminal.
    }
}

function disconnectError(message: string): Error & { code: string; syscall: string } {
    return Object.assign(new Error(message), {
        code: 'ECONNRESET',
        syscall: 'write',
    });
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
    private terminal: ResponseTerminal = 'open';
    private terminalError: Error | null = null;
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
            if (this.terminal !== 'open') return;
            // Peer closed while we still owed bytes — normal HTTP abort path.
            this.enterAborted(disconnectError('socket closed before response finished'));
        });
    }

    /** True when the peer left or a write fault already ended the stream. */
    get isClosed(): boolean {
        return this.terminal !== 'open' && this.terminal !== 'finished';
    }

    get isFinished(): boolean {
        return this.terminal === 'finished';
    }

    get isAborted(): boolean {
        return this.terminal === 'aborted';
    }

    get lastError(): Error | null {
        return this.terminalError;
    }

    private normalize(err: unknown): Error {
        return this.transport.normalizeError?.(err)
            ?? (err instanceof Error ? err : new Error(String(err)));
    }

    private closedWriteError(): Error {
        return this.terminalError ?? disconnectError('socket closed before response write completed');
    }

    /**
     * Serialize transport ops on a single queue. Faults never leave as bare
     * rejections: onOk/onErr run inside the chain so QuickJS cannot report
     * unhandled rejection between schedule and caller attach.
     */
    private enqueue(
        op: () => Promise<void>,
        onOk?: () => void,
        onErr?: (err: unknown) => void,
    ): void {
        const run = async () => {
            if (this.terminal !== 'open') {
                onErr?.(this.closedWriteError());
                return;
            }
            try {
                await op();
                onOk?.();
            } catch (err) {
                onErr?.(err);
            }
        };
        this.queue = this.queue.then(run, run);
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

        // Node: Keep-Alive: timeout=5 when the connection will stay open.
        const resConn = String(this.response.getHeader?.('connection') ?? '').toLowerCase();
        const req = (this.response as { req?: { headers?: Record<string, unknown> } }).req;
        const reqConn = String(req?.headers?.['connection'] ?? '').toLowerCase();
        const closing = resConn === 'close' || reqConn === 'close';
        if (!closing && this.response.shouldKeepAlive !== false && !this.response.hasHeader('keep-alive')) {
            this.response.setHeader('Keep-Alive', 'timeout=5');
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

    private markWritableEnded(): void {
        if (!this.response.writableEnded) this.response.writableEnded = true;
    }

    /**
     * Drop the Node socket facade after transport teardown so closeSource and
     * connection tracking see a real 'close' (HTTP-owned sockets never read EOF).
     */
    private closeSocketFacade(): void {
        const src = this.transport.closeSource;
        if (!src || typeof src !== 'object') return;
        const destroy = Reflect.get(src, 'destroy');
        if (typeof destroy !== 'function') return;
        const destroyed = Reflect.get(src, 'destroyed');
        if (destroyed === true) return;
        try {
            destroy.call(src);
        } catch {
            // Facade may already be torn down with the transport.
        }
    }

    /** Client/peer gone — end the stream without treating it as a server error. */
    private enterAborted(err: Error): void {
        if (this.terminal !== 'open') return;
        this.terminal = 'aborted';
        this.terminalError = err;
        this.markWritableEnded();
        this.abortTransportQuietly(err);
        this.closeSocketFacade();
        emitServeFinishedQuietly(this.serveHook, {
            requestId: this.requestId,
            timestamp: nodeTs(),
            success: false,
            errorText: String(err.message ?? err),
        });
        // close first so waiters can treat peer-gone as normal end-of-stream.
        this.response.emit('close');
        // Optional: apps that listen get the disconnect; no listener ⇒ silent.
        emitResponseErrorQuietly(this.response, err);
    }

    /** Real write/protocol fault. */
    private enterFailed(err: Error, callback?: (err?: Error | null) => void): void {
        if (this.terminal !== 'open') {
            callback?.(err);
            return;
        }
        this.terminal = 'failed';
        this.terminalError = err;
        this.markWritableEnded();
        this.abortTransportQuietly(err);
        this.closeSocketFacade();
        emitServeFinishedQuietly(this.serveHook, {
            requestId: this.requestId,
            timestamp: nodeTs(),
            success: false,
            errorText: String(err.message ?? err),
        });
        // Always emit error for real faults — request runtime attaches a listener
        // for the request lifetime, so this is never an unhandled EE throw.
        try {
            this.response.emit('error', err);
        } catch {
            // No listener / listener threw; still close the stream.
        }
        this.response.emit('close');
        callback?.(err);
    }

    private fail(err: unknown, callback?: (err?: Error | null) => void): void {
        const error = this.normalize(err);
        if (this.terminal !== 'open') {
            callback?.(error);
            return;
        }
        if (isTransportDisconnectError(error)) {
            this.enterAborted(error);
            callback?.(error);
            return;
        }
        this.enterFailed(error, callback);
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
            // Empty string is not a real phrase — fill from STATUS_CODES like Node.
            if (/[\r\n]/.test(statusMessageOrHeaders)) throw new TypeError('statusMessage must not contain CR/LF');
            this.response.statusMessage = statusMessageOrHeaders || reasonPhrase(statusCode);
            this.normalizeHeadersInput(headers);
        } else {
            this.response.statusMessage = reasonPhrase(statusCode, this.response.statusMessage);
            if (statusMessageOrHeaders !== undefined && statusMessageOrHeaders !== null) {
                this.normalizeHeadersInput(statusMessageOrHeaders);
            } else {
                this.normalizeHeadersInput(headers);
            }
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

        this.enqueue(
            () => this.transport.writeHead(this.response, outHeaders),
            undefined,
            (err) => this.fail(err),
        );

        return this.response;
    }

    flushHeaders(): void {
        if (this.response.headersSent) return;
        this.ensureImplicitHeaders();
        // Pass only statusCode so STATUS_CODES fills an empty statusMessage.
        this.writeHead(this.response.statusCode);
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
            if (!callback) queueMicrotask(() => emitResponseErrorQuietly(this.response, err));
            return false;
        }
        if (!this.response.headersSent) {
            this.ensureImplicitHeaders();
            this.writeHead(this.response.statusCode);
        }

        try {
            const encodeString = encodeStringForEncoding(encoding);
            const data = toUint8Array(chunk, encodeString);
            if (this.shouldSuppressBody()) {
                callback?.();
                return true;
            }
            this.pendingBytes += data.byteLength;
            this.enqueue(
                async () => {
                    try { this.serveHook?.onData?.({ requestId: this.requestId, timestamp: nodeTs(), data }); } catch {}
                    await this.transport.writeBody(this.response, data);
                },
                () => {
                    this.settleWrite(data.byteLength);
                    callback?.();
                },
                (err) => {
                    this.settleWrite(data.byteLength);
                    this.fail(err, callback);
                },
            );
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
            // Only statusCode — empty statusMessage is filled from STATUS_CODES.
            this.writeHead(this.response.statusCode);
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
            this.writeHead(this.response.statusCode);
            chunk = data;
        }

        this.enqueue(
            async () => {
                if (chunk !== undefined && !this.shouldSuppressBody()) {
                    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
                    const encodeString = encodeStringForEncoding(encoding);
                    const data = chunk instanceof Uint8Array ? chunk : toUint8Array(chunk, encodeString);
                    try { this.serveHook?.onData?.({ requestId: this.requestId, timestamp: nodeTs(), data }); } catch {}
                    await this.transport.writeBody(this.response, data);
                }
                await this.transport.finish(this.response);
            },
            () => {
                if (this.terminal !== 'open') {
                    // Peer aborted while finishing — callback still runs; no finish event.
                    callback?.();
                    return;
                }
                this.terminal = 'finished';
                this.response.finished = true;
                this.response.writableFinished = true;
                emitServeFinishedQuietly(this.serveHook, { requestId: this.requestId, timestamp: nodeTs(), success: true });
                this.response.emit('finish');
                callback?.();
            },
            (err) => {
                this.fail(err, callback as ((err?: Error | null) => void) | undefined);
            },
        );

        return this.response;
    }

    abort(err: unknown): void {
        const error = this.normalize(err);
        if (this.terminal !== 'open') return;
        // Peer already gone — tear down now; no bytes left to flush.
        if (isTransportDisconnectError(error)) {
            this.enterAborted(error);
            return;
        }
        // App/protocol fault: finish in-flight writes (e.g. writeHead) first so
        // partial headers reach the client, then destroy the transport.
        this.enqueue(
            async () => {
                if (this.terminal !== 'open') return;
                this.enterFailed(error);
            },
            undefined,
            (queueErr) => {
                if (this.terminal !== 'open') return;
                this.enterFailed(this.normalize(queueErr));
            },
        );
    }
}
