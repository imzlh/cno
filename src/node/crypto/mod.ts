/**
 * Node.js crypto module
 * Based on CModuleCrypto implementation
 */

const crypto = import.meta.use('crypto');
const algorithm = import.meta.use('algorithm');
const engine = import.meta.use('engine');
import { Buffer } from '../buffer';

// Re-export types from types.ts
export type { BinaryInput, KeyInput, KeyWithOptions, KeyExportOptions, SecretJwk, Hash, Hmac, Cipheriv, Decipheriv, CipherGCM, DecipherGCM, GcmEncryptResult, GcmDecryptResult, CipherInfo, Sign, Verify } from './types';
export type { ScryptOptions } from './random';
import type { BinaryInput, KeyInput, KeyObject as KeyObjectShape, KeyWithOptions, KeyExportOptions, SecretJwk, Hash, Hmac, Cipheriv, Decipheriv, CipherGCM, DecipherGCM, GcmEncryptResult, GcmDecryptResult, CipherInfo, Sign, Verify } from './types';

// Import helpers from helpers.ts
import { toBuffer, toExactArrayBuffer, encodeOutput, concatBuffers, createBufferedCipher, createBufferedDecipher, isGcmAlgorithm, normalizeHashAlgorithm, oneShotHmac, createOneShotHmac, isSupportedHmacAlgorithm, readAsymmetricCipherArgs, readKeyOptions, detectEcCoordinateSize, derToP1363, p1363ToDer, kKeyData, kKeyFormat, guessKeyFormat, isKeyObject, type KeyFormat } from './helpers';

