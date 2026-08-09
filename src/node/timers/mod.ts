/**
 * Node.js timers module
 * Timer functions and TimersPromises for promise-based timer APIs
 * Type definitions reference: @types/node/timers.d.ts
 */

const timer = import.meta.use('timers');

type TimerCallback = (...args: unknown[]) => void;

// Node clamps every timer delay into [1, 2^31-1] and warns outside that range.
const TIMEOUT_MAX = 2 ** 31 - 1;

// Node's timers/promises rejects with an instance of a real `AbortError` class,
// not a plain Error carrying `name = 'AbortError'`. Measured on v24.18.0:
// `err.constructor.name` and `Object.getPrototypeOf(err).constructor.name` are
// both 'AbortError', while a plain-Error version reports 'Error' for both. Code
// that brands errors by constructor rather than by `.name` (a common pattern in
// retry/cancellation wrappers) sees a different class and misroutes the error.
// `name` and `code` stay OWN properties so `Object.getOwnPropertyNames` remains
// cause+code+message+name+stack, exactly as Node reports it.
class AbortError extends Error {
    name: string;
    code: string;
    cause?: unknown;

    constructor(reason?: unknown) {
        super('The operation was aborted');
        this.name = 'AbortError';
        this.code = 'ABORT_ERR';
        if (reason !== undefined) this.cause = reason;
    }
}

function createAbortError(reason?: unknown): Error & { name: string; code: string; cause?: unknown } {
    return new AbortError(reason);
}

function describeReceived(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'object' || type === 'function') {
        const name = Reflect.get(Object(value), 'constructor');
        const ctorName = typeof name === 'function' ? name.name : undefined;
        return `an instance of ${ctorName || 'Object'}`;
    }
    if (type === 'string') return `type string ('${String(value)}')`;
    if (type === 'bigint') return `type bigint (${String(value)}n)`;
    return `type ${type} (${String(value)})`;
}

