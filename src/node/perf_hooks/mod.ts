/**
 * Node.js perf_hooks module
 * Performance measurement hooks
 */

export const constants = {
    NODE_PERFORMANCE_GC_MAJOR: 4,
    NODE_PERFORMANCE_GC_MINOR: 1,
    NODE_PERFORMANCE_GC_INCREMENTAL: 8,
    NODE_PERFORMANCE_GC_WEAKCB: 16,
    NODE_PERFORMANCE_GC_FLAGS_NO: 0,
    NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
    NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
    NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
    NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
    NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
    NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
};

type EntryType = 'mark' | 'measure' | 'function' | 'resource';
type ObserverOptions = { entryTypes?: string[]; type?: string; buffered?: boolean };

class PerformanceEntryRecord implements PerformanceEntry {
    name: string;
    entryType: string;
    startTime: number;
    duration: number;
    detail?: unknown;

    constructor(name: string, entryType: string, startTime: number, duration: number, detail?: unknown) {
        this.name = name;
        this.entryType = entryType;
        this.startTime = startTime;
        this.duration = duration;
        if (detail !== undefined) this.detail = detail;
    }
}

class PerformanceResourceTimingRecord extends PerformanceEntryRecord {
    initiatorType: string;
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;

    constructor(name: string, startTime: number, duration: number, initiatorType: string, transferSize: number) {
        super(name, 'resource', startTime, duration);
        this.initiatorType = initiatorType;
        this.transferSize = transferSize;
        this.encodedBodySize = transferSize;
        this.decodedBodySize = transferSize;
    }
}

class EntryList implements PerformanceObserverEntryList {
    private readonly _entries: PerformanceEntry[];

    constructor(entries: PerformanceEntry[]) {
        this._entries = entries;
    }

    getEntries(): PerformanceEntry[] {
        return [...this._entries];
    }

    getEntriesByName(name: string, type?: string): PerformanceEntry[] {
        return this._entries.filter((entry) => entry.name === name && (type === undefined || entry.entryType === type));
    }

    getEntriesByType(type: string): PerformanceEntry[] {
        return this._entries.filter((entry) => entry.entryType === type);
    }
}

type ObserverState = {
    callback: (list: PerformanceObserverEntryList, observer: PerformanceObserver) => void;
    entryTypes: Set<string>;
    records: PerformanceEntry[];
};

const marks = new Map<string, PerformanceEntryRecord>();
const entries: PerformanceEntryRecord[] = [];
const observers = new WeakMap<PerformanceObserver, ObserverState>();
const activeObservers = new Set<PerformanceObserver>();

function notifyObservers(entry: PerformanceEntryRecord): void {
    for (const observer of activeObservers) {
        const state = observers.get(observer);
        if (!state || !state.entryTypes.has(entry.entryType)) continue;
        state.records.push(entry);
        state.callback(new EntryList([entry]), observer);
    }
}

function addEntry(entry: PerformanceEntryRecord): PerformanceEntryRecord {
    entries.push(entry);
    if (entry.entryType === 'mark') marks.set(entry.name, entry);
    notifyObservers(entry);
    return entry;
}

function getEntriesByName(name: string, type?: string): PerformanceEntryRecord[] {
    return entries.filter((entry) => entry.name === name && (type === undefined || entry.entryType === type));
}

function getEntriesByType(type: string): PerformanceEntryRecord[] {
    return entries.filter((entry) => entry.entryType === type);
}

function clearEntries(type: EntryType, name?: string): void {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry === undefined) continue;
        if (entry.entryType !== type) continue;
        if (name !== undefined && entry.name !== name) continue;
        entries.splice(i, 1);
    }
    if (type === 'mark') {
        if (name !== undefined) marks.delete(name);
        else marks.clear();
    }
}

function now(): number {
    return globalThis.performance?.now?.() ?? Date.now();
}

function missingMark(name: string): SyntaxError & { code?: number } {
    const error = new SyntaxError(`The "${name}" performance mark has not been set`) as SyntaxError & { code?: number };
    error.code = 12;
    return error;
}

export class PerformanceObserver {
    static supportedEntryTypes = ['mark', 'measure', 'function', 'resource'];

    constructor(callback: (list: PerformanceObserverEntryList, observer: PerformanceObserver) => void) {
        observers.set(this, {
            callback,
            entryTypes: new Set(),
            records: [],
        });
    }

