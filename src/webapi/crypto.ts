/**
 * Web Crypto API (SubtleCrypto) implementation for txiki.js
 * Based on W3C Web Cryptography API specification
 */

const crypto = import.meta.use('crypto');

// ============================================================================
// Type Definitions
// ============================================================================

type BufferSource = ArrayBuffer | ArrayBufferView;
type HashAlgorithmIdentifier = AlgorithmIdentifier | string;
type AlgorithmIdentifier = string | Algorithm;

interface Algorithm {
    name: string;
}

interface KeyAlgorithm {
    name: string;
}

interface RsaHashedKeyAlgorithm extends KeyAlgorithm {
    modulusLength: number;
    publicExponent: Uint8Array;
    hash: KeyAlgorithm;
}

interface EcKeyAlgorithm extends KeyAlgorithm {
    namedCurve: string;
}

interface AesKeyAlgorithm extends KeyAlgorithm {
    length: number;
}

interface HmacKeyAlgorithm extends KeyAlgorithm {
    hash: KeyAlgorithm;
    length: number;
}

type KeyType = 'public' | 'private' | 'secret';
type KeyUsage = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';

interface CryptoKey {
    type: KeyType;
    extractable: boolean;
    algorithm: KeyAlgorithm;
    usages: KeyUsage[];
}

interface CryptoKeyPair {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
}

interface RsaHashedImportParams extends Algorithm {
    hash: HashAlgorithmIdentifier;
}

interface RsaHashedKeyGenParams extends RsaHashedImportParams {
    modulusLength: number;
    publicExponent: Uint8Array;
}

interface EcKeyGenParams extends Algorithm {
    namedCurve: string;
}

interface AesKeyGenParams extends Algorithm {
    length: number;
}

interface HmacKeyGenParams extends Algorithm {
    hash: HashAlgorithmIdentifier;
    length?: number;
}

interface RsaOaepParams extends Algorithm {
    label?: BufferSource;
}

interface RsaPssParams extends Algorithm {
    saltLength: number;
}

interface EcdsaParams extends Algorithm {
    hash: HashAlgorithmIdentifier;
}

interface AesCbcParams extends Algorithm {
    iv: BufferSource;
}

interface AesGcmParams extends Algorithm {
    iv: BufferSource;
    additionalData?: BufferSource;
    tagLength?: number;
}

interface HkdfParams extends Algorithm {
    hash: HashAlgorithmIdentifier;
    salt: BufferSource;
    info: BufferSource;
}

interface Pbkdf2Params extends Algorithm {
    salt: BufferSource;
    iterations: number;
    hash: HashAlgorithmIdentifier;
}

interface EcdhKeyDeriveParams extends Algorithm {
    public: CryptoKey;
}

// ============================================================================
// Utility Functions
// ============================================================================

function toArrayBuffer(source: BufferSource): ArrayBuffer {
    if (source instanceof ArrayBuffer) return source;
    const v = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    if (v instanceof ArrayBuffer) return v;
    throw new Error('Unsupported buffer source');
}

function normalizeAlgorithm(algorithm: AlgorithmIdentifier): Algorithm {
    if (typeof algorithm === 'string') {
        return { name: algorithm.toUpperCase() };
    }
    return { ...algorithm, name: algorithm.name.toUpperCase() };
}

function getHashFunction(algorithm: HashAlgorithmIdentifier): (data: ArrayBuffer) => ArrayBuffer {
    const normalized = typeof algorithm === 'string' ? algorithm.toUpperCase() : normalizeAlgorithm(algorithm).name;

    const hashFunctions: Record<string, (data: ArrayBuffer) => ArrayBuffer> = {
        'SHA-1': crypto.sha1,
        'SHA-256': crypto.sha256,
        'SHA-384': crypto.sha384,
        'SHA-512': crypto.sha512,
        'SHA3-224': crypto.sha3_224,
        'SHA3-256': crypto.sha3_256,
        'SHA3-384': crypto.sha3_384,
        'SHA3-512': crypto.sha3_512,
    };

    const fn = hashFunctions[normalized];
    if (!fn) throw new Error(`Unsupported hash algorithm: ${normalized}`);
    return fn;
}

