import { sanitizeSurrogates } from '../../utils/bytes';
import { Blob as WebBlob } from '../../webapi/formdata';
import { isBunFile } from '../file';

export type HashInput = Parameters<typeof import('bun').hash>[0];

const engine = import.meta.use('engine');
const blobBytesSymbol = Symbol.for('cno.blob.bytes');

type BrandGetter<T> = (this: unknown) => T;

const blobSizeGetter = Object.getOwnPropertyDescriptor(WebBlob.prototype, 'size')!.get! as BrandGetter<number>;
const blobBytes = Reflect.get(WebBlob.prototype, blobBytesSymbol) as (this: Blob) => Uint8Array;

const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get! as BrandGetter<number>;
const sharedArrayBufferByteLengthGetter = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get as BrandGetter<number> | undefined
    : undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get! as BrandGetter<number>;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get! as BrandGetter<number>;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const dataViewByteOffsetGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get! as BrandGetter<number>;
const dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get! as BrandGetter<number>;
const arrayBufferIsView = ArrayBuffer.isView;
const emptyBytes = new Uint8Array();
const invalidInputPrototype = Object.create(TypeError.prototype) as TypeError & { code: string };

Object.defineProperties(invalidInputPrototype, {
    name: { configurable: true, enumerable: true, value: 'TypeError', writable: true },
    code: { configurable: true, enumerable: true, value: 'ERR_INVALID_ARG_TYPE', writable: true },
    toString: {
        configurable: true,
        enumerable: true,
        value: function toString(this: TypeError & { code: string }) {
            return `${this.name} [${this.code}]: ${this.message}`;
        },
        writable: true,
    },
});

function invalidInput(): TypeError & { code: string } {
    const error = new TypeError('data must be a string, ArrayBuffer, ArrayBufferView or Blob');
    Object.setPrototypeOf(error, invalidInputPrototype);
    return error as TypeError & { code: string };
}

function rawBufferByteLength(value: unknown): number | undefined {
    try {
        return Reflect.apply(arrayBufferByteLengthGetter, value, []);
    } catch {
        if (!sharedArrayBufferByteLengthGetter) return undefined;
        try {
            return Reflect.apply(sharedArrayBufferByteLengthGetter, value, []);
        } catch {
            return undefined;
        }
    }
}

function blobBytesOf(value: unknown): Uint8Array | undefined {
    try {
        Reflect.apply(blobSizeGetter, value, []);
        return Reflect.apply(blobBytes, value, []) as Uint8Array;
    } catch {
        return undefined;
    }
}

function viewBytes(value: ArrayBufferView): Uint8Array {
    let buffer: ArrayBufferLike;
    try {
        buffer = Reflect.apply(typedArrayBufferGetter, value, []);
        const byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []);
        const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []);
        return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
    } catch {
        try {
            buffer = Reflect.apply(dataViewBufferGetter, value, []);
            const byteOffset = Reflect.apply(dataViewByteOffsetGetter, value, []);
            const byteLength = Reflect.apply(dataViewByteLengthGetter, value, []);
            return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
        } catch {
            // Bun hashes detached and out-of-bounds views as empty inputs.
            return emptyBytes;
        }
    }
}

/** Convert supported inputs without losing the byte bounds of typed-array views. */
export function hashInputBytes(data: unknown): Uint8Array {
    if (data == null) {
        throw invalidInput();
    }
    if (typeof data === 'string') return engine.encodeString(sanitizeSurrogates(data));
    if (isBunFile(data)) {
        throw Object.assign(invalidInput(), { message: 'File blob cannot be used here' });
    }
    const blob = blobBytesOf(data);
    if (blob) return blob;
    const byteLength = rawBufferByteLength(data);
    if (byteLength !== undefined) {
        return byteLength === 0 ? emptyBytes : new Uint8Array(data as ArrayBufferLike, 0, byteLength);
    }
    if (arrayBufferIsView(data)) {
        return viewBytes(data);
    }
    return engine.encodeString(sanitizeSurrogates(`${data}`));
}

export function seed32(value: unknown): number {
    if (typeof value === 'bigint') return Number(BigInt.asUintN(32, value));
    return Number(BigInt.asUintN(32, numberSeed(value)));
}

export function seed64(value: unknown): bigint {
    if (typeof value === 'bigint') return BigInt.asUintN(64, value);
    return numberSeed(value);
}

function numberSeed(value: unknown): bigint {
    if (typeof value !== 'number' || Number.isNaN(value) || value === -Infinity) return 0n;
    if (value === Infinity || value >= 2 ** 64) return 0xffff_ffff_ffff_ffffn;
    // Finite negative values wrap modulo 2^64, including values below -2^64.
    return BigInt.asUintN(64, BigInt(Math.trunc(value)));
}
