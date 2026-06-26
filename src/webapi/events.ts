export class Event implements globalThis.Event {
    readonly type: string;
    readonly bubbles: boolean = false;
    readonly cancelable: boolean = false;
    readonly composed: boolean = false;
    readonly eventPhase: 0 = 0;             // NONE only
    readonly isTrusted: boolean = false;

    // Legacy aliases required by TypeScript lib.dom.d.ts
    cancelBubble: boolean = false;
    returnValue: boolean = true;
    srcElement: EventTarget | null = null;

    target: EventTarget | null = null;
    currentTarget: EventTarget | null = null;
    timeStamp: number = performance.now();

    private _stopped = false;
    private _prevented = false;

    constructor(type: string, options?: EventInit, trust = false) {
        this.type = type;
        if (options) {
            (this as any).bubbles = !!options.bubbles;
            (this as any).cancelable = !!options.cancelable;
            (this as any).composed = !!options.composed;
        }
        this.isTrusted = trust;
    }

    preventDefault(): void {
        if (this.cancelable) this._prevented = true;
    }
    stopPropagation(): void {
        this._stopped = true;
    }
    stopImmediatePropagation(): void {
        this._stopped = true;
    }

    get defaultPrevented(): boolean {
        return this._prevented;
    }
    get propagationStopped(): boolean {
        return this._stopped;
    }

    static NONE = 0;
    static CAPTURING_PHASE = 1;
    static AT_TARGET = 2;
    static BUBBLING_PHASE = 3;
    public readonly NONE = 0;
    public readonly CAPTURING_PHASE = 1;
    public readonly AT_TARGET = 2;
    public readonly BUBBLING_PHASE = 3;

    composedPath(): EventTarget[] {
        return this.target ? [this.target] : [];
    }

    initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void {
        (this as any).type = type;
        (this as any).bubbles = !!bubbles;
        (this as any).cancelable = !!cancelable;
    }
    
    get [Symbol.toStringTag]() {
        return 'Event';
    }
}

interface ListenerEntry { listener: EventListenerOrEventListenerObject; once: boolean; signal?: AbortSignal; }

export class EventTarget implements globalThis.EventTarget {
    #listeners = new Map<string, ListenerEntry[]>();

    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean
    ): void {
        if (!listener) return;
        const opts = typeof options === 'boolean' ? { capture: options } : options ?? {};
        let bucket = this.#listeners.get(type);
        if (!bucket) { bucket = []; this.#listeners.set(type, bucket); }
        const entry: ListenerEntry = { listener, once: !!opts.once, signal: opts.signal };
        bucket.push(entry);
        if (opts.signal) {
            opts.signal.addEventListener('abort', () => {
                const idx = bucket.indexOf(entry);
                if (idx !== -1) bucket.splice(idx, 1);
            }, { once: true });
        }
    }

    removeEventListener(
        type: string,
        listener: EventListener | null,
        options?: AddEventListenerOptions | boolean
    ): void {
        if (!listener) return;
        const bucket = this.#listeners.get(type);
        if (!bucket) return;
        const idx = bucket.findIndex(e => e.listener === listener);
        if (idx !== -1) bucket.splice(idx, 1);
    }

    dispatchEvent(event: globalThis.Event): boolean {
        if (!(event instanceof Event)) throw new TypeError('Invalid event object');

        // fill legacy aliases
        event.target = this;
        event.currentTarget = this;
        event.srcElement = this;

        const bucket = this.#listeners.get(event.type);
        if (bucket) {
            const snapshot = [...bucket];
            for (const entry of snapshot) {
                if (event.propagationStopped) break;
                if (entry.once) {
                    const idx = bucket.indexOf(entry);
                    if (idx !== -1) bucket.splice(idx, 1);
                }
                const fn = entry.listener;
                // @ts-expect-error - polyfill Event vs global Event structural mismatch
                if (typeof fn === 'function') fn.call(this, event);
                else fn.handleEvent?.(event);
            }
        }

        // cleanup
        event.target = null;
        event.currentTarget = null;
        event.srcElement = null;

        return !event.defaultPrevented;
    }
}

export class CustomEvent extends Event implements globalThis.CustomEvent {
    public readonly detail: any;
    constructor(type: string, eventInitDict?: CustomEventInit, trust?: boolean) {
        super(type, eventInitDict, trust);
        this.detail = eventInitDict?.detail;
    }
}

export class ErrorEvent extends Event implements globalThis.ErrorEvent {
    /** Human-readable error description. */
    public readonly message: string;

    /** URL of the script where the error happened. */
    public readonly filename: string;

    /** Line number (1-based) where the error happened. */
    public readonly lineno: number;

    /** Column number (1-based) where the error happened. */
    public readonly colno: number;

    /** Arbitrary payload attached to the error (e.g. the original Error). */
    public readonly error: unknown;

