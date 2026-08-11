/**
 * Node.js console module
 * Provides the Console class and the global console instance
 */

import process from '../process';
import { format as utilFormat, formatWithOptions as utilFormatWithOptions, inspect as utilInspect } from '../util/mod';

const nativeConsole = import.meta.use('console');

interface ConsoleOptions {
    stdout: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    ignoreErrors?: boolean;
    colorMode?: boolean | 'auto';
    inspectOptions?: ImportInspectOptions;
    groupIndentation?: number;
}

/** Node forwards this object verbatim to util.formatWithOptions/inspect. */
interface ImportInspectOptions {
    showHidden?: boolean;
    depth?: number | null;
    colors?: boolean;
    customInspect?: boolean;
    showProxy?: boolean;
    maxArrayLength?: number | null;
    maxStringLength?: number | null;
    breakLength?: number;
    compact?: boolean | number;
    sorted?: boolean | ((a: string, b: string) => number);
    getters?: boolean | 'get' | 'set';
    numericSeparator?: boolean;
}

/** Mirrors node's determineSpecificType() for argument-error messages. */
function specificType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'an instance of Array';
    if (typeof value === 'function') return `function ${(value as { name?: string }).name ?? ''}`;
    return `type ${typeof value} (${utilInspect(value)})`;
}

/** Node says "property" for a dotted path and "argument" otherwise. */
function invalidArgType(name: string, expected: string, value: unknown): never {
    const kind = name.includes('.') ? 'property' : 'argument';
    const err = new TypeError(
        `The "${name}" ${kind} must be of type ${expected}. Received ${specificType(value)}`,
    ) as TypeError & { code?: string };
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
}

function outOfRange(name: string, expected: string, value: unknown): never {
    const err = new RangeError(
        `The value of "${name}" is out of range. It must be ${expected}. Received ${String(value)}`,
    ) as RangeError & { code?: string };
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
}

/** Node's validateObject: null, an array and a function are all rejected. */
function validateInspectOptions(value: unknown): void {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
        invalidArgType('options.inspectOptions', 'object', value);
    }
}

function validateColorMode(value: unknown): void {
    if (typeof value === 'boolean' || value === 'auto') return;
    const err = new TypeError(
        `The argument 'colorMode' must be one of: 'auto', true, false. Received ${utilInspect(value)}`,
    ) as TypeError & { code?: string };
    err.code = 'ERR_INVALID_ARG_VALUE';
    throw err;
}

function validateGroupIndentation(value: unknown): void {
    if (typeof value !== 'number') invalidArgType('groupIndentation', 'number', value);
    if (!Number.isInteger(value)) outOfRange('groupIndentation', 'an integer', value);
    if (value < 0 || value > 1000) outOfRange('groupIndentation', '>= 0 && <= 1000', value);
}

