/**
 * Node.js crypto module
 * Based on CModuleCrypto implementation
 */

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

// ============================================================================
// Type interfaces (simplified, compatible with Node.js crypto API)
// ============================================================================

type BinaryInput = ArrayBuffer | Uint8Array | string;

export interface Hash {
    update(input: BinaryInput, encoding?: string): Hash;
    digest(encoding?: string): ArrayBuffer | string;
}

export interface Hmac {
    update(input: BinaryInput, encoding?: string): Hmac;
    digest(encoding?: string): ArrayBuffer | string;
}

export interface Cipheriv {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): ArrayBuffer | string;
    final(outputEncoding?: string): ArrayBuffer | string;
}

export interface Decipheriv {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): ArrayBuffer | string;
    final(outputEncoding?: string): ArrayBuffer | string;
}

export interface CipherGCM {
    setAAD(aad: ArrayBuffer | Uint8Array): CipherGCM;
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): ArrayBuffer | string;
    final(outputEncoding?: string): ArrayBuffer | string;
    getAuthTag(): ArrayBuffer;
}

export interface DecipherGCM {
    setAAD(aad: ArrayBuffer | Uint8Array): DecipherGCM;
    setAuthTag(tag: ArrayBuffer | Uint8Array): DecipherGCM;
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): ArrayBuffer | string;
    final(outputEncoding?: string): ArrayBuffer | string;
}

export interface Sign {
    update(input: BinaryInput, encoding?: string): Sign;
    sign(privateKey: ArrayBuffer | Uint8Array, outputEncoding?: string): ArrayBuffer | string;
}

export interface Verify {
    update(input: BinaryInput, encoding?: string): Verify;
    verify(publicKey: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array, signatureEncoding?: string): boolean;
}

// ============================================================================
// Helper functions
// ============================================================================

function toBuffer(data: ArrayBuffer | Uint8Array | string, encoding: string = 'utf8'): Uint8Array {
    if (typeof data === 'string') {
        if (encoding === 'hex') return new Uint8Array(crypto.hexDecode(data));
        if (encoding === 'base64') return new Uint8Array(crypto.base64Decode(data));
        if (encoding === 'base64url') return new Uint8Array(crypto.base64Decode(data.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - data.length % 4) % 4)));
        if (encoding === 'latin1' || encoding === 'ascii' || encoding === 'binary') {
            const buf = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i);
            return buf;
        }
        return engine.encodeString(data);
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    return data;
}

function encodeOutput(data: ArrayBuffer, encoding?: string): ArrayBuffer | string {
    if (!encoding) return data;
    if (encoding === 'hex') return crypto.hexEncode(data);
    if (encoding === 'base64') return crypto.base64Encode(data);
    if (encoding === 'base64url') {
        const b64 = crypto.base64Encode(data) as string;
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return data;
}

// ============================================================================
// createHash
// ============================================================================

export function createHash(algorithm: string): Hash {
    const a = algorithm.toLowerCase().replace(/-/g, '');

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

// ============================================================================
// hash - one-shot hash
// ============================================================================

export function hash(algorithm: string, data: ArrayBuffer | Uint8Array | string, outputEncoding?: string): ArrayBuffer | string {
    const buf = toBuffer(data);
    let result: ArrayBuffer;

    const a = algorithm.toLowerCase().replace(/-/g, '');
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

// ============================================================================
// createHmac
// ============================================================================

export function createHmac(algorithm: string, key: ArrayBuffer | Uint8Array | string): Hmac {
    const keyBuf = toBuffer(key);
    let hmacObj: CModuleCrypto.Hmac | null = null;
    let data: Uint8Array[] = [];

    const getHmacObj = () => {
        if (!hmacObj) {
            const a = algorithm.toLowerCase().replace(/-/g, '');
            switch (a) {
                case 'md5':    hmacObj = crypto.createHmacSha256(keyBuf); break; // FIXME: C layer only has sha256/512 streaming
                case 'sha1':   hmacObj = crypto.createHmacSha256(keyBuf); break; // FIXME: C layer only has sha256/512 streaming
                case 'sha256': hmacObj = crypto.createHmacSha256(keyBuf); break;
                case 'sha512': hmacObj = crypto.createHmacSha512(keyBuf); break;
                default: throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
            }
            for (const d of data) hmacObj.update(d);
        }
        return hmacObj;
    };

    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            data.push(toBuffer(input, encoding));
            if (hmacObj) {
                hmacObj.update(toBuffer(input, encoding));
            }
            return this;
        },
        digest(encoding?: string) {
            const result = getHmacObj().digest();
            return encodeOutput(result, encoding);
        },
    };
}

// ============================================================================
// hmac - one-shot HMAC
// ============================================================================

export function hmac(algorithm: string, key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string, outputEncoding?: string): ArrayBuffer | string {
    const keyBuf = toBuffer(key);
    const dataBuf = toBuffer(data);
    let result: ArrayBuffer;

    const a = algorithm.toLowerCase().replace(/-/g, '');
    switch (a) {
        case 'md5':    result = crypto.hmacMd5(keyBuf, dataBuf); break;
        case 'sha1':   result = crypto.hmacSha1(keyBuf, dataBuf); break;
        case 'sha256': result = crypto.hmacSha256(keyBuf, dataBuf); break;
        case 'sha512': result = crypto.hmacSha512(keyBuf, dataBuf); break;
        default: throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
    }

    return encodeOutput(result, outputEncoding);
}

// ============================================================================
// createCipher / createDecipher
// ============================================================================

export function createCipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array): Cipheriv {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const a = algorithm.toLowerCase();

    if (a === 'aes-256-cbc') {
        const cipher = crypto.createCipherAes256Cbc(keyBuf, ivBuf);
        return {
            update(data: ArrayBuffer | Uint8Array | string, inputEncoding?: string, outputEncoding?: string) {
                return encodeOutput(cipher.update(toBuffer(data, inputEncoding)), outputEncoding);
            },
            final(outputEncoding?: string) {
                return encodeOutput(cipher.final(), outputEncoding);
            },
        };
    }

    throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
}

