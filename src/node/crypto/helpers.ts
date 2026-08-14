/**
 * Node.js crypto module - shared helper functions
 */

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const algorithm = import.meta.use('algorithm');
import { Buffer } from '../buffer';
import type { BinaryInput, KeyInput, KeyObject, KeyWithOptions, AsymmetricKeyType } from './types';
import { concatChunks as concatBuffers } from '../_internal/buffer';
export { concatBuffers };

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')?.get;
const dataViewByteOffsetGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')?.get;
const dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')?.get;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
const arrayBufferSlice = ArrayBuffer.prototype.slice;
const uint8ArraySet = Uint8Array.prototype.set;

export const kKeyData = Symbol('cno.node.crypto.keyData');
export const kKeyFormat = Symbol('cno.node.crypto.keyFormat');
export type KeyFormat = 'raw' | 'pem' | 'der';

function applySlot<T>(getter: ((this: unknown) => T) | undefined, value: object): T {
    if (!getter) throw new TypeError('Required BufferSource slot is unavailable');
    return Reflect.apply(getter, value, []);
}

function viewSlots(value: unknown): { buffer: ArrayBufferLike; byteOffset: number; byteLength: number } | null {
    if (!value || typeof value !== 'object') return null;
    const dataView = engine.isDataView(value);
    const bufferGetter = dataView ? dataViewBufferGetter : typedArrayBufferGetter;
    try {
        return {
            buffer: applySlot(bufferGetter, value),
            byteOffset: applySlot(dataView ? dataViewByteOffsetGetter : typedArrayByteOffsetGetter, value),
            byteLength: applySlot(dataView ? dataViewByteLengthGetter : typedArrayByteLengthGetter, value),
        };
    } catch { return null; }
}

function isBufferSource(value: unknown): value is ArrayBuffer | ArrayBufferView {
    return engine.isArrayBuffer(value) || viewSlots(value) !== null;
}

export function toBuffer(data: BinaryInput, encoding: string = 'utf8'): Uint8Array {
    if (typeof data === 'string') {
        if (encoding === 'hex') return algorithm.hexDecodeLoose(data);
        if (encoding === 'base64' || encoding === 'base64url') return algorithm.base64DecodeLoose(data);
        if (encoding === 'latin1' || encoding === 'ascii' || encoding === 'binary') {
            return algorithm.latin1EncodeLoose(data);
        }
        return engine.encodeString(data);
    }
    if (engine.isArrayBuffer(data)) return new Uint8Array(data as ArrayBuffer);
    const view = viewSlots(data);
    if (view) return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    throw new TypeError('The input must be a string, ArrayBuffer, or ArrayBufferView');
}

export function toExactArrayBuffer(data: Uint8Array): ArrayBuffer {
    const view = viewSlots(data);
    if (!view) throw new TypeError('The input must be a Uint8Array');
    if (engine.isArrayBuffer(view.buffer)) {
        const buffer = view.buffer as ArrayBuffer;
        const bufferLength = applySlot(arrayBufferByteLengthGetter, buffer);
        if (view.byteOffset === 0 && view.byteLength === bufferLength) return buffer;
        return Reflect.apply(arrayBufferSlice, buffer, [view.byteOffset, view.byteOffset + view.byteLength]);
    }
    const copy = new Uint8Array(view.byteLength);
    Reflect.apply(uint8ArraySet, copy, [new Uint8Array(view.buffer, view.byteOffset, view.byteLength)]);
    return copy.buffer;
}

