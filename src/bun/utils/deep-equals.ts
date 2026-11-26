/** Structural equality with Bun's loose-by-default object and array rules. */

type Key = string | symbol;
type Shape = { keys: Key[]; prototype: object | null };
type WebCollectionKind = 'Headers' | 'URLSearchParams';
type BrandName = 'Date' | 'RegExp' | 'Map' | 'Set' | 'ArrayBuffer' | 'SharedArrayBuffer'
    | 'Number' | 'String' | 'Boolean' | 'BigInt' | 'Symbol' | 'URL' | WebCollectionKind;
type WebCollectionSlot = {
    kind: WebCollectionKind;
    entries: [string, string][];
    baseConstructor: Function;
};
type SlotInfo =
    | { kind: 'Date'; value: number }
    | { kind: 'RegExp'; source: string; flags: string }
    | { kind: 'Map'; iterator: Iterator<[unknown, unknown]> }
    | { kind: 'Set'; iterator: Iterator<unknown> }
    | { kind: 'ArrayBuffer' | 'SharedArrayBuffer'; value: object; byteLength: number }
    | { kind: 'Number' | 'String' | 'Boolean' | 'BigInt' | 'Symbol'; value: unknown }
    | { kind: 'URL'; href: string }
    | WebCollectionSlot;

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const dateValue = getOwnPropertyDescriptor(Date.prototype, 'getTime')!.value as Function;
const regexpSource = getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get as Function;
const regexpFlags: [string, Function][] = [
    ['d', 'hasIndices'], ['g', 'global'], ['i', 'ignoreCase'], ['m', 'multiline'],
    ['s', 'dotAll'], ['u', 'unicode'], ['v', 'unicodeSets'], ['y', 'sticky'],
].flatMap(([flag, name]) => {
    const getter = getOwnPropertyDescriptor(RegExp.prototype, name)?.get;
    return getter ? [[flag, getter as Function]] : [];
});
const mapEntries = Map.prototype.entries;
const mapIteratorNext = getPrototypeOf(mapEntries.call(new Map())).next as Function;
const setValues = Set.prototype.values;
const setIteratorNext = getPrototypeOf(setValues.call(new Set())).next as Function;
const arrayBufferByteLength = getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get as Function;
const arrayBufferIsView = ArrayBuffer.isView;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'undefined' ? undefined
    : getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get as Function | undefined;
const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype);
const typedArrayName = getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get as Function;
const typedArrayLength = getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get as Function;
const dataViewByteLength = getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get as Function;
const boxedValueOf: Record<'Number' | 'String' | 'Boolean' | 'BigInt' | 'Symbol', Function> = {
    Number: Number.prototype.valueOf,
    String: String.prototype.valueOf,
    Boolean: Boolean.prototype.valueOf,
    BigInt: BigInt.prototype.valueOf,
    Symbol: Symbol.prototype.valueOf,
};
const urlHref = typeof URL === 'undefined' ? undefined
    : getOwnPropertyDescriptor(URL.prototype, 'href')?.get as Function | undefined;
const webCollections: {
    kind: WebCollectionKind;
    constructor: Function;
    has: Function;
    entries: Function;
    next: Function;
}[] = [];
if (typeof Headers !== 'undefined') {
    webCollections.push({
        kind: 'Headers',
        constructor: Headers,
        has: Headers.prototype.has,
        entries: Headers.prototype.entries,
        next: getPrototypeOf(Headers.prototype.entries.call(new Headers())).next as Function,
    });
}
if (typeof URLSearchParams !== 'undefined') {
    webCollections.push({
        kind: 'URLSearchParams',
        constructor: URLSearchParams,
        has: URLSearchParams.prototype.has,
        entries: URLSearchParams.prototype.entries,
        next: getPrototypeOf(URLSearchParams.prototype.entries.call(new URLSearchParams())).next as Function,
    });
}
const nativeErrorIsError = (Error as ErrorConstructor & { isError?: (value: unknown) => boolean }).isError;
const knownBrands = new Set<BrandName>([
    'Date', 'RegExp', 'Map', 'Set', 'ArrayBuffer', 'SharedArrayBuffer',
    'Number', 'String', 'Boolean', 'BigInt', 'Symbol', 'URL', 'Headers', 'URLSearchParams',
]);

