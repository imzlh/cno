import { Buffer } from 'node:buffer';
import { toBuffer } from '../../node/crypto/helpers';
import { arrayBufferBackedBytes, nativeLittleEndian, sanitizeSurrogates } from '../../utils/bytes';
import { blobBytesOf } from '../blob-intrinsics';
import { blake2b, blake2b256 } from './blake2b';
import { hmacMd4, md4 } from './md4';
import { isBunFile } from '../file';

const native = import.meta.use('crypto');
const engine = import.meta.use('engine');
interface HashAlgorithm {
    byteLength: number;
    hash(data: Uint8Array<ArrayBuffer>): ArrayBuffer;
    create?: () => CModuleCrypto.Hash;
    hmac?: (key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) => ArrayBuffer;
    blockSize?: number;
}

const hashes: Record<string, HashAlgorithm> = {
    // Bun keys BLAKE2b directly rather than applying HMAC.
    blake2b256: { byteLength: 32, hash: data => blake2b256(data).buffer, hmac: (key, data) => blake2b256(data, key).buffer },
    blake2b512: { byteLength: 64, hash: native.blake2b512, create: native.createBlake2b512, hmac: (key, data) => blake2b(64, data, key).buffer },
    blake2s256: { byteLength: 32, hash: native.blake2s256, create: native.createBlake2s256 },
    md4: { byteLength: 16, hash: data => md4(data).buffer, hmac: (key, data) => hmacMd4(key, data).buffer },
    md5: { byteLength: 16, hash: native.md5, create: native.createMd5, blockSize: 64 },
    ripemd160: { byteLength: 20, hash: native.ripemd160, create: native.createRipemd160, blockSize: 64 },
    sha1: { byteLength: 20, hash: native.sha1, create: native.createSha1, blockSize: 64 },
    sha224: { byteLength: 28, hash: native.sha224, create: native.createSha224, blockSize: 64 },
    sha256: { byteLength: 32, hash: native.sha256, create: native.createSha256, blockSize: 64 },
    sha384: { byteLength: 48, hash: native.sha384, create: native.createSha384, blockSize: 128 },
    sha512: { byteLength: 64, hash: native.sha512, create: native.createSha512, blockSize: 128 },
    'sha512-224': { byteLength: 28, hash: native.sha512_224, create: native.createSha512_224, blockSize: 128 },
    'sha512-256': { byteLength: 32, hash: native.sha512_256, create: native.createSha512_256, blockSize: 128 },
    'sha3-224': { byteLength: 28, hash: native.sha3_224, create: native.createSha3_224, blockSize: 144 },
    'sha3-256': { byteLength: 32, hash: native.sha3_256, create: native.createSha3_256, blockSize: 136 },
    'sha3-384': { byteLength: 48, hash: native.sha3_384, create: native.createSha3_384, blockSize: 104 },
    'sha3-512': { byteLength: 64, hash: native.sha3_512, create: native.createSha3_512, blockSize: 72 },
    shake128: { byteLength: 16, hash: data => native.shake128(data, 16) },
    shake256: { byteLength: 32, hash: data => native.shake256(data, 32) },
};

type Input = string | ArrayBuffer | ArrayBufferView | Blob;

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

function inputBytes(input: unknown, encoding?: unknown): Uint8Array<ArrayBuffer> {
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
                    const units = engine.encodeU16String(sanitized);
                    source = new Uint8Array(units.buffer, units.byteOffset, units.byteLength);
                    if (!nativeLittleEndian) {
                        for (let offset = 0; offset < source.byteLength; offset += 2) {
                            const low = source[offset];
                            source[offset] = source[offset + 1];
                            source[offset + 1] = low;
                        }
                    }
                } else if (normalized === '' || normalized === 'utf8' || normalized === 'utf-8') {
                    source = engine.encodeString(sanitized);
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

    return arrayBufferBackedBytes(source);
}

class BufferedHash implements CModuleCrypto.Hash {
    #algorithm: HashAlgorithm;
    #key?: Uint8Array<ArrayBuffer>;
    #chunks: Uint8Array<ArrayBuffer>[] = [];
    #length = 0;

    constructor(algorithm: HashAlgorithm, key?: Uint8Array<ArrayBuffer>) {
        this.#algorithm = algorithm;
        this.#key = key?.slice();
    }

