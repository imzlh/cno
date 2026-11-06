const fs = import.meta.use('fs');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');

const KIB = 1024;
const MAX_PSS_KIB = Math.floor(Number.MAX_SAFE_INTEGER / KIB);

const Uint8ArrayConstructor = Uint8Array;
const Uint16ArrayConstructor = Uint16Array;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const uint8ByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const uint8ByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const uint8Buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const uint16ByteLength = uint8ByteLength;
const uint16ByteOffset = uint8ByteOffset;
const uint16Buffer = uint8Buffer;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const emptyBytes = new Uint8ArrayConstructor();
const emptyU16 = new Uint16ArrayConstructor();

type Getter = () => number;
type InvalidBufferError = TypeError & { code: string };

const invalidBufferPrototype = Object.create(TypeError.prototype) as InvalidBufferError;
const invalidBufferToString = {
    toString(this: InvalidBufferError): string {
        return `${this.name} [${this.code}]: ${this.message}`;
    },
}.toString;

Object.defineProperties(invalidBufferPrototype, {
    name: { configurable: true, enumerable: true, value: 'TypeError', writable: true },
    code: { configurable: true, enumerable: true, value: 'ERR_INVALID_ARG_TYPE', writable: true },
    toString: { configurable: true, enumerable: true, value: invalidBufferToString, writable: true },
});

function invalidBuffer(): never {
    const error = new TypeError('Expected an ArrayBuffer');
    Object.setPrototypeOf(error, invalidBufferPrototype);
    throw error;
}

function slotValue(getter: Getter | undefined, value: unknown): number | undefined {
    if (!getter) return undefined;
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    try {
        return Reflect.apply(getter, value, []);
    } catch {
        return undefined;
    }
}

function rawBufferByteLength(value: unknown): number | undefined {
    return slotValue(arrayBufferByteLength, value)
        ?? slotValue(sharedArrayBufferByteLength, value);
}

function typedArrayTag(value: unknown): string {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return '';
    try {
        // Calling the intrinsic getter directly avoids a user-defined
        // Symbol.toStringTag and still works for typed arrays from another realm.
        return Reflect.apply(typedArrayTagGetter, value, []);
    } catch {
        return '';
    }
}

function byteView(value: unknown): Uint8Array {
    const tag = typedArrayTag(value);
    const byteLength = slotValue(uint8ByteLength, value);
    if (tag && tag !== 'Uint16Array' && byteLength !== undefined) {
        if (byteLength === 0) return emptyBytes;
        const object = value as object;
        const buffer = Reflect.apply(uint8Buffer, object, []);
        return new Uint8ArrayConstructor(
            buffer,
            Reflect.apply(uint8ByteOffset, object, []),
            byteLength,
        );
    }
    const rawByteLength = rawBufferByteLength(value);
    if (rawByteLength !== undefined) {
        return rawByteLength === 0 ? emptyBytes : new Uint8ArrayConstructor(value as ArrayBufferLike);
    }
    return invalidBuffer();
}

/**
 * Safe copying fallback for Bun's zero-copy cast. The cno engine always creates
 * an owned JavaScript string, so callers do not need to retain the input view.
 */
interface ArrayBufferToString {
    (buffer: Uint8Array<ArrayBuffer> | ArrayBufferLike): string;
    (buffer: ArrayBufferView): string;
}

export const arrayBufferToString = ((buffer: unknown): string => {
    const tag = typedArrayTag(buffer);
    const byteLength = slotValue(uint16ByteLength, buffer);
    if ((tag === 'Uint16Array' || tag === 'Int16Array') && byteLength !== undefined) {
        if (byteLength === 0) return engine.decodeU16String(emptyU16);
        const object = buffer as object;
        const source = new Uint16ArrayConstructor(
            Reflect.apply(uint16Buffer, object, []),
            Reflect.apply(uint16ByteOffset, object, []),
            byteLength / 2,
        );
        return engine.decodeU16String(source);
    }

    return algorithm.latin1DecodeLoose(byteView(buffer));
}) as ArrayBufferToString;

/** Best-effort heap trim request; the host has no separate idle trim hook. */
export const shrink = (): void => {
    engine.gc.run();
};

/**
 * Returns Linux proportional set size when the kernel exposes its compact
 * rollup view. Other platforms deliberately return undefined rather than
 * substituting RSS or another non-equivalent metric.
 */
export const memoryFootprint = (): number | undefined => {
    if (os.platform !== 'linux') return undefined;

    try {
        const report = engine.decodeString(fs.readFile('/proc/self/smaps_rollup'));
        const matches = [...report.matchAll(/^Pss:\s*([0-9]+)\s+kB\s*$/gm)];
        if (matches.length !== 1) return undefined;
        const match = matches[0];

        const kib = Number(match[1]);
        if (!Number.isSafeInteger(kib) || kib < 0 || kib > MAX_PSS_KIB) return undefined;
        return kib * KIB;
    } catch {
        // Sandboxes and older kernels may not expose smaps_rollup.
        return undefined;
    }
};

/** Partial, intentionally conservative subset of Bun.unsafe. */
export const unsafe = Object.freeze({ memoryFootprint, arrayBufferToString });
