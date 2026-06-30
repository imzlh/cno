/**
 * Node.js crypto module
 * Based on CModuleCrypto implementation
 */

const crypto = import.meta.use('crypto');

// Re-export types from types.ts
export type { BinaryInput, Hash, Hmac, Cipheriv, Decipheriv, CipherGCM, DecipherGCM, GcmEncryptResult, GcmDecryptResult, Sign, Verify } from './types';
import type { BinaryInput, Hash, Hmac, Cipheriv, Decipheriv, CipherGCM, DecipherGCM, GcmEncryptResult, GcmDecryptResult, Sign, Verify } from './types';

// Import helpers from helpers.ts
import { toBuffer, encodeOutput, concatBuffers, createBufferedCipher, createBufferedDecipher, isGcmAlgorithm, normalizeHashAlgorithm, oneShotHmac, createOneShotHmac, readAsymmetricCipherArgs } from './helpers';

function resolveCurve(curve: string): 'p256' | 'p384' | 'p521' {
    switch (curve.toLowerCase()) {
        case 'p256': case 'prime256v1': case 'secp256r1': return 'p256';
        case 'p384': case 'secp384r1': return 'p384';
        case 'p521': case 'secp521r1': return 'p521';
        default: throw new Error(`Unsupported curve: ${curve}`);
    }
}

// createHash

export function createHash(algorithm: string): Hash {
    const a = normalizeHashAlgorithm(algorithm);

    // Algorithms with native streaming support
    const streamingAlgos: Record<string, () => CModuleCrypto.Hash> = {
        md5:    () => crypto.createMd5(),
        sha1:   () => crypto.createSha1(),
        sha256: () => crypto.createSha256(),
        sha512: () => crypto.createSha512(),
    };

    // Algorithms without native streaming — accumulate and use one-shot
    const oneshotAlgos: Record<string, (buf: Uint8Array) => ArrayBuffer> = {
        sha224:  buf => crypto.sha224(buf),
        sha384:  buf => crypto.sha384(buf),
        sha3224: buf => crypto.sha3_224(buf),
        sha3256: buf => crypto.sha3_256(buf),
        sha3384: buf => crypto.sha3_384(buf),
        sha3512: buf => crypto.sha3_512(buf),
    };

    if (streamingAlgos[a]) {
        const hashObj = streamingAlgos[a]!();
        return {
            update(input: BinaryInput, encoding?: string) {
                hashObj.update(toBuffer(input, encoding));
                return this;
            },
            digest(encoding?: string) {
                return encodeOutput(hashObj.digest(), encoding);
            },
        };
    }

    if (oneshotAlgos[a]) {
        const fn = oneshotAlgos[a]!;
        const chunks: Uint8Array[] = [];
        return {
            update(input: BinaryInput, encoding?: string) {
                chunks.push(toBuffer(input, encoding));
                return this;
            },
            digest(encoding?: string) {
                const total = chunks.reduce((s, c) => s + c.length, 0);
                const buf = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) { buf.set(c, off); off += c.length; }
                return encodeOutput(fn(buf), encoding);
            },
        };
    }

    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
}

// hash - one-shot hash

export function hash(algorithm: string, data: ArrayBuffer | Uint8Array | string, outputEncoding?: string): ArrayBuffer | string {
    const buf = toBuffer(data);
    let result: ArrayBuffer;

    const a = normalizeHashAlgorithm(algorithm);
    switch (a) {
        case 'md5':       result = crypto.md5(buf); break;
        case 'sha1':      result = crypto.sha1(buf); break;
        case 'sha224':    result = crypto.sha224(buf); break;
        case 'sha256':    result = crypto.sha256(buf); break;
        case 'sha384':    result = crypto.sha384(buf); break;
        case 'sha512':    result = crypto.sha512(buf); break;
        case 'sha3224':   result = crypto.sha3_224(buf); break;
        case 'sha3256':   result = crypto.sha3_256(buf); break;
        case 'sha3384':   result = crypto.sha3_384(buf); break;
        case 'sha3512':   result = crypto.sha3_512(buf); break;
        default: throw new Error(`Unsupported hash algorithm: ${algorithm}`);
    }

    return encodeOutput(result, outputEncoding);
}

