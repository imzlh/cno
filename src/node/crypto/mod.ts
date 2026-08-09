/**
 * Node.js crypto module
 * Based on CModuleCrypto implementation
 */

const crypto = import.meta.use('crypto');
const algorithm = import.meta.use('algorithm');
const engine = import.meta.use('engine');
import { Buffer } from '../buffer';

// Re-export types from types.ts
export type { BinaryInput, KeyInput, KeyWithOptions, KeyExportOptions, SecretJwk, AsymmetricKeyType, Hash, Hmac, Cipheriv, Decipheriv, CipherGCM, DecipherGCM, GcmEncryptResult, GcmDecryptResult, CipherInfo, Sign, Verify } from './types';
export type { ScryptOptions } from './random';
import type { BinaryInput, KeyInput, KeyObject as KeyObjectShape, KeyWithOptions, KeyExportOptions, SecretJwk, AsymmetricKeyType, Hash, Hmac, Cipheriv, Decipheriv, CipherGCM, DecipherGCM, GcmEncryptResult, GcmDecryptResult, CipherInfo, Sign, Verify } from './types';
import { Transform, type TransformOptions } from '../stream';

// Import helpers from helpers.ts
import { toBuffer, toExactArrayBuffer, encodeOutput, concatBuffers, isGcmAlgorithm, normalizeHashAlgorithm, oneShotHmac, isSupportedHmacAlgorithm, readAsymmetricCipherArgs, readKeyOptions, rejectUnsupportedPadding, classifyKeyForP1363, derToP1363, p1363ToDer, keyDetailsFromBytes, kKeyData, kKeyFormat, guessKeyFormat, isKeyObject, type KeyFormat } from './helpers';

function assertCallback(callback: unknown): asserts callback is (...args: unknown[]) => void {
    if (typeof callback !== 'function') {
        const err = new TypeError(
            `The "callback" argument must be of type function. Received ${callback === undefined ? 'undefined' : typeof callback}`,
        ) as TypeError & { code?: string };
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
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
        default: throw withCode(new Error('Invalid EC curve name'), 'ERR_CRYPTO_INVALID_CURVE');
    }
}

type EcdhCurve = 'p256' | 'p384' | 'p521' | 'secp256k1';

function resolveEcdhCurve(curve: string): EcdhCurve {
    if (curve.toLowerCase() === 'secp256k1') return 'secp256k1';
    return resolveCurve(curve);
}

function keyTypeFromPrivate(bytes: Uint8Array): AsymmetricKeyType {
    return crypto.getPrivateKeyType(bytes) as AsymmetricKeyType;
}

