import { DOMException } from "../webapi/events";

type CronOptions = {
    backoffSchedule?: number[];
    signal?: AbortSignal;
};

type CronField = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek';

type Matcher = {
    minute: Set<number>;
    hour: Set<number>;
    dayOfMonth: Set<number>;
    month: Set<number>;
    dayOfWeek: Set<number>;
    dayOfMonthWildcard: boolean;
    dayOfWeekWildcard: boolean;
};

type CompiledSchedule = {
    source: string | Deno.CronSchedule;
    matches(date: Date): boolean;
};

const timers = import.meta.use('timers');

const FIELD_RANGES: Record<CronField, { min: number; max: number }> = {
    minute: { min: 0, max: 59 },
    hour: { min: 0, max: 23 },
    dayOfMonth: { min: 1, max: 31 },
    month: { min: 1, max: 12 },
    dayOfWeek: { min: 0, max: 6 },
};

const MONTH_NAMES: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_NAMES: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function fail(message: string): never {
    throw new TypeError(`Deno.cron: ${message}`);
}

function normalizeValue(field: CronField, raw: string | number): number {
    if (typeof raw === 'number') return normalizeNumber(field, raw);
    const value = raw.trim().toLowerCase();
    if (field === 'month' && value in MONTH_NAMES) return MONTH_NAMES[value]!;
    if (field === 'dayOfWeek' && value in DAY_NAMES) return DAY_NAMES[value]!;
    const num = Number(value);
    if (!Number.isInteger(num)) fail(`invalid ${field} value "${raw}"`);
    return normalizeNumber(field, num);
}

function normalizeNumber(field: CronField, value: number): number {
    const range = FIELD_RANGES[field];
    if (!Number.isInteger(value)) fail(`${field} value must be an integer`);
    if (field === 'dayOfWeek' && value === 7) return 0;
    if (value < range.min || value > range.max) {
        fail(`${field} value ${value} is out of range ${range.min}-${range.max}`);
    }
    return value;
}

function rangeSet(field: CronField, start: number, end: number, every = 1): Set<number> {
    const values = new Set<number>();
    const from = normalizeNumber(field, start);
    const to = normalizeNumber(field, end);
    if (!Number.isInteger(every) || every <= 0) fail(`${field} step must be a positive integer`);
    if (from > to) fail(`${field} range start ${from} must be <= end ${to}`);
    for (let value = from; value <= to; value += every) values.add(value);
    return values;
}

function wildcardSet(field: CronField, every = 1): Set<number> {
    const { min, max } = FIELD_RANGES[field];
    return rangeSet(field, min, max, every);
}

function mergeSets(target: Set<number>, source: Iterable<number>): Set<number> {
    for (const value of source) target.add(value);
    return target;
}

function parseStringField(field: CronField, expr: string): Set<number> {
    const parts = expr.split(',').map(part => part.trim()).filter(Boolean);
    if (!parts.length) fail(`empty ${field} expression`);
    const values = new Set<number>();
    for (const part of parts) {
        const [base, rawStep] = part.split('/');
        if (!base) fail(`invalid ${field} expression "${expr}"`);
        const step = rawStep === undefined ? 1 : Number(rawStep);
        if (!Number.isInteger(step) || step <= 0) fail(`invalid ${field} step in "${part}"`);

        if (base === '*') {
            mergeSets(values, wildcardSet(field, step));
            continue;
        }

        if (base.includes('-')) {
            const [rawStart, rawEnd] = base.split('-');
            if (!rawStart || !rawEnd) fail(`invalid ${field} range "${part}"`);
            mergeSets(values, rangeSet(field, normalizeValue(field, rawStart), normalizeValue(field, rawEnd), step));
            continue;
        }

        if (rawStep !== undefined) {
            const start = normalizeValue(field, base);
            mergeSets(values, rangeSet(field, start, FIELD_RANGES[field].max, step));
            continue;
        }

        values.add(normalizeValue(field, base));
    }
    return values;
}

function parseScheduleExpression(field: CronField, expr: Deno.CronScheduleExpression | undefined): Set<number> {
    if (expr === undefined) return wildcardSet(field);
    if (typeof expr === 'number') return new Set([normalizeNumber(field, expr)]);
    if ('exact' in expr) {
        const exact = Array.isArray(expr.exact) ? expr.exact : [expr.exact];
        if (!exact.length) fail(`${field}.exact cannot be empty`);
        return new Set(exact.map(value => normalizeNumber(field, value)));
    }
    const start = expr.start ?? FIELD_RANGES[field].min;
    const end = expr.end ?? FIELD_RANGES[field].max;
    const every = expr.every ?? 1;
    return rangeSet(field, start, end, every);
}

