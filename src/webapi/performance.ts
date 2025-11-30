/*!
 * User Timing Level 3 Polyfill for Deno/QuickJS
 * TypeScript version with full spec compliance
 */

// === Type Definitions ===
type DOMHighResTimeStamp = number;
type PerformanceEntryType = "mark" | "measure" | "navigation" | "resource" | "paint" | "largest-contentful-paint" | "first-input" | "layout-shift";
interface PerformanceMarkOptions {
    detail?: any;
    startTime?: DOMHighResTimeStamp;
}

interface PerformanceMeasureOptions {
    detail?: any;
    start?: string | DOMHighResTimeStamp ;
    end?: string | DOMHighResTimeStamp;
    duration?: DOMHighResTimeStamp;
}

// === Module Scope Storage ===
// Use WeakMap instead of symbols for better TypeScript compatibility
const storage = new WeakMap<Performance, {
    buffer: PerformanceEntry[];
    marks: Map<string, PerformanceMark[]>;
}>();

// === PerformanceMark Class ===
class PerformanceMark implements PerformanceEntry {
    readonly entryType: "mark" = "mark";
    readonly duration: DOMHighResTimeStamp = 0;
    readonly name: string;
    readonly startTime: DOMHighResTimeStamp;
    readonly detail: any;

    constructor(markName: string, markOptions: PerformanceMarkOptions = {}) {
        if (typeof markName !== "string" || markName === "") {
            throw new TypeError("markName must be a non-empty string");
        }

        // PerformanceTiming reserved names (for spec compliance)
        const forbidden = ["navigationStart", "unloadEventStart", "unloadEventEnd",
            "redirectStart", "redirectEnd", "fetchStart", "domainLookupStart",
            "domainLookupEnd", "connectStart", "connectEnd", "secureConnectionStart",
            "requestStart", "responseStart", "responseEnd", "domLoading",
            "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd",
            "domComplete", "loadEventStart", "loadEventEnd"];

        if (forbidden.includes(markName)) {
            throw new SyntaxError(`Cannot use reserved timing name: ${markName}`);
        }

        this.name = markName;
        this.startTime = markOptions.startTime !== undefined
            ? Number(markOptions.startTime)
            : performance.now();

        if (this.startTime < 0) throw new TypeError("startTime cannot be negative");

        // Structured clone simulation
        this.detail = markOptions.detail !== undefined
            ? JSON.parse(JSON.stringify(markOptions.detail))
            : null;

        Object.freeze(this);
    }

    toJSON() {
        return {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration,
            detail: this.detail,
        };
    }
}

// === PerformanceMeasure Class ===
class PerformanceMeasure implements PerformanceEntry {
    readonly entryType: "measure" = "measure";
    readonly name: string;
    readonly startTime: DOMHighResTimeStamp;
    readonly duration: DOMHighResTimeStamp;
    readonly detail: any;

    constructor(
        measureName: string,
        startTime: DOMHighResTimeStamp,
        duration: DOMHighResTimeStamp,
        detail: any = null
    ) {
        if (typeof measureName !== "string" || measureName === "") {
            throw new TypeError("measureName must be a non-empty string");
        }

        this.name = measureName;
        this.startTime = Number(startTime);
        this.duration = Number(duration);
        this.detail = detail !== null ? JSON.parse(JSON.stringify(detail)) : null;

        Object.freeze(this);
    }

    toJSON() {
        return {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration,
            detail: this.detail,
        };
    }
}

// === Utility Functions ===
function getStore(perf: Performance) {
    if (!storage.has(perf)) {
        storage.set(perf, {
            buffer: [],
            marks: new Map<string, PerformanceMark[]>(),
        });
    }
    return storage.get(perf)!;
}

function convertMarkToTimestamp(mark: string | DOMHighResTimeStamp): DOMHighResTimeStamp {
    if (typeof mark === "string") {
        const store = getStore(performance);
        const marks = store.marks.get(mark);
        if (!marks?.length) throw new SyntaxError(`Mark not found: ${mark}`);
        return marks[marks.length - 1]!.startTime;
    }

    const timestamp = Number(mark);
    if (timestamp < 0) throw new TypeError("Timestamp cannot be negative");
    return timestamp;
}

function isMeasureOptions(obj: any): obj is PerformanceMeasureOptions {
    return obj && typeof obj === "object" &&
        ("start" in obj || "end" in obj || "duration" in obj);
}