    constructor(type: string, init: ErrorEventInit = {}, trust?: boolean) {
        super(type, init, trust);

        this.message = init.message ?? '';
        this.filename = init.filename ?? '';
        this.lineno = init.lineno ?? 0;
        this.colno = init.colno ?? 0;
        this.error = init.error ?? null;

        // Ensures `instanceof ErrorEvent` works correctly.
        Object.setPrototypeOf(this, ErrorEvent.prototype);
    }
}

export class PromiseRejectionEvent extends Event implements globalThis.PromiseRejectionEvent {
    public readonly reason: any;
    public readonly promise: Promise<any>;

    constructor(type: string, init: PromiseRejectionEventInit, trust?: boolean) {
        super(type, init, trust);
        this.reason = init.reason;
        this.promise = init.promise;
    }
}

export class CloseEvent extends Event implements globalThis.CloseEvent {
    public readonly code: number;
    public readonly reason: string;
    public readonly wasClean: boolean;

    constructor(type: string, init: CloseEventInit, trust?: boolean) {
        super(type, init, trust);
        this.code = init.code ?? 0;
        this.reason = init.reason ?? '';
        this.wasClean = init.wasClean ?? true;
    }
}

export class MessageEvent extends Event implements globalThis.MessageEvent {
    public readonly data: any;
    public readonly origin: string;
    public readonly lastEventId: string;
    public readonly source = null;
    public readonly ports: MessagePort[];

    /** @deprecated */
    initMessageEvent(): void {
        throw new Error('legacy initMessageEvent deprecated');
    }

    constructor(type: string, init: MessageEventInit, trust?: boolean) {
        super(type, init, trust);
        this.data = init.data;
        this.origin = init.origin ?? '';
        this.lastEventId = init.lastEventId ?? '';
        this.ports = init.ports ?? [];
    }
}

export class DOMException extends Error {
    public code: number;

    constructor(message: string = '', name: string = 'Error') {
        super(message);

        this.name = name;
        this.code = DOMException.getErrorCode(name);
        Object.setPrototypeOf(this, DOMException.prototype);
    }

    // Static error code constants (as defined in DOM Standard)
    static readonly INDEX_SIZE_ERR: number = 1;
    static readonly DOMSTRING_SIZE_ERR: number = 2;
    static readonly HIERARCHY_REQUEST_ERR: number = 3;
    static readonly WRONG_DOCUMENT_ERR: number = 4;
    static readonly INVALID_CHARACTER_ERR: number = 5;
    static readonly NO_DATA_ALLOWED_ERR: number = 6;
    static readonly NO_MODIFICATION_ALLOWED_ERR: number = 7;
    static readonly NOT_FOUND_ERR: number = 8;
    static readonly NOT_SUPPORTED_ERR: number = 9;
    static readonly INUSE_ATTRIBUTE_ERR: number = 10;
    static readonly INVALID_STATE_ERR: number = 11;
    static readonly SYNTAX_ERR: number = 12;
    static readonly INVALID_MODIFICATION_ERR: number = 13;
    static readonly NAMESPACE_ERR: number = 14;
    static readonly INVALID_ACCESS_ERR: number = 15;
    static readonly VALIDATION_ERR: number = 16;
    static readonly TYPE_MISMATCH_ERR: number = 17;
    static readonly SECURITY_ERR: number = 18;
    static readonly NETWORK_ERR: number = 19;
    static readonly ABORT_ERR: number = 20;
    static readonly URL_MISMATCH_ERR: number = 21;
    static readonly QUOTA_EXCEEDED_ERR: number = 22;
    static readonly TIMEOUT_ERR: number = 23;
    static readonly INVALID_NODE_TYPE_ERR: number = 24;
    static readonly DATA_CLONE_ERR: number = 25;

    // Map error names to error codes
    private static errorCodeMap: Record<string, number> = {
        'IndexSizeError': DOMException.INDEX_SIZE_ERR,
        'DOMStringSizeError': DOMException.DOMSTRING_SIZE_ERR,
        'HierarchyRequestError': DOMException.HIERARCHY_REQUEST_ERR,
        'WrongDocumentError': DOMException.WRONG_DOCUMENT_ERR,
        'InvalidCharacterError': DOMException.INVALID_CHARACTER_ERR,
        'NoDataAllowedError': DOMException.NO_DATA_ALLOWED_ERR,
        'NoModificationAllowedError': DOMException.NO_MODIFICATION_ALLOWED_ERR,
        'NotFoundError': DOMException.NOT_FOUND_ERR,
        'NotSupportedError': DOMException.NOT_SUPPORTED_ERR,
        'InUseAttributeError': DOMException.INUSE_ATTRIBUTE_ERR,
        'InvalidStateError': DOMException.INVALID_STATE_ERR,
        'SyntaxError': DOMException.SYNTAX_ERR,
        'InvalidModificationError': DOMException.INVALID_MODIFICATION_ERR,
        'NamespaceError': DOMException.NAMESPACE_ERR,
        'InvalidAccessError': DOMException.INVALID_ACCESS_ERR,
        'ValidationError': DOMException.VALIDATION_ERR,
        'TypeMismatchError': DOMException.TYPE_MISMATCH_ERR,
        'SecurityError': DOMException.SECURITY_ERR,
        'NetworkError': DOMException.NETWORK_ERR,
        'AbortError': DOMException.ABORT_ERR,
        'URLMismatchError': DOMException.URL_MISMATCH_ERR,
        'QuotaExceededError': DOMException.QUOTA_EXCEEDED_ERR,
        'TimeoutError': DOMException.TIMEOUT_ERR,
        'InvalidNodeTypeError': DOMException.INVALID_NODE_TYPE_ERR,
        'DataCloneError': DOMException.DATA_CLONE_ERR,
        'Error': 0 // Default error
    };

