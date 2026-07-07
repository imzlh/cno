import { DOMException, EventTarget } from "./events";
import { structuredCloneWithTransfer } from "../node/_internal/structured-clone";
const console = import.meta.use('console');
const denoCustomInspect = Symbol.for('Deno.customInspect');

// Store native performance.now reference
const nativePerformanceNow = globalThis.performance?.now?.bind(globalThis.performance) ?? (() => Date.now());

type PerformanceEntryType =
    | 'mark'
    | 'measure'
    | 'navigation'
    | 'resource'
    | 'paint'
    | 'frame'
    | 'function'
    | 'node';
type EventLoopUtilization = { idle: number; active: number; utilization: number };

type PerformanceObserverCallback = (
    list: PerformanceObserverEntryList,
    observer: PerformanceObserver
) => void;
type PerformanceEventHandler = ((this: Performance, ev: Event) => unknown) | null;

interface PerformanceObserverInit {
    entryTypes?: PerformanceEntryType[];
    type?: PerformanceEntryType;
    buffered?: boolean;
}

const constructorKey = {};

function emitPerformanceObserverCallback(
    callback: PerformanceObserverCallback,
    list: PerformanceObserverEntryList,
    observer: PerformanceObserver,
): void {
    try {
        callback(list, observer);
    } catch (error) {
        console.error('Error in PerformanceObserver callback:', error);
    }
}

function setFunctionNameQuietly(fn: Function, name: string): void {
    try {
        Object.defineProperty(fn, 'name', { value: name, configurable: true });
    } catch {
        // Function names are cosmetic for timerified callbacks.
    }
}

function cloneDetail(detail: unknown): unknown {
    return detail === undefined ? null : structuredCloneWithTransfer(detail);
}

function isPerformanceEntryType(type: string): type is PerformanceEntryType {
    return PerformanceObserver.supportedEntryTypes.some((entryType) => entryType === type);
}

function currentPerformance(): Performance {
    return globalThis.performance as Performance;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
    return typeof Reflect.get(value, 'then') === 'function';
}

// ==================== PerformanceEntry ====================

class PerformanceEntry<ET extends PerformanceEntryType> implements globalThis.PerformanceEntry {
    readonly name: string;
    readonly entryType: ET;
    readonly startTime: number;
    readonly duration: number;
    readonly detail: unknown;

    constructor(
        key: object,
        name: string,
        entryType: ET,
        startTime: number,
        duration: number,
        detail?: unknown
    ) {
        if (key !== constructorKey) throw new TypeError('Illegal constructor');
        this.name = name;
        this.entryType = entryType;
        this.startTime = startTime;
        this.duration = duration;
        if (detail !== undefined) {
            this.detail = detail;
        }
    }

    toJSON(): object {
        const obj: Record<string, unknown> = {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration
        };
        if (this.detail !== undefined) {
            obj.detail = this.detail;
        }
        return obj;
    }

    [denoCustomInspect]() {
        const className = this?.constructor?.name || 'PerformanceEntry';
        if (!(this instanceof PerformanceEntry)) return `${className} {}`;
        return `${className} ${console.inspect(this.toJSON(), { colors: false })}`;
    }
}

// ==================== PerformanceMark ====================

class PerformanceMark extends PerformanceEntry<'mark'> implements globalThis.PerformanceMark {
    public detail: unknown;

    constructor(name: string, options?: PerformanceMarkOptions) {
        const startTime = options?.startTime ?? nativePerformanceNow();
        const detail = cloneDetail(options?.detail);
        super(constructorKey, name, 'mark', startTime, 0, detail);
        this.detail = detail;
    }
}

// ==================== PerformanceMeasure ====================

class PerformanceMeasure extends PerformanceEntry<'measure'> implements globalThis.PerformanceMeasure {
    constructor(
        key: object,
        name: string,
        startTime: number,
        duration: number,
        detail?: unknown
    ) {
        if (key !== constructorKey) throw new TypeError('Illegal constructor');
        super(constructorKey, name, 'measure', startTime, duration, cloneDetail(detail));
    }
}