// createHmac

export function createHmac(algorithm: string, key: ArrayBuffer | Uint8Array | string): Hmac {
    const keyBuf = toBuffer(key);
    const a = normalizeHashAlgorithm(algorithm);

    if (a === 'md5' || a === 'sha1') {
        return createOneShotHmac(algorithm, keyBuf);
    }

    let hmacObj: CModuleCrypto.Hmac;
    switch (a) {
        case 'sha256':
            hmacObj = crypto.createHmacSha256(keyBuf);
            break;
        case 'sha512':
            hmacObj = crypto.createHmacSha512(keyBuf);
            break;
        default:
            throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
    }

    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            hmacObj.update(toBuffer(input, encoding));
            return this;
        },
        digest(encoding?: string) {
            const result = hmacObj.digest();
            return encodeOutput(result, encoding);
        },
    };
}

// hmac - one-shot HMAC

export function hmac(algorithm: string, key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string, outputEncoding?: string): ArrayBuffer | string {
    const keyBuf = toBuffer(key);
    const dataBuf = toBuffer(data);
    const result = oneShotHmac(algorithm, keyBuf, dataBuf);
    return encodeOutput(result, outputEncoding);
}

export function md5(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.md5(toBuffer(data));
}

export function sha1(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha1(toBuffer(data));
}

export function sha224(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha224(toBuffer(data));
}

export function sha256(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha256(toBuffer(data));
}

export function sha384(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha384(toBuffer(data));
}

export function sha512(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha512(toBuffer(data));
}

export function sha3_224(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha3_224(toBuffer(data));
}

export function sha3_256(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha3_256(toBuffer(data));
}

export function sha3_384(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha3_384(toBuffer(data));
}

export function sha3_512(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha3_512(toBuffer(data));
}

export function createMd5(): CModuleCrypto.Hash {
    return crypto.createMd5();
}

export function createSha1(): CModuleCrypto.Hash {
    return crypto.createSha1();
}

export function createSha256(): CModuleCrypto.Hash {
    return crypto.createSha256();
}

export function createSha512(): CModuleCrypto.Hash {
    return crypto.createSha512();
}

export function hmacMd5(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacMd5(toBuffer(key), toBuffer(data));
}

export function hmacSha1(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha1(toBuffer(key), toBuffer(data));
}

export function hmacSha256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha256(toBuffer(key), toBuffer(data));
}

export function hmacSha512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha512(toBuffer(key), toBuffer(data));
}

export function createHmacSha256(key: ArrayBuffer | Uint8Array | string): CModuleCrypto.Hmac {
    return crypto.createHmacSha256(toBuffer(key));
}

export function createHmacSha512(key: ArrayBuffer | Uint8Array | string): CModuleCrypto.Hmac {
    return crypto.createHmacSha512(toBuffer(key));
}

// createCipher / createDecipher

export function createCipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array): Cipheriv {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const a = algorithm.toLowerCase();

    if (isGcmAlgorithm(a)) {
        return createCipherivGCM(a, keyBuf, ivBuf) as unknown as Cipheriv;
    }

    // CBC: use one-shot functions so setAutoPadding() is a simple flag toggle
    // and never needs to recreate the cipher mid-stream (which would discard data).

    if (a === 'aes-128-cbc') {
        // aes-128 path is handled fully above via buffered helpers
        let noPad = false;
        const chunks: Uint8Array[] = [];
        const obj = {
            update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
                chunks.push(toBuffer(data, inputEncoding));
                return encodeOutput(new ArrayBuffer(0), outputEncoding);
            },
            final(outputEncoding?: string) {
                const fn = noPad ? crypto.aes128CbcEncryptRaw : crypto.aes128CbcEncrypt;
                return encodeOutput(fn(keyBuf, ivBuf, concatBuffers(chunks)), outputEncoding);
            },
            setAutoPadding(v: boolean) { noPad = !v; },
        };
        return obj as unknown as Cipheriv;
    }

    // CBC: buffer all chunks and encrypt at final() so setAutoPadding() never
    // needs to recreate the cipher mid-stream (which would discard buffered data).
    if (a !== 'aes-192-cbc' && a !== 'aes-256-cbc') throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    let autoPadding = true;
    const chunks: Uint8Array[] = [];
    const result = {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            return encodeOutput(new ArrayBuffer(0), outputEncoding);
        },
        final(outputEncoding?: string) {
            const cipher = autoPadding
                ? (a === 'aes-192-cbc' ? crypto.aes192CbcEncrypt : crypto.aes256CbcEncrypt)
                : (a === 'aes-192-cbc' ? crypto.aes192CbcEncryptRaw : crypto.aes256CbcEncryptRaw);
            return encodeOutput(cipher(keyBuf, ivBuf, concatBuffers(chunks)), outputEncoding);
        },
        setAutoPadding(v: boolean) { autoPadding = v; },
    };
    return result as unknown as Cipheriv;
}

