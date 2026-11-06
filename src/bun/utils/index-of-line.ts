/**
 * Byte index of the first LF (0x0a) at or after `offset`, or -1 when none exists.
 * Accepts an ArrayBuffer or any ArrayBuffer view, and reads the view's bytes only.
 */
const arrayBufferIsView = ArrayBuffer.isView;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;
const Uint8ArrayConstructor = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayIndexOf = Uint8Array.prototype.indexOf;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const emptyBytes = new Uint8ArrayConstructor();

function invalidBuffer(): never {
    throw Object.assign(
        new TypeError('buffer must be an ArrayBuffer or ArrayBufferView'),
        { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

function rawBufferByteLength(value: unknown): number | undefined {
    try {
        return Reflect.apply(arrayBufferByteLength, value, []);
    } catch {
        if (!sharedArrayBufferByteLength) return undefined;
        try {
            return Reflect.apply(sharedArrayBufferByteLength, value, []);
        } catch {
            return undefined;
        }
    }
}

function viewBytes(value: ArrayBufferView): Uint8Array {
    let backing: ArrayBufferLike;
    try {
        backing = Reflect.apply(typedArrayBuffer, value, []);
        const byteOffset = Reflect.apply(typedArrayByteOffset, value, []);
        const byteLength = Reflect.apply(typedArrayByteLength, value, []);
        return byteLength === 0 ? emptyBytes : new Uint8ArrayConstructor(backing, byteOffset, byteLength);
    } catch {
        try {
            backing = Reflect.apply(dataViewBuffer, value, []);
        } catch {
            return invalidBuffer();
        }
    }

    try {
        const byteOffset = Reflect.apply(dataViewByteOffset, value, []);
        const byteLength = Reflect.apply(dataViewByteLength, value, []);
        return byteLength === 0 ? emptyBytes : new Uint8ArrayConstructor(backing, byteOffset, byteLength);
    } catch {
        // Bun treats a detached or out-of-bounds DataView as an empty window.
        return emptyBytes;
    }
}

function toNumberPrimitive(value: unknown): unknown {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;

    const object = value as Record<PropertyKey, unknown>;
    const exotic = object[Symbol.toPrimitive];
    if (exotic !== undefined && exotic !== null) {
        if (typeof exotic !== 'function') {
            throw new TypeError('Symbol.toPrimitive is not a function, undefined, or null');
        }
        const primitive = Reflect.apply(exotic, value, ['number']);
        if (primitive === null || (typeof primitive !== 'object' && typeof primitive !== 'function')) {
            return primitive;
        }
        throw new TypeError('No default value');
    }

    for (const key of ['valueOf', 'toString'] as const) {
        const method = object[key];
        if (typeof method !== 'function') continue;
        const primitive = Reflect.apply(method, value, []);
        if (primitive === null || (typeof primitive !== 'object' && typeof primitive !== 'function')) {
            return primitive;
        }
    }
    throw new TypeError('No default value');
}

function numericOffset(value: unknown): number | bigint {
    const primitive = toNumberPrimitive(value);
    if (typeof primitive === 'bigint') return primitive;
    if (typeof primitive === 'symbol') throw new TypeError('Cannot convert a symbol to a number');
    return Number(primitive);
}

function normalizedOffset(value: number | bigint, byteLength: number): number {
    if (typeof value === 'bigint') {
        if (value < 0n) return 0;
        if (value >= BigInt(byteLength)) return byteLength;
        return Number(value);
    }
    if (value === Infinity) return byteLength;
    return !Number.isFinite(value) || value < 0
        ? 0
        : Math.trunc(value);
}

export const indexOfLine = (
    buffer: ArrayBufferLike | ArrayBufferView,
    offset: unknown = 0,
): number => {
    const isView = arrayBufferIsView(buffer);
    if (!isView && rawBufferByteLength(buffer) === undefined) return invalidBuffer();

    // Coercion can detach or resize the backing buffer. Re-read the intrinsic
    // window afterwards so length-tracking and out-of-bounds views match Bun.
    const numeric = numericOffset(offset);
    const bytes = isView
        ? viewBytes(buffer as ArrayBufferView)
        : (() => {
            const byteLength = rawBufferByteLength(buffer)!;
            return byteLength === 0 ? emptyBytes : new Uint8ArrayConstructor(buffer as ArrayBufferLike);
        })();
    return Reflect.apply(typedArrayIndexOf, bytes, [0x0a, normalizedOffset(numeric, bytes.length)]);
};
