type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export interface IncomingRequestStreamTarget {
    complete: boolean;
    aborted: boolean;
    push(chunk: Uint8Array | null): boolean;
    destroy(error?: Error): unknown;
}

type BodyReader = (() => Promise<Uint8Array | null>) | null | undefined;

export function pushIncomingRequestChunk(target: IncomingRequestStreamTarget, chunk: Uint8Array): void {
    target.push(chunk);
}

export function completeIncomingRequest(target: IncomingRequestStreamTarget): void {
    target.complete = true;
    target.push(null);
}

export function failIncomingRequest(target: IncomingRequestStreamTarget, err: unknown): void {
    target.aborted = true;
    target.destroy(err instanceof Error ? err : new Error(String(err)));
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
