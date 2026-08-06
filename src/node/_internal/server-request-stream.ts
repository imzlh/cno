type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export interface IncomingRequestStreamTarget {
    complete: boolean;
    aborted: boolean;
    errored?: unknown;
    push(chunk: Uint8Array | null): boolean;
    destroy(error?: Error): unknown;
    emit?(event: string, ...args: unknown[]): boolean;
    listenerCount?(event: string): number;
}

type BodyReader = (() => Promise<Uint8Array | null>) | null | undefined;

export function pushIncomingRequestChunk(target: IncomingRequestStreamTarget, chunk: Uint8Array): void {
    target.push(chunk);
}

export function completeIncomingRequest(target: IncomingRequestStreamTarget): void {
    target.complete = true;
    target.push(null);
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
 * This must therefore NOT call completeIncomingRequest(): doing so set
 * `complete = true` and pushed null, which fired 'end' and made a truncated upload
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
export function failIncomingRequest(target: IncomingRequestStreamTarget, err: unknown): void {
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
        completeIncomingRequest(target);
        return;
    }

    (async () => {
        try {
            while (true) {
                const chunk = await body();
                if (chunk === null) break;
                pushIncomingRequestChunk(target, chunk);
            }
            completeIncomingRequest(target);
        } catch (err) {
            failIncomingRequest(target, err);
        }
    })().catch(() => {});
}
