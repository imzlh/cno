// node:buffer polyfill for QuickJS (circu.js)
//
// Implements the Node.js 20+ `Buffer` API on top of `Uint8Array`, plus the
// module-level helpers exported by `node:buffer` (transcode, isUtf8, isAscii,
// atob/btoa, Blob/File re-exports, constants, ...).
//
// This module is registered onto the engine as `engine.__buffer` by
// `_internal/inject.ts`; `node/buffer/index.ts` re-exports from there.

// `utf8DecodeReplace` is shared with `string_decoder`, which validated it against
// Node on 2837 malformed-byte cases; keep one implementation, not two.
import { utf8DecodeReplace } from '../_internal/buffer';

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

/**
 * Render an encoding value for `ERR_UNKNOWN_ENCODING`. Node inspects the value,
 * so `null`/`42`/`true` print bare and an empty object prints `{}`. A Symbol is
 * left to coerce naturally — Node reports the plain "Cannot convert a Symbol
 * value to a string" TypeError (with no `.code`) for that case.
 */
function describeEncoding(encoding: unknown): string {
    if (encoding === null) return 'null';
    if (Array.isArray(encoding)) return encoding.length === 0 ? '[]' : `[ ${encoding.join(', ')} ]`;
    if (typeof encoding === 'object') {
        const keys = Object.keys(encoding as object);
        return keys.length === 0 ? '{}' : `{ ${keys.map((k) => `${k}: ${(encoding as Record<string, unknown>)[k]}`).join(', ')} }`;
    }
    return String(encoding);
}

function unknownEncoding(encoding: unknown): never {
    const err = new TypeError(`Unknown encoding: ${describeEncoding(encoding)}`);
    (err as { code?: string }).code = 'ERR_UNKNOWN_ENCODING';
    throw err;
}

/**
 * Strict encoding check, used by `toString`/`write`/`indexOf` & friends. Node
 * coerces the value to a string and looks that up, so a `String` wrapper around
 * a valid name is accepted while `{}` (`"[object Object]"`) is not; anything
 * unknown is `ERR_UNKNOWN_ENCODING`. `Buffer.from`/`byteLength` are deliberately
 * looser and keep using `normalizeEncoding` directly — measured against Node
 * v24.18, `Buffer.from('ab', 42)` silently encodes as utf8.
 */
