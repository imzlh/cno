/** Re-exports the runtime WebCrypto globals as crypto.webcrypto / crypto.subtle. */

// Web Crypto API — re-export runtime globals so code that imports
// `crypto.webcrypto` or `crypto.subtle` gets the real implementation.
function isRuntimeCrypto(value: unknown): value is Crypto {
    return typeof value === 'object' && value !== null
        && typeof Reflect.get(value, 'getRandomValues') === 'function'
        && typeof Reflect.get(value, 'randomUUID') === 'function'
        && typeof Reflect.get(value, 'subtle') === 'object'
        && Reflect.get(value, 'subtle') !== null;
}

const runtimeCrypto = Reflect.get(globalThis, 'crypto');
if (!isRuntimeCrypto(runtimeCrypto)) {
    throw new Error('Web Crypto API is not initialized');
}

export const webcrypto: Crypto = runtimeCrypto;
export const subtle: SubtleCrypto = webcrypto.subtle;
