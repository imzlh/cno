/** Hash and Hmac: the Transform-based classes plus the one-shot native wrappers. */

const crypto = import.meta.use('crypto');
import { Buffer } from '../buffer';
import { Transform, type TransformOptions } from '../stream';
import type { BinaryInput, Hash, Hmac, KeyInput } from './types';
import { toBuffer, toExactArrayBuffer, encodeOutput, concatBuffers, normalizeHashAlgorithm, oneShotHmac, isSupportedHmacAlgorithm, getKeyBytes } from './helpers';
import { createDigestAlreadyCalledError, withCode, asError } from './errors';

type DigestState = {
    update(data: Uint8Array): void;
    digest(): ArrayBuffer;
    copy(): DigestState;
};

type NativeDigest = CModuleCrypto.Hash & { copy(): CModuleCrypto.Hash };

export function nativeDigest(factory: () => NativeDigest): DigestState {
    const native = factory();
    return {
        update(data) { native.update(data); },
        digest() { return native.digest(); },
        copy() { return nativeDigest(() => native.copy() as NativeDigest); },
    };
}

export function bufferedDigest(fn: (data: Uint8Array) => ArrayBuffer, seed: Uint8Array[] = []): DigestState {
    const chunks = seed.map(chunk => new Uint8Array(chunk));
    return {
        update(data) { chunks.push(new Uint8Array(data)); },
        digest() { return fn(concatBuffers(chunks)); },
        copy() { return bufferedDigest(fn, chunks); },
    };
}

class HashImpl extends Transform implements Hash {
    private readonly state: DigestState;
    private finalized = false;

    constructor(state: DigestState, options?: TransformOptions) {
        super(options);
        this.state = state;
    }

    update(input: BinaryInput, encoding?: string): Hash {
        if (this.finalized) throw createDigestAlreadyCalledError();
        this.state.update(toBuffer(input, encoding));
        return this;
    }

    digest(encoding?: string): Uint8Array | string {
        if (this.finalized) throw createDigestAlreadyCalledError();
        this.finalized = true;
        return encodeOutput(this.state.digest(), encoding);
    }

    copy(options?: TransformOptions): Hash {
        if (this.finalized) throw createDigestAlreadyCalledError();
        return new HashImpl(this.state.copy(), options);
    }

    _transform(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            this.update(chunk as BinaryInput, encoding);
            callback();
        } catch (error) {
            callback(asError(error));
        }
    }

    _flush(callback: (error?: Error | null, data?: unknown) => void): void {
        try {
            callback(null, this.digest());
        } catch (error) {
            callback(asError(error));
        }
    }
}

// createHash

export function createHash(algorithm: string, options?: TransformOptions & { outputLength?: number }): Hash {
    const a = normalizeHashAlgorithm(algorithm);
    const isShake = a === 'shake128' || a === 'shake256';
    if (options?.outputLength !== undefined &&
        (!Number.isInteger(options.outputLength) || options.outputLength < 0 || options.outputLength > 0xffffffff)) {
        throw new RangeError('The value of "options.outputLength" is out of range');
    }
    if (options?.outputLength !== undefined && !isShake) {
        throw new RangeError('outputLength is only supported for SHAKE hash algorithms');
    }
    const streamingAlgos: Record<string, () => NativeDigest> = {
        md5:       () => crypto.createMd5() as NativeDigest,
        ripemd160: () => crypto.createRipemd160() as NativeDigest,
        sha1:      () => crypto.createSha1() as NativeDigest,
        sha224:    () => crypto.createSha224() as NativeDigest,
        sha256:    () => crypto.createSha256() as NativeDigest,
        sha384:    () => crypto.createSha384() as NativeDigest,
        sha512:    () => crypto.createSha512() as NativeDigest,
        sha512224: () => crypto.createSha512_224() as NativeDigest,
        sha512256: () => crypto.createSha512_256() as NativeDigest,
        sha3224:   () => crypto.createSha3_224() as NativeDigest,
        sha3256:   () => crypto.createSha3_256() as NativeDigest,
        sha3384:   () => crypto.createSha3_384() as NativeDigest,
        sha3512:   () => crypto.createSha3_512() as NativeDigest,
        blake2b512:() => crypto.createBlake2b512() as NativeDigest,
        blake2s256:() => crypto.createBlake2s256() as NativeDigest,
    };
    const shakeLength = options?.outputLength;
    const oneshotAlgos: Record<string, (buf: Uint8Array) => ArrayBuffer> = {
        shake128: buf => crypto.shake128(buf, shakeLength),
        shake256: buf => crypto.shake256(buf, shakeLength),
    };
    const factory = streamingAlgos[a];
    if (factory) return new HashImpl(nativeDigest(factory), options);
    const fn = oneshotAlgos[a];
    if (fn) return new HashImpl(bufferedDigest(fn), options);
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
}

