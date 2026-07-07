/**
 * Node.js timers module
 * Timer functions and TimersPromises for promise-based timer APIs
 * Type definitions reference: @types/node/timers.d.ts
 */

const timer = import.meta.use('timers');

type TimerCallback = (...args: unknown[]) => void;

function createAbortError(reason?: unknown): Error & { name: string; code: string; cause?: unknown } {
    const error: Error & { name: string; code: string; cause?: unknown } = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
    });
    if (reason !== undefined) error.cause = reason;
    return error;
}

function assertTimerCallback(callback: unknown): asserts callback is TimerCallback {
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }
}

function assertPromiseDelay(delay: unknown): asserts delay is number | undefined {
    if (delay !== undefined && typeof delay !== 'number') {
        throw new TypeError('The "delay" argument must be of type number');
    }
}

function assertTimerOptions(options: unknown): asserts options is TimerOptions | undefined {
    if (options !== undefined && (typeof options !== 'object' || options === null)) {
        throw new TypeError('The "options" argument must be of type object');
    }
}

function toTimerId(timeout: NodeJS.Timeout | string | number | undefined): number | undefined {
    if (timeout === undefined) return undefined;
    const id = typeof timeout === 'number' ? timeout : Number(timeout);
    return Number.isNaN(id) ? undefined : id;
}

// TimerOptions

export interface TimerOptions {
    ref?: boolean;
    signal?: AbortSignal;
}

// Timeout wrapper

class Timeout implements NodeJS.Timeout {
    #id: number;
    #isInterval: boolean;
    #fn?: TimerCallback;
    #ms?: number;
    #args: unknown[];
    #cleared = false;

    constructor(id: number, isInterval = false, fn?: TimerCallback, ms?: number, args: unknown[] = []) {
        this.#id = id;
        this.#isInterval = isInterval;
        this.#fn = fn;
        this.#ms = ms;
        this.#args = args;
    }

