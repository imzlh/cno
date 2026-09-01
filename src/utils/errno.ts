export function hasErrno(value: unknown, code: number): boolean {
    return typeof value === 'object' && value !== null
        && Reflect.get(value, 'code') === code;
}
