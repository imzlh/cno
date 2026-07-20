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
    #id = 0;
    #isInterval: boolean;
    #fn: TimerCallback;
    #ms: number;
    #args: unknown[];
    #cleared = false;
    #active = false;
    #refed = true;

    constructor(isInterval: boolean, fn: TimerCallback, ms: number, args: unknown[] = []) {
        this.#isInterval = isInterval;
        this.#fn = fn;
        this.#ms = ms;
        this.#args = args;
        this.#schedule();
    }

    #schedule(): void {
        const callback = () => {
            if (!this.#isInterval) this.#active = false;
            this.#fn.apply(this, this.#args);
        };
        this.#id = this.#isInterval
            ? timer.setInterval(callback, this.#ms)
            : timer.setTimeout(callback, this.#ms);
        this.#active = true;
        if (!this.#refed) timer.unrefTimer(this.#id);
    }

    hasRef(): boolean {
        return this.#refed;
    }

    ref(): this {
        this.#refed = true;
        if (this.#active) timer.refTimer(this.#id);
        return this;
    }

    unref(): this {
        this.#refed = false;
        if (this.#active) timer.unrefTimer(this.#id);
        return this;
    }

    refresh(): this {
        if (this.#cleared) return this;
        if (this.#active) {
            const clearFn = this.#isInterval ? timer.clearInterval : timer.clearTimeout;
            clearFn(this.#id);
        }
        this.#schedule();
        return this;
    }

    close(): this {
        if (this.#active) {
            const clearFn = this.#isInterval ? timer.clearInterval : timer.clearTimeout;
            clearFn(this.#id);
            this.#active = false;
        }
        this.#cleared = true;
        return this;
    }

    [Symbol.toPrimitive](): number {
        return Number(this.#id) || 0;
    }

    [Symbol.dispose](): void {
        this.close();
    }

    get _onTimeout(): TimerCallback | null {
        return this.#cleared ? null : this.#fn;
    }

    get __cno_timer_id(): number {
        return Number(this.#id);
    }
}

// Immediate wrapper

class Immediate implements NodeJS.Immediate {
    #id: number;
    #active = true;
    #refed = true;

    constructor(private handle: TimerCallback, args: unknown[] = []) {
        this.#id = timer.setTimeout(() => {
            if (!this.#active) return;
            this.#active = false;
            this.#refed = false;
            handle.apply(this, args);
        }, 0);
    }

    hasRef(): boolean {
        return this.#active && this.#refed;
    }

    ref(): this {
        if (!this.#active) return this;
        this.#refed = true;
        timer.refTimer(this.#id);
        return this;
    }

    unref(): this {
        if (!this.#active) return this;
        this.#refed = false;
        timer.unrefTimer(this.#id);
        return this;
    }

    [Symbol.dispose](): void {
        this.close();
    }

    close(): this {
        if (this.#active) timer.clearTimeout(this.#id);
        this.#active = false;
        this.#refed = false;
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
    return new Timeout(false, callback, delay, args);
}

export function setInterval<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    assertTimerCallback(callback);
    const delay = ms ?? 1;
    return new Timeout(true, callback, delay, args);
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
            if (options?.ref === false) timer.unrefTimer(id);
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
                    if (options?.ref === false) timer.unrefTimer(id);
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
            const onAbort = () => { cleanup(); timer.clearTimeout(id); reject(createAbortError(signal?.reason)); };
            const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
            signal?.addEventListener('abort', onAbort, { once: true });

            const id = timer.setTimeout(() => {
                cleanup();
                resolve(value as T);
            }, 0);
            if (options?.ref === false) timer.unrefTimer(id);
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
                if (Reflect.get(options ?? {}, 'ref') === false) timer.unrefTimer(id);
            });
        },

        yield(): Promise<void> {
            return promises.setImmediate();
        },
    },
};

Object.defineProperty(setTimeout, Symbol.for('nodejs.util.promisify.custom'), {
    value: promises.setTimeout,
    writable: false,
    enumerable: false,
    configurable: true,
});
