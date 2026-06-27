// node:buffer polyfill for QuickJS (circu.js)
//
// Implements the Node.js 20+ `Buffer` API on top of `Uint8Array`, plus the
// module-level helpers exported by `node:buffer` (transcode, isUtf8, isAscii,
// atob/btoa, Blob/File re-exports, constants, ...).
//
// This module is registered onto the engine as `engine.__buffer` by
// `_internal/inject.ts`; `node/buffer/index.ts` re-exports from there.

// ── Encodings ───────────────────────────────────────────────────────────────

export type Encoding =
    | 'ascii' | 'utf8' | 'utf-8' | 'utf16le' | 'utf-16le' | 'ucs2' | 'ucs-2'
    | 'base64' | 'base64url' | 'latin1' | 'binary' | 'hex';

const enc = new TextEncoder();
const utf8Dec = new TextDecoder('utf-8'); // non-fatal: invalid → U+FFFD

/** Canonicalise an encoding name, or return undefined if unknown. */
function normalizeEncoding(encoding?: string): string | undefined {
    if (!encoding) return 'utf8';
    switch (encoding) {
        case 'utf8': case 'utf-8': return 'utf8';
        case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': return 'utf16le';
        case 'latin1': case 'binary': return 'latin1';
        case 'base64': return 'base64';
        case 'base64url': return 'base64url';
        case 'hex': return 'hex';
        case 'ascii': return 'ascii';
    }
    const low = ('' + encoding).toLowerCase();
    if (low === encoding) return undefined;
    return normalizeEncoding(low);
}

function assertEncoding(encoding?: string): string {
    const e = normalizeEncoding(encoding);
    if (e === undefined) throw new TypeError(`Unknown encoding: ${encoding}`);
    return e;
}

// ── Low-level string ↔ bytes helpers ────────────────────────────────────────

const CHUNK = 0x8000;

/** Build a string from a sequence of UTF-16 code units without blowing the stack. */
function codeUnitsToString(codes: ArrayLike<number>, length: number): string {
    if (length <= CHUNK) {
        return String.fromCharCode.apply(null, codes as any);
    }
    let out = '';
    for (let i = 0; i < length; i += CHUNK) {
        const end = Math.min(i + CHUNK, length);
        out += String.fromCharCode.apply(null, Array.prototype.slice.call(codes, i, end));
    }
    return out;
}

function latin1ToString(bytes: Uint8Array): string {
    return codeUnitsToString(bytes, bytes.length);
}

function asciiToString(bytes: Uint8Array): string {
    const n = bytes.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = bytes[i] & 0x7f;
    return codeUnitsToString(out, n);
}

function utf16leToString(bytes: Uint8Array): string {
    const n = bytes.length >>> 1;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    return codeUnitsToString(out, n);
}

const HEX = '0123456789abcdef';
function hexToString(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
    }
    return out;
}

function hexToBytes(str: string): Uint8Array {
    // Node stops at the first non-hex character / truncates odd length.
    const len = str.length >>> 1;
    const out = new Uint8Array(len);
    let written = 0;
    for (let i = 0; i < len; i++) {
        const hi = parseHexChar(str.charCodeAt(i * 2));
        const lo = parseHexChar(str.charCodeAt(i * 2 + 1));
        if (hi === -1 || lo === -1) break;
        out[written++] = (hi << 4) | lo;
    }
    return written === len ? out : out.subarray(0, written);
}

function parseHexChar(c: number): number {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;        // 0-9
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;   // a-f
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;   // A-F
    return -1;
}

// base64 (+ base64url) ---------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
    const t = new Int8Array(256).fill(-1);
    for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
    t['-'.charCodeAt(0)] = 62; // base64url
    t['_'.charCodeAt(0)] = 63; // base64url
    return t;
})();

function base64ToBytes(str: string): Uint8Array {
    // Tolerant decode: ignores whitespace/invalid chars, handles missing padding.
    const n = str.length;
    const out = new Uint8Array((n * 3) >>> 2 || 0);
    let written = 0, acc = 0, bits = 0;
    for (let i = 0; i < n; i++) {
        const v = B64_LOOKUP[str.charCodeAt(i) & 0xff];
        if (v === -1) continue; // skip '=', whitespace, anything invalid
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[written++] = (acc >> bits) & 0xff;
        }
    }
    return written === out.length ? out : out.subarray(0, written);
}

