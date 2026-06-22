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

export interface GcmEncryptResult {
    ciphertext: ArrayBuffer;
    tag: ArrayBuffer;
}

export interface GcmDecryptResult {
    plaintext: ArrayBuffer;
    verified: boolean;
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

function concatBuffers(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function createBufferedCipher(
    transform: (data: Uint8Array) => ArrayBuffer,
): Cipheriv {
    const chunks: Uint8Array[] = [];
    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            return encodeOutput(new ArrayBuffer(0), outputEncoding);
        },
        final(outputEncoding?: string) {
            return encodeOutput(transform(concatBuffers(chunks)), outputEncoding);
        },
    };
}

function createBufferedDecipher(
    transform: (data: Uint8Array) => ArrayBuffer,
): Decipheriv {
    const chunks: Uint8Array[] = [];
    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            return encodeOutput(new ArrayBuffer(0), outputEncoding);
        },
        final(outputEncoding?: string) {
            return encodeOutput(transform(concatBuffers(chunks)), outputEncoding);
        },
    };
}

function isGcmAlgorithm(algorithm: string): boolean {
    const a = algorithm.toLowerCase();
    return a === 'aes-128-gcm' || a === 'aes-192-gcm' || a === 'aes-256-gcm';
}

function normalizeHashAlgorithm(algorithm: string): string {
    return algorithm.toLowerCase().replace(/-/g, '');
}

function oneShotHmac(algorithm: string, key: Uint8Array, data: Uint8Array): ArrayBuffer {
    switch (normalizeHashAlgorithm(algorithm)) {
        case 'md5':
            return crypto.hmacMd5(key, data);
        case 'sha1':
            return crypto.hmacSha1(key, data);
        case 'sha256':
            return crypto.hmacSha256(key, data);
        case 'sha512':
            return crypto.hmacSha512(key, data);
        default:
            throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
    }
}

function createOneShotHmac(algorithm: string, key: Uint8Array): Hmac {
    const chunks: Uint8Array[] = [];
    return {
        update(input: BinaryInput, encoding?: string) {
            chunks.push(toBuffer(input, encoding));
            return this;
        },
        digest(encoding?: string) {
            const result = oneShotHmac(algorithm, key, concatBuffers(chunks));
            return encodeOutput(result, encoding);
        },
    };
}

function readAsymmetricCipherArgs(
    keyOrOptions: ArrayBuffer | Uint8Array | { key: ArrayBuffer | Uint8Array; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
) {
    if (keyOrOptions instanceof ArrayBuffer || keyOrOptions instanceof Uint8Array) {
        return {
            key: toBuffer(keyOrOptions),
            data: toBuffer(data),
            oaepHash: 'sha256',
            oaepLabel: undefined as Uint8Array | undefined,
        };
    }

    return {
        key: toBuffer(keyOrOptions.key),
        data: toBuffer(data),
        oaepHash: keyOrOptions.oaepHash?.toLowerCase() || 'sha256',
        oaepLabel: keyOrOptions.oaepLabel ? toBuffer(keyOrOptions.oaepLabel) : undefined,
    };
}

// ============================================================================
// createHash
// ============================================================================

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

// ============================================================================
// hash - one-shot hash
// ============================================================================

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

// ============================================================================
// createHmac
// ============================================================================

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

// ============================================================================
// hmac - one-shot HMAC
// ============================================================================

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

// ============================================================================
// createCipher / createDecipher
// ============================================================================

export function createCipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array): Cipheriv {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const a = algorithm.toLowerCase();

    if (isGcmAlgorithm(a)) {
        return createCipherivGCM(a, keyBuf, ivBuf) as unknown as Cipheriv;
    }

    // CBC: use streaming cipher so we can honour setAutoPadding().
    // The `Raw` variants (no PKCS7 padding) are swapped in when padding is disabled.
    let cipherObj: CModuleCrypto.Cipher | null = null;
    let autoPadding = true;

    const makeCipher = (withPadding: boolean) => {
        if (a === 'aes-128-cbc') {
            // aes-128 only has buffered one-shot in C; re-create via raw variant when needed.
            if (!withPadding) {
                const chunks: Uint8Array[] = [];
                const obj = {
                    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
                        chunks.push(toBuffer(data, inputEncoding));
                        return encodeOutput(new ArrayBuffer(0), outputEncoding);
                    },
                    final(outputEncoding?: string) {
                        return encodeOutput(crypto.aes128CbcEncryptRaw(keyBuf, ivBuf, concatBuffers(chunks)), outputEncoding);
                    },
                    setAutoPadding(_: boolean) { /* already locked */ },
                };
                return obj as unknown as Cipheriv;
            }
            return createBufferedCipher((data) => crypto.aes128CbcEncrypt(keyBuf, ivBuf, data));
        }
        if (a === 'aes-192-cbc') {
            return withPadding ? crypto.createCipherAes192Cbc(keyBuf, ivBuf) : crypto.createCipherAes192CbcRaw(keyBuf, ivBuf);
        }
        if (a === 'aes-256-cbc') {
            return withPadding ? crypto.createCipherAes256Cbc(keyBuf, ivBuf) : crypto.createCipherAes256CbcRaw(keyBuf, ivBuf);
        }
        return null;
    };

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

    cipherObj = makeCipher(true) as unknown as CModuleCrypto.Cipher;
    const result = {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            if (!cipherObj) return encodeOutput(new ArrayBuffer(0), outputEncoding);
            return encodeOutput(cipherObj.update(toBuffer(data, inputEncoding)), outputEncoding);
        },
        final(outputEncoding?: string) {
            if (!cipherObj) return encodeOutput(new ArrayBuffer(0), outputEncoding);
            return encodeOutput(cipherObj.final(), outputEncoding);
        },
        setAutoPadding(v: boolean) {
            if (v === autoPadding) return;
            autoPadding = v;
            cipherObj = makeCipher(v) as unknown as CModuleCrypto.Cipher;
        },
    };
    if (a !== 'aes-192-cbc' && a !== 'aes-256-cbc') throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
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

    const makeDecipher = (withPadding: boolean): CModuleCrypto.Cipher => {
        if (a === 'aes-192-cbc')
            return withPadding ? crypto.createDecipherAes192Cbc(keyBuf, ivBuf) : crypto.createDecipherAes192CbcRaw(keyBuf, ivBuf);
        // aes-256-cbc
        return withPadding ? crypto.createDecipherAes256Cbc(keyBuf, ivBuf) : crypto.createDecipherAes256CbcRaw(keyBuf, ivBuf);
    };

    if (a !== 'aes-192-cbc' && a !== 'aes-256-cbc') throw new Error(`Unsupported cipher algorithm: ${algorithm}`);

    let autoPadding = true;
    let decipherObj = makeDecipher(true);
    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            return encodeOutput(decipherObj.update(toBuffer(data, inputEncoding)), outputEncoding);
        },
        final(outputEncoding?: string) {
            return encodeOutput(decipherObj.final(), outputEncoding);
        },
        setAutoPadding(v: boolean) {
            if (v === autoPadding) return;
            autoPadding = v;
            decipherObj = makeDecipher(v);
        },
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

// ============================================================================
// createCipheriv GCM
// ============================================================================

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
        case 'sha256':
            return crypto.verifySha256(keyBuf, dataBuf, sigBuf);
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

// ============================================================================
// RSA-OAEP
// ============================================================================

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

// ============================================================================
// CRC32
// ============================================================================

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