function assertCallback(callback: unknown): asserts callback is (...args: unknown[]) => void {
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function resolveCurve(curve: string): 'p256' | 'p384' | 'p521' {
    switch (curve.toLowerCase()) {
        case 'p256': case 'p-256': case 'prime256v1': case 'secp256r1': return 'p256';
        case 'p384': case 'p-384': case 'secp384r1': return 'p384';
        case 'p521': case 'p-521': case 'secp521r1': return 'p521';
        default: throw new Error(`Unsupported curve: ${curve}`);
    }
}

function keyTypeFromPrivate(bytes: Uint8Array): 'rsa' | 'ec' {
    return crypto.getPrivateKeyType(bytes) as 'rsa' | 'ec';
}

function keyTypeFromPublic(bytes: Uint8Array): 'rsa' | 'ec' {
    return crypto.getPublicKeyType(bytes) as 'rsa' | 'ec';
}

type KeyInputWithFormat = { key: KeyInput; format?: 'pem' | 'der' };

function isKeyInputWithFormat(input: KeyInput | KeyInputWithFormat): input is KeyInputWithFormat {
    return input !== null
        && typeof input === 'object'
        && !isKeyObject(input)
        && !(input instanceof Uint8Array)
        && !(input instanceof ArrayBuffer)
        && 'key' in input;
}

function normalizeKeySource(input: KeyInput | { key: KeyInput; format?: 'pem' | 'der' }): { bytes: Uint8Array; format: KeyFormat } {
    const source = isKeyInputWithFormat(input)
        ? input.key
        : input;
    if (isKeyObject(source)) {
        return {
            bytes: source[kKeyData],
            format: source[kKeyFormat],
        };
    }
    return {
        bytes: toBuffer(source),
        format: guessKeyFormat(source, isKeyInputWithFormat(input) ? input.format : undefined),
    };
}

function toPemString(bytes: Uint8Array): string {
    return engine.decodeString(bytes);
}

function exportKeyObjectBytes(keyObject: KeyObject, format: 'pem' | 'der'): Uint8Array {
    if (keyObject.type === 'private') {
        if (format === 'pem') {
            return keyObject[kKeyFormat] === 'pem'
                ? keyObject[kKeyData]
                : new Uint8Array(crypto.exportPrivateKeyPem(keyObject[kKeyData]));
        }
        return keyObject[kKeyFormat] === 'der'
            ? keyObject[kKeyData]
            : new Uint8Array(crypto.exportPrivateKeyDer(keyObject[kKeyData]));
    }

    if (format === 'pem') {
        return keyObject[kKeyFormat] === 'pem'
            ? keyObject[kKeyData]
            : new Uint8Array(crypto.exportPublicKeyPem(keyObject[kKeyData]));
    }
    return keyObject[kKeyFormat] === 'der'
        ? keyObject[kKeyData]
        : new Uint8Array(crypto.exportPublicKeyDer(keyObject[kKeyData]));
}

function signatureToP1363(signature: ArrayBuffer, keyBytes: Uint8Array): ArrayBuffer {
    const size = detectEcCoordinateSize(keyBytes);
    if (!size) {
        throw new TypeError('Unable to determine EC key size for ieee-p1363 signature');
    }
    return derToP1363(signature, size);
}

function maybeEncodeSignatureForSign(signature: ArrayBuffer, keyInput: KeyInput | KeyWithOptions, outputEncoding?: string): Uint8Array | string {
    const { key, dsaEncoding } = readKeyOptions(keyInput);
    const out = dsaEncoding === 'ieee-p1363' ? signatureToP1363(signature, key) : signature;
    return outputEncoding ? encodeOutput(out, outputEncoding) : Buffer.from(new Uint8Array(out));
}

function normalizeSignatureForVerify(signature: BinaryInput, signatureEncoding: string | undefined, keyInput: KeyInput | KeyWithOptions): Uint8Array {
    const { dsaEncoding } = readKeyOptions(keyInput);
    const sigBuf = toBuffer(signature, signatureEncoding);
    return dsaEncoding === 'ieee-p1363' ? new Uint8Array(p1363ToDer(sigBuf)) : sigBuf;
}

function createDigestAlreadyCalledError(): Error {
    const err = new Error('Digest already called') as Error & { code?: string };
    err.code = 'ERR_CRYPTO_HASH_FINALIZED';
    return err;
}

export class KeyObject implements KeyObjectShape {
    readonly [Symbol.toStringTag] = 'KeyObject' as const;
    readonly type: 'private' | 'public' | 'secret';
    readonly asymmetricKeyType?: 'rsa' | 'ec';
    readonly symmetricKeySize?: number;
    [kKeyData]: Uint8Array;
    [kKeyFormat]: KeyFormat;

    constructor(type: 'private' | 'public' | 'secret', asymmetricKeyType: 'rsa' | 'ec' | undefined, data: BinaryInput, format: KeyFormat) {
        this.type = type;
        this.asymmetricKeyType = asymmetricKeyType;
        this[kKeyData] = toBuffer(data);
        this[kKeyFormat] = format;
        if (type === 'secret') this.symmetricKeySize = this[kKeyData].byteLength;
    }

    export(options: KeyExportOptions = {}): Uint8Array | string | SecretJwk {
        if (this.type === 'secret') {
            if (options.format === 'jwk') {
                return { kty: 'oct', k: algorithm.base64UrlEncode(this[kKeyData]) };
            }
            if (options.format && options.format !== 'der') {
                throw new TypeError(`Unsupported secret key export format: ${options.format}`);
            }
            return Buffer.from(this[kKeyData]);
        }
        const format = options.format ?? (this[kKeyFormat] === 'pem' ? 'pem' : 'der');
        if (this.type === 'private' && options.type && options.type !== 'pkcs8') {
            throw new TypeError(`Unsupported private key export type: ${options.type}`);
        }
        if (this.type === 'public' && options.type && options.type !== 'spki') {
            throw new TypeError(`Unsupported public key export type: ${options.type}`);
        }
        if (format !== 'pem' && format !== 'der') {
            throw new TypeError(`Unsupported key export format: ${String(format)}`);
        }

        const exported = exportKeyObjectBytes(this, format);
        return format === 'pem' ? toPemString(exported) : Buffer.from(exported);
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
        ripemd160:  buf => crypto.ripemd160(buf),
        sha224:     buf => crypto.sha224(buf),
        sha384:     buf => crypto.sha384(buf),
        sha512224:  buf => crypto.sha512_224(buf),
        sha512256:  buf => crypto.sha512_256(buf),
        sha3224:    buf => crypto.sha3_224(buf),
        sha3256:    buf => crypto.sha3_256(buf),
        sha3384:    buf => crypto.sha3_384(buf),
        sha3512:    buf => crypto.sha3_512(buf),
        blake2b512: buf => crypto.blake2b512(buf),
        blake2s256: buf => crypto.blake2s256(buf),
        shake128:   buf => crypto.shake128(buf),
        shake256:   buf => crypto.shake256(buf),
    };

    const streamingAlgo = streamingAlgos[a];
    if (streamingAlgo) {
        const hashObj = streamingAlgo();
        let finalized = false;
        return {
            update(input: BinaryInput, encoding?: string) {
                if (finalized) throw createDigestAlreadyCalledError();
                hashObj.update(toBuffer(input, encoding));
                return this;
            },
            digest(encoding?: string) {
                if (finalized) throw createDigestAlreadyCalledError();
                finalized = true;
                return encodeOutput(hashObj.digest(), encoding);
            },
        };
    }

    const oneshotAlgo = oneshotAlgos[a];
    if (oneshotAlgo) {
        const fn = oneshotAlgo;
        const chunks: Uint8Array[] = [];
        let finalized = false;
        return {
            update(input: BinaryInput, encoding?: string) {
                if (finalized) throw createDigestAlreadyCalledError();
                chunks.push(toBuffer(input, encoding));
                return this;
            },
            digest(encoding?: string) {
                if (finalized) throw createDigestAlreadyCalledError();
                finalized = true;
                return encodeOutput(fn(concatBuffers(chunks)), encoding);
            },
        };
    }

    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
}

// hash - one-shot hash

export function hash(algorithm: string, data: ArrayBuffer | Uint8Array | string, outputEncoding: string = 'hex'): ArrayBuffer | string {
    const buf = toBuffer(data);
    let result: ArrayBuffer;

    const a = normalizeHashAlgorithm(algorithm);
    switch (a) {
        case 'md5':       result = crypto.md5(buf); break;
        case 'ripemd160': result = crypto.ripemd160(buf); break;
        case 'sha1':      result = crypto.sha1(buf); break;
        case 'sha224':    result = crypto.sha224(buf); break;
        case 'sha256':    result = crypto.sha256(buf); break;
        case 'sha384':    result = crypto.sha384(buf); break;
        case 'sha512':    result = crypto.sha512(buf); break;
        case 'sha512224': result = crypto.sha512_224(buf); break;
        case 'sha512256': result = crypto.sha512_256(buf); break;
        case 'sha3224':   result = crypto.sha3_224(buf); break;
        case 'sha3256':   result = crypto.sha3_256(buf); break;
        case 'sha3384':   result = crypto.sha3_384(buf); break;
        case 'sha3512':   result = crypto.sha3_512(buf); break;
        case 'blake2b512': result = crypto.blake2b512(buf); break;
        case 'blake2s256': result = crypto.blake2s256(buf); break;
        case 'shake128':   result = crypto.shake128(buf); break;
        case 'shake256':   result = crypto.shake256(buf); break;
        default: throw new Error(`Unsupported hash algorithm: ${algorithm}`);
    }

    return encodeOutput(result, outputEncoding);
}

// createHmac

export function createHmac(algorithm: string, key: KeyInput): Hmac {
    const keyBuf = isKeyObject(key) ? key[kKeyData] : toBuffer(key);
    const a = normalizeHashAlgorithm(algorithm);

    if (a !== 'sha256' && a !== 'sha512') {
        if (!isSupportedHmacAlgorithm(a)) throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
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

    let finalized = false;
    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            if (finalized) throw createDigestAlreadyCalledError();
            hmacObj.update(toBuffer(input, encoding));
            return this;
        },
        digest(encoding?: string) {
            if (finalized) {
                return encodeOutput(new Uint8Array(), encoding);
            }
            finalized = true;
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

export function createSha512_224(): CModuleCrypto.Hash {
    return crypto.createSha512_224();
}

export function createSha512_256(): CModuleCrypto.Hash {
    return crypto.createSha512_256();
}

export function createBlake2b512(): CModuleCrypto.Hash {
    return crypto.createBlake2b512();
}

export function createBlake2s256(): CModuleCrypto.Hash {
    return crypto.createBlake2s256();
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

export function hmacSha512_224(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha512_224(toBuffer(key), toBuffer(data));
}

export function hmacSha512_256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha512_256(toBuffer(key), toBuffer(data));
}

export function hmacSha3_224(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha3_224(toBuffer(key), toBuffer(data));
}

export function hmacSha3_256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha3_256(toBuffer(key), toBuffer(data));
}

export function hmacSha3_384(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha3_384(toBuffer(key), toBuffer(data));
}

export function hmacSha3_512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha3_512(toBuffer(key), toBuffer(data));
}

export function hmacBlake2b512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacBlake2b512(toBuffer(key), toBuffer(data));
}

