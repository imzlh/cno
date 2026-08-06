/**
 * Web Crypto API (SubtleCrypto) implementation for txiki.js
 * Based on W3C Web Cryptography API specification
 */

import { DOMException } from "./events";

const crypto = import.meta.use('crypto');
const algo = import.meta.use('algorithm');
const engine = import.meta.use('engine');

// Type Definitions

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
interface RuntimeSubtleCrypto {
    digest(algorithm: HashAlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
    generateKey(algorithm: AlgorithmIdentifier, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKeyPair | CryptoKey>;
    sign(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
    verify(algorithm: AlgorithmIdentifier, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean>;
    encrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
    decrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
    deriveKey(algorithm: AlgorithmIdentifier, baseKey: CryptoKey, derivedKeyAlgorithm: AlgorithmIdentifier, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
    deriveBits(algorithm: AlgorithmIdentifier, baseKey: CryptoKey, length: number | null): Promise<ArrayBuffer>;
    importKey(format: string, keyData: BufferSource | JsonWebKey, algorithm: AlgorithmIdentifier, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
    exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer | JsonWebKey>;
    wrapKey(format: string, key: CryptoKey, wrappingKey: CryptoKey, wrapAlgorithm: AlgorithmIdentifier): Promise<ArrayBuffer>;
    unwrapKey(format: string, wrappedKey: BufferSource, unwrappingKey: CryptoKey, unwrapAlgorithm: AlgorithmIdentifier, unwrappedKeyAlgorithm: AlgorithmIdentifier, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
}

type RuntimeCrypto = Omit<Crypto, 'subtle'> & {
    subtle: RuntimeSubtleCrypto;
    digest(algorithm: HashAlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
};

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

// Utility Functions

function toArrayBuffer(source: BufferSource): ArrayBuffer {
    if (source instanceof ArrayBuffer) return source;
    const v = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    if (v instanceof ArrayBuffer) return v;
    throw new Error('Unsupported buffer source');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringArrayField(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}

function jsonWebKeyFromUnknown(value: unknown): JsonWebKey {
    if (!isRecord(value)) throw new Error('Invalid JWK data');
    const jwk: JsonWebKey = {};
    for (const key of ['kty', 'k', 'alg', 'crv', 'x', 'y', 'd', 'n', 'e'] as const) {
        const field = value[key];
        if (typeof field === 'string') jwk[key] = field;
    }
    if (typeof value.ext === 'boolean') jwk.ext = value.ext;
    const keyOps = stringArrayField(value.key_ops);
    if (keyOps) jwk.key_ops = keyOps;
    return jwk;
}

function exportKeyBytes(format: string, exportedKey: ArrayBuffer | JsonWebKey): BufferSource {
    if (format === 'jwk') return engine.encodeString(JSON.stringify(exportedKey));
    if (exportedKey instanceof ArrayBuffer) return exportedKey;
    throw new Error(`Unsupported wrapped key export format: ${format}`);
}

function importKeyData(format: string, decryptedKey: ArrayBuffer): BufferSource | JsonWebKey {
    if (format !== 'jwk') return decryptedKey;
    return jsonWebKeyFromUnknown(JSON.parse(engine.decodeString(new Uint8Array(decryptedKey))));
}

function normalizeAlgorithm(algorithm: AlgorithmIdentifier): Algorithm {
    if (typeof algorithm === 'string') {
        return { name: algorithm.toUpperCase() };
    }
    return { ...algorithm, name: algorithm.name.toUpperCase() };
}

function algorithmLength(algorithm: Algorithm): number | undefined {
    const value = (algorithm as Algorithm & { length?: unknown }).length;
    return typeof value === 'number' ? value : undefined;
}

const HASH_FUNCTIONS: Record<string, (data: ArrayBuffer) => ArrayBuffer> = {
    'SHA-1': crypto.sha1,
    'SHA-256': crypto.sha256,
    'SHA-384': crypto.sha384,
    'SHA-512': crypto.sha512,
    'SHA3-224': crypto.sha3_224,
    'SHA3-256': crypto.sha3_256,
    'SHA3-384': crypto.sha3_384,
    'SHA3-512': crypto.sha3_512,
};

function getHashFunction(algorithm: HashAlgorithmIdentifier): (data: ArrayBuffer) => ArrayBuffer {
    const normalized = typeof algorithm === 'string' ? algorithm.toUpperCase() : normalizeAlgorithm(algorithm).name;
    const fn = HASH_FUNCTIONS[normalized];
    // WebCrypto requires NotSupportedError, not a bare Error.
    if (!fn) throw new DOMException(`Unrecognized algorithm name: ${normalized}`, 'NotSupportedError');
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

function getHmacDefaultLength(algorithm: HashAlgorithmIdentifier): number {
    const normalized = typeof algorithm === 'string' ? algorithm.toUpperCase() : normalizeAlgorithm(algorithm).name;
    return normalized === 'SHA-384' || normalized === 'SHA-512' ? 1024 : 512;
}

function hmacJwkAlg(hash: HashAlgorithmIdentifier): string | undefined {
    const normalized = typeof hash === 'string' ? hash.toUpperCase() : normalizeAlgorithm(hash).name;
    if (normalized === 'SHA-1') return 'HS1';
    if (normalized === 'SHA-256') return 'HS256';
    if (normalized === 'SHA-384') return 'HS384';
    if (normalized === 'SHA-512') return 'HS512';
    return undefined;
}

function jwkHashAlg(alg: unknown): HashAlgorithmIdentifier | undefined {
    if (alg === 'HS1') return 'SHA-1';
    if (alg === 'HS256') return 'SHA-256';
    if (alg === 'HS384') return 'SHA-384';
    if (alg === 'HS512') return 'SHA-512';
    return undefined;
}

function deriveKeyLength(algorithm: Algorithm): number {
    const explicit = algorithmLength(algorithm);
    if (explicit !== undefined) return explicit;
    if (algorithm.name === 'HMAC') return getHmacDefaultLength((algorithm as HmacKeyGenParams).hash);
    return 256;
}

function ecCurveBits(curve: string): number {
    if (curve === 'P-256') return 256;
    if (curve === 'P-384') return 384;
    if (curve === 'P-521') return 521;
    throw new Error(`Unsupported curve: ${curve}`);
}

// WebCrypto ECDSA signatures are fixed-width r||s: the spec calls for the
// concatenation of r and s, each padded to the byte length of the curve order.
// The C layer emits and expects DER because node:crypto's EC contract is DER, so
// the conversion belongs at this boundary and not in mod_crypto.c.
const EC_COORD_BYTES: Record<string, number> = {
    'P-256': 32,
    'P-384': 48,
    'P-521': 66,   // ceil(521/8)
};

function ecCoordBytes(curve: string): number {
    const n = EC_COORD_BYTES[curve];
    if (n === undefined) {
        throw new DOMException(`Unsupported curve: ${curve}`, 'NotSupportedError');
    }
    return n;
}

// DER SEQUENCE { INTEGER r, INTEGER s }  ->  r||s, each left-padded to coordLen.
function ecdsaDerToRaw(der: ArrayBuffer, coordLen: number): ArrayBuffer {
    const d = new Uint8Array(der);
    let i = 0;
    const bad = () => new DOMException('Invalid ECDSA signature', 'OperationError');
    if (d[i++] !== 0x30) throw bad();
    let seqLen = d[i++];
    if (seqLen & 0x80) {                       // long-form length (P-521)
        const n = seqLen & 0x7f;
        if (n === 0 || n > 2) throw bad();
        seqLen = 0;
        for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | d[i++];
    }
    if (i + seqLen !== d.length) throw bad();
    const readInt = (): Uint8Array => {
        if (d[i++] !== 0x02) throw bad();
        const len = d[i++];
        if (len === 0 || i + len > d.length) throw bad();
        let v = d.subarray(i, i + len);
        i += len;
        let z = 0;
        while (z < v.length - 1 && v[z] === 0) z++;   // drop DER sign padding
        v = v.subarray(z);
        if (v.length > coordLen) throw bad();
        const out = new Uint8Array(coordLen);
        out.set(v, coordLen - v.length);              // left-pad
        return out;
    };
    const r = readInt();
    const s = readInt();
    if (i !== d.length) throw bad();
    const out = new Uint8Array(coordLen * 2);
    out.set(r, 0);
    out.set(s, coordLen);
    return out.buffer;
}

// r||s  ->  DER SEQUENCE { INTEGER r, INTEGER s }.
function ecdsaRawToDer(raw: ArrayBuffer, coordLen: number): ArrayBuffer {
    const u = new Uint8Array(raw);
    if (u.length !== coordLen * 2) {
        throw new DOMException('Invalid ECDSA signature', 'OperationError');
    }
    const encodeInt = (v: Uint8Array): Uint8Array => {
        let z = 0;
        while (z < v.length - 1 && v[z] === 0) z++;   // minimal encoding
        const body = v.subarray(z);
        const pad = (body[0] & 0x80) !== 0 ? 1 : 0;   // DER INTEGER is signed
        const out = new Uint8Array(2 + pad + body.length);
        out[0] = 0x02;
        out[1] = pad + body.length;
        out.set(body, 2 + pad);
        return out;
    };
    const r = encodeInt(u.subarray(0, coordLen));
    const s = encodeInt(u.subarray(coordLen));
    const bodyLen = r.length + s.length;
    // P-521 bodies exceed 127 bytes and need the long form.
    const header = bodyLen < 0x80 ? 2 : 3;
    const out = new Uint8Array(header + bodyLen);
    out[0] = 0x30;
    if (bodyLen < 0x80) {
        out[1] = bodyLen;
    } else {
        out[1] = 0x81;
        out[2] = bodyLen;
    }
    out.set(r, header);
    out.set(s, header + r.length);
    return out.buffer;
}

function normalizeDeriveBitsLength(length: number | null, defaultLength: number | null): number {
    if (length === null && defaultLength === null) {
        throw new DOMException('Invalid length', 'OperationError');
    }
    const bits = length === null ? defaultLength : Number(length);
    if (bits === null) {
        throw new DOMException('Invalid length', 'OperationError');
    }
    if (!Number.isFinite(bits) || bits < 0 || Math.trunc(bits) !== bits || bits % 8 !== 0) {
        throw new DOMException('Invalid length', 'OperationError');
    }
    return bits;
}

function normalizeGcmTagLength(length: number | undefined): number {
    const bits = length ?? 128;
    if (![32, 64, 96, 104, 112, 120, 128].includes(bits)) {
        throw new DOMException('Invalid AES-GCM tag length', 'OperationError');
    }
    return bits / 8;
}

function invalidAccess(message: string): DOMException {
    return new DOMException(message, 'InvalidAccessError');
}

// Per WebCrypto, importKey must reject usages the algorithm cannot support,
// and secret/private keys may not be imported with an empty usage list.
const ALGORITHM_USAGES: Record<string, KeyUsage[]> = {
    'HMAC': ['sign', 'verify'],
    'AES-CBC': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    'AES-GCM': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    'AES-KW': ['wrapKey', 'unwrapKey'],
    'PBKDF2': ['deriveKey', 'deriveBits'],
    'HKDF': ['deriveKey', 'deriveBits'],
    'RSASSA-PKCS1-V1_5': ['sign', 'verify'],
    'RSA-PSS': ['sign', 'verify'],
    'RSA-OAEP': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    'ECDSA': ['sign', 'verify'],
    'ECDH': ['deriveKey', 'deriveBits'],
};

function describeUsageAlgorithm(name: string): string {
    if (name === 'HMAC') return 'HMAC key';
    if (name.startsWith('AES')) return 'an AES key';
    return `a ${name} key`;
}

function validateKeyUsages(
    algorithmName: string,
    usages: KeyUsage[],
    requireNonEmpty: boolean,
    context: string = 'importing a secret key'
): void {
    if (!Array.isArray(usages)) {
        throw new DOMException('Key usages must be an array', 'SyntaxError');
    }
    if (requireNonEmpty && usages.length === 0) {
        throw new DOMException(`Usages cannot be empty when ${context}.`, 'SyntaxError');
    }
    const allowed = ALGORITHM_USAGES[algorithmName];
    if (!allowed) return;
    for (const usage of usages) {
        if (!allowed.includes(usage)) {
            throw new DOMException(`Unsupported key usage for ${describeUsageAlgorithm(algorithmName)}`, 'SyntaxError');
        }
    }
}

function operationError(error: unknown, fallback: string): DOMException {
    if (error instanceof DOMException) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new DOMException(message || fallback, 'OperationError');
}

function runOperation<T>(operation: () => T, fallback: string): T {
    try {
        return operation();
    } catch (error) {
        throw operationError(error, fallback);
    }
}

function pbkdf2Sha1(password: ArrayBuffer, salt: ArrayBuffer, iterations: number, keylen: number): ArrayBuffer {
    if (iterations < 1 || keylen < 1) {
        throw new DOMException('Invalid PBKDF2 parameters', 'OperationError');
    }

    const hashLen = 20;
    const blocks = Math.ceil(keylen / hashLen);
    const out = new Uint8Array(blocks * hashLen);
    const saltBytes = new Uint8Array(salt);

    for (let block = 1; block <= blocks; block++) {
        const input = new Uint8Array(saltBytes.length + 4);
        input.set(saltBytes);
        input[input.length - 4] = (block >>> 24) & 0xff;
        input[input.length - 3] = (block >>> 16) & 0xff;
        input[input.length - 2] = (block >>> 8) & 0xff;
        input[input.length - 1] = block & 0xff;

        let u = new Uint8Array(crypto.hmacSha1(password, input));
        const t = new Uint8Array(u);

        for (let i = 1; i < iterations; i++) {
            u = new Uint8Array(crypto.hmacSha1(password, u));
            for (let j = 0; j < hashLen; j++) {
                t[j] ^= u[j];
            }
        }

        out.set(t, (block - 1) * hashLen);
    }

    return out.slice(0, keylen).buffer;
}

// CryptoKey Implementation

// Key bytes live outside the object graph so they are not an own property and
// cannot be reached by Object.keys/getOwnPropertyDescriptors/structuredClone or
// dumped by a debug log. Membership in this map is also the brand: only _create
// inserts, so a duck-typed literal can never satisfy handleOf().
const KEY_HANDLES = new WeakMap<object, ArrayBuffer>();

class CryptoKeyImpl implements CryptoKey {
    static #allowConstruct = false;
    #type: KeyType;
    #extractable: boolean;
    #algorithm: KeyAlgorithm;
    #usages: readonly KeyUsage[];

    static _create(
        type: KeyType,
        extractable: boolean,
        algorithm: KeyAlgorithm,
        usages: KeyUsage[],
        handle: ArrayBuffer
    ): CryptoKeyImpl {
        CryptoKeyImpl.#allowConstruct = true;
        try {
            const key = new CryptoKeyImpl(type, extractable, algorithm, usages);
            KEY_HANDLES.set(key, handle);
            // Required, or the prototype accessors below are shadowable with
            // Object.defineProperty(key, 'extractable', { value: true }) and the
            // whole hardening is decorative.
            Object.preventExtensions(key);
            return key;
        } finally {
            CryptoKeyImpl.#allowConstruct = false;
        }
    }

    constructor(
        type: KeyType,
        extractable: boolean,
        algorithm: KeyAlgorithm,
        usages: KeyUsage[]
    ) {
        if (!CryptoKeyImpl.#allowConstruct) {
            throw new TypeError('Illegal constructor');
        }
        this.#type = type;
        this.#extractable = extractable;
        // Frozen copy so `key.algorithm.length = 512` cannot retarget an
        // operation. A copy also stops the two halves of a generated key pair
        // from sharing one mutable algorithm object.
        this.#algorithm = Object.freeze({ ...algorithm });
        // Frozen copy so `key.usages.push('sign')` cannot escalate, and so a
        // caller-supplied array cannot be mutated after the fact either.
        this.#usages = Object.freeze([...usages]);
    }

    // Accessors, not data properties: assignment throws in strict mode (all
    // module code is strict) and defineProperty on the instance fails because
    // these live on the prototype and the instance is non-extensible.
    get type(): KeyType { return this.#type; }
    get extractable(): boolean { return this.#extractable; }
    get algorithm(): KeyAlgorithm { return this.#algorithm; }
    get usages(): KeyUsage[] { return this.#usages as KeyUsage[]; }

    get [Symbol.toStringTag]() {
        return 'CryptoKey';
    }
}

// Brand check. Every operation fetches key bytes through this, so a plain object
// is refused with a TypeError before any crypto runs.
function handleOf(key: CryptoKey): ArrayBuffer {
    const handle = KEY_HANDLES.get(key as unknown as object);
    if (!handle) {
        throw new TypeError('Argument is not a CryptoKey');
    }
    return handle;
}

// SubtleCrypto Implementation

class SubtleCrypto implements RuntimeSubtleCrypto {
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

        // validateKeyUsages already existed and was called from importKey, but
        // generateKey never called it, so AES-GCM with ['sign'] was accepted.
        // The caller's requested set is validated once here rather than per half:
        // the RSA and EC branches legitimately filter each half to a subset, and
        // the public half of an ECDSA key generated with ['sign'] is empty.
        validateKeyUsages(alg.name, keyUsages, true, 'creating a key');

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
                publicKey: CryptoKeyImpl._create('public', true, algorithmObj,
                    keyUsages.filter(u => u === 'verify' || u === 'encrypt' || u === 'wrapKey'), keyPair.publicKey),
                privateKey: CryptoKeyImpl._create('private', extractable, algorithmObj,
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

            const publicUsages: KeyUsage[] = alg.name === 'ECDSA' ? ['verify'] : [];
            const privateUsages: KeyUsage[] = alg.name === 'ECDSA' ? ['sign'] : ['deriveKey', 'deriveBits'];

            return {
                publicKey: CryptoKeyImpl._create('public', true, algorithmObj,
                    keyUsages.filter(u => publicUsages.includes(u)), keyPair.publicKey),
                privateKey: CryptoKeyImpl._create('private', extractable, algorithmObj,
                    keyUsages.filter(u => privateUsages.includes(u)), keyPair.privateKey),
            };
        }

        // AES
        if (alg.name === 'AES-CBC' || alg.name === 'AES-GCM') {
            const params = algorithm as AesKeyGenParams;
            const length = params.length;
            if (![128, 192, 256].includes(length)) {
                throw new Error(`Invalid AES key length: ${length}`);
            }

            const keyData = new ArrayBuffer(length / 8);
            crypto.randomFill(keyData);
            const algorithmObj: AesKeyAlgorithm = {
                name: alg.name,
                length,
            };

            return CryptoKeyImpl._create('secret', extractable, algorithmObj, keyUsages, keyData);
        }

        // HMAC
        if (alg.name === 'HMAC') {
            const params = algorithm as HmacKeyGenParams;
            const hashLength = getHashOutputLength(params.hash);
            const length = params.length || getHmacDefaultLength(params.hash);

            const keyData = new ArrayBuffer(length / 8);
            crypto.randomFill(keyData);
            const hashAlg = normalizeAlgorithm(params.hash);
            const algorithmObj: HmacKeyAlgorithm = {
                name: 'HMAC',
                hash: { name: hashAlg.name },
                length,
            };

            return CryptoKeyImpl._create('secret', extractable, algorithmObj, keyUsages, keyData);
        }

        throw new Error(`Unsupported algorithm: ${alg.name}`);
    }

    /**
     * Sign data
     */
    async sign(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
        // Brand check first: node reports a TypeError for a non-CryptoKey
        // argument before it ever looks at usages.
        const keyHandle = handleOf(key);
        if (!key.usages.includes('sign')) {
            throw invalidAccess('Key cannot be used for signing');
        }

        const alg = normalizeAlgorithm(algorithm);
        const keyImpl = key as CryptoKeyImpl;
        const dataBuffer = toArrayBuffer(data);

        // RSA-PSS
        if (alg.name === 'RSA-PSS') {
            const params = algorithm as RsaPssParams;
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.rsaPssSha256Sign(keyHandle, dataBuffer, params.saltLength);
            }
            throw new Error(`Unsupported hash for RSA-PSS: ${keyAlg.hash.name}`);
        }

        // RSASSA-PKCS1-v1_5
        if (alg.name === 'RSASSA-PKCS1-V1_5') {
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.signSha256(keyHandle, dataBuffer);
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return crypto.signSha512(keyHandle, dataBuffer);
            }
            throw new Error(`Unsupported hash for RSASSA-PKCS1-v1_5: ${keyAlg.hash.name}`);
        }

        // ECDSA
        if (alg.name === 'ECDSA') {
            const keyAlg = keyImpl.algorithm as EcKeyAlgorithm;
            // The C layer emits DER because node:crypto's EC contract is DER.
            // WebCrypto's contract is fixed-width r||s, so convert here rather
            // than in C, which would fix WebCrypto and break node:crypto.
            const coordLen = ecCoordBytes(keyAlg.namedCurve);

            if (keyAlg.namedCurve === 'P-256') {
                return ecdsaDerToRaw(crypto.ecdsaSignP256(keyHandle, dataBuffer), coordLen);
            }
            if (keyAlg.namedCurve === 'P-384') {
                return ecdsaDerToRaw(crypto.ecdsaSignP384(keyHandle, dataBuffer), coordLen);
            }
            if (keyAlg.namedCurve === 'P-521') {
                return ecdsaDerToRaw(crypto.ecdsaSignP521(keyHandle, dataBuffer), coordLen);
            }
            throw new Error(`Unsupported curve for ECDSA: ${keyAlg.namedCurve}`);
        }

        // HMAC
        if (alg.name === 'HMAC') {
            const keyAlg = keyImpl.algorithm as HmacKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.hmacSha256(keyHandle, dataBuffer);
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return crypto.hmacSha512(keyHandle, dataBuffer);
            }
            if (keyAlg.hash.name === 'SHA-1') {
                return crypto.hmacSha1(keyHandle, dataBuffer);
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
        const keyHandle = handleOf(key);
        if (!key.usages.includes('verify')) {
            throw invalidAccess('Key cannot be used for verification');
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
                return crypto.rsaPssSha256Verify(keyHandle, dataBuffer, signatureBuffer, params.saltLength);
            }
            throw new Error(`Unsupported hash for RSA-PSS: ${keyAlg.hash.name}`);
        }

        // RSASSA-PKCS1-v1_5
        if (alg.name === 'RSASSA-PKCS1-V1_5') {
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;

            if (keyAlg.hash.name === 'SHA-256') {
                return crypto.verifySha256(keyHandle, dataBuffer, signatureBuffer);
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return crypto.verifySha512(keyHandle, dataBuffer, signatureBuffer);
            }
            throw new Error(`Unsupported hash for RSASSA-PKCS1-v1_5: ${keyAlg.hash.name}`);
        }

        // ECDSA
        if (alg.name === 'ECDSA') {
            const keyAlg = keyImpl.algorithm as EcKeyAlgorithm;
            const coordLen = ecCoordBytes(keyAlg.namedCurve);

            // Per spec, verify() reports false for a signature it cannot use;
            // only key, usage and algorithm problems reject. A malformed,
            // truncated or wrong-length signature is data, not an error, and it
            // previously escaped as InternalError 'Failed to parse signature'.
            // An all-zero 64-byte input is a structurally valid raw width, so it
            // converts successfully and the C verifier rejects it on the merits.
            let der: ArrayBuffer;
            try {
                der = ecdsaRawToDer(signatureBuffer, coordLen);
            } catch {
                return false;
            }
            try {
                if (keyAlg.namedCurve === 'P-256') {
                    return crypto.ecdsaVerifyP256(keyHandle, dataBuffer, der);
                }
                if (keyAlg.namedCurve === 'P-384') {
                    return crypto.ecdsaVerifyP384(keyHandle, dataBuffer, der);
                }
                if (keyAlg.namedCurve === 'P-521') {
                    return crypto.ecdsaVerifyP521(keyHandle, dataBuffer, der);
                }
            } catch {
                // A public key the C layer cannot parse also yields false rather
                // than InternalError, matching node.
                return false;
            }
            throw new Error(`Unsupported curve for ECDSA: ${keyAlg.namedCurve}`);
        }

        // HMAC
        if (alg.name === 'HMAC') {
            const keyAlg = keyImpl.algorithm as HmacKeyAlgorithm;
            const hashAlg = normalizeAlgorithm(keyAlg.hash);

            let computedHmac: ArrayBuffer;
            if (hashAlg.name === 'SHA-256') {
                computedHmac = crypto.hmacSha256(keyHandle, dataBuffer);
            } else if (hashAlg.name === 'SHA-512') {
                computedHmac = crypto.hmacSha512(keyHandle, dataBuffer);
            } else if (hashAlg.name === 'SHA-1') {
                computedHmac = crypto.hmacSha1(keyHandle, dataBuffer);
            } else {
                throw new Error(`Unsupported hash for HMAC: ${hashAlg.name}`);
            }

            if (computedHmac.byteLength !== signatureBuffer.byteLength) {
                return false;
            }

            const a = new Uint8Array(computedHmac);
            const b = new Uint8Array(signatureBuffer);
            return algo.bytesEqual(a, b);
        }

        throw new Error(`Unsupported verification algorithm: ${alg.name}`);
    }

    /**
     * Encrypt data
     */
    async encrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
        handleOf(key);
        if (!key.usages.includes('encrypt')) {
            throw invalidAccess('Key cannot be used for encryption');
        }
        return this.encryptData(algorithm, key as CryptoKeyImpl, toArrayBuffer(data));
    }

    private encryptData(algorithm: AlgorithmIdentifier, keyImpl: CryptoKeyImpl, dataBuffer: ArrayBuffer): ArrayBuffer {
        const alg = normalizeAlgorithm(algorithm);
        const keyHandle = handleOf(keyImpl);

        // RSA-OAEP
        if (alg.name === 'RSA-OAEP') {
            const params = algorithm as RsaOaepParams;
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;
            const label = params.label ? toArrayBuffer(params.label) : undefined;

            if (keyAlg.hash.name === 'SHA-256') {
                return runOperation(() => crypto.rsaOaepSha256Encrypt(keyHandle, dataBuffer, label), 'RSA-OAEP encryption failed');
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return runOperation(() => crypto.rsaOaepSha512Encrypt(keyHandle, dataBuffer, label), 'RSA-OAEP encryption failed');
            }
            throw new Error(`Unsupported hash for RSA-OAEP: ${keyAlg.hash.name}`);
        }

        // AES-CBC
        if (alg.name === 'AES-CBC') {
            const params = algorithm as AesCbcParams;
            const keyAlg = keyImpl.algorithm as AesKeyAlgorithm;
            const iv = toArrayBuffer(params.iv);

            if (keyAlg.length === 128) {
                return crypto.aes128CbcEncrypt(keyHandle, iv, dataBuffer);
            }
            if (keyAlg.length === 192) {
                return crypto.aes192CbcEncrypt(keyHandle, iv, dataBuffer);
            }
            if (keyAlg.length === 256) {
                return crypto.aes256CbcEncrypt(keyHandle, iv, dataBuffer);
            }
            throw new Error(`Unsupported AES key length: ${keyAlg.length}`);
        }

        // AES-GCM
        if (alg.name === 'AES-GCM') {
            const params = algorithm as AesGcmParams;
            const iv = toArrayBuffer(params.iv);
            const aad = params.additionalData ? toArrayBuffer(params.additionalData) : undefined;
            const tagLength = normalizeGcmTagLength(params.tagLength);

            const result = crypto.gcmEncrypt(keyHandle, iv, dataBuffer, aad, tagLength);
            const ciphertext = new Uint8Array(result.ciphertext);
            const tag = new Uint8Array(result.tag);
            const output = algo.bytesConcat([ciphertext, tag]);
            return toArrayBuffer(output);
        }

        throw new Error(`Unsupported encryption algorithm: ${alg.name}`);
    }

    /**
     * Decrypt data
     */
    async decrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
        handleOf(key);
        if (!key.usages.includes('decrypt')) {
            throw invalidAccess('Key cannot be used for decryption');
        }
        return this.decryptData(algorithm, key as CryptoKeyImpl, toArrayBuffer(data));
    }

    private decryptData(algorithm: AlgorithmIdentifier, keyImpl: CryptoKeyImpl, dataBuffer: ArrayBuffer): ArrayBuffer {
        const alg = normalizeAlgorithm(algorithm);
        const keyHandle = handleOf(keyImpl);

        // RSA-OAEP
        if (alg.name === 'RSA-OAEP') {
            const params = algorithm as RsaOaepParams;
            const keyAlg = keyImpl.algorithm as RsaHashedKeyAlgorithm;
            const label = params.label ? toArrayBuffer(params.label) : undefined;

            if (keyAlg.hash.name === 'SHA-256') {
                return runOperation(() => crypto.rsaOaepSha256Decrypt(keyHandle, dataBuffer, label), 'RSA-OAEP decryption failed');
            }
            if (keyAlg.hash.name === 'SHA-512') {
                return runOperation(() => crypto.rsaOaepSha512Decrypt(keyHandle, dataBuffer, label), 'RSA-OAEP decryption failed');
            }
            throw new Error(`Unsupported hash for RSA-OAEP: ${keyAlg.hash.name}`);
        }

        // AES-CBC
        if (alg.name === 'AES-CBC') {
            const params = algorithm as AesCbcParams;
            const keyAlg = keyImpl.algorithm as AesKeyAlgorithm;
            const iv = toArrayBuffer(params.iv);

            if (keyAlg.length === 128) {
                return crypto.aes128CbcDecrypt(keyHandle, iv, dataBuffer);
            }
            if (keyAlg.length === 192) {
                return crypto.aes192CbcDecrypt(keyHandle, iv, dataBuffer);
            }
            if (keyAlg.length === 256) {
                return crypto.aes256CbcDecrypt(keyHandle, iv, dataBuffer);
            }
            throw new Error(`Unsupported AES key length: ${keyAlg.length}`);
        }

        // AES-GCM
        if (alg.name === 'AES-GCM') {
            const params = algorithm as AesGcmParams;
            const keyAlg = keyImpl.algorithm as AesKeyAlgorithm;
            const iv = toArrayBuffer(params.iv);
            const aad = params.additionalData ? toArrayBuffer(params.additionalData) : undefined;

            const ciphertextWithTag = dataBuffer;
            const tagLength = normalizeGcmTagLength(params.tagLength);
            const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.byteLength - tagLength);
            const tag = ciphertextWithTag.slice(ciphertextWithTag.byteLength - tagLength);

            const result = crypto.gcmDecrypt(keyHandle, iv, ciphertext, tag, aad);
            if (!result.verified) {
                throw new DOMException('AES-GCM decryption failed: authentication tag mismatch', 'OperationError');
            }
            return result.plaintext;
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

        const derivedAlg = normalizeAlgorithm(derivedKeyAlgorithm);
        const length = deriveKeyLength(derivedAlg);

        const bits = await this.deriveBits(algorithm, baseKey, length);
        return this.importKey('raw', bits, derivedKeyAlgorithm, extractable, keyUsages);
    }

    /**
     * Derive bits from base key
     */
    async deriveBits(algorithm: AlgorithmIdentifier, baseKey: CryptoKey, length: number | null): Promise<ArrayBuffer> {
        const keyHandle = handleOf(baseKey);
        if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
            throw new Error('Key cannot be used for derivation');
        }

        const alg = normalizeAlgorithm(algorithm);
        const keyImpl = baseKey as CryptoKeyImpl;

        // ECDH
        if (alg.name === 'ECDH') {
            const params = algorithm as EcdhKeyDeriveParams;
            const keyAlg = keyImpl.algorithm as EcKeyAlgorithm;
            // The peer public key is brand-checked too: it arrives from the
            // caller's algorithm object, so it is the easiest place to smuggle a
            // plain object in.
            const publicKeyHandle = handleOf(params.public);
            const bits = normalizeDeriveBitsLength(length, ecCurveBits(keyAlg.namedCurve));

            let sharedSecret: ArrayBuffer;
            if (keyAlg.namedCurve === 'P-256') {
                sharedSecret = crypto.ecdhDeriveP256(keyHandle, publicKeyHandle);
            } else if (keyAlg.namedCurve === 'P-384') {
                sharedSecret = crypto.ecdhDeriveP384(keyHandle, publicKeyHandle);
            } else if (keyAlg.namedCurve === 'P-521') {
                sharedSecret = crypto.ecdhDeriveP521(keyHandle, publicKeyHandle);
            } else {
                throw new Error(`Unsupported curve for ECDH: ${keyAlg.namedCurve}`);
            }

            if (bits > sharedSecret.byteLength * 8) {
                throw new DOMException('Invalid length', 'OperationError');
            }
            const bytes = bits / 8;
            return sharedSecret.slice(0, bytes);
        }

        // HKDF
        if (alg.name === 'HKDF') {
            const params = algorithm as HkdfParams;
            if (length === null) throw new DOMException('Invalid length', 'OperationError');
            const bits = normalizeDeriveBitsLength(length, length);
            const salt = toArrayBuffer(params.salt);
            const info = toArrayBuffer(params.info);
            const hashAlg = normalizeAlgorithm(params.hash);

            if (hashAlg.name === 'SHA-256') {
                return crypto.hkdfSha256(keyHandle, bits / 8, salt, info);
            }
            if (hashAlg.name === 'SHA-512') {
                return crypto.hkdfSha512(keyHandle, bits / 8, salt, info);
            }
            throw new Error(`Unsupported hash for HKDF: ${hashAlg.name}`);
        }

        // PBKDF2
        if (alg.name === 'PBKDF2') {
            const params = algorithm as Pbkdf2Params;
            if (length === null) throw new DOMException('Invalid length', 'OperationError');
            const bits = normalizeDeriveBitsLength(length, length);
            const salt = toArrayBuffer(params.salt);
            const hashAlg = normalizeAlgorithm(params.hash);

            if (hashAlg.name === 'SHA-1') {
                return pbkdf2Sha1(keyHandle, salt, params.iterations, bits / 8);
            }
            if (hashAlg.name === 'SHA-256') {
                return crypto.pbkdf2Sha256(keyHandle, salt, params.iterations, bits / 8);
            }
            if (hashAlg.name === 'SHA-512') {
                return crypto.pbkdf2Sha512(keyHandle, salt, params.iterations, bits / 8);
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
            validateKeyUsages(alg.name, keyUsages, true);

            // HMAC
            if (alg.name === 'HMAC') {
                const params = algorithm as HmacKeyGenParams;
                const hashAlg = normalizeAlgorithm(params.hash);
                const algorithmObj: HmacKeyAlgorithm = {
                    name: 'HMAC',
                    hash: { name: hashAlg.name },
                    length: keyBuffer.byteLength * 8,
                };
                return CryptoKeyImpl._create('secret', extractable, algorithmObj, keyUsages, keyBuffer);
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
                return CryptoKeyImpl._create('secret', extractable, algorithmObj, keyUsages, keyBuffer);
            }

            // PBKDF2 / HKDF (password material)
            if (alg.name === 'PBKDF2' || alg.name === 'HKDF') {
                return CryptoKeyImpl._create('secret', false, { name: alg.name }, keyUsages, keyBuffer);
            }

            throw new Error(`Cannot import raw key for algorithm: ${alg.name}`);
        }

        if (format === 'jwk') {
            const jwk = keyData as JsonWebKey;
            if (alg.name === 'HMAC') {
                validateKeyUsages(alg.name, keyUsages, true);
                if (jwk.kty !== 'oct' || typeof jwk.k !== 'string') {
                    throw new DOMException('Invalid HMAC JWK', 'DataError');
                }
                const params = algorithm as HmacKeyGenParams;
                const hashAlg = normalizeAlgorithm(params.hash ?? jwkHashAlg(jwk.alg));
                const keyBuffer = toArrayBuffer(algo.base64DecodeLoose(jwk.k));
                const algorithmObj: HmacKeyAlgorithm = {
                    name: 'HMAC',
                    hash: { name: hashAlg.name },
                    length: keyBuffer.byteLength * 8,
                };
                return CryptoKeyImpl._create('secret', extractable && jwk.ext !== false, algorithmObj, keyUsages, keyBuffer);
            }
            throw new Error(`Cannot import JWK key for algorithm: ${alg.name}`);
        }

        if (format === 'spki' || format === 'pkcs8') {
            // RSA or EC keys in PEM/DER format
            const keyBuffer = toArrayBuffer(keyData as BufferSource);
            // Public keys may legitimately carry an empty usage list.
            validateKeyUsages(alg.name, keyUsages, format === 'pkcs8');

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
                return CryptoKeyImpl._create(type, extractable, algorithmObj, keyUsages, keyBuffer);
            }

            if (alg.name === 'ECDSA' || alg.name === 'ECDH') {
                const params = algorithm as EcKeyGenParams;
                const algorithmObj: EcKeyAlgorithm = {
                    name: alg.name,
                    namedCurve: params.namedCurve,
                };

                const type: KeyType = format === 'spki' ? 'public' : 'private';
                return CryptoKeyImpl._create(type, extractable, algorithmObj, keyUsages, keyBuffer);
            }
        }

        throw new Error(`Unsupported import format: ${format}`);
    }

    /**
     * Export key to external format
     */
    async exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer | JsonWebKey> {
        const keyHandle = handleOf(key);
        if (!key.extractable) {
            throw new DOMException('Key is not extractable', 'InvalidAccessError');
        }

        const keyImpl = key as CryptoKeyImpl;

        if (format === 'raw') {
            if (key.type !== 'secret') {
                throw new Error('Can only export secret keys as raw');
            }
            // A copy. Returning the live handle let a caller mutate the key in
            // place, and handed back the same ArrayBuffer identity every call.
            return keyHandle.slice(0);
        }

        if (format === 'jwk') {
            if (key.type !== 'secret') {
                throw new Error('Can only export secret keys as JWK');
            }
            const keyAlg = keyImpl.algorithm;
            if (keyAlg.name === 'HMAC') {
                const hmacAlg = keyAlg as HmacKeyAlgorithm;
                return {
                    kty: 'oct',
                    k: algo.base64UrlEncode(new Uint8Array(keyHandle)),
                    alg: hmacJwkAlg(hmacAlg.hash),
                    ext: key.extractable,
                    key_ops: [...key.usages],
                };
            }
            throw new Error(`Unsupported JWK export algorithm: ${keyAlg.name}`);
        }

        if (format === 'spki' && key.type === 'public') {
            return keyHandle.slice(0);
        }

        if (format === 'pkcs8' && key.type === 'private') {
            return keyHandle.slice(0);
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
        handleOf(wrappingKey);
        if (!wrappingKey.usages.includes('wrapKey')) {
            throw new Error('Key cannot be used for wrapping');
        }

        // Export the key to be wrapped
        const exportedKey = await this.exportKey(format, key);

        // Encrypt the exported key data using the wrapping key
        return this.encryptData(wrapAlgorithm, wrappingKey as CryptoKeyImpl, toArrayBuffer(exportKeyBytes(format, exportedKey)));
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
        handleOf(unwrappingKey);
        if (!unwrappingKey.usages.includes('unwrapKey')) {
            throw new Error('Key cannot be used for unwrapping');
        }

        // Decrypt the wrapped key using the unwrapping key
        const decryptedKey = this.decryptData(unwrapAlgorithm, unwrappingKey as CryptoKeyImpl, toArrayBuffer(wrappedKey));

        // Import the decrypted key data
        return this.importKey(format, importKeyData(format, decryptedKey), unwrappedKeyAlgorithm, extractable, keyUsages);
    }
}

export const subtle = new SubtleCrypto();

Reflect.set(globalThis, 'CryptoKey', CryptoKeyImpl);

const webCrypto: RuntimeCrypto = {
    subtle,

    digest(algorithm: HashAlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
        return subtle.digest(algorithm, data);
    },

    getRandomValues<T extends ArrayBufferView>(buffer: T): T {
        if (!ArrayBuffer.isView(buffer) || buffer instanceof DataView || buffer instanceof Float32Array || buffer instanceof Float64Array) {
            throw new DOMException('The provided ArrayBufferView is not an integer typed array', 'TypeMismatchError');
        }
        if (buffer.byteLength > 65536) {
            throw new DOMException('The ArrayBufferView byte length exceeds the number of bytes of entropy available via this API', 'QuotaExceededError');
        }
        crypto.randomFill(buffer);
        return buffer;
    },

    randomUUID() {
        return crypto.randomUUID();
    },
};

Reflect.defineProperty(globalThis, 'crypto', {
    value: webCrypto,
    writable: false,
    enumerable: true,
    configurable: true
});
