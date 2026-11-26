const nativeError = import.meta.use('error');

export type ErrnoCode = string | number;

const entries = Object.freeze(
    Object.entries(nativeError.errno)
        .filter(([name]) => name !== 'OK')
        .map(([name, value]) => Object.freeze([name, value] as const)),
);

export const unknownErrno = nativeError.errno.UNKNOWN;
const errnoByName = new Map<string, number>();
const nameByErrno = new Map<number, string>();

for (const [name, value] of entries) {
    errnoByName.set(name, value);
    if (!nameByErrno.has(value)) nameByErrno.set(value, name);
}

export function errnoEntries(): readonly (readonly [string, number])[] {
    return entries;
}

export function errnoCode(name: string): number | undefined {
    return errnoByName.get(name);
}

export function errnoName(value: number): string | undefined {
    return nameByErrno.get(value);
}

export const errnoMessage = nativeError.strerror;
export const errnoDescription = nativeError.getErrorMessage;
export const systemErrorName = nativeError.getErrorName;

/** Build the UV binding's errno map, whose duplicate values keep the last alias. */
export function systemErrorMap(): Map<number, [string, string]> {
    const map = new Map<number, [string, string]>();
    for (const [name, value] of entries) {
        map.set(value, [name, errnoDescription(value)]);
    }
    return map;
}

export function isErrorValue(value: unknown): value is Error {
    return Error.isError(value);
}

/**
 * Read the structured code attached by a native or Node-style error.
 *
 * Native errors and the Node facade share the code field but may not share an
 * Error prototype. Keep property access structural and safe for foreign values.
 */
export function errorCode(value: unknown): ErrnoCode | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    try {
        const code = Reflect.get(value, 'code');
        return typeof code === 'string' || typeof code === 'number' ? code : undefined;
    } catch {
        return undefined;
    }
}

export function hasErrno(value: unknown, code: number): boolean {
    return isErrorValue(value) && errorCode(value) === code;
}

export function matchesErrnoCode(value: unknown, ...names: string[]): boolean {
    if (!isErrorValue(value)) return false;
    const code = errorCode(value);
    if (typeof code === 'string') return names.includes(code);
    if (typeof code !== 'number') return false;
    return names.some((name) => errnoByName.get(name) === code);
}
