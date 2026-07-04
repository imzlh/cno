/**
 * Scheduling API (scheduler.postTask)
 * Based on https://wicg.github.io/scheduling-apis/
 */

type TaskPriority = 'user-blocking' | 'user-visible' | 'background';
const { setTimeout, clearTimeout } = import.meta.use('timers');

interface PostTaskOptions {
    priority?: TaskPriority;
    signal?: AbortSignal;
    delay?: number;
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
    addEventListener(type: string, cb: any, opts?: any) { this._controller.signal.addEventListener(type, cb, opts); }
    removeEventListener(type: string, cb: any, opts?: any) { this._controller.signal.removeEventListener(type, cb, opts); }
    dispatchEvent(e: Event) { return this._controller.signal.dispatchEvent(e); }
}

class TaskController {
    readonly signal: TaskSignal;
    constructor(init?: { priority?: TaskPriority }) {
        this.signal = new TaskSignal(init?.priority ?? 'user-visible');
    }
    abort(reason?: any) {
        (this.signal as any)._controller.abort(reason);
    }
}

const priorities: Record<TaskPriority, number> = {
    'user-blocking': 0,
    'user-visible': 1,
    'background': 2,
};

const scheduler = {
    postTask<T>(callback: () => T | Promise<T>, options?: PostTaskOptions): Promise<T> {
        const signal = options?.signal;
        const delay = options?.delay ?? 0;

        if (signal?.aborted) return Promise.reject(signal.reason);

        return new Promise<T>((resolve, reject) => {
            const run = () => {
                if (signal?.aborted) { reject(signal.reason); return; }
                try {
                    const result = callback();
                    if (result && typeof (result as any).then === 'function') {
                        (result as Promise<T>).then(resolve, reject);
                    } else {
                        resolve(result);
                    }
                } catch (e) { reject(e); }
            };

            if (delay > 0) {
                const id = setTimeout(run, delay);
                signal?.addEventListener('abort', () => { clearTimeout(id); reject(signal.reason); }, { once: true });
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

export { scheduler, TaskController, TaskSignal, type TaskPriority };
