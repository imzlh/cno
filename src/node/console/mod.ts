/**
 * Node.js console module
 * Provides the Console class and the global console instance
 */

import process from '../process';
import { format as utilFormat, formatWithOptions as utilFormatWithOptions, inspect as utilInspect } from '../util/mod';

const nativeConsole = import.meta.use('console');

export interface ConsoleOptions {
    stdout: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    ignoreErrors?: boolean;
    colorMode?: boolean | 'auto';
    inspectOptions?: ImportInspectOptions;
    groupIndentation?: number;
}

interface ImportInspectOptions {
    showHidden?: boolean;
    depth?: number | null;
    colors?: boolean;
    compact?: boolean | number;
    breakLength?: number;
}

function buildOutput(args: unknown[], inspectOptions?: ImportInspectOptions): string {
    // Node formats every console message through the instance's inspectOptions
    // (formatWithOptions), not a bare format() — otherwise `new Console({stdout,
    // inspectOptions:{depth:0}}).log(o)` silently ignores depth/compact/sorted.
    if (inspectOptions && Object.keys(inspectOptions).length > 0) {
        return utilFormatWithOptions(inspectOptions as never, ...args);
    }
    return utilFormat(...args);
}

// The native console.format collapses `%%` even for a lone string argument,
// where Node returns a single string argument unchanged. Delegate to util.
function formatOutput(...args: unknown[]): string {
    return utilFormat(...args);
}

function emitConsoleWarning(message: string): void {
    // `process` is a loosely-typed default import here; probe before calling.
    const emit = Reflect.get(process, 'emitWarning');
    if (typeof emit === 'function') {
        try {
            Reflect.apply(emit, process, [message]);
            return;
        } catch { /* fall back to the native console below */ }
    }
    if (typeof nativeConsole.warn === 'function') nativeConsole.warn(message);
}

/** Node's console time formatting: ms under 1s, then s, then min. */
function formatDuration(ms: number): string {
    if (ms >= 1000) {
        if (ms >= 60_000) {
            const minutes = Math.floor(ms / 60_000);
            return `${minutes}:${((ms % 60_000) / 1000).toFixed(3).padStart(6, '0')} (min:sec.ms)`;
        }
        return `${(ms / 1000).toFixed(3)}s`;
    }
    return `${ms.toFixed(3)}ms`;
}

/**
 * Builds the console write callback. Mirrors Node's console error handler: when the
 * failure arrives asynchronously the noop parked around the synchronous `write()`
 * call has already been removed, so re-park one to absorb the pending `'error'`
 * emission instead of letting it surface as an unhandled error/rejection.
 * The stream is captured explicitly — a write callback gets no reliable `this`.
 */
function makeConsoleWriteCallback(stream: {
    once?: (event: string, fn: () => void) => unknown;
    listenerCount?: (event: string) => number;
}): (err?: Error | null) => void {
    return (err?: Error | null): void => {
        if (!err || typeof stream.once !== 'function') return;
        try {
            if (typeof stream.listenerCount === 'function' && stream.listenerCount('error') > 0) return;
            stream.once('error', absorbStreamError);
        } catch { /* nothing further we can do from a console write */ }
    };
}

function absorbStreamError(): void { /* intentionally empty */ }

export class Console {
    private _stdout: NodeJS.WritableStream;
    private _stderr: NodeJS.WritableStream;
    private _ignoreErrors: boolean;
    private _groupIndent: string;
    private _groupIndentation: number;
    private _timers: Map<string, number>;
    private _counters: Map<string, number>;
    private _inspectOptions: ImportInspectOptions;

    constructor(stdout: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, ignoreErrors?: boolean);
    constructor(options: ConsoleOptions);
    constructor(stdoutOrOptions: NodeJS.WritableStream | ConsoleOptions, stderr?: NodeJS.WritableStream, ignoreErrors?: boolean) {
        if (typeof stdoutOrOptions === 'object' && 'stdout' in stdoutOrOptions) {
            const opts = stdoutOrOptions;
            this._stdout = opts.stdout;
            this._stderr = opts.stderr ?? opts.stdout;
            this._ignoreErrors = opts.ignoreErrors ?? true;
            this._groupIndentation = opts.groupIndentation ?? 2;
            this._inspectOptions = opts.inspectOptions ?? {};
        } else {
            this._stdout = stdoutOrOptions as NodeJS.WritableStream;
            this._stderr = stderr ?? this._stdout;
            this._ignoreErrors = ignoreErrors ?? true;
            this._groupIndentation = 2;
            this._inspectOptions = {};
        }
        this._groupIndent = '';
        this._timers = new Map();
        this._counters = new Map();
    }

