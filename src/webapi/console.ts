/**
 * Full-featured console implementation
 * Supports: format specifiers, CSS styles, table, time, count, group, etc.
 */

const internal = import.meta.use('console');

// ANSI escape codes
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const styles: Record<string, string> = {
    // Styles
    bold: `${ESC}1m`, dim: `${ESC}2m`, italic: `${ESC}3m`,
    underline: `${ESC}4m`, blink: `${ESC}5m`, reverse: `${ESC}7m`,
    strikethrough: `${ESC}9m`,
    // Colors
    black: `${ESC}30m`, red: `${ESC}31m`, green: `${ESC}32m`,
    yellow: `${ESC}33m`, blue: `${ESC}34m`, magenta: `${ESC}35m`,
    cyan: `${ESC}36m`, white: `${ESC}37m`, gray: `${ESC}90m`,
    // Backgrounds
    bgBlack: `${ESC}40m`, bgRed: `${ESC}41m`, bgGreen: `${ESC}42m`,
    bgYellow: `${ESC}43m`, bgBlue: `${ESC}44m`, bgMagenta: `${ESC}45m`,
    bgCyan: `${ESC}46m`, bgWhite: `${ESC}47m`,
};

// Check if colors should be disabled
const noColor = (() => {
    try {
        if (typeof Deno !== 'undefined') {
            return Deno.env?.get?.('NO_COLOR') === '1' || !Deno.stdout?.isTerminal?.();
        }
    } catch { }
    return false;
})();

// Parse CSS style string to ANSI codes
function cssToAnsi(css: string): string {
    if (noColor) return '';
    const codes: string[] = [];
    for (const rule of css.toLowerCase().split(';')) {
        const [prop, val] = rule.split(':').map(s => s.trim());
        if (!prop || !val) continue;
        switch (prop) {
            case 'color':
                if (val in styles) codes.push(styles[val]);
                else if (val.startsWith('#')) {
                    // Convert hex to ANSI (simplified)
                    const r = parseInt(val.slice(1, 3), 16);
                    const g = parseInt(val.slice(3, 5), 16);
                    const b = parseInt(val.slice(5, 7), 16);
                    codes.push(`${ESC}38;2;${r};${g};${b}m`);
                }
                break;
            case 'background-color':
            case 'background':
                if (val in styles) codes.push(styles['bg' + val.charAt(0).toUpperCase() + val.slice(1)]);
                break;
            case 'font-weight':
                if (val === 'bold') codes.push(styles.bold);
                break;
            case 'font-style':
                if (val === 'italic') codes.push(styles.italic);
                break;
            case 'text-decoration':
                if (val.includes('underline')) codes.push(styles.underline);
                if (val.includes('line-through')) codes.push(styles.strikethrough);
                break;
        }
    }
    return codes.join('');
}

// Format value for display — primitives handled here, everything else delegated to native inspect
function formatValue(val: unknown): string {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') return String(val);
    if (typeof val === 'symbol') return val.toString();
    try {
        return (internal as any).inspect(val, { depth: 4 });
    } catch {
        return String(val);
    }
}

