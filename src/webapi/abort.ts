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
            this.removeEventListener('abort', this.#onabort);
        }
        this.#onabort = handler;
        if (handler) {
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

// ==================== DOMException (if not available) ====================

class DOMException extends Error implements DOMException {
    readonly name: string;
    readonly code: number;

    static readonly INDEX_SIZE_ERR = 1;
    static readonly DOMSTRING_SIZE_ERR = 2;
    static readonly HIERARCHY_REQUEST_ERR = 3;
    static readonly WRONG_DOCUMENT_ERR = 4;
    static readonly INVALID_CHARACTER_ERR = 5;
    static readonly NO_DATA_ALLOWED_ERR = 6;
    static readonly NO_MODIFICATION_ALLOWED_ERR = 7;
    static readonly NOT_FOUND_ERR = 8;
    static readonly NOT_SUPPORTED_ERR = 9;
    static readonly INUSE_ATTRIBUTE_ERR = 10;
    static readonly INVALID_STATE_ERR = 11;
    static readonly SYNTAX_ERR = 12;
    static readonly INVALID_MODIFICATION_ERR = 13;
    static readonly NAMESPACE_ERR = 14;
    static readonly INVALID_ACCESS_ERR = 15;
    static readonly VALIDATION_ERR = 16;
    static readonly TYPE_MISMATCH_ERR = 17;
    static readonly SECURITY_ERR = 18;
    static readonly NETWORK_ERR = 19;
    static readonly ABORT_ERR = 20;
    static readonly URL_MISMATCH_ERR = 21;
    static readonly QUOTA_EXCEEDED_ERR = 22;
    static readonly TIMEOUT_ERR = 23;
    static readonly INVALID_NODE_TYPE_ERR = 24;
    static readonly DATA_CLONE_ERR = 25;

    readonly INDEX_SIZE_ERR = 1;
    readonly DOMSTRING_SIZE_ERR = 2;
    readonly HIERARCHY_REQUEST_ERR = 3;
    readonly WRONG_DOCUMENT_ERR = 4;
    readonly INVALID_CHARACTER_ERR = 5;
    readonly NO_DATA_ALLOWED_ERR = 6;
    readonly NO_MODIFICATION_ALLOWED_ERR = 7;
    readonly NOT_FOUND_ERR = 8;
    readonly NOT_SUPPORTED_ERR = 9;
    readonly INUSE_ATTRIBUTE_ERR = 10;
    readonly INVALID_STATE_ERR = 11;
    readonly SYNTAX_ERR = 12;
    readonly INVALID_MODIFICATION_ERR = 13;
    readonly NAMESPACE_ERR = 14;
    readonly INVALID_ACCESS_ERR = 15;
    readonly VALIDATION_ERR = 16;
    readonly TYPE_MISMATCH_ERR = 17;
    readonly SECURITY_ERR = 18;
    readonly NETWORK_ERR = 19;
    readonly ABORT_ERR = 20;
    readonly URL_MISMATCH_ERR = 21;
    readonly QUOTA_EXCEEDED_ERR = 22;
    readonly TIMEOUT_ERR = 23;
    readonly INVALID_NODE_TYPE_ERR = 24;
    readonly DATA_CLONE_ERR = 25;

    constructor(message: string = '', name: string = 'Error') {
        super(message);
        this.name = name;
        this.code = getCodeForName(name);

        // Set prototype explicitly for proper instanceof checks
        Object.setPrototypeOf(this, DOMException.prototype);
    }
}

const getCodeForName = (name: string): number => {
    const codes: Record<string, number> = {
        'IndexSizeError': 1,
        'HierarchyRequestError': 3,
        'WrongDocumentError': 4,
        'InvalidCharacterError': 5,
        'NoModificationAllowedError': 7,
        'NotFoundError': 8,
        'NotSupportedError': 9,
        'InUseAttributeError': 10,
        'InvalidStateError': 11,
        'SyntaxError': 12,
        'InvalidModificationError': 13,
        'NamespaceError': 14,
        'InvalidAccessError': 15,
        'TypeMismatchError': 17,
        'SecurityError': 18,
        'NetworkError': 19,
        'AbortError': 20,
        'URLMismatchError': 21,
        'QuotaExceededError': 22,
        'TimeoutError': 23,
        'InvalidNodeTypeError': 24,
        'DataCloneError': 25
    };
    return codes[name] ?? 0;
};

Reflect.set(globalThis, 'AbortController', AbortController);
Reflect.set(globalThis, 'AbortSignal', AbortSignal);
Reflect.set(globalThis, 'DOMException', DOMException);

// ==================== Export ====================
export {
    AbortController,
    AbortSignal,
    DOMException
};
