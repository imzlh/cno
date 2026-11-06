import { sanitizeSurrogates } from '../../utils/bytes';

export type HashInput = Parameters<typeof import('bun').hash>[0];

const engine = import.meta.use('engine');
const blobBytesSymbol = Symbol.for('cno.blob.bytes');

const sharedArrayBufferByteLengthGetter = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;

function hasSharedArrayBufferSlot(value: unknown): value is SharedArrayBuffer {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
    if (!sharedArrayBufferByteLengthGetter) return false;
    try {
        Reflect.apply(sharedArrayBufferByteLengthGetter, value, []);
        return true;
    } catch {
        return false;
    }
}

/** Convert supported inputs without losing the byte bounds of typed-array views. */
export function hashInputBytes(data: unknown): Uint8Array {
    if (data == null) {
        throw Object.assign(
            new TypeError('data must be a string, ArrayBuffer, ArrayBufferView or Blob'),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    if (typeof data === 'string') return engine.encodeString(sanitizeSurrogates(data));
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        const getBytes = Reflect.get(data, blobBytesSymbol);
        if (typeof getBytes === 'function') return Reflect.apply(getBytes, data, []) as Uint8Array;
    }
    if (engine.isArrayBuffer(data) || hasSharedArrayBufferSlot(data)) {
        return new Uint8Array(data as ArrayBufferLike);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
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
