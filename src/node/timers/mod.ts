import {
    _clearNativeQueueTimer,
    _createNativeQueueResource,
    type NativeQueueResource,
} from '../../utils/native-queue-resource';

const timer = import.meta.use('timers');

type TimerCallback = (...args: unknown[]) => void;
const noopTimerCallback: TimerCallback = () => {};

// Node clamps every timer delay into [1, 2^31-1] and warns outside that range.
const TIMEOUT_MAX = 2 ** 31 - 1;

// Preserve the AbortError constructor identity and own name/code properties.
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

export interface TimerOptions {
    ref?: boolean;
    signal?: AbortSignal;
}

class Timeout implements NodeJS.Timeout {
    #id = 0;
    #isInterval: boolean;
    #fn: TimerCallback | null;
    #ms: number;
    #args: unknown[];
    #resource: NativeQueueResource;
    #active = false;
    #refed = true;

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
        this.#resource = _createNativeQueueResource(isInterval ? 'Interval' : 'Timeout', fn, {
            resource: this,
            clearNative: timer.clearTimeout,
            repeat: isInterval,
            refreshable: true,
            onCancel: () => {
                this.#active = false;
                this._destroyed = true;
                this._idleTimeout = -1;
                this.#fn = null;
                this.#args = [];
            },
            onStart: resource => {
                this.#resource = resource;
                this.#id = this.#schedule();
                resource.bind(this.#id);
                this.#active = true;
                this._destroyed = false;
                if (!this.#refed) timer.unrefTimer(this.#id);
            },
        });
    }

    #schedule(): number {
        const callback = () => {
            if (!this.#isInterval) this.#active = false;
            try {
                this.#resource.invoke(this, this.#args);
            } finally {
                if (!this.#active) this._destroyed = true;
            }
        };
        return this.#isInterval
            ? timer.setInterval(callback, this.#ms)
            : timer.setTimeout(callback, this.#ms);
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
        this.#resource.refresh();
        return this;
    }

    close(): this {
        _clearNativeQueueTimer(this);
        return this;
    }

    [Symbol.toPrimitive](): number {
        return Number(this.#id) || 0;
    }

    [Symbol.dispose](): void {
        this.close();
    }

    get _onTimeout(): TimerCallback {
        return this.#fn ?? noopTimerCallback;
    }

    get __cno_timer_id(): number {
        return Number(this.#id);
    }
}

class Immediate implements NodeJS.Immediate {
    /* Backed by the native check-phase immediate (mod_timers.c) — the same
       registry the global setImmediate uses, so cross-boundary clearImmediate
       works through the shared id space. */
    #id = 0;
    #active = true;
    #refed = true;
    #resource: NativeQueueResource;

    _destroyed = false;

    constructor(handle: TimerCallback, args: unknown[] = []) {
        this.handle = handle;
        this.#resource = _createNativeQueueResource('Immediate', handle, {
            resource: this,
            clearNative: timer.clearImmediate,
            onCancel: () => this.#markDestroyed(),
            onStart: resource => {
                this.#resource = resource;
                this.#id = timer.setImmediate(() => {
                    this.#markDestroyed();
                    resource.invoke(this, args);
                });
                resource.bind(this.#id);
            },
        });
    }

    #markDestroyed(): void {
        this.#active = false;
        this.#refed = false;
        this._destroyed = true;
        this.handle = null;
    }

    hasRef(): boolean {
        return this.#active && this.#refed;
    }

    ref(): this {
        if (!this.#active) return this;
        this.#refed = true;
        timer.refImmediate(this.#id);
        return this;
    }

    unref(): this {
        if (!this.#active) return this;
        this.#refed = false;
        timer.unrefImmediate(this.#id);
        return this;
    }

    [Symbol.dispose](): void {
        this.close();
    }

    close(): this {
        _clearNativeQueueTimer(this, 'Immediate');
        return this;
    }

    // globalThis.clearImmediate (webapi/basic.ts) can only reach a handle through
    // Number(handle); without valueOf that is NaN and the clear silently no-ops.
    valueOf(): number {
        return Number(this.#id);
    }

    private handle: TimerCallback | null;

    get _onImmediate(): TimerCallback {
        return this.handle ?? noopTimerCallback;
    }

    get __cno_timer_id(): number {
        return Number(this.#id);
    }
}

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
    _clearNativeQueueTimer(timeout);
}

export function clearInterval(timeout: NodeJS.Timeout | string | number | undefined): void {
    _clearNativeQueueTimer(timeout);
}

export function clearImmediate(immediate: NodeJS.Immediate | number | undefined): void {
    _clearNativeQueueTimer(immediate, 'Immediate');
}

function timerPromise<T>(delay: number | undefined, value: T, options: TimerOptions | undefined, immediate = false): Promise<T> {
    assertTimerOptions(options);
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(new AbortError(signal.reason));

    return new Promise<T>((resolve, reject) => {
        let resource: NativeQueueResource | undefined;
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (settled) return;
            settled = true;
            try { reject(new AbortError(signal?.reason)); }
            catch (error) { reject(error); }
            finally { resource?.cancel(); }
        };
        try {
            const ms = immediate ? 0 : normalizeDelay(delay);
            const refed = options?.ref !== false;
            const entry = resource = _createNativeQueueResource(immediate ? 'Immediate' : 'Timeout', () => {
                settled = true;
                try {
                    cleanup();
                    resolve(value);
                } catch (error) {
                    reject(error);
                }
            }, {
                clearNative: immediate ? timer.clearImmediate : timer.clearTimeout,
                onCancel: cleanup,
            });
            if (signal?.aborted) {
                onAbort();
                return;
            }

            const invoke = () => entry.invoke(undefined, []);
            const id = immediate ? timer.setImmediate(invoke) : timer.setTimeout(invoke, ms);
            entry.bind(id);
            if (!refed) {
                if (immediate) timer.unrefImmediate(id);
                else timer.unrefTimer(id);
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        } catch (error) {
            settled = true;
            reject(error);
            resource?.cancel();
        }
    });
}

export const promises = {
    setTimeout<T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> {
        assertPromiseDelay(delay);
        return timerPromise(delay, value as T, options);
    },

    setInterval<T = void>(delay?: number, value?: T, options?: TimerOptions): AsyncIterableIterator<T> {
        assertPromiseDelay(delay);
        assertTimerOptions(options);
        const ms = normalizeDelay(delay);

        // Generator requests are serialized: return()/throw() wait for an
        // outstanding next() to release its timer and abort listener, as in Node.
        return (async function* () {
            while (true) {
                await promises.setTimeout(ms, undefined, options);
                yield value as T;
            }
        })();
    },

    setImmediate<T = void>(value?: T, options?: TimerOptions): Promise<T> {
        return timerPromise(undefined, value as T, options, true);
    },

    scheduler: {
        wait(delay: number, options?: { signal?: AbortSignal }): Promise<void> {
            return promises.setTimeout(delay, undefined, options);
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