function bytesToBase64(bytes: Uint8Array, url: boolean): string {
    let out = '';
    const n = bytes.length;
    const last = n - (n % 3);
    for (let i = 0; i < last; i += 3) {
        const x = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64_CHARS[(x >> 18) & 63] + B64_CHARS[(x >> 12) & 63]
            + B64_CHARS[(x >> 6) & 63] + B64_CHARS[x & 63];
    }
    const rem = n - last;
    if (rem === 1) {
        const x = bytes[last];
        out += B64_CHARS[x >> 2] + B64_CHARS[(x << 4) & 63] + (url ? '' : '==');
    } else if (rem === 2) {
        const x = (bytes[last] << 8) | bytes[last + 1];
        out += B64_CHARS[x >> 10] + B64_CHARS[(x >> 4) & 63] + B64_CHARS[(x << 2) & 63] + (url ? '' : '=');
    }
    if (url) return out.replace(/\+/g, '-').replace(/\//g, '_');
    return out;
}

// ── Encode a string to bytes for a given encoding ───────────────────────────

function stringToBytes(str: string, encoding: string): Uint8Array {
    switch (encoding) {
        case 'utf8': return enc.encode(str);
        case 'ascii': {
            const out = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
            return out;
        }
        case 'latin1': {
            const out = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
            return out;
        }
        case 'utf16le': {
            const out = new Uint8Array(str.length * 2);
            for (let i = 0; i < str.length; i++) {
                const c = str.charCodeAt(i);
                out[i * 2] = c & 0xff;
                out[i * 2 + 1] = c >> 8;
            }
            return out;
        }
        case 'base64': case 'base64url': return base64ToBytes(str);
        case 'hex': return hexToBytes(str);
    }
    return enc.encode(str);
}

function bytesToString(bytes: Uint8Array, encoding: string): string {
    switch (encoding) {
        case 'utf8': return utf8Dec.decode(bytes);
        case 'ascii': return asciiToString(bytes);
        case 'latin1': return latin1ToString(bytes);
        case 'utf16le': return utf16leToString(bytes);
        case 'base64': return bytesToBase64(bytes, false);
        case 'base64url': return bytesToBase64(bytes, true);
        case 'hex': return hexToString(bytes);
    }
    return utf8Dec.decode(bytes);
}

function byteLengthOf(str: string, encoding: string): number {
    switch (encoding) {
        case 'utf8': return enc.encode(str).length;
        case 'ascii': case 'latin1': return str.length;
        case 'utf16le': return str.length * 2;
        case 'hex': return str.length >>> 1;
        case 'base64': case 'base64url': return base64ToBytes(str).length;
    }
    return enc.encode(str).length;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const kMaxLength = 0xFFFFFFFF;           // 4 GiB - 1
export const kStringMaxLength = 0x1FFFFFE8;      // (1 << 29) - 24
export const constants = Object.freeze({
    MAX_LENGTH: kMaxLength,
    MAX_STRING_LENGTH: kStringMaxLength,
});
export let INSPECT_MAX_BYTES = 50;

const kInspect = Symbol.for('nodejs.util.inspect.custom');

// ── Bounds checking ─────────────────────────────────────────────────────────

function boundsError(value: number, length: number, type?: string): never {
    if (Math.floor(value) !== value) {
        throw new RangeError(`The value of "${type ?? 'offset'}" is out of range. It must be an integer. Received ${value}`);
    }
    if (length < 0) throw new RangeError('Attempt to access memory outside buffer bounds');
    throw new RangeError(
        `The value of "${type ?? 'offset'}" is out of range. It must be >= 0 and <= ${length}. Received ${value}`
    );
}

function checkBounds(buf: Buffer, offset: number, byteLength: number): void {
    if (offset < 0 || offset + byteLength > buf.length || (offset | 0) !== offset) {
        boundsError(offset, buf.length - byteLength);
    }
}

let dvCache: WeakMap<Uint8Array, DataView> | null = null;
function viewOf(buf: Buffer): DataView {
    if (!dvCache) dvCache = new WeakMap();
    let dv = dvCache.get(buf);
    if (dv === undefined || dv.byteLength !== buf.byteLength) {
        dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        dvCache.set(buf, dv);
    }
    return dv;
}

// ── Buffer class ────────────────────────────────────────────────────────────

export class Buffer extends Uint8Array {
    // Inherits the Uint8Array constructors:
    //   new Buffer(size) / new Buffer(arrayBuffer, byteOffset?, length?) / new Buffer(arrayLike)

    static poolSize = 8192;

    // ── Allocation ──────────────────────────────────────────────────────────

    static alloc(size: number, fill?: string | Uint8Array | number, encoding?: Encoding): Buffer {
        assertSize(size);
        const buf = new Buffer(size);
        if (fill !== undefined && fill !== 0) buf.fill(fill as any, encoding);
        return buf;
    }

    static allocUnsafe(size: number): Buffer {
        assertSize(size);
        return new Buffer(size);
    }

    static allocUnsafeSlow(size: number): Buffer {
        assertSize(size);
        return new Buffer(size);
    }

    // ── Construction from data ──────────────────────────────────────────────

    static from(value: any, encodingOrOffset?: any, length?: number): Buffer {
        if (typeof value === 'string') {
            return fromString(value, encodingOrOffset);
        }

        if (value instanceof ArrayBuffer
            || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
            const ab = value as ArrayBuffer;
            const offset = encodingOrOffset === undefined ? 0 : +encodingOrOffset;
            const len = length === undefined ? ab.byteLength - offset : length;
            return new Buffer(ab, offset, len);
        }

        if (ArrayBuffer.isView(value)) {
            // Uint8Array / Buffer → copy bytes; other views → copy element values.
            if (value instanceof Uint8Array) {
                const buf = new Buffer(value.length);
                buf.set(value);
                return buf;
            }
            return Buffer.from(
                new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            );
        }

        if (value == null) {
            throw new TypeError(
                'The first argument must be of type string or an instance of Buffer, ArrayBuffer, Array, or Array-like Object.'
            );
        }

        // { type: 'Buffer', data: [...] } — Buffer.toJSON() round-trip.
        if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
            return fromArrayLike(value.data);
        }

        // Iterable / array-like
        if (typeof value.length === 'number' || Symbol.iterator in Object(value)) {
            return fromArrayLike(value);
        }

        // { valueOf() } / { [Symbol.toPrimitive]() }
        const prim = value.valueOf && value.valueOf();
        if (prim != null && prim !== value) return Buffer.from(prim, encodingOrOffset, length);

        const toPrim = value[Symbol.toPrimitive];
        if (typeof toPrim === 'function') {
            const r = toPrim.call(value, 'string');
            if (typeof r === 'string') return fromString(r, encodingOrOffset);
        }

        throw new TypeError(
            'The first argument must be of type string or an instance of Buffer, ArrayBuffer, Array, or Array-like Object.'
        );
    }

    static of(...items: number[]): Buffer {
        return fromArrayLike(items);
    }

    static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
        if (!Array.isArray(list)) {
            throw new TypeError('The "list" argument must be an instance of Array.');
        }
        if (list.length === 0) return new Buffer(0);

        if (totalLength === undefined) {
            totalLength = 0;
            for (const b of list) totalLength += b.length;
        }

        const result = new Buffer(totalLength);
        let pos = 0;
        for (const b of list) {
            if (pos >= totalLength) break;
            const slice = pos + b.length > totalLength ? b.subarray(0, totalLength - pos) : b;
            result.set(slice, pos);
            pos += b.length;
        }
        return result;
    }

    // ── Introspection ───────────────────────────────────────────────────────

    static isBuffer(obj: any): obj is Buffer {
        return obj instanceof Buffer;
    }

    static isEncoding(encoding: string): boolean {
        return typeof encoding === 'string' && normalizeEncoding(encoding) !== undefined;
    }

    static byteLength(
        value: string | Uint8Array | ArrayBuffer | ArrayBufferView,
        encoding?: Encoding
    ): number {
        if (typeof value === 'string') {
            return byteLengthOf(value, assertEncoding(encoding));
        }
        if (ArrayBuffer.isView(value)) return value.byteLength;
        if (value instanceof ArrayBuffer) return value.byteLength;
        throw new TypeError('The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.');
    }

    static compare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
        return compareBytes(a, 0, a.length, b, 0, b.length);
    }

    // ── Conversion ──────────────────────────────────────────────────────────

    toString(encoding?: Encoding, start = 0, end: number = this.length): string {
        const e = assertEncoding(encoding);
        start = start < 0 ? 0 : start > this.length ? this.length : start | 0;
        end = end > this.length ? this.length : end | 0;
        if (end <= start) return '';
        return bytesToString(this.subarray(start, end), e);
    }

    toJSON(): { type: 'Buffer'; data: number[] } {
        return { type: 'Buffer', data: Array.prototype.slice.call(this) };
    }

    [kInspect](): string {
        const max = INSPECT_MAX_BYTES;
        let str = '';
        for (let i = 0; i < this.length && i < max; i++) {
            str += (i ? ' ' : '') + HEX[this[i] >> 4] + HEX[this[i] & 0xf];
        }
        if (this.length > max) str += ` ... ${this.length - max} more byte${this.length - max > 1 ? 's' : ''}`;
        return `<Buffer ${str}>`;
    }

    // ── Comparison ──────────────────────────────────────────────────────────

    equals(other: Uint8Array): boolean {
        if (!(other instanceof Uint8Array)) {
            throw new TypeError('The "otherBuffer" argument must be an instance of Buffer or Uint8Array.');
        }
        if (other === this) return true;
        if (other.length !== this.length) return false;
        for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
        return true;
    }

    compare(
        target: Uint8Array,
        targetStart = 0, targetEnd: number = target.length,
        sourceStart = 0, sourceEnd: number = this.length
    ): -1 | 0 | 1 {
        if (!(target instanceof Uint8Array)) {
            throw new TypeError('The "target" argument must be an instance of Buffer or Uint8Array.');
        }
        if (targetStart < 0 || sourceStart < 0 || targetEnd > target.length || sourceEnd > this.length) {
            throw new RangeError('Index out of range');
        }
        return compareBytes(this, sourceStart, sourceEnd, target, targetStart, targetEnd);
    }

    // ── Copy / slice ────────────────────────────────────────────────────────

    copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd: number = this.length): number {
        if (sourceEnd > this.length) sourceEnd = this.length;
        if (sourceStart < 0) sourceStart = 0;
        if (targetStart < 0) throw new RangeError('targetStart out of bounds');
        if (sourceEnd <= sourceStart || targetStart >= target.length) return 0;

        let len = sourceEnd - sourceStart;
        if (targetStart + len > target.length) len = target.length - targetStart;

        // copyWithin-style overlap-safe copy via set on a subarray view
        target.set(this.subarray(sourceStart, sourceStart + len), targetStart);
        return len;
    }

    /** @deprecated Use `subarray` — kept for parity, shares memory like Node. */
    slice(start?: number, end?: number): Buffer {
        return this.subarray(start, end);
    }

    subarray(start?: number, end?: number): Buffer {
        return super.subarray(start as any, end as any) as Buffer;
    }

    // ── Mutation ────────────────────────────────────────────────────────────

    fill(value: string | Uint8Array | number, offset?: any, end?: any, encoding?: Encoding): this {
        // Argument shuffling: fill(value, encoding) / fill(value, offset, encoding)
        if (typeof offset === 'string') { encoding = offset as Encoding; offset = 0; end = this.length; }
        else if (typeof end === 'string') { encoding = end as Encoding; end = this.length; }

        let start = offset === undefined ? 0 : offset | 0;
        let stop = end === undefined ? this.length : end | 0;
        if (start < 0) start = 0;
        if (stop > this.length) stop = this.length;
        if (stop <= start) return this;

        if (typeof value === 'number') {
            super.fill(value & 0xff, start, stop);
            return this;
        }

        const bytes = typeof value === 'string'
            ? stringToBytes(value, assertEncoding(encoding))
            : value;

        if (bytes.length === 0) {
            super.fill(0, start, stop);
            return this;
        }
        if (bytes.length === 1) {
            super.fill(bytes[0], start, stop);
            return this;
        }
        for (let i = start, j = 0; i < stop; i++) {
            this[i] = bytes[j];
            if (++j === bytes.length) j = 0;
        }
        return this;
    }

    write(string: string, offset?: any, length?: any, encoding?: Encoding): number {
        // write(string, [offset], [length], [encoding]) with overloads
        if (offset === undefined) { offset = 0; length = this.length; encoding = 'utf8' as Encoding; }
        else if (typeof offset === 'string') { encoding = offset as Encoding; offset = 0; length = this.length; }
        else if (typeof length === 'string') { encoding = length as Encoding; length = this.length - offset; }

        offset = offset | 0;
        const remaining = this.length - offset;
        if (length === undefined || length > remaining) length = remaining;
        if (offset < 0 || length < 0) throw new RangeError('Offset is out of bounds');
        if (length === 0) return 0;

        const e = assertEncoding(encoding);
        if (e === 'utf8') {
            // encodeInto won't write a partial multi-byte char.
            const { written } = enc.encodeInto(string, this.subarray(offset, offset + length));
            return written;
        }
        const bytes = stringToBytes(string, e);
        const n = Math.min(bytes.length, length);
        this.set(bytes.subarray(0, n), offset);
        return n;
    }

    // ── Search ──────────────────────────────────────────────────────────────

    indexOf(value: string | number | Uint8Array, byteOffset?: any, encoding?: Encoding): number {
        return bidirectionalIndexOf(this, value, byteOffset, encoding, true);
    }

    lastIndexOf(value: string | number | Uint8Array, byteOffset?: any, encoding?: Encoding): number {
        return bidirectionalIndexOf(this, value, byteOffset, encoding, false);
    }

    includes(value: string | number | Uint8Array, byteOffset?: any, encoding?: Encoding): boolean {
        return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    // ── Byte-order swaps ────────────────────────────────────────────────────

    reverse(): this {
        super.reverse();
        return this;
    }

    swap16(): this {
        if (this.length % 2 !== 0) throw new RangeError('Buffer size must be a multiple of 16-bits');
        for (let i = 0; i < this.length; i += 2) {
            const t = this[i]; this[i] = this[i + 1]; this[i + 1] = t;
        }
        return this;
    }

    swap32(): this {
        if (this.length % 4 !== 0) throw new RangeError('Buffer size must be a multiple of 32-bits');
        for (let i = 0; i < this.length; i += 4) {
            let t = this[i]; this[i] = this[i + 3]; this[i + 3] = t;
            t = this[i + 1]; this[i + 1] = this[i + 2]; this[i + 2] = t;
        }
        return this;
    }

    swap64(): this {
        if (this.length % 8 !== 0) throw new RangeError('Buffer size must be a multiple of 64-bits');
        for (let i = 0; i < this.length; i += 8) {
            for (let j = 0; j < 4; j++) {
                const a = i + j, b = i + 7 - j;
                const t = this[a]; this[a] = this[b]; this[b] = t;
            }
        }
        return this;
    }

    // ── Fixed-width reads ───────────────────────────────────────────────────

    readUInt8(offset = 0): number { checkBounds(this, offset, 1); return this[offset]; }
    readInt8(offset = 0): number { checkBounds(this, offset, 1); return (this[offset] << 24) >> 24; }

    readUInt16LE(offset = 0): number { checkBounds(this, offset, 2); return viewOf(this).getUint16(offset, true); }
    readUInt16BE(offset = 0): number { checkBounds(this, offset, 2); return viewOf(this).getUint16(offset, false); }
    readInt16LE(offset = 0): number { checkBounds(this, offset, 2); return viewOf(this).getInt16(offset, true); }
    readInt16BE(offset = 0): number { checkBounds(this, offset, 2); return viewOf(this).getInt16(offset, false); }

    readUInt32LE(offset = 0): number { checkBounds(this, offset, 4); return viewOf(this).getUint32(offset, true); }
    readUInt32BE(offset = 0): number { checkBounds(this, offset, 4); return viewOf(this).getUint32(offset, false); }
    readInt32LE(offset = 0): number { checkBounds(this, offset, 4); return viewOf(this).getInt32(offset, true); }
    readInt32BE(offset = 0): number { checkBounds(this, offset, 4); return viewOf(this).getInt32(offset, false); }

    readFloatLE(offset = 0): number { checkBounds(this, offset, 4); return viewOf(this).getFloat32(offset, true); }
    readFloatBE(offset = 0): number { checkBounds(this, offset, 4); return viewOf(this).getFloat32(offset, false); }
    readDoubleLE(offset = 0): number { checkBounds(this, offset, 8); return viewOf(this).getFloat64(offset, true); }
    readDoubleBE(offset = 0): number { checkBounds(this, offset, 8); return viewOf(this).getFloat64(offset, false); }

    readBigUInt64LE(offset = 0): bigint { checkBounds(this, offset, 8); return viewOf(this).getBigUint64(offset, true); }
    readBigUInt64BE(offset = 0): bigint { checkBounds(this, offset, 8); return viewOf(this).getBigUint64(offset, false); }
    readBigInt64LE(offset = 0): bigint { checkBounds(this, offset, 8); return viewOf(this).getBigInt64(offset, true); }
    readBigInt64BE(offset = 0): bigint { checkBounds(this, offset, 8); return viewOf(this).getBigInt64(offset, false); }

    // ── Variable-width reads (1..6 bytes) ───────────────────────────────────

    readUIntLE(offset: number, byteLength: number): number {
        checkBounds(this, offset, byteLength);
        let val = this[offset], mul = 1, i = 0;
        while (++i < byteLength && (mul *= 0x100)) val += this[offset + i] * mul;
        return val;
    }
    readUIntBE(offset: number, byteLength: number): number {
        checkBounds(this, offset, byteLength);
        let val = this[offset + --byteLength], mul = 1;
        while (byteLength > 0 && (mul *= 0x100)) val += this[offset + --byteLength] * mul;
        return val;
    }
    readIntLE(offset: number, byteLength: number): number {
        let val = this.readUIntLE(offset, byteLength);
        const sub = Math.pow(2, 8 * byteLength - 1);
        if (val >= sub) val -= sub * 2;
        return val;
    }
    readIntBE(offset: number, byteLength: number): number {
        let val = this.readUIntBE(offset, byteLength);
        const sub = Math.pow(2, 8 * byteLength - 1);
        if (val >= sub) val -= sub * 2;
        return val;
    }

    // ── Fixed-width writes ──────────────────────────────────────────────────

    writeUInt8(value: number, offset = 0): number { checkBounds(this, offset, 1); this[offset] = value & 0xff; return offset + 1; }
    writeInt8(value: number, offset = 0): number { checkBounds(this, offset, 1); this[offset] = value & 0xff; return offset + 1; }

    writeUInt16LE(value: number, offset = 0): number { checkBounds(this, offset, 2); viewOf(this).setUint16(offset, value & 0xffff, true); return offset + 2; }
    writeUInt16BE(value: number, offset = 0): number { checkBounds(this, offset, 2); viewOf(this).setUint16(offset, value & 0xffff, false); return offset + 2; }
    writeInt16LE(value: number, offset = 0): number { checkBounds(this, offset, 2); viewOf(this).setInt16(offset, value, true); return offset + 2; }
    writeInt16BE(value: number, offset = 0): number { checkBounds(this, offset, 2); viewOf(this).setInt16(offset, value, false); return offset + 2; }

    writeUInt32LE(value: number, offset = 0): number { checkBounds(this, offset, 4); viewOf(this).setUint32(offset, value >>> 0, true); return offset + 4; }
    writeUInt32BE(value: number, offset = 0): number { checkBounds(this, offset, 4); viewOf(this).setUint32(offset, value >>> 0, false); return offset + 4; }
    writeInt32LE(value: number, offset = 0): number { checkBounds(this, offset, 4); viewOf(this).setInt32(offset, value, true); return offset + 4; }
    writeInt32BE(value: number, offset = 0): number { checkBounds(this, offset, 4); viewOf(this).setInt32(offset, value, false); return offset + 4; }

    writeFloatLE(value: number, offset = 0): number { checkBounds(this, offset, 4); viewOf(this).setFloat32(offset, value, true); return offset + 4; }
    writeFloatBE(value: number, offset = 0): number { checkBounds(this, offset, 4); viewOf(this).setFloat32(offset, value, false); return offset + 4; }
    writeDoubleLE(value: number, offset = 0): number { checkBounds(this, offset, 8); viewOf(this).setFloat64(offset, value, true); return offset + 8; }
    writeDoubleBE(value: number, offset = 0): number { checkBounds(this, offset, 8); viewOf(this).setFloat64(offset, value, false); return offset + 8; }

    writeBigUInt64LE(value: bigint, offset = 0): number { checkBounds(this, offset, 8); viewOf(this).setBigUint64(offset, value, true); return offset + 8; }
    writeBigUInt64BE(value: bigint, offset = 0): number { checkBounds(this, offset, 8); viewOf(this).setBigUint64(offset, value, false); return offset + 8; }
    writeBigInt64LE(value: bigint, offset = 0): number { checkBounds(this, offset, 8); viewOf(this).setBigInt64(offset, value, true); return offset + 8; }
    writeBigInt64BE(value: bigint, offset = 0): number { checkBounds(this, offset, 8); viewOf(this).setBigInt64(offset, value, false); return offset + 8; }

    // ── Variable-width writes (1..6 bytes) ──────────────────────────────────

    writeUIntLE(value: number, offset: number, byteLength: number): number {
        checkBounds(this, offset, byteLength);
        let mul = 1, i = 0;
        this[offset] = value & 0xff;
        while (++i < byteLength && (mul *= 0x100)) this[offset + i] = (value / mul) & 0xff;
        return offset + byteLength;
    }
    writeUIntBE(value: number, offset: number, byteLength: number): number {
        checkBounds(this, offset, byteLength);
        let i = byteLength - 1, mul = 1;
        this[offset + i] = value & 0xff;
        while (--i >= 0 && (mul *= 0x100)) this[offset + i] = (value / mul) & 0xff;
        return offset + byteLength;
    }
    writeIntLE(value: number, offset: number, byteLength: number): number {
        if (value < 0) value += Math.pow(2, 8 * byteLength);
        return this.writeUIntLE(value, offset, byteLength);
    }
    writeIntBE(value: number, offset: number, byteLength: number): number {
        if (value < 0) value += Math.pow(2, 8 * byteLength);
        return this.writeUIntBE(value, offset, byteLength);
    }

    // ── Uint aliases (declared for the type system; wired up below) ─────────
    readUint8!: Buffer['readUInt8'];
    readUint16LE!: Buffer['readUInt16LE'];
    readUint16BE!: Buffer['readUInt16BE'];
    readUint32LE!: Buffer['readUInt32LE'];
    readUint32BE!: Buffer['readUInt32BE'];
    readUintLE!: Buffer['readUIntLE'];
    readUintBE!: Buffer['readUIntBE'];
    readBigUint64LE!: Buffer['readBigUInt64LE'];
    readBigUint64BE!: Buffer['readBigUInt64BE'];
    writeUint8!: Buffer['writeUInt8'];
    writeUint16LE!: Buffer['writeUInt16LE'];
    writeUint16BE!: Buffer['writeUInt16BE'];
    writeUint32LE!: Buffer['writeUInt32LE'];
    writeUint32BE!: Buffer['writeUInt32BE'];
    writeUintLE!: Buffer['writeUIntLE'];
    writeUintBE!: Buffer['writeUIntBE'];
    writeBigUint64LE!: Buffer['writeBigUInt64LE'];
    writeBigUint64BE!: Buffer['writeBigUInt64BE'];
}

