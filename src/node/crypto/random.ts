/**
 * Node.js crypto module - random, pbkdf2, hkdf functions
 */

const crypto = import.meta.use('crypto');
import { normalizeHashAlgorithm, oneShotHmac, toBuffer } from './helpers';
import { Buffer } from '../buffer';
import type { BinaryInput } from './types';

type RandomFillBuffer = ArrayBuffer | ArrayBufferView;

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

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

function assertCallback(callback: unknown): asserts callback is (...args: unknown[]) => void {
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }
}

// randomInt / randomFill

const RANDOM_INT_MAX = 0x1000000000000;
const RANDOM_INT_MAX_RANGE = RANDOM_INT_MAX - 1;

function assertRandomInt(name: string, value: number): void {
    if (!Number.isSafeInteger(value)) {
        throw new TypeError(`The "${name}" argument must be a safe integer`);
    }
}

function assertRandomFillBuffer(buffer: unknown): asserts buffer is RandomFillBuffer {
    if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
        throw new TypeError('The "buf" argument must be an instance of ArrayBuffer or ArrayBufferView');
    }
}

function parseRandomFillRange(buffer: RandomFillBuffer, offset: number, size: number): { off: number; sz: number } {
    if (typeof offset !== 'number') {
        throw new TypeError('The "offset" argument must be of type number');
    }
    if (!Number.isFinite(offset) || offset < 0 || offset > buffer.byteLength) {
        throw new RangeError('The value of "offset" is out of range');
    }
    if (typeof size !== 'number') {
        throw new TypeError('The "size" argument must be of type number');
    }

    const off = Math.trunc(offset);
    const sz = Math.trunc(size);
    if (!Number.isFinite(size) || sz < 0 || off + sz > buffer.byteLength) {
        throw new RangeError('The value of "size + offset" is out of range');
    }
    return { off, sz };
}

export function randomInt(max: number): number;
export function randomInt(max: number, callback: (err: Error | null, n: number) => void): void;
export function randomInt(min: number, max: number): number;
export function randomInt(min: number, max: number, callback: (err: Error | null, n: number) => void): void;
export function randomInt(min: number, max?: number | ((err: Error | null, n: number) => void), callback?: (err: Error | null, n: number) => void): number | void {
    if (typeof max === 'function') {
        callback = max;
        max = min;
        min = 0;
    } else if (max === undefined) {
        max = min;
        min = 0;
    }

    assertRandomInt('min', min);
    assertRandomInt('max', max);
    const range = max - min;
    if (range <= 0) {
        throw new RangeError(`The value of "max" must be greater than the value of "min"`);
    }
    if (range > RANDOM_INT_MAX_RANGE) {
        throw new RangeError(`The value of "max - min" must be <= ${RANDOM_INT_MAX_RANGE}`);
    }
    if (callback !== undefined && typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }

    const limit = Math.floor(RANDOM_INT_MAX / range) * range;
    const bytes = new Uint8Array(6);
    let value: number;
    do {
        crypto.randomFill(bytes);
        value = bytes[0] * 0x10000000000
            + bytes[1] * 0x100000000
            + bytes[2] * 0x1000000
            + bytes[3] * 0x10000
            + bytes[4] * 0x100
            + bytes[5];
    } while (value >= limit);
    const result = min + (value % range);

    if (callback) {
        queueMicrotask(() => callback(null, result));
        return;
    }
    return result;
}

export function randomFill<T extends RandomFillBuffer>(buffer: T, callback: (err: Error | null, buf: T) => void): void;
export function randomFill<T extends RandomFillBuffer>(buffer: T, offset: number, callback: (err: Error | null, buf: T) => void): void;
export function randomFill<T extends RandomFillBuffer>(buffer: T, offset: number, size: number, callback: (err: Error | null, buf: T) => void): void;
export function randomFill<T extends RandomFillBuffer>(buffer: T, offset?: number | ((err: Error | null, buf: T) => void), size?: number | ((err: Error | null, buf: T) => void), callback?: (err: Error | null, buf: T) => void): void {
    assertRandomFillBuffer(buffer);
    let fillOffset = 0;
    let fillSize: number | undefined;
    if (typeof offset === 'function') {
        callback = offset;
        fillSize = buffer.byteLength;
    } else if (typeof size === 'function') {
        callback = size;
        fillOffset = offset ?? 0;
        fillSize = buffer.byteLength - fillOffset;
    } else {
        fillOffset = offset ?? 0;
        fillSize = size;
    }

    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }

    const { off, sz } = parseRandomFillRange(
        buffer,
        fillOffset,
        fillSize === undefined ? buffer.byteLength - Math.trunc(fillOffset) : fillSize,
    );
    const cb = callback;

    try {
        crypto.randomFill(buffer, off, sz);
    } catch (err) {
        cb(asError(err), buffer);
        return;
    }
    cb(null, buffer);
}