// ==================== PerformanceNavigationTiming ====================

class PerformanceNavigationTiming extends PerformanceEntry<'navigation'> {
    readonly unloadEventStart: number = 0;
    readonly unloadEventEnd: number = 0;
    readonly domInteractive: number;
    readonly domContentLoadedEventStart: number;
    readonly domContentLoadedEventEnd: number;
    readonly domComplete: number;
    readonly loadEventStart: number;
    readonly loadEventEnd: number;
    readonly type: string = 'navigate';
    readonly redirectCount: number = 0;

    constructor() {
        const now = nativePerformanceNow();
        super(constructorKey, 'navigation', 'navigation', 0, now);

        this.domInteractive = now;
        this.domContentLoadedEventStart = now;
        this.domContentLoadedEventEnd = now;
        this.domComplete = now;
        this.loadEventStart = now;
        this.loadEventEnd = now;
    }

    toJSON(): object {
        return {
            ...super.toJSON(),
            unloadEventStart: this.unloadEventStart,
            unloadEventEnd: this.unloadEventEnd,
            domInteractive: this.domInteractive,
            domContentLoadedEventStart: this.domContentLoadedEventStart,
            domContentLoadedEventEnd: this.domContentLoadedEventEnd,
            domComplete: this.domComplete,
            loadEventStart: this.loadEventStart,
            loadEventEnd: this.loadEventEnd,
            type: this.type,
            redirectCount: this.redirectCount
        };
    }
}

// ==================== PerformanceResourceTiming ====================

class PerformanceResourceTiming extends PerformanceEntry<'resource'> {
    readonly initiatorType: string;
    readonly nextHopProtocol: string = '';
    readonly workerStart: number = 0;
    readonly redirectStart: number = 0;
    readonly redirectEnd: number = 0;
    readonly fetchStart: number;
    readonly domainLookupStart: number;
    readonly domainLookupEnd: number;
    readonly connectStart: number;
    readonly connectEnd: number;
    readonly secureConnectionStart: number = 0;
    readonly requestStart: number;
    readonly responseStart: number;
    readonly responseEnd: number;
    readonly transferSize: number;
    readonly encodedBodySize: number;
    readonly decodedBodySize: number;

    constructor(
        name: string,
        startTime: number,
        duration: number,
        initiatorType: string,
        transferSize: number = 0
    ) {
        super(constructorKey, name, 'resource', startTime, duration);

        this.initiatorType = initiatorType;
        this.fetchStart = startTime;
        this.domainLookupStart = startTime;
        this.domainLookupEnd = startTime;
        this.connectStart = startTime;
        this.connectEnd = startTime;
        this.requestStart = startTime;
        this.responseStart = startTime + duration * 0.7;
        this.responseEnd = startTime + duration;
        this.transferSize = transferSize;
        this.encodedBodySize = transferSize;
        this.decodedBodySize = transferSize;
    }

    toJSON(): object {
        return {
            ...super.toJSON(),
            initiatorType: this.initiatorType,
            nextHopProtocol: this.nextHopProtocol,
            workerStart: this.workerStart,
            redirectStart: this.redirectStart,
            redirectEnd: this.redirectEnd,
            fetchStart: this.fetchStart,
            domainLookupStart: this.domainLookupStart,
            domainLookupEnd: this.domainLookupEnd,
            connectStart: this.connectStart,
            connectEnd: this.connectEnd,
            secureConnectionStart: this.secureConnectionStart,
            requestStart: this.requestStart,
            responseStart: this.responseStart,
            responseEnd: this.responseEnd,
            transferSize: this.transferSize,
            encodedBodySize: this.encodedBodySize,
            decodedBodySize: this.decodedBodySize
        };
    }
}

// ==================== Node-compatible Performance Timing ====================

