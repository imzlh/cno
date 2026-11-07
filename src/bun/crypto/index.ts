import { Buffer } from 'node:buffer';
import { toBuffer } from '../../node/crypto/helpers';
import { sanitizeSurrogates } from '../../utils/bytes';
import { blobBytesOf } from '../blob-intrinsics';
import { blake2b, blake2b256 } from './blake2b';
import { hmacMd4, md4 } from './md4';
import { isBunFile } from '../file';

const native = import.meta.use('crypto');
const engine = import.meta.use('engine');
type Hash = (data: BufferSource) => ArrayBuffer;
type Hmac = (key: BufferSource, data: BufferSource) => ArrayBuffer;

/** The BLAKE2b implementation reads plain bytes and owns its copies. */
function asBytes(data: BufferSource): Uint8Array<ArrayBuffer> {
    return ownedBytes(data);
}
const hashes: Record<string, [number, Hash, Hmac?]> = {
    // BLAKE2b has no native keyed mode and Bun's second argument is BLAKE2b
    // keying rather than HMAC, so both widths run the JS core when a key is
    // present; the unkeyed digests stay on the native path.
    blake2b256: [32, data => blake2b256(asBytes(data)).buffer, (key, data) => blake2b256(asBytes(data), asBytes(key)).buffer],
    blake2b512: [64, native.blake2b512, (key, data) => blake2b(64, asBytes(data), asBytes(key)).buffer],
    blake2s256: [32, native.blake2s256],
    md4: [16, data => md4(asBytes(data)).buffer, (key, data) => hmacMd4(asBytes(key), asBytes(data)).buffer],
    md5: [16, native.md5, native.hmacMd5],
    ripemd160: [20, native.ripemd160, native.hmacRipemd160],
    sha1: [20, native.sha1, native.hmacSha1],
    sha224: [28, native.sha224, native.hmacSha224],
    sha256: [32, native.sha256, native.hmacSha256],
    sha384: [48, native.sha384, native.hmacSha384],
    sha512: [64, native.sha512, native.hmacSha512],
    'sha512-224': [28, native.sha512_224, native.hmacSha512_224],
    'sha512-256': [32, native.sha512_256, native.hmacSha512_256],
    'sha3-224': [28, native.sha3_224, native.hmacSha3_224],
    'sha3-256': [32, native.sha3_256, native.hmacSha3_256],
    'sha3-384': [48, native.sha3_384, native.hmacSha3_384],
    'sha3-512': [64, native.sha3_512, native.hmacSha3_512],
    shake128: [16, data => native.shake128(data, 16)],
    shake256: [32, data => native.shake256(data, 32)],
};

type Input = string | ArrayBuffer | ArrayBufferView | Blob;
type Output = string | ArrayBuffer | ArrayBufferView | null;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const sharedByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;

interface ViewSlots {
    buffer: ArrayBufferLike;
    byteOffset: number;
    byteLength: number;
}

function viewSlots(value: unknown): ViewSlots | null {
    if (!arrayBufferIsView(value)) return null;
    try {
        return {
            buffer: Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike,
            byteOffset: Reflect.apply(typedArrayByteOffset, value, []) as number,
            byteLength: Reflect.apply(typedArrayByteLength, value, []) as number,
        };
    } catch {
        return {
            buffer: Reflect.apply(dataViewBuffer, value, []) as ArrayBufferLike,
            byteOffset: Reflect.apply(dataViewByteOffset, value, []) as number,
            byteLength: Reflect.apply(dataViewByteLength, value, []) as number,
        };
    }
}

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
    if (!sharedByteLength || (typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
    try {
        Reflect.apply(sharedByteLength, value, []);
        return true;
    } catch {
        return false;
    }
}

function isRawBuffer(value: unknown): value is ArrayBufferLike {
    return engine.isArrayBuffer(value) || isSharedArrayBuffer(value);
}

function stringValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
    try {
        return Reflect.apply(String.prototype.valueOf, value, []) as string;
    } catch {
        return undefined;
    }
}

