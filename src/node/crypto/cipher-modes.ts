/**
 * ECB/CBC mode plumbing: the native function tables and the incremental
 * cipher/decipher cores that createCipheriv and createDecipheriv build on.
 */

const crypto = import.meta.use('crypto');
import type { BinaryInput, KeyInput } from './types';
import { toBuffer, toExactArrayBuffer, encodeOutput, concatBuffers, kKeyData, isKeyObject } from './helpers';
import { createInvalidIvError, createInvalidKeyLengthError, createUnknownCipherError, createAuthenticationFailedError, createCipherInvalidStateError, withCode } from './errors';

// createCipher / createDecipher

export type CipherCore = {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): Uint8Array | string;
    final(outputEncoding?: string): Uint8Array | string;
    setAutoPadding?(value: boolean): void;
    setAAD?(aad: ArrayBuffer | ArrayBufferView): unknown;
    setAuthTag?(tag: ArrayBuffer | ArrayBufferView): unknown;
    getAuthTag?(): Uint8Array;
};
export type CipherivWithAutoPadding = CipherCore & { setAutoPadding(value: boolean): void };
export type DecipherivWithAutoPadding = CipherCore & { setAutoPadding(value: boolean): void };

export type CbcFns = {
    keyLength: number;
    ivLength: number;
    encrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    encryptRaw: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decryptRaw: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
};

export type EcbFns = {
    keyLength: number;
    encrypt: (key: Uint8Array, data: Uint8Array) => ArrayBuffer;
    encryptRaw: (key: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decrypt: (key: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decryptRaw: (key: Uint8Array, data: Uint8Array) => ArrayBuffer;
};

export const GCM_KEY_LENGTHS: Record<string, number> = {
    'aes-128-gcm': 16,
    'aes-192-gcm': 24,
    'aes-256-gcm': 32,
};

export function toCipherKey(key: KeyInput): Uint8Array {
    if (!isKeyObject(key)) return toBuffer(key);
    if (key.type !== 'secret') throw new TypeError(`Invalid key object type ${key.type}, expected secret`);
    return key[kKeyData];
}

export function getEcbFns(algorithm: string): EcbFns {
    switch (algorithm) {
        case 'aes-128-ecb':
            return {
                keyLength: 16,
                encrypt: (key, data) => crypto.aes128EcbEncrypt(key, null, data),
                encryptRaw: (key, data) => crypto.aes128EcbEncryptRaw(key, null, data),
                decrypt: (key, data) => crypto.aes128EcbDecrypt(key, null, data),
                decryptRaw: (key, data) => crypto.aes128EcbDecryptRaw(key, null, data),
            };
        case 'aes-192-ecb':
            return {
                keyLength: 24,
                encrypt: (key, data) => crypto.aes192EcbEncrypt(key, null, data),
                encryptRaw: (key, data) => crypto.aes192EcbEncryptRaw(key, null, data),
                decrypt: (key, data) => crypto.aes192EcbDecrypt(key, null, data),
                decryptRaw: (key, data) => crypto.aes192EcbDecryptRaw(key, null, data),
            };
        case 'aes-256-ecb':
            return {
                keyLength: 32,
                encrypt: (key, data) => crypto.aes256EcbEncrypt(key, null, data),
                encryptRaw: (key, data) => crypto.aes256EcbEncryptRaw(key, null, data),
                decrypt: (key, data) => crypto.aes256EcbDecrypt(key, null, data),
                decryptRaw: (key, data) => crypto.aes256EcbDecryptRaw(key, null, data),
            };
        default:
            throw createUnknownCipherError(algorithm);
    }
}

export function getCbcFns(algorithm: string): CbcFns {
    switch (algorithm) {
        case 'aes-128-cbc':
            return {
                keyLength: 16,
                ivLength: 16,
                encrypt: crypto.aes128CbcEncrypt,
                encryptRaw: crypto.aes128CbcEncryptRaw,
                decrypt: crypto.aes128CbcDecrypt,
                decryptRaw: crypto.aes128CbcDecryptRaw,
            };
        case 'aes-192-cbc':
            return {
                keyLength: 24,
                ivLength: 16,
                encrypt: crypto.aes192CbcEncrypt,
                encryptRaw: crypto.aes192CbcEncryptRaw,
                decrypt: crypto.aes192CbcDecrypt,
                decryptRaw: crypto.aes192CbcDecryptRaw,
            };
        case 'aes-256-cbc':
        case 'aes256':
            return {
                keyLength: 32,
                ivLength: 16,
                encrypt: crypto.aes256CbcEncrypt,
                encryptRaw: crypto.aes256CbcEncryptRaw,
                decrypt: crypto.aes256CbcDecrypt,
                decryptRaw: crypto.aes256CbcDecryptRaw,
            };
        default:
            throw createUnknownCipherError(algorithm);
    }
}

export function validateCbcKeyIv(key: Uint8Array, iv: Uint8Array, fns: CbcFns): void {
    if (key.byteLength !== fns.keyLength) throw createInvalidKeyLengthError();
    if (iv.byteLength !== fns.ivLength) throw createInvalidIvError();
}

export function makeEcbCipher(key: Uint8Array, fns: EcbFns): CipherivWithAutoPadding {
    let autoPadding = true;
    const chunks: Uint8Array[] = [];

    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            const buf = concatBuffers(chunks);
            const processLength = Math.floor(buf.byteLength / 16) * 16;
            chunks.length = 0;
            if (buf.byteLength > processLength) chunks.push(buf.subarray(processLength));
            if (processLength === 0) return encodeOutput(new ArrayBuffer(0), outputEncoding);
            return encodeOutput(fns.encryptRaw(key, buf.subarray(0, processLength)), outputEncoding);
        },
        final(outputEncoding?: string) {
            const buf = concatBuffers(chunks);
            chunks.length = 0;
            const out = autoPadding ? fns.encrypt(key, buf) : fns.encryptRaw(key, buf);
            return encodeOutput(out, outputEncoding);
        },
        setAutoPadding(value: boolean) {
            autoPadding = value;
        },
    };
}

