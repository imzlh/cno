/**
 * Byte index of the first LF (0x0a) at or after `offset`, or -1 when none exists.
 * Accepts an ArrayBuffer or any ArrayBuffer view, and reads the view's bytes only.
 */
const arrayBufferIsView = ArrayBuffer.isView;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const emptyBytes = new Uint8Array();

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
        return byteLength === 0 ? emptyBytes : new Uint8Array(backing, byteOffset, byteLength);
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
        return byteLength === 0 ? emptyBytes : new Uint8Array(backing, byteOffset, byteLength);
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

function normalizedOffset(value: unknown, byteLength: number): number {
    const primitive = toNumberPrimitive(value);
    if (typeof primitive === 'bigint') {
        if (primitive < 0n) return 0;
        if (primitive >= BigInt(byteLength)) return byteLength;
        return Number(primitive);
    }
    if (typeof primitive === 'symbol') throw new TypeError('Cannot convert a symbol to a number');

    const numericOffset = Number(primitive);
    if (numericOffset === Infinity) return byteLength;
    return !Number.isFinite(numericOffset) || numericOffset < 0
        ? 0
        : Math.trunc(numericOffset);
}

export const indexOfLine = (
    buffer: ArrayBufferLike | ArrayBufferView,
    offset: unknown = 0,
): number => {
    let bytes: Uint8Array;
    if (arrayBufferIsView(buffer)) {
        bytes = viewBytes(buffer);
    } else {
        const byteLength = rawBufferByteLength(buffer);
        if (byteLength === undefined) return invalidBuffer();
        bytes = byteLength === 0 ? emptyBytes : new Uint8Array(buffer as ArrayBufferLike);
    }
    return bytes.indexOf(0x0a, normalizedOffset(offset, bytes.length));
};
