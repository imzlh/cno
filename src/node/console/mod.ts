/**
 * Node.js console module
 * Provides the Console class and the global console instance
 */

const nativeConsole = import.meta.use('console') as Record<string, any>;

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

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const styleMap: Record<string, string> = {
    bold: `${ESC}1m`, dim: `${ESC}2m`, italic: `${ESC}3m`,
    underline: `${ESC}4m`, blink: `${ESC}5m`, reverse: `${ESC}7m`,
    strikethrough: `${ESC}9m`,
    black: `${ESC}30m`, red: `${ESC}31m`, green: `${ESC}32m`,
    yellow: `${ESC}33m`, blue: `${ESC}34m`, magenta: `${ESC}35m`,
    cyan: `${ESC}36m`, white: `${ESC}37m`, gray: `${ESC}90m`,
    bgBlack: `${ESC}40m`, bgRed: `${ESC}41m`, bgGreen: `${ESC}42m`,
    bgYellow: `${ESC}43m`, bgBlue: `${ESC}44m`, bgMagenta: `${ESC}45m`,
    bgCyan: `${ESC}46m`, bgWhite: `${ESC}47m`,
};

function cssToAnsi(css: string): string {
    const codes: string[] = [];
    for (const rule of css.toLowerCase().split(';')) {
        const [prop, val] = rule.split(':').map(s => s.trim());
        if (!prop || !val) continue;
        switch (prop) {
            case 'color':
                if (val in styleMap) codes.push(styleMap[val]);
                else if (val.startsWith('#')) {
                    const r = parseInt(val.slice(1, 3), 16);
                    const g = parseInt(val.slice(3, 5), 16);
                    const b = parseInt(val.slice(5, 7), 16);
                    codes.push(`${ESC}38;2;${r};${g};${b}m`);
                }
                break;
            case 'background-color':
            case 'background':
                if (val in styleMap) codes.push(styleMap['bg' + val.charAt(0).toUpperCase() + val.slice(1)]);
                break;
            case 'font-weight':
                if (val === 'bold') codes.push(styleMap.bold);
                break;
            case 'font-style':
                if (val === 'italic') codes.push(styleMap.italic);
                break;
            case 'text-decoration':
                if (val.includes('underline')) codes.push(styleMap.underline);
                if (val.includes('line-through')) codes.push(styleMap.strikethrough);
                break;
        }
    }
    return codes.join('');
}

function formatValue(val: unknown, depth = 0): string {
    if (depth > 2) {
        if (typeof val === 'object' && val !== null) {
            if (Array.isArray(val)) return `[Array(${val.length})]`;
            if (val instanceof Map) return `[Map(${val.size})]`;
            if (val instanceof Set) return `[Set(${val.size})]`;
            return '[Object]';
        }
    }
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') return val.length > 200 ? val.slice(0, 197) + '...' : val;
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') return String(val);
    if (typeof val === 'symbol') return val.toString();
    if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
    if (val instanceof Date) return val.toISOString();
    if (val instanceof RegExp) return val.toString();
    if (val instanceof Error) return `${val.name}: ${val.message}`;
    if (val instanceof Promise) return 'Promise { <pending> }';

    if (Array.isArray(val)) {
        if (val.length === 0) return '[]';
        const items = val.slice(0, 5).map(v => formatValue(v, depth + 1)).join(', ');
        return val.length > 5 ? `[${items}, ... ${val.length - 5} more items]` : `[${items}]`;
    }

    if (val instanceof Map) {
        const entries = Array.from(val.entries()).slice(0, 3)
            .map(([k, v]) => `${formatValue(k, depth + 1)} => ${formatValue(v, depth + 1)}`).join(', ');
        return `Map(${val.size}) {${entries}${val.size > 3 ? ', ...' : ''}}`;
    }

    if (val instanceof Set) {
        const items = Array.from(val).slice(0, 3).map(v => formatValue(v, depth + 1)).join(', ');
        return `Set(${val.size}) {${items}${val.size > 3 ? ', ...' : ''}}`;
    }

    if (typeof val === 'object') {
        try {
            const keys = Object.keys(val);
            if (keys.length === 0) return '{}';
            const entries = keys.slice(0, 3).map(k => `${k}: ${formatValue((val as Record<string, unknown>)[k], depth + 1)}`).join(', ');
            return keys.length > 3 ? `{${entries}, ...}` : `{${entries}}`;
        } catch {
            return '[Object]';
        }
    }

    return String(val);
}