// === Polyfill Installation ===
export function installUserTimingPolyfill(): void {
    if ((performance as any).userTimingPolyfill) return;

    // Store original methods once
    const original = {
        getEntriesByType: performance.getEntriesByType?.bind(performance),
        getEntriesByName: performance.getEntriesByName?.bind(performance),
        getEntries: performance.getEntries?.bind(performance),
    };

    // Implement mark()
    performance.mark = function (
        markName: string,
        markOptions?: PerformanceMarkOptions
    ): PerformanceMark {
        const mark = new PerformanceMark(markName, markOptions);
        const store = getStore(this);

        store.buffer.push(mark);

        if (!store.marks.has(mark.name)) {
            store.marks.set(mark.name, []);
        }
        store.marks.get(mark.name)!.push(mark);

        return mark;
    };

    // Implement measure()
    performance.measure = function (
        measureName: string,
        startOrMeasureOptions?: string | PerformanceMeasureOptions,
        endMark?: string
    ): PerformanceMeasure {
        let startTime: DOMHighResTimeStamp;
        let endTime: DOMHighResTimeStamp;
        let detail: any = null;

        // Parameter validation
        if (typeof startOrMeasureOptions === "string" && endMark !== undefined) {
            // Legacy: measure(name, startMark, endMark)
            startTime = convertMarkToTimestamp(startOrMeasureOptions);
            endTime = convertMarkToTimestamp(endMark);
        } else if (isMeasureOptions(startOrMeasureOptions)) {
            // Modern options object
            if (endMark !== undefined) {
                throw new TypeError("Cannot provide both options object and endMark");
            }

            const opts = startOrMeasureOptions;
            detail = opts.detail;

            const hasStart = opts.start !== undefined;
            const hasEnd = opts.end !== undefined;
            const hasDuration = opts.duration !== undefined;

            if (!hasStart && !hasEnd && !hasDuration) {
                throw new TypeError("Must specify at least start, end, or duration");
            }
            if (hasStart && hasEnd && hasDuration) {
                throw new TypeError("Cannot specify start, end, and duration simultaneously");
            }

            if (hasStart && hasEnd) {
                startTime = convertMarkToTimestamp(opts.start!);
                endTime = convertMarkToTimestamp(opts.end!);
            } else if (hasStart && hasDuration) {
                startTime = convertMarkToTimestamp(opts.start!);
                endTime = startTime + Number(opts.duration);
            } else if (hasEnd && hasDuration) {
                endTime = convertMarkToTimestamp(opts.end!);
                startTime = endTime - Number(opts.duration);
            } else if (hasStart) {
                startTime = convertMarkToTimestamp(opts.start!);
                endTime = performance.now();
            } else if (hasEnd) {
                startTime = 0;
                endTime = convertMarkToTimestamp(opts.end!);
            } else {
                endTime = performance.now();
                startTime = endTime - Number(opts.duration);
            }
        } else if (typeof startOrMeasureOptions === "string") {
            // measure(name, startMark)
            startTime = convertMarkToTimestamp(startOrMeasureOptions);
            endTime = performance.now();
        } else {
            // measure(name)
            startTime = 0;
            endTime = performance.now();
        }

        const duration = endTime - startTime;
        const measure = new PerformanceMeasure(measureName, startTime, duration, detail);

        const store = getStore(this);
        store.buffer.push(measure);

        return measure;
    };

    // Implement clearMarks()
    performance.clearMarks = function (markName?: string): void {
        const store = getStore(this);

        if (markName === undefined) {
            store.buffer = store.buffer.filter((e) => e.entryType !== "mark");
            store.marks.clear();
        } else {
            store.buffer = store.buffer.filter(
                (e) => !(e.entryType === "mark" && e.name === markName)
            );
            store.marks.delete(markName);
        }
    };

    // Implement clearMeasures()
    performance.clearMeasures = function (measureName?: string): void {
        const store = getStore(this);

        if (measureName === undefined) {
            store.buffer = store.buffer.filter((e) => e.entryType !== "measure");
        } else {
            store.buffer = store.buffer.filter(
                (e) => !(e.entryType === "measure" && e.name === measureName)
            );
        }
    };

    // Override getEntriesByType()
    performance.getEntriesByType = function <K extends PerformanceEntryType>(
        type: K
    ): PerformanceEntryList {
        const store = getStore(this);
        const ourEntries = store.buffer.filter((e) => e.entryType === type);

        const nativeEntries = original.getEntriesByType
            ? original.getEntriesByType(type)
            : [];

        return [...ourEntries, ...nativeEntries] as PerformanceEntryList;
    };

    // Override getEntriesByName()
    performance.getEntriesByName = function (
        name: string,
        type?: PerformanceEntryType
    ): PerformanceEntryList {
        const store = getStore(this);
        let ourEntries = store.buffer.filter((e) => e.name === name);
        if (type) {
            ourEntries = ourEntries.filter((e) => e.entryType === type);
        }

        const nativeEntries = original.getEntriesByName
            ? original.getEntriesByName(name, type)
            : [];

        return [...ourEntries, ...nativeEntries] as PerformanceEntryList;
    };

    // Override getEntries()
    performance.getEntries = function (): PerformanceEntryList {
        const store = getStore(this);
        const nativeEntries = original.getEntries ? original.getEntries() : [];
        return [...store.buffer, ...nativeEntries] as PerformanceEntryList;
    };

    // Mark as installed
    (performance as any).userTimingPolyfill = true;
}

// Auto-install for module consumers
installUserTimingPolyfill();