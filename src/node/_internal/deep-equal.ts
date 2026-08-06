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

// Loose mode ignores prototype identity but still separates object *kinds*:
// Node reports `Object.create(null)` == `{}` yet `[]` != `{}` and
// `new Error('x')` != `{ message: 'x' }`.
function kindOf(value: object): string {
    if (Array.isArray(value)) return 'Array';
    if (value instanceof Date) return 'Date';
    if (value instanceof RegExp) return 'RegExp';
    if (value instanceof Error) return 'Error';
    if (value instanceof Map) return 'Map';
    if (value instanceof Set) return 'Set';
    if (value instanceof WeakMap) return 'WeakMap';
    if (value instanceof WeakSet) return 'WeakSet';
    if (value instanceof Promise) return 'Promise';
    if (value instanceof ArrayBuffer) return 'ArrayBuffer';
    if (value instanceof Number) return 'Number';
    if (value instanceof String) return 'String';
    if (value instanceof Boolean) return 'Boolean';
    // Typed arrays / DataView keep their exact type: Node reports
    // Uint8Array([1]) != Int8Array([1]) even in loose mode.
    if (ArrayBuffer.isView(value)) return value.constructor?.name ?? 'View';
    return 'Object';
}

// Node compares only *enumerable* own properties in both modes, so a
// non-enumerable property never makes two objects unequal.
function enumerableOwnKeys(value: object, includeSymbols: boolean): (string | symbol)[] {
    const keys: (string | symbol)[] = Object.keys(value);
    if (!includeSymbols) return keys;
    for (const sym of Object.getOwnPropertySymbols(value)) {
        if (Object.getOwnPropertyDescriptor(value, sym)?.enumerable) keys.push(sym);
    }
    return keys;
}

// Loose mode compares typed arrays element-wise with ==, so F64[-0] equals
// F64[0] while F64[NaN] does not equal F64[NaN]. Strict mode compares raw
// bytes, which gives the opposite (and correct) answer for both.
function looseViewEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
    if (a instanceof DataView || b instanceof DataView) {
        if (!(a instanceof DataView) || !(b instanceof DataView)) return false;
        if (a.byteLength !== b.byteLength) return false;
        const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        return algorithm.bytesEqual(av, bv);
    }
    const av = a as unknown as ArrayLike<number | bigint>;
    const bv = b as unknown as ArrayLike<number | bigint>;
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
        // eslint-disable-next-line eqeqeq
        if (!(av[i] == bv[i])) return false;
    }
    return true;
}

// A typed array's indices are enumerable own keys, and the elements have already
// been compared byte-wise, so only the non-index extras are of interest here.
function isIndexKey(key: string | symbol): boolean {
    return typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key);
}

function extraViewKeysEqual(
    a: ArrayBufferView,
    b: ArrayBufferView,
    strict: boolean,
    skipPrototype: boolean,
    seen: PathState,
): boolean {
    const aKeys = enumerableOwnKeys(a, strict).filter(k => !isIndexKey(k));
    const bKeys = enumerableOwnKeys(b, strict).filter(k => !isIndexKey(k));
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!bKeys.includes(key)) return false;
        if (!deepEqual(Reflect.get(a, key), Reflect.get(b, key), strict, skipPrototype, seen)) return false;
    }
    return true;
}

