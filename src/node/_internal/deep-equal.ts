/**
 * Shared deep equality implementation for Node.js polyfill modules.
 * Used by both assert and util modules.
 */

const algorithm = import.meta.use('algorithm');

function sameValueZero(a: unknown, b: unknown): boolean {
    return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

function primitiveEqual(a: unknown, b: unknown, strict: boolean): boolean {
    return strict ? Object.is(a, b) : sameValueZero(a, b);
}

/**
 * Deep equality check supporting strict mode, prototype comparison,
 * boxed primitives, and circular references.
 *
 * @param strict - When true, uses SameValueZero and checks symbol keys
 * @param skipPrototype - When true, skips prototype identity check
 * @param seen - Internal WeakMap for circular reference detection
 */
export function deepEqual(
    a: unknown,
    b: unknown,
    strict: boolean,
    skipPrototype: boolean = false,
    seen = new WeakMap<object, object>(),
): boolean {
    if (strict ? Object.is(a, b) : a === b) return true;
    if (!strict && a == b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object' || a === null || b === null) return false;
    const aObject = a;
    const bObject = b;

    // Circular reference protection
    if (seen.get(aObject) === bObject) return true;
    seen.set(aObject, bObject);

    // Boxed primitives
    if (a instanceof Number && b instanceof Number) return primitiveEqual(a.valueOf(), b.valueOf(), strict);
    if (a instanceof Boolean && b instanceof Boolean) return primitiveEqual(a.valueOf(), b.valueOf(), strict);
    if (a instanceof String && b instanceof String) return primitiveEqual(a.valueOf(), b.valueOf(), strict);

    // Prototype check
    if (!skipPrototype && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

    // Date
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    // RegExp
    if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
    // ArrayBuffer
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
        const av = new Uint8Array(a);
        const bv = new Uint8Array(b);
        if (av.length !== bv.length) return false;
        return algorithm.bytesEqual(av, bv);
    }
    // TypedArray / DataView
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
        const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        if (av.length !== bv.length) return false;
        return algorithm.bytesEqual(av, bv);
    }
    // Map
    if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false;
        for (const [key, value] of a) {
            if (!b.has(key) || !deepEqual(value, b.get(key), strict, skipPrototype, seen)) return false;
        }
        return true;
    }
    // Set
    if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false;
        for (const value of a) {
            if (!b.has(value)) {
                // .has() uses reference equality; for objects, do deep comparison
                let found = false;
                for (const bv of b) {
                    if (deepEqual(value, bv, strict, skipPrototype, seen)) { found = true; break; }
                }
                if (!found) return false;
            }
        }
        return true;
    }

    if (Array.isArray(a) !== Array.isArray(b)) return false;

    // Own keys comparison
    const aKeys = Reflect.ownKeys(aObject);
    const bKeys = Reflect.ownKeys(bObject);

    // In non-strict mode, only compare string keys (skip symbols)
    const effectiveAKeys = strict ? aKeys : aKeys.filter(k => typeof k === 'string');
    const effectiveBKeys = strict ? bKeys : bKeys.filter(k => typeof k === 'string');
    if (effectiveAKeys.length !== effectiveBKeys.length) return false;

    for (const key of effectiveAKeys) {
        if (!effectiveBKeys.includes(key)) return false;
        if (!deepEqual(Reflect.get(aObject, key), Reflect.get(bObject, key), strict, skipPrototype, seen)) return false;
    }

    return true;
}
