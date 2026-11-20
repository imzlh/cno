import { Buffer } from 'node:buffer';
import { blobBytesOf } from '../blob-intrinsics';
import { isBunFile } from '../file';
import { CryptoHasher } from './index';
import { sanitizeSurrogates } from '../../utils/bytes';

const engine = import.meta.use('engine');

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
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;

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

function bytesOfBuffer(value: ArrayBufferLike | ArrayBufferView): Uint8Array {
    if (isRawBuffer(value)) return new Uint8Array(value);
    const slots = viewSlots(value)!;
    return new Uint8Array(slots.buffer, slots.byteOffset, slots.byteLength);
}

/** Bytes of an accepted input, or a TypeError carrying `invalidMessage`. */
function inputBytes(input: unknown): Uint8Array {
    const text = stringValue(input);
    if (text !== undefined) return engine.encodeString(sanitizeSurrogates(text));
    if (typeof input === 'object' && input !== null) {
        if (isRawBuffer(input) || viewSlots(input)) return bytesOfBuffer(input as ArrayBufferLike | ArrayBufferView);
        if (isBunFile(input)) throw invalidArgType('File blob cannot be used here');
        const bytes = blobBytesOf(input);
        if (bytes) return bytes;
    }
    throw invalidArgType('input must be a string, ArrayBuffer, ArrayBufferView or Blob');
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
    if (typeof output === 'object' && output !== null && (isRawBuffer(output) || arrayBufferIsView(output))) {
        const target = bytesOfBuffer(output);
        if (target.byteLength < size) {
            throw invalidArgType(`TypedArray must be at least ${size} bytes`);
        }
        return digest => {
            target.set(digest);
            return output;
        };
    }
    throw invalidArgType('output must be of type string or ArrayBuffer or ArrayBufferView');
}

interface HashState {
    hasher: CryptoHasher;
    done: boolean;
}

function defineHashClass(name: string, size: number, algorithm: string): HashClassConstructor<never> {
    const states = new WeakMap<object, HashState>();

    function stateOf(self: unknown): HashState {
        const state = typeof self === 'object' && self !== null ? states.get(self) : undefined;
        if (state) return state;
        let suffix = '';
        if (self === null) suffix = ', but received null';
        else if (self !== undefined && (typeof self === 'object' || typeof self === 'function')) {
            const received = String((self as { constructor?: { name?: unknown } }).constructor?.name ?? 'Object');
            suffix = `, but received an instance of ${received}`;
        } else if (self !== undefined) {
            suffix = `, but received type ${typeof self} (${String(self)})`;
        }
        throw codedError(
            new TypeError(`Expected this to be instanceof ${name}${suffix}`),
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
        states.set(this, { hasher: new CryptoHasher(algorithm), done: false });
    }
    Object.defineProperty(Hasher, 'name', { value: name, configurable: true });

    function update(this: unknown, input: unknown): unknown {
        const state = stateOf(this);
        const bytes = inputBytes(input);
        assertOpen(state, 'update');
        state.hasher.update(bytes);
        return this;
    }

    // `digest` must report length 0 (Bun shape), so the output argument is
    // variadic; `hash` keeps its declared (input, output) arity of 2.
    function digest(this: unknown, ...args: unknown[]): unknown {
        const state = stateOf(this);
        assertOpen(state, 'digest again');
        const render = planOutput(args[0], size, true);
        const result = new Uint8Array(state.hasher.digest());
        state.done = true;
        return render(result);
    }

    function hash(input: unknown, output?: unknown): unknown {
        const bytes = inputBytes(input);
        const render = planOutput(output, size, false);
        const hasher = new CryptoHasher(algorithm);
        hasher.update(bytes);
        return render(new Uint8Array(hasher.digest()));
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

export const SHA1: HashClassConstructor<SHA1> = defineHashClass('SHA1', 20, 'sha1');
export const MD5: HashClassConstructor<MD5> = defineHashClass('MD5', 16, 'md5');
export const MD4: HashClassConstructor<MD4> = defineHashClass('MD4', 16, 'md4');
export const SHA224: HashClassConstructor<SHA224> = defineHashClass('SHA224', 28, 'sha224');
export const SHA256: HashClassConstructor<SHA256> = defineHashClass('SHA256', 32, 'sha256');
export const SHA384: HashClassConstructor<SHA384> = defineHashClass('SHA384', 48, 'sha384');
export const SHA512: HashClassConstructor<SHA512> = defineHashClass('SHA512', 64, 'sha512');
export const SHA512_256: HashClassConstructor<SHA512_256> = defineHashClass('SHA512_256', 32, 'sha512-256');

/** `Bun.sha(input, output?)`: SHA-512/256 of `input`. Bun's sha.length is 1. */
export function sha(input: HashClassInput): Uint8Array<ArrayBuffer>;
export function sha(input: HashClassInput, encoding: HashDigestEncoding): string;
export function sha<T extends HashClassOutput>(input: HashClassInput, hashInto: T): T;
export function sha(input: HashClassInput, ...rest: unknown[]): unknown {
    return (SHA512_256.hash as (input: unknown, output?: unknown) => unknown)(input, rest[0]);
}
