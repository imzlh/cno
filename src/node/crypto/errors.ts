/** Error factories and argument validation shared across the crypto modules. */

export function assertCallback(callback: unknown): asserts callback is (...args: unknown[]) => void {
    if (typeof callback !== 'function') {
        const err = new TypeError(
            `The "callback" argument must be of type function. Received ${callback === undefined ? 'undefined' : typeof callback}`,
        ) as TypeError & { code?: string };
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
    }
}

export function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function createDigestAlreadyCalledError(): Error {
    const err = new Error('Digest already called') as Error & { code?: string };
    err.code = 'ERR_CRYPTO_HASH_FINALIZED';
    return err;
}

// Node attaches a `.code` to every crypto error; bare Error/TypeError is a
// detectable divergence for callers that branch on err.code.
export function withCode<E extends Error>(error: E, code: string): E & { code: string } {
    const err = error as E & { code: string };
    err.code = code;
    return err;
}

export function createInvalidIvError(): TypeError {
    return withCode(new TypeError('Invalid initialization vector'), 'ERR_CRYPTO_INVALID_IV');
}

export function createInvalidKeyLengthError(): RangeError {
    return withCode(new RangeError('Invalid key length'), 'ERR_CRYPTO_INVALID_KEYLEN');
}

export function createUnknownCipherError(algorithm: string): Error {
    return withCode(new Error(`Unknown cipher: ${algorithm}`), 'ERR_CRYPTO_UNKNOWN_CIPHER');
}

// GCM/CBC authentication + padding failures surface as OpenSSL errors in Node.
export function createAuthenticationFailedError(): Error {
    return withCode(new Error('Unsupported state or unable to authenticate data'), 'ERR_OSSL_EVP_UNSUPPORTED');
}

export function createCipherInvalidStateError(operation: string): Error {
    if (operation === 'update') {
        return withCode(new Error('Trying to add data in unsupported state'), 'ERR_CRYPTO_INVALID_STATE');
    }
    const message = operation === 'final' ? 'Invalid state' : `Invalid state for operation ${operation}`;
    const err = new Error(message) as Error & { code?: string };
    err.code = 'ERR_CRYPTO_INVALID_STATE';
    return err;
}

export function createInvalidGcmAuthTagLengthError(length: number): TypeError {
    const err = new TypeError(`Invalid authentication tag length: ${length}`) as TypeError & { code?: string };
    err.code = 'ERR_CRYPTO_INVALID_AUTH_TAG';
    return err;
}

export function validateGcmAuthTagLength(length: number | undefined): number | undefined {
    if (length === undefined) return undefined;
    if (length !== 4 && length !== 8 && !(Number.isInteger(length) && length >= 12 && length <= 16)) {
        throw createInvalidGcmAuthTagLengthError(length);
    }
    return length;
}
