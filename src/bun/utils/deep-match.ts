import { deepEquals } from './deep-equals';

/**
 * Partial structural match used by Bun.deepMatch. Every own enumerable property of
 * `subset` must match the same key on `value`; extra keys on `value` are ignored.
 * Arrays must have equal length and match element-wise. Built-in objects (Date,
 * RegExp, Map, Set, typed arrays, buffers, errors, wrappers) fall back to deepEquals.
 * A plain-object subset matches any object value; other class instances require the
 * same prototype.
 */
export function deepMatch(subset: unknown, value: unknown): boolean {
    const inProgress = new Map<object, Set<object>>();

    function match(s: unknown, v: unknown): boolean {
        if (typeof s !== 'object' || s === null || typeof v !== 'object' || v === null) {
            return deepEquals(s, v);
        }
        const active = inProgress.get(s);
        if (active?.has(v)) return true;
        if (!active) inProgress.set(s, new Set([v]));
        else active.add(v);
        try {
            return matchObjects(s, v);
        } finally {
            const set = inProgress.get(s);
            set?.delete(v);
            if (set?.size === 0) inProgress.delete(s);
        }
    }

    function matchObjects(s: object, v: object): boolean {
        if (Array.isArray(s)) {
            if (!Array.isArray(v) || s.length !== v.length) return false;
            for (let i = 0; i < s.length; i++) {
                if (!match(s[i], v[i])) return false;
            }
            return true;
        }
        if (Array.isArray(v) || isBuiltin(s)) return deepEquals(s, v);

        const proto = Object.getPrototypeOf(s);
        if (proto !== Object.prototype && proto !== null && Object.getPrototypeOf(v) !== proto) return false;

        for (const key of Reflect.ownKeys(s)) {
            if (!Object.prototype.propertyIsEnumerable.call(s, key)) continue;
            if (!(key in v)) return false;
            if (!match(Reflect.get(s, key), Reflect.get(v, key))) return false;
        }
        return true;
    }

    return match(subset, value);
}

function isBuiltin(value: object): boolean {
    return value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set
        || value instanceof Error || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
        || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
        || value instanceof Number || value instanceof String || value instanceof Boolean
        || value instanceof URL;
}