export function createDecipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array): Decipheriv {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const a = algorithm.toLowerCase();

    if (isGcmAlgorithm(a)) {
        return createDecipherivGCM(a, keyBuf, ivBuf) as unknown as Decipheriv;
    }

    if (a === 'aes-128-cbc') {
        let noPad = false;
        const chunks: Uint8Array[] = [];
        return {
            update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
                chunks.push(toBuffer(data, inputEncoding));
                return encodeOutput(new ArrayBuffer(0), outputEncoding);
            },
            final(outputEncoding?: string) {
                const fn = noPad ? crypto.aes128CbcDecryptRaw : crypto.aes128CbcDecrypt;
                return encodeOutput(fn(keyBuf, ivBuf, concatBuffers(chunks)), outputEncoding);
            },
            setAutoPadding(v: boolean) { noPad = !v; },
        } as unknown as Decipheriv;
    }

    if (a !== 'aes-192-cbc' && a !== 'aes-256-cbc') throw new Error(`Unsupported cipher algorithm: ${algorithm}`);

    // CBC: buffer all chunks and decrypt at final() so setAutoPadding() never
    // needs to recreate the decipher mid-stream (which would discard buffered data).
    let autoPadding = true;
    const chunks: Uint8Array[] = [];
    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            return encodeOutput(new ArrayBuffer(0), outputEncoding);
        },
        final(outputEncoding?: string) {
            const decipher = autoPadding
                ? (a === 'aes-192-cbc' ? crypto.aes192CbcDecrypt : crypto.aes256CbcDecrypt)
                : (a === 'aes-192-cbc' ? crypto.aes192CbcDecryptRaw : (crypto as any).aes256CbcDecryptRaw);
            return encodeOutput(decipher(keyBuf, ivBuf, concatBuffers(chunks)), outputEncoding);
        },
        setAutoPadding(v: boolean) { autoPadding = v; },
    } as unknown as Decipheriv;
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

export function createCipherivGCM(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, options?: { authTagLength?: number }): CipherGCM {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    if (!isGcmAlgorithm(algorithm)) {
        throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    }
    const gcm = new crypto.GCM('encrypt', keyBuf.buffer as ArrayBuffer, ivBuf.buffer as ArrayBuffer);
    let ctag: ArrayBuffer | undefined;

    return {
        setAAD(aad: ArrayBuffer | Uint8Array) {
            gcm.setAAD(toBuffer(aad).buffer as ArrayBuffer);
            return this;
        },
        update(data: ArrayBuffer | Uint8Array | string, inputEncoding?: string, outputEncoding?: string) {
            const result = gcm.update(toBuffer(data, inputEncoding).buffer as ArrayBuffer);
            return encodeOutput(result, outputEncoding);
        },
        final(outputEncoding?: string) {
            const { data, tag } = gcm.final();
            // Store tag for getAuthTag
            ctag = tag;
            return encodeOutput(data, outputEncoding);
        },
        getAuthTag() {
            return ctag || new ArrayBuffer(0);
        },
    };
}