    observe(options: ObserverOptions): void {
        const state = observers.get(this);
        if (!state) return;
        if (options === undefined) {
            throw new TypeError('The "options.entryTypes" and "options.type" arguments must be specified');
        }
        if (options === null || typeof options !== 'object') {
            throw new TypeError('The "options" argument must be of type object');
        }
        if (options.entryTypes !== undefined && options.type !== undefined) {
            throw new TypeError("The property 'options.entryTypes' options.entryTypes can not set with options.type together");
        }
        if (options.entryTypes !== undefined && !Array.isArray(options.entryTypes)) {
            throw new TypeError('The "options.entryTypes" property must be string[]');
        }
        if (options.entryTypes === undefined && options.type === undefined) {
            throw new TypeError('The "options.entryTypes" and "options.type" arguments must be specified');
        }
        const entryTypes = options.entryTypes ?? (options.type ? [options.type] : []);
        state.entryTypes = new Set(entryTypes);
        activeObservers.add(this);
        if (options.buffered) {
            const buffered = entries.filter((entry) => state.entryTypes.has(entry.entryType));
            if (buffered.length > 0) {
                state.records.push(...buffered);
                state.callback(new EntryList(buffered), this);
            }
        }
    }

    disconnect(): void {
        activeObservers.delete(this);
    }

    takeRecords(): PerformanceEntry[] {
        const state = observers.get(this);
        if (!state) return [];
        const records = [...state.records];
        state.records.length = 0;
        return records;
    }
}

export interface PerformanceObserverEntryList {
    getEntries(): PerformanceEntry[];
    getEntriesByName(name: string, type?: string): PerformanceEntry[];
    getEntriesByType(type: string): PerformanceEntry[];
}

export interface PerformanceEntry {
    name: string;
    entryType: string;
    startTime: number;
    duration: number;
    detail?: unknown;
}

export class PerformanceNodeTiming {
    readonly name = 'node';
    readonly entryType = 'node';
    readonly startTime = 0;
    readonly duration = 0;
    readonly bootstrapComplete: number = now();
    readonly environment: number = 0;
    readonly idleTime: number = 0;
    readonly loopExit: number = 0;
    readonly loopStart: number = 0;
    readonly v8Start: number = 0;
}

const timeOrigin = globalThis.performance?.timeOrigin ?? Date.now();

export const performance = {
    get timeOrigin() { return timeOrigin; },
    now,
    mark(name: string, options?: { detail?: unknown }): PerformanceEntry {
        return addEntry(new PerformanceEntryRecord(name, 'mark', now(), 0, options?.detail));
    },
    measure(name: string, startMark?: string, endMark?: string): PerformanceEntry {
        const start = startMark === undefined ? undefined : marks.get(startMark);
        if (startMark !== undefined && !start) throw missingMark(startMark);
        const end = endMark === undefined ? undefined : marks.get(endMark);
        if (endMark !== undefined && !end) throw missingMark(endMark);
        const startTime = start?.startTime ?? 0;
        const endTime = end?.startTime ?? now();
        return addEntry(new PerformanceEntryRecord(name, 'measure', startTime, Math.max(0, endTime - startTime)));
    },
    clearMarks(markName?: string): void { clearEntries('mark', markName); },
    clearMeasures(measureName?: string): void { clearEntries('measure', measureName); },
    clearResourceTimings(): void { clearEntries('resource'); },
    getEntries(): PerformanceEntry[] { return [...entries]; },
    getEntriesByName(name: string, type?: string): PerformanceEntry[] { return getEntriesByName(name, type); },
    getEntriesByType(type: string): PerformanceEntry[] { return getEntriesByType(type); },
    markResourceTiming(
        timingInfo: { startTime?: number; endTime?: number; transferSize?: number; encodedBodySize?: number } = {},
        requestedUrl = '',
        initiatorType = 'other',
        _global?: unknown,
        _cacheMode?: string,
        bodyInfo?: { transferSize?: number; encodedBodySize?: number } | string,
        _responseStatus?: number,
    ): PerformanceEntry {
        const start = Number.isFinite(timingInfo.startTime) ? Number(timingInfo.startTime) : now();
        const end = Number.isFinite(timingInfo.endTime) ? Number(timingInfo.endTime) : start;
        const body = bodyInfo && typeof bodyInfo === 'object' ? bodyInfo : timingInfo;
        const transferSize = Number.isFinite(body.transferSize)
            ? Number(body.transferSize)
            : Number.isFinite(body.encodedBodySize)
                ? Number(body.encodedBodySize)
                : 0;
        return addEntry(new PerformanceResourceTimingRecord(
            String(requestedUrl),
            start,
            Math.max(0, end - start),
            String(initiatorType || 'other'),
            transferSize,
        ));
    },
    nodeTiming: new PerformanceNodeTiming(),
    eventLoopUtilization(): { idle: number; active: number; utilization: number } {
        return { idle: 0, active: 0, utilization: 0 };
    },
    timerify<T extends (...args: unknown[]) => unknown>(fn: T): T {
        if (typeof fn !== 'function') throw new TypeError('The "fn" argument must be of type function');
        const wrapped = function(this: unknown, ...args: unknown[]) {
            const start = now();
            const record = (duration: number) => {
                addEntry(new PerformanceEntryRecord(fn.name || 'anonymous', 'function', start, duration, [...args]));
            };
            try {
                const result = fn.apply(this, args);
                if (result && typeof result.then === 'function') {
                    return result.then(
                        (value: unknown) => {
                            record(Math.max(0, now() - start));
                            return value;
                        },
                        (error: unknown) => {
                            record(Math.max(0, now() - start));
                            throw error;
                        },
                    );
                }
                record(Math.max(0, now() - start));
                return result;
            } catch (error) {
                record(Math.max(0, now() - start));
                throw error;
            }
        };
        try {
            Object.defineProperty(wrapped, 'name', { value: `timerified ${fn.name || 'anonymous'}`, configurable: true });
        } catch {}
        return wrapped as T;
    },
};

