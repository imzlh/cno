/** createSign / createVerify and the one-shot sign / verify functions. */

const crypto = import.meta.use('crypto');
import type { BinaryInput, KeyInput, KeyWithOptions, Sign, Verify } from './types';
import { toBuffer, concatBuffers, readKeyOptions, rejectUnsupportedPadding } from './helpers';
import { maybeEncodeSignatureForSign, normalizeSignatureForVerify } from './sigcodec';

const signatureAlgorithms = new Map([
    ['sha224', { sign: crypto.signSha224, verify: crypto.verifySha224 }],
    ['sha256', { sign: crypto.signSha256, verify: crypto.verifySha256 }],
    ['sha384', { sign: crypto.signSha384, verify: crypto.verifySha384 }],
    ['sha512', { sign: crypto.signSha512, verify: crypto.verifySha512 }],
]);

function signatureAlgorithm(algorithm: string, operation: 'sign' | 'verify') {
    const name = algorithm.toLowerCase();
    const methods = signatureAlgorithms.get(name.startsWith('rsa-') ? name.slice(4) : name);
    if (!methods) throw new Error(`Unsupported ${operation} algorithm: ${algorithm}`);
    return methods;
}

// sign / verify

export function createSign(algorithm: string): Sign {
    let data: Uint8Array[] = [];

    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            data.push(toBuffer(input, encoding));
            return this;
        },
        sign(privateKey: KeyInput | KeyWithOptions, outputEncoding?: string) {
            const { key, padding } = readKeyOptions(privateKey);
            // Never silently downgrade a requested signature scheme.
            rejectUnsupportedPadding(padding, 'sign');
            const allData = concatBuffers(data);
            data = [];

            const result = signatureAlgorithm(algorithm, 'sign').sign(key, allData);
            return maybeEncodeSignatureForSign(result, privateKey, outputEncoding);
        },
    };
}

export function createVerify(algorithm: string): Verify {
    let data: Uint8Array[] = [];

    return {
        update(input: ArrayBuffer | Uint8Array | string, encoding?: string) {
            data.push(toBuffer(input, encoding));
            return this;
        },
        verify(publicKey: KeyInput | KeyWithOptions, signature: BinaryInput, signatureEncoding?: string) {
            const { key, padding } = readKeyOptions(publicKey);
            rejectUnsupportedPadding(padding, 'verify');
            const sigBuf = normalizeSignatureForVerify(signature, signatureEncoding, publicKey);
            const allData = concatBuffers(data);
            data = [];
            // null means the signature cannot be valid for this key (wrong P1363
            // length). Node returns false for that; it does not throw.
            if (sigBuf === null) return false;

            return signatureAlgorithm(algorithm, 'verify').verify(key, allData, sigBuf);
        },
    };
}

export function sign(algorithm: string, data: BinaryInput, key: KeyInput | KeyWithOptions): Uint8Array | string {
    const dataBuf = toBuffer(data);
    const { key: keyBuf, padding } = readKeyOptions(key);
    rejectUnsupportedPadding(padding, 'sign');
    const result = signatureAlgorithm(algorithm, 'sign').sign(keyBuf, dataBuf);
    return maybeEncodeSignatureForSign(result, key);
}

export function generateRsaKey(bits?: number): CModuleCrypto.RsaKeyPair {
    return crypto.generateRsaKey(bits);
}

export function signSha256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha256(toBuffer(key), toBuffer(data));
}

export function signSha224(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha224(toBuffer(key), toBuffer(data));
}

export function signSha384(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha384(toBuffer(key), toBuffer(data));
}

export function signSha512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.signSha512(toBuffer(key), toBuffer(data));
}

export function verify(algorithm: string, data: BinaryInput, key: KeyInput | KeyWithOptions, signature: BinaryInput): boolean {
    const dataBuf = toBuffer(data);
    const { key: keyBuf, padding } = readKeyOptions(key);
    rejectUnsupportedPadding(padding, 'verify');
    const sigBuf = normalizeSignatureForVerify(signature, undefined, key);
    // null means the signature cannot be valid for this key (wrong P1363
    // length). Node returns false for that; it does not throw.
    if (sigBuf === null) return false;

    return signatureAlgorithm(algorithm, 'verify').verify(keyBuf, dataBuf, sigBuf);
}

export function verifySha256(
    key: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.verifySha256(toBuffer(key), toBuffer(data), toBuffer(signature));
}

export function verifySha224(
    key: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.verifySha224(toBuffer(key), toBuffer(data), toBuffer(signature));
}

export function verifySha384(
    key: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.verifySha384(toBuffer(key), toBuffer(data), toBuffer(signature));
}

export function verifySha512(
    key: ArrayBuffer | Uint8Array | string,
    data: ArrayBuffer | Uint8Array | string,
    signature: ArrayBuffer | Uint8Array | string,
): boolean {
    return crypto.verifySha512(toBuffer(key), toBuffer(data), toBuffer(signature));
}
