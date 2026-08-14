/** createCipheriv / createDecipheriv and the GCM + one-shot AES surface. */

const crypto = import.meta.use('crypto');
import { Buffer } from '../buffer';
import { Transform, type TransformOptions } from '../stream';
import type { BinaryInput, KeyInput, Cipheriv, Decipheriv, CipherGCM, DecipherGCM, GcmEncryptResult, GcmDecryptResult } from './types';
import { toBuffer, toExactArrayBuffer, encodeOutput, isGcmAlgorithm } from './helpers';
import { createInvalidIvError, createInvalidKeyLengthError, createUnknownCipherError, createAuthenticationFailedError, createCipherInvalidStateError, createInvalidGcmAuthTagLengthError, validateGcmAuthTagLength, withCode, asError } from './errors';
import { type CipherCore, type CipherivWithAutoPadding, type DecipherivWithAutoPadding, GCM_KEY_LENGTHS, toCipherKey, getEcbFns, getCbcFns, validateCbcKeyIv, makeEcbCipher, mapBadDecrypt, makeEcbDecipher, makeCbcCipher, makeCbcDecipher } from './cipher-modes';

class CipherTransform extends Transform implements CipherGCM, DecipherGCM {
    private readonly core: CipherCore;
    private finalized = false;
    private started = false;

    constructor(core: CipherCore, options?: TransformOptions) {
        super(options);
        this.core = core;
    }

    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): Uint8Array | string {
        if (this.finalized) throw createCipherInvalidStateError('update');
        const output = this.core.update(data, inputEncoding, outputEncoding);
        this.started = true;
        return output;
    }

    final(outputEncoding?: string): Uint8Array | string {
        if (this.finalized) throw createCipherInvalidStateError('final');
        this.finalized = true;
        return this.core.final(outputEncoding);
    }

    setAutoPadding(autoPadding = true): this {
        if (this.finalized) throw createCipherInvalidStateError('setAutoPadding');
        this.core.setAutoPadding?.(autoPadding);
        return this;
    }

    setAAD(aad: ArrayBuffer | ArrayBufferView): this {
        if (this.finalized || this.started) throw createCipherInvalidStateError('setAAD');
        if (!this.core.setAAD) throw new TypeError('setAAD is only supported for authenticated ciphers');
        this.core.setAAD(aad);
        return this;
    }

    setAuthTag(tag: ArrayBuffer | ArrayBufferView): this {
        if (this.finalized) throw createCipherInvalidStateError('setAuthTag');
        if (!this.core.setAuthTag) throw new TypeError('setAuthTag is only supported for authenticated ciphers');
        this.core.setAuthTag(tag);
        return this;
    }

    getAuthTag(): Uint8Array {
        if (!this.core.getAuthTag) throw new TypeError('getAuthTag is only supported for authenticated ciphers');
        return this.core.getAuthTag();
    }

    _transform(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void): void {
        try {
            const output = this.update(chunk as BinaryInput, encoding);
            callback(null, output);
        } catch (error) {
            callback(asError(error));
        }
    }

    _flush(callback: (error?: Error | null, data?: unknown) => void): void {
        try {
            callback(null, this.final());
        } catch (error) {
            callback(asError(error));
        }
    }
}

export function createCipheriv(algorithm: string, key: KeyInput, iv: BinaryInput | null, options?: TransformOptions & { authTagLength?: number }): Cipheriv {
    const keyBuf = toCipherKey(key);
    const a = algorithm.toLowerCase();

    if (a.endsWith('-ecb')) {
        const fns = getEcbFns(a);
        if (iv !== null) throw createInvalidIvError();
        if (keyBuf.byteLength !== fns.keyLength) throw createInvalidKeyLengthError();
        return new CipherTransform(makeEcbCipher(keyBuf, fns), options);
    }
    if (isGcmAlgorithm(a)) {
        if (iv === null) throw createInvalidIvError();
        return createCipherivGCM(a, keyBuf, iv, options);
    }

    const fns = getCbcFns(a);
    if (iv === null) throw createInvalidIvError();
    const ivBuf = toBuffer(iv);
    validateCbcKeyIv(keyBuf, ivBuf, fns);
    return new CipherTransform(makeCbcCipher(keyBuf, ivBuf, fns), options);
}