// The C layer (circu.js mod_crypto.c) collapses every OpenSSL failure into a
// generic InternalError, so a padded decipher final() failure is remapped here
// to Node's code. Only applied to decipher final(), where bad padding is the
// dominant cause.
export function mapBadDecrypt<T>(operation: () => T): T {
    try {
        return operation();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Cipher operation failed') {
            const err = withCode(
                new Error('error:1C800064:Provider routines::bad decrypt'),
                'ERR_OSSL_BAD_DECRYPT',
            );
            (err as Error & { cause?: unknown }).cause = error;
            throw err;
        }
        throw error;
    }
}

export function makeEcbDecipher(key: Uint8Array, fns: EcbFns): DecipherivWithAutoPadding {
    let autoPadding = true;
    const chunks: Uint8Array[] = [];

    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            const buf = concatBuffers(chunks);
            const fullLength = Math.floor(buf.byteLength / 16) * 16;
            const processLength = autoPadding ? Math.max(0, fullLength - 16) : fullLength;
            chunks.length = 0;
            if (buf.byteLength > processLength) chunks.push(buf.subarray(processLength));
            if (processLength === 0) return encodeOutput(new ArrayBuffer(0), outputEncoding);
            return encodeOutput(fns.decryptRaw(key, buf.subarray(0, processLength)), outputEncoding);
        },
        final(outputEncoding?: string) {
            const buf = concatBuffers(chunks);
            chunks.length = 0;
            const out = autoPadding
                ? mapBadDecrypt(() => fns.decrypt(key, buf))
                : fns.decryptRaw(key, buf);
            return encodeOutput(out, outputEncoding);
        },
        setAutoPadding(value: boolean) {
            autoPadding = value;
        },
    };
}

export function makeCbcCipher(key: Uint8Array, iv: Uint8Array, fns: CbcFns): CipherivWithAutoPadding {
    let autoPadding = true;
    let currentIv = new Uint8Array(iv);
    const chunks: Uint8Array[] = [];

    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            const buf = concatBuffers(chunks);
            const processLength = Math.floor(buf.byteLength / 16) * 16;
            chunks.length = 0;
            if (buf.byteLength > processLength) chunks.push(buf.subarray(processLength));
            if (processLength === 0) return encodeOutput(new ArrayBuffer(0), outputEncoding);

            const out = new Uint8Array(fns.encryptRaw(key, currentIv, buf.subarray(0, processLength)));
            currentIv = out.subarray(out.byteLength - 16);
            return encodeOutput(toExactArrayBuffer(out), outputEncoding);
        },
        final(outputEncoding?: string) {
            const buf = concatBuffers(chunks);
            chunks.length = 0;
            const out = autoPadding
                ? fns.encrypt(key, currentIv, buf)
                : fns.encryptRaw(key, currentIv, buf);
            return encodeOutput(out, outputEncoding);
        },
        setAutoPadding(v: boolean) {
            autoPadding = v;
        },
    };
}

export function makeCbcDecipher(key: Uint8Array, iv: Uint8Array, fns: CbcFns): DecipherivWithAutoPadding {
    let autoPadding = true;
    let currentIv = new Uint8Array(iv);
    const chunks: Uint8Array[] = [];

    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            const buf = concatBuffers(chunks);
            const fullLength = Math.floor(buf.byteLength / 16) * 16;
            const processLength = autoPadding ? Math.max(0, fullLength - 16) : fullLength;
            chunks.length = 0;
            if (buf.byteLength > processLength) chunks.push(buf.subarray(processLength));
            if (processLength === 0) return encodeOutput(new ArrayBuffer(0), outputEncoding);

            const input = buf.subarray(0, processLength);
            const out = fns.decryptRaw(key, currentIv, input);
            currentIv = input.subarray(input.byteLength - 16);
            return encodeOutput(out, outputEncoding);
        },
        final(outputEncoding?: string) {
            const buf = concatBuffers(chunks);
            chunks.length = 0;
            const out = autoPadding
                ? mapBadDecrypt(() => fns.decrypt(key, currentIv, buf))
                : fns.decryptRaw(key, currentIv, buf);
            return encodeOutput(out, outputEncoding);
        },
        setAutoPadding(v: boolean) {
            autoPadding = v;
        },
    };
}