// Apply format specifiers
function applyFormat(format: string, args: unknown[]): { text: string; consumed: number } {
    let result = '';
    let argIdx = 0;
    let i = 0;

    while (i < format.length) {
        if (format[i] === '%' && i + 1 < format.length) {
            const spec = format[i + 1];
            if (argIdx < args.length) {
                const arg = args[argIdx++];
                switch (spec) {
                    case 's':
                        result += String(arg);
                        i += 2;
                        continue;
                    case 'd':
                    case 'i':
                        result += typeof arg === 'bigint' ? String(arg) : String(parseInt(String(arg), 10) || 0);
                        i += 2;
                        continue;
                    case 'f':
                        result += String(parseFloat(String(arg)) || 0);
                        i += 2;
                        continue;
                    case 'o':
                    case 'O':
                        try {
                            result += (internal as any).inspect(arg, { depth: spec === 'O' ? 100 : 4 });
                        } catch {
                            result += String(arg);
                        }
                        i += 2;
                        continue;
                    case 'c':
                        // CSS style - apply ANSI codes to subsequent text
                        // Note: In terminal, we apply style and reset after
                        // The style affects the next text until another %c or reset
                        if (!noColor) {
                            result += cssToAnsi(String(arg));
                        }
                        i += 2;
                        continue;
                    case '%':
                        result += '%';
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

// Build output from arguments
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

// =================== TABLE IMPLEMENTATION ===================

// Flat single-line formatter for table cells — avoids multiline inspect output
function formatCell(val: unknown): string {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') return val.length > 50 ? val.slice(0, 47) + '...' : val;
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') return String(val);
    if (typeof val === 'symbol') return val.toString();
    if (typeof val === 'function') return `[Function: ${(val as Function).name || 'anonymous'}]`;
    if (Array.isArray(val)) return `Array(${val.length})`;
    if (val instanceof Map) return `Map(${val.size})`;
    if (val instanceof Set) return `Set(${val.size})`;
    if (typeof val === 'object') {
        const name = (val as any)?.constructor?.name;
        const tag = name && name !== 'Object' ? name + ' ' : '';
        try {
            const keys = Object.keys(val as object);
            if (keys.length === 0) return `${tag}{}`;
            return `${tag}{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''}}`;
        } catch {
            return `${tag}{}`;
        }
    }
    return String(val);
}

interface TableColumn {
    key: string;
    width: number;
}

function getTableColumns(data: unknown, columns?: string[]): TableColumn[] {
    const cols = new Map<string, number>();

    // Add index column
    cols.set('(index)', '(index)'.length);

    if (Array.isArray(data)) {
        // Get all possible keys from all objects
        for (const item of data) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                for (const key of Object.keys(item)) {
                    if (columns && !columns.includes(key)) continue;
                    const val = formatCell((item as Record<string, unknown>)[key]);
                    cols.set(key, Math.max(cols.get(key) || key.length, val.length, key.length));
                }
            } else {
                // Primitive array
                const val = formatCell(item);
                cols.set('Value', Math.max(cols.get('Value') || 'Value'.length, val.length));
            }
        }
    } else if (data && typeof data === 'object') {
        // Single object - show as key-value table
        cols.set('Key', 'Key'.length);
        cols.set('Value', 'Value'.length);
        for (const [k, v] of Object.entries(data)) {
            if (columns && !columns.includes(k)) continue;
            cols.set('Key', Math.max(cols.get('Key') || 'Key'.length, k.length));
            cols.set('Value', Math.max(cols.get('Value') || 'Value'.length, formatCell(v).length));
        }
    }

    // Remove empty columns except index
    const result: TableColumn[] = [];
    for (const [key, width] of cols) {
        if (key === '(index)' || width > key.length) {
            result.push({ key, width: Math.min(width, 50) + 2 }); // +1 for padding
        }
    }
    return result;
}

function pad(str: string, width: number): string {
    const len = str.length;
    if (len >= width) return str.slice(0, width - 1) + '…';
    return str + ' '.repeat(width - len);
}

function printTable(data: unknown, columns?: string[]): string[] {
    const lines: string[] = [];
    const cols = getTableColumns(data, columns);

    if (cols.length <= 1) {
        // No data columns
        return ['(empty)'];
    }

    // Build separator
    const totalWidth = cols.reduce((sum, c) => sum + c.width + 1, 0);
    const sep = '─'.repeat(totalWidth - 1);

    // Header
    const header = cols.map(c => pad(c.key, c.width)).join('│');
    lines.push('┌' + sep + '┐');
    lines.push('│' + header + '│');
    lines.push('├' + sep + '┤');

    // Rows
    if (Array.isArray(data)) {
        data.forEach((item, idx) => {
            const row: string[] = [pad(String(idx), cols[0].width)];
            for (let i = 1; i < cols.length; i++) {
                const key = cols[i].key;
                let val: string;
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    val = formatCell((item as Record<string, unknown>)[key]);
                } else if (cols.length === 2 && cols[1].key === 'Value') {
                    val = formatCell(item);
                } else {
                    val = '';
                }
                row.push(pad(val, cols[i].width));
            }
            lines.push('│' + row.join('│') + '│');
        });
    } else if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
            if (columns && !columns.includes(k)) continue;
            const row = [
                pad(k, cols[0].width),
                pad(k, cols.find(c => c.key === 'Key')?.width || 10),
                pad(formatCell(v), cols.find(c => c.key === 'Value')?.width || 10)
            ];
            lines.push('│' + row.join('│') + '│');
        }
    }

    lines.push('└' + sep + '┘');
    return lines;
}