// Unordered structural matching for Set/Map entries. Both are *multisets* once
// object members are compared structurally, so a candidate that has already been
// paired off must not be reused: Set{ {x:1}, {x:1} } is not equal to
// Set{ {x:1}, {x:2} } even though every left element finds *some* right match.
// Matching Node, this is greedy-with-removal rather than a full bipartite match.
//
// `fastEqual` reproduces Node's first pass, which asks the collection itself
// (Set.has / Map.has) and therefore uses SameValueZero. That is why Node reports
// Set([0]) equal to Set([-0]) while deepStrictEqual(0, -0) is unequal.
function matchUnordered(
    left: unknown[],
    right: unknown[],
    compare: (a: unknown, b: unknown) => boolean,
    fastEqual?: (a: unknown, b: unknown) => boolean,
): boolean {
    if (left.length !== right.length) return false;
    const remaining = right.slice();
    let pending = left;

    if (fastEqual) {
        pending = [];
        for (const item of left) {
            let hit = -1;
            for (let i = 0; i < remaining.length; i++) {
                if (fastEqual(item, remaining[i])) { hit = i; break; }
            }
            if (hit === -1) pending.push(item);
            else remaining.splice(hit, 1);
        }
    }

    for (const item of pending) {
        let hit = -1;
        for (let i = 0; i < remaining.length; i++) {
            if (compare(item, remaining[i])) { hit = i; break; }
        }
        if (hit === -1) return false;
        remaining.splice(hit, 1);
    }
    return true;
}

/**
 * Cycle-detection state. Node's algorithm records, for each side, the *position*
 * at which an object was entered on the current comparison path — not a set of
 * every pair ever visited. Two cyclic structures are equal only if their
 * back-edges land at the same depth on both sides, which is what distinguishes
 * `a.self = a` from `b.self = { self: b }`.
 *
 * Entries are removed as the recursion unwinds, so this tracks the path rather
 * than the whole traversal. That matters: Node is *not* reference-topology
 * sensitive for acyclic values, and reports `[a, a]` deep-equal to
 * `[{x:1}, {x:1}]` even though the left side shares one reference.
 */
interface PathState {
    left: Map<object, number>;
    right: Map<object, number>;
    depth: number;
}

/**
 * Deep equality check supporting strict mode, prototype comparison,
 * boxed primitives, and circular references.
 *
 * @param strict - When true, uses Object.is, compares prototypes and symbol keys
 * @param skipPrototype - When true, skips prototype identity check
 */
export function deepEqual(
    a: unknown,
    b: unknown,
    strict: boolean,
    skipPrototype: boolean = false,
    state: PathState = { left: new Map(), right: new Map(), depth: 0 },
): boolean {
    if (strict ? Object.is(a, b) : sameValueZero(a, b)) return true;

    // A boxed primitive never equals a bare one: Node reports
    // new Number(1) != 1 in loose mode too.
    const aIsObject = typeof a === 'object' && a !== null;
    const bIsObject = typeof b === 'object' && b !== null;
    if (!aIsObject || !bIsObject) {
        if (aIsObject !== bIsObject) return false;
        // Both primitives and not already equal: loose mode still allows ==
        // across types (1 == '1'), strict mode does not.
        return strict ? false : a == b;
    }
    const aObject = a;
    const bObject = b;

    const aSeen = state.left.has(aObject);
    const bSeen = state.right.has(bObject);
    if (aSeen || bSeen) {
        // Both sides closed a cycle: equal only if they closed it at the same
        // depth. One side only: the structures differ in shape.
        if (aSeen && bSeen) return state.left.get(aObject) === state.right.get(bObject);
        return false;
    }

    const depth = state.depth;
    state.left.set(aObject, depth);
    state.right.set(bObject, depth);
    state.depth = depth + 1;
    try {
        return compareObjects(aObject, bObject, strict, skipPrototype, state);
    } finally {
        state.left.delete(aObject);
        state.right.delete(bObject);
        state.depth = depth;
    }
}