// ── Lower-case `Uint` aliases (Node 14.10+) ─────────────────────────────────

const P = Buffer.prototype as any;
P.readUint8 = P.readUInt8;
P.readUint16LE = P.readUInt16LE;
P.readUint16BE = P.readUInt16BE;
P.readUint32LE = P.readUInt32LE;
P.readUint32BE = P.readUInt32BE;
P.readUintLE = P.readUIntLE;
P.readUintBE = P.readUIntBE;
P.readBigUint64LE = P.readBigUInt64LE;
P.readBigUint64BE = P.readBigUInt64BE;
P.writeUint8 = P.writeUInt8;
P.writeUint16LE = P.writeUInt16LE;
P.writeUint16BE = P.writeUInt16BE;
P.writeUint32LE = P.writeUInt32LE;
P.writeUint32BE = P.writeUInt32BE;
P.writeUintLE = P.writeUIntLE;
P.writeUintBE = P.writeUIntBE;
P.writeBigUint64LE = P.writeBigUInt64LE;
P.writeBigUint64BE = P.writeBigUInt64BE;

// ── Internal construction helpers ───────────────────────────────────────────

function assertSize(size: number): void {
    if (typeof size !== 'number') throw new TypeError(`The "size" argument must be of type number. Received ${typeof size}`);
    if (size < 0 || size > kMaxLength || Number.isNaN(size)) {
        throw new RangeError(`The value "${size}" is invalid for option "size"`);
    }
}

