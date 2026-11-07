const blobBytesSymbol = Symbol.for('cno.blob.bytes');
const blobPrototype = Blob.prototype;
const blobSizeGetter = Object.getOwnPropertyDescriptor(blobPrototype, 'size')!.get!;
const blobBytes = Reflect.get(blobPrototype, blobBytesSymbol) as (this: Blob) => Uint8Array;

/** Return bytes only when `value` carries the runtime Blob's internal slots. */
export function blobBytesOf(value: unknown): Uint8Array | undefined {
    try {
        Reflect.apply(blobSizeGetter, value, []);
        return Reflect.apply(blobBytes, value, []) as Uint8Array;
    } catch {
        return undefined;
    }
}