class PerformanceNodeTiming extends PerformanceEntry<'node'> {
    readonly bootstrapComplete: number;
    readonly environment: number = 0;
    readonly idleTime: number = 0;
    readonly loopExit: number = 0;
    readonly loopStart: number = 0;
    readonly v8Start: number = 0;

    constructor() {
        super(constructorKey, 'node', 'node', 0, 0);
        this.bootstrapComplete = nativePerformanceNow();
    }
}

// ==================== PerformanceObserverEntryList ====================

class PerformanceObserverEntryList {
    #entries: globalThis.PerformanceEntry[];

    constructor(entries: globalThis.PerformanceEntry[]) {
        this.#entries = [...entries];
    }

    getEntries(): globalThis.PerformanceEntry[] {
        return [...this.#entries].sort((a, b) => a.startTime - b.startTime);
    }

    getEntriesByType(type: PerformanceEntryType): globalThis.PerformanceEntry[] {
        return this.#entries
            .filter(entry => entry.entryType === type)
            .sort((a, b) => a.startTime - b.startTime);
    }

    getEntriesByName(name: string, type?: PerformanceEntryType): globalThis.PerformanceEntry[] {
        return this.#entries
            .filter(entry => {
                if (entry.name !== name) return false;
                if (type !== undefined && entry.entryType !== type) return false;
                return true;
            })
            .sort((a, b) => a.startTime - b.startTime);
    }
}

// ==================== PerformanceObserver ====================

class PerformanceObserver {
    #callback: PerformanceObserverCallback;
    #observedTypes = new Set<PerformanceEntryType>();
    #connected = false;
    #buffered = false;

    static supportedEntryTypes: PerformanceEntryType[] = [
        'mark',
        'measure',
        'navigation',
        'resource',
        'paint',
        'frame',
        'function'
    ];

    constructor(callback: PerformanceObserverCallback) {
        if (typeof callback !== 'function') {
            throw new TypeError('Callback must be a function');
        }
        this.#callback = callback;
    }