export function hmacBlake2s256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacBlake2s256(toBuffer(key), toBuffer(data));
}

export function createHmacSha256(key: ArrayBuffer | Uint8Array | string): CModuleCrypto.Hmac {
    return crypto.createHmacSha256(toBuffer(key));
}

export function createHmacSha512(key: ArrayBuffer | Uint8Array | string): CModuleCrypto.Hmac {
    return crypto.createHmacSha512(toBuffer(key));
}

// createCipher / createDecipher

type CipherivWithAutoPadding = Cipheriv & { setAutoPadding(v: boolean): void };
type DecipherivWithAutoPadding = Decipheriv & { setAutoPadding(v: boolean): void };

type CbcFns = {
    keyLength: number;
    ivLength: number;
    encrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    encryptRaw: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decryptRaw: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
};

const GCM_KEY_LENGTHS: Record<string, number> = {
    'aes-128-gcm': 16,
    'aes-192-gcm': 24,
    'aes-256-gcm': 32,
};

function getCbcFns(algorithm: string): CbcFns {
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
            throw new Error(`Unknown cipher: ${algorithm}`);
    }
}

function validateCbcKeyIv(key: Uint8Array, iv: Uint8Array, fns: CbcFns): void {
    if (key.byteLength !== fns.keyLength) throw new RangeError('Invalid key length');
    if (iv.byteLength !== fns.ivLength) throw new TypeError('Invalid initialization vector');
}

