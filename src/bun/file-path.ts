/**
 * Bun accepts a path supplied as an ArrayBuffer, Uint8Array, or DataView.
 * Use intrinsic accessors instead of `instanceof` so values from another
 * JavaScript realm retain the same validation and byte-window semantics.
 */

type BrandGetter = (this: object) => number;

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get! as BrandGetter;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get as BrandGetter | undefined
    : undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get! as BrandGetter;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get! as (this: object) => string;
const dataViewByteLength = typeof DataView === 'function'
    ? Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get! as BrandGetter
    : undefined;

function hasBrand(getter: BrandGetter | undefined, value: unknown): boolean {
    if (!getter || value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
        getter.call(value as object);
        return true;
    } catch {
        return false;
    }
}

function isUint8Array(value: unknown): value is Uint8Array<ArrayBufferLike> {
    if (!hasBrand(typedArrayByteLength, value)) return false;
    try {
        return typedArrayTagGetter.call(value as object) === 'Uint8Array';
    } catch {
        return false;
    }
}

function isDataView(value: unknown): value is DataView<ArrayBufferLike> {
    return hasBrand(dataViewByteLength, value);
}

export type BunBytePath = ArrayBufferLike | Uint8Array<ArrayBufferLike> | DataView<ArrayBufferLike>;

export function isBunBytePath(value: unknown): value is BunBytePath {
    return isUint8Array(value) || isDataView(value) || hasBrand(arrayBufferByteLength, value)
        || hasBrand(sharedArrayBufferByteLength, value);
}
