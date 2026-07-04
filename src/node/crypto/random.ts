/**
 * Node.js crypto module - random, pbkdf2, hkdf functions
 */

const crypto = import.meta.use('crypto');
import { toBuffer } from './helpers';

export interface ScryptOptions {
    N?: number;
    cost?: number;
    r?: number;
    blockSize?: number;
    p?: number;
    parallelization?: number;
    maxmem?: number;
}

function readScryptNumberOption(options: ScryptOptions | undefined, primary: keyof ScryptOptions, fallback: keyof ScryptOptions, defaultValue: number): number {
    const value = options?.[primary] ?? options?.[fallback];
    if (value === undefined || value === 0) {
        return defaultValue;
    }
    if (typeof value !== 'number') {
        throw new TypeError(`The "${String(primary)}" argument must be of type number. Received type ${typeof value}`);
    }
    if (!Number.isInteger(value)) {
        throw new RangeError(`The value of "${String(primary)}" is out of range. It must be an integer. Received ${value}`);
    }
    return value;
}

function parseScryptKeylen(keylen: number): number {
    if (typeof keylen !== 'number') {
        throw new TypeError(`The "keylen" argument must be of type number. Received type ${typeof keylen}`);
    }
    if (!Number.isInteger(keylen) || keylen < 0 || keylen > 0x7fffffff) {
        throw new RangeError(`The value of "keylen" is out of range. It must be >= 0 && <= 2147483647. Received ${keylen}`);
    }
    return keylen;
}

function isPowerOfTwo(value: number): boolean {
    return value > 1 && 2 ** Math.floor(Math.log2(value)) === value;
}

function parseScryptOptions(options?: ScryptOptions): { N: number; r: number; p: number; maxmem: number } {
    if (options === undefined) {
        return { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
    }
    if (options === null || typeof options !== 'object') {
        throw new TypeError('The "options" argument must be of type object');
    }

    const N = readScryptNumberOption(options, 'N', 'cost', 16384);
    const r = readScryptNumberOption(options, 'r', 'blockSize', 8);
    const p = readScryptNumberOption(options, 'p', 'parallelization', 1);
    const maxmem = options.maxmem ?? 32 * 1024 * 1024;

    if (typeof maxmem !== 'number') {
        throw new TypeError(`The "maxmem" argument must be of type number. Received type ${typeof maxmem}`);
    }
    if (!Number.isInteger(maxmem) || maxmem < 0 || maxmem > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`The value of "maxmem" is out of range. It must be >= 0 && <= ${Number.MAX_SAFE_INTEGER}. Received ${maxmem}`);
    }
    if (!isPowerOfTwo(N) || r < 0 || p < 0) {
        throw new RangeError('Invalid scrypt params');
    }

    return { N, r, p, maxmem };
}

// randomInt / randomFill

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

// pbkdf2

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

// scrypt

export function scrypt(password: ArrayBuffer | Uint8Array | string, salt: ArrayBuffer | Uint8Array | string, keylen: number, callback: (err: Error | null, derivedKey: Uint8Array) => void): void;
export function scrypt(password: ArrayBuffer | Uint8Array | string, salt: ArrayBuffer | Uint8Array | string, keylen: number, options: ScryptOptions, callback: (err: Error | null, derivedKey: Uint8Array) => void): void;
export function scrypt(
    password: ArrayBuffer | Uint8Array | string,
    salt: ArrayBuffer | Uint8Array | string,
    keylen: number,
    optionsOrCallback: ScryptOptions | ((err: Error | null, derivedKey: Uint8Array) => void),
    maybeCallback?: (err: Error | null, derivedKey: Uint8Array) => void,
): void {
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) throw new TypeError('callback is required');

    queueMicrotask(() => {
        try {
            callback(null, scryptSync(password, salt, keylen, options));
        } catch (err) {
            callback(err as Error, new Uint8Array(0));
        }
    });
}

export function scryptSync(
    password: ArrayBuffer | Uint8Array | string,
    salt: ArrayBuffer | Uint8Array | string,
    keylen: number,
    options?: ScryptOptions,
): Uint8Array {
    keylen = parseScryptKeylen(keylen);
    const { N, r, p, maxmem } = parseScryptOptions(options);
    const passwordBuf = toBuffer(password);
    const saltBuf = toBuffer(salt);
    return new Uint8Array(crypto.scrypt(passwordBuf, saltBuf, keylen, N, r, p, maxmem));
}

// hkdf

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
