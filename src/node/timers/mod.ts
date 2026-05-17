/**
 * Node.js timers module
 * TimersPromises provides promise-based timer APIs
 */

export function setTimeout<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    return globalThis.setTimeout(callback, ms, ...args) as unknown as NodeJS.Timeout;
}

export function setInterval<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    return globalThis.setInterval(callback, ms, ...args) as unknown as NodeJS.Timeout;
}

export function setImmediate<T>(callback: (...args: T[]) => void, ...args: T[]): NodeJS.Immediate {
    return globalThis.setImmediate(callback, ...args) as unknown as NodeJS.Immediate;
}

export function clearTimeout(timeout: NodeJS.Timeout | string | number | undefined): void {
    globalThis.clearTimeout(timeout as any);
}

export function clearInterval(timeout: NodeJS.Timeout | string | number | undefined): void {
    globalThis.clearInterval(timeout as any);
}

export function clearImmediate(immediate: NodeJS.Immediate | undefined): void {
    globalThis.clearImmediate(immediate as any);
}

export const promises = {
    setTimeout(delay?: number, value?: any, options?: { ref?: boolean; signal?: AbortSignal }): Promise<any> {
        const signal = options?.signal;
        if (signal?.aborted) return Promise.reject(signal.reason);

        return new Promise((resolve, reject) => {
            const onAbort = () => { cleanup(); globalThis.clearTimeout(id); reject(signal!.reason); };
            const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
            signal?.addEventListener('abort', onAbort, { once: true });

            const id = globalThis.setTimeout(() => {
                cleanup();
                resolve(value);
            }, delay ?? 0);
        });
    },

    setInterval(delay?: number, value?: any, options?: { ref?: boolean; signal?: AbortSignal }): AsyncIterableIterator<any> {
        return {
            [Symbol.asyncIterator]() { return this; },
            async next() {
                await new Promise(r => globalThis.setTimeout(r, delay ?? 0));
                return { done: false, value };
            },
            async return() { return { done: true, value: undefined }; },
        };
    },

    setImmediate(value?: any, options?: { ref?: boolean; signal?: AbortSignal }): Promise<any> {
        return new Promise(r => globalThis.setImmediate(() => r(value)));
    },
};