function incompatibleOptionPair(): never {
    const err = new TypeError(
        'Option "options.inspectOptions.color" cannot be used in combination with option "colorMode"',
    ) as TypeError & { code?: string };
    err.code = 'ERR_INCOMPATIBLE_OPTION_PAIR';
    throw err;
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

/**
 * Node binds these onto each instance as own enumerable properties, so
 * `Object.keys(c)`, `{...c}` and `const {log} = c` all behave. `profile`,
 * `profileEnd`, `timeStamp` and `format` deliberately stay prototype-only,
 * matching node's own list.
 */
const BOUND_CONSOLE_METHODS = [
    'log', 'warn', 'dir', 'time', 'timeEnd', 'timeLog', 'trace', 'assert',
    'clear', 'count', 'countReset', 'group', 'groupEnd', 'table', 'debug',
    'info', 'dirxml', 'error', 'groupCollapsed',
] as const;

/** Node: a stream must look writable or the constructor throws. */
function validateConsoleStream(stream: unknown, name: string): void {
    if (stream === null || stream === undefined ||
        (typeof stream !== 'object' && typeof stream !== 'function') ||
        typeof (stream as { write?: unknown }).write !== 'function') {
        const err = new TypeError(
            `Console expects a writable stream instance for ${name}`,
        ) as TypeError & { code?: string };
        err.code = 'ERR_CONSOLE_WRITABLE_STREAM';
        throw err;
    }
}

class ConsoleImpl {
    private _stdout!: NodeJS.WritableStream;
    private _stderr!: NodeJS.WritableStream;
    private _ignoreErrors!: boolean;
    private _groupIndent!: string;
    private _groupIndentation!: number;
    private _timers!: Map<string, number>;
    private _counters!: Map<string, number>;
    private _inspectOptions!: ImportInspectOptions | undefined;
    private _colorMode!: boolean | 'auto';

    constructor(stdout: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, ignoreErrors?: boolean);
    constructor(options: ConsoleOptions);
    constructor(stdoutOrOptions: NodeJS.WritableStream | ConsoleOptions, stderr?: NodeJS.WritableStream, ignoreErrors?: boolean) {
        let outStream: NodeJS.WritableStream;
        let errStream: NodeJS.WritableStream;
        let ignore: boolean;
        let indentation: number;
        let inspectOptions: ImportInspectOptions | undefined;
        let colorMode: boolean | 'auto' = 'auto';

        if (typeof stdoutOrOptions === 'object' && stdoutOrOptions !== null && 'stdout' in stdoutOrOptions) {
            const opts = stdoutOrOptions;
            outStream = opts.stdout;
            errStream = opts.stderr ?? opts.stdout;
            ignore = opts.ignoreErrors ?? true;
            indentation = opts.groupIndentation ?? 2;
            inspectOptions = opts.inspectOptions;
            const colorModeGiven = opts.colorMode !== undefined;
            if (colorModeGiven) colorMode = opts.colorMode as boolean | 'auto';

            // Node validates before any assignment, so a bad stream never yields a
            // half-built Console that throws later at the first write instead.
            validateConsoleStream(outStream, 'stdout');
            if (errStream !== outStream) validateConsoleStream(errStream, 'stderr');
            validateColorMode(colorMode);
            if (opts.groupIndentation !== undefined) validateGroupIndentation(opts.groupIndentation);
            if (inspectOptions !== undefined) {
                validateInspectOptions(inspectOptions);
                // Both would decide `colors`, so node refuses the pair outright
                // rather than silently letting one of them win.
                if (inspectOptions.colors !== undefined && colorModeGiven) incompatibleOptionPair();
            }
        } else {
            outStream = stdoutOrOptions as NodeJS.WritableStream;
            errStream = stderr ?? outStream;
            ignore = ignoreErrors ?? true;
            indentation = 2;
            inspectOptions = undefined;
            validateConsoleStream(outStream, 'stdout');
            if (errStream !== outStream) validateConsoleStream(errStream, 'stderr');
        }

        // Internals are non-enumerable so Object.keys()/spread show node's method
        // set rather than cno's private fields.
        const hide = (key: string, value: unknown): void => {
            Object.defineProperty(this, key, {
                value, writable: true, enumerable: false, configurable: true,
            });
        };
        hide('_stdout', outStream);
        hide('_stderr', errStream);
        hide('_ignoreErrors', ignore);
        hide('_groupIndentation', indentation);
        hide('_inspectOptions', inspectOptions);
        hide('_colorMode', colorMode);
        hide('_groupIndent', '');
        hide('_timers', new Map<string, number>());
        hide('_counters', new Map<string, number>());

        for (const name of BOUND_CONSOLE_METHODS) {
            const fn = (this as unknown as Record<string, unknown>)[name];
            if (typeof fn !== 'function') continue;
            Object.defineProperty(this, name, {
                value: (fn as (...a: unknown[]) => unknown).bind(this),
                writable: true, enumerable: true, configurable: true,
            });
        }
    }

    /**
     * Node's kGetInspectOptions: `colorMode` decides `colors` per *stream*, so
     * stderr can be a TTY while stdout is a pipe. 'auto' resolves through
     * isTTY/getColorDepth and stays `undefined` on a plain Writable, which is why
     * a non-TTY sink gets no `colors` key at all. Node caches the answer by
     * mutating the caller's inspectOptions; mirrored so the side effect matches.
     */
    private _optionsFor(stream: NodeJS.WritableStream): ImportInspectOptions {
        let color: boolean | undefined;
        if (this._colorMode === 'auto') {
            const s = stream as unknown as { isTTY?: boolean; getColorDepth?: () => number };
            color = s.isTTY && (typeof s.getColorDepth === 'function' ? s.getColorDepth() > 2 : true);
        } else {
            color = this._colorMode;
        }

        const options = this._inspectOptions;
        if (options) {
            if (options.colors === undefined && color !== undefined) options.colors = color;
            return options;
        }
        return color ? { colors: true } : {};
    }

    private _out(args: unknown[]): string {
        return this._groupIndent + buildOutput(args, this._optionsFor(this._stdout));
    }

    private _err(args: unknown[]): string {
        return this._groupIndent + buildOutput(args, this._optionsFor(this._stderr));
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
        this._write(this._stdout, this._out(args));
    }

    format(...args: unknown[]): string {
        return formatOutput(...args);
    }

    info(...args: unknown[]): void {
        this._write(this._stdout, this._out(args));
    }

    warn(...args: unknown[]): void {
        this._write(this._stderr, this._err(args));
    }

    error(...args: unknown[]): void {
        this._write(this._stderr, this._err(args));
    }

    debug(...args: unknown[]): void {
        this._write(this._stdout, this._out(args));
    }

    dir(obj: unknown, options?: ImportInspectOptions): void {
        // customInspect:false is node's *default* here, not a forced value -- an
        // explicit console.dir(o, {customInspect: true}) must still win.
        this._write(this._stdout, this._groupIndent + utilInspect(obj, {
            customInspect: false,
            ...this._optionsFor(this._stdout),
            ...options,
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
        for (const line of buildTable(data, columns, this._cellInspect())) {
            this._write(this._stdout, this._groupIndent + line);
        }
    }

    /**
     * Node's table cells are NOT inspected at the instance's depth: it forces
     * maxArrayLength 3 and an unbounded breakLength, and picks depth per value
     * (-1 for a non-array object with more than two keys, else 0). The instance
     * options spread LAST, so an explicit depth/maxArrayLength still wins.
     */
    private _cellInspect(): (value: unknown) => string {
        const resolved = this._optionsFor(this._stdout);
        return (value: unknown): string => {
            const depth = value !== null && typeof value === 'object' && !Array.isArray(value) &&
                Object.keys(value as object).length > 2 ? -1 : 0;
            return utilInspect(value, {
                depth, maxArrayLength: 3, breakLength: Infinity, ...resolved,
            } as never);
        };
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
        const extra = args.length ? ' ' + buildOutput(args, this._optionsFor(this._stdout)) : '';
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
        const head = args.length ? `Trace: ${buildOutput(args, this._optionsFor(this._stderr))}` : 'Trace';
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
        this._write(this._stderr, this._groupIndent + buildOutput(parts, this._optionsFor(this._stderr)));
    }

    clear(): void {
        this._write(this._stdout, '\x1b[2J\x1b[0;0H');
    }

    profile(_label?: string): void {}

    profileEnd(_label?: string): void {}

    timeStamp(_label?: string): void {}
}

/*
 * Node exposes Console as a constructable *and* callable function. An ES class
 * cannot be called directly (its constructor throws before its body runs), so
 * the compatibility branch must live in a Proxy apply trap. Keeping the class
 * as the proxy target preserves `instanceof`, the prototype methods, and the
 * normal `new Console(...)` path.
 */
interface ConsoleConstructor {
    new (stdout: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, ignoreErrors?: boolean): ConsoleImpl;
    new (options: ConsoleOptions): ConsoleImpl;
    (stdout: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, ignoreErrors?: boolean): ConsoleImpl;
    (options: ConsoleOptions): ConsoleImpl;
    readonly prototype: ConsoleImpl;
}

const consoleConstructor = new Proxy(ConsoleImpl, {
    apply(target, _thisArg, args) {
        return Reflect.construct(target, args);
    },
}) as unknown as ConsoleConstructor;
Object.defineProperty(consoleConstructor, 'name', { value: 'Console', configurable: true });

export type Console = ConsoleImpl;
export const Console = consoleConstructor;

const TABLE_CHARS = {
    topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
    left: '├', right: '┤', middle: '┼', top: '┬', bottom: '┴',
    dash: '─', line: '│',
};

/** Display width: SGR escapes count 0, combining marks 0, East-Asian wide 2. */
function cellWidth(str: string): number {
    let width = 0;
    // Node measures with getStringWidth, which strips ANSI first -- otherwise a
    // coloured cell counts ~10 columns too wide and every divider misaligns.
    for (const ch of str.replace(/\u001b\[[0-9;]*m/g, '')) {
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

/** Mirrors Node's cliTable: real junctions, a `Values` column, `ins` per cell. */
function buildTable(data: object, columns: string[] | undefined, ins: (v: unknown) => string): string[] {
    const keys: string[] = [];
    const indexes: string[] = [];
    const map: Record<string, string[]> = {};
    const valuesColumn: string[] = [];
    let hasPrimitives = false;

    // Node iterates a Map/Set rather than reading own properties (which are none),
    // and labels the index column '(iteration index)'. Neither ever expands its
    // values into columns -- each value goes whole into `Values` -- so these two
    // return early instead of falling into the generic column walk below.
    const asMap = data instanceof Map;
    const asSet = data instanceof Set;
    if (asMap || asSet) {
        const values: string[] = [];
        const keyColumn: string[] = [];
        let n = 0;
        if (asMap) {
            for (const [k, v] of data) { keyColumn[n] = ins(k); values[n] = ins(v); n++; }
        } else {
            for (const v of data) { values[n] = ins(v); n++; }
        }
        const header = asMap
            ? ['(iteration index)', 'Key', 'Values']
            : ['(iteration index)', 'Values'];
        const rows = Array.from({ length: n }, (_, i) => (asMap
            ? [ins(i), keyColumn[i], values[i]]
            : [ins(i), values[i]]));
        return renderTable(header, rows);
    }

    const entries: Array<[string, unknown]> = Array.isArray(data)
        ? data.map((v, i) => [String(i), v] as [string, unknown])
        : Object.entries(data as Record<string, unknown>);

    for (const [key, item] of entries) {
        const idx = indexes.length;
        indexes.push(key);

        // Node's `primitive` test excludes functions, so a bare function is walked
        // for own keys (it has none) rather than landing in a `Values` column. And
        // when `properties` is given, a primitive gets an empty cell per column
        // instead of a `Values` column of its own.
        const primitive = item === null || (typeof item !== 'function' && typeof item !== 'object');
        if (columns === undefined && primitive) {
            hasPrimitives = true;
            valuesColumn[idx] = ins(item);
            continue;
        }

        const own = columns ?? Object.keys(item as Record<string, unknown>);
        for (const k of own) {
            if (!(k in map)) {
                keys.push(k);
                map[k] = [];
            }
            map[k][idx] = (primitive && columns) ||
                !Object.prototype.hasOwnProperty.call(item as object, k)
                ? ''
                : ins(Reflect.get(item as object, k));
        }
    }

    const finalKeys = columns ?? keys;
    const header = ['(index)', ...finalKeys, ...(hasPrimitives ? ['Values'] : [])];
    const rows: string[][] = indexes.map((label, i) => [
        label,
        ...finalKeys.map(k => map[k]?.[i] ?? ''),
        ...(hasPrimitives ? [valuesColumn[i] ?? ''] : []),
    ]);
    return renderTable(header, rows);
}

function renderTable(header: string[], rows: string[][]): string[] {
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
