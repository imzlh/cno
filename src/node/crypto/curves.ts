/** EC curve name resolution. Shared by ECDSA, ECDH and key generation. */

import { withCode } from './errors';

export function resolveCurve(curve: string): 'p256' | 'p384' | 'p521' {
    switch (curve.toLowerCase()) {
        case 'p256': case 'p-256': case 'prime256v1': case 'secp256r1': return 'p256';
        case 'p384': case 'p-384': case 'secp384r1': return 'p384';
        case 'p521': case 'p-521': case 'secp521r1': return 'p521';
        default: throw withCode(new Error('Invalid EC curve name'), 'ERR_CRYPTO_INVALID_CURVE');
    }
}

export type EcdhCurve = 'p256' | 'p384' | 'p521' | 'secp256k1';

export function resolveEcdhCurve(curve: string): EcdhCurve {
    if (curve.toLowerCase() === 'secp256k1') return 'secp256k1';
    return resolveCurve(curve);
}