function makeCbcCipher(key: Uint8Array, iv: Uint8Array, fns: CbcFns): CipherivWithAutoPadding {
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

function makeCbcDecipher(key: Uint8Array, iv: Uint8Array, fns: CbcFns): DecipherivWithAutoPadding {
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
                ? fns.decrypt(key, currentIv, buf)
                : fns.decryptRaw(key, currentIv, buf);
            return encodeOutput(out, outputEncoding);
        },
        setAutoPadding(v: boolean) {
            autoPadding = v;
        },
    };
}

export function createCipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array): Cipheriv {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const a = algorithm.toLowerCase();

    if (isGcmAlgorithm(a)) {
        return createCipherivGCM(a, keyBuf, ivBuf);
    }

    const fns = getCbcFns(a);
    validateCbcKeyIv(keyBuf, ivBuf, fns);
    return makeCbcCipher(keyBuf, ivBuf, fns);
}

export function createDecipheriv(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array): Decipheriv {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    const a = algorithm.toLowerCase();

    if (isGcmAlgorithm(a)) {
        return createDecipherivGCM(a, keyBuf, ivBuf);
    }

    const fns = getCbcFns(a);
    validateCbcKeyIv(keyBuf, ivBuf, fns);
    return makeCbcDecipher(keyBuf, ivBuf, fns);
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
    const expectedKeyLength = GCM_KEY_LENGTHS[algorithm.toLowerCase()];
    if (keyBuf.byteLength !== expectedKeyLength) throw new Error('Invalid key length');
    const gcm = new crypto.GCM('encrypt', toExactArrayBuffer(keyBuf), toExactArrayBuffer(ivBuf));
    let ctag: ArrayBuffer | undefined;

    return {
        setAAD(aad: ArrayBuffer | Uint8Array) {
            gcm.setAAD(toExactArrayBuffer(toBuffer(aad)));
            return this;
        },
        update(data: ArrayBuffer | Uint8Array | string, inputEncoding?: string, outputEncoding?: string) {
            const result = gcm.update(toExactArrayBuffer(toBuffer(data, inputEncoding)));
            return encodeOutput(result, outputEncoding);
        },
        final(outputEncoding?: string) {
            const { data, tag } = gcm.final();
            // Store tag for getAuthTag
            ctag = tag;
            return encodeOutput(data, outputEncoding);
        },
        getAuthTag() {
            return Buffer.from(new Uint8Array(ctag || new ArrayBuffer(0)));
        },
    };
}

