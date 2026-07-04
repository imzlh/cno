/**
 * Node.js string_decoder module
 * Decodes buffer data into strings preserving multi-byte characters
 */

const { Decoder } = import.meta.use('text');
import { Buffer } from '../buffer';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type NativeDecoder = InstanceType<typeof Decoder>;

function normalizeEncoding(encoding: string): string {
    const lower = encoding.toLowerCase();
    if (lower === 'utf-8') return 'utf8';
    return lower;
}

function isUtf8Encoding(encoding: string): boolean {
    return encoding === 'utf8';
}

function createDecoder(encoding: string): NativeDecoder | null {
    if (encoding === 'hex') return null;
    return new Decoder(encoding, { stream: true });
}

function concatBytes(a: Uint8Array | null, b: Uint8Array): Uint8Array {
    if (!a || a.byteLength === 0) return b;
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
}

function utf8TrailingBytes(bytes: Uint8Array): number {
    const len = bytes.byteLength;
    if (len === 0) return 0;

    let continuation = 0;
    for (let i = len - 1; i >= 0 && continuation < 3; i--) {
        const byte = bytes[i]!;
        if ((byte & 0b1100_0000) === 0b1000_0000) {
            continuation++;
            continue;
        }

        if ((byte & 0b1000_0000) === 0) return 0;

        const expected =
            (byte & 0b1111_1000) === 0b1111_0000 ? 3 :
            (byte & 0b1111_0000) === 0b1110_0000 ? 2 :
            (byte & 0b1110_0000) === 0b1100_0000 ? 1 :
            0;
        return continuation < expected ? continuation + 1 : 0;
    }

    return Math.min(len, continuation);
}

export interface StringDecoder {
    _encoding: string;
    _decoder: NativeDecoder | null;
    _pending: Uint8Array | null;
    write(buf: Buffer | Uint8Array): string;
    end(buf?: Buffer | Uint8Array): string;
}

export interface StringDecoderConstructor {
    new (encoding?: string): StringDecoder;
    (encoding?: string): StringDecoder;
    prototype: StringDecoder;
}

function toUint8Array(buf: Buffer | Uint8Array): Uint8Array {
    return buf instanceof Uint8Array ? buf as Uint8Array : new Uint8Array(buf);
}

export const StringDecoder: StringDecoderConstructor = function StringDecoder(this: any, encoding: string = 'utf8') {
    const target = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(StringDecoder.prototype);
    target._encoding = normalizeEncoding(encoding);
    target._decoder = createDecoder(target._encoding);
    target._pending = null;
    return target;
} as StringDecoderConstructor;

StringDecoder.prototype.write = function write(this: StringDecoder, buf: Buffer | Uint8Array): string {
    if (this._encoding === 'hex') {
        return Buffer.from(toUint8Array(buf)).toString('hex');
    }

    let bytes = concatBytes(this._pending, toUint8Array(buf));
    this._pending = null;

    if (isUtf8Encoding(this._encoding)) {
        const trailing = utf8TrailingBytes(bytes);
        if (trailing > 0) {
            this._pending = bytes.subarray(bytes.byteLength - trailing);
            bytes = bytes.subarray(0, bytes.byteLength - trailing);
        }
    }

    if (bytes.byteLength === 0) return '';
    return this._decoder!.decode(bytes);
};

StringDecoder.prototype.end = function end(this: StringDecoder, buf?: Buffer | Uint8Array): string {
    if (this._encoding === 'hex') {
        return buf && toUint8Array(buf).byteLength > 0
            ? Buffer.from(toUint8Array(buf)).toString('hex')
            : '';
    }

    let out = '';
    let bytes = this._pending;
    this._pending = null;
    if (buf && toUint8Array(buf).byteLength > 0) {
        bytes = concatBytes(bytes, toUint8Array(buf));
    }
    if (bytes && bytes.byteLength > 0) {
        out += this._decoder!.decode(bytes, { stream: true });
    }
    out += (this._decoder as any).decode();
    this._decoder = createDecoder(this._encoding);
    return out;
};

Object.defineProperty(StringDecoder.prototype, 'constructor', {
    value: StringDecoder,
    writable: true,
    configurable: true,
});

export default {
    StringDecoder,
};
