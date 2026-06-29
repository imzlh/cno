/**
 * Node.js crypto module - random, pbkdf2, hkdf functions
 */

const crypto = import.meta.use('crypto');
import { toBuffer } from './helpers';

// ============================================================================
// randomInt / randomFill
// ============================================================================

export function randomInt(max: number): number;
export function randomInt(min: number, max: number): number;
export function randomInt(min: number, max?: number, callback?: (err: Error | null, n: number) => void): number | void {
    if (max === undefined) {
        max = min;
        min = 0;
    }

    const range = max - min;
    const limit = Math.floor(0x100000000 / range) * range;
    let value: number;
    do {
        const bytes = new Uint8Array(crypto.randomBytes(4));
        value = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
    } while (value >= limit);
    const result = min + (value % range);

    if (callback) {
        queueMicrotask(() => callback(null, result));
        return;
    }
    return result;
}

export function randomFill<T extends ArrayBufferView>(buffer: T, callback: (err: Error | null, buf: T) => void): void;
export function randomFill<T extends ArrayBufferView>(buffer: T, offset: number, callback: (err: Error | null, buf: T) => void): void;
export function randomFill<T extends ArrayBufferView>(buffer: T, offset: number, size: number, callback: (err: Error | null, buf: T) => void): void;
export function randomFill<T extends ArrayBufferView>(buffer: T, offset?: number | ((err: Error | null, buf: T) => void), size?: number | ((err: Error | null, buf: T) => void), callback?: (err: Error | null, buf: T) => void): void {
    if (typeof offset === 'function') {
        callback = offset;
        offset = 0;
        size = buffer.byteLength;
    } else if (typeof size === 'function') {
        callback = size;
        size = buffer.byteLength - (offset as number);
    }

    const off = offset as number;
    const sz = size as number;
    const cb = callback!;

    if (off < 0 || sz < 0 || off + sz > buffer.byteLength) {
        cb(new RangeError('offset + size exceeds buffer length'), buffer);
        return;
    }

    try {
        const randomData = new Uint8Array(crypto.randomBytes(sz));
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        for (let i = 0; i < sz; i++) {
            view[off + i] = randomData[i];
        }
        cb(null, buffer);
    } catch (err) {
        cb(err as Error, buffer);
    }
}

export function randomFillSync<T extends ArrayBufferView>(buffer: T, offset = 0, size?: number): T {
    const sz = size ?? buffer.byteLength - offset;
    if (offset < 0 || sz < 0 || offset + sz > buffer.byteLength) {
        throw new RangeError('offset + size exceeds buffer length');
    }
    const randomData = new Uint8Array(crypto.randomBytes(sz));
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    for (let i = 0; i < sz; i++) {
        view[offset + i] = randomData[i]!;
    }
    return buffer;
}

// ============================================================================
// pbkdf2
// ============================================================================

export function pbkdf2(password: ArrayBuffer | Uint8Array | string, salt: ArrayBuffer | Uint8Array | string, iterations: number, keylen: number, digest: string, callback: (err: Error | null, derivedKey: Uint8Array) => void): void {
    try {
        const passwordBuf = toBuffer(password);
        const saltBuf = toBuffer(salt);
        let result: ArrayBuffer;

        switch (digest.toLowerCase()) {
            case 'sha256':
                result = crypto.pbkdf2Sha256(passwordBuf, saltBuf, iterations, keylen);
                break;
            case 'sha512':
                result = crypto.pbkdf2Sha512(passwordBuf, saltBuf, iterations, keylen);
                break;
            default:
                throw new Error(`Unsupported digest: ${digest}`);
        }

        callback(null, new Uint8Array(result));
    } catch (err) {
        callback(err as Error, new Uint8Array(0));
    }
}

export function pbkdf2Sync(password: ArrayBuffer | Uint8Array | string, salt: ArrayBuffer | Uint8Array | string, iterations: number, keylen: number, digest: string): Uint8Array {
    const passwordBuf = toBuffer(password);
    const saltBuf = toBuffer(salt);
    let result: ArrayBuffer;

    switch (digest.toLowerCase()) {
        case 'sha256':
            result = crypto.pbkdf2Sha256(passwordBuf, saltBuf, iterations, keylen);
            break;
        case 'sha512':
            result = crypto.pbkdf2Sha512(passwordBuf, saltBuf, iterations, keylen);
            break;
        default:
            throw new Error(`Unsupported digest: ${digest}`);
    }

    return new Uint8Array(result);
}

export function pbkdf2Sha256(
    password: ArrayBuffer | Uint8Array | string,
    salt: ArrayBuffer | Uint8Array | string,
    iterations: number,
    keylen: number,
): ArrayBuffer {
    return crypto.pbkdf2Sha256(toBuffer(password), toBuffer(salt), iterations, keylen);
}

export function pbkdf2Sha512(
    password: ArrayBuffer | Uint8Array | string,
    salt: ArrayBuffer | Uint8Array | string,
    iterations: number,
    keylen: number,
): ArrayBuffer {
    return crypto.pbkdf2Sha512(toBuffer(password), toBuffer(salt), iterations, keylen);
}

// ============================================================================
// hkdf
// ============================================================================

export function hkdf(digest: string, ikm: ArrayBuffer | Uint8Array, salt: ArrayBuffer | Uint8Array, info: ArrayBuffer | Uint8Array, keylen: number): ArrayBuffer {
    const ikmBuf = toBuffer(ikm);
    const saltBuf = salt ? toBuffer(salt) : undefined;
    const infoBuf = info ? toBuffer(info) : undefined;

    switch (digest.toLowerCase()) {
        case 'sha256':
            return crypto.hkdfSha256(ikmBuf, keylen, saltBuf, infoBuf);
        case 'sha512':
            return crypto.hkdfSha512(ikmBuf, keylen, saltBuf, infoBuf);
        default:
            throw new Error(`Unsupported digest: ${digest}`);
    }
}

export function hkdfSync(digest: string, ikm: ArrayBuffer | Uint8Array, salt: ArrayBuffer | Uint8Array, info: ArrayBuffer | Uint8Array, keylen: number): ArrayBuffer {
    return hkdf(digest, ikm, salt, info, keylen);
}

export function hkdfSha256(
    ikm: ArrayBuffer | Uint8Array | string,
    keylen: number,
    salt?: ArrayBuffer | Uint8Array | string,
    info?: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.hkdfSha256(toBuffer(ikm), keylen, salt ? toBuffer(salt) : undefined, info ? toBuffer(info) : undefined);
}

export function hkdfSha512(
    ikm: ArrayBuffer | Uint8Array | string,
    keylen: number,
    salt?: ArrayBuffer | Uint8Array | string,
    info?: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.hkdfSha512(toBuffer(ikm), keylen, salt ? toBuffer(salt) : undefined, info ? toBuffer(info) : undefined);
}
