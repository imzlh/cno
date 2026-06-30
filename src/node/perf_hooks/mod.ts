/**
 * Node.js perf_hooks module
 * Performance measurement hooks
 */

export const constants = {
    NODE_PERFORMANCE_ENTRY_TYPE_GC: 'gc',
    NODE_PERFORMANCE_ENTRY_TYPE_HTTP: 'http',
    NODE_PERFORMANCE_ENTRY_TYPE_HTTP2: 'http2',
    NODE_PERFORMANCE_ENTRY_TYPE_NET: 'net',
    NODE_PERFORMANCE_ENTRY_TYPE_DNS: 'dns',
    NODE_PERFORMANCE_MILESTONE_TIMESTAMP_RESOLUTION: 1,
    NODE_PERFORMANCE_GC_MAJOR: 'major',
    NODE_PERFORMANCE_GC_MINOR: 'minor',
    NODE_PERFORMANCE_GC_INCREMENTAL: 'incremental',
    NODE_PERFORMANCE_GC_WEAKCB: 'weakcb',
};

function now(): number {
    return globalThis.performance?.now?.() ?? Date.now();
}

export class PerformanceObserver {
    constructor(_callback: (list: PerformanceObserverEntryList, observer: PerformanceObserver) => void) {}
    observe(_options: { entryTypes?: string[]; type?: string; buffered?: boolean }): void {}
    disconnect(): void {}
    takeRecords(): PerformanceEntry[] { return []; }
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

export const performance = {
    timeOrigin: globalThis.performance?.timeOrigin ?? Date.now(),
    now,
    mark(name: string): void { globalThis.performance?.mark?.(name); },
    measure(name: string, startMark: string, endMark?: string): void {
        globalThis.performance?.measure?.(name, startMark, endMark);
    },
    clearMarks(markName?: string): void { globalThis.performance?.clearMarks?.(markName); },
    clearMeasures(measureName?: string): void { globalThis.performance?.clearMeasures?.(measureName); },
    getEntries(): PerformanceEntry[] { return []; },
    getEntriesByName(name: string, type?: string): PerformanceEntry[] { return []; },
    getEntriesByType(type: string): PerformanceEntry[] { return []; },
    nodeTiming: new PerformanceNodeTiming(),
    eventLoopUtilization(): { idle: number; active: number; utilization: number } {
        return { idle: 0, active: 0, utilization: 0 };
    },
    timerify<T extends (...args: any[]) => any>(fn: T): T { return fn; },
};

export interface IntervalHistogram {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly stddev: number;
    readonly percentiles: Map<number, number>;
    readonly exceeds: number;
    enable(): boolean;
    disable(): boolean;
    reset(): void;
    percentile(percentile: number): number;
}

export function monitorEventLoopDelay(options?: { resolution?: number }): IntervalHistogram {
    const resolution = options?.resolution ?? 10;
    let enabled = false;
    let _timer: any;
    const samples: number[] = [];
    let _lastTime = performance.now();

    const hist: IntervalHistogram = {
        get min() { return samples.length ? Math.min(...samples) : 0; },
        get max() { return samples.length ? Math.max(...samples) : 0; },
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
        enable() {
            if (enabled) return false;
            enabled = true;
            _lastTime = performance.now();
            _timer = setInterval(() => {
                const now = performance.now();
                samples.push(now - _lastTime - resolution);
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
