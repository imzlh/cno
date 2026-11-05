import { Buffer } from 'node:buffer';
import { BunFile } from '../file';
import { CryptoHasher } from './index';
import { md4 } from './md4';
import { sanitizeSurrogates } from '../../utils/bytes';

/**
 * `Bun.SHA1`, `Bun.MD5`, `Bun.MD4`, `Bun.SHA224`, `Bun.SHA256`, `Bun.SHA384`,
 * `Bun.SHA512`, `Bun.SHA512_256` and `Bun.sha`.
 *
 * SHA-1/MD5/SHA-2 delegate to `CryptoHasher`. MD4 has no native binding, so it
 * uses the RFC 1320 implementation in `./md4`. Neither path hashes
 * incrementally: input is buffered until `digest()`.
 */

const engine = import.meta.use('engine');
const kBlobBytes = Symbol.for('cno.blob.bytes');

export type HashDigestEncoding = import('bun').DigestEncoding;
export type HashClassInput = import('bun').BlobOrStringOrBuffer | DataView;
export type HashClassOutput = ArrayBufferLike | ArrayBufferView;

export interface HashClassInstance<Self> {
    readonly byteLength: number;
    update(data: HashClassInput): Self;
    digest(): Uint8Array<ArrayBuffer>;
    digest(encoding: HashDigestEncoding): string;
    digest<T extends HashClassOutput>(hashInto: T): T;
}

export interface HashClassConstructor<Self> {
    new (): Self;
    readonly prototype: Self;
    readonly byteLength: number;
    hash(input: HashClassInput): Uint8Array<ArrayBuffer>;
    hash(input: HashClassInput, encoding: HashDigestEncoding): string;
    hash<T extends HashClassOutput>(input: HashClassInput, hashInto: T): T;
}

// Names accepted by digest()/hash(), compared case-insensitively. Notably
// absent: 'utf-16le'. 'buffer' returns a Buffer.
const ENCODINGS = new Set([
    'hex', 'base64', 'base64url', 'binary', 'latin1', 'ascii',
    'utf8', 'utf-8', 'utf16le', 'ucs2', 'ucs-2', 'buffer',
]);

const sharedByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
    if (!sharedByteLength || typeof value !== 'object' || value === null) return false;
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

function codedError<T extends Error>(error: T, code: string): T {
    Object.defineProperty(error, 'code', { value: code, writable: true, configurable: true });
    return error;
}

function invalidArgType(message: string): TypeError {
    return codedError(new TypeError(message), 'ERR_INVALID_ARG_TYPE');
}

function bytesOfBuffer(value: ArrayBufferLike | ArrayBufferView): Uint8Array {
    return ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
}

/** Bytes of an accepted input, or a TypeError carrying `invalidMessage`. */
function inputBytes(input: unknown, invalidMessage: string): Uint8Array {
    if (typeof input === 'string') return engine.encodeString(sanitizeSurrogates(input));
    if (typeof input === 'object' && input !== null) {
        if (isRawBuffer(input) || ArrayBuffer.isView(input)) return bytesOfBuffer(input);
        if (input instanceof String) return engine.encodeString(sanitizeSurrogates(input.valueOf()));
        if (input instanceof BunFile) throw invalidArgType('File blob cannot be used here');
        if (typeof Blob !== 'undefined' && input instanceof Blob) {
            const getBytes = Reflect.get(input, kBlobBytes);
            if (typeof getBytes !== 'function') throw new TypeError('Blob byte access is unavailable');
            return Reflect.apply(getBytes, input, []) as Uint8Array;
        }
    }
    throw invalidArgType(invalidMessage);
}

/**
 * Validates a digest() argument up front, so a rejected call leaves the hasher
 * usable, and returns the function that renders the final digest.
 */
function planOutput(
    output: unknown,
    size: number,
    nullMeansDefault: boolean,
): (digest: Uint8Array<ArrayBuffer>) => unknown {
    if (output === undefined || (output === null && nullMeansDefault)) return digest => digest;
    if (typeof output === 'string' || output instanceof String) {
        const requested = String(output);
        const encoding = requested.toLowerCase();
        if (!ENCODINGS.has(encoding)) {
            throw codedError(new TypeError(`Unknown encoding: ${requested}`), 'ERR_INVALID_ARG_VALUE');
        }
        return digest => {
            const buffer = Buffer.from(digest);
            return encoding === 'buffer'
                ? buffer
                : Reflect.apply(buffer.toString, buffer, [encoding]) as string;
        };
    }
    if (typeof output === 'object' && output !== null && (isRawBuffer(output) || ArrayBuffer.isView(output))) {
        const target = bytesOfBuffer(output);
        if (target.byteLength < size) {
            throw invalidArgType(`TypedArray must be at least ${size} bytes`);
        }
        return digest => {
            target.set(digest);
            return output;
        };
    }
    throw invalidArgType('expected string or buffer');
}

interface HashEngine {
    update(bytes: Uint8Array): void;
    digest(): Uint8Array<ArrayBuffer>;
}

function nativeEngine(algorithm: string): HashEngine {
    const hasher = new CryptoHasher(algorithm);
    return {
        // CryptoHasher snapshots every chunk, so callers may reuse their buffers.
        update: bytes => void hasher.update(bytes),
        digest: () => new Uint8Array(hasher.digest()),
    };
}

