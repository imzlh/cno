/** generateKeyPair / generateKeyPairSync, including the RFC 8410 PKCS#8 builder. */

const crypto = import.meta.use('crypto');
import type { AsymmetricKeyType } from './types';
import { KeyObject, type KeyEncodingSpec, type GenerateKeyPairOptions } from './keys';
import { resolveCurve } from './curves';
import { assertCallback, asError, withCode } from './errors';
import { randomBytes } from './random';

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
