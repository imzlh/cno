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
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= -0x8000_0000 || value >= 2 ** 51) return 0;
    return Math.trunc(value) >>> 0;
}

export function seed64(value: unknown): bigint {
    if (typeof value === 'bigint') return BigInt.asUintN(64, value);
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= -0x8000_0000 || value >= 2 ** 51) return 0n;
    return BigInt.asUintN(64, BigInt(Math.trunc(value)));
}