function fromString(string: string, encoding?: string): Buffer {
    const bytes = stringToBytes(string, assertEncoding(encoding));
    if ((bytes as any) instanceof Buffer) return bytes as Buffer;
    const buf = new Buffer(bytes.length);
    buf.set(bytes);
    return buf;
}

function fromArrayLike(arrayLike: ArrayLike<number> | Iterable<number>): Buffer {
    const arr = Array.isArray(arrayLike) || ('length' in (arrayLike as any))
        ? arrayLike as ArrayLike<number>
        : Array.from(arrayLike as Iterable<number>);
    const len = arr.length >>> 0;
    const buf = new Buffer(len);
    for (let i = 0; i < len; i++) buf[i] = (arr as any)[i] & 0xff;
    return buf;
}

// ── Comparison / search helpers ─────────────────────────────────────────────

function compareBytes(
    a: Uint8Array, aStart: number, aEnd: number,
    b: Uint8Array, bStart: number, bEnd: number
): -1 | 0 | 1 {
    const aLen = aEnd - aStart, bLen = bEnd - bStart;
    const len = Math.min(aLen, bLen);
    for (let i = 0; i < len; i++) {
        const x = a[aStart + i], y = b[bStart + i];
        if (x < y) return -1;
        if (x > y) return 1;
    }
    if (aLen < bLen) return -1;
    if (aLen > bLen) return 1;
    return 0;
}