export function createDecipheriv(algorithm: string, key: KeyInput, iv: BinaryInput | null, options?: TransformOptions & { authTagLength?: number }): Decipheriv {
    const keyBuf = toCipherKey(key);
    const a = algorithm.toLowerCase();

    if (a.endsWith('-ecb')) {
        const fns = getEcbFns(a);
        if (iv !== null) throw createInvalidIvError();
        if (keyBuf.byteLength !== fns.keyLength) throw createInvalidKeyLengthError();
        return new CipherTransform(makeEcbDecipher(keyBuf, fns), options);
    }
    if (isGcmAlgorithm(a)) {
        if (iv === null) throw createInvalidIvError();
        return createDecipherivGCM(a, keyBuf, iv, options);
    }

    const fns = getCbcFns(a);
    if (iv === null) throw createInvalidIvError();
    const ivBuf = toBuffer(iv);
    validateCbcKeyIv(keyBuf, ivBuf, fns);
    return new CipherTransform(makeCbcDecipher(keyBuf, ivBuf, fns), options);
}

export function createCipherAes256Cbc(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
): CModuleCrypto.Cipher {
    return crypto.createCipherAes256Cbc(toBuffer(key), toBuffer(iv));
}

export function createDecipherAes256Cbc(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
): CModuleCrypto.Cipher {
    return crypto.createDecipherAes256Cbc(toBuffer(key), toBuffer(iv));
}

// createCipheriv GCM

export function createCipherivGCM(algorithm: string, key: KeyInput, iv: BinaryInput, options?: TransformOptions & { authTagLength?: number }): CipherGCM {
    const keyBuf = toCipherKey(key);
    const ivBuf = toBuffer(iv);
    if (!isGcmAlgorithm(algorithm)) {
        throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    }
    const expectedKeyLength = GCM_KEY_LENGTHS[algorithm.toLowerCase()];
    if (keyBuf.byteLength !== expectedKeyLength) throw createInvalidKeyLengthError();
    // OpenSSL rejects a 0-length GCM IV with a bare InternalError from the C
    // layer; Node reports ERR_CRYPTO_INVALID_IV.
    if (ivBuf.byteLength === 0) throw createInvalidIvError();
    const authTagLength = validateGcmAuthTagLength(options?.authTagLength) ?? 16;
    const gcm = new crypto.GCM('encrypt', toExactArrayBuffer(keyBuf), toExactArrayBuffer(ivBuf));
    let ctag: Uint8Array | undefined;

    return new CipherTransform({
        setAAD(aad: ArrayBuffer | ArrayBufferView) {
            gcm.setAAD(toExactArrayBuffer(toBuffer(aad)));
            return this;
        },
        update(data: ArrayBuffer | Uint8Array | string, inputEncoding?: string, outputEncoding?: string) {
            const result = gcm.update(toExactArrayBuffer(toBuffer(data, inputEncoding)));
            return encodeOutput(result, outputEncoding);
        },
        final(outputEncoding?: string) {
            const { data, tag } = gcm.final();
            ctag = new Uint8Array(tag).subarray(0, authTagLength);
            return encodeOutput(data, outputEncoding);
        },
        getAuthTag() {
            if (!ctag) throw createCipherInvalidStateError('getAuthTag');
            return Buffer.from(ctag);
        },
    }, options);
}

export function createDecipherivGCM(algorithm: string, key: KeyInput, iv: BinaryInput, options?: TransformOptions & { authTagLength?: number }): DecipherGCM {
    const keyBuf = toCipherKey(key);
    const ivBuf = toBuffer(iv);
    if (!isGcmAlgorithm(algorithm)) {
        throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    }
    const expectedKeyLength = GCM_KEY_LENGTHS[algorithm.toLowerCase()];
    if (keyBuf.byteLength !== expectedKeyLength) throw createInvalidKeyLengthError();
    if (ivBuf.byteLength === 0) throw createInvalidIvError();
    const expectedAuthTagLength = validateGcmAuthTagLength(options?.authTagLength);
    const gcm = new crypto.GCM('decrypt', toExactArrayBuffer(keyBuf), toExactArrayBuffer(ivBuf));
    let authTag: ArrayBuffer | null = null;

    return new CipherTransform({
        setAAD(aad: ArrayBuffer | ArrayBufferView) {
            gcm.setAAD(toExactArrayBuffer(toBuffer(aad)));
            return this;
        },
        setAuthTag(tag: ArrayBuffer | ArrayBufferView) {
            const tagBuffer = toBuffer(tag);
            validateGcmAuthTagLength(tagBuffer.byteLength);
            if (expectedAuthTagLength !== undefined && tagBuffer.byteLength !== expectedAuthTagLength) {
                throw createInvalidGcmAuthTagLengthError(tagBuffer.byteLength);
            }
            authTag = toExactArrayBuffer(tagBuffer);
            return this;
        },
        update(data: ArrayBuffer | Uint8Array | string, inputEncoding?: string, outputEncoding?: string) {
            const result = gcm.update(toExactArrayBuffer(toBuffer(data, inputEncoding)));
            return encodeOutput(result, outputEncoding);
        },
        final(outputEncoding?: string) {
            if (!authTag) {
                throw createAuthenticationFailedError();
            }
            const result = gcm.final(authTag);
            if (!result.verified) {
                throw createAuthenticationFailedError();
            }
            return encodeOutput(result.data, outputEncoding);
        },
    }, options);
}

