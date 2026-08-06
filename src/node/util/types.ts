const engine = import.meta.use('engine');

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const sharedArrayBufferByteLengthGetter = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;
const booleanValueOf = Boolean.prototype.valueOf;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;

function hasBoxedSlot(value: unknown, valueOf: (this: unknown) => unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    try { Reflect.apply(valueOf, value, []); return true; } catch { return false; }
}

function typedArrayTag(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || !typedArrayTagGetter) return undefined;
    try { return Reflect.apply(typedArrayTagGetter, value, []); } catch { return undefined; }
}

function hasArrayBufferViewSlot(value: unknown): value is ArrayBufferView {
    if (!value || typeof value !== 'object') return false;
    return engine.isDataView(value) || typedArrayTag(value) !== undefined;
}

function hasSharedArrayBufferSlot(value: unknown): value is SharedArrayBuffer {
    if (!value || typeof value !== 'object' || !sharedArrayBufferByteLengthGetter) return false;
    try { Reflect.apply(sharedArrayBufferByteLengthGetter, value, []); return true; } catch { return false; }
}

/**
 * Reading Symbol.toStringTag runs a proxy `get` trap, which throws for a revoked
 * proxy. A type predicate must answer, not throw, so failures read as "no tag".
 */
function toStringTag(value: object): unknown {
    try {
        return Reflect.get(value, Symbol.toStringTag);
    } catch {
        return undefined;
    }
}

export function isAnyArrayBuffer(value: unknown): value is ArrayBuffer | SharedArrayBuffer {
    return engine.isArrayBuffer(value) || hasSharedArrayBufferSlot(value);
}

export function isArrayBuffer(value: unknown): value is ArrayBuffer {
    return engine.isArrayBuffer(value);
}

export function isArgumentsObject(value: unknown): value is IArguments {
    return engine.isArgumentsObject(value);
}

export function isArrayBufferView(value: unknown): value is ArrayBufferView {
    return hasArrayBufferViewSlot(value);
}

type AsyncCallable = (...args: unknown[]) => Promise<unknown>;

export function isAsyncFunction(value: unknown): value is AsyncCallable {
    return engine.isAsyncFunction(value);
}

export function isBigInt64Array(value: unknown): value is BigInt64Array {
    return typedArrayTag(value) === 'BigInt64Array';
}

export function isBigUint64Array(value: unknown): value is BigUint64Array {
    return typedArrayTag(value) === 'BigUint64Array';
}

export function isBooleanObject(value: unknown): value is Boolean {
    return hasBoxedSlot(value, booleanValueOf);
}

export function isBigIntObject(value: unknown): value is BigInt {
    return hasBoxedSlot(value, bigintValueOf);
}

export function isBoxedPrimitive(value: unknown): value is Boolean | String | Number | Symbol | BigInt {
    if (value === null || typeof value !== 'object') return false;
    return hasBoxedSlot(value, booleanValueOf)
        || hasBoxedSlot(value, numberValueOf)
        || hasBoxedSlot(value, stringValueOf)
        || hasBoxedSlot(value, symbolValueOf)
        || hasBoxedSlot(value, bigintValueOf);
}

export function isDataView(value: unknown): value is DataView {
    return engine.isDataView(value);
}

export function isDate(value: unknown): value is Date {
    return engine.isDate(value);
}

export function isFloat16Array(value: unknown): boolean {
    return typedArrayTag(value) === 'Float16Array';
}

export function isFloat32Array(value: unknown): value is Float32Array {
    return typedArrayTag(value) === 'Float32Array';
}

export function isFloat64Array(value: unknown): value is Float64Array {
    return typedArrayTag(value) === 'Float64Array';
}

export function isGeneratorFunction(value: unknown): value is GeneratorFunction {
    return engine.isGeneratorFunction(value);
}

export function isGeneratorObject(value: unknown): value is Generator {
    return engine.isGeneratorObject(value);
}

export function isInt8Array(value: unknown): value is Int8Array {
    return typedArrayTag(value) === 'Int8Array';
}

export function isInt16Array(value: unknown): value is Int16Array {
    return typedArrayTag(value) === 'Int16Array';
}

export function isInt32Array(value: unknown): value is Int32Array {
    return typedArrayTag(value) === 'Int32Array';
}

export function isMap(value: unknown): value is Map<unknown, unknown> {
    return engine.isMap(value);
}

export function isMapIterator(value: unknown): boolean {
    return engine.isMapIterator(value);
}

export function isModuleNamespaceObject(value: unknown): boolean {
    return engine.isModuleNamespaceObject(value);
}

export function isNativeError(value: unknown): value is Error {
    return engine.isError(value);
}

export function isNumberObject(value: unknown): value is Number {
    return hasBoxedSlot(value, numberValueOf);
}

export function isPromise(value: unknown): value is Promise<unknown> {
    return engine.isPromise(value);
}

export function isProxy(value: unknown): boolean {
    return engine.isProxy(value);
}

export function isRegExp(value: unknown): value is RegExp {
    return engine.isRegExp(value);
}

export function isSet(value: unknown): value is Set<unknown> {
    return engine.isSet(value);
}

export function isSetIterator(value: unknown): boolean {
    return engine.isSetIterator(value);
}

export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
    return hasSharedArrayBufferSlot(value);
}

export function isStringObject(value: unknown): value is String {
    return hasBoxedSlot(value, stringValueOf);
}

export function isSymbolObject(value: unknown): value is object {
    return hasBoxedSlot(value, symbolValueOf);
}

/** NodeJS.TypedArray is not declared in this build's type env; spell it out. */
type TypedArrayLike =
    | Int8Array | Uint8Array | Uint8ClampedArray
    | Int16Array | Uint16Array
    | Int32Array | Uint32Array
    | Float32Array | Float64Array
    | BigInt64Array | BigUint64Array;

export function isTypedArray(value: unknown): value is TypedArrayLike {
    return typedArrayTag(value) !== undefined;
}

export function isUint8Array(value: unknown): value is Uint8Array {
    return typedArrayTag(value) === 'Uint8Array';
}

export function isUint8ClampedArray(value: unknown): value is Uint8ClampedArray {
    return typedArrayTag(value) === 'Uint8ClampedArray';
}

export function isUint16Array(value: unknown): value is Uint16Array {
    return typedArrayTag(value) === 'Uint16Array';
}

export function isUint32Array(value: unknown): value is Uint32Array {
    return typedArrayTag(value) === 'Uint32Array';
}

export function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
    return engine.isWeakMap(value);
}

export function isWeakSet(value: unknown): value is WeakSet<object> {
    return engine.isWeakSet(value);
}

/**
 * Node returns true only for a native `napi_external`. Nothing reachable from
 * pure JS carries that slot, so false is the correct answer for every value a
 * script can construct.
 */
export function isExternal(_value: unknown): boolean {
    return false;
}

export function isKeyObject(value: unknown): boolean {
    return value !== null && typeof value === 'object'
        && toStringTag(value) === 'KeyObject';
}

export function isCryptoKey(value: unknown): boolean {
    return value !== null && typeof value === 'object'
        && toStringTag(value) === 'CryptoKey';
}