    private _write(stream: NodeJS.WritableStream, data: string): void {
        // Node indents every line of a multi-line message, not just the first.
        const indented = this._groupIndent && data.includes('\n')
            ? data.replaceAll('\n', '\n' + this._groupIndent)
            : data;
        const payload = indented + '\n';

        if (!this._ignoreErrors) {
            stream.write(payload);
            return;
        }

        // A write can fail synchronously (files/TTYs) or asynchronously (pipes,
        // or a Writable whose _write calls back with an error). Node handles both
        // by passing a swallowing completion callback AND parking a noop 'error'
        // listener, so the stream never emits 'error' with nothing attached.
        const emitter = stream as unknown as {
            listenerCount?: (event: string) => number;
            once?: (event: string, fn: () => void) => unknown;
            removeListener?: (event: string, fn: () => void) => unknown;
        };
        const parkedNoop = typeof emitter.once === 'function' &&
            typeof emitter.removeListener === 'function' &&
            (typeof emitter.listenerCount !== 'function' || emitter.listenerCount('error') === 0);

        if (parkedNoop) emitter.once!('error', absorbStreamError);
        try {
            // The callback receives the async failure instead of it going unhandled.
            stream.write(payload, makeConsoleWriteCallback(emitter));
        } catch { /* console is a debugging aid; it must not throw here */ } finally {
            if (parkedNoop) emitter.removeListener!('error', absorbStreamError);
        }
    }

    log(...args: unknown[]): void {
        this._write(this._stdout, this._groupIndent + buildOutput(args, this._inspectOptions));
    }

    format(...args: unknown[]): string {
        return formatOutput(...args);
    }

    info(...args: unknown[]): void {
        this._write(this._stdout, this._groupIndent + buildOutput(args, this._inspectOptions));
    }

    warn(...args: unknown[]): void {
        this._write(this._stderr, this._groupIndent + buildOutput(args, this._inspectOptions));
    }

    error(...args: unknown[]): void {
        this._write(this._stderr, this._groupIndent + buildOutput(args, this._inspectOptions));
    }

    debug(...args: unknown[]): void {
        this._write(this._stdout, this._groupIndent + buildOutput(args, this._inspectOptions));
    }

    dir(obj: unknown, options?: ImportInspectOptions): void {
        this._write(this._stdout, this._groupIndent + utilInspect(obj, {
            ...this._inspectOptions,
            ...options,
            customInspect: false,
        } as never));
    }

    dirxml(...args: unknown[]): void {
        this.log(...args);
    }

    table(data: unknown, columns?: string[]): void {
        if (data === null || typeof data !== 'object') {
            this.log(data);
            return;
        }
        // Node validates this before touching the data: a non-array `properties`
        // is ERR_INVALID_ARG_TYPE, not a silently ignored argument. Node's message
        // names the type AND inspects the value — "Received type string ('a')" —
        // except for null/undefined, which it renders bare.
        if (columns !== undefined && !Array.isArray(columns)) {
            const received = columns === null
                ? 'null'
                : `type ${typeof columns} (${utilInspect(columns)})`;
            const err = new TypeError(
                `The "properties" argument must be an instance of Array. Received ${received}`,
            ) as TypeError & { code?: string };
            err.code = 'ERR_INVALID_ARG_TYPE';
            throw err;
        }
        for (const line of buildTable(data, columns)) {
            this._write(this._stdout, this._groupIndent + line);
        }
    }

    time(label = 'default'): void {
        if (this._timers.has(label)) {
            emitConsoleWarning(`Label '${label}' already exists for console.time()`);
            return;
        }
        this._timers.set(label, performance.now());
    }

    timeLog(label = 'default', ...args: unknown[]): void {
        const start = this._timers.get(label);
        if (start === undefined) {
            emitConsoleWarning(`No such label '${label}' for console.timeLog()`);
            return;
        }
        const ms = performance.now() - start;
        const extra = args.length ? ' ' + buildOutput(args, this._inspectOptions) : '';
        this.log(`${label}: ${formatDuration(ms)}${extra}`);
    }

    timeEnd(label = 'default'): void {
        const start = this._timers.get(label);
        if (start === undefined) {
            emitConsoleWarning(`No such label '${label}' for console.timeEnd()`);
            return;
        }
        const ms = performance.now() - start;
        this.log(`${label}: ${formatDuration(ms)}`);
        this._timers.delete(label);
    }

    count(label = 'default'): void {
        const n = (this._counters.get(label) || 0) + 1;
        this._counters.set(label, n);
        this.log(`${label}: ${n}`);
    }

    countReset(label = 'default'): void {
        if (!this._counters.has(label)) {
            emitConsoleWarning(`Count for '${label}' does not exist`);
            return;
        }
        this._counters.delete(label);
    }

