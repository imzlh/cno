/**
 * Node.js string_decoder module
 * Decodes buffer data into strings preserving multi-byte characters
 */

const { Decoder } = import.meta.use('text');
const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
import type { Buffer } from '../buffer';
import { concatChunks } from '../_internal/buffer';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type ByteView = globalThis.Uint8Array<ArrayBufferLike>;
type NativeDecoder = InstanceType<typeof Decoder>;

function normalizeEncoding(encoding: string): string {
    const lower = encoding.toLowerCase();
    if (lower === 'utf-8') return 'utf8';
    return lower;
}

function isUtf8Encoding(encoding: string): boolean {
    return encoding === 'utf8';
}

function isUtf16Encoding(encoding: string): boolean {
    return encoding === 'utf16le' || encoding === 'ucs2' || encoding === 'ucs-2';
}

function createDecoder(encoding: string): NativeDecoder | null {
    if (encoding === 'hex' || encoding === 'base64' || encoding === 'base64url' || isUtf16Encoding(encoding)) return null;
    return new Decoder(encoding, { stream: true });
}

function base64Encode(bytes: Uint8Array, url: boolean): string {
    const encoded = crypto.base64Encode(bytes);
    return url ? encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') : encoded;
}

function concatBytes(a: Uint8Array | null, b: Uint8Array): Uint8Array {
    if (!a || a.byteLength === 0) return b;
    return concatChunks([a, b]);
}

function utf8TrailingBytes(bytes: Uint8Array): number {
    const len = bytes.byteLength;
    if (len === 0) return 0;

    let continuation = 0;
    for (let i = len - 1; i >= 0 && continuation < 4; i--) {
        const byte = bytes[i];
        if (byte === undefined) break;
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
    write(buf: Buffer | ByteView): string;
    end(buf?: Buffer | ByteView): string;
}

export interface StringDecoderConstructor {
    new (encoding?: string): StringDecoder;
    (encoding?: string): StringDecoder;
    prototype: StringDecoder;
}

function toUint8Array(buf: Buffer | ByteView): Uint8Array {
    if (buf.buffer instanceof ArrayBuffer) {
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    return copy;
}

function decodeUtf16le(bytes: Uint8Array): string {
    const len = bytes.byteLength & ~1;
    if (len === 0) return '';
    if ((bytes.byteOffset & 1) === 0) {
        return engine.decodeU16String(new Uint16Array(bytes.buffer, bytes.byteOffset, len >>> 1));
    }
    const copy = new Uint8Array(len);
    copy.set(bytes.subarray(0, len));
    return engine.decodeU16String(copy.buffer);
}

export const StringDecoder: StringDecoderConstructor = function StringDecoder(this: StringDecoder | undefined, encoding: string = 'utf8') {
    const target: StringDecoder = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(StringDecoder.prototype);
    target._encoding = normalizeEncoding(encoding);
    target._decoder = createDecoder(target._encoding);
    target._pending = null;
    return target;
} as StringDecoderConstructor;

StringDecoder.prototype.write = function write(this: StringDecoder, buf: Buffer | ByteView): string {
    if (this._encoding === 'hex') {
        return crypto.hexEncode(toUint8Array(buf));
    }

    let bytes = concatBytes(this._pending, toUint8Array(buf));
    this._pending = null;

    if (this._encoding === 'base64' || this._encoding === 'base64url') {
        const remainder = bytes.byteLength % 3;
        if (remainder > 0) {
            this._pending = bytes.subarray(bytes.byteLength - remainder);
            bytes = bytes.subarray(0, bytes.byteLength - remainder);
        }
        return bytes.byteLength === 0 ? '' : base64Encode(bytes, this._encoding === 'base64url');
    }

    if (isUtf16Encoding(this._encoding)) {
        let pendingBytes = bytes.byteLength % 2;
        if (bytes.byteLength >= 2) {
            const completeLength = bytes.byteLength - pendingBytes;
            if (completeLength >= 2) {
                const lo = bytes[completeLength - 2];
                const hi = bytes[completeLength - 1];
                const lastUnit = lo === undefined || hi === undefined ? 0 : lo | (hi << 8);
                if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF) pendingBytes += 2;
            }
        }
        if (pendingBytes > 0) {
            this._pending = bytes.subarray(bytes.byteLength - pendingBytes);
            bytes = bytes.subarray(0, bytes.byteLength - pendingBytes);
        }
        return decodeUtf16le(bytes);
    }

    if (isUtf8Encoding(this._encoding)) {
        const trailing = utf8TrailingBytes(bytes);
        if (trailing > 0) {
            this._pending = bytes.subarray(bytes.byteLength - trailing);
            bytes = bytes.subarray(0, bytes.byteLength - trailing);
        }
    }

    if (bytes.byteLength === 0) return '';
    const decoder = this._decoder;
    return decoder ? decoder.decode(bytes) : '';
};

StringDecoder.prototype.end = function end(this: StringDecoder, buf?: Buffer | ByteView): string {
    if (this._encoding === 'hex') {
        return buf && toUint8Array(buf).byteLength > 0
            ? crypto.hexEncode(toUint8Array(buf))
            : '';
    }

    let out = '';
    let bytes = this._pending;
    this._pending = null;
    if (buf && toUint8Array(buf).byteLength > 0) {
        bytes = concatBytes(bytes, toUint8Array(buf));
    }
    if (this._encoding === 'base64' || this._encoding === 'base64url') {
        return bytes && bytes.byteLength > 0 ? base64Encode(bytes, this._encoding === 'base64url') : '';
    }
    if (isUtf16Encoding(this._encoding)) {
        return bytes && bytes.byteLength > 0 ? decodeUtf16le(bytes) : '';
    }
    if (bytes && bytes.byteLength > 0) {
        const decoder = this._decoder;
        if (decoder) out += decoder.decode(bytes, { stream: true });
    }
    out += this._decoder?.decode() ?? '';
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
