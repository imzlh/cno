/**
 * node:tls error shaping and peer-identity checking: the X509_V_ERR_* -> Node
 * `code` table, the error factories that `authorizationError` and the emitted
 * 'error' carry, `checkServerIdentity`, and the cipher/version constants.
 *
 * `nameFailureError` delegates to `checkServerIdentity` to rebuild Node's
 * ERR_TLS_CERT_ALTNAME_INVALID from the peer certificate, and
 * `checkServerIdentity` builds it through `altNameError`, so all three belong
 * in one file. Pulls types plus the ssl native only, no sibling runtime imports.
 */

import type { CodedError, PeerCertificate } from './types';

const ssl = import.meta.use('ssl');

export function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * OpenSSL X509_V_ERR_* → the `code` string Node puts on the error it emits and
 * on `socket.authorizationError`. Callers branch on these (a proxy that retries
 * only on CERT_HAS_EXPIRED, a pinning check that tolerates
 * DEPTH_ZERO_SELF_SIGNED_CERT), so a bare OpenSSL string with `code: undefined`
 * makes every failure indistinguishable.
 */
const X509_ERR_CODES: Record<number, string> = {
    2: 'UNABLE_TO_GET_ISSUER_CERT',
    3: 'UNABLE_TO_GET_CRL',
    4: 'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
    5: 'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
    6: 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
    7: 'CERT_SIGNATURE_FAILURE',
    8: 'CRL_SIGNATURE_FAILURE',
    9: 'CERT_NOT_YET_VALID',
    10: 'CERT_HAS_EXPIRED',
    11: 'CRL_NOT_YET_VALID',
    12: 'CRL_HAS_EXPIRED',
    13: 'ERROR_IN_CERT_NOT_BEFORE_FIELD',
    14: 'ERROR_IN_CERT_NOT_AFTER_FIELD',
    15: 'ERROR_IN_CRL_LAST_UPDATE_FIELD',
    16: 'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
    17: 'OUT_OF_MEM',
    18: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    19: 'SELF_SIGNED_CERT_IN_CHAIN',
    20: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    21: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    22: 'CERT_CHAIN_TOO_LONG',
    23: 'CERT_REVOKED',
    24: 'INVALID_CA',
    25: 'PATH_LENGTH_EXCEEDED',
    26: 'INVALID_PURPOSE',
    27: 'CERT_UNTRUSTED',
    28: 'CERT_REJECTED',
    29: 'SUBJECT_ISSUER_MISMATCH',
    30: 'AKID_SKID_MISMATCH',
    31: 'AKID_ISSUER_SERIAL_MISMATCH',
    32: 'KEYUSAGE_NO_CERTSIGN',
    50: 'APPLICATION_VERIFICATION',
    // 62/63/64 are the name-check failures. Only 62 was mapped, so an IP-SAN
    // mismatch (64) produced an Error with NO `code` at all, and a caller
    // branching on err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' silently missed
    // it. Node reports ERR_TLS_CERT_ALTNAME_INVALID for all three. OBSERVED
    // against Node v24.18.0: case A3 of the hostname matrix.
    62: 'ERR_TLS_CERT_ALTNAME_INVALID',
    63: 'ERR_TLS_CERT_ALTNAME_INVALID',
    64: 'ERR_TLS_CERT_ALTNAME_INVALID',
    68: 'EE_KEY_TOO_SMALL',
    69: 'CA_KEY_TOO_SMALL',
    70: 'CA_MD_TOO_WEAK',
};

/** Attach a Node-shaped `code` (and `reason`) to a verification failure. */
export function codedVerifyError(message: string, verifyCode?: number): CodedError {
    const err = new Error(message) as CodedError;
    const mapped = verifyCode === undefined ? undefined : X509_ERR_CODES[verifyCode];
    if (mapped) {
        err.code = mapped;
        err.reason = message;
    }
    return err;
}

/**
 * Node's ERR_TLS_CERT_ALTNAME_INVALID carries `reason`, `host` and `cert`
 * alongside `code`, and the message is always the fixed prefix plus `reason`.
 * The exported checkServerIdentity returned a bare Error with none of those, so
 * a caller doing `err.code === 'ERR_TLS_CERT_ALTNAME_INVALID'` or reading
 * `err.host` got undefined. OBSERVED against Node v24.18.0.
 */