function bidirectionalIndexOf(
    buf: Buffer,
    value: string | number | Uint8Array,
    byteOffset: any,
    encoding: Encoding | undefined,
    forward: boolean
): number {
    if (typeof byteOffset === 'string') { encoding = byteOffset as Encoding; byteOffset = undefined; }

    let offset = byteOffset === undefined ? (forward ? 0 : buf.length - 1) : +byteOffset;
    if (Number.isNaN(offset)) offset = forward ? 0 : buf.length - 1;
    if (offset < 0) offset += buf.length;

    // Normalise the needle to a byte sequence.
    let needle: Uint8Array;
    if (typeof value === 'number') {
        const b = value & 0xff;
        if (forward) {
            for (let i = Math.max(offset, 0); i < buf.length; i++) if (buf[i] === b) return i;
        } else {
            for (let i = Math.min(offset, buf.length - 1); i >= 0; i--) if (buf[i] === b) return i;
        }
        return -1;
    } else if (typeof value === 'string') {
        needle = stringToBytes(value, assertEncoding(encoding));
    } else if (value instanceof Uint8Array) {
        needle = value;
    } else {
        throw new TypeError('The "value" argument must be one of type number, string, Buffer, or Uint8Array.');
    }

    if (needle.length === 0) {
        return forward ? Math.min(Math.max(offset, 0), buf.length) : Math.min(Math.max(offset, 0), buf.length);
    }
    if (needle.length > buf.length) return -1;

    if (forward) {
        const last = buf.length - needle.length;
        for (let i = Math.max(offset, 0); i <= last; i++) {
            if (matchAt(buf, needle, i)) return i;
        }
    } else {
        for (let i = Math.min(offset, buf.length - needle.length); i >= 0; i--) {
            if (matchAt(buf, needle, i)) return i;
        }
    }
    return -1;
}