function call(fn: Function, value: unknown): unknown {
    return Reflect.apply(fn, value, []);
}

function shape(value: object): Shape {
    const keys: Key[] = [];
    for (const key of Reflect.ownKeys(value)) {
        if (getOwnPropertyDescriptor(value, key)?.enumerable) keys.push(key);
    }
    return { keys, prototype: getPrototypeOf(value) };
}

function constructorName(value: unknown): string | undefined {
    if (typeof value !== 'function') return undefined;
    const descriptor = getOwnPropertyDescriptor(value, 'name');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
        ? descriptor.value : undefined;
}

function prototypeBrand(prototype: object | null): BrandName | undefined {
    const seen = new Set<object>();
    for (let current = prototype, depth = 0; current !== null && depth < 16; depth++) {
        if (seen.has(current)) return undefined;
        seen.add(current);
        const descriptor = getOwnPropertyDescriptor(current, 'constructor');
        if (descriptor && 'value' in descriptor) {
            const name = constructorName(descriptor.value) as BrandName | undefined;
            if (name && knownBrands.has(name)) return name;
        }
        current = getPrototypeOf(current);
    }
    return undefined;
}

function regexpFlagsOf(value: object): string {
    let result = '';
    for (const [flag, getter] of regexpFlags) {
        if (call(getter, value)) result += flag;
    }
    return result;
}

function webCollectionSlotInfo(value: object, hint?: WebCollectionKind): WebCollectionSlot | undefined {
    for (const collection of webCollections) {
        if (hint !== undefined && collection.kind !== hint) continue;
        try {
            Reflect.apply(collection.has, value, ['x']);
        } catch {
            continue;
        }
        const iterator = Reflect.apply(collection.entries, value, []) as Iterator<[string, string]>;
        return {
            kind: collection.kind,
            entries: iteratorValues(iterator, collection.next),
            baseConstructor: collection.constructor,
        };
    }
    return undefined;
}

function collectionSlotInfo(value: object): Extract<SlotInfo, { kind: 'Map' | 'Set' }> | WebCollectionSlot | undefined {
    try {
        return { kind: 'Map', iterator: Reflect.apply(mapEntries, value, []) as Iterator<[unknown, unknown]> };
    } catch {
        try {
            return { kind: 'Set', iterator: Reflect.apply(setValues, value, []) as Iterator<unknown> };
        } catch {
            // Forged prototypes and Proxies do not carry the collection's internal slot.
            return webCollectionSlotInfo(value);
        }
    }
}

function slotInfo(value: object, prototype: object | null): SlotInfo | undefined {
    const hint = prototypeBrand(prototype);
    if (!hint) {
        try {
            // Date slots survive prototype replacement, and this intrinsic check cannot be spoofed.
            return { kind: 'Date', value: call(dateValue, value) as number };
        } catch {
            return collectionSlotInfo(value);
        }
    }
    try {
        switch (hint) {
            case 'Date':
                return { kind: hint, value: call(dateValue, value) as number };
            case 'RegExp':
                return {
                    kind: hint,
                    source: call(regexpSource, value) as string,
                    flags: regexpFlagsOf(value),
                };
            case 'Map':
                return { kind: hint, iterator: Reflect.apply(mapEntries, value, []) as Iterator<[unknown, unknown]> };
            case 'Set':
                return { kind: hint, iterator: Reflect.apply(setValues, value, []) as Iterator<unknown> };
            case 'ArrayBuffer':
                return { kind: hint, value, byteLength: call(arrayBufferByteLength, value) as number };
            case 'SharedArrayBuffer':
                if (!sharedArrayBufferByteLength) return undefined;
                return { kind: hint, value, byteLength: call(sharedArrayBufferByteLength, value) as number };
            case 'Number':
            case 'String':
            case 'Boolean':
            case 'BigInt':
            case 'Symbol':
                return { kind: hint, value: call(boxedValueOf[hint], value) };
            case 'URL':
                if (!urlHref) return undefined;
                return { kind: hint, href: call(urlHref, value) as string };
            case 'Headers':
            case 'URLSearchParams':
                return webCollectionSlotInfo(value, hint) ?? collectionSlotInfo(value);
        }
    } catch {
        // A hint can be forged or replaced; intrinsic collection calls recover the real brand.
        return collectionSlotInfo(value);
    }
}