    hasRef(): boolean {
        return timer.hasRef(this.#id);
    }

    ref(): this {
        timer.refTimer(this.#id);
        return this;
    }

    unref(): this {
        timer.unrefTimer(this.#id);
        return this;
    }

    refresh(): this {
        if (this.#cleared) return this;
        if (this.#fn) {
            const clearFn = this.#isInterval ? timer.clearInterval : timer.clearTimeout;
            clearFn(this.#id);
            if (this.#isInterval) {
                this.#id = timer.setInterval(this.#fn, this.#ms, ...this.#args);
            } else {
                this.#id = timer.setTimeout(this.#fn, this.#ms, ...this.#args);
            }
        }
        return this;
    }

    close(): this {
        const clearFn = this.#isInterval ? timer.clearInterval : timer.clearTimeout;
        clearFn(this.#id);
        this.#cleared = true;
        return this;
    }

    [Symbol.toPrimitive](): number {
        return Number(this.#id) || 0;
    }

    [Symbol.dispose](): void {
        const clearFn = this.#isInterval ? timer.clearInterval : timer.clearTimeout;
        clearFn(this.#id);
        this.#cleared = true;
    }

    get _onTimeout(): TimerCallback | null {
        return null;
    }

    get __cno_timer_id(): number {
        return Number(this.#id);
    }
}

// Immediate wrapper

class Immediate implements NodeJS.Immediate {
    #canceled = false;
    #refed = true;

    constructor(private handle: TimerCallback, args: unknown[] = []) {
        queueMicrotask(() => {
            if (this.#canceled) return;
            handle.apply(this, args);
        });
    }

    hasRef(): boolean {
        return this.#refed;
    }

    ref(): this {
        this.#refed = true;
        return this;
    }

    unref(): this {
        this.#refed = false;
        return this;
    }

    [Symbol.dispose](): void {
        this.#canceled = true;
    }

    close(): this {
        this.#canceled = true;
        return this;
    }

    get _onImmediate(): TimerCallback {
        return this.handle;
    }
}

// Timer functions

export function setTimeout<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    assertTimerCallback(callback);
    const delay = ms ?? 1;
    const id = timer.setTimeout(callback, delay, ...args);
    return new Timeout(id, false, callback, delay, args);
}

export function setInterval<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    assertTimerCallback(callback);
    const delay = ms ?? 1;
    const id = timer.setInterval(callback, delay, ...args);
    return new Timeout(id, true, callback, delay, args);
}

export function setImmediate<T>(callback: (...args: T[]) => void, ...args: T[]): NodeJS.Immediate {
    assertTimerCallback(callback);
    return new Immediate(callback, args);
}

export function clearTimeout(timeout: NodeJS.Timeout | string | number | undefined): void {
    if (timeout instanceof Timeout) {
        timeout[Symbol.dispose]();
    } else {
        const id = toTimerId(timeout);
        if (id !== undefined) timer.clearTimeout(id);
    }
}

export function clearInterval(timeout: NodeJS.Timeout | string | number | undefined): void {
    if (timeout instanceof Timeout) {
        timeout[Symbol.dispose]();
    } else {
        const id = toTimerId(timeout);
        if (id !== undefined) timer.clearInterval(id);
    }
}

export function clearImmediate(immediate: NodeJS.Immediate | undefined): void {
    if (immediate) immediate[Symbol.dispose]();
}

// promises namespace

export const promises = {
    setTimeout<T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> {
        assertPromiseDelay(delay);
        assertTimerOptions(options);
        const signal = options?.signal;
        if (signal?.aborted) return Promise.reject(createAbortError(signal.reason));

        return new Promise<T>((resolve, reject) => {
            const onAbort = () => { cleanup(); timer.clearTimeout(id); reject(createAbortError(signal?.reason)); };
            const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
            signal?.addEventListener('abort', onAbort, { once: true });

            const id = timer.setTimeout(() => {
                cleanup();
                resolve(value as T);
            }, delay ?? 1);
        });
    },

    setInterval<T = void>(delay?: number, value?: T, options?: TimerOptions): AsyncIterableIterator<T> {
        assertPromiseDelay(delay);
        assertTimerOptions(options);
        const signal = options?.signal;

        return {
            [Symbol.asyncIterator]() { return this; },
            async next(): Promise<IteratorResult<T>> {
                if (signal?.aborted) return Promise.reject(createAbortError(signal.reason));

                await new Promise<void>((resolve, reject) => {
                    const onAbort = () => { cleanup(); timer.clearTimeout(id); reject(createAbortError(signal?.reason)); };
                    const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
                    signal?.addEventListener('abort', onAbort, { once: true });

                    const id = timer.setTimeout(() => {
                        cleanup();
                        resolve();
                    }, delay ?? 1);
                });

                return { done: false, value: value as T };
            },
            async return(): Promise<IteratorResult<T>> {
                return { done: true, value: undefined };
            },
        };
    },

    setImmediate<T = void>(value?: T, options?: TimerOptions): Promise<T> {
        assertTimerOptions(options);
        const signal = options?.signal;
        if (signal?.aborted) return Promise.reject(createAbortError(signal.reason));

        return new Promise<T>((resolve, reject) => {
            const onAbort = () => { cleanup(); reject(createAbortError(signal?.reason)); };
            const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
            signal?.addEventListener('abort', onAbort, { once: true });

            queueMicrotask(() => {
                cleanup();
                resolve(value as T);
            });
        });
    },

    scheduler: {
        wait(delay: number, options?: { signal?: AbortSignal }): Promise<void> {
            assertPromiseDelay(delay);
            assertTimerOptions(options);
            const signal = options?.signal;
            if (signal?.aborted) return Promise.reject(createAbortError(signal.reason));

            return new Promise<void>((resolve, reject) => {
                const onAbort = () => { cleanup(); timer.clearTimeout(id); reject(createAbortError(signal?.reason)); };
                const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
                signal?.addEventListener('abort', onAbort, { once: true });

                const id = timer.setTimeout(() => {
                    cleanup();
                    resolve();
                }, delay);
            });
        },

        yield(): Promise<void> {
            return new Promise<void>(resolve => queueMicrotask(resolve));
        },
    },
};

Object.defineProperty(setTimeout, Symbol.for('nodejs.util.promisify.custom'), {
    value: promises.setTimeout,
    writable: false,
    enumerable: false,
    configurable: true,
});