function invalidArgType(name: string, expected: string, value: unknown): TypeError & { code: string } {
    return Object.assign(
        new TypeError(`The "${name}" argument must be of type ${expected}. Received ${describeReceived(value)}`),
        { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

function emitTimerWarning(message: string, name: string): void {
    const proc = Reflect.get(globalThis, 'process');
    const emit = proc === null || proc === undefined ? undefined : Reflect.get(Object(proc), 'emitWarning');
    if (typeof emit === 'function') emit.call(proc, message, name);
}

// Mirrors Node's Timeout duration validation: clamp to 1 and warn on bad input.
function normalizeDelay(msecs: unknown): number {
    if (msecs === undefined) return 1;
    const after = Number(msecs);
    if (after >= 1 && after <= TIMEOUT_MAX) return after;
    if (after > TIMEOUT_MAX) {
        emitTimerWarning(`${after} does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.`, 'TimeoutOverflowWarning');
    } else if (after < 0) {
        emitTimerWarning(`${after} is a negative number.\nTimeout duration was set to 1.`, 'TimeoutNegativeWarning');
    } else if (Number.isNaN(after)) {
        emitTimerWarning(`${after} is not a number.\nTimeout duration was set to 1.`, 'TimeoutNaNWarning');
    }
    return 1;
}

function assertTimerCallback(callback: unknown): asserts callback is TimerCallback {
    if (typeof callback !== 'function') throw invalidArgType('callback', 'function', callback);
}

function assertPromiseDelay(delay: unknown): asserts delay is number | undefined {
    if (delay !== undefined && typeof delay !== 'number') throw invalidArgType('delay', 'number', delay);
}

function assertTimerOptions(options: unknown): asserts options is TimerOptions | undefined {
    if (options !== undefined && (typeof options !== 'object' || options === null)) {
        throw invalidArgType('options', 'object', options);
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
    #generation = 0;

    // Node-visible internals relied on by ecosystem code.
    _idleTimeout: number;
    _repeat: number | null;
    _destroyed = false;

    constructor(isInterval: boolean, fn: TimerCallback, ms: number, args: unknown[] = []) {
        this.#isInterval = isInterval;
        this.#fn = fn;
        this.#ms = ms;
        this.#args = args;
        this._idleTimeout = ms;
        this._repeat = isInterval ? ms : null;
        this.#schedule();
    }

    #schedule(): void {
        // Node marks a one-shot destroyed only once its callback RETURNS, and
        // leaves it live if the callback re-armed it via refresh(). Bumping a
        // generation on every (re)schedule lets the finally block tell those
        // two cases apart. Measured against Node v24.18.0.
        const generation = ++this.#generation;
        const callback = () => {
            if (!this.#isInterval) this.#active = false;
            try {
                this.#fn.apply(this, this.#args);
            } finally {
                if (!this.#isInterval && this.#generation === generation) {
                    this._destroyed = true;
                }
            }
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
        this._idleTimeout = this.#ms;
        this._destroyed = false;
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
        this._destroyed = true;
        this._idleTimeout = -1;
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

    _destroyed = false;

    constructor(private handle: TimerCallback, args: unknown[] = []) {
        this.#id = timer.setTimeout(() => {
            if (!this.#active) return;
            this.#active = false;
            this.#refed = false;
            this._destroyed = true;
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
        this._destroyed = true;
        return this;
    }

    // globalThis.clearImmediate (webapi/basic.ts) can only reach a handle through
    // Number(handle); without valueOf that is NaN and the clear silently no-ops.
    valueOf(): number {
        return Number(this.#id);
    }

    get _onImmediate(): TimerCallback {
        return this.handle;
    }

    get __cno_timer_id(): number {
        return Number(this.#id);
    }
}

// The global setImmediate returns webapi/basic.ts's own Immediate class, so a
// cross-boundary clearImmediate has to recognise foreign handles too. Both
// classes share the native timer registry, so cancelling by id is sufficient.
function clearForeignImmediate(handle: object): boolean {
    if (!('_onImmediate' in handle)) return false;
    const close = Reflect.get(handle, 'close');
    if (typeof close === 'function') {
        close.call(handle);
        return true;
    }
    const id = Number(handle);
    if (!Number.isNaN(id) && id !== 0) timer.clearTimeout(id);
    return true;
}

// Timer functions

export function setTimeout<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    assertTimerCallback(callback);
    return new Timeout(false, callback, normalizeDelay(ms), args);
}

export function setInterval<T>(callback: (...args: T[]) => void, ms?: number, ...args: T[]): NodeJS.Timeout {
    assertTimerCallback(callback);
    return new Timeout(true, callback, normalizeDelay(ms), args);
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
    if (immediate instanceof Immediate) {
        immediate[Symbol.dispose]();
        return;
    }
    // Foreign (global) Immediate handles must clear too; bare ids/objects stay no-ops.
    if (typeof immediate === 'object' && immediate !== null) clearForeignImmediate(immediate);
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
            }, normalizeDelay(delay));
            if (options?.ref === false) timer.unrefTimer(id);
        });
    },

    setInterval<T = void>(delay?: number, value?: T, options?: TimerOptions): AsyncIterableIterator<T> {
        assertPromiseDelay(delay);
        assertTimerOptions(options);
        const signal = options?.signal;
        const ms = normalizeDelay(delay);
        let finished = false;
        let pendingId: number | undefined;

        // return()/throw() must cancel the pending tick so the loop can drain.
        const stop = () => {
            finished = true;
            if (pendingId !== undefined) {
                timer.clearTimeout(pendingId);
                pendingId = undefined;
            }
        };

        return {
            [Symbol.asyncIterator]() { return this; },
            async next(): Promise<IteratorResult<T>> {
                if (finished) return { done: true, value: undefined };
                if (signal?.aborted) { stop(); throw createAbortError(signal.reason); }

                await new Promise<void>((resolve, reject) => {
                    const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
                    const onAbort = () => { cleanup(); stop(); reject(createAbortError(signal?.reason)); };
                    signal?.addEventListener('abort', onAbort, { once: true });

                    pendingId = timer.setTimeout(() => {
                        pendingId = undefined;
                        cleanup();
                        resolve();
                    }, ms);
                    if (options?.ref === false) timer.unrefTimer(pendingId);
                });

                if (finished) return { done: true, value: undefined };
                return { done: false, value: value as T };
            },
            async return(): Promise<IteratorResult<T>> {
                stop();
                return { done: true, value: undefined };
            },
            async throw(err?: unknown): Promise<IteratorResult<T>> {
                stop();
                throw err;
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
                }, normalizeDelay(delay));
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