export function encodeOutput(data: ArrayBuffer, encoding?: string): Buffer | string {
    if (!encoding) return Buffer.from(new Uint8Array(data));
    const normalized = encoding.toLowerCase();
    if (normalized === 'hex') return crypto.hexEncode(data);
    if (normalized === 'base64') return crypto.base64Encode(data);
    if (normalized === 'base64url') {
        return algorithm.base64UrlEncode(new Uint8Array(data));
    }
    const bytes = new Uint8Array(data);
    if (normalized === 'utf8' || normalized === 'utf-8') {
        return engine.decodeString(bytes);
    }
    if (normalized === 'latin1' || normalized === 'binary') {
        return algorithm.latin1DecodeLoose(bytes);
    }
    if (normalized === 'ascii') {
        return algorithm.asciiDecodeLoose(bytes);
    }
    return Buffer.from(bytes);
}

export function isKeyObject(value: unknown): value is KeyObject & {
    [kKeyData]: Uint8Array;
    [kKeyFormat]: KeyFormat;
    asymmetricKeyType?: AsymmetricKeyType;
} {
    return value !== null && typeof value === 'object'
        && Reflect.get(value, Symbol.toStringTag) === 'KeyObject'
        && kKeyData in value;
}

export function guessKeyFormat(input: KeyInput, explicit?: 'pem' | 'der'): KeyFormat {
    if (explicit) return explicit;
    return typeof input === 'string' ? 'pem' : 'der';
}

export function getKeyBytes(input: KeyInput): Uint8Array {
    if (isKeyObject(input)) {
        return input[kKeyData];
    }
    if (typeof input === 'string' || isBufferSource(input)) {
        return toBuffer(input);
    }
    throw new TypeError('The key must be a KeyObject, string, ArrayBuffer, or ArrayBufferView');
}

export function readKeyOptions(input: KeyInput | KeyWithOptions): { key: Uint8Array; dsaEncoding: 'der' | 'ieee-p1363'; padding?: number } {
    if (input && typeof input === 'object' && !isKeyObject(input) && !isBufferSource(input) && 'key' in input) {
        const opts = input as KeyWithOptions & { padding?: number };
        return {
            key: getKeyBytes(opts.key),
            dsaEncoding: opts.dsaEncoding === 'ieee-p1363' ? 'ieee-p1363' : 'der',
            padding: typeof opts.padding === 'number' ? opts.padding : undefined,
        };
    }
    return {
        key: getKeyBytes(input as KeyInput),
        dsaEncoding: 'der',
    };
}

/**
 * The native sign/verify entry points (`crypto.signSha256` and friends) take no
 * padding argument — they always use PKCS#1 v1.5. So a caller asking for PSS was
 * silently served the legacy scheme, and measured on the 17:41 binary a PKCS1
 * signature VERIFIED TRUE against an explicit PSS request, where real Node
 * v24.18.0 returns false. That is a padding-scheme downgrade, and silently
 * accepting it is worse than not supporting PSS at all: the caller believes it
 * opted in.
 *
 * Until the native layer accepts a padding parameter, fail loudly instead. Node's
 * own error for an unsupported padding is ERR_CRYPTO_INVALID_PADDING-shaped, so
 * mirror that rather than inventing a code.
 */
export function rejectUnsupportedPadding(padding: number | undefined, fn: 'sign' | 'verify'): void {
    // 1 = RSA_PKCS1_PADDING, which is what the native layer actually does.
    if (padding === undefined || padding === 1) return;
    const err = new Error(
        `crypto.${fn}: padding ${padding} is not supported by this build (only RSA_PKCS1_PADDING). `
        + 'Requesting PSS would otherwise be silently downgraded to PKCS#1 v1.5.',
    ) as Error & { code?: string };
    err.code = 'ERR_CRYPTO_INVALID_PADDING';
    throw err;
}

export function detectEcCoordinateSize(bytes: Uint8Array): number | undefined {
    switch (bytes.length) {
        case 32:
        case 48:
        case 66:
            return bytes.length;
        case 65:
            return bytes[0] === 0x04 ? 32 : undefined;
        case 97:
            return bytes[0] === 0x04 ? 48 : undefined;
        case 133:
            return bytes[0] === 0x04 ? 66 : undefined;
        default:
            return undefined;
    }
}