// hash - one-shot hash

export function hash(algorithm: string, data: ArrayBuffer | Uint8Array | string, outputEncoding: string = 'hex'): Uint8Array | string {
    const buf = toBuffer(data);
    let result: ArrayBuffer;

    const a = normalizeHashAlgorithm(algorithm);
    switch (a) {
        case 'md5':       result = crypto.md5(buf); break;
        case 'ripemd160': result = crypto.ripemd160(buf); break;
        case 'sha1':      result = crypto.sha1(buf); break;
        case 'sha224':    result = crypto.sha224(buf); break;
        case 'sha256':    result = crypto.sha256(buf); break;
        case 'sha384':    result = crypto.sha384(buf); break;
        case 'sha512':    result = crypto.sha512(buf); break;
        case 'sha512224': result = crypto.sha512_224(buf); break;
        case 'sha512256': result = crypto.sha512_256(buf); break;
        case 'sha3224':   result = crypto.sha3_224(buf); break;
        case 'sha3256':   result = crypto.sha3_256(buf); break;
        case 'sha3384':   result = crypto.sha3_384(buf); break;
        case 'sha3512':   result = crypto.sha3_512(buf); break;
        case 'blake2b512': result = crypto.blake2b512(buf); break;
        case 'blake2s256': result = crypto.blake2s256(buf); break;
        case 'shake128':   result = crypto.shake128(buf); break;
        case 'shake256':   result = crypto.shake256(buf); break;
        default: throw new Error(`Unsupported hash algorithm: ${algorithm}`);
    }

    return encodeOutput(result, outputEncoding);
}

type HmacState = {
    update(data: Uint8Array): void;
    digest(): ArrayBuffer;
};

class HmacImpl extends Transform implements Hmac {
    private readonly state: HmacState;
    private finalized = false;

    constructor(state: HmacState, options?: TransformOptions) {
        super(options);
        this.state = state;
    }

    update(input: BinaryInput, encoding?: string): Hmac {
        if (this.finalized) throw createDigestAlreadyCalledError();
        this.state.update(toBuffer(input, encoding));
        return this;
    }

    // Node's Hmac (unlike Hash) does not throw on digest-after-digest; it
    // returns empty output, because OpenSSL frees the context on first final.
    digest(encoding?: string): Uint8Array | string {
        if (this.finalized) return encodeOutput(new ArrayBuffer(0), encoding);
        this.finalized = true;
        return encodeOutput(this.state.digest(), encoding);
    }

    _transform(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            this.update(chunk as BinaryInput, encoding);
            callback();
        } catch (error) {
            callback(asError(error));
        }
    }

    _flush(callback: (error?: Error | null, data?: unknown) => void): void {
        try {
            callback(null, this.digest());
        } catch (error) {
            callback(asError(error));
        }
    }
}

// createHmac

