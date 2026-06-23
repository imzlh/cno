/**
 * Crypto module - shared types and helper functions
 */

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

type BinaryInput = ArrayBuffer | Uint8Array | string;

export { BinaryInput };

export function toBuffer(data: ArrayBuffer | Uint8Array | string, encoding: string = 'utf8'): Uint8Array {
    if (typeof data === 'string') {
        if (encoding === 'hex') return new Uint8Array(crypto.hexDecode(data));
        if (encoding === 'base64') return new Uint8Array(crypto.base64Decode(data));
        if (encoding === 'base64url') return new Uint8Array(crypto.base64Decode(data.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - data.length % 4) % 4)));
        if (encoding === 'latin1' || encoding === 'ascii' || encoding === 'binary') {
            const buf = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i);
            return buf;
        }
        return engine.encodeString(data);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
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

export function concatBuffers(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
}

export function isGcmAlgorithm(algorithm: string): boolean {
    const a = algorithm.toLowerCase();
    return a === 'aes-128-gcm' || a === 'aes-192-gcm' || a === 'aes-256-gcm';
}

export function normalizeHashAlgorithm(algorithm: string): string {
    return algorithm.toLowerCase().replace(/-/g, '');
}

export function readAsymmetricCipherArgs(
    keyOrOptions: ArrayBuffer | Uint8Array | { key: ArrayBuffer | Uint8Array; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
) {
    if (keyOrOptions instanceof ArrayBuffer || keyOrOptions instanceof Uint8Array) {
        return { key: toBuffer(keyOrOptions), data: toBuffer(data), oaepHash: 'sha256', oaepLabel: undefined as Uint8Array | undefined };
    }
    return { key: toBuffer(keyOrOptions.key), data: toBuffer(data), oaepHash: keyOrOptions.oaepHash?.toLowerCase() || 'sha256', oaepLabel: keyOrOptions.oaepLabel ? toBuffer(keyOrOptions.oaepLabel) : undefined };
}
