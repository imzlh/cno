/**
 * Web Locks API (navigator.locks)
 * Based on https://wicg.github.io/web-locks/
 */

interface LockRequest {
    name: string;
    mode: 'exclusive' | 'shared';
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    signal?: AbortSignal;
    cb: (lock: Lock) => any;
}

export class Lock {
    readonly name: string;
    readonly mode: 'exclusive' | 'shared';

    constructor(name: string, mode: 'exclusive' | 'shared') {
        this.name = name;
        this.mode = mode;
    }
}

const held = new Map<string, { mode: 'exclusive' | 'shared'; count: number }>();
const queues = new Map<string, LockRequest[]>();

function processQueue(name: string) {
    const queue = queues.get(name);
    if (!queue?.length) {
        held.delete(name);
        return;
    }

    // Skip aborted requests at front
    while (queue.length && queue[0].signal?.aborted) {
        const aborted = queue.shift()!;
        aborted.reject(aborted.signal!.reason ?? new DOMException('Lock request aborted', 'AbortError'));
    }
    if (!queue.length) { held.delete(name); return; }

    const current = held.get(name);
    if (current) {
        if (current.mode === 'shared') {
            // Activate all consecutive shared requests
            while (queue.length && queue[0].mode === 'shared' && !queue[0].signal?.aborted) {
                const req = queue.shift()!;
                current.count++;
                runLock(name, req);
            }
        }
        return;
    }

    // No lock held — activate first request (and any consecutive shared ones)
    const first = queue.shift()!;
    held.set(name, { mode: first.mode, count: 1 });
    runLock(name, first);

    if (first.mode === 'shared') {
        while (queue.length && queue[0].mode === 'shared' && !queue[0].signal?.aborted) {
            const req = queue.shift()!;
            held.get(name)!.count++;
            runLock(name, req);
        }
    }
}

function runLock(name: string, req: LockRequest) {
    const lock = new Lock(name, req.mode);
    let result: any;
    try { result = req.cb(lock); } catch (e) { req.reject(e); release(name); return; }
    if (result && typeof result.then === 'function') {
        result.then(
            (v: any) => { req.resolve(v); release(name); },
            (e: any) => { req.reject(e); release(name); }
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
    async request(name: string, optionsOrCb: any, maybeCb?: any): Promise<any> {
        const options = typeof optionsOrCb === 'function' ? {} : (optionsOrCb ?? {});
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        const mode: 'exclusive' | 'shared' = options.mode ?? 'exclusive';
        const signal: AbortSignal | undefined = options.signal;

        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Lock request aborted', 'AbortError');
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn: 'resolve' | 'reject', value: any) => {
                if (settled) return;
                settled = true;
                if (fn === 'resolve') resolve(value);
                else reject(value);
            };
            const req: LockRequest = { name, mode, resolve: (v) => settle('resolve', v), reject: (e) => settle('reject', e), signal, cb };
            if (signal) {
                signal.addEventListener('abort', () => {
                    const queue = queues.get(name);
                    if (queue) {
                        const idx = queue.indexOf(req);
                        if (idx !== -1) queue.splice(idx, 1);
                    }
                    settle('reject', signal.reason ?? new DOMException('Lock request aborted', 'AbortError'));
                }, { once: true });
            }
            let queue = queues.get(name);
            if (!queue) { queue = []; queues.set(name, queue); }
            queue.push(req);
            processQueue(name);
        });
    }

    async query(): Promise<{ held: any[]; pending: any[] }> {
        const heldList: any[] = [];
        for (const [name, h] of held) {
            heldList.push({ name, mode: h.mode, clientId: '' });
        }
        const pendingList: any[] = [];
        for (const [name, queue] of queues) {
            for (const req of queue) {
                pendingList.push({ name, mode: req.mode, clientId: '' });
            }
        }
        return { held: heldList, pending: pendingList };
    }
}
