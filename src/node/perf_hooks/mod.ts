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
