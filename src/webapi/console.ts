/**
 * Web/global console facade.
 *
 * The native console module owns formatting and output. Keep this layer thin so
 * globalThis.console behaves the same as import.meta.use('console').
 */

const internal = import.meta.use('console') as Record<string, any>;

function call(name: string, fallback: string, args: unknown[]): void {
    const fn = internal[name] ?? internal[fallback];
    if (typeof fn === 'function') fn.apply(internal, args);
}

function inspect(value: unknown, depth = 4): string {
    try {
        if (typeof internal.inspect === 'function') {
            return internal.inspect(value, { depth });
        }
    } catch { }
    return String(value);
}

function json(value: unknown): string {
    try {
        const seen = new WeakSet<object>();
        const out = JSON.stringify(value, (_key, current) => {
            if (typeof current === 'object' && current !== null) {
                if (seen.has(current)) return '[Circular]';
                seen.add(current);
            }
            return current;
        });
        return out === undefined ? 'undefined' : out;
    } catch {
        return '[Circular]';
    }
}

function format(template: string, ...args: unknown[]): string {
    let result = '';
    let argIndex = 0;

    for (let i = 0; i < template.length; i++) {
        if (template[i] !== '%' || i + 1 >= template.length) {
            result += template[i];
            continue;
        }

        const spec = template[++i];
        if (spec === '%') {
            result += '%';
            continue;
        }
        if (argIndex >= args.length) {
            result += `%${spec}`;
            continue;
        }

        const arg = args[argIndex++];
        switch (spec) {
            case 's':
                result += String(arg);
                break;
            case 'd':
            case 'i':
                result += typeof arg === 'bigint' ? String(arg) : String(Math.trunc(Number(arg)));
                break;
            case 'f':
                result += typeof arg === 'bigint' ? String(arg) : String(Number(arg));
                break;
            case 'j':
                result += json(arg);
                break;
            case 'o':
                result += inspect(arg, 4);
                break;
            case 'O':
                result += inspect(arg, 100);
                break;
            case 'c':
                break;
            default:
                result += `%${spec}`;
                argIndex--;
                break;
        }
    }

    if (argIndex < args.length) {
        const rest = args.slice(argIndex).map((arg) => typeof arg === 'string' ? arg : inspect(arg, 2));
        if (rest.length) result += `${result ? ' ' : ''}${rest.join(' ')}`;
    }

    return result;
}

const webConsole = {
    log(...args: unknown[]) {
        call('log', 'log', args);
    },

    info(...args: unknown[]) {
        call('info', 'log', args);
    },

    warn(...args: unknown[]) {
        call('warn', 'error', args);
    },

    error(...args: unknown[]) {
        call('error', 'log', args);
    },

    debug(...args: unknown[]) {
        call('debug', 'log', args);
    },

    dir(obj?: unknown, options?: { depth?: number; colors?: boolean }) {
        call('dir', 'log', options === undefined ? [obj] : [obj, options]);
    },

    dirxml(...args: unknown[]) {
        call('dirxml', 'log', args);
    },

    table(data?: unknown, columns?: readonly string[]) {
        call('table', 'log', columns === undefined ? [data] : [data, columns]);
    },

    trace(...args: unknown[]) {
        call('trace', 'error', args);
    },

    clear() {
        call('clear', 'log', []);
    },

    assert(condition?: unknown, ...args: unknown[]) {
        call('assert', 'error', [condition, ...args]);
    },

    count(label?: string) {
        call('count', 'log', label === undefined ? [] : [label]);
    },

    countReset(label?: string) {
        call('countReset', 'warn', label === undefined ? [] : [label]);
    },

    time(label?: string) {
        call('time', 'log', label === undefined ? [] : [label]);
    },

    timeLog(label?: string, ...args: unknown[]) {
        call('timeLog', 'log', label === undefined ? ['default', ...args] : [label, ...args]);
    },

    timeEnd(label?: string) {
        call('timeEnd', 'log', label === undefined ? [] : [label]);
    },

    timeStamp(label?: string) {
        call('timeStamp', 'log', label === undefined ? [] : [label]);
    },

    group(...args: unknown[]) {
        call('group', 'log', args);
    },

    groupCollapsed(...args: unknown[]) {
        call('groupCollapsed', 'group', args);
    },

    groupEnd() {
        call('groupEnd', 'log', []);
    },

    profile(_label?: string) { },
    profileEnd(_label?: string) { },

    format,
};

Object.defineProperty(globalThis, 'console', {
    value: webConsole,
    writable: true,
    enumerable: true,
    configurable: true,
});