    observe(options: PerformanceObserverInit): void {
        if (!options || typeof options !== 'object') {
            throw new TypeError('Options must be an object');
        }

        const { entryTypes, type, buffered } = options;

        if (entryTypes && type) {
            throw new TypeError('Cannot specify both entryTypes and type');
        }

        if (!entryTypes && !type) {
            throw new TypeError('Must specify either entryTypes or type');
        }

        const types = entryTypes ?? (type ? [type] : []);

        for (const entryType of types) {
            if (!PerformanceObserver.supportedEntryTypes.includes(entryType)) {
                console.warn(`Unsupported entry type: ${entryType}`);
                continue;
            }
            this.#observedTypes.add(entryType);
        }

        this.#buffered = buffered ?? false;
        this.#connected = true;

        const perf = currentPerformance();
        perf._registerObserver(this);

        if (this.#buffered) {
            const bufferedEntries = perf._getBufferedEntries(Array.from(this.#observedTypes));
            if (bufferedEntries.length > 0) {
                this._notify(bufferedEntries);
            }
        }
    }

    disconnect(): void {
        if (!this.#connected) return;

        this.#connected = false;
        this.#observedTypes.clear();

        const perf = currentPerformance();
        perf._unregisterObserver(this);
    }

    takeRecords(): globalThis.PerformanceEntry[] {
        const perf = currentPerformance();
        return perf._takeRecordsForObserver(this);
    }

    _notify(entries: globalThis.PerformanceEntry[]): void {
        if (!this.#connected) return;

        const filteredEntries = entries.filter(entry =>
            isPerformanceEntryType(entry.entryType) && this.#observedTypes.has(entry.entryType)
        );

        if (filteredEntries.length === 0) return;

        const list = new PerformanceObserverEntryList(filteredEntries);
        emitPerformanceObserverCallback(this.#callback, list, this);
    }

    _observes(type: PerformanceEntryType): boolean {
        return this.#connected && this.#observedTypes.has(type);
    }
}

// ==================== Performance ====================

class Performance extends EventTarget implements globalThis.Performance {
    #entries: globalThis.PerformanceEntry[] = [];
    #marks = new Map<string, PerformanceMark>();
    #observers = new Set<PerformanceObserver>();
    #pendingEntries = new Map<PerformanceObserver, globalThis.PerformanceEntry[]>();
    #timeOrigin: number;
    #resourceTimingBufferSize: number = 250;
    #navigationTiming: PerformanceNavigationTiming;
    #nodeTiming = new PerformanceNodeTiming();
    #onResourceTimingBufferFull: PerformanceEventHandler = null;
    #onResourceTimingBufferFullListener: EventListener | null = null;

    get nodeTiming(): PerformanceNodeTiming {
        return this.#nodeTiming;
    }

    markResourceTiming(
        this: Performance | undefined,
        timingInfo: { startTime?: number; endTime?: number; transferSize?: number; encodedBodySize?: number } = {},
        requestedUrl = '',
        initiatorType = 'other',
        _global?: unknown,
        _cacheMode?: string,
        bodyInfo?: { transferSize?: number; encodedBodySize?: number } | string,
        _responseStatus?: number,
    ): PerformanceResourceTiming {
        const performance = this instanceof Performance ? this : currentPerformance();
        const start = Number.isFinite(timingInfo.startTime) ? Number(timingInfo.startTime) : performance.now();
        const end = Number.isFinite(timingInfo.endTime) ? Number(timingInfo.endTime) : start;
        const body = bodyInfo && typeof bodyInfo === 'object' ? bodyInfo : timingInfo;
        const transferSize = Number.isFinite(body.transferSize)
            ? Number(body.transferSize)
            : Number.isFinite(body.encodedBodySize)
                ? Number(body.encodedBodySize)
                : 0;
        const entry = new PerformanceResourceTiming(
            String(requestedUrl),
            start,
            Math.max(0, end - start),
            String(initiatorType || 'other'),
            transferSize,
        );
        performance.#addEntry(entry);
        performance.#trimResourceTimings();
        return entry;
    }

    eventLoopUtilization(): EventLoopUtilization {
        return { idle: 0, active: 0, utilization: 0 };
    }

    timerify<T extends (...args: unknown[]) => unknown>(fn: T): T {
        if (typeof fn !== 'function') throw new TypeError('The "fn" argument must be of type function');
        const performance = this;
        const wrapped = function(this: unknown, ...args: unknown[]) {
            const start = performance.now();
            const record = () => {
                const duration = Math.max(0, performance.now() - start);
                performance.#addEntry(new PerformanceEntry(
                    constructorKey,
                    fn.name || 'anonymous',
                    'function',
                    start,
                    duration,
                    [...args],
                ));
            };
            try {
                const result = fn.apply(this, args);
                if (isThenable(result)) {
                    return result.then(
                        (value) => {
                            record();
                            return value;
                        },
                        (error) => {
                            record();
                            throw error;
                        },
                    );
                }
                record();
                return result;
            } catch (error) {
                record();
                throw error;
            }
        };
        setFunctionNameQuietly(wrapped, `timerified ${fn.name || 'anonymous'}`);
        return wrapped as T;
    }

    get onresourcetimingbufferfull(): PerformanceEventHandler {
        return this.#onResourceTimingBufferFull;
    }

    set onresourcetimingbufferfull(handler: PerformanceEventHandler) {
        if (this.#onResourceTimingBufferFullListener) {
            this.removeEventListener('resourcetimingbufferfull', this.#onResourceTimingBufferFullListener);
            this.#onResourceTimingBufferFullListener = null;
        }
        if (typeof handler !== 'function') {
            this.#onResourceTimingBufferFull = null;
            return;
        }

        const listener: EventListener = (event) => handler.call(this, event);
        this.#onResourceTimingBufferFull = handler;
        this.#onResourceTimingBufferFullListener = listener;
        this.addEventListener('resourcetimingbufferfull', listener);
    }

    // Navigation Timing (deprecated but widely used)
    readonly timing: {
        navigationStart: number;
        unloadEventStart: number;
        unloadEventEnd: number;
        redirectStart: number;
        redirectEnd: number;
        fetchStart: number;
        domainLookupStart: number;
        domainLookupEnd: number;
        connectStart: number;
        connectEnd: number;
        secureConnectionStart: number;
        requestStart: number;
        responseStart: number;
        responseEnd: number;
        domLoading: number;
        domInteractive: number;
        domContentLoadedEventStart: number;
        domContentLoadedEventEnd: number;
        domComplete: number;
        loadEventStart: number;
        loadEventEnd: number;
    };

    // Navigation object (deprecated)
    readonly navigation: {
        type: number;
        redirectCount: number;
    };

    constructor(key: object) {
        if (key !== constructorKey) throw new TypeError('Illegal constructor');
        super();
        const startTime = nativePerformanceNow();
        this.#timeOrigin = Date.now() - startTime;

        this.#navigationTiming = new PerformanceNavigationTiming();
        this.#entries.push(this.#navigationTiming);

        this.timing = {
            navigationStart: 0,
            unloadEventStart: 0,
            unloadEventEnd: 0,
            redirectStart: 0,
            redirectEnd: 0,
            fetchStart: 0,
            domainLookupStart: 0,
            domainLookupEnd: 0,
            connectStart: 0,
            connectEnd: 0,
            secureConnectionStart: 0,
            requestStart: 0,
            responseStart: 0,
            responseEnd: 0,
            domLoading: 0,
            domInteractive: startTime,
            domContentLoadedEventStart: startTime,
            domContentLoadedEventEnd: startTime,
            domComplete: startTime,
            loadEventStart: startTime,
            loadEventEnd: startTime
        };

        this.navigation = {
            type: 0, // TYPE_NAVIGATE
            redirectCount: 0
        };
    }

    now(): number {
        return nativePerformanceNow();
    }

    get timeOrigin(): number {
        return this.#timeOrigin;
    }

    // ==================== User Timing API ====================

    mark(markName: string, options?: PerformanceMarkOptions): PerformanceMark {
        if (arguments.length === 0) {
            throw new TypeError('Failed to execute \'mark\' on \'Performance\': 1 argument required, but only 0 present.');
        }

        const name = String(markName);

        // Prevent reserved names
        if (name.startsWith('mark_')) {
            console.warn(`Mark name "${name}" starts with reserved prefix "mark_"`);
        }

        const mark = new PerformanceMark(name, options);
        this.#marks.set(name, mark);
        this.#addEntry(mark);

        return mark;
    }

    clearMarks(markName?: string): void {
        if (markName !== undefined) {
            const name = String(markName);
            this.#marks.delete(name);
            this.#entries = this.#entries.filter(
                entry => !(entry.entryType === 'mark' && entry.name === name)
            );
        } else {
            this.#marks.clear();
            this.#entries = this.#entries.filter(entry => entry.entryType !== 'mark');
        }
    }

    measure(
        measureName: string,
        startOrOptions?: string | PerformanceMeasureOptions,
        endMark?: string
    ): PerformanceMeasure {
        if (arguments.length === 0) {
            throw new TypeError('Failed to execute \'measure\' on \'Performance\': 1 argument required, but only 0 present.');
        }

        const name = String(measureName);
        let startTime: number;
        let endTime: number;
        let detail: unknown;

        if (typeof startOrOptions === 'object' && startOrOptions !== null) {
            const options = startOrOptions;
            detail = options.detail;

            if (options.start !== undefined) {
                startTime = this.#resolveTimestamp(options.start);
            } else {
                startTime = 0;
            }

            if (options.duration !== undefined && options.end !== undefined) {
                throw new TypeError('Cannot specify both duration and end');
            }

            if (options.duration !== undefined) {
                const duration = Number(options.duration);
                if (duration < 0) {
                    throw new TypeError('Duration cannot be negative');
                }
                endTime = startTime + duration;
            } else if (options.end !== undefined) {
                endTime = this.#resolveTimestamp(options.end);
            } else {
                endTime = this.now();
            }
        } else {
            startTime = startOrOptions !== undefined
                ? this.#resolveTimestamp(startOrOptions)
                : 0;

            endTime = endMark !== undefined
                ? this.#resolveTimestamp(endMark)
                : this.now();
        }

        if (endTime < startTime) {
            throw new DOMException(
                `Failed to execute 'measure': The end time (${endTime}) is before the start time (${startTime}).`,
                'InvalidAccessError'
            );
        }

        const duration = endTime - startTime;
        const measure = new PerformanceMeasure(constructorKey, name, startTime, duration, detail);
        this.#addEntry(measure);

        return measure;
    }

    clearMeasures(measureName?: string): void {
        if (measureName !== undefined) {
            const name = String(measureName);
            this.#entries = this.#entries.filter(
                entry => !(entry.entryType === 'measure' && entry.name === name)
            );
        } else {
            this.#entries = this.#entries.filter(entry => entry.entryType !== 'measure');
        }
    }

    // ==================== Performance Timeline API ====================

    getEntries(): globalThis.PerformanceEntryList {
        return [...this.#entries].sort((a, b) => a.startTime - b.startTime);
    }

    getEntriesByType(type: PerformanceEntryType): globalThis.PerformanceEntryList {
        return this.#entries
            .filter(entry => entry.entryType === type)
            .sort((a, b) => a.startTime - b.startTime);
    }

    getEntriesByName(name: string, type?: PerformanceEntryType): globalThis.PerformanceEntryList {
        return this.#entries
            .filter(entry => {
                if (entry.name !== name) return false;
                if (type !== undefined && entry.entryType !== type) return false;
                return true;
            })
            .sort((a, b) => a.startTime - b.startTime);
    }

    // ==================== Resource Timing API ====================

    clearResourceTimings(): void {
        this.#entries = this.#entries.filter(entry => entry.entryType !== 'resource');
    }

    setResourceTimingBufferSize(maxSize: number): void {
        if (arguments.length === 0) {
            throw new TypeError('Failed to execute setResourceTimingBufferSize: 1 argument required');
        }
        const size = Number(maxSize);
        if (size < 0 || !Number.isInteger(size)) {
            throw new TypeError('Buffer size must be a non-negative integer');
        }
        this.#resourceTimingBufferSize = size;
        this.#trimResourceTimings();
    }

    #trimResourceTimings(): void {
        const resourceEntries = this.#entries.filter(e => e.entryType === 'resource');
        if (resourceEntries.length > this.#resourceTimingBufferSize) {
            const toRemove = resourceEntries.slice(
                0,
                resourceEntries.length - this.#resourceTimingBufferSize
            );
            this.#entries = this.#entries.filter(e => !toRemove.includes(e));
            this.dispatchEvent(new Event('resourcetimingbufferfull'));
        }
    }

    // Public API to add resource timing
    addResourceTiming(
        name: string,
        initiatorType: string,
        startTime?: number,
        duration?: number,
        transferSize?: number
    ): void {
        const start = startTime ?? this.now();
        const dur = duration ?? 0;
        const entry = new PerformanceResourceTiming(
            name,
            start,
            dur,
            initiatorType,
            transferSize
        );
        this.#addEntry(entry);
        this.#trimResourceTimings();
    }

    // ==================== Utilities ====================

    toJSON(): object {
        return {
            timeOrigin: this.timeOrigin
        };
    }

    [denoCustomInspect]() {
        if (!(this instanceof Performance)) return 'Performance {}';
        return `Performance ${console.inspect(this.toJSON(), { colors: false })}`;
    }

    #resolveTimestamp(markNameOrTimestamp: string | number): number {
        if (typeof markNameOrTimestamp === 'number') {
            return markNameOrTimestamp;
        }

        const name = String(markNameOrTimestamp);

        // Check for navigation timing properties
        const timingValue = this.timing[name as keyof typeof this.timing];
        if (timingValue !== undefined) {
            return timingValue;
        }

        // Check for marks
        const mark = this.#marks.get(name);
        if (!mark) {
            throw new DOMException(
                `Failed to execute 'measure' on 'Performance': The mark '${name}' does not exist.`,
                'SyntaxError'
            );
        }

        return mark.startTime;
    }

    #addEntry(entry: globalThis.PerformanceEntry): void {
        this.#entries.push(entry);
        if (entry.entryType === 'resource') {
            const resourceEntries = this.#entries.filter(e => e.entryType === 'resource');
            if (resourceEntries.length >= this.#resourceTimingBufferSize) {
                this.dispatchEvent(new Event('resourcetimingbufferfull'));
            }
        }
        // Cap marks/measures to prevent unbounded growth
        if (entry.entryType === 'mark' || entry.entryType === 'measure') {
            const typed = this.#entries.filter(e => e.entryType === entry.entryType);
            if (typed.length > 1000) {
                const toRemove = typed.length - 1000;
                let removed = 0;
                this.#entries = this.#entries.filter(e => {
                    if (removed < toRemove && e.entryType === entry.entryType) {
                        removed++;
                        return false;
                    }
                    return true;
                });
            }
        }

