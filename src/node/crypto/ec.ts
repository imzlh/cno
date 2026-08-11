/** ECDSA, ECDH and the one-shot key agreement (diffieHellman). */

const crypto = import.meta.use('crypto');
import { Buffer } from '../buffer';
import type { BinaryInput } from './types';
import { toBuffer, toExactArrayBuffer, encodeOutput, kKeyData, kKeyFormat, isKeyObject } from './helpers';
import { KeyObject } from './keys';
import { resolveCurve, resolveEcdhCurve, type EcdhCurve } from './curves';

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

/**
 * Node's one-shot key agreement. The algorithm comes from the keys, so this must
 * accept every agreement type Node does -- X25519/X448 and DH as well as EC --
 * in whatever encoding the KeyObject happens to hold.
 *
 * It previously required BOTH keys to be `raw` EC, which is only what our own
 * `generateKeyPairSync('ec')` produces. Every other origin failed: an X25519
 * pair (generated as PKCS#8/SPKI DER, and the only type some callers use) and
 * any key from `createPrivateKey`/`createPublicKey` on a PEM/DER both threw
 * "Only raw EC KeyObjects are supported by diffieHellman".
 *
 * Two paths, because `raw` is an internal format of ours that carries no
 * algorithm identifier -- for raw keys the curve is known only from
 * `asymmetricKeyDetails`, so those go to the curve-fixed native entry point.
 */
export function diffieHellman(options: { privateKey: KeyObject; publicKey: KeyObject }): Buffer {
    const privateKey = options?.privateKey;
    const publicKey = options?.publicKey;
    if (!isKeyObject(privateKey) || privateKey.type !== 'private') {
        throw new TypeError('options.privateKey must be a private KeyObject');
    }
    if (!isKeyObject(publicKey) || publicKey.type !== 'public') {
        throw new TypeError('options.publicKey must be a public KeyObject');
    }

    const privateRaw = privateKey[kKeyFormat] === 'raw';
    const publicRaw = publicKey[kKeyFormat] === 'raw';

    if (privateRaw && publicRaw) {
        const privateCurve = privateKey.asymmetricKeyDetails?.namedCurve;
        const publicCurve = publicKey.asymmetricKeyDetails?.namedCurve;
        if (!privateCurve || !publicCurve) {
            throw new TypeError('Raw EC KeyObjects must carry a namedCurve for diffieHellman');
        }
        if (resolveEcdhCurve(privateCurve) !== resolveEcdhCurve(publicCurve)) {
            throw new TypeError('Public key is not valid for specified curve');
        }
        return Buffer.from(new Uint8Array(ecdhComputeSecret(privateCurve, privateKey[kKeyData], publicKey[kKeyData])));
    }

    // A raw key paired with an encoded one still works: the native loaders fall
    // back to raw EC parsing. That fallback infers the curve from the byte
    // length, which cannot express secp256k1 (32 bytes, same as P-256), so
    // refuse rather than silently deriving on the wrong curve.
    for (const [key, raw] of [[privateKey, privateRaw], [publicKey, publicRaw]] as const) {
        if (raw && key.asymmetricKeyDetails?.namedCurve === 'secp256k1') {
            throw new TypeError('A raw secp256k1 KeyObject must be paired with another raw KeyObject');
        }
    }

    // The native layer reads the algorithm out of the key material, which is what
    // makes X25519/X448/DH work without special-casing each of them here.
    return Buffer.from(new Uint8Array(crypto.deriveSharedSecret(privateKey[kKeyData], publicKey[kKeyData])));
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