export function createHmac(algorithm: string, key: KeyInput, options?: TransformOptions): Hmac {
    const keyBuf = getKeyBytes(key);
    const a = normalizeHashAlgorithm(algorithm);
    if (!isSupportedHmacAlgorithm(a)) throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);

    const nativeAlgos: Record<string, () => CModuleCrypto.Hmac> = {
        sha256: () => crypto.createHmacSha256(keyBuf),
        sha512: () => crypto.createHmacSha512(keyBuf),
    };
    // The native streaming HMAC rejects a zero-length key with an InternalError,
    // but Node accepts one (HMAC pads any key, including the empty key, to the
    // block size). The generic one-shot path handles it and matches Node byte
    // for byte, so keep empty keys off the native fast path.
    const nativeFactory = keyBuf.byteLength === 0 ? undefined : nativeAlgos[a];
    if (nativeFactory) {
        const native = nativeFactory();
        return new HmacImpl({
            update(data) { native.update(data); },
            digest() { return native.digest(); },
        }, options);
    }

    const chunks: Uint8Array[] = [];
    return new HmacImpl({
        update(data) { chunks.push(new Uint8Array(data)); },
        digest() { return oneShotHmac(algorithm, keyBuf, concatBuffers(chunks)); },
    }, options);
}

// hmac - one-shot HMAC

export function hmac(algorithm: string, key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string, outputEncoding?: string): Uint8Array | string {
    const keyBuf = toBuffer(key);
    const dataBuf = toBuffer(data);
    const result = oneShotHmac(algorithm, keyBuf, dataBuf);
    return encodeOutput(result, outputEncoding);
}

export function md5(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.md5(toBuffer(data));
}

export function sha1(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha1(toBuffer(data));
}

export function sha224(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha224(toBuffer(data));
}

export function sha256(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha256(toBuffer(data));
}

export function sha384(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha384(toBuffer(data));
}

export function sha512(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha512(toBuffer(data));
}

export function sha3_224(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha3_224(toBuffer(data));
}

export function sha3_256(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha3_256(toBuffer(data));
}

export function sha3_384(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha3_384(toBuffer(data));
}

export function sha3_512(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.sha3_512(toBuffer(data));
}

export function createMd5(): CModuleCrypto.Hash {
    return crypto.createMd5();
}

export function createSha1(): CModuleCrypto.Hash {
    return crypto.createSha1();
}

export function createSha256(): CModuleCrypto.Hash {
    return crypto.createSha256();
}

export function createSha512(): CModuleCrypto.Hash {
    return crypto.createSha512();
}

export function createSha512_224(): CModuleCrypto.Hash {
    return crypto.createSha512_224();
}

export function createSha512_256(): CModuleCrypto.Hash {
    return crypto.createSha512_256();
}

export function createBlake2b512(): CModuleCrypto.Hash {
    return crypto.createBlake2b512();
}

export function createBlake2s256(): CModuleCrypto.Hash {
    return crypto.createBlake2s256();
}

export function hmacMd5(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacMd5(toBuffer(key), toBuffer(data));
}

export function hmacSha1(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha1(toBuffer(key), toBuffer(data));
}

export function hmacSha256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha256(toBuffer(key), toBuffer(data));
}

export function hmacSha512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha512(toBuffer(key), toBuffer(data));
}

export function hmacSha512_224(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha512_224(toBuffer(key), toBuffer(data));
}

export function hmacSha512_256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha512_256(toBuffer(key), toBuffer(data));
}

export function hmacSha3_224(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha3_224(toBuffer(key), toBuffer(data));
}

export function hmacSha3_256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha3_256(toBuffer(key), toBuffer(data));
}

export function hmacSha3_384(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha3_384(toBuffer(key), toBuffer(data));
}

export function hmacSha3_512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacSha3_512(toBuffer(key), toBuffer(data));
}

export function hmacBlake2b512(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacBlake2b512(toBuffer(key), toBuffer(data));
}

export function hmacBlake2s256(key: ArrayBuffer | Uint8Array | string, data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
    return crypto.hmacBlake2s256(toBuffer(key), toBuffer(data));
}

export function createHmacSha256(key: ArrayBuffer | Uint8Array | string): CModuleCrypto.Hmac {
    return crypto.createHmacSha256(toBuffer(key));
}

export function createHmacSha512(key: ArrayBuffer | Uint8Array | string): CModuleCrypto.Hmac {
    return crypto.createHmacSha512(toBuffer(key));
}
