/**
 * Structural equality with Bun's loose-by-default object and array rules.
 * Handles local-realm builtins; host objects are compared by enumerable state.
 */
export function deepEquals(a: unknown, b: unknown, strict = false): boolean {
    const strictMode = strict === true;
    const left = new Map<object, number>();
    const right = new Map<object, number>();
    const objectToString = Object.prototype.toString;

    function equal(x: unknown, y: unknown, depth: number): boolean {
        if (Object.is(x, y)) return true;
        if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) return false;
        const lx = left.get(x), ry = right.get(y);
        if (lx !== undefined || ry !== undefined) return lx !== undefined && lx === ry;
        left.set(x, depth);
        right.set(y, depth);
        try { return objectsEqual(x, y, depth + 1); }
        finally { left.delete(x); right.delete(y); }
    }

    function keys(value: object): (string | symbol)[] {
        return Reflect.ownKeys(value).filter(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable);
    }
    function properties(x: object, y: object, depth: number): boolean {
        const xKeys = keys(x), yKeys = keys(y);
        for (const key of xKeys) {
            if (!yKeys.includes(key)) {
                if (strictMode || Reflect.get(x, key) !== undefined) return false;
                // Missing own properties do not read inherited values or getters.
                continue;
            }
            if (!equal(Reflect.get(x, key), Reflect.get(y, key), depth)) return false;
        }
        for (const key of yKeys) {
            if (!xKeys.includes(key) && (strictMode || Reflect.get(y, key) !== undefined)) return false;
        }
        return true;
    }
    function symbolProperties(x: object, y: object, depth: number): boolean {
        const xKeys = keys(x).filter((key): key is symbol => typeof key === 'symbol');
        const yKeys = keys(y).filter((key): key is symbol => typeof key === 'symbol');
        for (const key of xKeys) {
            if (!yKeys.includes(key)) {
                if (strictMode || Reflect.get(x, key) !== undefined) return false;
                continue;
            }
            if (!equal(Reflect.get(x, key), Reflect.get(y, key), depth)) return false;
        }
        for (const key of yKeys) {
            if (!xKeys.includes(key) && (strictMode || Reflect.get(y, key) !== undefined)) return false;
        }
        return true;
    }
    function unordered(xs: unknown[], ys: unknown[], compare: (x: unknown, y: unknown) => boolean): boolean {
        if (xs.length !== ys.length) return false;
        const remaining = ys.slice();
        for (const x of xs) {
            const i = remaining.findIndex(y => compare(x, y));
            if (i < 0) return false;
            remaining.splice(i, 1);
        }
        return true;
    }
    function bytes(x: ArrayBufferView | ArrayBuffer, y: ArrayBufferView | ArrayBuffer): boolean {
        const a = x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        const b = y instanceof ArrayBuffer ? new Uint8Array(y) : new Uint8Array(y.buffer, y.byteOffset, y.byteLength);
        return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    function tag(value: object): string {
        return Reflect.apply(objectToString, value, []);
    }
    function prototypesEqual(x: object, y: object): boolean {
        const constructor = (value: object | null): unknown => {
            if (value === null) return undefined;
            const result = Reflect.get(value, 'constructor');
            return result === Object ? undefined : result;
        };
        return constructor(Object.getPrototypeOf(x)) === constructor(Object.getPrototypeOf(y));
    }
    function objectsEqual(x: object, y: object, depth: number): boolean {
        if (Array.isArray(x) || Array.isArray(y)) {
            if (!Array.isArray(x) || !Array.isArray(y)) return false;
            if (strictMode && x.length !== y.length) return false;
            const length = Math.max(x.length, y.length);
            for (let i = 0; i < length; i++) {
                if (strictMode && (i in x) !== (i in y)) return false;
                if (!equal(x[i], y[i], depth)) return false;
            }
            return symbolProperties(x, y, depth);
        }
        const xTag = tag(x), yTag = tag(y);
        if (xTag === '[object Date]' || yTag === '[object Date]') {
            return xTag === yTag && Date.prototype.getTime.call(x) === Date.prototype.getTime.call(y);
        }
        if (xTag === '[object RegExp]' || yTag === '[object RegExp]') {
            return xTag === yTag && RegExp.prototype.toString.call(x) === RegExp.prototype.toString.call(y);
        }
        if (x instanceof Error || y instanceof Error) {
            return x instanceof Error && y instanceof Error && x.name === y.name && x.message === y.message
                && equal(x.cause, y.cause, depth) && properties(x, y, depth);
        }
        if (xTag === '[object Map]' || yTag === '[object Map]') {
            if (xTag !== yTag) return false;
            return unordered(Array.from(x as Map<unknown, unknown>), Array.from(y as Map<unknown, unknown>), (a, b) => {
                const [ak, av] = a as [unknown, unknown], [bk, bv] = b as [unknown, unknown];
                return equal(ak, bk, depth) && equal(av, bv, depth);
            });
        }
        if (xTag === '[object Set]' || yTag === '[object Set]') {
            if (xTag !== yTag) return false;
            return unordered(Array.from(x as Set<unknown>), Array.from(y as Set<unknown>), (a, b) => equal(a, b, depth));
        }
        if (xTag === '[object ArrayBuffer]' || yTag === '[object ArrayBuffer]') {
            return xTag === yTag && bytes(x as ArrayBuffer, y as ArrayBuffer);
        }
        if (typeof SharedArrayBuffer !== 'undefined' && (x instanceof SharedArrayBuffer || y instanceof SharedArrayBuffer)) {
            if (!(x instanceof SharedArrayBuffer) || !(y instanceof SharedArrayBuffer)) return false;
            const a = new Uint8Array(x), b = new Uint8Array(y);
            return a.length === b.length && a.every((value, i) => value === b[i]);
        }
        if (ArrayBuffer.isView(x) || ArrayBuffer.isView(y)) {
            if (!ArrayBuffer.isView(x) || !ArrayBuffer.isView(y) || xTag !== yTag) return false;
            if (xTag === '[object DataView]') return bytes(x, y) && properties(x, y, depth);
            if (strictMode) return bytes(x, y) && properties(x, y, depth);
            const a = x as unknown as ArrayLike<number | bigint>, b = y as unknown as ArrayLike<number | bigint>;
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
            return true;
        }
        if (x instanceof Number || y instanceof Number || x instanceof String || y instanceof String || x instanceof Boolean || y instanceof Boolean
            || x instanceof BigInt || y instanceof BigInt || x instanceof Symbol || y instanceof Symbol) {
            if (Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) return false;
            if (!Object.is(x.valueOf(), y.valueOf())) return false;
        }
        if (typeof URL !== 'undefined' && x instanceof URL && y instanceof URL && x.href !== y.href) return false;
        if (strictMode && !prototypesEqual(x, y)) return false;
        return properties(x, y, depth);
    }
    return equal(a, b, 0);
}