function applyFormat(format: string, args: unknown[]): { text: string; consumed: number } {
    let result = '';
    let argIdx = 0;
    let i = 0;

    while (i < format.length) {
        if (format[i] === '%' && i + 1 < format.length) {
            const spec = format[i + 1];
            if (spec === '%') {
                result += '%';
                i += 2;
                continue;
            }
            if (argIdx < args.length) {
                const arg = args[argIdx++];
                switch (spec) {
                    case 's':
                        result += String(arg);
                        i += 2;
                        continue;
                    case 'd':
                    case 'i':
                        if (typeof arg === 'bigint') {
                            result += String(arg);
                        } else {
                            const num = Number(arg);
                            result += isNaN(num) ? 'NaN' : String(Math.floor(num));
                        }
                        i += 2;
                        continue;
                    case 'f':
                        if (typeof arg === 'bigint') {
                            result += String(arg);
                        } else {
                            const num = Number(arg);
                            result += isNaN(num) ? 'NaN' : String(num);
                        }
                        i += 2;
                        continue;
                    case 'x':
                    case 'X':
                        {
                            const num = Number(arg);
                            if (isNaN(num)) { result += 'NaN'; }
                            else { result += (spec === 'X' ? Math.abs(Math.floor(num)) >>> 0 : Math.floor(num) >>> 0).toString(16); }
                        }
                        i += 2;
                        continue;
                    case 'j':
                        try { result += JSON.stringify(arg); } catch { result += String(arg); }
                        i += 2;
                        continue;
                    case 'o':
                    case 'O':
                        try {
                            const seen = new WeakSet();
                            result += JSON.stringify(arg, (k, v) => {
                                if (typeof v === 'object' && v !== null) {
                                    if (seen.has(v)) return '[Circular]';
                                    seen.add(v);
                                }
                                return v;
                            }, spec === 'O' ? 2 : undefined);
                        } catch {
                            result += String(arg);
                        }
                        i += 2;
                        continue;
                    case 'c':
                        result += cssToAnsi(String(arg));
                        i += 2;
                        continue;
                }
            }
        }
        result += format[i];
        i++;
    }

    return { text: result, consumed: argIdx };
}

function buildOutput(args: unknown[]): string {
    if (args.length === 0) return '';
    if (typeof args[0] !== 'string') {
        return args.map(a => formatValue(a)).join(' ');
    }

    const format = args[0];
    if (!format.includes('%')) {
        return args.map(a => typeof a === 'string' ? a : formatValue(a)).join(' ');
    }

    const { text, consumed } = applyFormat(format, args.slice(1));
    const remaining = args.slice(1 + consumed);
    if (remaining.length > 0) {
        return text + ' ' + remaining.map(a => formatValue(a)).join(' ');
    }
    return text;
}

function formatOutput(...args: unknown[]): string {
    return String(nativeConsole.format.apply(nativeConsole, args));
}

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
        try {
            stream.write(data + '\n');
        } catch (e) {
            if (!this._ignoreErrors) throw e;
        }
    }

    log(...args: unknown[]): void {
        this._write(this._stdout, this._groupIndent + buildOutput(args));
    }

    format(...args: unknown[]): string {
        return formatOutput(...args);
    }

    info(...args: unknown[]): void {
        this._write(this._stdout, this._groupIndent + buildOutput(args));
    }

    warn(...args: unknown[]): void {
        this._write(this._stderr, this._groupIndent + buildOutput(args));
    }

    error(...args: unknown[]): void {
        this._write(this._stderr, this._groupIndent + buildOutput(args));
    }

    debug(...args: unknown[]): void {
        this._write(this._stdout, this._groupIndent + buildOutput(args));
    }

    dir(obj: unknown, options?: { depth?: number; colors?: boolean }): void {
        this._write(this._stdout, formatValue(obj, options?.depth ?? 2));
    }

    dirxml(...args: unknown[]): void {
        this.log(...args);
    }

    table(data: unknown, columns?: string[]): void {
        if (!data) {
            this.log(data);
            return;
        }
        const lines = buildTable(data, columns);
        for (const line of lines) {
            this._write(this._stdout, this._groupIndent + line);
        }
    }

    time(label = 'default'): void {
        this._timers.set(label, performance.now());
    }

    timeLog(label = 'default', ...args: unknown[]): void {
        const start = this._timers.get(label);
        if (start === undefined) {
            this.warn(`Timer '${label}' does not exist`);
            return;
        }
        const ms = performance.now() - start;
        const extra = args.length ? ' ' + buildOutput(args) : '';
        this.log(`${label}: ${ms.toFixed(3)}ms${extra}`);
    }

    timeEnd(label = 'default'): void {
        const start = this._timers.get(label);
        if (start === undefined) {
            this.warn(`Timer '${label}' does not exist`);
            return;
        }
        const ms = performance.now() - start;
        this.log(`${label}: ${ms.toFixed(3)}ms`);
        this._timers.delete(label);
    }

    count(label = 'default'): void {
        const n = (this._counters.get(label) || 0) + 1;
        this._counters.set(label, n);
        this.log(`${label}: ${n}`);
    }

    countReset(label = 'default'): void {
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
        const err = new Error();
        const stack = err.stack?.split('\n').slice(2).join('\n') || '';
        this.log(...args);
        this.log('Trace' + stack);
    }

    assert(condition?: boolean, ...args: unknown[]): void {
        if (!condition) {
            const msg = args.length ? buildOutput(args) : 'console.assert';
            this.error(`Assertion failed: ${msg}`);
        }
    }

    clear(): void {
        this._write(this._stdout, '\x1b[2J\x1b[0;0H');
    }

    profile(_label?: string): void {}

    profileEnd(_label?: string): void {}

    timeStamp(_label?: string): void {}
}

