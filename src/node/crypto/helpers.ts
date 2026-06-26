/**
 * Node.js crypto module - shared helper functions
 */

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
import type { BinaryInput, Cipheriv, Decipheriv, Hmac } from './types';

export function toBuffer(data: ArrayBuffer | Uint8Array | string, encoding: string = 'utf8'): Uint8Array {
    if (typeof data === 'string') {
        if (encoding === 'hex') return new Uint8Array(crypto.hexDecode(data));
        if (encoding === 'base64') return new Uint8Array(crypto.base64Decode(data));
        if (encoding === 'base64url') {
            const stripped = data.replace(/=+$/, '');
            return new Uint8Array(crypto.base64Decode(stripped.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - stripped.length % 4) % 4)));
        }
        if (encoding === 'latin1' || encoding === 'ascii' || encoding === 'binary') {
            const buf = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i);
            return buf;
        }
        return engine.encodeString(data);
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    return data;
}

export function encodeOutput(data: ArrayBuffer, encoding?: string): ArrayBuffer | string {
    if (!encoding) return data;
    if (encoding === 'hex') return crypto.hexEncode(data);
    if (encoding === 'base64') return crypto.base64Encode(data);
    if (encoding === 'base64url') {
        const b64 = crypto.base64Encode(data) as string;
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return data;
}

export function concatBuffers(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

export function createBufferedCipher(
    transform: (data: Uint8Array) => ArrayBuffer,
    blockSize = 16,
): Cipheriv {
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
            return encodeOutput(result.buffer, outputEncoding);
        },
        final(outputEncoding?: string) {
            const buf = concatBuffers(chunks);
            chunks.length = 0;
            return encodeOutput(transform(buf), outputEncoding);
        },
    };
}

export function createBufferedDecipher(
    transform: (data: Uint8Array) => ArrayBuffer,
    blockSize = 16,
): Decipheriv {
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
            return encodeOutput(result.buffer, outputEncoding);
        },
        final(outputEncoding?: string) {
            const buf = concatBuffers(chunks);
            chunks.length = 0;
            return encodeOutput(transform(buf), outputEncoding);
        },
    };
}

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
        case 'sha1': return crypto.hmacSha1(key, data);
        case 'sha256': return crypto.hmacSha256(key, data);
        case 'sha512': return crypto.hmacSha512(key, data);
        default: throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
    }
}

export function createOneShotHmac(algorithm: string, key: Uint8Array): Hmac {
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

export function readAsymmetricCipherArgs(
    keyOrOptions: ArrayBuffer | Uint8Array | { key: ArrayBuffer | Uint8Array; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
) {
    if (keyOrOptions instanceof ArrayBuffer || keyOrOptions instanceof Uint8Array) {
        return {
            key: toBuffer(keyOrOptions),
            data: toBuffer(data),
            oaepHash: 'sha256',
            oaepLabel: undefined as Uint8Array | undefined,
        };
    }

    return {
        key: toBuffer(keyOrOptions.key),
        data: toBuffer(data),
        oaepHash: keyOrOptions.oaepHash?.toLowerCase() || 'sha256',
        oaepLabel: keyOrOptions.oaepLabel ? toBuffer(keyOrOptions.oaepLabel) : undefined,
    };
}
