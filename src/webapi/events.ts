export class Event {
    readonly type: string;
    readonly bubbles: boolean = false;
    readonly cancelable: boolean = true;    // by default, cjs events are cancelable
    readonly composed: boolean = false;
    readonly eventPhase: 0 = 0; // NONE only
    readonly isTrusted: boolean = true;

    // Legacy aliases required by TypeScript lib.dom.d.ts
    cancelBubble: boolean = false;
    returnValue: boolean = true;
    srcElement: EventTarget | null = null;

    target: EventTarget | null = null;
    currentTarget: EventTarget | null = null;
    timeStamp: number = performance.now();

    private _stopped = false;
    private _prevented = false;

    constructor(type: string, options?: EventInit) {
        this.type = type;
        Object.assign(this, options);
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
}

export class EventTarget {
    #listeners = new Map<string, Set<EventListener>>();

    addEventListener(
        type: string,
        listener: EventListener | null,
        _options?: AddEventListenerOptions | boolean
    ): void {
        if (!listener) return;
        let bucket = this.#listeners.get(type);
        if (!bucket) {
            bucket = new Set();
            this.#listeners.set(type, bucket);
        }
        bucket.add(listener);
    }

    removeEventListener(
        type: string,
        listener: EventListener | null,
        _options?: AddEventListenerOptions | boolean
    ): void {
        if (!listener) return;
        this.#listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event: Event): boolean {
        if (!(event instanceof Event)) throw new TypeError('Invalid event object');

        // fill legacy aliases
        event.target = this;
        event.currentTarget = this;
        event.srcElement = this;

        const bucket = this.#listeners.get(event.type);
        if (bucket) {
            // copy to allow removal during iteration
            for (const fn of [...bucket]) {
                if (event.propagationStopped) break;
                fn.call(this, event);
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
    constructor(type: string, eventInitDict?: CustomEventInit) {
        super(type, eventInitDict);
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

    constructor(type: string, init: ErrorEventInit = {}) {
        super(type, init);

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

    constructor(type: string, init: PromiseRejectionEventInit) {
        super(type, init);
        this.reason = init.reason;
        this.promise = init.promise;
    }
}

export class CloseEvent extends Event implements globalThis.CloseEvent {
    public readonly code: number;
    public readonly reason: string;
    public readonly wasClean: boolean;

    constructor(type: string, init: CloseEventInit) {
        super(type, init);
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

    initMessageEvent(type: string, bubbles?: boolean, cancelable?: boolean, data?: any, origin?: string, lastEventId?: string, source?: MessageEventSource | null, ports?: MessagePort[]): void {
        throw new Error('legacy initMessageEvent not implemented');
    }

    constructor(type: string, init: MessageEventInit) {
        super(type, init);
        this.data = init.data;
        this.origin = init.origin ?? '';
        this.lastEventId = init.lastEventId ?? '';
        this.ports = init.ports ?? [];
    }
}

Reflect.set(globalThis, 'Event', Event);
Reflect.set(globalThis, 'EventTarget', EventTarget);
Reflect.set(globalThis, 'CustomEvent', CustomEvent);
Reflect.set(globalThis, 'ErrorEvent', ErrorEvent);
Reflect.set(globalThis, 'PromiseRejectionEvent', PromiseRejectionEvent);
Reflect.set(globalThis, 'CloseEvent', CloseEvent);
Reflect.set(globalThis, 'MessageEvent', MessageEvent);

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

export function fromError(error: any): ErrorEvent {
    if (!(error instanceof Error)) {
        return new ErrorEvent('error', {
            message: String(error),
        });
    }
    const infoLine = error.stack?.split('\n')[0].trim();
    if (!infoLine) {
        return new ErrorEvent('error', {
            message: error.message,
        });
    }
    const match = parseStackFrame(infoLine);
    if (!match) {
        return new ErrorEvent('error', {
            message: error.message,
        });
    }
    return new ErrorEvent('error', {
        message: error.message,
        filename: match.file,
        lineno: match.line,
        colno: match.col,
        error,
    });
}