export function createDecipherivGCM(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, options?: { authTagLength?: number }): DecipherGCM {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    if (!isGcmAlgorithm(algorithm)) {
        throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    }
    const gcm = new crypto.GCM('decrypt', keyBuf.buffer as ArrayBuffer, ivBuf.buffer as ArrayBuffer);
    let authTag: ArrayBuffer | null = null;

    return {
        setAAD(aad: ArrayBuffer | Uint8Array) {
            gcm.setAAD(toBuffer(aad).buffer as ArrayBuffer);
            return this;
        },
        setAuthTag(tag: ArrayBuffer | Uint8Array) {
            authTag = toBuffer(tag).buffer as ArrayBuffer;
            return this;
        },
        update(data: ArrayBuffer | Uint8Array | string, inputEncoding?: string, outputEncoding?: string) {
            const result = gcm.update(toBuffer(data, inputEncoding).buffer as ArrayBuffer);
            return encodeOutput(result, outputEncoding);
        },
        final(outputEncoding?: string) {
            if (!authTag) {
                throw new Error('authTag not set - call setAuthTag() before final()');
            }
            const result = gcm.final(authTag);
            if (!result.verified) {
                throw new Error('Unsupported state or unable to authenticate data');
            }
            return encodeOutput(result.data, outputEncoding);
        },
    };
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

export function cipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, outputEncoding?: string): ArrayBuffer | string {
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

export function decipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, outputEncoding?: string): ArrayBuffer | string {
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

// randomBytes

export function randomBytes(size: number): Uint8Array;
export function randomBytes(size: number, callback: (err: Error | null, buf: Uint8Array) => void): void;
export function randomBytes(size: number, callback?: (err: Error | null, buf: Uint8Array) => void): Uint8Array | void {
    if (callback) {
        try {
            const result = new Uint8Array(crypto.randomBytes(size));
            callback(null, result);
        } catch (err) {
            callback(err as Error, new Uint8Array(0));
        }
        return;
    }
    return new Uint8Array(crypto.randomBytes(size));
}

export function timingSafeEqual(a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer): boolean {
    const left = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (left.byteLength !== right.byteLength) {
        throw new RangeError('Input buffers must have the same byte length');
    }

    let diff = 0;
    for (let i = 0; i < left.byteLength; i++) {
        diff |= left[i]! ^ right[i]!;
    }
    return diff === 0;
}

// Web Crypto API compat (Node.js 17+)
export function getRandomValues<T extends ArrayBufferView>(array: T): T {
    const bytes = crypto.randomBytes(array.byteLength);
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(new Uint8Array(bytes));
    return array;
}
// Re-export random/kdf/hkdf from random.ts
export { randomInt, randomFill, randomFillSync, pbkdf2, pbkdf2Sync, pbkdf2Sha256, pbkdf2Sha512, hkdf, hkdfSync, hkdfSha256, hkdfSha512 } from './random';

// RSA

export function generateKeyPairSync(type: 'rsa', options: { modulusLength: number }): { publicKey: ArrayBuffer; privateKey: ArrayBuffer };
export function generateKeyPairSync(type: 'ec', options: { namedCurve: string }): { publicKey: ArrayBuffer; privateKey: ArrayBuffer };
export function generateKeyPairSync(type: string, options: any): { publicKey: ArrayBuffer; privateKey: ArrayBuffer } {
    if (type === 'rsa') {
        const keyPair = crypto.generateRsaKey(options.modulusLength || 2048);
        return {
            publicKey: keyPair.publicKey,
            privateKey: keyPair.privateKey,
        };
    }

    if (type === 'ec') {
        const curve = resolveCurve(options.namedCurve || '');
        let keyPair: CModuleCrypto.EcKeyPair;

        switch (curve) {
            case 'p256': keyPair = crypto.generateEcKeyP256(); break;
            case 'p384': keyPair = crypto.generateEcKeyP384(); break;
            case 'p521': keyPair = crypto.generateEcKeyP521(); break;
        }

        return {
            publicKey: keyPair.publicKey,
            privateKey: keyPair.privateKey,
        };
    }

    throw new Error(`Unsupported key type: ${type}`);
}

export function generateKeyPair(type: 'rsa', options: { modulusLength: number }, callback: (err: Error | null, result: { publicKey: ArrayBuffer; privateKey: ArrayBuffer }) => void): void;
export function generateKeyPair(type: 'ec', options: { namedCurve: string }, callback: (err: Error | null, result: { publicKey: ArrayBuffer; privateKey: ArrayBuffer }) => void): void;
export function generateKeyPair(type: string, options: any, callback: (err: Error | null, result: { publicKey: ArrayBuffer; privateKey: ArrayBuffer }) => void): void {
    try {
        const result = generateKeyPairSync(type as any, options);
        callback(null, result);
    } catch (err) {
        callback(err as Error, { publicKey: new ArrayBuffer(0), privateKey: new ArrayBuffer(0) });
    }
}

// sign / verify

export function createSign(algorithm: string): Sign {
    let data: Uint8Array[] = [];

    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            data.push(toBuffer(input, encoding));
            return this;
        },
        sign(privateKey: ArrayBuffer | Uint8Array, outputEncoding?: string) {
            const keyBuf = toBuffer(privateKey);
            const allData = concatBuffers(data);
            data = [];

            let result: ArrayBuffer;
            switch (algorithm.toLowerCase()) {
                case 'rsa-sha256':
                case 'sha256':
                    result = crypto.signSha256(keyBuf, allData);
                    break;
                case 'rsa-sha512':
                case 'sha512':
                    result = crypto.signSha512(keyBuf, allData);
                    break;
                default:
                    throw new Error(`Unsupported sign algorithm: ${algorithm}`);
            }

            return encodeOutput(result, outputEncoding);
        },
    };
}