function compileMatcher(source: string | Deno.CronSchedule): Matcher {
    if (typeof source === 'string') {
        const fields = source.trim().split(/\s+/);
        if (fields.length !== 5) fail(`expected 5 cron fields, got ${fields.length}`);
        const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
        return {
            minute: parseStringField('minute', minute!),
            hour: parseStringField('hour', hour!),
            dayOfMonth: parseStringField('dayOfMonth', dayOfMonth!),
            month: parseStringField('month', month!),
            dayOfWeek: parseStringField('dayOfWeek', dayOfWeek!),
            dayOfMonthWildcard: dayOfMonth === '*',
            dayOfWeekWildcard: dayOfWeek === '*',
        };
    }

    return {
        minute: parseScheduleExpression('minute', source.minute),
        hour: parseScheduleExpression('hour', source.hour),
        dayOfMonth: parseScheduleExpression('dayOfMonth', source.dayOfMonth),
        month: parseScheduleExpression('month', source.month),
        dayOfWeek: parseScheduleExpression('dayOfWeek', source.dayOfWeek),
        dayOfMonthWildcard: source.dayOfMonth === undefined,
        dayOfWeekWildcard: source.dayOfWeek === undefined,
    };
}

function compileSchedule(source: string | Deno.CronSchedule): CompiledSchedule {
    const matcher = compileMatcher(source);
    return {
        source,
        matches(date: Date): boolean {
            const dayOfMonthMatch = matcher.dayOfMonth.has(date.getUTCDate());
            const dayOfWeekMatch = matcher.dayOfWeek.has(date.getUTCDay());
            const dayMatch = matcher.dayOfMonthWildcard || matcher.dayOfWeekWildcard
                ? dayOfMonthMatch && dayOfWeekMatch
                : dayOfMonthMatch || dayOfWeekMatch;
            return matcher.minute.has(date.getUTCMinutes())
                && matcher.hour.has(date.getUTCHours())
                && matcher.month.has(date.getUTCMonth() + 1)
                && dayMatch;
        }
    };
}

function nextRunAt(schedule: CompiledSchedule, now: Date): Date {
    const cursor = new Date(now.getTime());
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    const maxChecks = 366 * 24 * 60 * 5;
    for (let i = 0; i < maxChecks; i++) {
        if (schedule.matches(cursor)) return new Date(cursor.getTime());
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
    fail(`unable to find next run for schedule ${JSON.stringify(schedule.source)}`);
}

function normalizeOptions(options?: CronOptions): Required<CronOptions> {
    const backoff = options?.backoffSchedule ?? [];
    if (!Array.isArray(backoff)) fail('backoffSchedule must be an array');
    if (backoff.length > MAX_RETRIES) fail(`backoffSchedule can contain at most ${MAX_RETRIES} entries`);
    for (const delay of backoff) {
        if (!Number.isInteger(delay) || delay < 0) fail('backoffSchedule values must be non-negative integers');
        if (delay > MAX_BACKOFF_MS) fail(`backoffSchedule values must be <= ${MAX_BACKOFF_MS}`);
    }
    return { backoffSchedule: backoff, signal: options?.signal ?? new AbortController().signal };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    await new Promise<void>((resolve, reject) => {
        const timerId = timers.setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            timers.clearTimeout(timerId);
            cleanup();
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const cleanup = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function emitCronError(name: string, error: unknown): void {
    const wrapped = error instanceof Error
        ? error
        : new Error(`Cron job "${name}" failed: ${String(error)}`);
    if (typeof globalThis.reportError === 'function') {
        globalThis.reportError(wrapped);
        return;
    }
    console.error(wrapped);
}

async function runWithBackoff(name: string, backoffSchedule: number[], signal: AbortSignal | undefined, handler: () => Promise<void> | void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await handler();
            return;
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                return;
            }
            if (attempt >= backoffSchedule.length) {
                emitCronError(name, error);
                return;
            }
            await sleep(backoffSchedule[attempt]!, signal);
        }
    }
}

function createCronJob(name: string, schedule: string | Deno.CronSchedule, options: Required<CronOptions>, handler: () => Promise<void> | void): void {
    const compiled = compileSchedule(schedule);
    let timerId: number | null = null;
    let stopped = false;
    let running = false;

    const stop = () => {
        stopped = true;
        if (timerId !== null) {
            timers.clearTimeout(timerId);
            timerId = null;
        }
    };

    if (options.signal) {
        if (options.signal.aborted) return;
        options.signal.addEventListener('abort', stop, { once: true });
    }

    const scheduleNext = () => {
        if (stopped || options.signal?.aborted) return;
        const target = nextRunAt(compiled, new Date());
        const delay = Math.max(0, target.getTime() - Date.now());
        timerId = timers.setTimeout(async () => {
            timerId = null;
            if (stopped || options.signal?.aborted) return;
            if (!running) {
                running = true;
                try {
                    await runWithBackoff(name, options.backoffSchedule, options.signal, handler);
                } finally {
                    running = false;
                }
            }
            scheduleNext();
        }, delay);
    };

    scheduleNext();
}

async function cron(
    name: string,
    schedule: string | Deno.CronSchedule,
    optionsOrHandler: CronOptions | (() => Promise<void> | void),
    maybeHandler?: () => Promise<void> | void,
): Promise<void> {
    if (typeof name !== 'string' || !name.trim()) fail('name must be a non-empty string');
    if (typeof schedule !== 'string' && (typeof schedule !== 'object' || schedule === null)) {
        fail('schedule must be a cron string or object');
    }

    const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;
    if (typeof handler !== 'function') fail('handler must be a function');

    const options = normalizeOptions(typeof optionsOrHandler === 'function' ? undefined : optionsOrHandler);
    createCronJob(name, schedule, options, handler);
}

Reflect.set(globalThis.Deno, 'cron', cron);