export function createDecipherivGCM(algorithm: string, key: ArrayBuffer | Uint8Array, iv: ArrayBuffer | Uint8Array, options?: { authTagLength?: number }): DecipherGCM {
    const keyBuf = toBuffer(key);
    const ivBuf = toBuffer(iv);
    if (!isGcmAlgorithm(algorithm)) {
        throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
    }
    const expectedKeyLength = GCM_KEY_LENGTHS[algorithm.toLowerCase()];
    if (keyBuf.byteLength !== expectedKeyLength) throw new Error('Invalid key length');
    const gcm = new crypto.GCM('decrypt', toExactArrayBuffer(keyBuf), toExactArrayBuffer(ivBuf));
    let authTag: ArrayBuffer | null = null;

    return {
        setAAD(aad: ArrayBuffer | Uint8Array) {
            gcm.setAAD(toExactArrayBuffer(toBuffer(aad)));
            return this;
        },
        setAuthTag(tag: ArrayBuffer | Uint8Array) {
            authTag = toExactArrayBuffer(toBuffer(tag));
            return this;
        },
        update(data: ArrayBuffer | Uint8Array | string, inputEncoding?: string, outputEncoding?: string) {
            const result = gcm.update(toExactArrayBuffer(toBuffer(data, inputEncoding)));
            return encodeOutput(result, outputEncoding);
        },
        final(outputEncoding?: string) {
            if (!authTag) {
                throw new TypeError('Failed to authenticate data');
            }
            const result = gcm.final(authTag);
            if (!result.verified) {
                throw new TypeError('Failed to authenticate data');
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

function parseRandomBytesSize(size: number): number {
    if (typeof size !== 'number') {
        throw new TypeError('The "size" argument must be of type number');
    }
    if (!Number.isFinite(size) || size < 0 || size > 0x7fffffff) {
        throw new RangeError('The value of "size" is out of range');
    }
    return Math.trunc(size);
}

export function randomBytes(size: number): Buffer;
export function randomBytes(size: number, callback: (err: Error | null, buf: Buffer) => void): void;
export function randomBytes(size: number, callback?: (err: Error | null, buf: Buffer) => void): Buffer | void {
    const length = parseRandomBytesSize(size);
    if (callback !== undefined && typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }

    if (callback !== undefined) {
        queueMicrotask(() => {
            let result: Buffer;
            try {
                result = Buffer.allocUnsafe(length);
                crypto.randomFill(result);
            } catch (err) {
                callback(asError(err), Buffer.alloc(0));
                return;
            }
            callback(null, result);
        });
        return;
    }

    const result = Buffer.allocUnsafe(length);
    crypto.randomFill(result);
    return result;
}

export const pseudoRandomBytes = randomBytes;

function toTimingSafeEqualBytes(value: ArrayBufferView | ArrayBuffer, name: string): Uint8Array {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError(`The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView`);
}

export function timingSafeEqual(a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer): boolean {
    const left = toTimingSafeEqualBytes(a, 'buf1');
    const right = toTimingSafeEqualBytes(b, 'buf2');
    if (left.byteLength !== right.byteLength) {
        throw new RangeError('Input buffers must have the same byte length');
    }
    return algorithm.bytesEqual(left, right);
}

// Web Crypto API compat (Node.js 17+)
export function getRandomValues<T extends ArrayBufferView>(array: T): T {
    if (!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) {
        throw new DOMException('The data argument must be an integer-type TypedArray', 'TypeMismatchError');
    }
    if (array.byteLength > 65536) {
        throw new DOMException('The requested length exceeds 65,536 bytes', 'QuotaExceededError');
    }
    crypto.randomFill(array);
    return array;
}
// Re-export random/kdf/hkdf from random.ts
export { randomInt, randomFill, randomFillSync, pbkdf2, pbkdf2Sync, pbkdf2Sha1, pbkdf2Sha256, pbkdf2Sha512, scrypt, scryptSync, hkdf, hkdfSync, hkdfSha256, hkdfSha512 } from './random';

// RSA

export function createPrivateKey(input: KeyInput | { key: KeyInput; type?: string; format?: 'pem' | 'der' }): KeyObject {
    if (isKeyObject(input)) {
        if (input.type !== 'private') {
            throw new TypeError('Expected a private key');
        }
        return input;
    }

    const { bytes, format } = normalizeKeySource(input);
    return new KeyObject('private', keyTypeFromPrivate(bytes), bytes, format);
}

export function createSecretKey(key: BinaryInput): KeyObject {
    return new KeyObject('secret', undefined, key, 'raw');
}

export function createPublicKey(input: KeyInput | { key: KeyInput; type?: string; format?: 'pem' | 'der' }): KeyObject {
    if (isKeyObject(input)) {
        if (input.type === 'public') {
            return input;
        }
        if (input.type === 'secret') {
            throw new TypeError('Expected a public or private key');
        }
        if (!input.asymmetricKeyType) throw new TypeError('Private key type is unknown');
        const derived = new Uint8Array(crypto.derivePublicKeyDer(input[kKeyData]));
        return new KeyObject('public', input.asymmetricKeyType, derived, 'der');
    }

    const source = normalizeKeySource(input);
    try {
        return new KeyObject('public', keyTypeFromPublic(source.bytes), source.bytes, source.format);
    } catch {
        const asym = keyTypeFromPrivate(source.bytes);
        const derived = new Uint8Array(crypto.derivePublicKeyDer(source.bytes));
        return new KeyObject('public', asym, derived, 'der');
    }
}

type GenerateKeyPairOptions = {
    modulusLength?: number;
    namedCurve?: string;
    paramEncoding?: string;
};

function generateKeyPairSyncImpl(type: string, options: GenerateKeyPairOptions): { publicKey: KeyObject; privateKey: KeyObject } {
    if (type === 'rsa') {
        const keyPair = crypto.generateRsaKey(options.modulusLength || 2048);
        return {
            publicKey: new KeyObject('public', 'rsa', keyPair.publicKey, 'pem'),
            privateKey: new KeyObject('private', 'rsa', keyPair.privateKey, 'pem'),
        };
    }

    if (type === 'ec') {
        if (options.paramEncoding === 'explicit') {
            throw new Error('Explicit EC parameter encoding is not supported');
        }
        const curve = resolveCurve(options.namedCurve || '');
        let keyPair: CModuleCrypto.EcKeyPair;

        switch (curve) {
            case 'p256': keyPair = crypto.generateEcKeyP256(); break;
            case 'p384': keyPair = crypto.generateEcKeyP384(); break;
            case 'p521': keyPair = crypto.generateEcKeyP521(); break;
        }

        return {
            publicKey: new KeyObject('public', 'ec', keyPair.publicKey, 'raw'),
            privateKey: new KeyObject('private', 'ec', keyPair.privateKey, 'raw'),
        };
    }

    throw new Error(`Unsupported key type: ${type}`);
}

export function generateKeyPairSync(type: 'rsa', options: { modulusLength: number }): { publicKey: KeyObject; privateKey: KeyObject };
export function generateKeyPairSync(type: 'ec', options: { namedCurve: string }): { publicKey: KeyObject; privateKey: KeyObject };
export function generateKeyPairSync(type: string, options: GenerateKeyPairOptions): { publicKey: KeyObject; privateKey: KeyObject } {
    return generateKeyPairSyncImpl(type, options);
}

export function generateKeyPair(type: 'rsa', options: { modulusLength: number }, callback: (err: Error | null, publicKey?: KeyObject, privateKey?: KeyObject) => void): void;
export function generateKeyPair(type: 'ec', options: { namedCurve: string }, callback: (err: Error | null, publicKey?: KeyObject, privateKey?: KeyObject) => void): void;
export function generateKeyPair(type: string, options: GenerateKeyPairOptions, callback: (err: Error | null, publicKey?: KeyObject, privateKey?: KeyObject) => void): void {
    assertCallback(callback);
    queueMicrotask(() => {
        let result: { publicKey: KeyObject; privateKey: KeyObject };
        try {
            result = generateKeyPairSyncImpl(type, options);
        } catch (err) {
            callback(asError(err));
            return;
        }
        callback(null, result.publicKey, result.privateKey);
    });
}

// sign / verify

export function createSign(algorithm: string): Sign {
    let data: Uint8Array[] = [];

    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            data.push(toBuffer(input, encoding));
            return this;
        },
        sign(privateKey: KeyInput | KeyWithOptions, outputEncoding?: string) {
            const { key } = readKeyOptions(privateKey);
            const allData = concatBuffers(data);
            data = [];

            let result: ArrayBuffer;
            switch (algorithm.toLowerCase()) {
                case 'rsa-sha224':
                case 'sha224':
                    result = crypto.signSha224(key, allData);
                    break;
                case 'rsa-sha256':
                case 'sha256':
                    result = crypto.signSha256(key, allData);
                    break;
                case 'rsa-sha384':
                case 'sha384':
                    result = crypto.signSha384(key, allData);
                    break;
                case 'rsa-sha512':
                case 'sha512':
                    result = crypto.signSha512(key, allData);
                    break;
                default:
                    throw new Error(`Unsupported sign algorithm: ${algorithm}`);
            }

            return maybeEncodeSignatureForSign(result, privateKey, outputEncoding);
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
        verify(publicKey: KeyInput | KeyWithOptions, signature: BinaryInput, signatureEncoding?: string) {
            const { key } = readKeyOptions(publicKey);
            const sigBuf = normalizeSignatureForVerify(signature, signatureEncoding, publicKey);
            const allData = concatBuffers(data);
            data = [];

            switch (algorithm.toLowerCase()) {
                case 'rsa-sha224':
                case 'sha224':
                    return crypto.verifySha224(key, allData, sigBuf);
                case 'rsa-sha256':
                case 'sha256':
                    return crypto.verifySha256(key, allData, sigBuf);
                case 'rsa-sha384':
                case 'sha384':
                    return crypto.verifySha384(key, allData, sigBuf);
                case 'rsa-sha512':
                case 'sha512':
                    return crypto.verifySha512(key, allData, sigBuf);
                default:
                    throw new Error(`Unsupported verify algorithm: ${algorithm}`);
            }
        },
    };
}

export function sign(algorithm: string, data: BinaryInput, key: KeyInput | KeyWithOptions): Uint8Array | string {
    const dataBuf = toBuffer(data);
    const { key: keyBuf } = readKeyOptions(key);
    let result: ArrayBuffer;

    switch (algorithm.toLowerCase()) {
        case 'rsa-sha224':
        case 'sha224':
            result = crypto.signSha224(keyBuf, dataBuf);
            break;
        case 'rsa-sha256':
        case 'sha256':
            result = crypto.signSha256(keyBuf, dataBuf);
            break;
        case 'rsa-sha384':
        case 'sha384':
            result = crypto.signSha384(keyBuf, dataBuf);
            break;
        case 'rsa-sha512':
        case 'sha512':
            result = crypto.signSha512(keyBuf, dataBuf);
            break;
        default:
            throw new Error(`Unsupported sign algorithm: ${algorithm}`);
    }
    return maybeEncodeSignatureForSign(result, key);
}

export function generateRsaKey(bits?: number): CModuleCrypto.RsaKeyPair {
    return crypto.generateRsaKey(bits);
}

export function signSha256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha256(toBuffer(key), toBuffer(data));
}

export function signSha224(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha224(toBuffer(key), toBuffer(data));
}

export function signSha384(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha384(toBuffer(key), toBuffer(data));
}

export function signSha512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha512(toBuffer(key), toBuffer(data));
}

export function verify(algorithm: string, data: BinaryInput, key: KeyInput | KeyWithOptions, signature: BinaryInput): boolean {
    const dataBuf = toBuffer(data);
    const { key: keyBuf } = readKeyOptions(key);
    const sigBuf = normalizeSignatureForVerify(signature, undefined, key);

    switch (algorithm.toLowerCase()) {
        case 'rsa-sha224':
        case 'sha224':
            return crypto.verifySha224(keyBuf, dataBuf, sigBuf);
        case 'rsa-sha256':
        case 'sha256':
            return crypto.verifySha256(keyBuf, dataBuf, sigBuf);
        case 'rsa-sha384':
        case 'sha384':
            return crypto.verifySha384(keyBuf, dataBuf, sigBuf);
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

export function verifySha224(
    key: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.verifySha224(toBuffer(key), toBuffer(data), toBuffer(signature));
}

export function verifySha384(
    key: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.verifySha384(toBuffer(key), toBuffer(data), toBuffer(signature));
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
    key: KeyInput | { key: KeyInput; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
): Buffer {
    const args = readAsymmetricCipherArgs(key, data);
    let result: ArrayBuffer;
    switch (args.oaepHash) {
        case 'sha256':
            result = crypto.rsaOaepSha256Encrypt(args.key, args.data, args.oaepLabel);
            break;
        case 'sha512':
            result = crypto.rsaOaepSha512Encrypt(args.key, args.data, args.oaepLabel);
            break;
        default:
            throw new Error(`Unsupported OAEP hash algorithm: ${args.oaepHash}`);
    }
    return Buffer.from(new Uint8Array(result));
}

export function privateDecrypt(
    key: KeyInput | { key: KeyInput; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
): Buffer {
    const args = readAsymmetricCipherArgs(key, data);
    let result: ArrayBuffer;
    switch (args.oaepHash) {
        case 'sha256':
            result = crypto.rsaOaepSha256Decrypt(args.key, args.data, args.oaepLabel);
            break;
        case 'sha512':
            result = crypto.rsaOaepSha512Decrypt(args.key, args.data, args.oaepLabel);
            break;
        default:
            throw new Error(`Unsupported OAEP hash algorithm: ${args.oaepHash}`);
    }
    return Buffer.from(new Uint8Array(result));
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
    return [
        'md5',
        'ripemd160',
        'sha1',
        'sha224',
        'sha256',
        'sha384',
        'sha512',
        'sha512-224',
        'sha512-256',
        'sha3-224',
        'sha3-256',
        'sha3-384',
        'sha3-512',
        'blake2b512',
        'blake2s256',
        'shake-128',
        'shake-256',
    ];
}

export function getCiphers(): string[] {
    return ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'];
}

const CIPHER_INFO: Record<string, CipherInfo> = {
    'aes-128-cbc': { name: 'aes-128-cbc', nid: 0, blockSize: 16, ivLength: 16, keyLength: 16, mode: 'cbc' },
    'aes-192-cbc': { name: 'aes-192-cbc', nid: 0, blockSize: 16, ivLength: 16, keyLength: 24, mode: 'cbc' },
    'aes-256-cbc': { name: 'aes-256-cbc', nid: 0, blockSize: 16, ivLength: 16, keyLength: 32, mode: 'cbc' },
    'aes-128-gcm': { name: 'aes-128-gcm', nid: 0, blockSize: 1, ivLength: 12, keyLength: 16, mode: 'gcm' },
    'aes-192-gcm': { name: 'aes-192-gcm', nid: 0, blockSize: 1, ivLength: 12, keyLength: 24, mode: 'gcm' },
    'aes-256-gcm': { name: 'aes-256-gcm', nid: 0, blockSize: 1, ivLength: 12, keyLength: 32, mode: 'gcm' },
};

function normalizeCipherName(name: string): string {
    const normalized = name.toLowerCase();
    switch (normalized) {
        case 'aes128': return 'aes-128-cbc';
        case 'aes192': return 'aes-192-cbc';
        case 'aes256': return 'aes-256-cbc';
        default: return normalized;
    }
}

export function getCipherInfo(nameOrNid: string | number): CipherInfo | undefined {
    if (typeof nameOrNid !== 'string') return undefined;
    const info = CIPHER_INFO[normalizeCipherName(nameOrNid)];
    return info ? { ...info } : undefined;
}

// UUID

export function randomUUID(): string {
    return crypto.randomUUID();
}

// Web Crypto API — re-export runtime globals so code that imports
// `crypto.webcrypto` or `crypto.subtle` gets the real implementation.
function isRuntimeCrypto(value: unknown): value is Crypto {
    return typeof value === 'object' && value !== null
        && typeof Reflect.get(value, 'getRandomValues') === 'function'
        && typeof Reflect.get(value, 'randomUUID') === 'function'
        && typeof Reflect.get(value, 'subtle') === 'object'
        && Reflect.get(value, 'subtle') !== null;
}

const runtimeCrypto = Reflect.get(globalThis, 'crypto');
if (!isRuntimeCrypto(runtimeCrypto)) {
    throw new Error('Web Crypto API is not initialized');
}

export const webcrypto: Crypto = runtimeCrypto;
export const subtle: SubtleCrypto = webcrypto.subtle;