function md4Engine(): HashEngine {
    const chunks: Uint8Array[] = [];
    return {
        update: bytes => void chunks.push(bytes.slice()),
        digest() {
            const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
            let offset = 0;
            for (const chunk of chunks) {
                joined.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return md4(joined);
        },
    };
}

interface HashState {
    engine: HashEngine;
    done: boolean;
}

function defineHashClass(name: string, size: number, createEngine: () => HashEngine): HashClassConstructor<never> {
    const states = new WeakMap<object, HashState>();

    function stateOf(self: unknown): HashState {
        const state = typeof self === 'object' && self !== null ? states.get(self) : undefined;
        if (state) return state;
        const received = typeof self === 'object' && self !== null
            ? String((self as { constructor?: { name?: unknown } }).constructor?.name ?? 'Object')
            : typeof self;
        throw codedError(
            new TypeError(`Expected this to be instanceof ${name}, but received an instance of ${received}`),
            'ERR_INVALID_THIS',
        );
    }

    function assertOpen(state: HashState, action: string): void {
        if (state.done) {
            throw codedError(
                new Error(`${name} hasher already digested, create a new instance to ${action}`),
                'ERR_INVALID_STATE',
            );
        }
    }

    function Hasher(this: object): void {
        if (!new.target) {
            throw codedError(new TypeError(`${name} constructor cannot be invoked without 'new'`), 'ERR_ILLEGAL_CONSTRUCTOR');
        }
        states.set(this, { engine: createEngine(), done: false });
    }
    Object.defineProperty(Hasher, 'name', { value: name, configurable: true });

    function update(this: unknown, input: unknown): unknown {
        const state = stateOf(this);
        assertOpen(state, 'update');
        state.engine.update(inputBytes(input, 'expected blob or string or buffer'));
        return this;
    }

    // `digest` must report length 0 (Bun shape), so the output argument is
    // variadic; `hash` keeps its declared (input, output) arity of 2.
    function digest(this: unknown, ...args: unknown[]): unknown {
        const state = stateOf(this);
        assertOpen(state, 'digest again');
        const render = planOutput(args[0], size, true);
        const result = state.engine.digest();
        state.done = true;
        return render(result);
    }

    function hash(input: unknown, output?: unknown): unknown {
        const bytes = inputBytes(input, 'expected blob, string or buffer');
        const render = planOutput(output, size, false);
        const hasher = createEngine();
        hasher.update(bytes);
        return render(hasher.digest());
    }

    function instanceByteLength(this: unknown): number {
        if (typeof this !== 'object' || this === null || !states.has(this)) {
            throw new TypeError(`The ${name}.byteLength getter can only be used on instances of ${name}`);
        }
        return size;
    }
    Object.defineProperty(instanceByteLength, 'name', { value: 'byteLength', configurable: true });

    const prototype = Hasher.prototype;
    Object.defineProperties(prototype, {
        byteLength: { get: instanceByteLength, enumerable: true, configurable: false },
        update: { value: update, writable: true, enumerable: true, configurable: false },
        digest: { value: digest, writable: true, enumerable: true, configurable: false },
        [Symbol.toStringTag]: { value: name, configurable: true },
    });
    Object.defineProperties(Hasher, {
        byteLength: { get: () => size, enumerable: true, configurable: false },
        hash: { value: hash, writable: true, enumerable: true, configurable: false },
        prototype: { writable: false },
    });
    return Hasher as unknown as HashClassConstructor<never>;
}

export interface SHA1 extends HashClassInstance<SHA1> {}
export interface MD5 extends HashClassInstance<MD5> {}
export interface MD4 extends HashClassInstance<MD4> {}
export interface SHA224 extends HashClassInstance<SHA224> {}
export interface SHA256 extends HashClassInstance<SHA256> {}
export interface SHA384 extends HashClassInstance<SHA384> {}
export interface SHA512 extends HashClassInstance<SHA512> {}
export interface SHA512_256 extends HashClassInstance<SHA512_256> {}

export const SHA1: HashClassConstructor<SHA1> = defineHashClass('SHA1', 20, () => nativeEngine('sha1'));
export const MD5: HashClassConstructor<MD5> = defineHashClass('MD5', 16, () => nativeEngine('md5'));
export const MD4: HashClassConstructor<MD4> = defineHashClass('MD4', 16, md4Engine);
export const SHA224: HashClassConstructor<SHA224> = defineHashClass('SHA224', 28, () => nativeEngine('sha224'));
export const SHA256: HashClassConstructor<SHA256> = defineHashClass('SHA256', 32, () => nativeEngine('sha256'));
export const SHA384: HashClassConstructor<SHA384> = defineHashClass('SHA384', 48, () => nativeEngine('sha384'));
export const SHA512: HashClassConstructor<SHA512> = defineHashClass('SHA512', 64, () => nativeEngine('sha512'));
export const SHA512_256: HashClassConstructor<SHA512_256> = defineHashClass('SHA512_256', 32, () => nativeEngine('sha512-256'));

/** `Bun.sha(input, output?)`: SHA-512/256 of `input`. Bun's sha.length is 1. */
export function sha(input: HashClassInput): Uint8Array<ArrayBuffer>;
export function sha(input: HashClassInput, encoding: HashDigestEncoding): string;
export function sha<T extends HashClassOutput>(input: HashClassInput, hashInto: T): T;
export function sha(input: HashClassInput, ...rest: unknown[]): unknown {
    return (SHA512_256.hash as (input: unknown, output?: unknown) => unknown)(input, rest[0]);
}
