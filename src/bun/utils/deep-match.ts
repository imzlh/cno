/**
 * Partial structural match used by Bun.deepMatch. Every enumerable property of
 * `subset` must match the same key on `value`; extra keys on `value` are ignored.
 * Arrays retain Bun's exact-length rule, while other objects compare only their
 * enumerable state rather than prototypes or internal slots.
 */
export function deepMatch(subset: unknown, value: unknown): boolean {
    const inProgress = new Map<object, Set<object>>();

    function match(s: unknown, v: unknown): boolean {
        if (!isObject(s) || !isObject(v)) return Object.is(s, v);
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

    function matchObjects(s: object | Function, v: object | Function): boolean {
        if (Array.isArray(s)) {
            if (!Array.isArray(v) || s.length !== v.length) return false;
        } else if (Array.isArray(v)) {
            // Non-array subsets can still match an array's enumerable indices.
        }

        // for..in intentionally includes enumerable inherited string keys. Bun
        // also considers own enumerable symbols, which for..in omits.
        for (const key in s) {
            if (!(key in v)) return false;
            if (!match(Reflect.get(s, key), Reflect.get(v, key))) return false;
        }
        for (const key of enumerableSymbols(s)) {
            if (!(key in v)) return false;
            if (!match(Reflect.get(s, key), Reflect.get(v, key))) return false;
        }
        return true;
    }

    if (!isObject(subset) || !isObject(value)) {
        throw new TypeError('Expected 2 objects to match');
    }
    return match(subset, value);
}

function isObject(value: unknown): value is object | Function {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function enumerableSymbols(value: object | Function): symbol[] {
    const symbols: symbol[] = [];
    const seen = new Set<symbol>();
    for (let current: object | null = value; current !== null; current = Object.getPrototypeOf(current)) {
        for (const key of Object.getOwnPropertySymbols(current)) {
            if (!Object.prototype.propertyIsEnumerable.call(current, key) || seen.has(key)) continue;
            seen.add(key);
            symbols.push(key);
        }
    }
    return symbols;
}