    group(...args: unknown[]): void {
        if (args.length) this.log(...args);
        this._groupIndent += ' '.repeat(this._groupIndentation);
    }

    groupCollapsed(...args: unknown[]): void {
        this.group(...args);
    }

    groupEnd(): void {
        if (this._groupIndent.length >= this._groupIndentation) {
            this._groupIndent = this._groupIndent.slice(0, -this._groupIndentation);
        }
    }

    trace(...args: unknown[]): void {
        // Node emits one message: "Trace: <formatted>" plus the caller's frames.
        // slice(2) drops the Error header and this method's own frame.
        const stack = new Error().stack?.split('\n').slice(2).join('\n') ?? '';
        const head = args.length ? `Trace: ${buildOutput(args, this._inspectOptions)}` : 'Trace';
        this._write(this._stderr, this._groupIndent + (stack ? `${head}\n${stack}` : head));
    }

    assert(condition?: unknown, ...args: unknown[]): void {
        if (condition) return;
        // Node only adds the colon when the first extra arg is a string;
        // otherwise "Assertion failed" is prepended as its own argument.
        const parts = args.length === 0
            ? ['Assertion failed']
            : typeof args[0] === 'string'
                ? [`Assertion failed: ${args[0]}`, ...args.slice(1)]
                : ['Assertion failed', ...args];
        this._write(this._stderr, this._groupIndent + buildOutput(parts, this._inspectOptions));
    }

    clear(): void {
        this._write(this._stdout, '\x1b[2J\x1b[0;0H');
    }

    profile(_label?: string): void {}

    profileEnd(_label?: string): void {}

    timeStamp(_label?: string): void {}
}

const TABLE_CHARS = {
    topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
    left: '├', right: '┤', middle: '┼', top: '┬', bottom: '┴',
    dash: '─', line: '│',
};

/** Display width: combining marks count 0, East-Asian wide chars count 2. */
function cellWidth(str: string): number {
    let width = 0;
    for (const ch of str) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0x300 && cp <= 0x36f) continue;
        width += (cp >= 0x1100 && (
            cp <= 0x115f
            || cp === 0x2329 || cp === 0x232a
            || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
            || (cp >= 0xac00 && cp <= 0xd7a3)
            || (cp >= 0xf900 && cp <= 0xfaff)
            || (cp >= 0xfe30 && cp <= 0xfe6f)
            || (cp >= 0xff00 && cp <= 0xff60)
            || (cp >= 0xffe0 && cp <= 0xffe6)
            || (cp >= 0x1f300 && cp <= 0x1f64f)
            || (cp >= 0x20000 && cp <= 0x3fffd)
        )) ? 2 : 1;
    }
    return width;
}

function renderRow(row: string[], widths: number[]): string {
    let out = TABLE_CHARS.line;
    for (let i = 0; i < widths.length; i++) {
        const cell = row[i] ?? '';
        // Node v24 left-aligns cells (verified byte-for-byte against v24.18).
        out += ` ${cell}${' '.repeat(widths[i] - cellWidth(cell))} ${TABLE_CHARS.line}`;
    }
    return out;
}

function renderDivider(widths: number[], left: string, mid: string, right: string): string {
    return left + widths.map(w => TABLE_CHARS.dash.repeat(w + 2)).join(mid) + right;
}