/* ------------------------------------------------------------------------- *
 * Key inspection for the ieee-p1363 signature paths
 *
 * The P1363 encoding is defined by the key's CURVE: the signature is exactly two
 * fixed-width coordinates. So both directions of the conversion need the curve.
 * A raw scalar or raw uncompressed point announces it by length, but a PEM or DER
 * key does not, and the encoded key's byte length says nothing about the curve.
 *
 * Guessing instead of asking produced four measured divergences from Node
 * v24.18.0:
 *   - sign({ key: <PEM>, dsaEncoding: 'ieee-p1363' }) threw, because no raw
 *     length matched (3/3 curves).
 *   - verify() inferred `size = signature.length / 2` from the SIGNATURE, so a
 *     valid signature zero-extended to any even length verified TRUE where Node
 *     returns FALSE (12/12 crafted cases across P-256/P-384/P-521). Signature
 *     malleability: one valid signature yields unboundedly many accepted byte
 *     strings, which breaks anything using signature bytes as a dedup key.
 *   - a malformed length threw where Node returns false (9/9 cases), turning a
 *     remote peer's bad signature into an uncaught exception.
 *   - RSA keys were dragged through the EC conversion, because dsaEncoding was
 *     honoured for every key type; Node ignores it for non-EC keys (4/4 cases).
 *
 * So read the namedCurve OID out of the key structure. The walk below is
 * STRUCTURAL, not a byte-scan for the OID pattern: a scan can match random key
 * material -- a modulus, a coordinate, an encrypted blob -- and "the odds are
 * tiny" is precisely the reasoning that produces this defect class.
 * ------------------------------------------------------------------------- */

// OID content octets (hex) -> EC coordinate size in bytes.
const EC_CURVE_COORDINATE_SIZE = new Map<string, number>([
    ['2a8648ce3d030107', 32], // prime256v1 / secp256r1 / P-256  1.2.840.10045.3.1.7
    ['2b81040022', 48],       // secp384r1 / P-384               1.3.132.0.34
    ['2b81040023', 66],       // secp521r1 / P-521               1.3.132.0.35
    ['2b8104000a', 32],       // secp256k1                       1.3.132.0.10
]);

// Algorithms for which Node ignores dsaEncoding entirely.
const NON_EC_ALGORITHM_OIDS = new Set<string>([
    '2a864886f70d010101', // rsaEncryption   1.2.840.113549.1.1.1
    '2a864886f70d01010a', // RSASSA-PSS      1.2.840.113549.1.1.10
    '2b6570',             // Ed25519         1.3.101.112
    '2b6571',             // Ed448           1.3.101.113
    '2b656e',             // X25519          1.3.101.110
    '2b656f',             // X448            1.3.101.111
]);

const HEX_DIGITS = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i] as number;
        out += HEX_DIGITS[(byte >> 4) & 0x0f] + HEX_DIGITS[byte & 0x0f];
    }
    return out;
}

/**
 * Collect OBJECT IDENTIFIER contents by walking constructed nodes only.
 *
 * Primitive payloads (INTEGER, BIT STRING, OCTET STRING) are never re-parsed as
 * TLV, so raw key material can never be mistaken for an OID. Every structure we
 * care about carries the curve OID inside a constructed node:
 *   SPKI    SEQUENCE { SEQUENCE { OID alg, OID curve }, BIT STRING }
 *   PKCS8   SEQUENCE { INTEGER, SEQUENCE { OID alg, OID curve }, OCTET STRING }
 *   SEC1    SEQUENCE { INTEGER, OCTET STRING, [0] { OID curve }, [1] { ... } }
 */