function iteratorValues<T>(iterator: Iterator<T>, next: Function): T[] {
    const result: T[] = [];
    while (true) {
        const item = Reflect.apply(next, iterator, []) as IteratorResult<T>;
        if (item.done) return result;
        result.push(item.value);
    }
}

function webCollectionEntriesEqual(left: WebCollectionSlot, right: WebCollectionSlot): boolean {
    if (left.entries.length !== right.entries.length) return false;
    const values: Map<string, string>[] = [];
    for (const collection of [left, right]) {
        const firstValues = new Map<string, string>();
        for (const [key, value] of collection.entries) {
            if (!firstValues.has(key)) firstValues.set(key, value);
            else if (collection.kind === 'Headers') firstValues.set(key, `${firstValues.get(key)}, ${value}`);
        }
        values.push(firstValues);
    }
    // Bun compares each entry to get(key), including repeated keys.
    for (let side = 0; side < 2; side++) {
        const collection = side === 0 ? left : right;
        const otherValues = values[1 - side];
        for (const [key, value] of collection.entries) {
            if (otherValues.get(key) !== value) return false;
        }
    }
    return true;
}

function isObjectConstructor(value: unknown, prototype: object): boolean {
    if (constructorName(value) !== 'Object') return false;
    const descriptor = getOwnPropertyDescriptor(value as object, 'prototype');
    return !!descriptor && 'value' in descriptor && descriptor.value === prototype
        && getPrototypeOf(prototype) === null;
}

function inheritedConstructor(prototype: object | null): unknown {
    if (prototype !== null && constructorName(getOwnPropertyDescriptor(prototype, 'constructor')?.value) === 'Object') {
        return undefined;
    }
    const seen = new Set<object>();
    for (let current = prototype, depth = 0; current !== null && depth < 32; depth++) {
        if (seen.has(current)) return undefined;
        seen.add(current);
        const descriptor = getOwnPropertyDescriptor(current, 'constructor');
        if (descriptor) {
            if (!('value' in descriptor) || isObjectConstructor(descriptor.value, current)) return undefined;
            return descriptor.value;
        }
        current = getPrototypeOf(current);
    }
    return undefined;
}

function dataProperty(value: object, key: string): unknown {
    const seen = new Set<object>();
    for (let current: object | null = value, depth = 0; current !== null && depth < 32; depth++) {
        if (seen.has(current)) return undefined;
        seen.add(current);
        const descriptor = getOwnPropertyDescriptor(current, key);
        if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
        current = getPrototypeOf(current);
    }
    return undefined;
}

function errorCause(value: object): unknown {
    const descriptor = getOwnPropertyDescriptor(value, 'cause');
    if (!descriptor) return undefined;
    return 'value' in descriptor ? descriptor.value : Reflect.get(value, 'cause');
}

function isError(value: object): boolean {
    return nativeErrorIsError ? nativeErrorIsError(value) : value instanceof Error;
}

/**
 * Bun obtains builtin brands from internal slots. Prototype hints keep ordinary
 * object comparisons cheap; every hint is verified by an intrinsic operation.
 */
