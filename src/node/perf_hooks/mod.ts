/**
 * Node.js perf_hooks module
 * The spec surface (performance, marks, measures, observers, entry classes)
 * delegates to the WebAPI implementation on globalThis, so both share one
 * entry buffer and one set of classes — as Node does.
 */

type UnknownFn = (...args: unknown[]) => unknown;
type EventLoopUtilization = { idle: number; active: number; utilization: number };

const NS_PER_MS = 1e6;
// Node reports INT64_MAX as `min` while a histogram is still empty.
const EMPTY_MIN = 9223372036854775807;
const EMPTY_MIN_BIGINT = 9223372036854775807n;
const PERCENTILE_KEYS = [0, 25, 50, 75, 90, 99, 99.9, 100];

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

function outOfRange(name: string, range: string, actual: unknown): RangeError {
    const error = new RangeError(
        `The value of "${name}" is out of range. It must be ${range}. Received ${String(actual)}`,
    );
    return Object.assign(error, { code: 'ERR_OUT_OF_RANGE' });
}

function assertPercentile(value: number): void {
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0 || value > 100) {
        throw outOfRange('percentile', '> 0 && <= 100', value);
    }
}

/** Shared sample store behind createHistogram() and monitorEventLoopDelay(). */
class HistogramBase {
    protected _samples: number[] = [];

    get count(): number { return this._samples.length; }
    get countBigInt(): bigint { return BigInt(this._samples.length); }
    get exceeds(): number { return 0; }
    get exceedsBigInt(): bigint { return 0n; }

    get min(): number { return this._samples.length ? Math.min(...this._samples) : EMPTY_MIN; }
    get minBigInt(): bigint {
        return this._samples.length ? BigInt(Math.trunc(this.min)) : EMPTY_MIN_BIGINT;
    }

    get max(): number { return this._samples.length ? Math.max(...this._samples) : 0; }
    get maxBigInt(): bigint { return BigInt(Math.trunc(this.max)); }

    // Node returns NaN (not 0) for mean/stddev of an empty histogram.
    get mean(): number {
        if (!this._samples.length) return NaN;
        return this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    }

    get stddev(): number {
        if (!this._samples.length) return NaN;
        const m = this.mean;
        return Math.sqrt(this._samples.reduce((a, b) => a + (b - m) ** 2, 0) / this._samples.length);
    }

    percentile(p: number): number {
        assertPercentile(p);
        if (!this._samples.length) return 0;
        const sorted = [...this._samples].sort((a, b) => a - b);
        const idx = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.min(sorted.length - 1, Math.max(0, idx))] ?? 0;
    }

    percentileBigInt(p: number): bigint { return BigInt(Math.trunc(this.percentile(p))); }

    get percentiles(): Map<number, number> {
        const out = new Map<number, number>();
        if (!this._samples.length) {
            out.set(100, 0);
            return out;
        }
        for (const p of PERCENTILE_KEYS) {
            out.set(p, p === 0 ? this.min : this.percentile(p));
        }
        return out;
    }

    get percentilesBigInt(): Map<number, bigint> {
        const out = new Map<number, bigint>();
        for (const [p, v] of this.percentiles) out.set(p, BigInt(Math.trunc(v)));
        return out;
    }

    reset(): void { this._samples.length = 0; }

    toJSON(): Record<string, unknown> {
        return {
            count: this.count,
            min: this.min,
            max: this.max,
            mean: this.mean,
            exceeds: this.exceeds,
            stddev: this.stddev,
            percentiles: Object.fromEntries(this.percentiles),
        };
    }
}

export class RecordableHistogram extends HistogramBase {
    #last = 0;

    record(value: number | bigint): void {
        const val = typeof value === 'bigint' ? Number(value) : value;
        if (typeof val !== 'number' || !Number.isInteger(val)) {
            throw outOfRange('val', 'an integer', value);
        }
        if (val < 1 || val > Number.MAX_SAFE_INTEGER) {
            throw outOfRange('val', '>= 1 && <= 9007199254740991', value);
        }
        this._samples.push(val);
    }