    private static getErrorCode(name: string): number {
        return this.errorCodeMap[name] || 0;
    }

    static create(name: string, message: string = ''): DOMException {
        return new DOMException(message, name);
    }

    static of(name: string, message?: string): DOMException {
        return new DOMException(message, name);
    }

    static indexSize(message?: string) { return DOMException.of('IndexSizeError', message); }
    static hierarchyRequest(message?: string) { return DOMException.of('HierarchyRequestError', message); }
    static notFound(message?: string) { return DOMException.of('NotFoundError', message); }
    static security(message?: string) { return DOMException.of('SecurityError', message); }
    static syntax(message?: string) { return DOMException.of('SyntaxError', message); }
    static typeMismatch(message?: string) { return DOMException.of('TypeMismatchError', message); }
    static invalidState(message?: string) { return DOMException.of('InvalidStateError', message); }
}

export class ProgressEvent<T extends EventTarget = EventTarget> extends Event implements globalThis.ProgressEvent<T> {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;

    declare target: T | null;

    constructor(type: string, init: ProgressEventInit = {}) {
        super(type, init);
        this.lengthComputable = init.lengthComputable ?? false;
        this.loaded = init.loaded ?? 0;
        this.total = init.total ?? 0;
    }
}

for (const [name, cls] of Object.entries({
    Event, EventTarget, CustomEvent, ErrorEvent, PromiseRejectionEvent,
    CloseEvent, MessageEvent, DOMException, ProgressEvent,
})) Reflect.set(globalThis, name, cls);

export const parseStackFrame = (
    line: string
): { func?: string; file: string; line: number; col: number } | null => {
    const body = line.replace(/^\s*at\s+/i, '').trim();
    if (!body) return null;

    const m1 = /^(?:(async\s+)?(?:([^()\s]+|\<anonymous\>|\<eval\>))\s+)?\(?(.+?)\)?$/i.exec(body);
    if (!m1) return null;

    const func = m1[2] || undefined;
    const location = m1[3];

    const m2 = /^(.+?):(\d+):(\d+)$/i.exec(location);
    if (!m2) return null;

    const [, file, lineStr, colStr] = m2;
    const lineNum = parseInt(lineStr, 10);
    const colNum = parseInt(colStr, 10);

    return { func, file, line: lineNum, col: colNum };
};

// FIXME: deno don't declared type StorageEvent
export class StorageEvent extends Event {
    readonly key: string | null;
    readonly oldValue: string | null;
    readonly newValue: string | null;
    readonly url: string;
    readonly storageArea: Storage | null;

    constructor(type: string, init?: /* StorageEventInit */ any, trust = false) {
        super(type, init, trust);
        this.key        = init?.key        ?? null;
        this.oldValue   = init?.oldValue   ?? null;
        this.newValue   = init?.newValue   ?? null;
        this.url        = init?.url        ?? '';
        this.storageArea = init?.storageArea ?? null;
    }

    initStorageEvent(type: string, bubbles?: boolean, cancelable?: boolean, key?: string | null, oldValue?: string | null, newValue?: string | null, url?: string, storageArea?: Storage | null): void {
        throw new Error('legacy initStorageEvent not implemented');
    }
}

Reflect.set(globalThis, 'StorageEvent', StorageEvent);

export function fromError(error: any): ErrorEvent {
    if (!(error instanceof Error)) {
        return new ErrorEvent('error', {
            error,
            message: String(error)
        }, true);
    }
    const infoLine = error.stack?.split('\n')[0].trim();
    if (!infoLine) {
        return new ErrorEvent('error', {
            message: error.message,
        }, true);
    }
    const match = parseStackFrame(infoLine);
    if (!match) {
        return new ErrorEvent('error', {
            message: error.message,
            error
        }, true);
    }
    return new ErrorEvent('error', {
        message: error.message,
        filename: match.file,
        lineno: match.line,
        colno: match.col,
        error,
    }, true);
}