        for (const observer of this.#observers) {
            if (isPerformanceEntryType(entry.entryType) && observer._observes(entry.entryType)) {
                const entries = this.#pendingEntries.get(observer) ?? [];
                entries.push(entry);
                this.#pendingEntries.set(observer, entries);
            }
        }

        queueMicrotask(() => this.#flushObserverNotifications());
    }

    #flushObserverNotifications(): void {
        for (const [observer, entries] of this.#pendingEntries.entries()) {
            if (entries.length > 0) {
                observer._notify(entries);
            }
        }
        this.#pendingEntries.clear();
    }

    // ==================== Observer Management ====================

    _registerObserver(observer: PerformanceObserver): void {
        this.#observers.add(observer);
    }

    _unregisterObserver(observer: PerformanceObserver): void {
        this.#observers.delete(observer);
        this.#pendingEntries.delete(observer);
    }

    _getBufferedEntries(types: PerformanceEntryType[]): globalThis.PerformanceEntry[] {
        return this.#entries.filter(entry => isPerformanceEntryType(entry.entryType) && types.includes(entry.entryType));
    }

    _takeRecordsForObserver(observer: PerformanceObserver): globalThis.PerformanceEntry[] {
        const entries = this.#pendingEntries.get(observer) ?? [];
        this.#pendingEntries.delete(observer);
        return entries;
    }
}

Object.defineProperty(Performance, 'length', { value: 0, configurable: true });
Object.defineProperty(PerformanceEntry, 'length', { value: 0, configurable: true });

const performanceInstance = new Performance(constructorKey);

// Preserve native now() function
const originalNow = nativePerformanceNow;
Reflect.set(performanceInstance, 'now', originalNow);

// Replace global performance
Reflect.deleteProperty(globalThis, 'performance');
Reflect.set(globalThis, 'performance', performanceInstance);
Reflect.set(globalThis, 'Performance', Performance);
Reflect.set(globalThis, 'PerformanceEntry', PerformanceEntry);
Reflect.set(globalThis, 'PerformanceMark', PerformanceMark);
Reflect.set(globalThis, 'PerformanceMeasure', PerformanceMeasure);
Reflect.set(globalThis, 'PerformanceObserver', PerformanceObserver);
Reflect.set(globalThis, 'PerformanceObserverEntryList', PerformanceObserverEntryList);
Reflect.set(globalThis, 'PerformanceNavigationTiming', PerformanceNavigationTiming);
Reflect.set(globalThis, 'PerformanceResourceTiming', PerformanceResourceTiming);
Reflect.set(globalThis, 'PerformanceNodeTiming', PerformanceNodeTiming);