// =================== STATE ===================

const timers = new Map<string, number>();
const counters = new Map<string, number>();
let groupIndent = '';

// =================== CONSOLE API ===================

const webConsole = {
    log(...args: unknown[]) {
        internal.log(groupIndent + buildOutput(args));
    },

    info(...args: unknown[]) {
        internal.info(groupIndent + buildOutput(args));
    },

    warn(...args: unknown[]) {
        internal.warn(groupIndent + buildOutput(args));
    },

    error(...args: unknown[]) {
        internal.error(groupIndent + buildOutput(args));
    },

    debug(...args: unknown[]) {
        internal.debug?.(groupIndent + buildOutput(args)) ?? internal.log(groupIndent + buildOutput(args));
    },

    dir(obj: unknown, options?: { depth?: number; colors?: boolean }) {
        (internal as any).dir(obj);
    },

    dirxml(...args: unknown[]) {
        this.log(...args);
    },

    table(data: unknown, columns?: string[]) {
        if (!data) {
            this.log(data);
            return;
        }
        const lines = printTable(data, columns);
        for (const line of lines) {
            internal.log(groupIndent + line);
        }
    },

    time(label = 'default') {
        timers.set(label, performance.now());
    },

    timeLog(label = 'default', ...args: unknown[]) {
        const start = timers.get(label);
        if (start === undefined) {
            this.warn(`Timer '${label}' does not exist`);
            return;
        }
        const ms = performance.now() - start;
        const extra = args.length ? ' ' + buildOutput(args) : '';
        this.log(`${label}: ${ms.toFixed(3)}ms${extra}`);
    },

    timeEnd(label = 'default') {
        const start = timers.get(label);
        if (start === undefined) {
            this.warn(`Timer '${label}' does not exist`);
            return;
        }
        const ms = performance.now() - start;
        this.log(`${label}: ${ms.toFixed(3)}ms`);
        timers.delete(label);
    },

    count(label = 'default') {
        const n = (counters.get(label) || 0) + 1;
        counters.set(label, n);
        this.log(`${label}: ${n}`);
    },

    countReset(label = 'default') {
        counters.delete(label);
    },

    group(...args: unknown[]) {
        if (args.length) this.log(...args);
        groupIndent += '  ';
    },

    groupCollapsed(...args: unknown[]) {
        this.group(...args);
    },

    groupEnd() {
        groupIndent = groupIndent.slice(0, -2);
    },

    trace(...args: unknown[]) {
        const err = new Error();
        const stack = err.stack?.split('\n').slice(2).join('\n') || '';
        this.log(...args);
        this.log(stack);
    },

    clear() {
        internal.clear?.();
    },

    assert(condition?: boolean, ...args: unknown[]) {
        if (!condition) {
            const msg = args.length ? buildOutput(args) : 'console.assert';
            this.error(`Assertion failed: ${msg}`);
        }
    },

    profile() { },
    profileEnd() { },

    // Additional formatting
    format,
};

function format(template: string, ...args: unknown[]): string {
    const { text } = applyFormat(template, args);
    return text;
}

// Export
Object.defineProperty(globalThis, 'console', {
    value: webConsole,
    writable: true,
    enumerable: true,
    configurable: true,
});
