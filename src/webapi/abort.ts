const { setTimeout } = import.meta.use('timers');

class AbortSignal extends EventTarget implements globalThis.AbortSignal {
    #aborted = false;
    #reason: any = undefined;
    #onabort: ((this: globalThis.AbortSignal, ev: Event) => any) | null = null;

    constructor() {
        super();
    }

    get aborted(): boolean {
        return this.#aborted;
    }

    get reason(): any {
        return this.#reason;
    }

    get onabort(): ((this: globalThis.AbortSignal, ev: Event) => any) | null {
        return this.#onabort;
    }

    set onabort(handler: ((this: globalThis.AbortSignal, ev: Event) => any) | null) {
        if (this.#onabort) {
            // @ts-ignore
            this.removeEventListener('abort', this.#onabort);
        }
        this.#onabort = handler;
        if (handler) {
            // @ts-ignore
            this.addEventListener('abort', handler);
        }
    }

    throwIfAborted(): void {
        if (this.#aborted) {
            throw this.#reason;
        }
    }

    static abort(reason?: any): globalThis.AbortSignal {
        const signal = new AbortSignal();
        signal._abort(reason ?? new DOMException('Signal aborted', 'AbortError'));
        return signal;
    }

    static timeout(milliseconds: number): globalThis.AbortSignal {
        const signal = new AbortSignal();
        const ms = Number(milliseconds);

        if (ms < 0 || !Number.isFinite(ms)) {
            throw new TypeError('Invalid timeout value');
        }

        setTimeout(() => {
            signal._abort(new DOMException('Signal timed out', 'TimeoutError'));
        }, ms);

        return signal;
    }

    static any(signals: globalThis.AbortSignal[]): globalThis.AbortSignal {
        if (!Array.isArray(signals)) {
            throw new TypeError('signals must be an array');
        }

        const resultSignal = new AbortSignal();

        // If any signal is already aborted, abort immediately
        for (const signal of signals) {
            if (signal.aborted) {
                resultSignal._abort(signal.reason);
                return resultSignal;
            }
        }

        // Listen to all signals
        const handlers = new Map<globalThis.AbortSignal, () => void>();

        for (const signal of signals) {
            const handler = () => {
                resultSignal._abort(signal.reason);
                for (const [s, h] of handlers) {
                    s.removeEventListener('abort', h);
                }
            };
            handlers.set(signal, handler);
            signal.addEventListener('abort', handler);
        }

        return resultSignal;
    }

    _abort(reason: any): void {
        if (this.#aborted) return;

        this.#aborted = true;
        this.#reason = reason;

        const event = new Event('abort');
        this.dispatchEvent(event);
    }
}

// ==================== AbortController ====================

class AbortController implements AbortController {
    #signal: AbortSignal;

    constructor() {
        this.#signal = new AbortSignal();
    }

    get signal(): AbortSignal {
        return this.#signal;
    }

    abort(reason?: any): void {
        this.#signal._abort(reason ?? new DOMException('Aborted', 'AbortError'));
    }
}

// ==================== Export ====================
export {
    AbortController,
    AbortSignal,
};

Reflect.set(globalThis, 'AbortController', AbortController);
Reflect.set(globalThis, 'AbortSignal', AbortSignal);
