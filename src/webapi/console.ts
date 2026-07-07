/**
 * Web/global console facade.
 *
 * The native console module owns formatting and output. Keep this layer thin so
 * globalThis.console behaves the same as import.meta.use('console').
 */

const internal = import.meta.use('console');
type ConsoleMethod = keyof typeof internal;
type NativeConsoleFunction = (this: typeof internal, ...args: unknown[]) => unknown;

function call(name: ConsoleMethod, fallback: ConsoleMethod, args: unknown[]): void {
    const fn = internal[name] ?? internal[fallback];
    if (typeof fn === 'function') Reflect.apply(fn as NativeConsoleFunction, internal, args);
}

function format(...allArgs: unknown[]): string {
    const fn = internal.format;
    return typeof fn === 'function'
        ? String(Reflect.apply(fn, internal, allArgs))
        : allArgs.map(String).join(' ');
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

Object.setPrototypeOf(webConsole, Object.create(Object.prototype));

Object.defineProperty(globalThis, 'console', {
    value: webConsole,
    writable: true,
    enumerable: true,
    configurable: true,
});