/** Mirrors Node's cliTable: centred cells, real junctions, a `Values` column. */
function buildTable(data: object, columns?: string[]): string[] {
    const keys: string[] = [];
    const indexes: string[] = [];
    const map: Record<string, string[]> = {};
    const valuesColumn: string[] = [];
    let hasPrimitives = false;

    // Node iterates a Map/Set rather than reading own properties (which are none),
    // and labels the index column '(iteration index)'. A Map contributes a 'Key'
    // column; a Set contributes only 'Values'. Without this both render as an
    // empty one-column table, because Object.entries() of either is [].
    const isMap = data instanceof Map;
    const isSet = data instanceof Set;
    const indexLabel = isMap || isSet ? '(iteration index)' : '(index)';
    const keyColumn: string[] = [];

    const entries: Array<[string, unknown]> = isMap
        ? [...data.entries()].map(([k, v], i) => {
            keyColumn[i] = utilInspect(k);
            return [String(i), v] as [string, unknown];
        })
        : isSet
            ? [...data.values()].map((v, i) => [String(i), v] as [string, unknown])
            : Array.isArray(data)
                ? data.map((v, i) => [String(i), v] as [string, unknown])
                : Object.entries(data as Record<string, unknown>);

    for (const [key, item] of entries) {
        const idx = indexes.length;
        indexes.push(key);

        if (item !== null && typeof item === 'object') {
            const own = Array.isArray(item)
                ? item.map((_, i) => String(i))
                : Object.keys(item as Record<string, unknown>);
            for (const k of own) {
                if (columns && !columns.includes(k)) continue;
                if (!(k in map)) {
                    keys.push(k);
                    map[k] = [];
                }
                map[k][idx] = utilInspect(Reflect.get(item as object, k));
            }
        } else {
            hasPrimitives = true;
            valuesColumn[idx] = utilInspect(item);
        }
    }

    const finalKeys = columns ?? keys;
    const header = [
        indexLabel,
        ...(isMap ? ['Key'] : []),
        ...finalKeys,
        ...(hasPrimitives ? ['Values'] : []),
    ];
    const rows: string[][] = indexes.map((label, i) => [
        label,
        ...(isMap ? [keyColumn[i] ?? ''] : []),
        ...finalKeys.map(k => map[k]?.[i] ?? ''),
        ...(hasPrimitives ? [valuesColumn[i] ?? ''] : []),
    ]);

    const widths = header.map((h, col) => {
        let w = cellWidth(h);
        for (const row of rows) w = Math.max(w, cellWidth(row[col] ?? ''));
        return w;
    });

    const lines = [
        renderDivider(widths, TABLE_CHARS.topLeft, TABLE_CHARS.top, TABLE_CHARS.topRight),
        renderRow(header, widths),
        renderDivider(widths, TABLE_CHARS.left, TABLE_CHARS.middle, TABLE_CHARS.right),
    ];
    for (const row of rows) lines.push(renderRow(row, widths));
    lines.push(renderDivider(widths, TABLE_CHARS.bottomLeft, TABLE_CHARS.bottom, TABLE_CHARS.bottomRight));
    return lines;
}

type ConsoleMethod =
    | 'assert'
    | 'clear'
    | 'count'
    | 'countReset'
    | 'debug'
    | 'dir'
    | 'dirxml'
    | 'error'
    | 'group'
    | 'groupCollapsed'
    | 'groupEnd'
    | 'info'
    | 'log'
    | 'profile'
    | 'profileEnd'
    | 'table'
    | 'time'
    | 'timeEnd'
    | 'timeLog'
    | 'timeStamp'
    | 'trace'
    | 'warn';

/**
 * Node's `console` module is itself a Console bound to process.stdout/stderr,
 * so the module-level methods must share that formatting (and its group indent
 * and timer/counter state) rather than reaching for the native console, whose
 * `format` mishandles a lone `%%`. Built lazily: process.stdout may not exist
 * yet while this module is still initialising.
 */
let sharedConsole: Console | undefined;

function moduleConsole(): Console | undefined {
    if (sharedConsole) return sharedConsole;
    const out = Reflect.get(process, 'stdout');
    const err = Reflect.get(process, 'stderr');
    if (!out || typeof Reflect.get(out, 'write') !== 'function') return undefined;
    sharedConsole = new Console({
        stdout: out as NodeJS.WritableStream,
        stderr: (err && typeof Reflect.get(err, 'write') === 'function'
            ? err
            : out) as NodeJS.WritableStream,
    });
    return sharedConsole;
}

function forward(name: ConsoleMethod) {
    return (...args: unknown[]) => {
        const shared = moduleConsole();
        const method = shared ? Reflect.get(shared, name) : undefined;
        if (typeof method === 'function') {
            return Reflect.apply(method, shared, args);
        }
        const fn = Reflect.get(nativeConsole, name);
        if (typeof fn === 'function') {
            return fn.apply(nativeConsole, args);
        }
        const fallback = globalThis.console ? Reflect.get(globalThis.console, name) : undefined;
        if (typeof fallback === 'function') {
            return fallback.apply(globalThis.console, args);
        }
    };
}

export function format(...args: unknown[]): string {
    return formatOutput(...args);
}

export const log = forward('log');
export const info = forward('info');
export const warn = forward('warn');
export const error = forward('error');
export const debug = forward('debug');
export const dir = forward('dir');
export const dirxml = forward('dirxml');
export const table = forward('table');
export const trace = forward('trace');
export const clear = forward('clear');
export const assert = forward('assert');
export const count = forward('count');
export const countReset = forward('countReset');
export const time = forward('time');
export const timeLog = forward('timeLog');
export const timeEnd = forward('timeEnd');
export const timeStamp = forward('timeStamp');
export const group = forward('group');
export const groupCollapsed = forward('groupCollapsed');
export const groupEnd = forward('groupEnd');
export const profile = forward('profile');
export const profileEnd = forward('profileEnd');

export const context = Reflect.get(nativeConsole, 'context');
export const createTask = Reflect.get(nativeConsole, 'createTask');
