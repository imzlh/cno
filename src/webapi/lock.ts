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
}

export class Lock {
    readonly name: string;
    readonly mode: LockMode;

    constructor(name: string, mode: LockMode) {
        this.name = name;
        this.mode = mode;
    }
}

const held = new Map<string, { mode: LockMode; count: number }>();
const queues = new Map<string, LockRequest[]>();

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
    return !!value && typeof value === 'object' && typeof Reflect.get(value, 'then') === 'function';
}

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

function processQueue(name: string) {
    const queue = queues.get(name);
    if (!queue?.length) {
        held.delete(name);
        return;
    }

    // Skip aborted requests at front
    while (queue.length && queue[0].signal?.aborted) {
        const aborted = queue.shift();
        if (!aborted) break;
        aborted.reject(aborted.signal?.reason ?? new DOMException('Lock request aborted', 'AbortError'));
    }
    if (!queue.length) {
        held.delete(name);
        return;
    }

    const current = held.get(name);
    if (current) {
        if (current.mode === 'shared') {
            // Activate all consecutive shared requests
            while (queue.length && queue[0].mode === 'shared' && !queue[0].signal?.aborted) {
                const req = queue.shift();
                if (!req) break;
                current.count++;
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
    held.set(name, { mode: first.mode, count: 1 });
    runLock(name, first);

    if (first.mode === 'shared') {
        while (queue.length && queue[0].mode === 'shared' && !queue[0].signal?.aborted) {
            const req = queue.shift();
            if (!req) break;
            const current = held.get(name);
            if (!current) break;
            current.count++;
            runLock(name, req);
        }
    }
}

function runLock(name: string, req: LockRequest) {
    const lock = new Lock(name, req.mode);
    let result: unknown;
    try {
        result = req.cb(lock);
    } catch (e) {
        req.reject(e);
        release(name);
        return;
    }
    if (isPromiseLike<unknown>(result)) {
        result.then(
            (v) => { req.resolve(v); release(name); },
            (e) => { req.reject(e); release(name); },
        );
    } else {
        req.resolve(result);
        release(name);
    }
}

function release(name: string) {
    const h = held.get(name);
    if (!h) return;
    if (h.count > 1) {
        h.count--;
    } else {
        held.delete(name);
    }
    processQueue(name);
}

export class LockManager {
    async request<T>(name: string, optionsOrCb: LockRequestOptions | LockCallback<T | null>, maybeCb?: LockCallback<T | null>): Promise<T | null> {
        const options: LockRequestOptions = typeof optionsOrCb === 'function' ? {} : (optionsOrCb ?? {});
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        if (!cb) throw new TypeError('Lock request callback is required');
        const mode: LockMode = options.mode ?? 'exclusive';
        const signal: AbortSignal | undefined = options.signal;
        if (mode !== 'exclusive' && mode !== 'shared') throw new TypeError('Invalid lock mode');
        if (options.ifAvailable && options.steal) throw new TypeError('ifAvailable and steal cannot both be true');

        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Lock request aborted', 'AbortError');
        }

        if (options.ifAvailable && !canGrantImmediately(String(name), mode)) {
            return await runCallbackWithoutLock(cb as (lock: null) => T | PromiseLike<T>);
        }

        name = String(name);
        return new Promise((resolve, reject) => {
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
            const req: LockRequest = { name, mode, resolve: (v) => settle('resolve', v), reject: (e) => settle('reject', e), signal, cb };
            if (signal) {
                onAbort = () => {
                    const queue = queues.get(name);
                    if (queue) {
                        const idx = queue.indexOf(req);
                        if (idx !== -1) queue.splice(idx, 1);
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
            queue.push(req);
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