export function randomFillSync<T extends RandomFillBuffer>(buffer: T, offset = 0, size?: number): T {
    assertRandomFillBuffer(buffer);
    const { off, sz } = parseRandomFillRange(buffer, offset, size ?? buffer.byteLength - Math.trunc(offset));
    crypto.randomFill(buffer, off, sz);
    return buffer;
}

// pbkdf2

export function pbkdf2(password: ArrayBuffer | Uint8Array | string, salt: ArrayBuffer | Uint8Array | string, iterations: number, keylen: number, digest: string, callback: (err: Error | null, derivedKey: Buffer) => void): void {
    assertCallback(callback);
    queueMicrotask(() => {
        let result: Buffer;
        try {
            result = pbkdf2Sync(password, salt, iterations, keylen, digest);
        } catch (err) {
            callback(asError(err), Buffer.alloc(0));
            return;
        }
        callback(null, result);
    });
}

export function pbkdf2Sync(password: ArrayBuffer | Uint8Array | string, salt: ArrayBuffer | Uint8Array | string, iterations: number, keylen: number, digest: string): Buffer {
    const passwordBuf = toBuffer(password);
    const saltBuf = toBuffer(salt);
    let result: ArrayBuffer;

    switch (normalizeHashAlgorithm(digest)) {
        case 'md5':
            result = pbkdf2Digest(passwordBuf, saltBuf, iterations, keylen, 'md5', 16);
            break;
        case 'ripemd160':
            result = pbkdf2Digest(passwordBuf, saltBuf, iterations, keylen, 'ripemd160', 20);
            break;
        case 'sha1':
            result = pbkdf2Digest(passwordBuf, saltBuf, iterations, keylen, 'sha1', 20);
            break;
        case 'sha224':
            result = pbkdf2Digest(passwordBuf, saltBuf, iterations, keylen, 'sha224', 28);
            break;
        case 'sha256':
            result = crypto.pbkdf2Sha256(passwordBuf, saltBuf, iterations, keylen);
            break;
        case 'sha384':
            result = pbkdf2Digest(passwordBuf, saltBuf, iterations, keylen, 'sha384', 48);
            break;
        case 'sha512':
            result = crypto.pbkdf2Sha512(passwordBuf, saltBuf, iterations, keylen);
            break;
        default:
            throw new Error(`Unsupported digest: ${digest}`);
    }

    return Buffer.from(result);
}

function pbkdf2Digest(
    passwordBuf: Uint8Array,
    saltBytes: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    hashLen: number,
): ArrayBuffer {
    if (iterations < 1 || keylen < 1) {
        throw new RangeError('Invalid iterations or keylen');
    }

    const blocks = Math.ceil(keylen / hashLen);
    const out = new Uint8Array(blocks * hashLen);

    for (let block = 1; block <= blocks; block++) {
        const input = new Uint8Array(saltBytes.length + 4);
        input.set(saltBytes);
        input[input.length - 4] = (block >>> 24) & 0xff;
        input[input.length - 3] = (block >>> 16) & 0xff;
        input[input.length - 2] = (block >>> 8) & 0xff;
        input[input.length - 1] = block & 0xff;

        let u = new Uint8Array(oneShotHmac(digest, passwordBuf, input));
        const t = new Uint8Array(u);
        for (let i = 1; i < iterations; i++) {
            u = new Uint8Array(oneShotHmac(digest, passwordBuf, u));
            for (let j = 0; j < hashLen; j++) t[j] ^= u[j];
        }
        out.set(t, (block - 1) * hashLen);
    }

    return out.slice(0, keylen).buffer;
}