function collectDerOids(der: Uint8Array, out: string[], depth: number): void {
    if (depth > 4) return;
    let offset = 0;
    while (offset < der.length && out.length < 16) {
        const tag = der[offset++];
        if (tag === undefined) return;
        // High-tag-number form: bail out rather than guess at the encoding.
        if ((tag & 0x1f) === 0x1f) return;
        const parsed = readAsn1LengthOrUndefined(der, offset);
        if (!parsed) return;
        const end = parsed.offset + parsed.length;
        if (end > der.length) return;
        if (tag === 0x06) {
            out.push(bytesToHex(der.subarray(parsed.offset, end)));
        } else if ((tag & 0x20) !== 0) {
            collectDerOids(der.subarray(parsed.offset, end), out, depth + 1);
        }
        offset = end;
    }
}

/** PEM label plus decoded DER body, or undefined if these bytes are not PEM/DER. */
function derFromKeyBytes(bytes: Uint8Array): { der: Uint8Array; label: string } | undefined {
    if (bytes.length === 0) return undefined;
    if (bytes[0] === 0x30) return { der: bytes, label: '' }; // already a DER SEQUENCE
    if (bytes[0] !== 0x2d) return undefined;                 // not '-', so not PEM
    let text: string;
    try {
        text = engine.decodeString(bytes);
    } catch {
        return undefined;
    }
    const header = /-----BEGIN ([A-Z0-9 ]+)-----/.exec(text);
    if (!header) return undefined;
    const bodyStart = (header.index as number) + header[0].length;
    const footer = text.indexOf('-----END', bodyStart);
    if (footer < 0) return undefined;
    // Keep only base64 alphabet characters; line breaks and CRs are noise here.
    const body = text.slice(bodyStart, footer).replace(/[^A-Za-z0-9+/=]/g, '');
    if (body.length === 0) return undefined;
    try {
        return { der: algorithm.base64DecodeLoose(body), label: header[1] as string };
    } catch {
        return undefined;
    }
}

export type P1363KeyShape =
    | { kind: 'ec'; coordinateSize: number }
    | { kind: 'non-ec' }
    | { kind: 'unknown' };

/**
 * Classify key material for the ieee-p1363 paths: an EC key with a known
 * coordinate size, a key type for which Node ignores dsaEncoding, or unknown.
 *
 * 'unknown' is deliberately distinct from 'non-ec' so callers can preserve the
 * pre-existing behaviour for key shapes this function does not recognise rather
 * than silently changing what they do.
 */
export function classifyKeyForP1363(keyBytes: Uint8Array): P1363KeyShape {
    // Raw scalars and raw uncompressed points are self-describing by length.
    const rawSize = detectEcCoordinateSize(keyBytes);
    if (rawSize !== undefined) return { kind: 'ec', coordinateSize: rawSize };

    const parsed = derFromKeyBytes(keyBytes);
    if (!parsed) return { kind: 'unknown' };

    const oids: string[] = [];
    collectDerOids(parsed.der, oids, 0);
    // Curve OIDs first: an EC key carries ecPublicKey AND the curve, so checking
    // the curve before the algorithm list keeps the two from racing.
    for (const oid of oids) {
        const size = EC_CURVE_COORDINATE_SIZE.get(oid);
        if (size !== undefined) return { kind: 'ec', coordinateSize: size };
    }
    for (const oid of oids) {
        if (NON_EC_ALGORITHM_OIDS.has(oid)) return { kind: 'non-ec' };
    }
    // PKCS#1 carries no OID at all -- it is a bare SEQUENCE of INTEGERs -- so the
    // PEM label is the only signal. Node accepts PKCS#1 input even though this
    // build cannot export it.
    if (parsed.label.indexOf('RSA') >= 0) return { kind: 'non-ec' };
    return { kind: 'unknown' };
}

function readAsn1Length(bytes: Uint8Array, offset: number): { length: number; offset: number } {
    const parsed = readAsn1LengthOrUndefined(bytes, offset);
    if (!parsed) throw new Error('Invalid DER length');
    return parsed;
}

