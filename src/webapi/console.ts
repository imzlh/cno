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

function format(...allArgs: unknown[]): string {
    return String(internal.format.apply(internal, allArgs));
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
