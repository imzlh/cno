/**
 * Web Locks API (navigator.locks)
 * Based on https://wicg.github.io/web-locks/
 */

type LockMode = 'exclusive' | 'shared';
type LockCallback<T> = (lock: Lock | null) => T | PromiseLike<T>;
type LockRequestOptions = { mode?: LockMode; ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal };
type LockQueryEntry = { name: string; mode: LockMode; clientId: string };

interface LockRequest {
    name: string;
    mode: LockMode;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    cb: LockCallback<unknown>;
    /** Detach the abort listener on grant; signals only cancel queued requests. */
    granted?: () => void;
}

export class Lock {
    readonly name: string;
    readonly mode: LockMode;

    constructor(name: string, mode: LockMode) {
        this.name = name;
        this.mode = mode;
    }
}

// Track holder identity so a stolen request cannot release its replacement.
const held = new Map<string, { mode: LockMode; active: Set<LockRequest> }>();
const queues = new Map<string, LockRequest[]>();

function canGrantImmediately(name: string, mode: LockMode): boolean {
    const queue = queues.get(name);
    if (queue?.length) return false;
    const current = held.get(name);
    if (!current) return true;
    return current.mode === 'shared' && mode === 'shared';
}

function runCallbackWithoutLock<T>(cb: (lock: null) => T | PromiseLike<T>): Promise<T> {
    try {
        return Promise.resolve(cb(null));
    } catch (error) {
        return Promise.reject(error);
    }
}

function deleteEmptyQueue(name: string, queue?: LockRequest[]): void {
    if (!queue || queue.length === 0) queues.delete(name);
}

function processQueue(name: string) {
    const queue = queues.get(name);
    if (!queue?.length) {
        deleteEmptyQueue(name, queue);
        return;
    }

    // Skip aborted requests at front
    while (queue.length && queue[0].signal?.aborted) {
        const aborted = queue.shift();
        if (!aborted) break;
        aborted.reject(aborted.signal?.reason ?? new DOMException('Lock request aborted', 'AbortError'));
    }
    if (!queue.length) {
        deleteEmptyQueue(name, queue);
        return;
    }

    const current = held.get(name);
    if (current) {
        if (current.mode === 'shared') {
            // Activate all consecutive shared requests
            while (queue.length && queue[0].mode === 'shared' && !queue[0].signal?.aborted) {
                const req = queue.shift();
                if (!req) break;
                current.active.add(req);
                runLock(name, req);
            }
        }
        return;
    }

    // No lock held — activate first request (and any consecutive shared ones)
    const first = queue.shift();
    if (!first) {
        held.delete(name);
        return;
    }
    held.set(name, { mode: first.mode, active: new Set([first]) });
    runLock(name, first);

    if (first.mode === 'shared') {
        while (queue.length && queue[0].mode === 'shared' && !queue[0].signal?.aborted) {
            const req = queue.shift();
            if (!req) break;
            const current = held.get(name);
            if (!current) break;
            current.active.add(req);
            runLock(name, req);
        }
    }
}

async function runLock(name: string, req: LockRequest): Promise<void> {
    req.granted?.();
    try {
        req.resolve(await req.cb(new Lock(name, req.mode)));
    } catch (error) {
        req.reject(error);
    } finally {
        release(name, req);
    }
}

function release(name: string, req: LockRequest) {
    const h = held.get(name);
    // A stolen request may finish after a new holder acquires the lock.
    if (!h || !h.active.has(req)) return;
    h.active.delete(req);
    if (h.active.size === 0) held.delete(name);
    processQueue(name);
}

/** Reject current holders while their callbacks continue running. */
function breakLock(name: string) {
    const h = held.get(name);
    if (!h) return;
    const victims = [...h.active];
    h.active.clear();
    held.delete(name);
    for (const victim of victims) {
        victim.reject(new DOMException('The lock was broken', 'AbortError'));
    }
}

export class LockManager {
    async request<T>(name: string, optionsOrCb: LockRequestOptions | LockCallback<T | null>, maybeCb?: LockCallback<T | null>): Promise<T | null> {
        const options: LockRequestOptions = typeof optionsOrCb === 'function' ? {} : (optionsOrCb ?? {});
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        if (!cb) throw new TypeError('Lock request callback is required');
        const mode: LockMode = options.mode ?? 'exclusive';
        const signal: AbortSignal | undefined = options.signal;
        if (mode !== 'exclusive' && mode !== 'shared') throw new TypeError('Invalid lock mode');
        // Keep the established TypeError for this conflicting option pair.
        if (options.ifAvailable && options.steal) throw new TypeError('ifAvailable and steal cannot both be true');
        if (options.steal && mode !== 'exclusive') {
            throw new DOMException("'mode' must be 'exclusive' if 'steal' is specified", 'NotSupportedError');
        }
        if (options.steal && signal) {
            throw new DOMException("'signal' cannot be provided with 'steal' or 'ifAvailable'", 'NotSupportedError');
        }

        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Lock request aborted', 'AbortError');
        }

        name = String(name);

        if (options.ifAvailable && !canGrantImmediately(name, mode)) {
            return await runCallbackWithoutLock(cb as (lock: null) => T | PromiseLike<T>);
        }

        if (options.steal) breakLock(name);

        // Attach rejection handling before a synchronous callback can fail.
        return await new Promise<T>((resolve, reject) => {
            let settled = false;
            let onAbort: (() => void) | undefined;
            const cleanup = () => {
                if (onAbort) signal?.removeEventListener('abort', onAbort);
                onAbort = undefined;
            };
            const settle = (fn: 'resolve' | 'reject', value: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (fn === 'resolve') resolve(value as T);
                else reject(value);
            };
            const req: LockRequest = {
                name,
                mode,
                resolve: (v) => settle('resolve', v),
                reject: (e) => settle('reject', e),
                signal,
                cb,
                granted: cleanup,
            };
            if (signal) {
                onAbort = () => {
                    const queue = queues.get(name);
                    if (queue) {
                        const idx = queue.indexOf(req);
                        if (idx !== -1) queue.splice(idx, 1);
                        deleteEmptyQueue(name, queue);
                    }
                    settle('reject', signal.reason ?? new DOMException('Lock request aborted', 'AbortError'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }
            let queue = queues.get(name);
            if (!queue) {
                queue = [];
                queues.set(name, queue);
            }
            // A stolen lock is granted ahead of pending requests.
            if (options.steal) queue.unshift(req);
            else queue.push(req);
            processQueue(name);
        });
    }

    async query(): Promise<{ held: LockQueryEntry[]; pending: LockQueryEntry[] }> {
        const heldList: LockQueryEntry[] = [];
        for (const [name, h] of held) {
            heldList.push({ name, mode: h.mode, clientId: '' });
        }
        const pendingList: LockQueryEntry[] = [];
        for (const [name, queue] of queues) {
            for (const req of queue) {
                pendingList.push({ name, mode: req.mode, clientId: '' });
            }
        }
        return { held: heldList, pending: pendingList };
    }
}
