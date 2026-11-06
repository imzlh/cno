const fs = import.meta.use('fs');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');

const KIB = 1024;
const MAX_PSS_KIB = Math.floor(Number.MAX_SAFE_INTEGER / KIB);

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

type Getter = () => number;

function hasTypedArrayBrand(getter: Getter | undefined, value: unknown): value is object {
    if (!getter) return false;
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
        getter.call(value as object);
        return true;
    } catch {
        return false;
    }
}

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
    return hasTypedArrayBrand(arrayBufferByteLength, value)
        || hasTypedArrayBrand(sharedArrayBufferByteLength, value);
}

function typedArrayTag(value: unknown): string {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return '';
    try {
        // Calling the intrinsic getter directly avoids a user-defined
        // Symbol.toStringTag and still works for typed arrays from another realm.
        return typedArrayTagGetter.call(value);
    } catch {
        return '';
    }
}

function byteView(value: unknown): Uint8Array {
    const tag = typedArrayTag(value);
    if (tag && tag !== 'Uint16Array' && hasTypedArrayBrand(uint8ByteLength, value)) {
        const object = value as object;
        const buffer = uint8Buffer.call(object);
        return new Uint8Array(
            buffer,
            uint8ByteOffset.call(object),
            uint8ByteLength.call(object),
        );
    }
    if (isArrayBufferLike(value)) return new Uint8Array(value);
    throw new TypeError('Expected an ArrayBuffer');
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
    if ((tag === 'Uint16Array' || tag === 'Int16Array')
        && hasTypedArrayBrand(uint16ByteLength, buffer)) {
        const object = buffer as object;
        const source = new Uint16Array(
            uint16Buffer.call(object),
            uint16ByteOffset.call(object),
            uint16ByteLength.call(object) / 2,
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
