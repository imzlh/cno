/**
 * Node.js crypto module - type definitions
 */

export type BinaryInput = ArrayBuffer | Uint8Array | string;

export interface Hash {
    update(input: BinaryInput, encoding?: string): Hash;
    digest(encoding?: string): ArrayBuffer | string;
}

export interface Hmac {
    update(input: BinaryInput, encoding?: string): Hmac;
    digest(encoding?: string): ArrayBuffer | string;
}

export interface Cipheriv {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): ArrayBuffer | string;
    final(outputEncoding?: string): ArrayBuffer | string;
}

export interface Decipheriv {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): ArrayBuffer | string;
    final(outputEncoding?: string): ArrayBuffer | string;
}

export interface CipherGCM {
    setAAD(aad: ArrayBuffer | Uint8Array): CipherGCM;
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): ArrayBuffer | string;
    final(outputEncoding?: string): ArrayBuffer | string;
    getAuthTag(): ArrayBuffer;
}

export interface DecipherGCM {
    setAAD(aad: ArrayBuffer | Uint8Array): DecipherGCM;
    setAuthTag(tag: ArrayBuffer | Uint8Array): DecipherGCM;
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): ArrayBuffer | string;
    final(outputEncoding?: string): ArrayBuffer | string;
}

export interface GcmEncryptResult {
    ciphertext: ArrayBuffer;
    tag: ArrayBuffer;
}

export interface GcmDecryptResult {
    plaintext: ArrayBuffer;
    verified: boolean;
}

export interface Sign {
    update(input: BinaryInput, encoding?: string): Sign;
    sign(privateKey: ArrayBuffer | Uint8Array, outputEncoding?: string): ArrayBuffer | string;
}

export interface Verify {
    update(input: BinaryInput, encoding?: string): Verify;
    verify(publicKey: ArrayBuffer | Uint8Array, signature: ArrayBuffer | Uint8Array, signatureEncoding?: string): boolean;
}
