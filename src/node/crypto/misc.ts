/** Encoding helpers, padding constants, algorithm enumeration and randomUUID. */

const crypto = import.meta.use('crypto');
import type { CipherInfo } from './types';
import { toBuffer } from './helpers';

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
