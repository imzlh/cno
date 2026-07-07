const objectToString = (value: unknown): string => Object.prototype.toString.call(value);

function toStringTag(value: object): unknown {
    return Reflect.get(value, Symbol.toStringTag);
}

export function isAnyArrayBuffer(value: unknown): value is ArrayBuffer {
    return value instanceof ArrayBuffer || value instanceof SharedArrayBuffer;
}

export function isArrayBuffer(value: unknown): value is ArrayBuffer {
    return value instanceof ArrayBuffer;
}

export function isArgumentsObject(value: unknown): value is IArguments {
    return objectToString(value) === '[object Arguments]';
}

export function isArrayBufferView(value: unknown): value is ArrayBufferView {
    return ArrayBuffer.isView(value);
}

type AsyncCallable = (...args: unknown[]) => Promise<unknown>;

export function isAsyncFunction(value: unknown): value is AsyncCallable {
    return typeof value === 'function' && value.constructor.name === 'AsyncFunction';
}

export function isBigInt64Array(value: unknown): value is BigInt64Array {
    return value instanceof BigInt64Array;
}

export function isBigUint64Array(value: unknown): value is BigUint64Array {
    return value instanceof BigUint64Array;
}

export function isBooleanObject(value: unknown): value is Boolean {
    return value instanceof Boolean;
}

export function isBoxedPrimitive(value: unknown): value is Boolean | String | Number | Symbol | BigInt {
    if (value === null || typeof value !== 'object') return false;
    const tag = objectToString(value);
    return tag === '[object Boolean]'
        || tag === '[object Number]'
        || tag === '[object String]'
        || tag === '[object Symbol]'
        || tag === '[object BigInt]';
}

export function isDataView(value: unknown): value is DataView {
    return value instanceof DataView;
}

export function isDate(value: unknown): value is Date {
    return value instanceof Date;
}

export function isFloat32Array(value: unknown): value is Float32Array {
    return value instanceof Float32Array;
}

export function isFloat64Array(value: unknown): value is Float64Array {
    return value instanceof Float64Array;
}

export function isGeneratorFunction(value: unknown): value is GeneratorFunction {
    return typeof value === 'function' && value.constructor.name === 'GeneratorFunction';
}

export function isGeneratorObject(value: unknown): value is Generator {
    return objectToString(value) === '[object Generator]';
}

export function isInt8Array(value: unknown): value is Int8Array {
    return value instanceof Int8Array;
}

export function isInt16Array(value: unknown): value is Int16Array {
    return value instanceof Int16Array;
}

export function isInt32Array(value: unknown): value is Int32Array {
    return value instanceof Int32Array;
}

export function isMap(value: unknown): value is Map<unknown, unknown> {
    return value instanceof Map;
}

export function isMapIterator(value: unknown): boolean {
    return objectToString(value) === '[object Map Iterator]';
}

export function isModuleNamespaceObject(value: unknown): boolean {
    return value !== null && typeof value === 'object' && toStringTag(value) === 'Module';
}

export function isNativeError(value: unknown): value is Error {
    return value instanceof Error;
}

export function isNumberObject(value: unknown): value is Number {
    return value instanceof Number;
}

export function isPromise(value: unknown): value is Promise<unknown> {
    return value instanceof Promise;
}

export function isProxy(value: unknown): boolean {
    return false;
}

export function isRegExp(value: unknown): value is RegExp {
    return value instanceof RegExp;
}

export function isSet(value: unknown): value is Set<unknown> {
    return value instanceof Set;
}

export function isSetIterator(value: unknown): boolean {
    return objectToString(value) === '[object Set Iterator]';
}

export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
    return value instanceof SharedArrayBuffer;
}

export function isStringObject(value: unknown): value is String {
    return value instanceof String;
}

export function isSymbolObject(value: unknown): value is object {
    if (value === null || typeof value !== 'object') return false;
    return objectToString(value) === '[object Symbol]';
}

export function isTypedArray(value: unknown): value is NodeJS.TypedArray {
    return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

export function isUint8Array(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array;
}

export function isUint8ClampedArray(value: unknown): value is Uint8ClampedArray {
    return value instanceof Uint8ClampedArray;
}

export function isUint16Array(value: unknown): value is Uint16Array {
    return value instanceof Uint16Array;
}

export function isUint32Array(value: unknown): value is Uint32Array {
    return value instanceof Uint32Array;
}

export function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
    return value instanceof WeakMap;
}

export function isWeakSet(value: unknown): value is WeakSet<object> {
    return value instanceof WeakSet;
}

export function isKeyObject(value: unknown): boolean {
    return value !== null && typeof value === 'object'
        && toStringTag(value) === 'KeyObject';
}

export function isCryptoKey(value: unknown): boolean {
    return value !== null && typeof value === 'object'
        && toStringTag(value) === 'CryptoKey';
}
