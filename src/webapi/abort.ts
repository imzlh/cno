import { DOMException } from "./events";

const { setTimeout, clearTimeout } = import.meta.use('timers');

let allowAbortSignalConstruction = false;

function createAbortSignal(): AbortSignal {
    allowAbortSignalConstruction = true;
    try {
        return new AbortSignal();
    } finally {
        allowAbortSignalConstruction = false;
    }
}

class AbortSignal extends EventTarget implements globalThis.AbortSignal {
    #aborted = false;
    #reason: unknown = undefined;
    #onabort: ((this: globalThis.AbortSignal, ev: Event) => unknown) | null = null;
    #onabortListener: ((ev: Event) => void) | null = null;

    constructor() {
        if (!allowAbortSignalConstruction) {
            throw new TypeError('Illegal constructor');
        }
        super();
    }

    get aborted(): boolean {
        return this.#aborted;
    }

    get reason(): unknown {
        return this.#reason;
    }

    get onabort(): ((this: globalThis.AbortSignal, ev: Event) => unknown) | null {
        return this.#onabort;
    }

    set onabort(handler: ((this: globalThis.AbortSignal, ev: Event) => unknown) | null) {
        if (this.#onabortListener) {
            this.removeEventListener('abort', this.#onabortListener);
            this.#onabortListener = null;
        }
        this.#onabort = typeof handler === 'function' ? handler : null;
        if (this.#onabort) {
            this.#onabortListener = (event) => this.#onabort?.call(this, event);
            this.addEventListener('abort', this.#onabortListener);
        }
    }

    throwIfAborted(): void {
        if (this.#aborted) {
            throw this.#reason;
        }
    }

    static abort(reason?: unknown): globalThis.AbortSignal {
        const signal = createAbortSignal();
        signal._abort(reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason);
        return signal;
    }

    static timeout(milliseconds: number): globalThis.AbortSignal {
        const signal = createAbortSignal();
        const ms = Number(milliseconds);

        if (!Number.isFinite(ms) || ms < 0) {
            throw new RangeError('The value of "milliseconds" is out of range. It must be >= 0');
        }

        const id = setTimeout(() => {
            signal._abort(new DOMException('Signal timed out', 'TimeoutError'));
        }, ms);
        signal.addEventListener('abort', () => clearTimeout(id), { once: true });

        return signal;
    }

    // Spec takes any iterable of signals, not just an Array.
    static any(signals: Iterable<globalThis.AbortSignal>): globalThis.AbortSignal {
        if (signals === null || signals === undefined || typeof Reflect.get(Object(signals), Symbol.iterator) !== 'function') {
            throw new TypeError('signals is not iterable');
        }
        const list = Array.from(signals);

        const resultSignal = createAbortSignal();

        // If any signal is already aborted, abort immediately
        for (const signal of list) {
            if (signal.aborted) {
                resultSignal._abort(signal.reason);
                return resultSignal;
            }
        }

        // Listen to all signals
        const handlers = new Map<globalThis.AbortSignal, () => void>();

        const cleanup = () => {
            for (const [s, h] of handlers) {
                s.removeEventListener('abort', h);
            }
            handlers.clear();
        };

        for (const signal of list) {
            const handler = () => {
                resultSignal._abort(signal.reason);
                cleanup();
            };
            handlers.set(signal, handler);
            signal.addEventListener('abort', handler);
        }

        resultSignal.addEventListener('abort', cleanup, { once: true });

        return resultSignal;
    }

    _abort(reason: unknown): void {
        if (this.#aborted) return;

        this.#aborted = true;
        this.#reason = reason;

        const event = new Event('abort');
        this.dispatchEvent(event);
    }
}

// ==================== AbortController ====================

class AbortController implements globalThis.AbortController {
    #signal: AbortSignal;

    constructor() {
        this.#signal = createAbortSignal();
    }

    get signal(): AbortSignal {
        return this.#signal;
    }

    abort(reason?: unknown): void {
        this.#signal._abort(reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason);
    }
}

// Spec puts Symbol.toStringTag on the prototype, not on each instance.
Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true });
Object.defineProperty(AbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true });

// ==================== Export ====================
export {
    AbortController,
    AbortSignal,
};

Reflect.set(globalThis, 'AbortController', AbortController);
Reflect.set(globalThis, 'AbortSignal', AbortSignal);