function getHashOutputLength(algorithm: HashAlgorithmIdentifier): number {
    const normalized = typeof algorithm === 'string' ? algorithm.toUpperCase() : normalizeAlgorithm(algorithm).name;

    const lengths: Record<string, number> = {
        'SHA-1': 20,
        'SHA-256': 32,
        'SHA-384': 48,
        'SHA-512': 64,
        'SHA3-224': 28,
        'SHA3-256': 32,
        'SHA3-384': 48,
        'SHA3-512': 64,
    };

    return lengths[normalized] || 32;
}

// ============================================================================
// CryptoKey Implementation
// ============================================================================

class CryptoKeyImpl implements CryptoKey {
    constructor(
        public type: KeyType,
        public extractable: boolean,
        public algorithm: KeyAlgorithm,
        public usages: KeyUsage[],
        public _handle: ArrayBuffer
    ) { }
}

// ============================================================================
// SubtleCrypto Implementation
// ============================================================================

class SubtleCrypto{
    /**
     * Generate cryptographic digest (hash)
     */
    async digest(algorithm: HashAlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
        const hashFn = getHashFunction(algorithm);
        return hashFn(toArrayBuffer(data));
    }

    /**
     * Generate a new key pair or secret key
     */
    async generateKey(
        algorithm: AlgorithmIdentifier,
        extractable: boolean,
        keyUsages: KeyUsage[]
    ): Promise<CryptoKeyPair | CryptoKey> {
        const alg = normalizeAlgorithm(algorithm);

        // RSA algorithms
        if (alg.name === 'RSASSA-PKCS1-V1_5' || alg.name === 'RSA-PSS' || alg.name === 'RSA-OAEP') {
            const params = algorithm as RsaHashedKeyGenParams;
            const keyPair = crypto.generateRsaKey(params.modulusLength || 2048);

            const hashAlg = normalizeAlgorithm(params.hash);
            const algorithmObj: RsaHashedKeyAlgorithm = {
                name: alg.name,
                modulusLength: params.modulusLength || 2048,
                publicExponent: params.publicExponent || new Uint8Array([0x01, 0x00, 0x01]),
                hash: { name: hashAlg.name },
            };

            return {
                publicKey: new CryptoKeyImpl('public', true, algorithmObj,
                    keyUsages.filter(u => u === 'verify' || u === 'encrypt' || u === 'wrapKey'), keyPair.publicKey),
                privateKey: new CryptoKeyImpl('private', extractable, algorithmObj,
                    keyUsages.filter(u => u === 'sign' || u === 'decrypt' || u === 'unwrapKey'), keyPair.privateKey),
            };
        }

        // ECDSA / ECDH
        if (alg.name === 'ECDSA' || alg.name === 'ECDH') {
            const params = algorithm as EcKeyGenParams;
            const curve = params.namedCurve;

            let keyPair: CModuleCrypto.EcKeyPair;
            if (curve === 'P-256') keyPair = crypto.generateEcKeyP256();
            else if (curve === 'P-384') keyPair = crypto.generateEcKeyP384();
            else if (curve === 'P-521') keyPair = crypto.generateEcKeyP521();
            else throw new Error(`Unsupported curve: ${curve}`);

            const algorithmObj: EcKeyAlgorithm = {
                name: alg.name,
                namedCurve: curve,
            };

            const publicUsages = alg.name === 'ECDSA' ? ['verify'] : [];
            const privateUsages = alg.name === 'ECDSA' ? ['sign'] : ['deriveKey', 'deriveBits'];

            return {
                publicKey: new CryptoKeyImpl('public', true, algorithmObj,
                    keyUsages.filter(u => publicUsages.includes(u)) as KeyUsage[], keyPair.publicKey),
                privateKey: new CryptoKeyImpl('private', extractable, algorithmObj,
                    keyUsages.filter(u => privateUsages.includes(u)) as KeyUsage[], keyPair.privateKey),
            };
        }

        // AES
        if (alg.name === 'AES-CBC' || alg.name === 'AES-GCM') {
            const params = algorithm as AesKeyGenParams;
            const length = params.length;
            if (![128, 192, 256].includes(length)) {
                throw new Error(`Invalid AES key length: ${length}`);
            }

            const keyData = crypto.randomBytes(length / 8);
            const algorithmObj: AesKeyAlgorithm = {
                name: alg.name,
                length,
            };

            return new CryptoKeyImpl('secret', extractable, algorithmObj, keyUsages, keyData);
        }

        // HMAC
        if (alg.name === 'HMAC') {
            const params = algorithm as HmacKeyGenParams;
            const hashLength = getHashOutputLength(params.hash);
            const length = params.length || hashLength * 8;

            const keyData = crypto.randomBytes(length / 8);
            const hashAlg = normalizeAlgorithm(params.hash);
            const algorithmObj: HmacKeyAlgorithm = {
                name: 'HMAC',
                hash: { name: hashAlg.name },
                length,
            };

            return new CryptoKeyImpl('secret', extractable, algorithmObj, keyUsages, keyData);
        }

        throw new Error(`Unsupported algorithm: ${alg.name}`);
    }

