/**
 * Scheduling API (scheduler.postTask)
 * Based on https://wicg.github.io/scheduling-apis/
 */

type TaskPriority = 'user-blocking' | 'user-visible' | 'background';
const timers = import.meta.use('timers');
const validPriorities = new Set<TaskPriority>(['user-blocking', 'user-visible', 'background']);

interface PostTaskOptions {
    priority?: TaskPriority;
    signal?: AbortSignal;
    delay?: number;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
    return !!value && typeof value === 'object' && typeof Reflect.get(value, 'then') === 'function';
}

function normalizePriority(priority: unknown, fallback: TaskPriority = 'user-visible'): TaskPriority {
    const value = priority ?? fallback;
    if (!validPriorities.has(value as TaskPriority)) {
        throw new TypeError('Invalid task priority');
    }
    return value as TaskPriority;
}

function normalizeDelay(delay: unknown): number {
    const value = delay ?? 0;
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) {
        throw new TypeError('Invalid task delay');
    }
    return ms;
}

class TaskSignal {
    readonly priority: TaskPriority;
    private _controller: AbortController;
    constructor(priority: TaskPriority = 'user-visible') {
        this.priority = priority;
        this._controller = new AbortController();
    }
    get aborted() { return this._controller.signal.aborted; }
    get reason() { return this._controller.signal.reason; }
    get signal() { return this._controller.signal; }
    addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
        if (!cb) return;
        const signal: EventTarget = this._controller.signal;
        signal.addEventListener(type, cb, opts);
    }
    removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
        if (!cb) return;
        const signal: EventTarget = this._controller.signal;
        signal.removeEventListener(type, cb, opts);
    }
    dispatchEvent(e: Event) { return this._controller.signal.dispatchEvent(e); }
    throwIfAborted(): void { this._controller.signal.throwIfAborted(); }
    abort(reason?: unknown): void { this._controller.abort(reason); }
    get [Symbol.toStringTag]() { return 'TaskSignal'; }
}

class TaskController {
    readonly signal: TaskSignal;
    constructor(init?: { priority?: TaskPriority }) {
        this.signal = new TaskSignal(normalizePriority(init?.priority));
    }
    abort(reason?: unknown) {
        this.signal.abort(reason);
    }
    get [Symbol.toStringTag]() { return 'TaskController'; }
}

const scheduler = {
    postTask<T>(callback: () => T | Promise<T>, options?: PostTaskOptions): Promise<T> {
        if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
        normalizePriority(options?.priority);
        const signal = options?.signal;
        const delay = normalizeDelay(options?.delay);

        if (signal?.aborted) return Promise.reject(signal.reason);

        return new Promise<T>((resolve, reject) => {
            const run = () => {
                if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                }
                try {
                    const result = callback();
                    if (isPromiseLike<T>(result)) result.then(resolve, reject);
                    else resolve(result);
                } catch (e) {
                    reject(e);
                }
            };

            if (delay > 0) {
                const deadline = Date.now() + delay;
                let id: number | null = null;
                const onAbort = () => {
                    if (id !== null) timers.clearTimeout(id);
                    reject(signal?.reason);
                };
                const scheduleRun = () => {
                    const remaining = deadline - Date.now();
                    if (remaining > 0) {
                        id = timers.setTimeout(scheduleRun, Math.max(1, remaining));
                        return;
                    }
                    signal?.removeEventListener?.('abort', onAbort);
                    run();
                };
                signal?.addEventListener('abort', onAbort, { once: true });
                scheduleRun();
            } else {
                queueMicrotask(run);
            }
        });
    },

    yield(): Promise<void> {
        return new Promise(resolve => queueMicrotask(resolve));
    },

    currentTaskSignal: null,
};

Reflect.set(globalThis, 'scheduler', scheduler);
Reflect.set(globalThis, 'TaskController', TaskController);
Reflect.set(globalThis, 'TaskSignal', TaskSignal);

export { scheduler, TaskController, TaskSignal, type TaskPriority };