function compareObjects(
    aObject: object,
    bObject: object,
    strict: boolean,
    skipPrototype: boolean,
    seen: PathState,
): boolean {
    const a: unknown = aObject;
    const b: unknown = bObject;

    if (strict && !skipPrototype) {
        if (Object.getPrototypeOf(aObject) !== Object.getPrototypeOf(bObject)) return false;
    } else if (kindOf(aObject) !== kindOf(bObject)) {
        return false;
    }

    // Boxed primitives
    if (a instanceof Number && b instanceof Number) return primitiveEqual(a.valueOf(), b.valueOf(), strict);
    if (a instanceof Boolean && b instanceof Boolean) return primitiveEqual(a.valueOf(), b.valueOf(), strict);
    if (a instanceof String && b instanceof String) return primitiveEqual(a.valueOf(), b.valueOf(), strict);

    // Types Node can only compare by reference: their contents are not
    // enumerable, so two distinct instances are never deep-equal. Reference
    // equality was already ruled out above.
    if (a instanceof WeakMap || b instanceof WeakMap) return false;
    if (a instanceof WeakSet || b instanceof WeakSet) return false;
    if (a instanceof Promise || b instanceof Promise) return false;

    // Date. Object.is, not ===, so two Invalid Dates (getTime() === NaN) compare
    // equal as Node reports. Falls through to the own-property compare afterwards.
    if (a instanceof Date && b instanceof Date) {
        if (!Object.is(a.getTime(), b.getTime())) return false;
    }
    // RegExp. Node also compares lastIndex, which is a non-enumerable own
    // property and so is invisible to the key walk below.
    if (a instanceof RegExp && b instanceof RegExp) {
        if (a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false;
    }
    // Error: name/message are non-enumerable, so they need an explicit compare.
    // So is `cause`, when set via the options bag.
    if (a instanceof Error && b instanceof Error) {
        if (a.name !== b.name || a.message !== b.message) return false;
        const aHasCause = 'cause' in a;
        const bHasCause = 'cause' in b;
        if (aHasCause !== bHasCause) return false;
        if (aHasCause && !deepEqual(a.cause, b.cause, strict, skipPrototype, seen)) return false;
    }
    // ArrayBuffer
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
        const av = new Uint8Array(a);
        const bv = new Uint8Array(b);
        if (av.length !== bv.length) return false;
        return algorithm.bytesEqual(av, bv);
    }
    // TypedArray / DataView. Byte comparison is necessary but not sufficient:
    // extra own properties still count, so this falls through to the key walk.
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
        if (strict) {
            const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
            const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
            if (av.length !== bv.length) return false;
            if (!algorithm.bytesEqual(av, bv)) return false;
        } else if (!looseViewEqual(a, b)) {
            return false;
        }
        // Index properties are enumerable own keys on a typed array, so compare
        // only the non-index extras to avoid re-walking every element.
        return extraViewKeysEqual(a, b, strict, skipPrototype, seen);
    }
    // Map. Keys are matched structurally, and a matched entry is consumed so an
    // equal-looking key cannot satisfy two different left entries.
    if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false;
        return matchUnordered(
            Array.from(a),
            Array.from(b),
            (ea, eb) => {
                const [ka, va] = ea as [unknown, unknown];
                const [kb, vb] = eb as [unknown, unknown];
                return deepEqual(ka, kb, strict, skipPrototype, seen)
                    && deepEqual(va, vb, strict, skipPrototype, seen);
            },
            (ea, eb) => {
                const [ka, va] = ea as [unknown, unknown];
                const [kb, vb] = eb as [unknown, unknown];
                return sameValueZero(ka, kb) && deepEqual(va, vb, strict, skipPrototype, seen);
            },
        );
    }
    // Set — same multiset semantics as Map.
    if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false;
        return matchUnordered(
            Array.from(a),
            Array.from(b),
            (va, vb) => deepEqual(va, vb, strict, skipPrototype, seen),
            sameValueZero,
        );
    }

    if (Array.isArray(a) !== Array.isArray(b)) return false;
    // Array length is not an enumerable own key, so holes and trailing length
    // differences are invisible to the walk below: [1,2,3] with length 5, and
    // new Array(3) vs new Array(4), both have identical key sets.
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;

    // Own enumerable keys; symbol keys only matter in strict mode.
    const aKeys = enumerableOwnKeys(aObject, strict);
    const bKeys = enumerableOwnKeys(bObject, strict);
    if (aKeys.length !== bKeys.length) return false;

    for (const key of aKeys) {
        if (!bKeys.includes(key)) return false;
        if (!deepEqual(Reflect.get(aObject, key), Reflect.get(bObject, key), strict, skipPrototype, seen)) return false;
    }

    return true;
}