export function deepEquals(a: unknown, b: unknown, strict = false): boolean {
    const strictMode = strict === true;
    const left = new Map<object, number>();
    const right = new Map<object, number>();

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

    function propertiesFromShapes(
        x: object,
        y: object,
        xShape: Shape,
        yShape: Shape,
        depth: number,
        comparePrototype = strictMode,
    ): boolean {
        if (comparePrototype && inheritedConstructor(xShape.prototype) !== inheritedConstructor(yShape.prototype)) return false;
        for (const key of xShape.keys) {
            if (!yShape.keys.includes(key)) {
                if (strictMode || Reflect.get(x, key) !== undefined) return false;
                // Missing own properties do not read inherited values or getters.
                continue;
            }
            if (!equal(Reflect.get(x, key), Reflect.get(y, key), depth)) return false;
        }
        for (const key of yShape.keys) {
            if (!xShape.keys.includes(key) && (strictMode || Reflect.get(y, key) !== undefined)) return false;
        }
        return true;
    }

    function properties(x: object, y: object, depth: number, comparePrototype = strictMode): boolean {
        return propertiesFromShapes(x, y, shape(x), shape(y), depth, comparePrototype);
    }

    function symbolProperties(x: object, y: object, depth: number): boolean {
        const xKeys = Reflect.ownKeys(x).filter((key): key is symbol =>
            typeof key === 'symbol' && !!getOwnPropertyDescriptor(x, key)?.enumerable);
        const yKeys = Reflect.ownKeys(y).filter((key): key is symbol =>
            typeof key === 'symbol' && !!getOwnPropertyDescriptor(y, key)?.enumerable);
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

    function bufferBytesEqual(x: SlotInfo, y: SlotInfo): boolean {
        if (!('byteLength' in x) || !('byteLength' in y) || x.byteLength !== y.byteLength) return false;
        const a = new Uint8Array(x.value as ArrayBuffer), b = new Uint8Array(y.value as ArrayBuffer);
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    function typedArrayExtras(value: object, valueShape: Shape, length: number): Shape {
        return {
            prototype: valueShape.prototype,
            keys: valueShape.keys.filter(key => {
                if (typeof key !== 'string') return true;
                const index = Number(key);
                return !Number.isInteger(index) || index < 0 || index >= length || String(index) !== key;
            }),
        };
    }

    function typedArraysEqual(x: object, y: object, xName: string, yName: string, depth: number): boolean {
        if (xName !== yName) return false;
        const xLength = call(typedArrayLength, x) as number;
        const yLength = call(typedArrayLength, y) as number;
        if (xLength !== yLength) return false;
        const a = x as unknown as ArrayLike<number | bigint>;
        const b = y as unknown as ArrayLike<number | bigint>;
        for (let i = 0; i < xLength; i++) {
            if (strictMode ? !Object.is(a[i], b[i]) : a[i] !== b[i]) return false;
        }
        if (!strictMode) return true;
        return propertiesFromShapes(
            x,
            y,
            typedArrayExtras(x, shape(x), xLength),
            typedArrayExtras(y, shape(y), yLength),
            depth,
            false,
        );
    }

    function errorsEqual(x: object, y: object, depth: number): boolean {
        if (dataProperty(x, 'name') !== dataProperty(y, 'name')
            || dataProperty(x, 'message') !== dataProperty(y, 'message')) return false;
        const xCause = errorCause(x), yCause = errorCause(y);
        return equal(xCause, yCause, depth) && properties(x, y, depth, false);
    }

    function objectsEqual(x: object, y: object, depth: number): boolean {
        const xArray = Array.isArray(x), yArray = Array.isArray(y);
        if (xArray || yArray) {
            if (!xArray || !yArray) return false;
            const xa = x as unknown[], ya = y as unknown[];
            if (strictMode && xa.length !== ya.length) return false;
            const length = Math.max(xa.length, ya.length);
            for (let i = 0; i < length; i++) {
                if (strictMode && (i in xa) !== (i in ya)) return false;
                if (!equal(xa[i], ya[i], depth)) return false;
            }
            return symbolProperties(x, y, depth);
        }

        const xError = isError(x), yError = isError(y);
        if (xError || yError) return xError && yError && errorsEqual(x, y, depth);

        const xView = arrayBufferIsView(x), yView = arrayBufferIsView(y);
        const xTypedName = xView ? call(typedArrayName, x) as string | undefined : undefined;
        const yTypedName = yView ? call(typedArrayName, y) as string | undefined : undefined;
        if (xTypedName !== undefined || yTypedName !== undefined) {
            return xTypedName !== undefined && yTypedName !== undefined
                && typedArraysEqual(x, y, xTypedName, yTypedName, depth);
        }
        if (strictMode && (xView || yView)) {
            const xDataView = xView && (() => { try { call(dataViewByteLength, x); return true; } catch { return false; } })();
            const yDataView = yView && (() => { try { call(dataViewByteLength, y); return true; } catch { return false; } })();
            if (xDataView || yDataView) return !!xDataView && !!yDataView && properties(x, y, depth, false);
        }

        // Shape collection deliberately precedes prototype/brand probing. This
        // matches Bun's observable ownKeys -> descriptors -> getPrototypeOf order.
        const xShape = shape(x), yShape = shape(y);
        const xSlot = slotInfo(x, xShape.prototype), ySlot = slotInfo(y, yShape.prototype);
        if (xSlot || ySlot) {
            if (!xSlot || !ySlot || xSlot.kind !== ySlot.kind) {
                const xObjectLike = !xSlot || xSlot.kind === 'URL' || xSlot.kind === 'Headers' || xSlot.kind === 'URLSearchParams';
                const yObjectLike = !ySlot || ySlot.kind === 'URL' || ySlot.kind === 'Headers' || ySlot.kind === 'URLSearchParams';
                if (!xObjectLike || !yObjectLike) return false;
            } else {
                switch (xSlot.kind) {
                    case 'Date':
                        return xSlot.value === (ySlot as Extract<SlotInfo, { kind: 'Date' }>).value;
                    case 'RegExp': {
                        const other = ySlot as Extract<SlotInfo, { kind: 'RegExp' }>;
                        return xSlot.source === other.source && xSlot.flags === other.flags;
                    }
                    case 'Map': {
                        const xs = iteratorValues(xSlot.iterator, mapIteratorNext);
                        const ys = iteratorValues((ySlot as Extract<SlotInfo, { kind: 'Map' }>).iterator, mapIteratorNext);
                        return unordered(xs, ys, (a, b) => {
                            const [ak, av] = a as [unknown, unknown];
                            const [bk, bv] = b as [unknown, unknown];
                            return equal(ak, bk, depth) && equal(av, bv, depth);
                        });
                    }
                    case 'Set':
                        return unordered(
                            iteratorValues(xSlot.iterator, setIteratorNext),
                            iteratorValues((ySlot as Extract<SlotInfo, { kind: 'Set' }>).iterator, setIteratorNext),
                            (a, b) => equal(a, b, depth),
                        );
                    case 'ArrayBuffer':
                    case 'SharedArrayBuffer':
                        return bufferBytesEqual(xSlot, ySlot);
                    case 'Number':
                    case 'String':
                    case 'Boolean':
                    case 'BigInt':
                    case 'Symbol':
                        return Object.is(xSlot.value, (ySlot as typeof xSlot).value)
                            && propertiesFromShapes(x, y, xShape, yShape, depth, false);
                    case 'URL':
                        return xSlot.href === (ySlot as Extract<SlotInfo, { kind: 'URL' }>).href
                            && propertiesFromShapes(x, y, xShape, yShape, depth, false);
                    case 'Headers':
                    case 'URLSearchParams': {
                        const other = ySlot as WebCollectionSlot;
                        if (!webCollectionEntriesEqual(xSlot, other)) return false;
                        if (strictMode) {
                            const xConstructor = inheritedConstructor(xShape.prototype);
                            const yConstructor = inheritedConstructor(yShape.prototype);
                            if ((xConstructor === xSlot.baseConstructor ? undefined : xConstructor)
                                !== (yConstructor === other.baseConstructor ? undefined : yConstructor)) return false;
                        }
                        return propertiesFromShapes(x, y, xShape, yShape, depth, false);
                    }
                }
            }
        }
        return propertiesFromShapes(x, y, xShape, yShape, depth);
    }

    return equal(a, b, 0);
}