/**
 * Non-throwing DER length reader.
 *
 * `length = (length << 8) | byte` wraps to a NEGATIVE number for a 4-byte length
 * whose top bit is set (0x84 FF FF FF FF read back as -1), and a negative length
 * silently defeats every `end > bytes.length` bounds check downstream -- the
 * comparison is simply false. Accumulate with multiplication instead, and reject
 * any length that cannot fit in the buffer we were handed.
 */
function readAsn1LengthOrUndefined(bytes: Uint8Array, offset: number): { length: number; offset: number } | undefined {
    const first = bytes[offset++];
    if (first === undefined) return undefined;
    if ((first & 0x80) === 0) {
        return { length: first, offset };
    }

    const count = first & 0x7f;
    // count === 0 is the indefinite form (illegal in DER); > 4 is beyond anything
    // a key or signature needs and beyond what a JS number tracks exactly here.
    if (count === 0 || count > 4 || offset + count > bytes.length) {
        return undefined;
    }

    let length = 0;
    for (let i = 0; i < count; i++) {
        const byte = bytes[offset + i];
        if (byte === undefined) return undefined;
        length = length * 256 + byte;
    }
    if (length > bytes.length) return undefined;
    return { length, offset: offset + count };
}

function writeAsn1Length(length: number): number[] {
    if (length < 0x80) {
        return [length];
    }
    const out: number[] = [];
    let value = length;
    while (value > 0) {
        out.unshift(value & 0xff);
        value >>>= 8;
    }
    out.unshift(0x80 | out.length);
    return out;
}

function normalizeDerInteger(bytes: Uint8Array): Uint8Array {
    // `bytes` is one fixed-width big-endian half of a P1363 signature -- a raw
    // scalar, never a TLV. Do not special-case a leading 0x04 here: that is the
    // uncompressed EC *point* prefix, which belongs to public keys, not to r/s.
    // Skipping it drops a real high-order byte for the ~1-in-128 signature whose
    // r or s happens to start with 0x04, and the rebuilt DER then fails to verify.
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
        start++;
    }
    const trimmed = bytes.subarray(start);
    if ((trimmed[0] ?? 0) & 0x80) {
        const out = new Uint8Array(trimmed.length + 1);
        out.set(trimmed, 1);
        return out;
    }
    return trimmed;
}

export function derToP1363(signature: BinaryInput, size: number): ArrayBuffer {
    const bytes = toBuffer(signature);
    let offset = 0;
    if (bytes[offset++] !== 0x30) {
        throw new Error('Invalid DER ECDSA signature');
    }
    const seq = readAsn1Length(bytes, offset);
    offset = seq.offset;
    const seqEnd = offset + seq.length;
    if (seqEnd > bytes.length || bytes[offset++] !== 0x02) {
        throw new Error('Invalid DER ECDSA signature');
    }
    const rInfo = readAsn1Length(bytes, offset);
    offset = rInfo.offset;
    const r = bytes.subarray(offset, offset + rInfo.length);
    offset += rInfo.length;
    if (offset >= seqEnd || bytes[offset++] !== 0x02) {
        throw new Error('Invalid DER ECDSA signature');
    }
    const sInfo = readAsn1Length(bytes, offset);
    offset = sInfo.offset;
    const s = bytes.subarray(offset, offset + sInfo.length);

    const out = Buffer.alloc(size * 2);
    const rTrimmed = r[0] === 0 ? r.subarray(1) : r;
    const sTrimmed = s[0] === 0 ? s.subarray(1) : s;
    out.set(rTrimmed.subarray(Math.max(0, rTrimmed.length - size)), size - Math.min(size, rTrimmed.length));
    out.set(sTrimmed.subarray(Math.max(0, sTrimmed.length - size)), size * 2 - Math.min(size, sTrimmed.length));
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

export function p1363ToDer(signature: BinaryInput): ArrayBuffer {
    const bytes = toBuffer(signature);
    if (bytes.length === 0 || bytes.length % 2 !== 0) {
        throw new Error('Invalid IEEE-P1363 ECDSA signature');
    }

    const size = bytes.length / 2;
    const r = normalizeDerInteger(bytes.subarray(0, size));
    const s = normalizeDerInteger(bytes.subarray(size));
    const rLen = writeAsn1Length(r.length);
    const sLen = writeAsn1Length(s.length);
    const bodyLength = 2 + rLen.length + r.length + sLen.length + s.length;
    const seqLen = writeAsn1Length(bodyLength);
    const out = new Uint8Array(1 + seqLen.length + bodyLength);
    let offset = 0;
    out[offset++] = 0x30;
    out.set(seqLen, offset); offset += seqLen.length;
    out[offset++] = 0x02;
    out.set(rLen, offset); offset += rLen.length;
    out.set(r, offset); offset += r.length;
    out[offset++] = 0x02;
    out.set(sLen, offset); offset += sLen.length;
    out.set(s, offset);
    return out.buffer;
}

export type BufferedCipher = {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): Uint8Array | string;
    final(outputEncoding?: string): Uint8Array | string;
};