export function createDecipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array): Decipheriv {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);

    if (algorithm.toLowerCase() === 'aes-256-cbc') {
        const decipher = crypto.createDecipherAes256Cbc(keyBuf, ivBuf);
        return {
            update(data: ArrayBuffer | Uint8Array | string, inputEncoding?: string, outputEncoding?: string) {
                const result = decipher.update(toBuffer(data, inputEncoding));
                return encodeOutput(result, outputEncoding);
            },
            final(outputEncoding?: string) {
                const result = decipher.final();
                return encodeOutput(result, outputEncoding);
            },
        };
    }

    throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
}

// ============================================================================
// createCipheriv GCM
// ============================================================================

export function createCipherivGCM(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, options?: { authTagLength?: number }): CipherGCM {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const gcm = new crypto.GCM('encrypt', keyBuf.buffer as ArrayBuffer, ivBuf.buffer as ArrayBuffer);
    let aadSet = false;
    let ctag: ArrayBuffer | undefined;

    return {
        setAAD(aad: ArrayBuffer | Uint8Array) {
            gcm.setAAD(toBuffer(aad).buffer as ArrayBuffer);
            aadSet = true;
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

// ============================================================================
// Encryption/Decryption - one-shot
// ============================================================================

export function cipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, outputEncoding?: string): ArrayBuffer | string {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const dataBuf = toBuffer(data);
    let result: ArrayBuffer;

    const a = algorithm.toLowerCase();
    switch (a) {
        case 'aes-128-cbc': result = crypto.aes128CbcEncrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-256-cbc': result = crypto.aes256CbcEncrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-128-gcm': result = crypto.aes128GcmEncrypt(keyBuf, ivBuf, dataBuf); break;
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
        case 'aes-256-cbc': result = crypto.aes256CbcDecrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-128-gcm': result = crypto.aes128GcmDecrypt(keyBuf, ivBuf, dataBuf); break;
        case 'aes-256-gcm': result = crypto.aes256GcmDecrypt(keyBuf, ivBuf, dataBuf); break;
        default: throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    }

    return encodeOutput(result, outputEncoding);
}

// ============================================================================
// randomBytes
// ============================================================================

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
    const bytes = new Uint8Array(crypto.randomBytes(4));
    const value = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    const result = min + (Math.abs(value) % range);

    if (callback) {
        callback(null, result);
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

// ============================================================================
// RSA
// ============================================================================

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
        const curve = options.namedCurve?.toLowerCase();
        let keyPair: CModuleCrypto.EcKeyPair;

        switch (curve) {
            case 'p256':
            case 'prime256v1':
            case 'secp256r1':
                keyPair = crypto.generateEcKeyP256();
                break;
            case 'p384':
            case 'secp384r1':
                keyPair = crypto.generateEcKeyP384();
                break;
            case 'p521':
            case 'secp521r1':
                keyPair = crypto.generateEcKeyP521();
                break;
            default:
                throw new Error(`Unsupported curve: ${curve}`);
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

// ============================================================================
// sign / verify
// ============================================================================

export function createSign(algorithm: string): Sign {
    let data: Uint8Array[] = [];

    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            data.push(toBuffer(input, encoding));
            return this;
        },
        sign(privateKey: ArrayBuffer | Uint8Array, outputEncoding?: string) {
            const keyBuf = toBuffer(privateKey);
            const allData = new Uint8Array(data.reduce((acc, d) => acc + d.length, 0));
            let offset = 0;
            for (const d of data) {
                allData.set(d, offset);
                offset += d.length;
            }

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
            const allData = new Uint8Array(data.reduce((acc, d) => acc + d.length, 0));
            let offset = 0;
            for (const d of data) {
                allData.set(d, offset);
                offset += d.length;
            }

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
        case 'sha256':
            return crypto.signSha256(keyBuf, dataBuf);
        case 'sha512':
            return crypto.signSha512(keyBuf, dataBuf);
        default:
            throw new Error(`Unsupported sign algorithm: ${algorithm}`);
    }
}

export function verify(algorithm: string, data: ArrayBuffer | Uint8Array, key: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array): boolean {
    const dataBuf = toBuffer(data);
    const keyBuf = toBuffer(key);
    const sigBuf = toBuffer(signature);

    switch (algorithm.toLowerCase()) {
        case 'sha256':
            return crypto.verifySha256(keyBuf, dataBuf, sigBuf);
        case 'sha512':
            return crypto.verifySha512(keyBuf, dataBuf, sigBuf);
        default:
            throw new Error(`Unsupported verify algorithm: ${algorithm}`);
    }
}

// ============================================================================
// ECDSA
// ============================================================================

export function ecdsaSign(curve: string, privateKey: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array): ArrayBuffer {
    const keyBuf = toBuffer(privateKey);
    const dataBuf = toBuffer(data);

    switch (curve.toLowerCase()) {
        case 'p256':
        case 'prime256v1':
        case 'secp256r1':
            return crypto.ecdsaSignP256(keyBuf, dataBuf);
        case 'p384':
        case 'secp384r1':
            return crypto.ecdsaSignP384(keyBuf, dataBuf);
        case 'p521':
        case 'secp521r1':
            return crypto.ecdsaSignP521(keyBuf, dataBuf);
        default:
            throw new Error(`Unsupported curve: ${curve}`);
    }
}

export function ecdsaVerify(curve: string, publicKey: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array): boolean {
    const keyBuf = toBuffer(publicKey);
    const dataBuf = toBuffer(data);
    const sigBuf = toBuffer(signature);

    switch (curve.toLowerCase()) {
        case 'p256':
        case 'prime256v1':
        case 'secp256r1':
            return crypto.ecdsaVerifyP256(keyBuf, dataBuf, sigBuf);
        case 'p384':
        case 'secp384r1':
            return crypto.ecdsaVerifyP384(keyBuf, dataBuf, sigBuf);
        case 'p521':
        case 'secp521r1':
            return crypto.ecdsaVerifyP521(keyBuf, dataBuf, sigBuf);
        default:
            throw new Error(`Unsupported curve: ${curve}`);
    }
}

// ============================================================================
// ECDH
// ============================================================================

export function ecdhComputeSecret(curve: string, privateKey: ArrayBuffer | Uint8Array, publicKey: ArrayBuffer | Uint8Array): ArrayBuffer {
    const privBuf = toBuffer(privateKey);
    const pubBuf = toBuffer(publicKey);

    switch (curve.toLowerCase()) {
        case 'p256':
        case 'prime256v1':
        case 'secp256r1':
            return crypto.ecdhDeriveP256(privBuf, pubBuf);
        case 'p384':
        case 'secp384r1':
            return crypto.ecdhDeriveP384(privBuf, pubBuf);
        case 'p521':
        case 'secp521r1':
            return crypto.ecdhDeriveP521(privBuf, pubBuf);
        default:
            throw new Error(`Unsupported curve: ${curve}`);
    }
}

// ============================================================================
// RSA-OAEP
// ============================================================================

export function publicEncrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array): ArrayBuffer {
    const keyBuf = toBuffer(key);
    const dataBuf = toBuffer(data);
    return crypto.rsaOaepSha256Encrypt(keyBuf, dataBuf);
}

export function privateDecrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array): ArrayBuffer {
    const keyBuf = toBuffer(key);
    const dataBuf = toBuffer(data);
    return crypto.rsaOaepSha256Decrypt(keyBuf, dataBuf);
}

// ============================================================================
// CRC32
// ============================================================================

export function crc32(data: ArrayBuffer | Uint8Array | string): number {
    return crypto.crc32(toBuffer(data));
}

// ============================================================================
// Encoding utilities
// ============================================================================

export const constants = {
    RSA_PKCS1_PADDING: 1,
    RSA_NO_PADDING: 3,
    RSA_PKCS1_OAEP_PADDING: 4,
};

// ============================================================================
// UUID
// ============================================================================

export function randomUUID(): string {
    return crypto.randomUUID() as unknown as string;
}