export function createVerify(algorithm: string): Verify {
    let data: Uint8Array[] = [];

    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            data.push(toBuffer(input, encoding));
            return this;
        },
        verify(publicKey: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array, signatureEncoding?: string) {
            const keyBuf = toBuffer(publicKey);
            const sigBuf = toBuffer(signature);
            const allData = concatBuffers(data);
            data = [];

            switch (algorithm.toLowerCase()) {
                case 'rsa-sha256':
                case 'sha256':
                    return crypto.verifySha256(keyBuf, allData, sigBuf);
                case 'rsa-sha512':
                case 'sha512':
                    return crypto.verifySha512(keyBuf, allData, sigBuf);
                default:
                    throw new Error(`Unsupported verify algorithm: ${algorithm}`);
            }
        },
    };
}

export function sign(algorithm: string, data: ArrayBuffer | Uint8Array, key: ArrayBuffer | Uint8Array): ArrayBuffer {
    const dataBuf = toBuffer(data);
    const keyBuf = toBuffer(key);

    switch (algorithm.toLowerCase()) {
        case 'rsa-sha256':
        case 'sha256':
            return crypto.signSha256(keyBuf, dataBuf);
        case 'rsa-sha512':
        case 'sha512':
            return crypto.signSha512(keyBuf, dataBuf);
        default:
            throw new Error(`Unsupported sign algorithm: ${algorithm}`);
    }
}

export function generateRsaKey(bits?: number): CModuleCrypto.RsaKeyPair {
    return crypto.generateRsaKey(bits);
}

export function signSha256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha256(toBuffer(key), toBuffer(data));
}

export function signSha512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha512(toBuffer(key), toBuffer(data));
}

export function verify(algorithm: string, data: ArrayBuffer | Uint8Array, key: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array): boolean {
    const dataBuf = toBuffer(data);
    const keyBuf = toBuffer(key);
    const sigBuf = toBuffer(signature);

    switch (algorithm.toLowerCase()) {
        case 'rsa-sha256':
        case 'sha256':
            return crypto.verifySha256(keyBuf, dataBuf, sigBuf);
        case 'rsa-sha512':
        case 'sha512':
            return crypto.verifySha512(keyBuf, dataBuf, sigBuf);
        default:
            throw new Error(`Unsupported verify algorithm: ${algorithm}`);
    }
}

export function verifySha256(
    key: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.verifySha256(toBuffer(key), toBuffer(data), toBuffer(signature));
}

export function verifySha512(
    key: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.verifySha512(toBuffer(key), toBuffer(data), toBuffer(signature));
}

// ECDSA

