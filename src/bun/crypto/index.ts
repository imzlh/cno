import { Buffer } from '../../node/buffer';
import { toBuffer } from '../../node/crypto/helpers';
import { sanitizeSurrogates } from '../../utils/bytes';

const blobBytesSymbol = Symbol.for('cno.blob.bytes');

const native = import.meta.use('crypto');
type Hash = (data: BufferSource) => ArrayBuffer;
type Hmac = (key: BufferSource, data: BufferSource) => ArrayBuffer;
const hashes: Record<string, [number, Hash, Hmac?]> = {
    blake2b512: [64, native.blake2b512, native.hmacBlake2b512],
    blake2s256: [32, native.blake2s256],
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
function ownedBytes(input: Input, encoding?: string): Uint8Array<ArrayBuffer> {
    let source: Uint8Array;
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
        const getBytes = Reflect.get(input, blobBytesSymbol);
        if (typeof getBytes !== 'function') throw new TypeError('Blob byte access is unavailable');
        source = Reflect.apply(getBytes, input, []) as Uint8Array;
    }
    else if (typeof input === 'string') {
        const text = sanitizeSurrogates(input);
        const normalized = typeof encoding === 'string' ? encoding.toLowerCase() : '';
        if (normalized === 'ucs2' || normalized === 'ucs-2' || normalized === 'utf16le') {
            source = Buffer.from(text, 'utf16le');
        } else {
            source = toBuffer(text, normalized === 'buffer' ? 'latin1' : normalized);
        }
    } else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
        source = toBuffer(input);
    } else {
        throw new TypeError('input must be a string, ArrayBuffer, ArrayBufferView or Blob');
    }

    // The crypto binding's BufferSource contract is ArrayBuffer-backed. Own a
    // copy here both to satisfy that contract and to snapshot update() input.
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

export class CryptoHasher {
    static readonly algorithms = Object.keys(hashes);
    readonly algorithm: string;
    readonly byteLength: number;
    private readonly key?: Uint8Array<ArrayBuffer>;
    private chunks: Uint8Array<ArrayBuffer>[] = [];
    private consumed = false;

    constructor(algorithm: string, hmacKey?: string | ArrayBuffer | ArrayBufferView) {
        if (typeof algorithm !== 'string') throw new TypeError('algorithm must be a string');
        const name = algorithm.toLowerCase().replace(/^sha-(1|224|256|384|512)$/, 'sha$1');
        const hash = Object.hasOwn(hashes, name) ? hashes[name] : undefined;
        if (!hash) throw new TypeError(`Unsupported algorithm ${algorithm}`);
        this.algorithm = name;
        this.byteLength = hash[0];
        if (hmacKey != null) {
            if (typeof hmacKey !== 'string' && !(hmacKey instanceof ArrayBuffer) && !ArrayBuffer.isView(hmacKey)) throw new TypeError('hmacKey must be a string or buffer');
            if (!hash[2]) {
                const error = new Error('HMAC is not supported for this algorithm yet');
                error.name = 'TODOError';
                throw error;
            }
            this.key = ownedBytes(hmacKey);
        }
    }

    update(input: Input, inputEncoding?: string): this {
        this.assertUsable();
        this.chunks.push(ownedBytes(input, inputEncoding));
        return this;
    }

    copy(): CryptoHasher {
        this.assertUsable();
        const result = new CryptoHasher(this.algorithm, this.key);
        result.chunks = this.chunks.map(chunk => chunk.slice());
        return result;
    }

    digest(): Buffer;
    digest(encoding: string): string;
    digest<T extends ArrayBuffer | ArrayBufferView>(output: T): T;
    digest(output?: Output): Buffer | string | ArrayBuffer | ArrayBufferView {
        this.assertUsable();
        if (output != null && typeof output !== 'string' && !(output instanceof ArrayBuffer) && !ArrayBuffer.isView(output)) {
            throw new TypeError('output must be of type string or ArrayBuffer or ArrayBufferView');
        }
        if (typeof output === 'string' && !['hex', 'base64', 'base64url', 'utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'buffer', 'ucs2', 'ucs-2', 'utf16le'].includes(output.toLowerCase())) {
            throw new TypeError(`Unknown encoding: ${output}`);
        }
        if (output && typeof output !== 'string' && output.byteLength < 64) throw new TypeError('TypedArray must be at least 64 bytes');
        const data = joinBytes(this.chunks);
        const [, hash, hmac] = hashes[this.algorithm];
        const result = new Uint8Array(this.key ? hmac!(this.key, data) : hash(data));
        this.chunks = [];
        if (this.key) this.consumed = true;
        if (output && typeof output !== 'string') {
            const view = output instanceof ArrayBuffer ? new Uint8Array(output) : new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
            view.set(result);
            return output;
        }
        const buffer = Buffer.from(result);
        return !output || output.toLowerCase() === 'buffer' ? buffer : buffer.toString(output as BufferEncoding);
    }

    private assertUsable(): void {
        if (this.consumed) throw new Error('HMAC has been consumed and is no longer usable');
    }

    static hash(algorithm: string, input: Input): Buffer;
    static hash(algorithm: string, input: Input, encoding: string): string;
    static hash<T extends ArrayBuffer | ArrayBufferView>(algorithm: string, input: Input, output: T): T;
    static hash(algorithm: string, input: Input, output?: Output): Buffer | string | ArrayBuffer | ArrayBufferView {
        const hasher = new CryptoHasher(algorithm).update(input);
        return hasher.digest(output as string);
    }
}
