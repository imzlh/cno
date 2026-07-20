/**
 * Node.js crypto module - type definitions
 */

export type BinaryInput = ArrayBuffer | ArrayBufferView | string;
export interface SecretJwk {
    kty: 'oct';
    k: string;
}

export interface KeyExportOptions {
    type?: 'pkcs8' | 'spki';
    format?: 'pem' | 'der' | 'jwk';
}

export interface KeyObject {
    readonly type: 'private' | 'public' | 'secret';
    readonly asymmetricKeyType?: 'rsa' | 'ec';
    readonly asymmetricKeyDetails?: { namedCurve?: string; modulusLength?: number };
    readonly symmetricKeySize?: number;
    export(options?: KeyExportOptions): Uint8Array | string | SecretJwk;
    readonly [Symbol.toStringTag]: 'KeyObject';
}

export type KeyInput = BinaryInput | KeyObject;

export interface KeyWithOptions {
    key: KeyInput;
    dsaEncoding?: 'der' | 'ieee-p1363';
}

import type { Transform, TransformOptions } from '../stream';

export interface Hash extends Transform {
    update(input: BinaryInput, encoding?: string): Hash;
    digest(encoding?: string): Uint8Array | string;
    copy(options?: TransformOptions): Hash;
}

export interface Hmac extends Transform {
    update(input: BinaryInput, encoding?: string): Hmac;
    digest(encoding?: string): Uint8Array | string;
}

export interface Cipheriv extends Transform {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): Uint8Array | string;
    final(outputEncoding?: string): Uint8Array | string;
    setAutoPadding(autoPadding?: boolean): this;
}

export interface Decipheriv extends Transform {
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): Uint8Array | string;
    final(outputEncoding?: string): Uint8Array | string;
    setAutoPadding(autoPadding?: boolean): this;
}

export interface CipherGCM extends Cipheriv {
    setAAD(aad: ArrayBuffer | Uint8Array): CipherGCM;
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): Uint8Array | string;
    final(outputEncoding?: string): Uint8Array | string;
    getAuthTag(): Uint8Array;
}

export interface DecipherGCM extends Decipheriv {
    setAAD(aad: ArrayBuffer | Uint8Array): DecipherGCM;
    setAuthTag(tag: ArrayBuffer | Uint8Array): DecipherGCM;
    update(data: BinaryInput, inputEncoding?: string, outputEncoding?: string): Uint8Array | string;
    final(outputEncoding?: string): Uint8Array | string;
}

export interface GcmEncryptResult {
    ciphertext: ArrayBuffer;
    tag: ArrayBuffer;
}

export interface GcmDecryptResult {
    plaintext: ArrayBuffer;
    verified: boolean;
}

export interface CipherInfo {
    name: string;
    nid: number;
    blockSize: number;
    ivLength: number;
    keyLength: number;
    mode: string;
}

export interface Sign {
    update(input: BinaryInput, encoding?: string): Sign;
    sign(privateKey: KeyInput | KeyWithOptions, outputEncoding?: string): Uint8Array | string;
}

export interface Verify {
    update(input: BinaryInput, encoding?: string): Verify;
    verify(publicKey: KeyInput | KeyWithOptions, signature: BinaryInput, signatureEncoding?: string): boolean;
}