export interface IntervalHistogram {
    readonly count: number;
    readonly min: number;
    readonly minBigInt: bigint;
    readonly max: number;
    readonly maxBigInt: bigint;
    readonly mean: number;
    readonly stddev: number;
    readonly percentiles: Map<number, number>;
    readonly exceeds: number;
    enable(): boolean;
    disable(): boolean;
    reset(): void;
    percentile(percentile: number): number;
    percentileBigInt(percentile: number): bigint;
}

export interface RecordableHistogram extends IntervalHistogram {
    record(value: number): void;
}

export function createHistogram(): RecordableHistogram {
    const samples: number[] = [];
    const histogram: RecordableHistogram = {
        get min() { return samples.length ? Math.min(...samples) : 0; },
        get minBigInt() { return BigInt(Math.trunc(histogram.min)); },
        get max() { return samples.length ? Math.max(...samples) : 0; },
        get maxBigInt() { return BigInt(Math.trunc(histogram.max)); },
        get mean() { return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0; },
        get stddev() {
            if (!samples.length) return 0;
            const m = histogram.mean;
            return Math.sqrt(samples.reduce((a, b) => a + (b - m) ** 2, 0) / samples.length);
        },
        get percentiles() {
            const sorted = [...samples].sort((a, b) => a - b);
            const m = new Map<number, number>();
            for (const p of [50, 75, 90, 95, 99, 99.9]) {
                const idx = Math.ceil(p / 100 * sorted.length) - 1;
                m.set(p, sorted[Math.max(0, idx)] ?? 0);
            }
            return m;
        },
        get exceeds() { return 0; },
        get count() { return samples.length; },
        enable() { return true; },
        disable() { return true; },
        reset() { samples.length = 0; },
        percentile(p: number) {
            const sorted = [...samples].sort((a, b) => a - b);
            const idx = Math.ceil(p / 100 * sorted.length) - 1;
            return sorted[Math.max(0, idx)] ?? 0;
        },
        percentileBigInt(p: number) {
            return BigInt(Math.trunc(histogram.percentile(p)));
        },
        record(value: number) {
            samples.push(value);
        },
    };
    return histogram;
}

export function monitorEventLoopDelay(options?: { resolution?: number }): IntervalHistogram {
    const resolution = options?.resolution ?? 10;
    let enabled = false;
    let _timer: ReturnType<typeof setInterval> | undefined;
    const samples: number[] = [];
    let _lastTime = performance.now();

    const hist: IntervalHistogram = {
        get count() { return samples.length; },
        get min() { return samples.length ? Math.min(...samples) : 0; },
        get minBigInt() { return BigInt(Math.trunc(hist.min)); },
        get max() { return samples.length ? Math.max(...samples) : 0; },
        get maxBigInt() { return BigInt(Math.trunc(hist.max)); },
        get mean() { return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0; },
        get stddev() {
            if (!samples.length) return 0;
            const m = hist.mean;
            return Math.sqrt(samples.reduce((a, b) => a + (b - m) ** 2, 0) / samples.length);
        },
        get percentiles() {
            const sorted = [...samples].sort((a, b) => a - b);
            const m = new Map<number, number>();
            for (const p of [50, 75, 90, 95, 99, 99.9]) {
                const idx = Math.ceil(p / 100 * sorted.length) - 1;
                m.set(p, sorted[Math.max(0, idx)] ?? 0);
            }
            return m;
        },
        get exceeds() { return 0; },
        percentile(p: number) {
            const sorted = [...samples].sort((a, b) => a - b);
            const idx = Math.ceil(p / 100 * sorted.length) - 1;
            return sorted[Math.max(0, idx)] ?? 0;
        },
        percentileBigInt(p: number) {
            return BigInt(Math.trunc(hist.percentile(p)));
        },
        enable() {
            if (enabled) return false;
            enabled = true;
            _lastTime = performance.now();
            _timer = setInterval(() => {
                const now = performance.now();
                samples.push(Math.max(1, now - _lastTime));
                if (samples.length > 1000) samples.shift();
                _lastTime = now;
            }, resolution);
            return true;
        },
        disable() {
            if (!enabled) return false;
            enabled = false;
            clearInterval(_timer);
            return true;
        },
        reset() { samples.length = 0; },
    };
    return hist;
}
