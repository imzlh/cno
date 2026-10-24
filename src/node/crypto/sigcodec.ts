/** ECDSA signature re-encoding between DER and IEEE P1363 (the dsaEncoding option). */

import type { BinaryInput, KeyInput, KeyWithOptions } from './types';
import { toBuffer, encodeOutput, classifyKeyForP1363, derToP1363, p1363ToDer, readKeyOptions } from './helpers';

/**
 * Sign side: convert the native DER signature to P1363 when the key is EC.
 * dsaEncoding is ignored for non-EC keys, so an RSA signature passes through
 * untouched.
 */
export function signatureToP1363(signature: ArrayBuffer, keyBytes: Uint8Array): ArrayBuffer {
    const shape = classifyKeyForP1363(keyBytes);
    if (shape.kind === 'non-ec') return signature;
    if (shape.kind === 'unknown') {
        throw new TypeError('Unable to determine EC key size for ieee-p1363 signature');
    }
    return derToP1363(signature, shape.coordinateSize);
}

export function maybeEncodeSignatureForSign(signature: ArrayBuffer, keyInput: KeyInput | KeyWithOptions, outputEncoding?: string): Uint8Array | string {
    const { key, dsaEncoding } = readKeyOptions(keyInput);
    const out = dsaEncoding === 'ieee-p1363' ? signatureToP1363(signature, key) : signature;
    return outputEncoding ? encodeOutput(out, outputEncoding) : Buffer.from(new Uint8Array(out));
}

/**
 * Verify side: turn a P1363 signature into DER, or return null for "cannot be
 * valid", which callers turn into `false`. Never throw here: the signature comes
 * from the peer, and the length is checked against the KEY's coordinate size --
 * inferring it from the signature accepts zero-extended forgeries (see
 * docs/node-internals.md#crypto-p1363-key-inspection).
 */
export function normalizeSignatureForVerify(signature: BinaryInput, signatureEncoding: string | undefined, keyInput: KeyInput | KeyWithOptions): Uint8Array | null {
    const { key, dsaEncoding } = readKeyOptions(keyInput);
    const sigBuf = toBuffer(signature, signatureEncoding);
    if (dsaEncoding !== 'ieee-p1363') return sigBuf;

    const shape = classifyKeyForP1363(key);
    // Non-EC keys ignore dsaEncoding: do not mangle a valid RSA signature.
    if (shape.kind === 'non-ec') return sigBuf;
    if (shape.kind === 'ec' && sigBuf.length !== shape.coordinateSize * 2) return null;
    // Unknown key shape: structural check, reported as an invalid signature.
    if (sigBuf.length === 0 || sigBuf.length % 2 !== 0) return null;
    return new Uint8Array(p1363ToDer(sigBuf));
}