function assertEncoding(encoding?: unknown): string {
    if (encoding === undefined) return 'utf8';
    if (typeof encoding === 'symbol') {
        // QuickJS's own coercion message differs from Node's, so throw Node's.
        throw new TypeError('Cannot convert a Symbol value to a string');
    }
    const coerced = `${encoding as string}`;
    // `normalizeEncoding` maps every falsy value to utf8 for the looser callers;
    // an explicit '' is an unknown encoding here.
    const e = coerced === '' ? undefined : normalizeEncoding(coerced);
    if (e === undefined) unknownEncoding(encoding);
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
    // Node stops at the first '=': "QQ==QQ==" is one byte, "=QUJD" is empty.
    // `base64DecodeLoose` instead skips '=' and keeps consuming, so a hostile
    // string decodes to more bytes here than in Node (a parser differential).
    const pad = str.indexOf('=');
    return algorithm.base64DecodeLoose(pad === -1 ? str : str.slice(0, pad));
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

/**
 * The native `engine.encodeString` emits WTF-8 for unpaired surrogates, but Node
 * (like the WHATWG encoding spec) substitutes U+FFFD.
 *
 * Both steps stay inside the regex engine — a per-character JS scan costs ~370x
 * a native encode in QuickJS. `LONE_SURROGATE` is one native pass that matches
 * only an unpaired unit (a high not followed by a low, or a low not preceded by
 * a high), so all-ASCII/BMP *and* well-formed astral text return the input
 * string untouched. `SURROGATE_SEQ` then relies on ordered alternation so a
 * valid pair is consumed as a pair and only a lone unit reaches the U+FFFD arm.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SURROGATE_SEQ = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

function sanitizeSurrogates(str: string): string {
    if (!LONE_SURROGATE.test(str)) return str;
    return str.replace(SURROGATE_SEQ, (m) => (m.length === 2 ? m : '�'));
}

function utf8Encode(str: string): Uint8Array {
    return engine.encodeString(sanitizeSurrogates(str));
}

/**
 * The decode direction of the same defect: `engine.decodeString` is
 * WTF-8-tolerant, so `Buffer.from([0xED,0xA0,0x80]).toString()` handed back a
 * lone U+D800 where Node yields three U+FFFD.
 *
 * No native primitive is correct here — the `text.Decoder` replaces per byte
 * where WHATWG replaces per *maximal subpart*, and it swallows the byte that
 * broke a sequence instead of reprocessing it. `utf8DecodeReplace` implements
 * the spec's error handling and keeps the `bytesIsUtf8` gate, so well-formed
 * UTF-8 (which cannot encode a surrogate) stays on the native fast path.
 */
function utf8Decode(bytes: Uint8Array): string {
    return utf8DecodeReplace(bytes);
}

function stringToBytes(str: string, encoding: string): Uint8Array {
    switch (encoding) {
        case 'utf8': return utf8Encode(str);
        // Node documents 'ascii' *encoding* as equivalent to latin1: it keeps the
        // low byte and does not mask to 7 bits. Measured on v24.18,
        // Buffer.from('hé','ascii') is [104,233], not [104,105].
        // Only the decode direction masks (`asciiDecodeLoose`).
        case 'ascii': return algorithm.latin1EncodeLoose(str);
        case 'latin1': return algorithm.latin1EncodeLoose(str);
        case 'utf16le': {
            const u16 = engine.encodeU16String(str);
            return new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
        }
        case 'base64': case 'base64url': return base64ToBytes(str);
        case 'hex': return hexToBytes(str);
    }
    return utf8Encode(str);
}

function bytesToString(bytes: Uint8Array, encoding: string): string {
    switch (encoding) {
        case 'utf8': return utf8Decode(bytes);
        case 'ascii': return asciiToString(bytes);
        case 'latin1': return latin1ToString(bytes);
        case 'utf16le': return utf16leToString(bytes);
        case 'base64': return bytesToBase64(bytes, false);
        case 'base64url': return bytesToBase64(bytes, true);
        case 'hex': return hexToString(bytes);
    }
    return utf8Decode(bytes);
}

function byteLengthOf(str: string, encoding: string): number {
    switch (encoding) {
        case 'utf8': return utf8Encode(str).length;
        case 'ascii': case 'latin1': return str.length;
        case 'utf16le': return str.length * 2;
        case 'hex': return str.length >>> 1;
        case 'base64': case 'base64url': return base64ByteLength(str);
    }
    return utf8Encode(str).length;
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

/** Node's `addNumericSeparator`: 1234567 -> 1_234_567. */
function addNumericSeparator(val: string): string {
    let res = '';
    let i = val.length;
    const start = val.charCodeAt(0) === 0x2d /* - */ ? 1 : 0;
    for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
    return i === val.length ? val : `${val.slice(0, i)}${res}`;
}

function formatReceived(received: unknown): string {
    if (typeof received === 'bigint') {
        let s = String(received);
        if (received > 4294967296n || received < -4294967296n) s = addNumericSeparator(s);
        return `${s}n`;
    }
    if (typeof received === 'number' && Number.isInteger(received)
        && (received > 4294967296 || received < -4294967296)) {
        return addNumericSeparator(String(received));
    }
    return String(received);
}

function outOfRange(name: string, range: string, received: unknown): never {
    const err = new RangeError(
        `The value of "${name}" is out of range. It must be ${range}. Received ${formatReceived(received)}`
    );
    (err as { code?: string }).code = 'ERR_OUT_OF_RANGE';
    throw err;
}

function bufferOutOfBounds(): never {
    const err = new RangeError('Attempt to access memory outside buffer bounds');
    (err as { code?: string }).code = 'ERR_BUFFER_OUT_OF_BOUNDS';
    throw err;
}

function receivedOf(actual: unknown): string {
    if (actual === null) return 'null';
    if (actual === undefined) return 'undefined';
    if (typeof actual === 'string') return `type string ('${actual}')`;
    if (typeof actual === 'number' || typeof actual === 'boolean' || typeof actual === 'bigint') {
        return `type ${typeof actual} (${String(actual)})`;
    }
    if (typeof actual === 'object') {
        const ctor = (actual as object).constructor;
        return `an instance of ${ctor && ctor.name ? ctor.name : 'Object'}`;
    }
    if (typeof actual === 'symbol') return `type symbol (${String(actual)})`;
    return `type ${typeof actual}`;
}

function invalidArgType(name: string, expected: string, actual: unknown): never {
    const err = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${receivedOf(actual)}`);
    (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
    throw err;
}

/** Node words a class expectation as "must be an instance of", not "of type". */
function invalidArgInstance(name: string, expected: string, actual: unknown): never {
    const err = new TypeError(`The "${name}" argument must be an instance of ${expected}. Received ${receivedOf(actual)}`);
    (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
    throw err;
}

/**
 * `fill`/`alloc` validate the encoding differently from `toString`: a non-string
 * is `ERR_INVALID_ARG_TYPE` rather than `ERR_UNKNOWN_ENCODING`, and `null` is
 * accepted as "use the default". Measured against Node v24.18.
 *
 * An empty string is also accepted here and means utf8. Node is genuinely
 * inconsistent about `''` across the family — OBSERVED on v24.18.0:
 *   toString('')  throws ERR_UNKNOWN_ENCODING     indexOf('')  throws
 *   write('')     -> utf8                         fill('')     -> utf8
 *   alloc(3,'a','') -> utf8                       from('a','') -> utf8
 * so the strict/loose split has to be per-call-site rather than one rule.
 */
function assertFillEncoding(encoding?: unknown): string {
    if (encoding === undefined || encoding === null) return 'utf8';
    if (typeof encoding !== 'string') invalidArgType('encoding', 'string', encoding);
    if (encoding === '') return 'utf8';
    return assertEncoding(encoding);
}

function boundsError(value: number, length: number, type?: string): never {
    if (Math.floor(value) !== value) {
        if (typeof value !== 'number') invalidArgType(type ?? 'offset', 'number', value);
        outOfRange(type ?? 'offset', 'an integer', value);
    }
    if (length < 0) bufferOutOfBounds();
    outOfRange(type ?? 'offset', `>= ${type ? 1 : 0} and <= ${length}`, value);
}

/**
 * Node's `checkInt`: validate `value` fits the target width, then bounds-check.
 * `byteLength` here is the *last byte index* (width - 1), matching Node.
 */
function checkInt(
    value: number | bigint, min: number | bigint, max: number | bigint,
    buf: Buffer, offset: number, byteLength: number,
): void {
    if (value > max || value < min) {
        const n = typeof min === 'bigint' ? 'n' : '';
        let range: string;
        if (byteLength > 3) {
            if (min === 0 || min === 0n) {
                range = `>= 0${n} and < 2${n} ** ${(byteLength + 1) * 8}${n}`;
            } else {
                range = `>= -(2${n} ** ${(byteLength + 1) * 8 - 1}${n}) and < 2${n} ** ${(byteLength + 1) * 8 - 1}${n}`;
            }
        } else {
            range = `>= ${min}${n} and <= ${max}${n}`;
        }
        outOfRange('value', range, value);
    }
    checkBounds(buf, offset, byteLength + 1);
}

/** Validate the 1..6 `byteLength` argument of the variable-width read/writes. */
function checkVarByteLength(byteLength: unknown): number {
    if (typeof byteLength !== 'number') invalidArgType('byteLength', 'number', byteLength);
    if (byteLength < 1 || byteLength > 6 || Math.floor(byteLength) !== byteLength) {
        boundsError(byteLength, 6, 'byteLength');
    }
    return byteLength;
}

function checkBounds(buf: Buffer, offset: number, byteLength: number): void {
    if (typeof offset !== 'number') invalidArgType('offset', 'number', offset);
    if (offset < 0 || offset + byteLength > buf.length || (offset | 0) !== offset) {
        boundsError(offset, buf.length - byteLength);
    }
}

/**
 * Node's `validateOffset`, used by `fill`/`write`/`copy`. It rejects
 * non-numbers outright rather than coercing, so an object with a hostile
 * `valueOf` can never run user JS between validation and the byte access —
 * that is what keeps a mid-call `transfer()`/`resize()` out of reach.
 */
function validateOffset(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number') invalidArgType(name, 'number', value);
    if (!Number.isInteger(value)) outOfRange(name, 'an integer', value);
    // `copy`'s targetStart has no upper bound in Node — an out-of-range start
    // just copies nothing — so an infinite max prints as a one-sided range.
    if (value < min || value > max) {
        outOfRange(name, max === Infinity ? `>= ${min}` : `>= ${min} && <= ${max}`, value);
    }
    return value;
}

/** Node's `ERR_INVALID_ARG_VALUE`: a fill value that encodes to zero bytes. */
function invalidFillValue(value: unknown): never {
    const shown = typeof value === 'string'
        ? `'${value}'`
        : Buffer.isBuffer(value) ? `<Buffer ${Array.from(value as Uint8Array).map((b) => HEX[b >> 4] + HEX[b & 15]).join(' ')}>`
        : String(value);
    const err = new TypeError(`The argument 'value' is invalid. Received ${shown}`);
    (err as { code?: string }).code = 'ERR_INVALID_ARG_VALUE';
    throw err;
}

let dvCache: WeakMap<Uint8Array, DataView> | null = null;
function viewOf(buf: Buffer): DataView {
    if (!dvCache) dvCache = new WeakMap();
    let dv = dvCache.get(buf);
    // Reading `byteLength` on a cached DataView whose resizable backing store
    // shrank throws in QuickJS, so a stale entry has to be detected defensively
    // rather than compared — Node just reads the smaller buffer successfully.
    let stale = dv === undefined;
    if (dv !== undefined) {
        try { stale = dv.byteLength !== buf.byteLength; } catch { stale = true; }
    }
    if (stale) {
        dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        dvCache.set(buf, dv);
    }
    return dv!;
}

// ── Buffer class ────────────────────────────────────────────────────────────

function attachBufferPrototype(view: Uint8Array<ArrayBufferLike>): asserts view is Buffer {
    Object.setPrototypeOf(view, Buffer.prototype);
}

export class Buffer extends Uint8Array {
    // Inherits the Uint8Array constructors:
    //   new Buffer(size) / new Buffer(arrayBuffer, byteOffset?, length?) / new Buffer(arrayLike)

    // Node v24 reports 65536. Nothing is pooled here (every allocation gets its
    // own ArrayBuffer), so this is the advertised value only — see the note on
    // `allocUnsafe`.
    static poolSize = 65536;

    // ── Allocation ──────────────────────────────────────────────────────────

    static alloc(size: number, fill?: string | Uint8Array | number, encoding?: Encoding): Buffer {
        assertSize(size);
        const buf = new Buffer(size);
        // `encoding` must land in `fill`'s encoding slot; passing it positionally
        // would be read as an offset and silently clamp the range to empty.
        if (fill !== undefined && fill !== 0) buf.fill(fill, 0, size, encoding);
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
            // Node reports its own bounds errors here; QuickJS's TypedArray
            // constructor otherwise surfaces "invalid offset"/"invalid length"
            // with no `.code`.
            if (offset < 0) throw new RangeError(`Start offset ${offset} is outside the bounds of the buffer`);
            if (offset > ab.byteLength) bufferBoundsFor('offset');
            // Omitting the length keeps the view length-tracking, so a resizable
            // ArrayBuffer that later grows or shrinks stays in bounds as in Node.
            if (length === undefined) return new Buffer(ab, offset);
            const len = Number(length);
            if (len > ab.byteLength - offset) bufferBoundsFor('length');
            return new Buffer(ab, offset, Number.isNaN(len) || len < 0 ? 0 : len);
        }

        if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
            const ab = value;
            const offset = encodingOrOffset === undefined ? 0 : Number(encodingOrOffset);
            const len = length === undefined ? undefined : Number(length);
            const view = len === undefined
                ? new Uint8Array(ab, offset)
                : new Uint8Array(ab, offset, Number.isNaN(len) || len < 0 ? 0 : len);
            attachBufferPrototype(view);
            return view;
        }

        if (ArrayBuffer.isView(value)) {
            // Uint8Array / Buffer -> copy bytes. Every other view is treated as an
            // array-like of *element values*, so Buffer.from(new Uint16Array([1,2]))
            // is [1,2] (2 bytes) and not the 4 raw memory bytes; a DataView has no
            // `length` at all and yields an empty Buffer. Matches Node v24.18.
            if (value instanceof Uint8Array) {
                const buf = new Buffer(value.length);
                buf.set(value);
                return buf;
            }
            return fromArrayLike(value as unknown as ArrayLike<number>);
        }

        if (value == null) {
            invalidFromValue(value);
        }

        // Everything from here needs an object. A non-object that reached this
        // point can only be a number/boolean/symbol/bigint/function, and Node
        // throws for all of them.
        //
        // `function` is the one that mattered: a function's `.length` is its
        // ARITY and is a number, so the array-like branch below used to accept
        // it and hand back an arity-sized zero-filled Buffer. `Buffer.from(fn)`
        // — the shape you get by forgetting `()` on a key/secret getter —
        // silently produced an all-zero Buffer instead of throwing.
        if (typeof value !== 'object') {
            invalidFromValue(value);
        }

        // { type: 'Buffer', data: [...] } — Buffer.toJSON() round-trip.
        {
            const type = Reflect.get(value, 'type');
            const data = Reflect.get(value, 'data');
            if (type === 'Buffer' && Array.isArray(data)) return fromArrayLike(data);
        }

        const objectValue = Object(value);

        // `valueOf` is consulted BEFORE the array-like `length` path, which is
        // the order Node uses (lib/buffer.js: the valueOf probe sits above
        // fromObject). Getting this backwards corrupted every boxed string:
        // `new String('ab')` has BOTH a numeric `length` and a string
        // `valueOf`, so the array-like branch won and coerced the CHARACTERS
        // to numbers — `Buffer.from(new String('ab'))` came back `0000`, and
        // `Buffer.from(new String('6162'), 'hex')` came back `06010602`
        // instead of `6162`, with no error either time.
        //
        // Node only takes the result when it is a *different* string-or-object,
        // so `{ valueOf(){ return 5 } }` (a number) and `{ valueOf(){ return
        // this } }` both fall through to the array-like path as they should.
        const valueOf = Reflect.get(objectValue, 'valueOf');
        if (typeof valueOf === 'function') {
            const prim: unknown = valueOf.call(value);
            if (prim != null && prim !== value && (typeof prim === 'string' || typeof prim === 'object')) {
                return Buffer.from(prim, encodingOrOffset, length);
            }
        }

        // Iterable / array-like
        const lengthProp = Reflect.get(objectValue, 'length');
        if (typeof lengthProp === 'number' || Symbol.iterator in objectValue) {
            return fromArrayLike(objectValue as ArrayLike<number> | Iterable<number>);
        }
        // A `length` that is not a number yields an empty Buffer in Node rather
        // than falling through to the valueOf/toPrimitive path.
        if ('length' in objectValue) return new Buffer(0);

        // { [Symbol.toPrimitive]() } — only reached when there is no usable
        // `valueOf` and no `length`, matching Node's ordering.
        const toPrim = Reflect.get(objectValue, Symbol.toPrimitive);
        if (typeof toPrim === 'function') {
            const r = toPrim.call(value, 'string');
            if (typeof r === 'string') return fromString(r, typeof encodingOrOffset === 'string' ? encodingOrOffset : undefined);
        }

        invalidFromValue(value);
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
            invalidArgInstance('list', 'Array', list);
        }
        if (list.length === 0) return new Buffer(0);

        if (totalLength === undefined) {
            let bytes: Uint8Array;
            try {
                bytes = algorithm.bytesConcat(liveList(list));
            } catch (e) {
                // The native chunk check has no index or `.code`; name the
                // offending element the way Node does. Only on the error path,
                // so the common case keeps the single native pass.
                throw concatMemberError(list, e);
            }
            return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
        }
        validateIndex(totalLength, 'length');

        const result = new Buffer(totalLength);
        let pos = 0;
        for (const b of list) {
            if (pos >= totalLength) break;
            if (!(b instanceof Uint8Array)) invalidArgInstance(`list[${list.indexOf(b)}]`, 'Buffer or Uint8Array', b);
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
        // `normalizeEncoding` maps every falsy value to utf8 for the loose
        // callers, so it cannot answer this question directly: it reported ''
        // as valid while `toString('')` and `indexOf('')` throw
        // ERR_UNKNOWN_ENCODING, which made the standard
        // `if (Buffer.isEncoding(e)) buf.toString(e)` guard throw on the very
        // input it had just approved. Node returns false for ''.
        if (encoding === '') return false;
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
        // Without this, a non-Uint8Array argument reached `subarray` and surfaced
        // as an opaque "TypeError: not a function".
        if (!(a instanceof Uint8Array)) invalidArgInstance('buf1', 'Buffer or Uint8Array', a);
        if (!(b instanceof Uint8Array)) invalidArgInstance('buf2', 'Buffer or Uint8Array', b);
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
            invalidArgInstance('otherBuffer', 'Buffer or Uint8Array', other);
        }
        if (other === this) return true;
        if (other.length !== this.length) return false;
        return algorithm.bytesEqual(liveView(this), liveView(other));
    }

    compare(
        target: Uint8Array,
        targetStart = 0, targetEnd: number = target.length,
        sourceStart = 0, sourceEnd: number = this.length
    ): -1 | 0 | 1 {
        if (!(target instanceof Uint8Array)) {
            invalidArgInstance('target', 'Buffer or Uint8Array', target);
        }
        validateOffset(targetStart, 'targetStart');
        validateOffset(sourceStart, 'sourceStart');
        if (targetEnd > target.length || sourceEnd > this.length) {
            throw new RangeError('Index out of range');
        }
        return compareBytes(this, sourceStart, sourceEnd, target, targetStart, targetEnd);
    }

    // ── Copy / slice ────────────────────────────────────────────────────────

    copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd: number = this.length): number {
        if (!(target instanceof Uint8Array)) {
            invalidArgInstance('target', 'Buffer or Uint8Array', target);
        }
        // Node truncates the indices toward zero rather than rejecting them, and
        // a NaN `sourceEnd` means "copy nothing" instead of returning NaN.
        targetStart = validateOffset(Math.trunc(targetStart) || 0, 'targetStart', 0, Infinity);
        sourceStart = validateOffset(Math.trunc(sourceStart) || 0, 'sourceStart', 0, this.length);
        sourceEnd = Math.trunc(sourceEnd) || 0;
        if (sourceEnd > this.length) sourceEnd = this.length;
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
        // Argument shuffling: fill(value, encoding) / fill(value, offset, encoding).
        // Node only reads a string in the offset slot as an encoding when `value`
        // is itself a string; `fill(1, '2')` is an ERR_INVALID_ARG_TYPE offset.
        if (typeof offset === 'string' && typeof value === 'string') {
            fillEncoding = offset;
            offset = 0;
            end = this.length;
        } else if (typeof end === 'string' && typeof value === 'string') {
            fillEncoding = end;
            end = this.length;
        }

        // Validated, never coerced — see `validateOffset`. `end` is additionally
        // bounded by the current length, matching Node.
        const start = offset === undefined ? 0 : validateOffset(offset, 'offset');
        const stop = end === undefined ? this.length : validateOffset(end, 'end', 0, this.length);
        if (stop <= start) return this;

        if (typeof value === 'string') {
            const bytes = stringToBytes(value, assertFillEncoding(fillEncoding));
            // An *empty* string means "fill with zero"; a non-empty string that
            // encodes to nothing (e.g. 'zz' as hex) is ERR_INVALID_ARG_VALUE.
            if (bytes.length === 0) {
                if (value.length === 0) {
                    super.fill(0, start, stop);
                    return this;
                }
                invalidFillValue(value);
            }
            if (bytes.length === 1) {
                super.fill(bytes[0]!, start, stop);
                return this;
            }
            algorithm.bytesRepeatInto(this, bytes, start, stop);
            return this;
        }

        if (value instanceof Uint8Array) {
            if (value.length === 0) invalidFillValue(value);
            if (value.length === 1) {
                super.fill(value[0]!, start, stop);
                return this;
            }
            algorithm.bytesRepeatInto(this, value, start, stop);
            return this;
        }

        // Everything else is coerced to a byte: null/undefined/{}/NaN -> 0,
        // true -> 1, { valueOf: () => 66 } -> 66. Node applies ToInteger then
        // masks, so 0x100 -> 0 and -1 -> 255.
        const n = Number(value);
        super.fill(Number.isNaN(n) ? 0 : n & 0xff, start, stop);
        return this;
    }

    write(string: string, offset?: unknown, length?: unknown, encoding?: Encoding): number {
        // Native `encodeString` throws this message without a `.code`; Node sets one.
        if (typeof string !== 'string') {
            const err = new TypeError('argument must be a string');
            (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
            throw err;
        }
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
            length = undefined;
        }

        // Validated, not coerced: a hostile `valueOf` cannot run here.
        const start = validateOffset(offset, 'offset', 0, this.length);
        const remaining = this.length - start;
        // Node bounds `length` by the whole buffer, then clamps the write to
        // what is left after `offset` — hence `<= 4` in its error on a 4-byte
        // buffer even when only 1 byte remains.
        let byteLength = length === undefined
            ? remaining
            : validateOffset(length, 'length', 0, this.length);
        if (byteLength > remaining) byteLength = remaining;
        if (byteLength === 0) return 0;

        // `write` is one of the loose callers: Node accepts '' here and means
        // utf8, unlike `toString`/`indexOf` which throw for it.
        const e = writeEncoding === '' ? 'utf8' : assertEncoding(writeEncoding);
        if (e === 'utf8') {
            const bytes = utf8Encode(string);
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
        if (this.length % 2 !== 0) invalidBufferSize('16-bits');
        algorithm.bytesSwap16(this);
        return this;
    }

    swap32(): this {
        if (this.length % 4 !== 0) invalidBufferSize('32-bits');
        algorithm.bytesSwap32(this);
        return this;
    }

    swap64(): this {
        if (this.length % 8 !== 0) invalidBufferSize('64-bits');
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
        checkVarByteLength(byteLength);
        checkBounds(this, offset, byteLength);
        let val = this[offset], mul = 1, i = 0;
        while (++i < byteLength && (mul *= 0x100)) val += this[offset + i] * mul;
        return val;
    }
    readUIntBE(offset: number, byteLength: number): number {
        checkVarByteLength(byteLength);
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

    writeUInt8(value: number, offset = 0): number { checkInt(+value, 0, 255, this, offset, 0); this[offset] = value; return offset + 1; }
    writeInt8(value: number, offset = 0): number { checkInt(+value, -128, 127, this, offset, 0); this[offset] = value; return offset + 1; }

    writeUInt16LE(value: number, offset = 0): number { checkInt(+value, 0, 65535, this, offset, 1); viewOf(this).setUint16(offset, value & 0xffff, true); return offset + 2; }
    writeUInt16BE(value: number, offset = 0): number { checkInt(+value, 0, 65535, this, offset, 1); viewOf(this).setUint16(offset, value & 0xffff, false); return offset + 2; }
    writeInt16LE(value: number, offset = 0): number { checkInt(+value, -32768, 32767, this, offset, 1); viewOf(this).setInt16(offset, value, true); return offset + 2; }
    writeInt16BE(value: number, offset = 0): number { checkInt(+value, -32768, 32767, this, offset, 1); viewOf(this).setInt16(offset, value, false); return offset + 2; }

    writeUInt32LE(value: number, offset = 0): number { checkInt(+value, 0, 4294967295, this, offset, 3); viewOf(this).setUint32(offset, value >>> 0, true); return offset + 4; }
    writeUInt32BE(value: number, offset = 0): number { checkInt(+value, 0, 4294967295, this, offset, 3); viewOf(this).setUint32(offset, value >>> 0, false); return offset + 4; }
    writeInt32LE(value: number, offset = 0): number { checkInt(+value, -2147483648, 2147483647, this, offset, 3); viewOf(this).setInt32(offset, value, true); return offset + 4; }
    writeInt32BE(value: number, offset = 0): number { checkInt(+value, -2147483648, 2147483647, this, offset, 3); viewOf(this).setInt32(offset, value, false); return offset + 4; }

    writeFloatLE(value: number, offset = 0): number { checkBounds(this, offset, 4); viewOf(this).setFloat32(offset, value, true); return offset + 4; }
    writeFloatBE(value: number, offset = 0): number { checkBounds(this, offset, 4); viewOf(this).setFloat32(offset, value, false); return offset + 4; }
    writeDoubleLE(value: number, offset = 0): number { checkBounds(this, offset, 8); viewOf(this).setFloat64(offset, value, true); return offset + 8; }
    writeDoubleBE(value: number, offset = 0): number { checkBounds(this, offset, 8); viewOf(this).setFloat64(offset, value, false); return offset + 8; }

    writeBigUInt64LE(value: bigint, offset = 0): number { checkInt(value, 0n, 18446744073709551615n, this, offset, 7); viewOf(this).setBigUint64(offset, value, true); return offset + 8; }
    writeBigUInt64BE(value: bigint, offset = 0): number { checkInt(value, 0n, 18446744073709551615n, this, offset, 7); viewOf(this).setBigUint64(offset, value, false); return offset + 8; }
    writeBigInt64LE(value: bigint, offset = 0): number { checkInt(value, -9223372036854775808n, 9223372036854775807n, this, offset, 7); viewOf(this).setBigInt64(offset, value, true); return offset + 8; }
    writeBigInt64BE(value: bigint, offset = 0): number { checkInt(value, -9223372036854775808n, 9223372036854775807n, this, offset, 7); viewOf(this).setBigInt64(offset, value, false); return offset + 8; }

    // ── Variable-width writes (1..6 bytes) ──────────────────────────────────

    writeUIntLE(value: number, offset: number, byteLength: number): number {
        checkVarByteLength(byteLength);
        checkInt(+value, 0, Math.pow(2, 8 * byteLength) - 1, this, offset, byteLength - 1);
        let mul = 1, i = 0;
        this[offset] = value & 0xff;
        while (++i < byteLength && (mul *= 0x100)) this[offset + i] = (value / mul) & 0xff;
        return offset + byteLength;
    }
    writeUIntBE(value: number, offset: number, byteLength: number): number {
        checkVarByteLength(byteLength);
        checkInt(+value, 0, Math.pow(2, 8 * byteLength) - 1, this, offset, byteLength - 1);
        let i = byteLength - 1, mul = 1;
        this[offset + i] = value & 0xff;
        while (--i >= 0 && (mul *= 0x100)) this[offset + i] = (value / mul) & 0xff;
        return offset + byteLength;
    }
    writeIntLE(value: number, offset: number, byteLength: number): number {
        checkVarByteLength(byteLength);
        const lim = Math.pow(2, 8 * byteLength - 1);
        checkInt(+value, -lim, lim - 1, this, offset, byteLength - 1);
        if (value < 0) value += lim * 2;
        let mul = 1, i = 0;
        this[offset] = value & 0xff;
        while (++i < byteLength && (mul *= 0x100)) this[offset + i] = (value / mul) & 0xff;
        return offset + byteLength;
    }
    writeIntBE(value: number, offset: number, byteLength: number): number {
        checkVarByteLength(byteLength);
        const lim = Math.pow(2, 8 * byteLength - 1);
        checkInt(+value, -lim, lim - 1, this, offset, byteLength - 1);
        if (value < 0) value += lim * 2;
        let i = byteLength - 1, mul = 1;
        this[offset + i] = value & 0xff;
        while (--i >= 0 && (mul *= 0x100)) this[offset + i] = (value / mul) & 0xff;
        return offset + byteLength;
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

/** Node's `ERR_INVALID_BUFFER_SIZE`, thrown by swap16/32/64. */
function invalidBufferSize(bits: string): never {
    const err = new RangeError(`Buffer size must be a multiple of ${bits}`);
    (err as { code?: string }).code = 'ERR_INVALID_BUFFER_SIZE';
    throw err;
}

/** Node's `ERR_INVALID_ARG_TYPE` for a rejected `Buffer.from` first argument. */
function invalidFromValue(value: unknown): never {
    const err = new TypeError(
        'The first argument must be of type string or an instance of Buffer, ArrayBuffer, '
        + `or Array or an Array-like Object. Received ${receivedOf(value)}`
    );
    (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
    throw err;
}

/** Node's `ERR_BUFFER_OUT_OF_BOUNDS` for the `Buffer.from(ab, offset, length)` window. */
function bufferBoundsFor(what: 'offset' | 'length'): never {
    const err = new RangeError(`"${what}" is outside of buffer bounds`);
    (err as { code?: string }).code = 'ERR_BUFFER_OUT_OF_BOUNDS';
    throw err;
}

/** Re-describe a native `bytesConcat` chunk rejection as Node's `list[i]` error. */
function concatMemberError(list: readonly Uint8Array[], fallback: unknown): unknown {
    for (let i = 0; i < list.length; i++) {
        if (!(list[i] instanceof Uint8Array)) {
            try {
                invalidArgInstance(`list[${i}]`, 'Buffer or Uint8Array', list[i]);
            } catch (e) { return e; }
        }
    }
    return fallback;
}

function assertSize(size: number): void {
    if (typeof size !== 'number') invalidArgType('size', 'number', size);
    // Node reports ERR_OUT_OF_RANGE against MAX_SAFE_INTEGER here (the
    // kMaxLength check happens later, on allocation), and NaN lands in the same
    // branch. Fractional sizes are accepted and truncated by the allocator.
    if (Number.isNaN(size) || size < 0 || size > Number.MAX_SAFE_INTEGER) {
        outOfRange('size', `>= 0 && <= ${Number.MAX_SAFE_INTEGER}`, size);
    }
}

function validateIndex(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number') invalidArgType(name, 'number', value);
    if (!Number.isInteger(value)) outOfRange(name, 'an integer', value);
    if (value < 0 || value > max) outOfRange(name, `>= 0 && <= ${max}`, value);
    return value;
}

/**
 * `Buffer.from(string, encoding)` is looser than `toString`: only a real,
 * non-empty string is validated, and anything else silently means utf8 — even a
 * `String` wrapper or a Symbol, neither of which throws here. Measured against
 * Node v24.18.
 */
function fromString(string: string, encoding?: string): Buffer {
    const e = typeof encoding === 'string' && encoding !== ''
        ? assertEncoding(encoding)
        : 'utf8';
    const bytes = stringToBytes(string, e);
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

/**
 * Native `JS_GetUint8Array` reports `ta->length` — the length captured when the
 * view was built — instead of the live length of a *length-tracking* view over a
 * resizable ArrayBuffer, and `typed_array_is_oob` deliberately returns false for
 * such views so nothing catches it (`quickjs.c` ~60093 vs ~60017).
 *
 * OBSERVED: shrinking a 4096-byte RAB to 8, then letting the freed tail be
 * reused, made `indexOf` report a byte at index 96 — a read of reclaimed heap.
 * Re-slicing rebuilds the view with current bounds, which the natives honour.
 * Only resizable/growable backings pay for the extra view.
 */
function isResizableBacked(view: Uint8Array): boolean {
    const ab = view.buffer as { resizable?: boolean; growable?: boolean };
    return ab.resizable === true || ab.growable === true;
}

function liveView(view: Uint8Array): Uint8Array {
    return isResizableBacked(view) ? view.subarray(0, view.length) : view;
}

function liveList(list: readonly Uint8Array[]): readonly Uint8Array[] {
    for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b instanceof Uint8Array && isResizableBacked(b)) {
            return list.map((x) => (x instanceof Uint8Array ? liveView(x) : x));
        }
    }
    return list;
}

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
        if (forward) return algorithm.bytesIndexOf(liveView(buf), byte, Math.max(offset, 0));
        const start = Math.min(offset, buf.length - 1);
        if (start < 0) return -1;
        return algorithm.bytesLastIndexOf(liveView(buf), byte, start);
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
        return algorithm.bytesIndexOf(liveView(buf), needle, Math.max(offset, 0));
    }

    const start = Math.min(offset, buf.length - needle.length);
    if (start < 0) return -1;
    return algorithm.bytesLastIndexOf(liveView(buf), needle, start);
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