export function ecdsaSign(curve: string, privateKey: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array): ArrayBuffer {
    const keyBuf = toBuffer(privateKey);
    const dataBuf = toBuffer(data);

    const c = resolveCurve(curve);
    switch (c) {
        case 'p256': return crypto.ecdsaSignP256(keyBuf, dataBuf);
        case 'p384': return crypto.ecdsaSignP384(keyBuf, dataBuf);
        case 'p521': return crypto.ecdsaSignP521(keyBuf, dataBuf);
    }
}

export function ecdsaVerify(curve: string, publicKey: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array): boolean {
    const keyBuf = toBuffer(publicKey);
    const dataBuf = toBuffer(data);
    const sigBuf = toBuffer(signature);

    const c = resolveCurve(curve);
    switch (c) {
        case 'p256': return crypto.ecdsaVerifyP256(keyBuf, dataBuf, sigBuf);
        case 'p384': return crypto.ecdsaVerifyP384(keyBuf, dataBuf, sigBuf);
        case 'p521': return crypto.ecdsaVerifyP521(keyBuf, dataBuf, sigBuf);
    }
}

// ECDH

export function ecdhComputeSecret(curve: string, privateKey: ArrayBuffer | Uint8Array, publicKey: ArrayBuffer | Uint8Array): ArrayBuffer {
    const privBuf = toBuffer(privateKey);
    const pubBuf = toBuffer(publicKey);

    const c = resolveCurve(curve);
    switch (c) {
        case 'p256': return crypto.ecdhDeriveP256(privBuf, pubBuf);
        case 'p384': return crypto.ecdhDeriveP384(privBuf, pubBuf);
        case 'p521': return crypto.ecdhDeriveP521(privBuf, pubBuf);
    }
}

export function generateEcKeyP256(): CModuleCrypto.EcKeyPair {
    return crypto.generateEcKeyP256();
}

export function generateEcKeyP384(): CModuleCrypto.EcKeyPair {
    return crypto.generateEcKeyP384();
}

export function generateEcKeyP521(): CModuleCrypto.EcKeyPair {
    return crypto.generateEcKeyP521();
}

export function ecdsaSignP256(privateKey: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.ecdsaSignP256(toBuffer(privateKey), toBuffer(data));
}

export function ecdsaSignP384(privateKey: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.ecdsaSignP384(toBuffer(privateKey), toBuffer(data));
}

export function ecdsaSignP521(privateKey: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.ecdsaSignP521(toBuffer(privateKey), toBuffer(data));
}

export function ecdsaVerifyP256(
    publicKey: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.ecdsaVerifyP256(toBuffer(publicKey), toBuffer(data), toBuffer(signature));
}

export function ecdsaVerifyP384(
    publicKey: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.ecdsaVerifyP384(toBuffer(publicKey), toBuffer(data), toBuffer(signature));
}

export function ecdsaVerifyP521(
    publicKey: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.ecdsaVerifyP521(toBuffer(publicKey), toBuffer(data), toBuffer(signature));
}

export function ecdhDeriveP256(
    privateKey: ArrayBuffer | Uint8Array | string,
    publicKey: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.ecdhDeriveP256(toBuffer(privateKey), toBuffer(publicKey));
}

export function ecdhDeriveP384(
    privateKey: ArrayBuffer | Uint8Array | string,
    publicKey: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.ecdhDeriveP384(toBuffer(privateKey), toBuffer(publicKey));
}

export function ecdhDeriveP521(
    privateKey: ArrayBuffer | Uint8Array | string,
    publicKey: ArrayBuffer | Uint8Array | string,
): ArrayBuffer {
    return crypto.ecdhDeriveP521(toBuffer(privateKey), toBuffer(publicKey));
}

// RSA-OAEP