function matchAt(buf: Uint8Array, needle: Uint8Array, pos: number): boolean {
    for (let j = 0; j < needle.length; j++) {
        if (buf[pos + j] !== needle[j]) return false;
    }
    return true;
}

// ── Module-level functions ──────────────────────────────────────────────────

export type TranscodeEncoding =
    | 'ascii' | 'utf8' | 'utf-8' | 'utf16le' | 'utf-16le' | 'ucs2' | 'ucs-2' | 'latin1' | 'binary';

/** Re-encode a Buffer/Uint8Array from one encoding to another. */
export function transcode(source: Uint8Array, fromEnc: TranscodeEncoding, toEnc: TranscodeEncoding): Buffer {
    const from = assertEncoding(fromEnc);
    const to = assertEncoding(toEnc);
    const str = bytesToString(source instanceof Buffer ? source : Buffer.from(source), from);
    // Substitute unrepresentable characters for single-byte target encodings.
    if (to === 'ascii' || to === 'latin1') {
        const limit = to === 'ascii' ? 0x80 : 0x100;
        const out = new Buffer(str.length);
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            out[i] = c < limit ? c : 0x3f; // '?'
        }
        return out;
    }
    return fromString(str, to);
}

/** True if `input` contains only valid UTF-8. */
export function isUtf8(input: ArrayBuffer | ArrayBufferView): boolean {
    const bytes = toBytes(input);
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
    } catch {
        return false;
    }
}

