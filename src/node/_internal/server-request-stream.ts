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

interface RequestBodyPumpTarget extends IncomingRequestStreamTarget {
    destroyed: boolean;
    _read(size: number): void;
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
    socket?: {
        once(event: 'close', listener: () => void): unknown;
        off(event: 'close', listener: () => void): unknown;
        destroy(): unknown;
    } | null;
}

export function appendIncomingHeader(target: IncomingRequestTarget, key: string, value: string): void {
    const lowerKey = key.toLowerCase();
    target.headers[lowerKey] = value;
    target.rawHeaders.push(key, value);
    (target.headersDistinct[lowerKey] ??= []).push(value);
}

/**
 * The body stopped short of what its framing promised. Must not look like a
 * clean end; see node-internals.md "Incoming body truncation".
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

export function pumpIncomingRequestBody(target: RequestBodyPumpTarget, body: BodyReader): void {
    if (typeof body !== 'function') {
        target.complete = true;
        target.push(null);
        return;
    }

    const socket = target.socket;
    const previousRead = target._read;
    let stopped = false;
    let running = false;
    let requested = false;
    const cleanup = () => {
        stopped = true;
        if (target._read === onRead) target._read = previousRead;
        target.off('close', onTargetClose);
        socket?.off('close', onSocketClose);
    };
    const onTargetClose = () => {
        cleanup();
        // A destroyed reader cannot release the protocol's body backpressure.
        if (!target.complete) socket?.destroy();
    };
    const onSocketClose = () => {
        cleanup();
        if (!target.complete && !target.destroyed) {
            failIncomingRequest(target, Object.assign(new Error('socket closed before request completed'), {
                code: 'ECONNRESET',
            }));
        }
    };
    const pump = async () => {
        if (running || stopped || target.destroyed) return;
        running = true;
        try {
            while (!stopped && !target.destroyed) {
                requested = false;
                const chunk = await body();
                if (stopped || target.destroyed) return;
                if (chunk === null) {
                    target.complete = true;
                    cleanup();
                    target.push(null);
                    return;
                }
                // Keep unread bytes in the bounded protocol queue until _read
                // asks for more, instead of growing IncomingMessage indefinitely.
                if (!target.push(chunk) && !requested) return;
            }
        } catch (err) {
            if (!stopped) {
                cleanup();
                failIncomingRequest(target, err);
            }
        } finally {
            running = false;
        }
    };
    const onRead = () => {
        requested = true;
        void pump();
    };
    target._read = onRead;
    target.once('close', onTargetClose);
    socket?.once('close', onSocketClose);
    void pump();
}