export function pbkdf2Sha1(
    password: BinaryInput,
    salt: BinaryInput,
    iterations: number,
    keylen: number,
): ArrayBuffer {
    return pbkdf2Digest(toBuffer(password), toBuffer(salt), iterations, keylen, 'sha1', 20);
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

export function scrypt(password: ArrayBuffer | Uint8Array | string, salt: ArrayBuffer | Uint8Array | string, keylen: number, callback: (err: Error | null, derivedKey: Buffer) => void): void;
export function scrypt(password: ArrayBuffer | Uint8Array | string, salt: ArrayBuffer | Uint8Array | string, keylen: number, options: ScryptOptions, callback: (err: Error | null, derivedKey: Buffer) => void): void;
export function scrypt(
    password: ArrayBuffer | Uint8Array | string,
    salt: ArrayBuffer | Uint8Array | string,
    keylen: number,
    optionsOrCallback: ScryptOptions | ((err: Error | null, derivedKey: Buffer) => void),
    maybeCallback?: (err: Error | null, derivedKey: Buffer) => void,
): void {
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    assertCallback(callback);

    // Match Node's eager validation: invalid params throw before any async work
    // is queued, while valid inputs still resolve through the callback.
    parseScryptKeylen(keylen);
    parseScryptOptions(options);

    queueMicrotask(() => {
        let result: Buffer;
        try {
            result = scryptSync(password, salt, keylen, options);
        } catch (err) {
            callback(asError(err), Buffer.alloc(0));
            return;
        }
        callback(null, result);
    });
}

export function scryptSync(
    password: ArrayBuffer | Uint8Array | string,
    salt: ArrayBuffer | Uint8Array | string,
    keylen: number,
    options?: ScryptOptions,
): Buffer {
    keylen = parseScryptKeylen(keylen);
    const { N, r, p, maxmem } = parseScryptOptions(options);
    const passwordBuf = toBuffer(password);
    const saltBuf = toBuffer(salt);
    return Buffer.from(crypto.scrypt(passwordBuf, saltBuf, keylen, N, r, p, maxmem));
}

// hkdf

function assertHkdfInfo(info: Uint8Array): void {
    if (info.byteLength > 1024) {
        throw new RangeError('The "info" argument must not contain more than 1024 bytes');
    }
}

function deriveHkdf(digest: string, ikm: BinaryInput, salt: BinaryInput, info: BinaryInput, keylen: number): ArrayBuffer {
    const ikmBuf = toBuffer(ikm);
    const saltBuf = salt ? toBuffer(salt) : undefined;
    const infoBuf = info ? toBuffer(info) : undefined;
    if (infoBuf) assertHkdfInfo(infoBuf);

    switch (digest.toLowerCase()) {
        case 'sha256':
            return crypto.hkdfSha256(ikmBuf, keylen, saltBuf, infoBuf);
        case 'sha512':
            return crypto.hkdfSha512(ikmBuf, keylen, saltBuf, infoBuf);
        default:
            throw new Error(`Unsupported digest: ${digest}`);
    }
}

export function hkdf(digest: string, ikm: BinaryInput, salt: BinaryInput, info: BinaryInput, keylen: number, callback: (err: Error | null, derivedKey?: ArrayBuffer) => void): void {
    assertCallback(callback);
    queueMicrotask(() => {
        let result: ArrayBuffer;
        try {
            result = deriveHkdf(digest, ikm, salt, info, keylen);
        } catch (err) {
            callback(asError(err));
            return;
        }
        callback(null, result);
    });
}

export function hkdfSync(digest: string, ikm: BinaryInput, salt: BinaryInput, info: BinaryInput, keylen: number): ArrayBuffer {
    return deriveHkdf(digest, ikm, salt, info, keylen);
}

export function hkdfSha256(
    ikm: BinaryInput,
    keylen: number,
    salt?: BinaryInput,
    info?: BinaryInput,
): ArrayBuffer {
    return crypto.hkdfSha256(toBuffer(ikm), keylen, salt ? toBuffer(salt) : undefined, info ? toBuffer(info) : undefined);
}

export function hkdfSha512(
    ikm: BinaryInput,
    keylen: number,
    salt?: BinaryInput,
    info?: BinaryInput,
): ArrayBuffer {
    return crypto.hkdfSha512(toBuffer(ikm), keylen, salt ? toBuffer(salt) : undefined, info ? toBuffer(info) : undefined);
}