/** True if `input` contains only 7-bit ASCII bytes. */
export function isAscii(input: ArrayBuffer | ArrayBufferView): boolean {
    const bytes = toBytes(input);
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
    return true;
}

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('The "input" argument must be an instance of ArrayBuffer or ArrayBufferView.');
}

/** Resolve a `blob:nodedata:...` URL — not supported in this runtime. */
export function resolveObjectURL(_id: string): undefined {
    return undefined;
}

// atob / btoa — prefer the engine globals, fall back to our base64 codec.
export const btoa: (data: string) => string =
    (typeof globalThis.btoa === 'function')
        ? globalThis.btoa
        : (data: string) => {
            const bytes = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) {
                const c = data.charCodeAt(i);
                if (c > 0xff) throw new DOMException('Invalid character', 'InvalidCharacterError') ?? new Error('Invalid character');
                bytes[i] = c;
            }
            return bytesToBase64(bytes, false);
        };

export const atob: (data: string) => string =
    (typeof globalThis.atob === 'function')
        ? globalThis.atob
        : (data: string) => latin1ToString(base64ToBytes(data));

// Blob / File come from the web platform layer when available.
export const Blob: typeof globalThis.Blob | undefined =
    typeof globalThis.Blob !== 'undefined' ? globalThis.Blob : undefined;
export const File: typeof globalThis.File | undefined =
    typeof globalThis.File !== 'undefined' ? (globalThis as any).File : undefined;

/** Deprecated alias retained for compatibility — same as `Buffer.allocUnsafeSlow`. */
export function SlowBuffer(length: number): Buffer {
    return Buffer.allocUnsafeSlow(length);
}