    /** Records the ns elapsed since the previous recordDelta() call. */
    recordDelta(): void {
        const nowNs = Math.round(nowMs() * NS_PER_MS);
        if (this.#last !== 0) this._samples.push(Math.max(1, nowNs - this.#last));
        this.#last = nowNs;
    }

    add(other: RecordableHistogram): void {
        if (!(other instanceof RecordableHistogram)) {
            throw new TypeError('The "other" argument must be an instance of RecordableHistogram');
        }
        this._samples.push(...other._samples);
    }
}

export class IntervalHistogram extends HistogramBase {
    #resolution: number;
    #timer: ReturnType<typeof setInterval> | undefined;
    #last = 0;
    #enabled = false;

    constructor(resolution: number) {
        super();
        this.#resolution = resolution;
    }

    enable(): boolean {
        if (this.#enabled) return false;
        this.#enabled = true;
        this.#last = nowMs();
        this.#timer = setInterval(() => {
            const now = nowMs();
            // Node's histogram is in NANOSECONDS and holds integers.
            this._samples.push(Math.max(1, Math.round((now - this.#last) * NS_PER_MS)));
            if (this._samples.length > 1000) this._samples.shift();
            this.#last = now;
        }, this.#resolution);
        return true;
    }

    disable(): boolean {
        if (!this.#enabled) return false;
        this.#enabled = false;
        clearInterval(this.#timer);
        this.#timer = undefined;
        return true;
    }
}

export function createHistogram(): RecordableHistogram {
    return new RecordableHistogram();
}

export function monitorEventLoopDelay(options?: { resolution?: number }): IntervalHistogram {
    const resolution = options?.resolution ?? 10;
    if (typeof resolution !== 'number' || !Number.isInteger(resolution) || resolution < 1) {
        throw outOfRange('options.resolution', '>= 1', resolution);
    }
    return new IntervalHistogram(resolution);
}

function globalFn(name: string): UnknownFn | undefined {
    const value = Reflect.get(globalThis, name);
    return typeof value === 'function' ? (value as UnknownFn) : undefined;
}

function nowMs(): number {
    const perf = Reflect.get(globalThis, 'performance');
    if (perf && typeof perf === 'object') {
        const fn = Reflect.get(perf, 'now');
        if (typeof fn === 'function') return Number(Reflect.apply(fn, perf, []));
    }
    return Date.now();
}

/**
 * Node's `perf_hooks.performance` IS `globalThis.performance`. Reusing the
 * WebAPI instance keeps one entry buffer, real PerformanceMark/Measure classes,
 * spec measure() options, DOMException errors and deferred observer dispatch.
 */
type NodePerformance = Performance & {
    nodeTiming: Record<string, unknown>;
    timerify<T extends UnknownFn>(fn: T, options?: { histogram?: RecordableHistogram }): T;
    eventLoopUtilization(a?: EventLoopUtilization, b?: EventLoopUtilization): EventLoopUtilization;
};

const globalPerformance = Reflect.get(globalThis, 'performance');
if (!globalPerformance || typeof globalPerformance !== 'object') {
    throw new Error('node:perf_hooks requires globalThis.performance (webapi bootstrap missing)');
}

export const performance = globalPerformance as NodePerformance;

/** Module-level aliases Node also exports. */
export function timerify<T extends UnknownFn>(fn: T, options?: { histogram?: RecordableHistogram }): T {
    return performance.timerify(fn, options);
}

export function eventLoopUtilization(
    a?: EventLoopUtilization,
    b?: EventLoopUtilization,
): EventLoopUtilization {
    return performance.eventLoopUtilization(a, b);
}

// Entry classes come from the WebAPI layer so `instanceof` works across both.
export const Performance = globalFn('Performance');
export const PerformanceEntry = globalFn('PerformanceEntry');
export const PerformanceMark = globalFn('PerformanceMark');
export const PerformanceMeasure = globalFn('PerformanceMeasure');
export const PerformanceObserver = globalFn('PerformanceObserver');
export const PerformanceObserverEntryList = globalFn('PerformanceObserverEntryList');
export const PerformanceResourceTiming = globalFn('PerformanceResourceTiming');
export const PerformanceNodeTiming = globalFn('PerformanceNodeTiming');