export function createBufferedCipher(
    transform: (data: Uint8Array) => ArrayBuffer,
    blockSize = 16,
): BufferedCipher {
    const chunks: Uint8Array[] = [];
    let outChunks: Uint8Array[] = [];
    return {
        update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string) {
            chunks.push(toBuffer(data, inputEncoding));
            const buf = concatBuffers(chunks);
            const fullBlocks = Math.floor(buf.length / blockSize) * blockSize;
            if (fullBlocks >= blockSize) {
                const out = new Uint8Array(transform(buf.slice(0, fullBlocks)));
                outChunks.push(out);
                chunks.length = 0;
                if (buf.length > fullBlocks) chunks.push(buf.slice(fullBlocks));
            }
            const result = concatBuffers(outChunks);
            outChunks = [];
            return encodeOutput(toExactArrayBuffer(result), outputEncoding);
        },
        final(outputEncoding?: string) {
            const buf = concatBuffers(chunks);
            chunks.length = 0;
            return encodeOutput(transform(buf), outputEncoding);
        },
    };
}

export const createBufferedDecipher = createBufferedCipher as (
    transform: (data: Uint8Array) => ArrayBuffer,
    blockSize?: number,
) => BufferedCipher;

export function isGcmAlgorithm(algorithm: string): boolean {
    const a = algorithm.toLowerCase();
    return a === 'aes-128-gcm' || a === 'aes-192-gcm' || a === 'aes-256-gcm';
}

export function normalizeHashAlgorithm(algorithm: string): string {
    return algorithm.toLowerCase().replace(/-/g, '');
}

export function oneShotHmac(algorithm: string, key: Uint8Array, data: Uint8Array): ArrayBuffer {
    switch (normalizeHashAlgorithm(algorithm)) {
        case 'md5': return crypto.hmacMd5(key, data);
        case 'ripemd160': return crypto.hmacRipemd160(key, data);
        case 'sha1': return crypto.hmacSha1(key, data);
        case 'sha224': return crypto.hmacSha224(key, data);
        case 'sha256': return crypto.hmacSha256(key, data);
        case 'sha384': return crypto.hmacSha384(key, data);
        case 'sha512': return crypto.hmacSha512(key, data);
        case 'sha512224': return crypto.hmacSha512_224(key, data);
        case 'sha512256': return crypto.hmacSha512_256(key, data);
        case 'sha3224': return crypto.hmacSha3_224(key, data);
        case 'sha3256': return crypto.hmacSha3_256(key, data);
        case 'sha3384': return crypto.hmacSha3_384(key, data);
        case 'sha3512': return crypto.hmacSha3_512(key, data);
        case 'blake2b512': return crypto.hmacBlake2b512(key, data);
        case 'blake2s256': return crypto.hmacBlake2s256(key, data);
        default: throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
    }
}

