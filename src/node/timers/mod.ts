/**
 * Node.js timers module
 * Timer functions and TimersPromises for promise-based timer APIs
 * Type definitions reference: @types/node/timers.d.ts
 */

const timer = import.meta.use('timers');

// ============================================================================
// TimerOptions
// ============================================================================

export interface TimerOptions {
    ref?: boolean;
    signal?: AbortSignal;
}

// ============================================================================
// Timeout wrapper
// ============================================================================

class Timeout implements NodeJS.Timeout {
    #id: any;
    #refed = true;
    #isInterval: boolean;
    #fn?: Function;
    #ms?: number;
    #args?: any[];

    constructor(id: any, isInterval = false, fn?: Function, ms?: number, args?: any[]) {
        this.#id = id;
        this.#isInterval = isInterval;
        this.#fn = fn;
        this.#ms = ms;
        this.#args = args;
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

    refresh(): this {
        if (this.#fn) {
            const clearFn = this.#isInterval ? timer.clearInterval : timer.clearTimeout;
            clearFn(this.#id);
            const setFn = this.#isInterval ? timer.setInterval : timer.setTimeout;
            this.#id = setFn(this.#fn, this.#ms, ...(this.#args ?? []));
        }
        return this;
    }

    close(): this {
        const clearFn = this.#isInterval ? timer.clearInterval : timer.clearTimeout;
        clearFn(this.#id);
        return this;
    }

    [Symbol.toPrimitive](): number {
        return Number(this.#id) || 0;
    }

    [Symbol.dispose](): void {
        const clearFn = this.#isInterval ? timer.clearInterval : timer.clearTimeout;
        clearFn(this.#id);
    }

    get _onTimeout(): any {
        return null;
    }
}

// ============================================================================
// Immediate wrapper
// ============================================================================

class Immediate implements NodeJS.Immediate {
    #canceled = false;

    constructor(private handle: Function, args: any[] = []) {
        queueMicrotask(() => {
            if (this.#canceled) return;
            handle.apply(this, args);
        });
    }

    hasRef(): boolean {
        return false;
    }

    ref(): this {
        return this;
    }

    unref(): this {
        return this;
    }

    [Symbol.dispose](): void {
        this.#canceled = true;
    }

    close(): this {
        this.#canceled = true;
        return this;
    }

    get _onImmediate(): any {
        return this.handle;
    }
}

// ============================================================================
// Timer functions
// ============================================================================

export function setTimeout<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    const delay = ms ?? 1;
    const id = timer.setTimeout(callback, delay, ...args);
    return new Timeout(id, false, callback, delay, args);
}

export function setInterval<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    const delay = ms ?? 1;
    const id = timer.setInterval(callback, delay, ...args);
    return new Timeout(id, true, callback, delay, args);
}

export function setImmediate<T>(callback: (...args: T[]) => void, ...args: T[]): NodeJS.Immediate {
    return new Immediate(callback, args);
}

export function clearTimeout(timeout: NodeJS.Timeout | string | number | undefined): void {
    if (timeout instanceof Timeout) {
        timeout[Symbol.dispose]();
    } else {
        timer.clearTimeout(timeout as any);
    }
}

export function clearInterval(timeout: NodeJS.Timeout | string | number | undefined): void {
    if (timeout instanceof Timeout) {
        timeout[Symbol.dispose]();
    } else {
        timer.clearInterval(timeout as any);
    }
}

export function clearImmediate(immediate: NodeJS.Immediate | undefined): void {
    if (immediate) immediate[Symbol.dispose]();
}

// ============================================================================
// promises namespace
// ============================================================================

export const promises = {
    setTimeout<T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> {
        const signal = options?.signal;
        if (signal?.aborted) return Promise.reject(signal.reason);

        return new Promise<T>((resolve, reject) => {
            const onAbort = () => { cleanup(); timer.clearTimeout(id); reject(signal!.reason); };
            const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
            signal?.addEventListener('abort', onAbort, { once: true });

            const id = timer.setTimeout(() => {
                cleanup();
                resolve(value as T);
            }, delay ?? 1);
        });
    },

    setInterval<T = void>(delay?: number, value?: T, options?: TimerOptions): AsyncIterableIterator<T> {
        const signal = options?.signal;

        return {
            [Symbol.asyncIterator]() { return this; },
            async next(): Promise<IteratorResult<T>> {
                if (signal?.aborted) return Promise.reject(signal.reason);

                await new Promise<void>((resolve, reject) => {
                    const onAbort = () => { cleanup(); timer.clearTimeout(id); reject(signal!.reason); };
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
                return { done: true, value: undefined as any };
            },
        };
    },

    setImmediate<T = void>(value?: T, options?: TimerOptions): Promise<T> {
        const signal = options?.signal;
        if (signal?.aborted) return Promise.reject(signal.reason);

        return new Promise<T>((resolve, reject) => {
            const onAbort = () => { cleanup(); reject(signal!.reason); };
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
            const signal = options?.signal;
            if (signal?.aborted) return Promise.reject(signal.reason);

            return new Promise<void>((resolve, reject) => {
                const onAbort = () => { cleanup(); timer.clearTimeout(id); reject(signal!.reason); };
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