    update(data: BufferSource): this {
        const bytes = inputBytes(data);
        if (bytes.byteLength > 0) {
            this.#chunks.push(bytes.slice());
            this.#length += bytes.byteLength;
        }
        return this;
    }

    copy(): BufferedHash {
        const copy = new BufferedHash(this.#algorithm, this.#key);
        // Chunks are private snapshots and remain immutable across branches.
        copy.#chunks = this.#chunks.slice();
        copy.#length = this.#length;
        return copy;
    }

    digest(): ArrayBuffer {
        const joined = new Uint8Array(this.#length);
        let offset = 0;
        for (const chunk of this.#chunks) {
            joined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const result = this.#key === undefined
            ? this.#algorithm.hash(joined)
            : this.#algorithm.hmac!(this.#key, joined);
        this.#chunks = [];
        this.#length = 0;
        return result;
    }
}

class HmacHash implements CModuleCrypto.Hash {
    #inner: CModuleCrypto.Hash;
    #outer: CModuleCrypto.Hash;

    constructor(inner: CModuleCrypto.Hash, outer: CModuleCrypto.Hash) {
        this.#inner = inner;
        this.#outer = outer;
    }

    update(data: BufferSource): this {
        this.#inner.update(data);
        return this;
    }

    copy(): HmacHash {
        return new HmacHash(this.#inner.copy(), this.#outer.copy());
    }

    digest(): ArrayBuffer {
        this.#outer.update(this.#inner.digest());
        return this.#outer.digest();
    }
}

function createHash(algorithm: HashAlgorithm, key?: Uint8Array<ArrayBuffer>): CModuleCrypto.Hash {
    if (!algorithm.create || (key !== undefined && algorithm.blockSize === undefined)) {
        return new BufferedHash(algorithm, key);
    }
    const inner = algorithm.create();
    if (key === undefined) return inner;

    const blockSize = algorithm.blockSize!;
    const normalizedKey = key.byteLength > blockSize ? new Uint8Array(algorithm.hash(key)) : key;
    const innerPad = new Uint8Array(blockSize).fill(0x36);
    const outerPad = new Uint8Array(blockSize).fill(0x5c);
    for (let index = 0; index < normalizedKey.byteLength; index++) {
        innerPad[index] ^= normalizedKey[index];
        outerPad[index] ^= normalizedKey[index];
    }
    inner.update(innerPad);
    const outer = algorithm.create();
    outer.update(outerPad);
    return new HmacHash(inner, outer);
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
    hash: CModuleCrypto.Hash;
    keyed: boolean;
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
            if (hash.blockSize === undefined && hash.hmac === undefined) {
                const error = new Error('HMAC is not supported for this algorithm yet');
                error.name = 'TODOError';
                throw error;
            }
            key = inputBytes(hmacKey);
        }
        states.set(this, {
            algorithm: name,
            byteLength: hash.byteLength,
            hash: createHash(hash, key),
            keyed: key !== undefined,
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
        const bytes = inputBytes(input, inputEncoding);
        assertUsable(state);
        state.hash.update(bytes);
        return this;
    }

    function copy(this: unknown): CryptoHasher {
        const state = stateOf(this);
        assertUsable(state);
        const result = Object.create(CryptoHasher.prototype) as CryptoHasher;
        states.set(result, { ...state, hash: state.hash.copy() });
        return result;
    }

    function digest(this: unknown, ...args: unknown[]): unknown {
        const state = stateOf(this);
        const render = planOutput(args[0], true);
        assertUsable(state);
        const result = new Uint8Array(state.hash.digest());
        if (state.keyed) state.consumed = true;
        return render(result);
    }

    function hash(algorithm: unknown, input: unknown, ...rest: unknown[]): unknown {
        // Bun's static helper requires a primitive algorithm string and checks
        // input/output categories before lookup, but output details afterward.
        if (typeof algorithm !== 'string') throw invalidArgType('algorithm must be a string');
        const data = inputBytes(input).slice();
        assertOutputType(rest[0], false);
        const name = algorithm.toLowerCase().replace(/^sha-(1|224|256|384|512)$/, 'sha$1');
        const entry = Object.hasOwn(hashes, name) ? hashes[name] : undefined;
        if (!entry) throw invalidArgType(`Unsupported algorithm "${algorithm}"`);
        const render = planOutput(rest[0], false, entry.byteLength);
        return render(new Uint8Array(entry.hash(data)));
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
