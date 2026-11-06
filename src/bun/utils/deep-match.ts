/**
 * Partial structural match used by Bun.deepMatch. Every enumerable property of
 * `subset` must match the same key on `value`; extra keys on `value` are ignored.
 * Arrays retain Bun's exact-length rule, while other objects compare only their
 * enumerable state rather than prototypes or internal slots. Host objects can
 * differ when CNO and Bun expose different enumerable prototype properties.
 */
export const deepMatch = {
    deepMatch(subset: unknown, value: unknown): boolean {
        const inProgress = new Set<object>();
        let repeatedReferences = 0;

        function match(s: unknown, v: unknown): boolean {
            if (Object.is(s, v)) return true;
            if (!isObject(s) || !isObject(v)) return Object.is(s, v);
            const active = inProgress.has(s);
            if (active && repeatedReferences >= 1) return true;
            if (active) repeatedReferences++;
            else inProgress.add(s);
            try {
                return matchObjects(s, v);
            } finally {
                if (active) repeatedReferences--;
                else inProgress.delete(s);
            }
        }

        function matchObjects(s: object | Function, v: object | Function): boolean {
            if (Array.isArray(s)) {
                if (!Array.isArray(v) || s.length !== v.length) return false;
                return matchArrays(s, v);
            }

            for (const key of enumerableKeys(s)) {
                if (!(key in v)) return false;
                const target = Reflect.get(v, key);
                if (!match(Reflect.get(s, key), target)) return false;
            }
            return true;
        }

        function matchArrays(s: unknown[], v: unknown[]): boolean {
            const sKeys = enumerableKeys(s), vKeys = enumerableKeys(v);
            if (sKeys.length !== vKeys.length) return false;
            const targetKeys = new Map(vKeys.map(key => [key, isOwnEnumerable(v, key)]));
            for (const key of sKeys) {
                if (!targetKeys.has(key) || targetKeys.get(key) !== isOwnEnumerable(s, key)) return false;
                const target = Reflect.get(v, key);
                if (!match(Reflect.get(s, key), target)) return false;
            }
            return true;
        }

        if (arguments.length < 2) throw new TypeError('Expected 2 values to compare');
        if (!isObject(subset) || !isObject(value)) {
            throw new TypeError('Expected 2 objects to match');
        }
        return match(subset, value);
    }
}.deepMatch;

function isOwnEnumerable(value: object, key: string | symbol): boolean {
    return Object.prototype.propertyIsEnumerable.call(value, key);
}

function isObject(value: unknown): value is object | Function {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function enumerableKeys(value: object | Function): (string | symbol)[] {
    const keys: (string | symbol)[] = [];
    const seen = new Set<string | symbol>();
    for (let current: object | null = value; current !== null; current = Object.getPrototypeOf(current)) {
        for (const key of Reflect.ownKeys(current)) {
            if (seen.has(key)) continue;
            if (!Object.prototype.propertyIsEnumerable.call(current, key)) continue;
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}
