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
    minuteValues: number[];
    hourValues: number[];
    dayOfMonthValues: number[];
    monthValues: number[];
    dayOfMonthWildcard: boolean;
    dayOfWeekWildcard: boolean;
};

type CompiledSchedule = {
    source: string | Deno.CronSchedule;
    matches(date: Date): boolean;
};

const timers = import.meta.use('timers');
const console = import.meta.use('console');

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
const MAX_CRON_JOBS = 100;
const activeCronJobs = new Map<string, () => void>();

function fail(message: string): never {
    throw new TypeError(`Deno.cron: ${message}`);
}

function normalizeValue(field: CronField, raw: string | number): number {
    if (typeof raw === 'number') return normalizeNumber(field, raw);
    const value = raw.trim().toLowerCase();
    const monthName = MONTH_NAMES[value];
    if (field === 'month' && monthName !== undefined) return monthName;
    const dayName = DAY_NAMES[value];
    if (field === 'dayOfWeek' && dayName !== undefined) return dayName;
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
        const minute = fields[0];
        const hour = fields[1];
        const dayOfMonth = fields[2];
        const month = fields[3];
        const dayOfWeek = fields[4];
        if (minute === undefined || hour === undefined || dayOfMonth === undefined || month === undefined || dayOfWeek === undefined) {
            fail(`expected 5 cron fields, got ${fields.length}`);
        }
        const minuteSet = parseStringField('minute', minute);
        const hourSet = parseStringField('hour', hour);
        const dayOfMonthSet = parseStringField('dayOfMonth', dayOfMonth);
        const monthSet = parseStringField('month', month);
        const dayOfWeekSet = parseStringField('dayOfWeek', dayOfWeek);
        return {
            minute: minuteSet,
            hour: hourSet,
            dayOfMonth: dayOfMonthSet,
            month: monthSet,
            dayOfWeek: dayOfWeekSet,
            minuteValues: Array.from(minuteSet).sort((a, b) => a - b),
            hourValues: Array.from(hourSet).sort((a, b) => a - b),
            dayOfMonthValues: Array.from(dayOfMonthSet).sort((a, b) => a - b),
            monthValues: Array.from(monthSet).sort((a, b) => a - b),
            dayOfMonthWildcard: dayOfMonth === '*',
            dayOfWeekWildcard: dayOfWeek === '*',
        };
    }

    const minuteSet = parseScheduleExpression('minute', source.minute);
    const hourSet = parseScheduleExpression('hour', source.hour);
    const dayOfMonthSet = parseScheduleExpression('dayOfMonth', source.dayOfMonth);
    const monthSet = parseScheduleExpression('month', source.month);
    const dayOfWeekSet = parseScheduleExpression('dayOfWeek', source.dayOfWeek);
    return {
        minute: minuteSet,
        hour: hourSet,
        dayOfMonth: dayOfMonthSet,
        month: monthSet,
        dayOfWeek: dayOfWeekSet,
        minuteValues: Array.from(minuteSet).sort((a, b) => a - b),
        hourValues: Array.from(hourSet).sort((a, b) => a - b),
        dayOfMonthValues: Array.from(dayOfMonthSet).sort((a, b) => a - b),
        monthValues: Array.from(monthSet).sort((a, b) => a - b),
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

function nextAllowedValue(values: number[], current: number): number | null {
    for (const value of values) {
        if (value >= current) return value;
    }
    return null;
}

function matchesDay(matcher: Matcher, date: Date): boolean {
    const dayOfMonthMatch = matcher.dayOfMonth.has(date.getUTCDate());
    const dayOfWeekMatch = matcher.dayOfWeek.has(date.getUTCDay());
    return matcher.dayOfMonthWildcard || matcher.dayOfWeekWildcard
        ? dayOfMonthMatch && dayOfWeekMatch
        : dayOfMonthMatch || dayOfWeekMatch;
}

function nextRunAt(schedule: CompiledSchedule, now: Date): Date {
    const matcher = compileMatcher(schedule.source);
    const cursor = new Date(now.getTime());
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    const deadline = now.getTime() + 366 * 24 * 60 * 60 * 1000 * 5;

    while (cursor.getTime() <= deadline) {
        const month = cursor.getUTCMonth() + 1;
        const nextMonth = nextAllowedValue(matcher.monthValues, month);
        if (nextMonth === null) {
            const firstMonth = matcher.monthValues[0];
            if (firstMonth === undefined) fail('empty month schedule');
            cursor.setUTCFullYear(cursor.getUTCFullYear() + 1, firstMonth - 1, 1);
            cursor.setUTCHours(0, 0, 0, 0);
            continue;
        }
        if (nextMonth !== month) {
            cursor.setUTCMonth(nextMonth - 1, 1);
            cursor.setUTCHours(0, 0, 0, 0);
            continue;
        }

        if (!matchesDay(matcher, cursor)) {
            cursor.setUTCDate(cursor.getUTCDate() + 1);
            cursor.setUTCHours(0, 0, 0, 0);
            continue;
        }

        const hour = cursor.getUTCHours();
        const nextHour = nextAllowedValue(matcher.hourValues, hour);
        if (nextHour === null) {
            cursor.setUTCDate(cursor.getUTCDate() + 1);
            cursor.setUTCHours(0, 0, 0, 0);
            continue;
        }
        if (nextHour !== hour) {
            cursor.setUTCHours(nextHour, 0, 0, 0);
            continue;
        }

        const minute = cursor.getUTCMinutes();
        const nextMinute = nextAllowedValue(matcher.minuteValues, minute);
        if (nextMinute === null) {
            cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
            continue;
        }
        if (nextMinute !== minute) {
            cursor.setUTCMinutes(nextMinute, 0, 0);
            continue;
        }

        if (schedule.matches(cursor)) return new Date(cursor.getTime());
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
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

function validateName(name: string): void {
    if (!name.trim()) fail('name must be a non-empty string');
    if (name.length > 64) fail(`name cannot exceed 64 characters: current length ${name.length}`);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail('invalid name');
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
            const delay = backoffSchedule[attempt];
            if (delay === undefined) return;
            await sleep(delay, signal);
        }
    }
}

function createCronJob(name: string, schedule: string | Deno.CronSchedule, options: Required<CronOptions>, handler: () => Promise<void> | void): Promise<void> {
    const compiled = compileSchedule(schedule);
    let timerId: number | null = null;
    let stopped = false;
    let running = false;
    let resolveJob: (() => void) | undefined;

    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timerId !== null) {
            timers.clearTimeout(timerId);
            timerId = null;
        }
        options.signal?.removeEventListener('abort', stop);
        activeCronJobs.delete(name);
        resolveJob?.();
    };

    if (options.signal) {
        if (options.signal.aborted) return Promise.resolve();
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

    activeCronJobs.set(name, stop);
    scheduleNext();
    return new Promise<void>((resolve) => {
        resolveJob = resolve;
        if (stopped) resolve();
    });
}

function cron(
    name: string,
    schedule: string | Deno.CronSchedule,
    optionsOrHandler: CronOptions | (() => Promise<void> | void),
    maybeHandler?: () => Promise<void> | void,
): Promise<void> {
    if (typeof name !== 'string') fail('name must be a non-empty string');
    validateName(name);
    if (typeof schedule !== 'string' && (typeof schedule !== 'object' || schedule === null)) {
        fail('schedule must be a cron string or object');
    }

    if (typeof optionsOrHandler === 'function' && maybeHandler !== undefined) {
        fail('a single handler is required: two handlers were specified');
    }
    const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;
    if (typeof handler !== 'function') fail('handler must be a function');
    if (activeCronJobs.has(name)) fail('job with this name already exists');
    if (activeCronJobs.size >= MAX_CRON_JOBS) fail('too many cron jobs');

    const options = normalizeOptions(typeof optionsOrHandler === 'function' ? undefined : optionsOrHandler);
    return createCronJob(name, schedule, options, handler);
}

Reflect.set(globalThis.Deno, 'cron', cron);