function buildTable(data: unknown, columns?: string[]): string[] {
    const lines: string[] = [];
    const cols = getTableColumns(data, columns);

    if (cols.length <= 1) return ['(empty)'];

    const totalWidth = cols.reduce((sum, c) => sum + c.width + 1, 0);
    const sep = '─'.repeat(totalWidth - 1);

    const header = cols.map(c => pad(c.key, c.width)).join('\u2502');
    lines.push('\u250c' + sep + '\u2510');
    lines.push('\u2502' + header + '\u2502');
    lines.push('\u251c' + sep + '\u2524');

    if (Array.isArray(data)) {
        data.forEach((item, idx) => {
            const row: string[] = [pad(String(idx), cols[0].width)];
            for (let i = 1; i < cols.length; i++) {
                const key = cols[i].key;
                let val: string;
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    val = formatValue((item as Record<string, unknown>)[key]);
                } else if (cols.length === 2 && cols[1].key === 'Value') {
                    val = formatValue(item);
                } else {
                    val = '';
                }
                row.push(pad(val, cols[i].width));
            }
            lines.push('\u2502' + row.join('\u2502') + '\u2502');
        });
    } else if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
            if (columns && !columns.includes(k)) continue;
            const row = [
                pad('0', cols[0].width),
                pad(k, cols.find(c => c.key === 'Key')?.width || 10),
                pad(formatValue(v), cols.find(c => c.key === 'Value')?.width || 10)
            ];
            lines.push('\u2502' + row.join('\u2502') + '\u2502');
        }
    }

    lines.push('\u2514' + sep + '\u2518');
    return lines;
}

interface TableColumn {
    key: string;
    width: number;
}

function getTableColumns(data: unknown, columns?: string[]): TableColumn[] {
    const cols = new Map<string, number>();
    cols.set('(index)', '(index)'.length);

    if (Array.isArray(data)) {
        for (const item of data) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                for (const key of Object.keys(item)) {
                    if (columns && !columns.includes(key)) continue;
                    const val = formatValue((item as Record<string, unknown>)[key]);
                    cols.set(key, Math.max(cols.get(key) || key.length, val.length, key.length));
                }
            } else {
                const val = formatValue(item);
                cols.set('Value', Math.max(cols.get('Value') || 'Value'.length, val.length));
            }
        }
    } else if (data && typeof data === 'object') {
        cols.set('Key', 'Key'.length);
        cols.set('Value', 'Value'.length);
        for (const [k, v] of Object.entries(data)) {
            if (columns && !columns.includes(k)) continue;
            cols.set('Value', Math.max(cols.get('Value') || 'Value'.length, formatValue(v).length));
        }
    }

    const result: TableColumn[] = [];
    for (const [key, width] of cols) {
        result.push({ key, width: Math.min(Math.max(width, key.length), 50) + 2 });
    }
    return result;
}

function pad(str: string, width: number): string {
    const len = str.length;
    if (len >= width) return str.slice(0, width - 1) + '\u2026';
    return str + ' '.repeat(width - len);
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

function forward(name: ConsoleMethod) {
    return (...args: unknown[]) => {
        const fn = nativeConsole[name];
        if (typeof fn === 'function') {
            return fn.apply(nativeConsole, args);
        }
        const fallback = (globalThis.console as Record<string, any> | undefined)?.[name];
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

export const context = nativeConsole.context;
export const createTask = nativeConsole.createTask;