    /**
     * Sign data
     */
    async sign(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
        if (!key.usages.includes('sign')) {
            throw new Error('Key cannot be used for signing');
        }

        const alg = normalizeAlgorithm(algorithm);
        const keyImpl = key as CryptoKeyImpl;
        const dataBuffer = toArrayBuffer(data);

        // RSA-PSS
        if (alg.name === 'RSA-PSS') {
            const params = algorithm as RsaPssParams;
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.rsaPssSha256Sign(keyImpl._handle, dataBuffer, params.saltLength);
            }
            throw new Error(`Unsupported hash for RSA-PSS: ${keyAlg.hash.name}`);
        }

        // RSASSA-PKCS1-v1_5
        if (alg.name === 'RSASSA-PKCS1-V1_5') {
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.signSha256(keyImpl._handle, dataBuffer);
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return crypto.signSha512(keyImpl._handle, dataBuffer);
            }
            throw new Error(`Unsupported hash for RSASSA-PKCS1-v1_5: ${keyAlg.hash.name}`);
        }

        // ECDSA
        if (alg.name === 'ECDSA') {
            const params = algorithm as EcdsaParams;
            const keyAlg = keyImpl.algorithm as EcKeyAlgorithm;

            if (keyAlg.namedCurve === 'P-256') {
                return crypto.ecdsaSignP256(keyImpl._handle, dataBuffer);
            }
            if (keyAlg.namedCurve === 'P-384') {
                return crypto.ecdsaSignP384(keyImpl._handle, dataBuffer);
            }
            if (keyAlg.namedCurve === 'P-521') {
                return crypto.ecdsaSignP521(keyImpl._handle, dataBuffer);
            }
            throw new Error(`Unsupported curve for ECDSA: ${keyAlg.namedCurve}`);
        }

        // HMAC
        if (alg.name === 'HMAC') {
            const keyAlg = keyImpl.algorithm as HmacKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.hmacSha256(keyImpl._handle, dataBuffer);
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return crypto.hmacSha512(keyImpl._handle, dataBuffer);
            }
            if (keyAlg.hash.name === 'SHA-1') {
                return crypto.hmacSha1(keyImpl._handle, dataBuffer);
            }
            throw new Error(`Unsupported hash for HMAC: ${keyAlg.hash.name}`);
        }

        throw new Error(`Unsupported signing algorithm: ${alg.name}`);
    }

    /**
     * Verify signature
     */
    async verify(
        algorithm: AlgorithmIdentifier,
        key: CryptoKey,
        signature: BufferSource,
        data: BufferSource
    ): Promise<boolean> {
        if (!key.usages.includes('verify')) {
            throw new Error('Key cannot be used for verification');
        }

        const alg = normalizeAlgorithm(algorithm);
        const keyImpl = key as CryptoKeyImpl;
        const signatureBuffer = toArrayBuffer(signature);
        const dataBuffer = toArrayBuffer(data);

        // RSA-PSS
        if (alg.name === 'RSA-PSS') {
            const params = algorithm as RsaPssParams;
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.rsaPssSha256Verify(keyImpl._handle, dataBuffer, signatureBuffer, params.saltLength);
            }
            throw new Error(`Unsupported hash for RSA-PSS: ${keyAlg.hash.name}`);
        }

        // RSASSA-PKCS1-v1_5
        if (alg.name === 'RSASSA-PKCS1-V1_5') {
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.verifySha256(keyImpl._handle, dataBuffer, signatureBuffer);
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return crypto.verifySha512(keyImpl._handle, dataBuffer, signatureBuffer);
            }
            throw new Error(`Unsupported hash for RSASSA-PKCS1-v1_5: ${keyAlg.hash.name}`);
        }

        // ECDSA
        if (alg.name === 'ECDSA') {
            const keyAlg = keyImpl.algorithm as EcKeyAlgorithm;

            if (keyAlg.namedCurve === 'P-256') {
                return crypto.ecdsaVerifyP256(keyImpl._handle, dataBuffer, signatureBuffer);
            }
            if (keyAlg.namedCurve === 'P-384') {
                return crypto.ecdsaVerifyP384(keyImpl._handle, dataBuffer, signatureBuffer);
            }
            if (keyAlg.namedCurve === 'P-521') {
                return crypto.ecdsaVerifyP521(keyImpl._handle, dataBuffer, signatureBuffer);
            }
            throw new Error(`Unsupported curve for ECDSA: ${keyAlg.namedCurve}`);
        }

        throw new Error(`Unsupported verification algorithm: ${alg.name}`);
    }

    /**
     * Encrypt data
     */
    async encrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
        if (!key.usages.includes('encrypt')) {
            throw new Error('Key cannot be used for encryption');
        }

        const alg = normalizeAlgorithm(algorithm);
        const keyImpl = key as CryptoKeyImpl;
        const dataBuffer = toArrayBuffer(data);

        // RSA-OAEP
        if (alg.name === 'RSA-OAEP') {
            const params = algorithm as RsaOaepParams;
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;
            const label = params.label ? toArrayBuffer(params.label) : undefined;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.rsaOaepSha256Encrypt(keyImpl._handle, dataBuffer, label);
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return crypto.rsaOaepSha512Encrypt(keyImpl._handle, dataBuffer, label);
            }
            throw new Error(`Unsupported hash for RSA-OAEP: ${keyAlg.hash.name}`);
        }

        // AES-CBC
        if (alg.name === 'AES-CBC') {
            const params = algorithm as AesCbcParams;
            const keyAlg = keyImpl.algorithm as AesKeyAlgorithm;
            const iv = toArrayBuffer(params.iv);

            if (keyAlg.length === 128) {
                return crypto.aes128CbcEncrypt(keyImpl._handle, iv, dataBuffer);
            }
            if (keyAlg.length === 256) {
                return crypto.aes256CbcEncrypt(keyImpl._handle, iv, dataBuffer);
            }
            throw new Error(`Unsupported AES key length: ${keyAlg.length}`);
        }

        // AES-GCM
        if (alg.name === 'AES-GCM') {
            const params = algorithm as AesGcmParams;
            const keyAlg = keyImpl.algorithm as AesKeyAlgorithm;
            const iv = toArrayBuffer(params.iv);
            const aad = params.additionalData ? toArrayBuffer(params.additionalData) : undefined;

            if (keyAlg.length === 128) {
                return crypto.aes128GcmEncrypt(keyImpl._handle, iv, dataBuffer);
            }
            if (keyAlg.length === 256) {
                return crypto.aes256GcmEncrypt(keyImpl._handle, iv, dataBuffer);
            }
            throw new Error(`Unsupported AES key length: ${keyAlg.length}`);
        }

        throw new Error(`Unsupported encryption algorithm: ${alg.name}`);
    }

    /**
     * Decrypt data
     */
    async decrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
        if (!key.usages.includes('decrypt')) {
            throw new Error('Key cannot be used for decryption');
        }

        const alg = normalizeAlgorithm(algorithm);
        const keyImpl = key as CryptoKeyImpl;
        const dataBuffer = toArrayBuffer(data);

        // RSA-OAEP
        if (alg.name === 'RSA-OAEP') {
            const params = algorithm as RsaOaepParams;
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;
            const label = params.label ? toArrayBuffer(params.label) : undefined;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.rsaOaepSha256Decrypt(keyImpl._handle, dataBuffer, label);
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return crypto.rsaOaepSha512Decrypt(keyImpl._handle, dataBuffer, label);
            }
            throw new Error(`Unsupported hash for RSA-OAEP: ${keyAlg.hash.name}`);
        }

        // AES-CBC
        if (alg.name === 'AES-CBC') {
            const params = algorithm as AesCbcParams;
            const keyAlg = keyImpl.algorithm as AesKeyAlgorithm;
            const iv = toArrayBuffer(params.iv);

            if (keyAlg.length === 128) {
                return crypto.aes128CbcDecrypt(keyImpl._handle, iv, dataBuffer);
            }
            if (keyAlg.length === 256) {
                return crypto.aes256CbcDecrypt(keyImpl._handle, iv, dataBuffer);
            }
            throw new Error(`Unsupported AES key length: ${keyAlg.length}`);
        }

        // AES-GCM
        if (alg.name === 'AES-GCM') {
            const params = algorithm as AesGcmParams;
            const keyAlg = keyImpl.algorithm as AesKeyAlgorithm;
            const iv = toArrayBuffer(params.iv);

            if (keyAlg.length === 128) {
                return crypto.aes128GcmDecrypt(keyImpl._handle, iv, dataBuffer);
            }
            if (keyAlg.length === 256) {
                return crypto.aes256GcmDecrypt(keyImpl._handle, iv, dataBuffer);
            }
            throw new Error(`Unsupported AES key length: ${keyAlg.length}`);
        }

        throw new Error(`Unsupported decryption algorithm: ${alg.name}`);
    }

    /**
     * Derive key from base key
     */
    async deriveKey(
        algorithm: AlgorithmIdentifier,
        baseKey: CryptoKey,
        derivedKeyAlgorithm: AlgorithmIdentifier,
        extractable: boolean,
        keyUsages: KeyUsage[]
    ): Promise<CryptoKey> {
        if (!baseKey.usages.includes('deriveKey')) {
            throw new Error('Base key cannot be used for key derivation');
        }

        const bits = await this.deriveBits(algorithm, baseKey, 256);
        return this.importKey('raw', bits, derivedKeyAlgorithm, extractable, keyUsages);
    }

    /**
     * Derive bits from base key
     */
    async deriveBits(algorithm: AlgorithmIdentifier, baseKey: CryptoKey, length: number): Promise<ArrayBuffer> {
        if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
            throw new Error('Key cannot be used for derivation');
        }

        const alg = normalizeAlgorithm(algorithm);
        const keyImpl = baseKey as CryptoKeyImpl;

        // ECDH
        if (alg.name === 'ECDH') {
            const params = algorithm as EcdhKeyDeriveParams;
            const keyAlg = keyImpl.algorithm as EcKeyAlgorithm;
            const publicKeyImpl = params.public as CryptoKeyImpl;

            let sharedSecret: ArrayBuffer;
            if (keyAlg.namedCurve === 'P-256') {
                sharedSecret = crypto.ecdhDeriveP256(keyImpl._handle, publicKeyImpl._handle);
            } else if (keyAlg.namedCurve === 'P-384') {
                sharedSecret = crypto.ecdhDeriveP384(keyImpl._handle, publicKeyImpl._handle);
            } else if (keyAlg.namedCurve === 'P-521') {
                sharedSecret = crypto.ecdhDeriveP521(keyImpl._handle, publicKeyImpl._handle);
            } else {
                throw new Error(`Unsupported curve for ECDH: ${keyAlg.namedCurve}`);
            }

            // Return requested number of bits
            const bytes = length / 8;
            return sharedSecret.slice(0, bytes);
        }

        // HKDF
        if (alg.name === 'HKDF') {
            const params = algorithm as HkdfParams;
            const salt = toArrayBuffer(params.salt);
            const info = toArrayBuffer(params.info);
            const hashAlg = normalizeAlgorithm(params.hash);

            if (hashAlg.name === 'SHA-256') {
                return crypto.hkdfSha256(keyImpl._handle, length / 8, salt, info);
            }
            if (hashAlg.name === 'SHA-512') {
                return crypto.hkdfSha512(keyImpl._handle, length / 8, salt, info);
            }
            throw new Error(`Unsupported hash for HKDF: ${hashAlg.name}`);
        }

        // PBKDF2
        if (alg.name === 'PBKDF2') {
            const params = algorithm as Pbkdf2Params;
            const salt = toArrayBuffer(params.salt);
            const hashAlg = normalizeAlgorithm(params.hash);

            if (hashAlg.name === 'SHA-256') {
                return crypto.pbkdf2Sha256(keyImpl._handle, salt, params.iterations, length / 8);
            }
            if (hashAlg.name === 'SHA-512') {
                return crypto.pbkdf2Sha512(keyImpl._handle, salt, params.iterations, length / 8);
            }
            throw new Error(`Unsupported hash for PBKDF2: ${hashAlg.name}`);
        }

        throw new Error(`Unsupported derivation algorithm: ${alg.name}`);
    }

    /**
     * Import key from external format
     */
    async importKey(
        format: string,
        keyData: BufferSource | JsonWebKey,
        algorithm: AlgorithmIdentifier,
        extractable: boolean,
        keyUsages: KeyUsage[]
    ): Promise<CryptoKey> {
        const alg = normalizeAlgorithm(algorithm);

        if (format === 'raw') {
            const keyBuffer = toArrayBuffer(keyData as BufferSource);

            // HMAC
            if (alg.name === 'HMAC') {
                const params = algorithm as HmacKeyGenParams;
                const hashAlg = normalizeAlgorithm(params.hash);
                const algorithmObj: HmacKeyAlgorithm = {
                    name: 'HMAC',
                    hash: { name: hashAlg.name },
                    length: keyBuffer.byteLength * 8,
                };
                return new CryptoKeyImpl('secret', extractable, algorithmObj, keyUsages, keyBuffer);
            }

            // AES
            if (alg.name === 'AES-CBC' || alg.name === 'AES-GCM') {
                const length = keyBuffer.byteLength * 8;
                if (![128, 192, 256].includes(length)) {
                    throw new Error(`Invalid AES key length: ${length}`);
                }
                const algorithmObj: AesKeyAlgorithm = {
                    name: alg.name,
                    length,
                };
                return new CryptoKeyImpl('secret', extractable, algorithmObj, keyUsages, keyBuffer);
            }

            // PBKDF2 / HKDF (password material)
            if (alg.name === 'PBKDF2' || alg.name === 'HKDF') {
                return new CryptoKeyImpl('secret', false, { name: alg.name }, keyUsages, keyBuffer);
            }

            throw new Error(`Cannot import raw key for algorithm: ${alg.name}`);
        }

        if (format === 'spki' || format === 'pkcs8') {
            // RSA or EC keys in PEM/DER format
            const keyBuffer = toArrayBuffer(keyData as BufferSource);

            if (alg.name.startsWith('RSA')) {
                const params = algorithm as RsaHashedImportParams;
                const hashAlg = normalizeAlgorithm(params.hash);
                const algorithmObj: RsaHashedKeyAlgorithm = {
                    name: alg.name,
                    modulusLength: 2048, // Cannot determine from data
                    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
                    hash: { name: hashAlg.name },
                };

                const type: KeyType = format === 'spki' ? 'public' : 'private';
                return new CryptoKeyImpl(type, extractable, algorithmObj, keyUsages, keyBuffer);
            }

            if (alg.name === 'ECDSA' || alg.name === 'ECDH') {
                const params = algorithm as EcKeyGenParams;
                const algorithmObj: EcKeyAlgorithm = {
                    name: alg.name,
                    namedCurve: params.namedCurve,
                };

                const type: KeyType = format === 'spki' ? 'public' : 'private';
                return new CryptoKeyImpl(type, extractable, algorithmObj, keyUsages, keyBuffer);
            }
        }

        throw new Error(`Unsupported import format: ${format}`);
    }

    /**
     * Export key to external format
     */
    async exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer | JsonWebKey> {
        if (!key.extractable) {
            throw new Error('Key is not extractable');
        }

        const keyImpl = key as CryptoKeyImpl;

        if (format === 'raw') {
            if (key.type !== 'secret') {
                throw new Error('Can only export secret keys as raw');
            }
            return keyImpl._handle;
        }

        if (format === 'spki' && key.type === 'public') {
            return keyImpl._handle;
        }

        if (format === 'pkcs8' && key.type === 'private') {
            return keyImpl._handle;
        }
        if (format === 'pkcs8' && key.type === 'private') {
            return keyImpl._handle;
        }

        throw new Error(`Unsupported export format: ${format}`);
    }
    /**
     * Wrap a key for secure storage or transmission
     */
    async wrapKey(
        format: string,
        key: CryptoKey,
        wrappingKey: CryptoKey,
        wrapAlgorithm: AlgorithmIdentifier
    ): Promise<ArrayBuffer> {
        if (!wrappingKey.usages.includes('wrapKey')) {
            throw new Error('Key cannot be used for wrapping');
        }

        // Export the key to be wrapped
        const exportedKey = await this.exportKey(format, key);

        // Encrypt the exported key data using the wrapping key
        return this.encrypt(wrapAlgorithm, wrappingKey, new Uint8Array(exportedKey as ArrayBuffer));
    }

    /**
     * Unwrap a previously wrapped key
     */
    async unwrapKey(
        format: string,
        wrappedKey: BufferSource,
        unwrappingKey: CryptoKey,
        unwrapAlgorithm: AlgorithmIdentifier,
        unwrappedKeyAlgorithm: AlgorithmIdentifier,
        extractable: boolean,
        keyUsages: KeyUsage[]
    ): Promise<CryptoKey> {
        if (!unwrappingKey.usages.includes('unwrapKey')) {
            throw new Error('Key cannot be used for unwrapping');
        }

        // Decrypt the wrapped key using the unwrapping key
        const decryptedKey = await this.decrypt(unwrapAlgorithm, unwrappingKey, wrappedKey);

        // Import the decrypted key data
        return this.importKey(format, decryptedKey, unwrappedKeyAlgorithm, extractable, keyUsages);
    }
}

export const subtle = new SubtleCrypto();

const webCrypto: Crypto = {
    // @ts-ignore
    subtle,

    digest(algorithm: HashAlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
        return subtle.digest(algorithm, data);
    },

    getRandomValues<T extends ArrayBufferView>(buffer: T): T {
        if (buffer.byteLength > 65536) {
            throw new RangeError('getRandomValues: Request exceeds maximum size of 65536 bytes');
        }
        const bytes = crypto.randomBytes(buffer.byteLength);
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(new Uint8Array(bytes));
        return buffer;
    },

    randomUUID() {
        const data = crypto.randomBytes(16);
        const dv = new DataView(data);
        // version 4
        dv.setUint8(6, (dv.getUint8(6) & 0x0f) | 0x40);
        // variant 10
        dv.setUint8(8, (dv.getUint8(8) & 0x3f) | 0x80);
        const hex = crypto.hexEncode(data);
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    },
};
Reflect.defineProperty(window, 'crypto', {
    value: webCrypto,
    writable: false,
    enumerable: true,
    configurable: true
});