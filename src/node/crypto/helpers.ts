/**
 * Node.js crypto module - shared helper functions
 */

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const algorithm = import.meta.use('algorithm');
import { Buffer } from '../buffer';
import type { BinaryInput, KeyInput, KeyObject, KeyWithOptions } from './types';
import { concatChunks as concatBuffers } from '../_internal/buffer';
export { concatBuffers };

export const kKeyData = Symbol('cno.node.crypto.keyData');
export const kKeyFormat = Symbol('cno.node.crypto.keyFormat');
export type KeyFormat = 'raw' | 'pem' | 'der';

export function toBuffer(data: BinaryInput, encoding: string = 'utf8'): Uint8Array {
    if (typeof data === 'string') {
        if (encoding === 'hex') return algorithm.hexDecodeLoose(data);
        if (encoding === 'base64' || encoding === 'base64url') return algorithm.base64DecodeLoose(data);
        if (encoding === 'latin1' || encoding === 'ascii' || encoding === 'binary') {
            return algorithm.latin1EncodeLoose(data);
        }
        return engine.encodeString(data);
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError('The input must be a string, ArrayBuffer, or ArrayBufferView');
}

export function toExactArrayBuffer(data: Uint8Array): ArrayBuffer {
    if (data.buffer instanceof ArrayBuffer) {
        if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer;
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
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
    asymmetricKeyType?: 'rsa' | 'ec';
} {
    return value !== null && typeof value === 'object'
        && Reflect.get(value, Symbol.toStringTag) === 'KeyObject'
        && kKeyData in value;
}

export function guessKeyFormat(input: BinaryInput, explicit?: 'pem' | 'der'): KeyFormat {
    if (explicit) return explicit;
    return typeof input === 'string' ? 'pem' : 'der';
}

export function getKeyBytes(input: KeyInput): Uint8Array {
    if (isKeyObject(input)) {
        return input[kKeyData];
    }
    if (typeof input === 'string' || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
        return toBuffer(input);
    }
    throw new TypeError('The key must be a KeyObject, string, ArrayBuffer, or ArrayBufferView');
}

export function readKeyOptions(input: KeyInput | KeyWithOptions): { key: Uint8Array; dsaEncoding: 'der' | 'ieee-p1363' } {
    if (input && typeof input === 'object' && !isKeyObject(input) && !(input instanceof Uint8Array) && !(input instanceof ArrayBuffer) && 'key' in input) {
        const opts = input as KeyWithOptions;
        return {
            key: getKeyBytes(opts.key),
            dsaEncoding: opts.dsaEncoding === 'ieee-p1363' ? 'ieee-p1363' : 'der',
        };
    }
    return {
        key: getKeyBytes(input as KeyInput),
        dsaEncoding: 'der',
    };
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

function readAsn1Length(bytes: Uint8Array, offset: number): { length: number; offset: number } {
    const first = bytes[offset++];
    if (first === undefined) {
        throw new Error('Invalid DER length');
    }
    if ((first & 0x80) === 0) {
        return { length: first, offset };
    }

    const count = first & 0x7f;
    if (count === 0 || count > 4 || offset + count > bytes.length) {
        throw new Error('Invalid DER length');
    }

    let length = 0;
    for (let i = 0; i < count; i++) {
        const byte = bytes[offset + i];
        if (byte === undefined) throw new Error('Invalid DER length');
        length = (length << 8) | byte;
    }
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