export function gcmEncrypt(
    key: ArrayBuffer | Uint8Array,
    iv: ArrayBuffer | Uint8Array,
    plaintext: ArrayBuffer | Uint8Array,
    aad?: ArrayBuffer | Uint8Array,
    tagLength?: number,
): GcmEncryptResult {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const plaintextBuf = toBuffer(plaintext);
    const aadBuf = aad ? toBuffer(aad) : undefined;
    const result = crypto.gcmEncrypt(keyBuf, ivBuf, plaintextBuf, aadBuf, tagLength);
    return {
        ciphertext: result.ciphertext,
        tag: result.tag,
    };
}

export function gcmDecrypt(
    key: ArrayBuffer | Uint8Array,
    iv: ArrayBuffer | Uint8Array,
    ciphertext: ArrayBuffer | Uint8Array,
    tag: ArrayBuffer | Uint8Array,
    aad?: ArrayBuffer | Uint8Array,
): GcmDecryptResult {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const ciphertextBuf = toBuffer(ciphertext);
    const tagBuf = toBuffer(tag);
    const aadBuf = aad ? toBuffer(aad) : undefined;
    const result = crypto.gcmDecrypt(keyBuf, ivBuf, ciphertextBuf, tagBuf, aadBuf);
    return {
        plaintext: result.plaintext,
        verified: result.verified,
    };
}

export function aes128CbcEncrypt(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.aes128CbcEncrypt(toBuffer(key), toBuffer(iv), toBuffer(data));
}

export function aes128CbcDecrypt(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.aes128CbcDecrypt(toBuffer(key), toBuffer(iv), toBuffer(data));
}

export function aes256CbcEncrypt(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.aes256CbcEncrypt(toBuffer(key), toBuffer(iv), toBuffer(data));
}

export function aes256CbcDecrypt(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.aes256CbcDecrypt(toBuffer(key), toBuffer(iv), toBuffer(data));
}

export function aes128GcmEncrypt(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.aes128GcmEncrypt(toBuffer(key), toBuffer(iv), toBuffer(data));
}

export function aes128GcmDecrypt(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.aes128GcmDecrypt(toBuffer(key), toBuffer(iv), toBuffer(data));
}

export function aes256GcmEncrypt(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.aes256GcmEncrypt(toBuffer(key), toBuffer(iv), toBuffer(data));
}

export function aes256GcmDecrypt(
    key: ArrayBuffer | Uint8Array | string,
    iv: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.aes256GcmDecrypt(toBuffer(key), toBuffer(iv), toBuffer(data));
}

// Encryption/Decryption - one-shot

export function cipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, outputEncoding?: string): Uint8Array | string {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const dataBuf = toBuffer(data);
    let result: ArrayBuffer;

    const a = algorithm.toLowerCase();
    switch (a) {
        case 'aes-128-cbc': result = crypto.aes128CbcEncrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-192-cbc': result = crypto.aes192CbcEncrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-256-cbc': result = crypto.aes256CbcEncrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-128-gcm': result = crypto.aes128GcmEncrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-192-gcm': result = crypto.aes192GcmEncrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-256-gcm': result = crypto.aes256GcmEncrypt(keyBuf, ivBuf, dataBuf); break;
        default: throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    }

    return encodeOutput(result, outputEncoding);
}

export function decipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, outputEncoding?: string): Uint8Array | string {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const dataBuf = toBuffer(data);
    let result: ArrayBuffer;

    const a = algorithm.toLowerCase();
    switch (a) {
        case 'aes-128-cbc': result = crypto.aes128CbcDecrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-192-cbc': result = crypto.aes192CbcDecrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-256-cbc': result = crypto.aes256CbcDecrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-128-gcm': result = crypto.aes128GcmDecrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-192-gcm': result = crypto.aes192GcmDecrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-256-gcm': result = crypto.aes256GcmDecrypt(keyBuf, ivBuf, dataBuf); break;
        default: throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    }

    return encodeOutput(result, outputEncoding);
}
