/** createSign / createVerify and the one-shot sign / verify functions. */

const crypto = import.meta.use('crypto');
import { Buffer } from '../buffer';
import type { BinaryInput, KeyInput, KeyWithOptions, Sign, Verify } from './types';
import { toBuffer, concatBuffers, normalizeHashAlgorithm, readKeyOptions, rejectUnsupportedPadding } from './helpers';
import { withCode } from './errors';
import { maybeEncodeSignatureForSign, normalizeSignatureForVerify } from './sigcodec';

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
            // The one-shot crypto.sign() guards padding, but this streaming path
            // read only `key` and dropped `padding`, so createSign(...).sign({
            // key, padding: RSA_PKCS1_PSS_PADDING }) silently produced a PKCS#1
            // v1.5 signature. Measured on the 21:53 binary against Node v24.18.0.
            rejectUnsupportedPadding(padding, 'sign');
            const allData = concatBuffers(data);
            data = [];

            let result: ArrayBuffer;
            switch (algorithm.toLowerCase()) {
                case 'rsa-sha224':
                case 'sha224':
                    result = crypto.signSha224(key, allData);
                    break;
                case 'rsa-sha256':
                case 'sha256':
                    result = crypto.signSha256(key, allData);
                    break;
                case 'rsa-sha384':
                case 'sha384':
                    result = crypto.signSha384(key, allData);
                    break;
                case 'rsa-sha512':
                case 'sha512':
                    result = crypto.signSha512(key, allData);
                    break;
                default:
                    throw new Error(`Unsupported sign algorithm: ${algorithm}`);
            }

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
            // Same hole as createSign above, and worse on this side: dropping
            // `padding` made createVerify(...).verify({ key, padding: PSS }, sig)
            // return TRUE for a PKCS#1 v1.5 signature — a signature-scheme
            // confusion. Node v24.18.0 returns false. OBSERVED, then fixed.
            rejectUnsupportedPadding(padding, 'verify');
            const sigBuf = normalizeSignatureForVerify(signature, signatureEncoding, publicKey);
            const allData = concatBuffers(data);
            data = [];
            // null means the signature cannot be valid for this key (wrong P1363
            // length). Node returns false for that; it does not throw.
            if (sigBuf === null) return false;

            switch (algorithm.toLowerCase()) {
                case 'rsa-sha224':
                case 'sha224':
                    return crypto.verifySha224(key, allData, sigBuf);
                case 'rsa-sha256':
                case 'sha256':
                    return crypto.verifySha256(key, allData, sigBuf);
                case 'rsa-sha384':
                case 'sha384':
                    return crypto.verifySha384(key, allData, sigBuf);
                case 'rsa-sha512':
                case 'sha512':
                    return crypto.verifySha512(key, allData, sigBuf);
                default:
                    throw new Error(`Unsupported verify algorithm: ${algorithm}`);
            }
        },
    };
}

export function sign(algorithm: string, data: BinaryInput, key: KeyInput | KeyWithOptions): Uint8Array | string {
    const dataBuf = toBuffer(data);
    const { key: keyBuf, padding } = readKeyOptions(key);
    rejectUnsupportedPadding(padding, 'sign');
    let result: ArrayBuffer;

    switch (algorithm.toLowerCase()) {
        case 'rsa-sha224':
        case 'sha224':
            result = crypto.signSha224(keyBuf, dataBuf);
            break;
        case 'rsa-sha256':
        case 'sha256':
            result = crypto.signSha256(keyBuf, dataBuf);
            break;
        case 'rsa-sha384':
        case 'sha384':
            result = crypto.signSha384(keyBuf, dataBuf);
            break;
        case 'rsa-sha512':
        case 'sha512':
            result = crypto.signSha512(keyBuf, dataBuf);
            break;
        default:
            throw new Error(`Unsupported sign algorithm: ${algorithm}`);
    }
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

    switch (algorithm.toLowerCase()) {
        case 'rsa-sha224':
        case 'sha224':
            return crypto.verifySha224(keyBuf, dataBuf, sigBuf);
        case 'rsa-sha256':
        case 'sha256':
            return crypto.verifySha256(keyBuf, dataBuf, sigBuf);
        case 'rsa-sha384':
        case 'sha384':
            return crypto.verifySha384(keyBuf, dataBuf, sigBuf);
        case 'rsa-sha512':
        case 'sha512':
            return crypto.verifySha512(keyBuf, dataBuf, sigBuf);
        default:
            throw new Error(`Unsupported verify algorithm: ${algorithm}`);
    }
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
