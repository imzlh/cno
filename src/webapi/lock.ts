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
    /**
     * Detaches the `abort` listener. Called the moment the request is granted:
     * per spec the signal only aborts a request that is still *queued*; once
     * the lock is held, abort() is ignored and the callback's result stands.
     * OBSERVED Deno 2.9.3: aborting during the callback resolves with the
     * callback's return value.
     */
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

/**
 * Currently-granted locks, keyed by name. `active` holds the granted requests
 * themselves (not just a count) so that `steal` can reject their promises and
 * so that a release can be matched to the request that is finishing — a stolen
 * holder must not release the thief's lock when its callback finally settles.
 */
const held = new Map<string, { mode: LockMode; active: Set<LockRequest> }>();
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

function runLock(name: string, req: LockRequest) {
    // Granted: the signal can no longer abort this request (spec), so drop the
    // listener before the callback runs — a callback that aborts its own signal
    // must still see its return value reach the caller.
    req.granted?.();
    const lock = new Lock(name, req.mode);
    let result: unknown;
    try {
        result = req.cb(lock);
    } catch (e) {
        req.reject(e);
        release(name, req);
        return;
    }
    if (isPromiseLike<unknown>(result)) {
        result.then(
            (v) => { req.resolve(v); release(name, req); },
            (e) => { req.reject(e); release(name, req); },
        );
    } else {
        req.resolve(result);
        release(name, req);
    }
}

function release(name: string, req: LockRequest) {
    const h = held.get(name);
    // Not the current holder — e.g. this request was stolen out from under us
    // and its callback has only now settled. Releasing here would hand the
    // thief's lock away, so do nothing.
    if (!h || !h.active.has(req)) return;
    h.active.delete(req);
    if (h.active.size === 0) held.delete(name);
    processQueue(name);
}

/**
 * `steal: true` — break every lock currently held under `name` and reject each
 * holder. OBSERVED Deno 2.9.3: the victim rejects with
 * `AbortError: The lock was broken`, its callback keeps running to completion,
 * and the thief jumps ahead of anything already queued.
 */
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
        // NOTE: spec + Deno throw NotSupportedError here, but
        // tests/webapi/locks-broadcast.test.ts pins TypeError for this pair, so
        // the pre-existing type is kept. The two checks below are new and follow
        // Deno's NotSupportedError.
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

        // `return await` is load-bearing, not a style choice. `processQueue`
        // below can run the callback synchronously, so this promise may already
        // be REJECTED by the time the executor returns. Handing an
        // already-rejected promise back with a bare `return` makes the async
        // function adopt it via a *later* job, while the runtime's
        // unhandled-rejection probe is already queued — so a rejection the
        // caller does handle gets reported as unhandled (fires both
        // `unhandledrejection` and `process.on('unhandledRejection')`).
        // `await` attaches the reaction synchronously, in this same turn, so the
        // promise is marked handled before that probe runs. The caller still
        // rejects with the original error.
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
            // A thief jumps the queue: it must be granted immediately rather
            // than waiting behind requests that were already pending (OBSERVED
            // Deno 2.9.3: order is thief, then the earlier waiter).
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