export function publicEncrypt(
    key: ArrayBuffer | Uint8Array | { key: ArrayBuffer | Uint8Array; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
): ArrayBuffer {
    const args = readAsymmetricCipherArgs(key, data);
    switch (args.oaepHash) {
        case 'sha256':
            return crypto.rsaOaepSha256Encrypt(args.key, args.data, args.oaepLabel);
        case 'sha512':
            return crypto.rsaOaepSha512Encrypt(args.key, args.data, args.oaepLabel);
        default:
            throw new Error(`Unsupported OAEP hash algorithm: ${args.oaepHash}`);
    }
}

export function privateDecrypt(
    key: ArrayBuffer | Uint8Array | { key: ArrayBuffer | Uint8Array; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
): ArrayBuffer {
    const args = readAsymmetricCipherArgs(key, data);
    switch (args.oaepHash) {
        case 'sha256':
            return crypto.rsaOaepSha256Decrypt(args.key, args.data, args.oaepLabel);
        case 'sha512':
            return crypto.rsaOaepSha512Decrypt(args.key, args.data, args.oaepLabel);
        default:
            throw new Error(`Unsupported OAEP hash algorithm: ${args.oaepHash}`);
    }
}

export function rsaOaepSha256Encrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, label?: ArrayBuffer | Uint8Array): ArrayBuffer {
    return crypto.rsaOaepSha256Encrypt(toBuffer(key), toBuffer(data), label ? toBuffer(label) : undefined);
}

export function rsaOaepSha256Decrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, label?: ArrayBuffer | Uint8Array): ArrayBuffer {
    return crypto.rsaOaepSha256Decrypt(toBuffer(key), toBuffer(data), label ? toBuffer(label) : undefined);
}

export function rsaOaepSha512Encrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, label?: ArrayBuffer | Uint8Array): ArrayBuffer {
    return crypto.rsaOaepSha512Encrypt(toBuffer(key), toBuffer(data), label ? toBuffer(label) : undefined);
}

export function rsaOaepSha512Decrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, label?: ArrayBuffer | Uint8Array): ArrayBuffer {
    return crypto.rsaOaepSha512Decrypt(toBuffer(key), toBuffer(data), label ? toBuffer(label) : undefined);
}

export function rsaPssSha256Sign(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, saltLength?: number): ArrayBuffer {
    return crypto.rsaPssSha256Sign(toBuffer(key), toBuffer(data), saltLength);
}

export function rsaPssSha256Verify(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array, saltLength?: number): boolean {
    return crypto.rsaPssSha256Verify(toBuffer(key), toBuffer(data), toBuffer(signature), saltLength);
}

// CRC32

export function crc32(data: ArrayBuffer | Uint8Array | string): number {
    return crypto.crc32(toBuffer(data));
}

export function base64Encode(data: ArrayBuffer | Uint8Array | string): string {
    return crypto.base64Encode(toBuffer(data));
}

export function base64Decode(data: string): ArrayBuffer {
    return crypto.base64Decode(data);
}

export function hexEncode(data: ArrayBuffer | Uint8Array | string): string {
    return crypto.hexEncode(toBuffer(data));
}

export function hexDecode(data: string): ArrayBuffer {
    return crypto.hexDecode(data);
}

// Encoding utilities

export const constants = {
    RSA_PKCS1_PADDING: 1,
    RSA_NO_PADDING: 3,
    RSA_PKCS1_OAEP_PADDING: 4,
};

// Algorithm enumeration (feature-detection probes)

// Only algorithms actually backed by the native crypto module are listed, so
// getHashes()/getCiphers() reflect what createHash/createCipheriv can build.
export function getHashes(): string[] {
    return ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512'];
}

export function getCiphers(): string[] {
    return ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'];
}

// UUID

export function randomUUID(): string {
    // Node's crypto.randomUUID() is synchronous and returns a string. The native
    // crypto.randomUUID() returns a Promise, so building the v4 UUID directly from
    // random bytes avoids handing callers "[object Promise]" as an id.
    const b = new Uint8Array(crypto.randomBytes(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx (RFC 4122)
    const h: string[] = [];
    for (let i = 0; i < 16; i++) h.push(b[i]!.toString(16).padStart(2, '0'));
    return (
        h.slice(0, 4).join('') + '-' +
        h.slice(4, 6).join('') + '-' +
        h.slice(6, 8).join('') + '-' +
        h.slice(8, 10).join('') + '-' +
        h.slice(10, 16).join('')
    );
}

// Web Crypto API — re-export runtime globals so code that imports
// `crypto.webcrypto` or `crypto.subtle` gets the real implementation.
export const webcrypto: Crypto = (globalThis as any).crypto ?? {} as Crypto;
export const subtle: SubtleCrypto = webcrypto.subtle ?? {} as SubtleCrypto;
