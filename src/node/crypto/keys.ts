/**
 * KeyObject plus the import/export surface: createPrivateKey, createPublicKey,
 * createSecretKey, and the PEM/DER normalisation they share.
 */

const crypto = import.meta.use('crypto');
const algorithm = import.meta.use('algorithm');
const engine = import.meta.use('engine');
import { Buffer } from '../buffer';
import type { BinaryInput, KeyInput, KeyObject as KeyObjectShape, KeyExportOptions, SecretJwk, AsymmetricKeyType } from './types';
import { getKeyBytes, toBuffer, keyDetailsFromBytes, kKeyData, kKeyFormat, guessKeyFormat, isKeyObject, type KeyFormat } from './helpers';

export function keyTypeFromPrivate(bytes: Uint8Array): AsymmetricKeyType {
    return crypto.getPrivateKeyType(bytes) as AsymmetricKeyType;
}

export function keyTypeFromPublic(bytes: Uint8Array): AsymmetricKeyType {
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

export function normalizeKeySource(input: KeyInput | { key: KeyInput; format?: 'pem' | 'der' }): { bytes: Uint8Array; format: KeyFormat } {
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
        bytes: getKeyBytes(source),
        format: guessKeyFormat(source, isKeyInputWithFormat(input) ? input.format : undefined),
    };
}

export function toPemString(bytes: Uint8Array): string {
    return engine.decodeString(bytes);
}

export function exportKeyObjectBytes(keyObject: KeyObject, format: 'pem' | 'der'): Uint8Array {
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

export type KeyEncodingSpec = { type?: 'spki' | 'pkcs8'; format?: 'pem' | 'der' | 'jwk' };

export type GenerateKeyPairOptions = {
    modulusLength?: number;
    namedCurve?: string;
    paramEncoding?: string;
    publicKeyEncoding?: KeyEncodingSpec;
    privateKeyEncoding?: KeyEncodingSpec;
};
