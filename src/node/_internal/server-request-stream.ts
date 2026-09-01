type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

interface IncomingRequestStreamTarget {
    complete: boolean;
    aborted: boolean;
    errored?: unknown;
    push(chunk: Uint8Array | null): boolean;
    destroy(error?: Error): unknown;
    emit?(event: string, ...args: unknown[]): boolean;
    listenerCount?(event: string): number;
}

export interface IncomingMessageTarget extends IncomingRequestStreamTarget {
    httpVersion: string;
    httpVersionMajor: number;
    httpVersionMinor: number;
    headers: Record<string, string | string[] | undefined>;
    headersDistinct: Record<string, string[] | undefined>;
    rawHeaders: string[];
    trailers: Record<string, string | undefined>;
    trailersDistinct: Record<string, string[] | undefined>;
    rawTrailers: string[];
    statusCode?: number;
    statusMessage?: string;
}

export interface IncomingRequestTarget extends IncomingMessageTarget {
    method?: string;
    url?: string;
}

type BodyReader = (() => Promise<Uint8Array | null>) | null | undefined;

export function appendIncomingHeader(target: IncomingRequestTarget, key: string, value: string): void {
    const lowerKey = key.toLowerCase();
    target.headers[lowerKey] = value;
    target.rawHeaders.push(key, value);
    (target.headersDistinct[lowerKey] ??= []).push(value);
}

/**
 * The body stopped short of what its framing promised.
 *
 * `body()` only rejects when the protocol layer established real truncation —
 * H1's failBody() resolves null for a disconnect that arrived *after* the declared
 * length, and rejects ECONNRESET only when bodyRead < contentLength or a chunked
 * body never saw its 0-chunk (h1.ts bodyIncomplete). So a rejection here is a
 * fault, never a normal end-of-stream.
 *
 * This must therefore NOT mark the request complete or push null: doing so fired
 * 'end' and made a truncated upload
 * observationally identical to a whole one. A handler that commits on 'end' then
 * stored a partial payload with no error anywhere. Measured against Node v24.18.0:
 * a peer sending 400 of a declared 1000 bytes yields no 'end', `complete === false`,
 * `aborted === true`, `readableEnded === false`, and `errored` set.
 *
 * 'error' is emitted only when a listener exists. That is Node's own rule
 * (_http_incoming onError: "an error is emitted only if there are listeners
 * attached"), and it is load-bearing here — this stream's destroy() emits 'error'
 * unconditionally, so a handler that never attached one would take an unhandled
 * 'error' for a peer disconnect it cannot control.
 */
function failIncomingRequest(target: IncomingRequestStreamTarget, err: unknown): void {
    target.aborted = true;
    const error = err instanceof Error ? err : new Error(String(err));
    // Node sets `errored` whether or not anyone listens, so a handler can check it
    // from 'close' — the only event guaranteed to fire in this path.
    if (target.errored === undefined || target.errored === null) target.errored = error;
    // Node's IncomingMessage._destroy emits 'aborted' whenever the message is torn
    // down before completing. It is the documented signal for exactly this case.
    if (!target.complete) {
        try { target.emit?.('aborted'); } catch { /* listener threw; teardown continues */ }
    }
    const hasErrorListener = (target.listenerCount?.('error') ?? 0) > 0;
    try {
        if (hasErrorListener) target.destroy(error);
        else target.destroy();
    } catch { /* already destroyed */ }
}

export function pumpIncomingRequestBody(target: IncomingRequestStreamTarget, body: BodyReader): void {
    if (typeof body !== 'function') {
        target.complete = true;
        target.push(null);
        return;
    }

    (async () => {
        try {
            while (true) {
                const chunk = await body();
                if (chunk === null) break;
                target.push(chunk);
            }
            target.complete = true;
            target.push(null);
        } catch (err) {
            failIncomingRequest(target, err);
        }
    })().catch(() => {});
}
