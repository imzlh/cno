// node:buffer polyfill for QuickJS (circu.js)
//
// Implements the Node.js 20+ `Buffer` API on top of `Uint8Array`, plus the
// module-level helpers exported by `node:buffer` (transcode, isUtf8, isAscii,
// atob/btoa, Blob/File re-exports, constants, ...).
//
// This module is registered onto the engine as `engine.__buffer` by
// `_internal/inject.ts`; `node/buffer/index.ts` re-exports from there.

const nativeCrypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');

// ── Encodings ───────────────────────────────────────────────────────────────

export type Encoding =
    | 'ascii' | 'utf8' | 'utf-8' | 'utf16le' | 'utf-16le' | 'ucs2' | 'ucs-2'
    | 'base64' | 'base64url' | 'latin1' | 'binary' | 'hex';

type TypedArrayView = ArrayBufferView & {
    readonly length: number;
    readonly BYTES_PER_ELEMENT: number;
};

function isTypedArrayView(view: ArrayBufferView): view is TypedArrayView {
    return !(view instanceof DataView);
}

/** Canonicalise an encoding name, or return undefined if unknown. */
function normalizeEncoding(encoding?: unknown): string | undefined {
    if (!encoding) return 'utf8';
    if (typeof encoding !== 'string') return 'utf8';
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

function latin1ToString(bytes: Uint8Array): string {
    return algorithm.latin1DecodeLoose(bytes);
}

function asciiToString(bytes: Uint8Array): string {
    return algorithm.asciiDecodeLoose(bytes);
}

function utf16leToString(bytes: Uint8Array): string {
    const len = bytes.length & ~1;
    if (len === 0) return '';
    if ((bytes.byteOffset & 1) === 0) {
        return engine.decodeU16String(new Uint16Array(bytes.buffer, bytes.byteOffset, len >>> 1));
    }
    const copy = new Uint8Array(len);
    copy.set(bytes.subarray(0, len));
    return engine.decodeU16String(copy.buffer);
}

function hexToString(bytes: Uint8Array): string {
    return nativeCrypto.hexEncode(bytes);
}

function hexToBytes(str: string): Uint8Array {
    return algorithm.hexDecodeLoose(str);
}

// base64 (+ base64url) ---------------------------------------------------------

function base64ToBytes(str: string): Uint8Array {
    return algorithm.base64DecodeLoose(str);
}

function bytesToBase64(bytes: Uint8Array, url: boolean): string {
    return url ? algorithm.base64UrlEncode(bytes) : nativeCrypto.base64Encode(bytes);
}

function base64ByteLength(str: string): number {
    let len = str.length;
    if (len > 0 && str.charCodeAt(len - 1) === 0x3d) len--;
    if (len > 1 && str.charCodeAt(len - 1) === 0x3d) len--;
    return (len * 3) >>> 2;
}

// ── Encode a string to bytes for a given encoding ───────────────────────────

function stringToBytes(str: string, encoding: string): Uint8Array {
    switch (encoding) {
        case 'utf8': return engine.encodeString(str);
        case 'ascii': return algorithm.asciiEncodeLoose(str);
        case 'latin1': return algorithm.latin1EncodeLoose(str);
        case 'utf16le': {
            const u16 = engine.encodeU16String(str);
            return new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
        }
        case 'base64': case 'base64url': return base64ToBytes(str);
        case 'hex': return hexToBytes(str);
    }
    return engine.encodeString(str);
}

function bytesToString(bytes: Uint8Array, encoding: string): string {
    switch (encoding) {
        case 'utf8': return engine.decodeString(bytes);
        case 'ascii': return asciiToString(bytes);
        case 'latin1': return latin1ToString(bytes);
        case 'utf16le': return utf16leToString(bytes);
        case 'base64': return bytesToBase64(bytes, false);
        case 'base64url': return bytesToBase64(bytes, true);
        case 'hex': return hexToString(bytes);
    }
    return engine.decodeString(bytes);
}

function byteLengthOf(str: string, encoding: string): number {
    switch (encoding) {
        case 'utf8': return engine.encodeString(str).length;
        case 'ascii': case 'latin1': return str.length;
        case 'utf16le': return str.length * 2;
        case 'hex': return str.length >>> 1;
        case 'base64': case 'base64url': return base64ByteLength(str);
    }
    return engine.encodeString(str).length;
}

function utf8PrefixLength(bytes: Uint8Array, max: number): number {
    if (max <= 0) return 0;
    if (max >= bytes.length) return bytes.length;

    let start = max;
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
    if (start === max) return max;

    const lead = bytes[start];
    const needed = lead < 0x80 ? 1
        : lead >= 0xc0 && lead < 0xe0 ? 2
        : lead >= 0xe0 && lead < 0xf0 ? 3
        : lead >= 0xf0 && lead < 0xf8 ? 4
        : 1;
    return start + needed <= max ? max : start;
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
const HEX = '0123456789abcdef';

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

function attachBufferPrototype(view: Uint8Array<ArrayBufferLike>): asserts view is Buffer {
    Object.setPrototypeOf(view, Buffer.prototype);
}

export class Buffer extends Uint8Array {
    // Inherits the Uint8Array constructors:
    //   new Buffer(size) / new Buffer(arrayBuffer, byteOffset?, length?) / new Buffer(arrayLike)

    static poolSize = 8192;

    // ── Allocation ──────────────────────────────────────────────────────────

    static alloc(size: number, fill?: string | Uint8Array | number, encoding?: Encoding): Buffer {
        assertSize(size);
        const buf = new Buffer(size);
        if (fill !== undefined && fill !== 0) buf.fill(fill, encoding);
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

    static from(value: unknown, encodingOrOffset?: unknown, length?: number): Buffer {
        if (typeof value === 'string') {
            return fromString(value, typeof encodingOrOffset === 'string' ? encodingOrOffset : undefined);
        }

        if (value instanceof ArrayBuffer) {
            const ab = value;
            const offset = encodingOrOffset === undefined ? 0 : Number(encodingOrOffset);
            const len = length === undefined ? ab.byteLength - offset : length;
            return new Buffer(ab, offset, len);
        }

        if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
            const ab = value;
            const offset = encodingOrOffset === undefined ? 0 : Number(encodingOrOffset);
            const len = length === undefined ? ab.byteLength - offset : length;
            const view = new Uint8Array(ab, offset, len);
            attachBufferPrototype(view);
            return view;
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
        if (typeof value === 'object' && value !== null) {
            const type = Reflect.get(value, 'type');
            const data = Reflect.get(value, 'data');
            if (type === 'Buffer' && Array.isArray(data)) return fromArrayLike(data);
        }

        // Iterable / array-like
        const objectValue = Object(value);
        if (typeof Reflect.get(objectValue, 'length') === 'number' || Symbol.iterator in objectValue) {
            return fromArrayLike(objectValue as ArrayLike<number> | Iterable<number>);
        }

        // { valueOf() } / { [Symbol.toPrimitive]() }
        const valueOf = Reflect.get(objectValue, 'valueOf');
        const prim = typeof valueOf === 'function' ? valueOf.call(value) : undefined;
        if (prim != null && prim !== value) return Buffer.from(prim, encodingOrOffset, length);

        const toPrim = Reflect.get(objectValue, Symbol.toPrimitive);
        if (typeof toPrim === 'function') {
            const r = toPrim.call(value, 'string');
            if (typeof r === 'string') return fromString(r, typeof encodingOrOffset === 'string' ? encodingOrOffset : undefined);
        }

        throw new TypeError(
            'The first argument must be of type string or an instance of Buffer, ArrayBuffer, Array, or Array-like Object.'
        );
    }

    static copyBytesFrom(view: ArrayBufferView, offset = 0, length?: number): Buffer {
        if (!ArrayBuffer.isView(view) || !isTypedArrayView(view)) {
            throw new TypeError('The "view" argument must be an instance of TypedArray.');
        }
        const start = validateIndex(offset, 'offset');
        const count = length === undefined
            ? Math.max(0, view.length - start)
            : validateIndex(length, 'length');
        const end = Math.min(view.length, start + count);
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        return Buffer.from(bytes.subarray(start * view.BYTES_PER_ELEMENT, end * view.BYTES_PER_ELEMENT));
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
            const bytes = algorithm.bytesConcat(list);
            return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
        }
        validateIndex(totalLength, 'length', kMaxLength);

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

    static isBuffer(obj: unknown): obj is Buffer {
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
            return byteLengthOf(value, normalizeEncoding(encoding) ?? 'utf8');
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

    utf8Slice(start = 0, end: number = this.length): string {
        return this.toString('utf8', start, end);
    }

    asciiSlice(start = 0, end: number = this.length): string {
        return this.toString('ascii', start, end);
    }

    latin1Slice(start = 0, end: number = this.length): string {
        return this.toString('latin1', start, end);
    }

    binarySlice(start = 0, end: number = this.length): string {
        return this.toString('latin1', start, end);
    }

    hexSlice(start = 0, end: number = this.length): string {
        return this.toString('hex', start, end);
    }

    base64Slice(start = 0, end: number = this.length): string {
        return this.toString('base64', start, end);
    }

    ucs2Slice(start = 0, end: number = this.length): string {
        return this.toString('utf16le', start, end);
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
        return algorithm.bytesEqual(this, other);
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
        return super.subarray(start, end) as Buffer;
    }

    // ── Mutation ────────────────────────────────────────────────────────────

    fill(value: string | Uint8Array | number, offset?: unknown, end?: unknown, encoding?: Encoding): this {
        let fillEncoding: string | undefined = encoding;
        // Argument shuffling: fill(value, encoding) / fill(value, offset, encoding)
        if (typeof offset === 'string') {
            fillEncoding = offset;
            offset = 0;
            end = this.length;
        } else if (typeof end === 'string') {
            fillEncoding = end;
            end = this.length;
        }

        let start = offset === undefined ? 0 : Number(offset) | 0;
        let stop = end === undefined ? this.length : Number(end) | 0;
        if (start < 0) start = 0;
        if (stop > this.length) stop = this.length;
        if (stop <= start) return this;

        if (typeof value === 'number') {
            super.fill(value & 0xff, start, stop);
            return this;
        }

        const bytes = typeof value === 'string'
            ? stringToBytes(value, assertEncoding(fillEncoding))
            : value;

        if (bytes.length === 0) {
            super.fill(0, start, stop);
            return this;
        }
        if (bytes.length === 1) {
            super.fill(bytes[0], start, stop);
            return this;
        }
        algorithm.bytesRepeatInto(this, bytes, start, stop);
        return this;
    }

    write(string: string, offset?: unknown, length?: unknown, encoding?: Encoding): number {
        let writeEncoding: string | undefined = encoding;
        // write(string, [offset], [length], [encoding]) with overloads
        if (offset === undefined) {
            offset = 0;
            length = this.length;
            writeEncoding = 'utf8';
        } else if (typeof offset === 'string') {
            writeEncoding = offset;
            offset = 0;
            length = this.length;
        } else if (typeof length === 'string') {
            writeEncoding = length;
            length = this.length - Number(offset);
        }

        const start = Number(offset) | 0;
        const remaining = this.length - start;
        let byteLength = length === undefined ? remaining : Number(length);
        if (byteLength > remaining) byteLength = remaining;
        if (start < 0 || byteLength < 0) throw new RangeError('Offset is out of bounds');
        if (byteLength === 0) return 0;

        const e = assertEncoding(writeEncoding);
        if (e === 'utf8') {
            const bytes = engine.encodeString(string);
            const n = bytes.length <= byteLength ? bytes.length : utf8PrefixLength(bytes, byteLength);
            this.set(bytes.subarray(0, n), start);
            return n;
        }
        const bytes = stringToBytes(string, e);
        const n = Math.min(bytes.length, byteLength);
        this.set(bytes.subarray(0, n), start);
        return n;
    }

    utf8Write(string: string, offset?: number, length?: number): number {
        return this.write(string, offset, length, 'utf8');
    }

    asciiWrite(string: string, offset?: number, length?: number): number {
        return this.write(string, offset, length, 'ascii');
    }

    latin1Write(string: string, offset?: number, length?: number): number {
        return this.write(string, offset, length, 'latin1');
    }

    binaryWrite(string: string, offset?: number, length?: number): number {
        return this.write(string, offset, length, 'latin1');
    }

    hexWrite(string: string, offset?: number, length?: number): number {
        return this.write(string, offset, length, 'hex');
    }

    base64Write(string: string, offset?: number, length?: number): number {
        return this.write(string, offset, length, 'base64');
    }

    ucs2Write(string: string, offset?: number, length?: number): number {
        return this.write(string, offset, length, 'ucs2');
    }

    // ── Search ──────────────────────────────────────────────────────────────

    indexOf(value: string | number | Uint8Array, byteOffset?: number | string, encoding?: Encoding): number {
        return bidirectionalIndexOf(this, value, byteOffset, encoding, true);
    }

    lastIndexOf(value: string | number | Uint8Array, byteOffset?: number | string, encoding?: Encoding): number {
        return bidirectionalIndexOf(this, value, byteOffset, encoding, false);
    }

    includes(value: string | number | Uint8Array, byteOffset?: number | string, encoding?: Encoding): boolean {
        return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    // ── Byte-order swaps ────────────────────────────────────────────────────

    reverse(): this {
        algorithm.bytesReverse(this);
        return this;
    }

    swap16(): this {
        if (this.length % 2 !== 0) throw new RangeError('Buffer size must be a multiple of 16-bits');
        algorithm.bytesSwap16(this);
        return this;
    }

    swap32(): this {
        if (this.length % 4 !== 0) throw new RangeError('Buffer size must be a multiple of 32-bits');
        algorithm.bytesSwap32(this);
        return this;
    }

    swap64(): this {
        if (this.length % 8 !== 0) throw new RangeError('Buffer size must be a multiple of 64-bits');
        algorithm.bytesSwap64(this);
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

    // ── Uint aliases (Node 14.10+) ─────────────────────────────────────────
    declare readUint8: Buffer['readUInt8'];
    declare readUint16LE: Buffer['readUInt16LE'];
    declare readUint16BE: Buffer['readUInt16BE'];
    declare readUint32LE: Buffer['readUInt32LE'];
    declare readUint32BE: Buffer['readUInt32BE'];
    declare readUintLE: Buffer['readUIntLE'];
    declare readUintBE: Buffer['readUIntBE'];
    declare readBigUint64LE: Buffer['readBigUInt64LE'];
    declare readBigUint64BE: Buffer['readBigUInt64BE'];
    declare writeUint8: Buffer['writeUInt8'];
    declare writeUint16LE: Buffer['writeUInt16LE'];
    declare writeUint16BE: Buffer['writeUInt16BE'];
    declare writeUint32LE: Buffer['writeUInt32LE'];
    declare writeUint32BE: Buffer['writeUInt32BE'];
    declare writeUintLE: Buffer['writeUIntLE'];
    declare writeUintBE: Buffer['writeUIntBE'];
    declare writeBigUint64LE: Buffer['writeBigUInt64LE'];
    declare writeBigUint64BE: Buffer['writeBigUInt64BE'];
}

// ── Lower-case `Uint` aliases (Node 14.10+) ─────────────────────────────────

const P = Buffer.prototype;
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

function validateIndex(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number') {
        throw new TypeError(`The "${name}" argument must be of type number. Received ${typeof value}`);
    }
    if (!Number.isInteger(value)) {
        throw new RangeError(`The value of "${name}" is out of range. It must be an integer. Received ${value}`);
    }
    if (value < 0 || value > max) {
        throw new RangeError(`The value of "${name}" is out of range. It must be >= 0 && <= ${max}. Received ${value}`);
    }
    return value;
}

function fromString(string: string, encoding?: string): Buffer {
    const bytes = stringToBytes(string, assertEncoding(encoding));
    return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

function fromArrayLike(arrayLike: ArrayLike<number> | Iterable<number>): Buffer {
    const arr = Array.isArray(arrayLike) || isArrayLike(arrayLike)
        ? arrayLike
        : Array.from(arrayLike as Iterable<number>);
    const bytes = algorithm.bytesFromArrayLike(arr);
    return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

function isArrayLike(value: ArrayLike<number> | Iterable<number>): value is ArrayLike<number> {
    return typeof value === 'object' && value !== null && 'length' in value;
}

// ── Comparison / search helpers ─────────────────────────────────────────────

function compareBytes(
    a: Uint8Array, aStart: number, aEnd: number,
    b: Uint8Array, bStart: number, bEnd: number
): -1 | 0 | 1 {
    return algorithm.bytesCompare(a.subarray(aStart, aEnd), b.subarray(bStart, bEnd));
}

function bidirectionalIndexOf(
    buf: Buffer,
    value: string | number | Uint8Array,
    byteOffset: number | string | undefined,
    encoding: Encoding | undefined,
    forward: boolean
): number {
    let searchEncoding: string | undefined = encoding;
    if (typeof byteOffset === 'string') {
        searchEncoding = byteOffset;
        byteOffset = undefined;
    }

    let offset = byteOffset === undefined ? (forward ? 0 : buf.length) : +byteOffset;
    if (Number.isNaN(offset)) offset = forward ? 0 : buf.length;
    else offset = Math.trunc(offset);
    if (offset < 0) offset += buf.length;

    // Normalise the needle to a byte sequence.
    let needle: Uint8Array;
    if (typeof value === 'number') {
        const byte = value & 0xff;
        if (forward && offset >= buf.length) return -1;
        if (forward) return algorithm.bytesIndexOf(buf, byte, Math.max(offset, 0));
        const start = Math.min(offset, buf.length - 1);
        if (start < 0) return -1;
        return algorithm.bytesLastIndexOf(buf, byte, start);
    } else if (typeof value === 'string') {
        needle = stringToBytes(value, assertEncoding(searchEncoding));
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
        if (offset >= buf.length) return -1;
        return algorithm.bytesIndexOf(buf, needle, Math.max(offset, 0));
    }

    const start = Math.min(offset, buf.length - needle.length);
    if (start < 0) return -1;
    return algorithm.bytesLastIndexOf(buf, needle, start);
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
        const bytes = to === 'ascii'
            ? algorithm.asciiEncodeReplace(str)
            : algorithm.latin1EncodeReplace(str);
        return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    }
    return fromString(str, to);
}

/** True if `input` contains only valid UTF-8. */
export function isUtf8(input: ArrayBuffer | ArrayBufferView): boolean {
    return algorithm.bytesIsUtf8(toBytes(input));
}

/** True if `input` contains only 7-bit ASCII bytes. */
export function isAscii(input: ArrayBuffer | ArrayBufferView): boolean {
    return algorithm.bytesIsAscii(toBytes(input));
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
    typeof globalThis.File !== 'undefined' ? globalThis.File : undefined;

/** Deprecated alias retained for compatibility — same as `Buffer.allocUnsafeSlow`. */
export function SlowBuffer(length: number): Buffer {
    return Buffer.allocUnsafeSlow(length);
}

for (const key of [
    'from',
    'copyBytesFrom',
    'of',
    'alloc',
    'allocUnsafe',
    'allocUnsafeSlow',
    'isBuffer',
    'compare',
    'isEncoding',
    'concat',
    'byteLength',
]) {
    const desc = Object.getOwnPropertyDescriptor(Buffer, key);
    if (desc && !desc.enumerable) {
        Object.defineProperty(Buffer, key, { ...desc, enumerable: true });
    }
}

Object.defineProperty(globalThis, 'Buffer', {
    value: Buffer,
    writable: true,
    configurable: true,
    enumerable: true,
});