function keyTypeFromPublic(bytes: Uint8Array): AsymmetricKeyType {
    return crypto.getPublicKeyType(bytes) as AsymmetricKeyType;
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

/**
 * Sign side: convert the native DER signature to P1363 when the key is EC.
 *
 * Node ignores dsaEncoding for non-EC keys, so an RSA key must get its signature
 * back untouched -- previously it was fed to the EC converter and threw
 * `TypeError: Unable to determine EC key size`, where Node v24.18.0 returns a
 * normal 128-byte PKCS#1 signature. The EC size now comes from the key's curve
 * OID, so a PEM or DER EC key works too; it used to throw for all three curves
 * because no raw byte length matched.
 */
function signatureToP1363(signature: ArrayBuffer, keyBytes: Uint8Array): ArrayBuffer {
    const shape = classifyKeyForP1363(keyBytes);
    if (shape.kind === 'non-ec') return signature;
    if (shape.kind === 'unknown') {
        throw new TypeError('Unable to determine EC key size for ieee-p1363 signature');
    }
    return derToP1363(signature, shape.coordinateSize);
}

function maybeEncodeSignatureForSign(signature: ArrayBuffer, keyInput: KeyInput | KeyWithOptions, outputEncoding?: string): Uint8Array | string {
    const { key, dsaEncoding } = readKeyOptions(keyInput);
    const out = dsaEncoding === 'ieee-p1363' ? signatureToP1363(signature, key) : signature;
    return outputEncoding ? encodeOutput(out, outputEncoding) : Buffer.from(new Uint8Array(out));
}

/**
 * Verify side: turn a P1363 signature into DER, or report that it cannot be one.
 *
 * Returns null for "no signature of this shape can be valid for this key", which
 * the callers turn into `false`. Node never throws for a malformed signature -- it
 * returns false -- and the signature bytes come from the remote peer, so throwing
 * here converted a failed verification into an uncaught exception (measured on 9
 * of 9 malformed-length cases).
 *
 * The length is checked against the KEY's coordinate size, not inferred from the
 * signature. Inferring it from the signature accepted a valid signature
 * zero-extended to any even length -- measured TRUE in cno and FALSE in Node on
 * 12 of 12 crafted cases across P-256/P-384/P-521. That is unbounded signature
 * malleability: one valid signature yields arbitrarily many distinct accepted
 * byte strings, which breaks any caller using signature bytes as a dedup or
 * replay key.
 */
function normalizeSignatureForVerify(signature: BinaryInput, signatureEncoding: string | undefined, keyInput: KeyInput | KeyWithOptions): Uint8Array | null {
    const { key, dsaEncoding } = readKeyOptions(keyInput);
    const sigBuf = toBuffer(signature, signatureEncoding);
    if (dsaEncoding !== 'ieee-p1363') return sigBuf;

    const shape = classifyKeyForP1363(key);
    // Node ignores dsaEncoding for non-EC keys: hand the signature straight to
    // the verifier instead of mangling a valid RSA signature into a false.
    if (shape.kind === 'non-ec') return sigBuf;
    if (shape.kind === 'ec' && sigBuf.length !== shape.coordinateSize * 2) return null;
    // Unknown key shape: keep the old structural requirement, but report a bad
    // length as an invalid signature rather than throwing.
    if (sigBuf.length === 0 || sigBuf.length % 2 !== 0) return null;
    return new Uint8Array(p1363ToDer(sigBuf));
}

function createDigestAlreadyCalledError(): Error {
    const err = new Error('Digest already called') as Error & { code?: string };
    err.code = 'ERR_CRYPTO_HASH_FINALIZED';
    return err;
}

// Node attaches a `.code` to every crypto error; bare Error/TypeError is a
// detectable divergence for callers that branch on err.code.
function withCode<E extends Error>(error: E, code: string): E & { code: string } {
    const err = error as E & { code: string };
    err.code = code;
    return err;
}

function createInvalidIvError(): TypeError {
    return withCode(new TypeError('Invalid initialization vector'), 'ERR_CRYPTO_INVALID_IV');
}

function createInvalidKeyLengthError(): RangeError {
    return withCode(new RangeError('Invalid key length'), 'ERR_CRYPTO_INVALID_KEYLEN');
}

function createUnknownCipherError(algorithm: string): Error {
    return withCode(new Error(`Unknown cipher: ${algorithm}`), 'ERR_CRYPTO_UNKNOWN_CIPHER');
}

// GCM/CBC authentication + padding failures surface as OpenSSL errors in Node.
function createAuthenticationFailedError(): Error {
    return withCode(new Error('Unsupported state or unable to authenticate data'), 'ERR_OSSL_EVP_UNSUPPORTED');
}

function createCipherInvalidStateError(operation: string): Error {
    if (operation === 'update') {
        return withCode(new Error('Trying to add data in unsupported state'), 'ERR_CRYPTO_INVALID_STATE');
    }
    const message = operation === 'final' ? 'Invalid state' : `Invalid state for operation ${operation}`;
    const err = new Error(message) as Error & { code?: string };
    err.code = 'ERR_CRYPTO_INVALID_STATE';
    return err;
}

function createInvalidGcmAuthTagLengthError(length: number): TypeError {
    const err = new TypeError(`Invalid authentication tag length: ${length}`) as TypeError & { code?: string };
    err.code = 'ERR_CRYPTO_INVALID_AUTH_TAG';
    return err;
}

function validateGcmAuthTagLength(length: number | undefined): number | undefined {
    if (length === undefined) return undefined;
    if (length !== 4 && length !== 8 && !(Number.isInteger(length) && length >= 12 && length <= 16)) {
        throw createInvalidGcmAuthTagLengthError(length);
    }
    return length;
}

export class KeyObject implements KeyObjectShape {
    readonly [Symbol.toStringTag] = 'KeyObject' as const;
    readonly type: 'private' | 'public' | 'secret';
    readonly asymmetricKeyType?: AsymmetricKeyType;
    readonly asymmetricKeyDetails?: { namedCurve?: string; modulusLength?: number; publicExponent?: bigint };
    readonly symmetricKeySize?: number;
    [kKeyData]: Uint8Array;
    [kKeyFormat]: KeyFormat;

    constructor(type: 'private' | 'public' | 'secret', asymmetricKeyType: AsymmetricKeyType | undefined, data: BinaryInput, format: KeyFormat, details?: { namedCurve?: string; modulusLength?: number; publicExponent?: bigint }) {
        this.type = type;
        this.asymmetricKeyType = asymmetricKeyType;
        this[kKeyData] = toBuffer(data);
        this[kKeyFormat] = format;
        this.asymmetricKeyDetails = details;
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

type DigestState = {
    update(data: Uint8Array): void;
    digest(): ArrayBuffer;
    copy(): DigestState;
};

type NativeDigest = CModuleCrypto.Hash & { copy(): CModuleCrypto.Hash };

function nativeDigest(factory: () => NativeDigest): DigestState {
    const native = factory();
    return {
        update(data) { native.update(data); },
        digest() { return native.digest(); },
        copy() { return nativeDigest(() => native.copy() as NativeDigest); },
    };
}

function bufferedDigest(fn: (data: Uint8Array) => ArrayBuffer, seed: Uint8Array[] = []): DigestState {
    const chunks = seed.map(chunk => new Uint8Array(chunk));
    return {
        update(data) { chunks.push(new Uint8Array(data)); },
        digest() { return fn(concatBuffers(chunks)); },
        copy() { return bufferedDigest(fn, chunks); },
    };
}

class HashImpl extends Transform implements Hash {
    private readonly state: DigestState;
    private finalized = false;

    constructor(state: DigestState, options?: TransformOptions) {
        super(options);
        this.state = state;
    }

    update(input: BinaryInput, encoding?: string): Hash {
        if (this.finalized) throw createDigestAlreadyCalledError();
        this.state.update(toBuffer(input, encoding));
        return this;
    }

    digest(encoding?: string): Uint8Array | string {
        if (this.finalized) throw createDigestAlreadyCalledError();
        this.finalized = true;
        return encodeOutput(this.state.digest(), encoding);
    }

    copy(options?: TransformOptions): Hash {
        if (this.finalized) throw createDigestAlreadyCalledError();
        return new HashImpl(this.state.copy(), options);
    }

    _transform(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            this.update(chunk as BinaryInput, encoding);
            callback();
        } catch (error) {
            callback(asError(error));
        }
    }

    _flush(callback: (error?: Error | null, data?: unknown) => void): void {
        try {
            callback(null, this.digest());
        } catch (error) {
            callback(asError(error));
        }
    }
}

// createHash

export function createHash(algorithm: string, options?: TransformOptions & { outputLength?: number }): Hash {
    const a = normalizeHashAlgorithm(algorithm);
    const isShake = a === 'shake128' || a === 'shake256';
    if (options?.outputLength !== undefined &&
        (!Number.isInteger(options.outputLength) || options.outputLength < 0 || options.outputLength > 0xffffffff)) {
        throw new RangeError('The value of "options.outputLength" is out of range');
    }
    if (options?.outputLength !== undefined && !isShake) {
        throw new RangeError('outputLength is only supported for SHAKE hash algorithms');
    }
    const streamingAlgos: Record<string, () => NativeDigest> = {
        md5:       () => crypto.createMd5() as NativeDigest,
        ripemd160: () => crypto.createRipemd160() as NativeDigest,
        sha1:      () => crypto.createSha1() as NativeDigest,
        sha224:    () => crypto.createSha224() as NativeDigest,
        sha256:    () => crypto.createSha256() as NativeDigest,
        sha384:    () => crypto.createSha384() as NativeDigest,
        sha512:    () => crypto.createSha512() as NativeDigest,
        sha512224: () => crypto.createSha512_224() as NativeDigest,
        sha512256: () => crypto.createSha512_256() as NativeDigest,
        sha3224:   () => crypto.createSha3_224() as NativeDigest,
        sha3256:   () => crypto.createSha3_256() as NativeDigest,
        sha3384:   () => crypto.createSha3_384() as NativeDigest,
        sha3512:   () => crypto.createSha3_512() as NativeDigest,
        blake2b512:() => crypto.createBlake2b512() as NativeDigest,
        blake2s256:() => crypto.createBlake2s256() as NativeDigest,
    };
    const shakeLength = options?.outputLength;
    const oneshotAlgos: Record<string, (buf: Uint8Array) => ArrayBuffer> = {
        shake128: buf => crypto.shake128(buf, shakeLength),
        shake256: buf => crypto.shake256(buf, shakeLength),
    };
    const factory = streamingAlgos[a];
    if (factory) return new HashImpl(nativeDigest(factory), options);
    const fn = oneshotAlgos[a];
    if (fn) return new HashImpl(bufferedDigest(fn), options);
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

type HmacState = {
    update(data: Uint8Array): void;
    digest(): ArrayBuffer;
};

class HmacImpl extends Transform implements Hmac {
    private readonly state: HmacState;
    private finalized = false;

    constructor(state: HmacState, options?: TransformOptions) {
        super(options);
        this.state = state;
    }

    update(input: BinaryInput, encoding?: string): Hmac {
        if (this.finalized) throw createDigestAlreadyCalledError();
        this.state.update(toBuffer(input, encoding));
        return this;
    }

    // Node's Hmac (unlike Hash) does not throw on digest-after-digest; it
    // returns empty output, because OpenSSL frees the context on first final.
    digest(encoding?: string): Uint8Array | string {
        if (this.finalized) return encodeOutput(new ArrayBuffer(0), encoding);
        this.finalized = true;
        return encodeOutput(this.state.digest(), encoding);
    }

    _transform(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            this.update(chunk as BinaryInput, encoding);
            callback();
        } catch (error) {
            callback(asError(error));
        }
    }

    _flush(callback: (error?: Error | null, data?: unknown) => void): void {
        try {
            callback(null, this.digest());
        } catch (error) {
            callback(asError(error));
        }
    }
}

// createHmac

export function createHmac(algorithm: string, key: KeyInput, options?: TransformOptions): Hmac {
    const keyBuf = isKeyObject(key) ? key[kKeyData] : toBuffer(key);
    const a = normalizeHashAlgorithm(algorithm);
    if (!isSupportedHmacAlgorithm(a)) throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);

    const nativeAlgos: Record<string, () => CModuleCrypto.Hmac> = {
        sha256: () => crypto.createHmacSha256(keyBuf),
        sha512: () => crypto.createHmacSha512(keyBuf),
    };
    // The native streaming HMAC rejects a zero-length key with an InternalError,
    // but Node accepts one (HMAC pads any key, including the empty key, to the
    // block size). The generic one-shot path handles it and matches Node byte
    // for byte, so keep empty keys off the native fast path.
    const nativeFactory = keyBuf.byteLength === 0 ? undefined : nativeAlgos[a];
    if (nativeFactory) {
        const native = nativeFactory();
        return new HmacImpl({
            update(data) { native.update(data); },
            digest() { return native.digest(); },
        }, options);
    }

    const chunks: Uint8Array[] = [];
    return new HmacImpl({
        update(data) { chunks.push(new Uint8Array(data)); },
        digest() { return oneShotHmac(algorithm, keyBuf, concatBuffers(chunks)); },
    }, options);
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

type CipherCore = {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): Uint8Array | string;
    final(outputEncoding?: string): Uint8Array | string;
    setAutoPadding?(value: boolean): void;
    setAAD?(aad: ArrayBuffer | ArrayBufferView): unknown;
    setAuthTag?(tag: ArrayBuffer | ArrayBufferView): unknown;
    getAuthTag?(): Uint8Array;
};
type CipherivWithAutoPadding = CipherCore & { setAutoPadding(value: boolean): void };
type DecipherivWithAutoPadding = CipherCore & { setAutoPadding(value: boolean): void };

type CbcFns = {
    keyLength: number;
    ivLength: number;
    encrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    encryptRaw: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decryptRaw: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => ArrayBuffer;
};

type EcbFns = {
    keyLength: number;
    encrypt: (key: Uint8Array, data: Uint8Array) => ArrayBuffer;
    encryptRaw: (key: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decrypt: (key: Uint8Array, data: Uint8Array) => ArrayBuffer;
    decryptRaw: (key: Uint8Array, data: Uint8Array) => ArrayBuffer;
};

const GCM_KEY_LENGTHS: Record<string, number> = {
    'aes-128-gcm': 16,
    'aes-192-gcm': 24,
    'aes-256-gcm': 32,
};

function toCipherKey(key: KeyInput): Uint8Array {
    if (!isKeyObject(key)) return toBuffer(key);
    if (key.type !== 'secret') throw new TypeError(`Invalid key object type ${key.type}, expected secret`);
    return key[kKeyData];
}

function getEcbFns(algorithm: string): EcbFns {
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
            throw createUnknownCipherError(algorithm);
    }
}

function validateCbcKeyIv(key: Uint8Array, iv: Uint8Array, fns: CbcFns): void {
    if (key.byteLength !== fns.keyLength) throw createInvalidKeyLengthError();
    if (iv.byteLength !== fns.ivLength) throw createInvalidIvError();
}

function makeEcbCipher(key: Uint8Array, fns: EcbFns): CipherivWithAutoPadding {
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
function mapBadDecrypt<T>(operation: () => T): T {
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

function makeEcbDecipher(key: Uint8Array, fns: EcbFns): DecipherivWithAutoPadding {
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
                ? mapBadDecrypt(() => fns.decrypt(key, currentIv, buf))
                : fns.decryptRaw(key, currentIv, buf);
            return encodeOutput(out, outputEncoding);
        },
        setAutoPadding(v: boolean) {
            autoPadding = v;
        },
    };
}

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
        throw withCode(
            new TypeError(`The "size" argument must be of type number. Received type ${typeof size}`),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    if (!Number.isFinite(size) || size < 0 || size > 0x7fffffff) {
        throw withCode(
            new RangeError(`The value of "size" is out of range. It must be >= 0 && <= 2147483647. Received ${size}`),
            'ERR_OUT_OF_RANGE',
        );
    }
    return Math.trunc(size);
}

export function randomBytes(size: number): Buffer;
export function randomBytes(size: number, callback: (err: Error | null, buf: Buffer) => void): void;
export function randomBytes(size: number, callback?: (err: Error | null, buf: Buffer) => void): Buffer | void {
    const length = parseRandomBytesSize(size);
    if (callback !== undefined && typeof callback !== 'function') {
        throw withCode(
            new TypeError(`The "callback" argument must be of type function. Received type ${typeof callback}`),
            'ERR_INVALID_ARG_TYPE',
        );
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
    throw withCode(
        new TypeError(`The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ${typeof value}`),
        'ERR_INVALID_ARG_TYPE',
    );
}

export function timingSafeEqual(a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer): boolean {
    const left = toTimingSafeEqualBytes(a, 'buf1');
    const right = toTimingSafeEqualBytes(b, 'buf2');
    if (left.byteLength !== right.byteLength) {
        throw withCode(
            new RangeError('Input buffers must have the same byte length'),
            'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH',
        );
    }
    // algorithm.bytesEqual is a constant-time XOR accumulate in C (no early exit).
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
    // Node reports asymmetricKeyDetails for parsed keys too, not just generated
    // ones; jsonwebtoken reads .namedCurve off it to validate ES* algorithms.
    return new KeyObject('private', keyTypeFromPrivate(bytes), bytes, format, keyDetailsFromBytes(bytes));
}

export function createSecretKey(key: BinaryInput): KeyObject {
    return new KeyObject('secret', undefined, key, 'raw');
}

// The C layer says "Unsupported key type" only when the key structure parsed
// cleanly and just the algorithm was unclassified, so that error identifies the
// real problem; "Failed to parse ..." means the bytes were not that structure.
function isUnsupportedKeyType(error: unknown): boolean {
    return error instanceof Error && error.message === 'Unsupported key type';
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
        return new KeyObject('public', input.asymmetricKeyType, derived, 'der', input.asymmetricKeyDetails);
    }

    const source = normalizeKeySource(input);
    let publicError: unknown;
    try {
        return new KeyObject('public', keyTypeFromPublic(source.bytes), source.bytes, source.format, keyDetailsFromBytes(source.bytes));
    } catch (error) {
        publicError = error;
    }
    // Node accepts a private key here and derives the public half, so the retry
    // below is load-bearing. But it must not mask the first error: for a public
    // key of an unsupported algorithm the retry reports "Failed to parse private
    // key", which names the wrong key kind AND the wrong operation.
    // Exactly one of the two attempts reports "Unsupported key type" -- the one
    // whose structure actually parsed -- and that is the accurate diagnosis, so
    // prefer it in whichever direction it appears.
    try {
        const asym = keyTypeFromPrivate(source.bytes);
        const derived = new Uint8Array(crypto.derivePublicKeyDer(source.bytes));
        // Details come from the ORIGINAL private bytes: the derived SPKI is
        // equivalent, but reading what we were handed avoids depending on the
        // derivation preserving the algorithm parameters.
        return new KeyObject('public', asym, derived, 'der', keyDetailsFromBytes(source.bytes));
    } catch (privateError) {
        throw isUnsupportedKeyType(privateError) ? privateError : publicError;
    }
}

type KeyEncodingSpec = { type?: 'spki' | 'pkcs8'; format?: 'pem' | 'der' | 'jwk' };

type GenerateKeyPairOptions = {
    modulusLength?: number;
    namedCurve?: string;
    paramEncoding?: string;
    publicKeyEncoding?: KeyEncodingSpec;
    privateKeyEncoding?: KeyEncodingSpec;
};

/* ---------------------------------------------------------------------------
 * RFC 8410 key generation (X25519, X448, Ed25519, Ed448).
 *
 * The native layer exposes keygen only for RSA and four EC curves, so there is
 * no C entry point to call for these algorithms. It does not need one: for the
 * RFC 8410 curves the private key IS a fixed-length string of uniform random
 * bytes. There are no parameters to generate, no primality testing, and no
 * validity condition to satisfy -- every byte string of the right length is a
 * valid private key, because the algorithms clamp/hash the scalar internally.
 *
 * So a keypair is `randomBytes(seed)` wrapped in the PKCS#8 structure, and the
 * public half comes from the *existing* generic native derive path, which
 * already classifies and handles all nine key types. This is why the fix lives
 * here and not in C.
 *
 * The seed lengths are the CurvePrivateKey sizes from RFC 8410 s.7, and the
 * resulting DER was checked byte-for-byte against Node v24.18.0's own PKCS#8
 * output for each of the four types.
 * ------------------------------------------------------------------------- */
const RFC8410_KEY_TYPES: Record<string, { oid: readonly number[]; seedLength: number }> = {
    // OID content octets, i.e. 1.3.101.{110,111,112,113} minus the DER header.
    x25519: { oid: [0x2b, 0x65, 0x6e], seedLength: 32 },
    x448: { oid: [0x2b, 0x65, 0x6f], seedLength: 56 },
    ed25519: { oid: [0x2b, 0x65, 0x70], seedLength: 32 },
    ed448: { oid: [0x2b, 0x65, 0x71], seedLength: 57 },
};

function isRfc8410KeyType(type: string): boolean {
    return Object.prototype.hasOwnProperty.call(RFC8410_KEY_TYPES, type);
}

/**
 * Encode a OneAsymmetricKey (PKCS#8) for an RFC 8410 algorithm:
 *
 *   SEQUENCE {
 *     INTEGER 0,                                  -- version
 *     SEQUENCE { OBJECT IDENTIFIER algorithm },   -- no parameters, by RFC 8410
 *     OCTET STRING {                              -- privateKey
 *       OCTET STRING seed                         -- CurvePrivateKey
 *     }
 *   }
 *
 * The lengths are computed rather than transcribed so the encoding cannot drift
 * from the seed length. Every length here is < 128, so DER short-form is
 * correct; the assertion below is what keeps that assumption honest if a future
 * curve with a larger seed is added to the table.
 */
function buildRfc8410Pkcs8(oid: readonly number[], seed: Uint8Array): Uint8Array {
    const algorithm = [0x30, oid.length + 2, 0x06, oid.length, ...oid];
    const curvePrivateKey = [0x04, seed.length, ...seed];
    const privateKey = [0x04, curvePrivateKey.length, ...curvePrivateKey];
    const body = [0x02, 0x01, 0x00, ...algorithm, ...privateKey];
    if (body.length > 0x7f) {
        throw new Error('RFC 8410 PKCS#8 body exceeds DER short-form length');
    }
    return new Uint8Array([0x30, body.length, ...body]);
}

function generateRfc8410KeyPair(type: string): { publicKey: KeyObject; privateKey: KeyObject } {
    const spec = RFC8410_KEY_TYPES[type] as { oid: readonly number[]; seedLength: number };
    const pkcs8 = buildRfc8410Pkcs8(spec.oid, randomBytes(spec.seedLength));
    // Derive through the native path rather than deriving in JS: it is the same
    // code that already produces SPKI for imported keys, so a generated key and
    // an imported key cannot disagree about the public half.
    const spki = new Uint8Array(crypto.derivePublicKeyDer(pkcs8));
    // Node reports an empty details object for these types, not undefined.
    return {
        publicKey: new KeyObject('public', type as AsymmetricKeyType, spki, 'der', {}),
        privateKey: new KeyObject('private', type as AsymmetricKeyType, pkcs8, 'der', {}),
    };
}

// Node validates the key type and curve synchronously, even for the async form.
function validateKeyPairArgs(type: string, options: GenerateKeyPairOptions | undefined): void {
    // Node ignores options entirely for these -- including a bogus namedCurve --
    // and accepts the call with no options argument at all (measured on v24.18.0).
    if (isRfc8410KeyType(type)) return;
    if (type === 'rsa') return;
    if (type === 'ec') {
        if (options?.paramEncoding === 'explicit') {
            throw new Error('Explicit EC parameter encoding is not supported');
        }
        if (typeof options?.namedCurve !== 'string') {
            throw withCode(
                new TypeError(`The "options.namedCurve" property must be of type string. Received ${options?.namedCurve === undefined ? 'undefined' : typeof options.namedCurve}`),
                'ERR_INVALID_ARG_TYPE',
            );
        }
        resolveCurve(options.namedCurve);
        return;
    }
    throw withCode(
        new TypeError(`The argument 'type' must be a supported key type. Received '${type}'`),
        'ERR_INVALID_ARG_VALUE',
    );
}

function generateKeyPairSyncImpl(type: string, options: GenerateKeyPairOptions | undefined): { publicKey: KeyObject; privateKey: KeyObject } {
    validateKeyPairArgs(type, options);

    if (isRfc8410KeyType(type)) {
        return generateRfc8410KeyPair(type);
    }

    if (type === 'rsa') {
        const modulusLength = options?.modulusLength || 2048;
        const keyPair = crypto.generateRsaKey(modulusLength);
        // Node reports details on generated RSA keys too. The C generator always
        // uses F4, and reading the bytes back would only re-derive what we asked
        // for, so state it directly.
        const details = { modulusLength, publicExponent: 65537n };
        return {
            publicKey: new KeyObject('public', 'rsa', keyPair.publicKey, 'pem', details),
            privateKey: new KeyObject('private', 'rsa', keyPair.privateKey, 'pem', details),
        };
    }

    if (type === 'ec') {
        // validateKeyPairArgs already rejected a missing/unknown curve.
        const namedCurve = (options as GenerateKeyPairOptions).namedCurve as string;
        const curve = resolveCurve(namedCurve);
        let keyPair: CModuleCrypto.EcKeyPair;

        switch (curve) {
            case 'p256': keyPair = crypto.generateEcKeyP256(); break;
            case 'p384': keyPair = crypto.generateEcKeyP384(); break;
            case 'p521': keyPair = crypto.generateEcKeyP521(); break;
        }

        return {
            publicKey: new KeyObject('public', 'ec', keyPair.publicKey, 'raw', { namedCurve }),
            privateKey: new KeyObject('private', 'ec', keyPair.privateKey, 'raw', { namedCurve }),
        };
    }

    throw withCode(
        new TypeError(`The argument 'type' must be a supported key type. Received '${type}'`),
        'ERR_INVALID_ARG_VALUE',
    );
}

type Rfc8410KeyType = 'x25519' | 'x448' | 'ed25519' | 'ed448';

/**
 * Apply `publicKeyEncoding` / `privateKeyEncoding` to a generated pair.
 *
 * These options were accepted (they pass validation) and then ignored, so
 * generateKeyPair always handed back KeyObjects. Node returns the ENCODED key
 * whenever the corresponding spec is present -- a string for `format:'pem'`, a
 * Buffer for `'der'` -- and each key is decided independently, so supplying only
 * `publicKeyEncoding` yields a string public key beside a KeyObject private key.
 *
 * Ignoring them fails silently rather than loudly: `writeFileSync('key.pem', privateKey)`
 * writes "[object Object]" and `String(privateKey)` is not a PEM, so the key
 * cannot be read back -- measured as `createPrivateKey(String(generated))` ->
 * "Failed to parse private key". Every library that persists a generated key
 * takes this path.
 */
function encodeGeneratedKey(key: KeyObject, spec: KeyEncodingSpec | undefined): KeyObject | string | Uint8Array {
    if (!spec || spec.format === undefined) return key;
    if (spec.format === 'jwk') {
        // Node returns a JWK object here. KeyObject.export already implements it,
        // and its return type is deliberately not narrowed to the two byte forms.
        return key.export({ format: 'jwk' }) as unknown as Uint8Array;
    }
    const type = spec.type ?? (key.type === 'private' ? 'pkcs8' : 'spki');
    return key.export({ type, format: spec.format }) as string | Uint8Array;
}

export function generateKeyPairSync(type: 'rsa', options: { modulusLength: number }): { publicKey: KeyObject; privateKey: KeyObject };
export function generateKeyPairSync(type: 'ec', options: { namedCurve: string }): { publicKey: KeyObject; privateKey: KeyObject };
export function generateKeyPairSync(type: Rfc8410KeyType, options?: GenerateKeyPairOptions): { publicKey: KeyObject; privateKey: KeyObject };
export function generateKeyPairSync(type: string, options?: GenerateKeyPairOptions): { publicKey: KeyObject; privateKey: KeyObject } {
    const pair = generateKeyPairSyncImpl(type, options);
    // The overloads above keep declaring KeyObject because callers that pass no
    // encoding -- the common case, and every internal use -- still get one. The
    // encoded forms are what node returns when an encoding IS supplied.
    return {
        publicKey: encodeGeneratedKey(pair.publicKey, options?.publicKeyEncoding) as KeyObject,
        privateKey: encodeGeneratedKey(pair.privateKey, options?.privateKeyEncoding) as KeyObject,
    };
}

type GenerateKeyPairCallback = (err: Error | null, publicKey?: KeyObject, privateKey?: KeyObject) => void;

export function generateKeyPair(type: 'rsa', options: { modulusLength: number }, callback: GenerateKeyPairCallback): void;
export function generateKeyPair(type: 'ec', options: { namedCurve: string }, callback: GenerateKeyPairCallback): void;
export function generateKeyPair(type: Rfc8410KeyType, callback: GenerateKeyPairCallback): void;
export function generateKeyPair(type: Rfc8410KeyType, options: GenerateKeyPairOptions | undefined, callback: GenerateKeyPairCallback): void;
export function generateKeyPair(
    type: string,
    optionsOrCallback: GenerateKeyPairOptions | GenerateKeyPairCallback | undefined,
    maybeCallback?: GenerateKeyPairCallback,
): void {
    // Node accepts generateKeyPair(type, callback) for the types that take no
    // options, so the second argument has to be probed rather than assumed.
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    assertCallback(callback);
    validateKeyPairArgs(type, options);
    queueMicrotask(() => {
        let result: { publicKey: KeyObject; privateKey: KeyObject };
        try {
            result = generateKeyPairSyncImpl(type, options);
        } catch (err) {
            callback(asError(err));
            return;
        }
        callback(null, encodeGeneratedKey(result.publicKey, options?.publicKeyEncoding) as KeyObject, encodeGeneratedKey(result.privateKey, options?.privateKeyEncoding) as KeyObject);
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
            const { key, padding } = readKeyOptions(privateKey);
            // The one-shot crypto.sign() guards padding, but this streaming path
            // read only `key` and dropped `padding`, so createSign(...).sign({
            // key, padding: RSA_PKCS1_PSS_PADDING }) silently produced a PKCS#1
            // v1.5 signature. Measured on the 21:53 binary against Node v24.18.0.
            rejectUnsupportedPadding(padding, 'sign');
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
            const { key, padding } = readKeyOptions(publicKey);
            // Same hole as createSign above, and worse on this side: dropping
            // `padding` made createVerify(...).verify({ key, padding: PSS }, sig)
            // return TRUE for a PKCS#1 v1.5 signature — a signature-scheme
            // confusion. Node v24.18.0 returns false. OBSERVED, then fixed.
            rejectUnsupportedPadding(padding, 'verify');
            const sigBuf = normalizeSignatureForVerify(signature, signatureEncoding, publicKey);
            const allData = concatBuffers(data);
            data = [];
            // null means the signature cannot be valid for this key (wrong P1363
            // length). Node returns false for that; it does not throw.
            if (sigBuf === null) return false;

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
    const { key: keyBuf, padding } = readKeyOptions(key);
    rejectUnsupportedPadding(padding, 'sign');
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
    const { key: keyBuf, padding } = readKeyOptions(key);
    rejectUnsupportedPadding(padding, 'verify');
    const sigBuf = normalizeSignatureForVerify(signature, undefined, key);
    // null means the signature cannot be valid for this key (wrong P1363
    // length). Node returns false for that; it does not throw.
    if (sigBuf === null) return false;

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

    const c = resolveEcdhCurve(curve);
    switch (c) {
        case 'p256': return crypto.ecdhDeriveP256(privBuf, pubBuf);
        case 'p384': return crypto.ecdhDeriveP384(privBuf, pubBuf);
        case 'p521': return crypto.ecdhDeriveP521(privBuf, pubBuf);
        case 'secp256k1': return crypto.ecdhDeriveSecp256k1(privBuf, pubBuf);
    }
}

type EcdhPointFormat = 'compressed' | 'uncompressed' | 'hybrid';
type EcdhNative = {
    generate(): CModuleCrypto.EcKeyPair;
    derive(privateKey: Uint8Array, publicKey: Uint8Array): ArrayBuffer;
    publicFromPrivate(privateKey: Uint8Array, format: number): ArrayBuffer;
    convertPublic(publicKey: Uint8Array, format: number): ArrayBuffer;
};

function pointFormatValue(format: EcdhPointFormat = 'uncompressed'): number {
    switch (format) {
        case 'compressed': return 2;
        case 'uncompressed': return 4;
        case 'hybrid': return 6;
        default: throw new TypeError(`Invalid ECDH format: ${String(format)}`);
    }
}

function ecdhNative(curve: EcdhCurve): EcdhNative {
    switch (curve) {
        case 'p256': return {
            generate: crypto.generateEcKeyP256,
            derive: crypto.ecdhDeriveP256,
            publicFromPrivate: crypto.ecPublicFromPrivateP256,
            convertPublic: crypto.ecConvertPublicP256,
        };
        case 'p384': return {
            generate: crypto.generateEcKeyP384,
            derive: crypto.ecdhDeriveP384,
            publicFromPrivate: crypto.ecPublicFromPrivateP384,
            convertPublic: crypto.ecConvertPublicP384,
        };
        case 'p521': return {
            generate: crypto.generateEcKeyP521,
            derive: crypto.ecdhDeriveP521,
            publicFromPrivate: crypto.ecPublicFromPrivateP521,
            convertPublic: crypto.ecConvertPublicP521,
        };
        case 'secp256k1': return {
            generate: crypto.generateEcKeySecp256k1,
            derive: crypto.ecdhDeriveSecp256k1,
            publicFromPrivate: crypto.ecPublicFromPrivateSecp256k1,
            convertPublic: crypto.ecConvertPublicSecp256k1,
        };
    }
}

function encodeEcdhOutput(data: ArrayBuffer | Uint8Array, encoding?: string): Buffer | string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return encodeOutput(toExactArrayBuffer(bytes), encoding);
}

export class ECDH {
    private readonly curve: EcdhCurve;
    private readonly native: EcdhNative;
    private privateKey?: Uint8Array;
    private publicKey?: Uint8Array;

    constructor(curve: string) {
        this.curve = resolveEcdhCurve(curve);
        this.native = ecdhNative(this.curve);
    }

    static convertKey(key: BinaryInput, curve: string, inputEncoding?: string, outputEncoding?: string, format?: EcdhPointFormat): Buffer | string {
        const native = ecdhNative(resolveEcdhCurve(curve));
        return encodeEcdhOutput(native.convertPublic(toBuffer(key, inputEncoding), pointFormatValue(format)), outputEncoding);
    }

    generateKeys(encoding?: string, format?: EcdhPointFormat): Buffer | string {
        const keyPair = this.native.generate();
        this.privateKey = new Uint8Array(keyPair.privateKey);
        this.publicKey = new Uint8Array(keyPair.publicKey);
        return this.getPublicKey(encoding, format);
    }

    computeSecret(otherPublicKey: BinaryInput, inputEncoding?: string, outputEncoding?: string): Buffer | string {
        if (!this.privateKey) throw new Error('Private key is not set');
        const peer = toBuffer(otherPublicKey, inputEncoding);
        try {
            return encodeEcdhOutput(this.native.derive(this.privateKey, peer), outputEncoding);
        } catch (error) {
            const invalid = new Error('Public key is not valid for specified curve') as Error & { code?: string };
            invalid.code = 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY';
            (invalid as Error & { cause?: unknown }).cause = error;
            throw invalid;
        }
    }

    getPrivateKey(encoding?: string): Buffer | string {
        if (!this.privateKey) throw new Error('Private key is not set');
        return encodeEcdhOutput(this.privateKey, encoding);
    }

    getPublicKey(encoding?: string, format?: EcdhPointFormat): Buffer | string {
        if (!this.publicKey) throw new Error('Public key is not set');
        const converted = this.native.convertPublic(this.publicKey, pointFormatValue(format));
        return encodeEcdhOutput(converted, encoding);
    }

    setPrivateKey(privateKey: BinaryInput, encoding?: string): void {
        const key = new Uint8Array(toBuffer(privateKey, encoding));
        const publicKey = this.native.publicFromPrivate(key, pointFormatValue());
        this.privateKey = key;
        this.publicKey = new Uint8Array(publicKey);
    }

    setPublicKey(publicKey: BinaryInput, encoding?: string): void {
        const key = this.native.convertPublic(toBuffer(publicKey, encoding), pointFormatValue());
        this.publicKey = new Uint8Array(key);
    }
}

export function createECDH(curve: string): ECDH {
    return new ECDH(curve);
}

export function getCurves(): string[] {
    return ['prime256v1', 'secp256r1', 'secp384r1', 'secp521r1', 'secp256k1'];
}

export function diffieHellman(options: { privateKey: KeyObject; publicKey: KeyObject }): Buffer {
    const privateKey = options?.privateKey;
    const publicKey = options?.publicKey;
    if (!isKeyObject(privateKey) || privateKey.type !== 'private') {
        throw new TypeError('options.privateKey must be a private KeyObject');
    }
    if (!isKeyObject(publicKey) || publicKey.type !== 'public') {
        throw new TypeError('options.publicKey must be a public KeyObject');
    }

    const privateCurve = privateKey.asymmetricKeyDetails?.namedCurve;
    const publicCurve = publicKey.asymmetricKeyDetails?.namedCurve;
    if (!privateCurve || !publicCurve || resolveEcdhCurve(privateCurve) !== resolveEcdhCurve(publicCurve) ||
        privateKey[kKeyFormat] !== 'raw' || publicKey[kKeyFormat] !== 'raw') {
        throw new TypeError('Only raw EC KeyObjects are supported by diffieHellman');
    }
    return Buffer.from(new Uint8Array(ecdhComputeSecret(privateCurve, privateKey[kKeyData], publicKey[kKeyData])));
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
    RSA_X931_PADDING: 5,
    // PSS was missing, and its absence was a real padding-scheme DOWNGRADE, not
    // just a missing constant. Measured on the 17:41 binary: because
    // `RSA_PKCS1_PSS_PADDING` was `undefined`, `sign/verify({ padding:
    // constants.RSA_PKCS1_PSS_PADDING })` passed `padding: undefined`, which
    // falls back to PKCS#1 v1.5 — so a PKCS1 signature VERIFIED TRUE against a
    // caller explicitly asking for PSS. Real Node returns false there. Code that
    // opted in to PSS silently got the legacy scheme.
    // Values checked against Node v24.18.0; SALTLEN_AUTO and MAX_SIGN are both -2
    // upstream, and RSA_SSLV23_PADDING is genuinely absent in Node so it is not
    // added here.
    RSA_PKCS1_PSS_PADDING: 6,
    RSA_PSS_SALTLEN_DIGEST: -1,
    RSA_PSS_SALTLEN_MAX_SIGN: -2,
    RSA_PSS_SALTLEN_AUTO: -2,
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
        'shake128',
        'shake256',
    ];
}

export function getCiphers(): string[] {
    return [
        'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc',
        'aes-128-ecb', 'aes-192-ecb', 'aes-256-ecb',
        'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
    ];
}

const CIPHER_INFO: Record<string, CipherInfo> = {
    'aes-128-cbc': { name: 'aes-128-cbc', nid: 0, blockSize: 16, ivLength: 16, keyLength: 16, mode: 'cbc' },
    'aes-192-cbc': { name: 'aes-192-cbc', nid: 0, blockSize: 16, ivLength: 16, keyLength: 24, mode: 'cbc' },
    'aes-256-cbc': { name: 'aes-256-cbc', nid: 0, blockSize: 16, ivLength: 16, keyLength: 32, mode: 'cbc' },
    'aes-128-ecb': { name: 'aes-128-ecb', nid: 0, blockSize: 16, ivLength: 0, keyLength: 16, mode: 'ecb' },
    'aes-192-ecb': { name: 'aes-192-ecb', nid: 0, blockSize: 16, ivLength: 0, keyLength: 24, mode: 'ecb' },
    'aes-256-ecb': { name: 'aes-256-ecb', nid: 0, blockSize: 16, ivLength: 0, keyLength: 32, mode: 'ecb' },
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