function codedError<T extends Error>(error: T, code: string): T {
    Object.defineProperty(error, 'code', { value: code, writable: true, configurable: true });
    return error;
}

function invalidArgType(message: string): TypeError {
    return codedError(new TypeError(message), 'ERR_INVALID_ARG_TYPE');
}

function ownedBytes(input: unknown, encoding?: unknown): Uint8Array<ArrayBuffer> {
    let source: Uint8Array;
    if (isBunFile(input)) {
        throw invalidArgType('File blob cannot be used here');
    } else {
        const blob = blobBytesOf(input);
        if (blob) source = blob;
        else {
            const text = stringValue(input);
            if (text !== undefined) {
                const sanitized = sanitizeSurrogates(text);
                const requestedEncoding = stringValue(encoding);
                const normalized = requestedEncoding === undefined ? '' : requestedEncoding.toLowerCase();
                if (normalized === 'ucs2' || normalized === 'ucs-2' || normalized === 'utf16le') {
                    source = Buffer.from(sanitized, 'utf16le');
                } else {
                    source = toBuffer(sanitized, normalized === 'buffer' ? 'latin1' : normalized);
                }
            } else if (isRawBuffer(input)) {
                source = new Uint8Array(input);
            } else {
                const slots = viewSlots(input);
                if (!slots) throw invalidArgType('input must be a string, ArrayBuffer, ArrayBufferView or Blob');
                source = new Uint8Array(slots.buffer, slots.byteOffset, slots.byteLength);
            }
        }
    }

    // Own a copy both for the native BufferSource contract and to snapshot
    // update() input, including SharedArrayBuffer-backed views.
    const result = new Uint8Array(source.byteLength);
    result.set(source);
    return result;
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

const ENCODINGS = new Set([
    'hex', 'base64', 'base64url', 'utf8', 'utf-8', 'ascii', 'latin1',
    'binary', 'buffer', 'ucs2', 'ucs-2', 'utf16le',
]);

function assertOutputType(output: unknown, nullMeansDefault: boolean): void {
    if (output === undefined || (output === null && nullMeansDefault)) return;
    if (stringValue(output) !== undefined || isRawBuffer(output) || viewSlots(output)) return;
    throw invalidArgType('output must be of type string or ArrayBuffer or ArrayBufferView');
}

function planOutput(
    output: unknown,
    nullMeansDefault: boolean,
    minimumLength = 64,
): (digest: Uint8Array<ArrayBuffer>) => Buffer | string | ArrayBufferLike | ArrayBufferView {
    if (output === undefined || (output === null && nullMeansDefault)) return digest => {
        const buffer = new Buffer(digest.byteLength);
        buffer.set(digest);
        return buffer;
    };
    const requested = stringValue(output);
    if (requested !== undefined) {
        const encoding = requested.toLowerCase();
        if (!ENCODINGS.has(encoding)) {
            throw codedError(new TypeError(`Unknown encoding: ${requested}`), 'ERR_INVALID_ARG_VALUE');
        }
        return digest => {
            const buffer = new Buffer(digest.byteLength);
            buffer.set(digest);
            return encoding === 'buffer'
                ? buffer
                : Reflect.apply(buffer.toString, buffer, [encoding]) as string;
        };
    }
    if (isRawBuffer(output)) {
        const target = new Uint8Array(output);
        if (target.byteLength < minimumLength) throw invalidArgType(`TypedArray must be at least ${minimumLength} bytes`);
        return digest => {
            target.set(digest);
            return output;
        };
    }
    const slots = viewSlots(output);
    if (slots) {
        if (slots.byteLength < minimumLength) throw invalidArgType(`TypedArray must be at least ${minimumLength} bytes`);
        const target = new Uint8Array(slots.buffer, slots.byteOffset, slots.byteLength);
        return digest => {
            target.set(digest);
            return output as ArrayBufferView;
        };
    }
    throw invalidArgType('output must be of type string or ArrayBuffer or ArrayBufferView');
}

interface CryptoHasherState {
    algorithm: string;
    byteLength: number;
    key?: Uint8Array<ArrayBuffer>;
    chunks: Uint8Array<ArrayBuffer>[];
    consumed: boolean;
}

export interface CryptoHasher {
    readonly algorithm: string;
    readonly byteLength: number;
    update(input: Input, inputEncoding?: string): this;
    copy(): CryptoHasher;
    digest(): Buffer;
    digest(encoding: string): string;
    digest<T extends ArrayBuffer | ArrayBufferView>(output: T): T;
}

export interface CryptoHasherConstructor {
    new (algorithm: string, hmacKey?: string | ArrayBuffer | ArrayBufferView): CryptoHasher;
    readonly prototype: CryptoHasher;
    readonly algorithms: string[];
    hash(algorithm: string, input: Input): Buffer;
    hash(algorithm: string, input: Input, encoding: string): string;
    hash<T extends ArrayBuffer | ArrayBufferView>(algorithm: string, input: Input, output: T): T;
}

function receivedSuffix(self: unknown): string {
    if (self === undefined) return '';
    if (self === null) return ', but received null';
    if (typeof self === 'object' || typeof self === 'function') {
        let name: unknown;
        try {
            name = (self as { constructor?: { name?: unknown } }).constructor?.name;
        } catch {
            // Formatting an invalid receiver must not replace ERR_INVALID_THIS.
        }
        return `, but received an instance of ${String(name ?? 'Object')}`;
    }
    return `, but received type ${typeof self} (${String(self)})`;
}

function defineCryptoHasher(): CryptoHasherConstructor {
    const states = new WeakMap<object, CryptoHasherState>();

    function stateOf(self: unknown): CryptoHasherState {
        const state = (typeof self === 'object' || typeof self === 'function') && self !== null
            ? states.get(self)
            : undefined;
        if (state) return state;
        throw codedError(
            new TypeError(`Expected this to be instanceof CryptoHasher${receivedSuffix(self)}`),
            'ERR_INVALID_THIS',
        );
    }

    function assertUsable(state: CryptoHasherState): void {
        if (state.consumed) throw new Error('HMAC has been consumed and is no longer usable');
    }

    function CryptoHasher(this: object, ...args: unknown[]): void {
        if (!new.target) {
            throw codedError(
                new TypeError("CryptoHasher constructor cannot be invoked without 'new'"),
                'ERR_ILLEGAL_CONSTRUCTOR',
            );
        }
        const requestedAlgorithm = stringValue(args[0]);
        if (requestedAlgorithm === undefined) throw invalidArgType('algorithm must be a string');
        const name = requestedAlgorithm.toLowerCase().replace(/^sha-(1|224|256|384|512)$/, 'sha$1');
        const hmacKey = args[1];
        if (hmacKey != null) {
            if (stringValue(hmacKey) === undefined && !isRawBuffer(hmacKey) && viewSlots(hmacKey) === null) {
                throw invalidArgType('hmacKey must be a string, ArrayBuffer or ArrayBufferView');
            }
        }
        if (requestedAlgorithm.length === 0) throw invalidArgType('Invalid algorithm name');
        const hash = Object.hasOwn(hashes, name) ? hashes[name] : undefined;
        if (!hash) {
            if (hmacKey != null) {
                throw invalidArgType("algorithm must be one of 'blake2b256', 'blake2b512', 'blake2s256', 'md4', 'md5', 'ripemd160', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'shake128' or 'shake256'");
            }
            throw invalidArgType(`Unsupported algorithm ${requestedAlgorithm}`);
        }

        let key: Uint8Array<ArrayBuffer> | undefined;
        if (hmacKey != null) {
            if (!hash[2]) {
                const error = new Error('HMAC is not supported for this algorithm yet');
                error.name = 'TODOError';
                throw error;
            }
            key = ownedBytes(hmacKey);
        }
        states.set(this, {
            algorithm: name,
            byteLength: hash[0],
            key,
            chunks: [],
            consumed: false,
        });
    }

    function algorithm(this: unknown): string {
        const state = (typeof this === 'object' || typeof this === 'function') && this !== null
            ? states.get(this)
            : undefined;
        if (!state) throw new TypeError('The CryptoHasher.algorithm getter can only be used on instances of CryptoHasher');
        return state.algorithm;
    }
    Object.defineProperty(algorithm, 'name', { value: 'get algorithm', configurable: true });

    function byteLength(this: unknown): number {
        const state = (typeof this === 'object' || typeof this === 'function') && this !== null
            ? states.get(this)
            : undefined;
        if (!state) throw new TypeError('The CryptoHasher.byteLength getter can only be used on instances of CryptoHasher');
        return state.byteLength;
    }
    Object.defineProperty(byteLength, 'name', { value: 'get byteLength', configurable: true });

    function update(this: unknown, input: unknown, inputEncoding?: unknown): unknown {
        const state = stateOf(this);
        const bytes = ownedBytes(input, inputEncoding);
        assertUsable(state);
        state.chunks.push(bytes);
        return this;
    }

    function copy(this: unknown): CryptoHasher {
        const state = stateOf(this);
        assertUsable(state);
        const result = new CryptoHasher(state.algorithm, state.key);
        const copyState = states.get(result as object)!;
        copyState.chunks = state.chunks.map(chunk => chunk.slice());
        return result;
    }

    function digest(this: unknown, ...args: unknown[]): unknown {
        const state = stateOf(this);
        const render = planOutput(args[0], true);
        assertUsable(state);
        const data = joinBytes(state.chunks);
        const [, hash, hmac] = hashes[state.algorithm];
        const result = new Uint8Array(state.key === undefined ? hash(data) : hmac!(state.key, data));
        state.chunks = [];
        if (state.key !== undefined) state.consumed = true;
        return render(result);
    }

    function hash(algorithm: unknown, input: unknown, ...rest: unknown[]): unknown {
        // Bun's static helper requires a primitive algorithm string and checks
        // input/output categories before lookup, but output details afterward.
        if (typeof algorithm !== 'string') throw invalidArgType('algorithm must be a string');
        const data = ownedBytes(input);
        assertOutputType(rest[0], false);
        const name = algorithm.toLowerCase().replace(/^sha-(1|224|256|384|512)$/, 'sha$1');
        const entry = Object.hasOwn(hashes, name) ? hashes[name] : undefined;
        if (!entry) throw invalidArgType(`Unsupported algorithm "${algorithm}"`);
        const render = planOutput(rest[0], false, entry[0]);
        return render(new Uint8Array(entry[1](data)));
    }

    function algorithms(): string[] {
        return Object.keys(hashes);
    }
    Object.defineProperty(algorithms, 'name', { value: 'get algorithms', configurable: true });

    Object.defineProperties(CryptoHasher.prototype, {
        algorithm: { get: algorithm, enumerable: true, configurable: false },
        byteLength: { get: byteLength, enumerable: true, configurable: false },
        copy: { value: copy, writable: true, enumerable: true, configurable: false },
        digest: { value: digest, writable: true, enumerable: true, configurable: false },
        update: { value: update, writable: true, enumerable: true, configurable: false },
        [Symbol.toStringTag]: { value: 'CryptoHasher', configurable: true },
    });
    Object.defineProperties(CryptoHasher, {
        algorithms: { get: algorithms, enumerable: true, configurable: false },
        hash: { value: hash, writable: true, enumerable: true, configurable: false },
        prototype: { writable: false },
    });
    return CryptoHasher as unknown as CryptoHasherConstructor;
}

export const CryptoHasher: CryptoHasherConstructor = defineCryptoHasher();
