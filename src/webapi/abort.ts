import { DOMException } from "./events";

const { setTimeout, clearTimeout } = import.meta.use('timers');

let allowAbortSignalConstruction = false;

const listenerChangeHook = Symbol.for('cno.internal.eventTargetListenerChange');
const internalListener = Symbol.for('cno.internal.eventTargetListener');
const signalSources = Symbol.for('cno.internal.abortSignalSources');
const retainedDependent = Symbol.for('cno.internal.abortSignalRetainedDependent');

type DependentAbortHandler = (() => void) & { [retainedDependent]: AbortSignal | null };

interface SignalSubscription {
    source: WeakRef<globalThis.AbortSignal>;
    handler: WeakRef<DependentAbortHandler>;
}

function removeSubscriptions(subscriptions: SignalSubscription[]): void {
    for (const { source, handler } of subscriptions) {
        const listener = handler.deref();
        if (listener) {
            listener[retainedDependent] = null;
            source.deref()?.removeEventListener('abort', listener);
        }
    }
    subscriptions.length = 0;
}

const dependentSignalRegistry = new FinalizationRegistry(removeSubscriptions);

function dependentAbortHandler(source: WeakRef<globalThis.AbortSignal>, target: WeakRef<AbortSignal>): DependentAbortHandler {
    const handler = (() => {
        const signal = target.deref();
        const parent = source.deref();
        if (signal && parent) signal._abort(parent.reason);
    }) as DependentAbortHandler;
    Object.defineProperty(handler, internalListener, { value: true });
    Object.defineProperty(handler, retainedDependent, { value: null, writable: true });
    return handler;
}

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
    #sources: globalThis.AbortSignal[] | null = null;
    #subscriptions: SignalSubscription[] | null = null;

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
        const list = Array.from(new Set(signals));

        const resultSignal = createAbortSignal();

        // If any signal is already aborted, abort immediately
        for (const signal of list) {
            if (signal.aborted) {
                resultSignal._abort(signal.reason);
                return resultSignal;
            }
        }

        const sources = new Set<globalThis.AbortSignal>();
        for (const signal of list) {
            const getSources = Reflect.get(signal, signalSources);
            const roots = typeof getSources === 'function'
                ? Reflect.apply(getSources, signal, []) as globalThis.AbortSignal[]
                : [signal];
            for (const source of roots) sources.add(source);
        }
        const subscriptions: SignalSubscription[] = [];
        resultSignal.#sources = [...sources];
        resultSignal.#subscriptions = subscriptions;
        dependentSignalRegistry.register(resultSignal, subscriptions, resultSignal);
        const target = new WeakRef(resultSignal);
        try {
            for (const signal of sources) {
                if (resultSignal.aborted) break;
                const source = new WeakRef(signal);
                const handler = dependentAbortHandler(source, target);
                // The registry must not root handlers once they retain an observer.
                subscriptions.push({ source, handler: new WeakRef(handler) });
                signal.addEventListener('abort', handler, { once: true });
            }
        } catch (error) {
            resultSignal.clearSubscriptions();
            throw error;
        }
        return resultSignal;
    }

    [signalSources](): globalThis.AbortSignal[] {
        return this.#sources ?? [this];
    }

    [listenerChangeHook](type: string, count: number): void {
        if (type !== 'abort' || this.#aborted || !this.#subscriptions) return;
        // Only observed dependents are retained by their source listeners.
        for (const { handler } of this.#subscriptions) {
            const listener = handler.deref();
            if (listener) listener[retainedDependent] = count > 0 ? this : null;
        }
    }

    private clearSubscriptions(): void {
        if (this.#subscriptions) {
            removeSubscriptions(this.#subscriptions);
            this.#subscriptions = null;
            dependentSignalRegistry.unregister(this);
        }
        this.#sources = null;
    }

    _abort(reason: unknown): void {
        if (this.#aborted) return;

        this.#aborted = true;
        this.#reason = reason;
        this.clearSubscriptions();

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

export {
    AbortController,
    AbortSignal,
};

Reflect.set(globalThis, 'AbortController', AbortController);
Reflect.set(globalThis, 'AbortSignal', AbortSignal);
