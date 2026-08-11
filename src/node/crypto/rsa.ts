/** RSA-OAEP encrypt/decrypt and the RSA-PSS one-shot wrappers. */

const crypto = import.meta.use('crypto');
import { Buffer } from '../buffer';
import type { BinaryInput, KeyInput, KeyWithOptions } from './types';
import { toBuffer, readAsymmetricCipherArgs } from './helpers';

// RSA-OAEP

export function publicEncrypt(
    key: KeyInput | { key: KeyInput; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
): Buffer {
    const args = readAsymmetricCipherArgs(key, data);
    let result: ArrayBuffer;
    switch (args.oaepHash) {
        case 'sha256':
            result = crypto.rsaOaepSha256Encrypt(args.key, args.data, args.oaepLabel);
            break;
        case 'sha512':
            result = crypto.rsaOaepSha512Encrypt(args.key, args.data, args.oaepLabel);
            break;
        default:
            throw new Error(`Unsupported OAEP hash algorithm: ${args.oaepHash}`);
    }
    return Buffer.from(new Uint8Array(result));
}

export function privateDecrypt(
    key: KeyInput | { key: KeyInput; oaepHash?: string; oaepLabel?: ArrayBuffer | Uint8Array },
    data: ArrayBuffer | Uint8Array,
): Buffer {
    const args = readAsymmetricCipherArgs(key, data);
    let result: ArrayBuffer;
    switch (args.oaepHash) {
        case 'sha256':
            result = crypto.rsaOaepSha256Decrypt(args.key, args.data, args.oaepLabel);
            break;
        case 'sha512':
            result = crypto.rsaOaepSha512Decrypt(args.key, args.data, args.oaepLabel);
            break;
        default:
            throw new Error(`Unsupported OAEP hash algorithm: ${args.oaepHash}`);
    }
    return Buffer.from(new Uint8Array(result));
}

export function rsaOaepSha256Encrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, label?: ArrayBuffer | Uint8Array): ArrayBuffer {
    return crypto.rsaOaepSha256Encrypt(toBuffer(key), toBuffer(data), label ? toBuffer(label) : undefined);
}

export function rsaOaepSha256Decrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, label?: ArrayBuffer | Uint8Array): ArrayBuffer {
    return crypto.rsaOaepSha256Decrypt(toBuffer(key), toBuffer(data), label ? toBuffer(label) : undefined);
}

export function rsaOaepSha512Encrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, label?: ArrayBuffer | Uint8Array): ArrayBuffer {
    return crypto.rsaOaepSha512Encrypt(toBuffer(key), toBuffer(data), label ? toBuffer(label) : undefined);
}

export function rsaOaepSha512Decrypt(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, label?: ArrayBuffer | Uint8Array): ArrayBuffer {
    return crypto.rsaOaepSha512Decrypt(toBuffer(key), toBuffer(data), label ? toBuffer(label) : undefined);
}

export function rsaPssSha256Sign(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, saltLength?: number): ArrayBuffer {
    return crypto.rsaPssSha256Sign(toBuffer(key), toBuffer(data), saltLength);
}

export function rsaPssSha256Verify(key: ArrayBuffer | Uint8Array, data: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array, saltLength?: number): boolean {
    return crypto.rsaPssSha256Verify(toBuffer(key), toBuffer(data), toBuffer(signature), saltLength);
}
