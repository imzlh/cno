/** ECDSA signature re-encoding between DER and IEEE P1363 (the dsaEncoding option). */

import type { BinaryInput, KeyInput, KeyWithOptions } from './types';
import { toBuffer, encodeOutput, classifyKeyForP1363, derToP1363, p1363ToDer, readKeyOptions } from './helpers';

/**
 * Sign side: convert the native DER signature to P1363 when the key is EC.
 *
 * Node ignores dsaEncoding for non-EC keys, so an RSA key must get its signature
 * back untouched -- previously it was fed to the EC converter and threw
 * `TypeError: Unable to determine EC key size`, where Node v24.18.0 returns a
 * normal 128-byte PKCS#1 signature. The EC size now comes from the key's curve
 * OID, so a PEM or DER EC key works too; it used to throw for all three curves
 * because no raw byte length matched.
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
 * Verify side: turn a P1363 signature into DER, or report that it cannot be one.
 *
 * Returns null for "no signature of this shape can be valid for this key", which
 * the callers turn into `false`. Node never throws for a malformed signature -- it
 * returns false -- and the signature bytes come from the remote peer, so throwing
 * here converted a failed verification into an uncaught exception (measured on 9
 * of 9 malformed-length cases).
 *
 * The length is checked against the KEY's coordinate size, not inferred from the
 * signature. Inferring it from the signature accepted a valid signature
 * zero-extended to any even length -- measured TRUE in cno and FALSE in Node on
 * 12 of 12 crafted cases across P-256/P-384/P-521. That is unbounded signature
 * malleability: one valid signature yields arbitrarily many distinct accepted
 * byte strings, which breaks any caller using signature bytes as a dedup or
 * replay key.
 */
export function normalizeSignatureForVerify(signature: BinaryInput, signatureEncoding: string | undefined, keyInput: KeyInput | KeyWithOptions): Uint8Array | null {
    const { key, dsaEncoding } = readKeyOptions(keyInput);
    const sigBuf = toBuffer(signature, signatureEncoding);
    if (dsaEncoding !== 'ieee-p1363') return sigBuf;

    const shape = classifyKeyForP1363(key);
    // Node ignores dsaEncoding for non-EC keys: hand the signature straight to
    // the verifier instead of mangling a valid RSA signature into a false.
    if (shape.kind === 'non-ec') return sigBuf;
    if (shape.kind === 'ec' && sigBuf.length !== shape.coordinateSize * 2) return null;
    // Unknown key shape: keep the old structural requirement, but report a bad
    // length as an invalid signature rather than throwing.
    if (sigBuf.length === 0 || sigBuf.length % 2 !== 0) return null;
    return new Uint8Array(p1363ToDer(sigBuf));
}
