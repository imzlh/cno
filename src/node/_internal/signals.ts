/* Node-layer copy of cno/src/utils/signals.ts: the node: install boundary
 * cannot reach the utils layer, so this bridge lives inside node/_internal.
 * Keep the two in sync. */
const nativeSignals = import.meta.use('signals');
const process = import.meta.use('process');
const nativeError = import.meta.use('error');

const namesByNumber = new Map<number, string>();
const nativeSignalNumbers = new Set<number>();
for (const [name, number] of Object.entries(nativeSignals?.signals ?? {})) {
    if (typeof number === 'number' && !namesByNumber.has(number)) {
        namesByNumber.set(number, name);
    }
    if (typeof number === 'number') nativeSignalNumbers.add(number);
}

const nodeSignalAliases: Readonly<Record<string, string>> = {
    SIGIO: 'SIGPOLL',
    SIGIOT: 'SIGABRT',
};

/** Resolve a public signal name to the branded number accepted by circu.js. */
export function nativeSignalNumber(name: string): CModuleSignals.Signal | undefined {
    return nativeSignals?.signals[name];
}

/** Resolve Node's accepted aliases as well as native canonical names. */
export function nodeNativeSignalNumber(name: string): CModuleSignals.Signal | undefined {
    return nativeSignalNumber(nodeSignalAliases[name] ?? name);
}

/** Brand a number only when it is present in this platform's native signal table. */
export function nativeSignalFromNumber(number: number): CModuleSignals.Signal | undefined {
    return nativeSignalNumbers.has(number) ? number as CModuleSignals.Signal : undefined;
}

/** Translate a numeric native wait result back to its canonical public name. */
export function nativeSignalName(number: number | null | undefined): string | null {
    if (number === null || number === undefined) return null;
    return namesByNumber.get(number) ?? null;
}

/** Translate a numeric wait result to Node's canonical public signal name. */
export function nodeSignalName(number: number | null | undefined): string | null {
    if (number === null || number === undefined) return null;
    if (number === nativeSignalNumber('SIGPOLL')) return 'SIGIO';
    return nativeSignalName(number);
}

/** Check process existence without sending a signal. */
export function probeProcess(pid: number): void {
    if (process.isAlive(pid)) return;
    throw nativeError.Error(nativeError.errno.ESRCH);
}

/** Node-style ERR_UNKNOWN_SIGNAL TypeError for unresolvable signal values. */
export function unknownSignalError(value: unknown): TypeError {
    const error = new TypeError(`Unknown signal: ${String(value)}`);
    Object.defineProperty(error, 'code', { value: 'ERR_UNKNOWN_SIGNAL', configurable: true });
    return error;
}
