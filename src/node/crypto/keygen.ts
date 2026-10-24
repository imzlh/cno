import type { AsymmetricKeyType } from './types';
import { KeyObject, type KeyEncodingSpec, type GenerateKeyPairOptions } from './keys';
import { resolveCurve } from './curves';
import { assertCallback, asError, withCode } from './errors';
import { randomBytes } from './random';

/** generateKeyPair / generateKeyPairSync, including the RFC 8410 PKCS#8 builder. */

const crypto = import.meta.use('crypto');

// RFC 8410 keygen (X25519, X448, Ed25519, Ed448). The native layer only generates
// RSA and EC, but an RFC 8410 private key IS uniform random bytes of a fixed
// length, so the seed is built here and the public half derived natively.
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
 * OneAsymmetricKey (PKCS#8) for an RFC 8410 algorithm:
 *
 *   SEQUENCE { INTEGER 0,
 *              SEQUENCE { OBJECT IDENTIFIER algorithm },   -- no parameters
 *              OCTET STRING { OCTET STRING seed } }
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
    // Native derive: the same path imported keys use, so the two cannot disagree.
    const spki = new Uint8Array(crypto.derivePublicKeyDer(pkcs8));
    // Node reports an empty details object for these types, not undefined.
    return {
        publicKey: new KeyObject('public', type as AsymmetricKeyType, spki, 'der', {}),
        privateKey: new KeyObject('private', type as AsymmetricKeyType, pkcs8, 'der', {}),
    };
}

// Node validates the key type and curve synchronously, even for the async form.
function validateKeyPairArgs(type: string, options: GenerateKeyPairOptions | undefined): void {
    // Node ignores options entirely for these, including a bogus namedCurve.
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
        // The C generator always uses F4.
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
 * Apply `publicKeyEncoding` / `privateKeyEncoding`: each key is encoded
 * independently when its spec is present. Ignoring the spec fails silently --
 * `writeFileSync('key.pem', privateKey)` writes "[object Object]".
 */
function encodeGeneratedKey(key: KeyObject, spec: KeyEncodingSpec | undefined): KeyObject | string | Uint8Array {
    if (!spec || spec.format === undefined) return key;
    if (spec.format === 'jwk') {
        // Node returns a JWK object; KeyObject.export does not type it as one.
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
    // The overloads declare KeyObject; the cast is for the encoded forms.
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
    // Node also accepts generateKeyPair(type, callback).
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