function altNameError(reason: string, host: string, cert?: PeerCertificate): CodedError {
    const err = new Error(`Hostname/IP does not match certificate's altnames: ${reason}`) as CodedError;
    err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
    err.reason = reason;
    err.host = host;
    if (cert) err.cert = cert;
    return err;
}

/**
 * Build Node's ERR_TLS_CERT_ALTNAME_INVALID for a name-check failure.
 *
 * OpenSSL reports only "hostname mismatch" / "IP address mismatch" and aborts
 * the handshake itself when SSL_set1_host is armed, so the terse text was all a
 * caller ever saw and `host`/`cert` were absent. Node names the host and lists
 * the cert's altnames. Rebuild that when the peer cert is reachable; otherwise
 * keep OpenSSL's text but still attach what we have.
 *
 * X509 codes: 62 hostname, 63 email, 64 IP address mismatch.
 */
export function nameFailureError(
    verifyCode: number | undefined,
    rawMessage: string,
    servername: string | undefined,
    cert: PeerCertificate | undefined,
): CodedError {
    const isNameFailure = verifyCode === 62 || verifyCode === 63 || verifyCode === 64;
    const hasCert = !!cert && Object.keys(cert).length > 0;
    if (isNameFailure && servername && hasCert) {
        const detailed = checkServerIdentity(servername, cert!) as CodedError | undefined;
        if (detailed) {
            detailed.cert = cert;
            return detailed;
        }
    }
    const err = codedVerifyError(rawMessage, verifyCode);
    if (isNameFailure) {
        err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
        if (!err.reason) err.reason = rawMessage;
        if (servername) err.host = servername;
        if (hasCert) err.cert = cert;
    }
    return err;
}

// Constants

export const DEFAULT_CIPHERS = ssl.ciphers.join(':');
export const DEFAULT_ECDH_CURVE = 'auto';
export const DEFAULT_MIN_VERSION = 'TLSv1.2';
export const DEFAULT_MAX_VERSION = 'TLSv1.3';

export function getCiphers(): string[] {
    return [...ssl.ciphers].map(cipher => String(cipher).toLowerCase());
}

export function convertProtocols(protocols: string[] | Buffer[] | Buffer): Buffer[] {
    if (Array.isArray(protocols)) {
        return protocols.map(p => typeof p === 'string' ? Buffer.from(p) : p as Buffer);
    }
    return [protocols as Buffer];
}

export function checkServerIdentity(servername: string, cert: PeerCertificate): Error | undefined {
    const cn = cert.subject?.CN ?? '';
    const sanText = cert.subjectaltname ?? cert.subjectAltName ?? '';
    const entries = sanText ? sanText.split(',').map(s => s.trim()).filter(Boolean) : [];
    const dnsNames: string[] = [];
    const ipNames: string[] = [];
    for (const entry of entries) {
        if (entry.startsWith('DNS:')) dnsNames.push(entry.slice(4));
        else if (entry.startsWith('IP Address:')) ipNames.push(entry.slice(11).trim());
        else if (entry.startsWith('IP:')) ipNames.push(entry.slice(3).trim());
    }

    const host = servername.toLowerCase();
    const looksLikeIp = /^[0-9.]+$/.test(servername) || servername.includes(':');

    // An IP peer name matches only an iPAddress SAN. Node never falls back to
    // the CN for an IP, and never matches a wildcard against one.
    if (looksLikeIp) {
        for (const ip of ipNames) {
            if (ip.toLowerCase() === host) return undefined;
        }
        return altNameError(
            `IP: ${servername} is not in the cert's list: ${ipNames.join(', ')}`,
            servername, cert,
        );
    }

    // Per RFC 6125 the CN is only consulted when there is no dNSName SAN at all.
    const names = dnsNames.length ? dnsNames : (cn ? [cn] : []);
    if (!names.length) return new Error('Cert has no name');

    for (const name of names) {
        const pattern = name.toLowerCase();
        if (pattern === host) return undefined;
        if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(2);
            if (host.endsWith('.' + suffix) && !host.slice(0, host.length - suffix.length - 1).includes('.')) {
                return undefined;
            }
        }
    }
    return altNameError(
        `Host: ${servername}. is not in the cert's altnames: ${sanText || `CN=${cn}`}`,
        servername, cert,
    );
}