export function isSupportedHmacAlgorithm(algorithm: string): boolean {
    switch (normalizeHashAlgorithm(algorithm)) {
        case 'md5':
        case 'ripemd160':
        case 'sha1':
        case 'sha224':
        case 'sha256':
        case 'sha384':
        case 'sha512':
        case 'sha512224':
        case 'sha512256':
        case 'sha3224':
        case 'sha3256':
        case 'sha3384':
        case 'sha3512':
        case 'blake2b512':
        case 'blake2s256':
            return true;
        default:
            return false;
    }
}

export type BufferedHmac = {
    update(input: BinaryInput, encoding?: string): BufferedHmac;
    digest(encoding?: string): Uint8Array | string;
};

export function createOneShotHmac(algorithm: string, key: Uint8Array): BufferedHmac {
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

type AsymmetricCipherArgs = {
    key: Uint8Array;
    data: Uint8Array;
    oaepHash: string;
    oaepLabel?: Uint8Array;
};

export function readAsymmetricCipherArgs(
    keyOrOptions: KeyInput | { key: KeyInput; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
): AsymmetricCipherArgs {
    if (
        isKeyObject(keyOrOptions)
        || typeof keyOrOptions === 'string'
        || keyOrOptions instanceof ArrayBuffer
        || ArrayBuffer.isView(keyOrOptions)
    ) {
        return {
            key: getKeyBytes(keyOrOptions),
            data: toBuffer(data),
            oaepHash: 'sha256',
        };
    }

    if (keyOrOptions && typeof keyOrOptions === 'object' && 'key' in keyOrOptions) {
        return {
            key: getKeyBytes(keyOrOptions.key),
            data: toBuffer(data),
            oaepHash: keyOrOptions.oaepHash?.toLowerCase() || 'sha256',
            oaepLabel: keyOrOptions.oaepLabel ? toBuffer(keyOrOptions.oaepLabel) : undefined,
        };
    }

    throw new TypeError('Invalid key or options for asymmetric cipher');
}

/* ------------------------------------------------------------------------- *
 * asymmetricKeyDetails for PARSED keys
 *
 * `createPrivateKey`/`createPublicKey` built KeyObjects with no details, so
 * `asymmetricKeyDetails` was `undefined` for every key that came from a PEM or
 * DER -- i.e. every key loaded from a file, which is how production keys are
 * actually supplied. `jsonwebtoken` reads `.asymmetricKeyDetails.namedCurve` to
 * check the curve against the algorithm, so ES256/ES384 signing crashed with
 * "cannot read property 'namedCurve' of undefined" for a real .pem while
 * working for a key generated in the same process.
 *
 * Node's exact shapes (measured, v24.18.0):
 *   EC       { namedCurve: 'prime256v1' | 'secp384r1' | 'secp521r1' }
 *   RSA      { modulusLength: <bits>, publicExponent: <BigInt> }
 *   ed/x     {}          (present but empty)
 *   secret   undefined
 * ------------------------------------------------------------------------- */

// OID content octets (hex) -> the curve name Node reports.
const EC_CURVE_NAME = new Map<string, string>([
    ['2a8648ce3d030107', 'prime256v1'],
    ['2b81040022', 'secp384r1'],
    ['2b81040023', 'secp521r1'],
    ['2b8104000a', 'secp256k1'],
]);

const RSA_OIDS = new Set<string>(['2a864886f70d010101', '2a864886f70d01010a']);
const RFC8410_OIDS = new Set<string>(['2b6570', '2b6571', '2b656e', '2b656f']);

/**
 * Walk to the first two INTEGERs of an RSA key body and report (modulus bits,
 * exponent). Structural like `collectDerOids`: descend only constructed nodes,
 * and follow the one OCTET STRING (PKCS#8) or BIT STRING (SPKI) that wraps the
 * inner RSAPrivateKey/RSAPublicKey, never re-parsing arbitrary primitives.
 */
function readRsaIntegers(der: Uint8Array, depth: number): { modulusLength: number; publicExponent: bigint } | undefined {
    if (depth > 4) return undefined;
    let offset = 0;
    const ints: Uint8Array[] = [];
    while (offset < der.length) {
        const tag = der[offset++];
        if (tag === undefined) break;
        if ((tag & 0x1f) === 0x1f) break;
        const parsed = readAsn1LengthOrUndefined(der, offset);
        if (!parsed) break;
        const end = parsed.offset + parsed.length;
        if (end > der.length) break;
        const body = der.subarray(parsed.offset, end);
        if (tag === 0x02) {
            ints.push(body);
            // PKCS#1 RSAPrivateKey leads with version 0; skip it.
            if (ints.length >= 2 && !(ints.length === 2 && ints[0]?.length === 1 && ints[0][0] === 0)) break;
        } else if (tag === 0x04 || tag === 0x03) {
            // OCTET STRING (PKCS#8) / BIT STRING (SPKI, leading unused-bits byte).
            const inner = tag === 0x03 ? body.subarray(1) : body;
            const found = readRsaIntegers(inner, depth + 1);
            if (found) return found;
        } else if ((tag & 0x20) !== 0) {
            const found = readRsaIntegers(body, depth + 1);
            if (found) return found;
        }
        offset = end;
    }
    // Drop a leading version INTEGER of value 0, then take modulus + exponent.
    const usable = (ints.length >= 3 && ints[0]?.length === 1 && ints[0][0] === 0) ? ints.slice(1) : ints;
    const modulus = usable[0];
    const exponent = usable[1];
    if (!modulus || !exponent) return undefined;
    // Strip DER's sign-padding zero before counting bits.
    let i = 0;
    while (i < modulus.length && modulus[i] === 0) i++;
    const significant = modulus.subarray(i);
    if (significant.length === 0) return undefined;
    let exp = 0n;
    for (const byte of exponent) exp = (exp << 8n) | BigInt(byte);
    return { modulusLength: significant.length * 8, publicExponent: exp };
}

export type AsymmetricKeyDetails = { namedCurve?: string; modulusLength?: number; publicExponent?: bigint };

/**
 * Derive Node's `asymmetricKeyDetails` from encoded key material, or undefined
 * when these bytes are not a key structure this build recognises.
 */
export function keyDetailsFromBytes(keyBytes: Uint8Array): AsymmetricKeyDetails | undefined {
    // Structure BEFORE length. An ed25519/x25519 PKCS#8 is 48 bytes, which is
    // also P-384's coordinate width, so trusting the raw-length probe first
    // reported `namedCurve: 'secp384r1'` for an Ed25519 DER key. Only fall back
    // to the length heuristic when these bytes are not a PEM/DER structure.
    const parsed = derFromKeyBytes(keyBytes);
    if (parsed) {
        const oids: string[] = [];
        collectDerOids(parsed.der, oids, 0);
        for (const oid of oids) {
            const name = EC_CURVE_NAME.get(oid);
            if (name !== undefined) return { namedCurve: name };
        }
        for (const oid of oids) {
            if (RFC8410_OIDS.has(oid)) return {};
        }
        for (const oid of oids) {
            if (RSA_OIDS.has(oid)) return readRsaIntegers(parsed.der, 0);
        }
        // PKCS#1 carries no OID -- a bare SEQUENCE of INTEGERs -- so the PEM
        // label is the only signal, matching classifyKeyForP1363.
        if (parsed.label.indexOf('RSA') >= 0) return readRsaIntegers(parsed.der, 0);
        return undefined;
    }

    const rawSize = detectEcCoordinateSize(keyBytes);
    if (rawSize !== undefined) {
        for (const [oid, name] of EC_CURVE_NAME) {
            if (EC_CURVE_COORDINATE_SIZE.get(oid) === rawSize) return { namedCurve: name };
        }
    }
    return undefined;
}
