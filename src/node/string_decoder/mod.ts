/**
 * Node.js string_decoder module
 * Decodes buffer data into strings preserving multi-byte characters
 */

const { Decoder } = import.meta.use('text');
const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');
import type { Buffer } from '../buffer';
import { concatChunks, utf8DecodeReplace } from '../_internal/buffer';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type ByteView = globalThis.Uint8Array<ArrayBufferLike>;
type NativeDecoder = InstanceType<typeof Decoder>;

/** Canonical encoding name, or undefined when unknown (mirrors Node's normalizeEncoding). */
function normalizeEncoding(encoding?: unknown): string | undefined {
    if (encoding === undefined || encoding === null || encoding === '') return 'utf8';
    if (typeof encoding !== 'string') return undefined;
    switch (encoding) {
        case 'utf8': case 'utf-8': return 'utf8';
        case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': return 'utf16le';
        case 'latin1': case 'binary': return 'latin1';
        case 'base64': return 'base64';
        case 'base64url': return 'base64url';
        case 'hex': return 'hex';
        case 'ascii': return 'ascii';
    }
    const low = encoding.toLowerCase();
    return low === encoding ? undefined : normalizeEncoding(low);
}

function isUtf8Encoding(encoding: string): boolean {
    return encoding === 'utf8';
}

/**
 * Lone surrogates and malformed sequences need WHATWG replacement; the shared
 * helper also fixes the native decoder's wrong error granularity. Correct here
 * because `utf8TrailingBytes` has already withheld any incomplete tail.
 */
const decodeUtf8 = utf8DecodeReplace;

function isUtf16Encoding(encoding: string): boolean {
    return encoding === 'utf16le' || encoding === 'ucs2' || encoding === 'ucs-2';
}

function createDecoder(encoding: string): NativeDecoder | null {
    if (encoding === 'hex' || encoding === 'base64' || encoding === 'base64url' ||
        encoding === 'ascii' || encoding === 'latin1' || isUtf16Encoding(encoding)) return null;
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

/**
 * How many trailing bytes form an *incomplete but still valid* UTF-8 prefix and
 * must be withheld until the next chunk. Returns 0 when the tail is complete or
 * already malformed — a broken sequence has to be reported now, not buffered,
 * or its error count collapses (Node emits one U+FFFD per invalid byte).
 */
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

        // ASCII: whatever follows is already complete.
        if ((byte & 0b1000_0000) === 0) return 0;

        // Only C2..DF, E0..EF and F0..F4 can start a sequence; C0/C1/F5..FF
        // are invalid leads that can never complete.
        const expected =
            byte >= 0xf0 && byte <= 0xf4 ? 3 :
            byte >= 0xe0 && byte <= 0xef ? 2 :
            byte >= 0xc2 && byte <= 0xdf ? 1 :
            0;
        if (expected === 0 || continuation >= expected) return 0;

        // The bytes already seen must satisfy this lead's ranges, else the
        // sequence is broken regardless of what arrives next.
        if (continuation >= 1) {
            const second = bytes[i + 1]!;
            const lower = byte === 0xe0 ? 0xa0 : byte === 0xf0 ? 0x90 : 0x80;
            const upper = byte === 0xed ? 0x9f : byte === 0xf4 ? 0x8f : 0xbf;
            if (second < lower || second > upper) return 0;
        }
        return continuation + 1;
    }

    // Scanned the whole buffer without finding a lead byte: these are stray
    // continuation bytes that can never complete, so withhold nothing and let
    // each decode to U+FFFD. (No UTF-8 sequence exceeds 4 bytes, so >3 trailing
    // continuations likewise cannot be an incomplete prefix.)
    return 0;
}

export interface StringDecoder {
    encoding: string;
    _decoder: NativeDecoder | null;
    _pending: Uint8Array | null;
    readonly lastNeed: number;
    readonly lastTotal: number;
    readonly lastChar: Uint8Array;
    write(buf: Buffer | ByteView): string;
    end(buf?: Buffer | ByteView): string;
}

interface StringDecoderConstructor {
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

export const StringDecoder: StringDecoderConstructor = function StringDecoder(this: StringDecoder | undefined, encoding?: string) {
    // Node's StringDecoder is a strict-mode function assigning to `this`, so a
    // call without `new` throws rather than silently producing an instance.
    if (this === undefined || this === null) {
        throw new TypeError("Cannot set properties of undefined (setting 'encoding')");
    }
    const target: StringDecoder = this;
    const normalized = normalizeEncoding(encoding);
    if (normalized === undefined) {
        const err = new TypeError(`Unknown encoding: ${String(encoding)}`) as TypeError & { code?: string };
        err.code = 'ERR_UNKNOWN_ENCODING';
        throw err;
    }
    target.encoding = normalized;
    // Node exposes only `encoding` as an own property; `_decoder`/`_pending` are
    // internal, so keep them off Object.keys/JSON.stringify/spread.
    Object.defineProperty(target, '_decoder', {
        value: createDecoder(normalized), writable: true, enumerable: false, configurable: true,
    });
    Object.defineProperty(target, '_pending', {
        value: null, writable: true, enumerable: false, configurable: true,
    });
    return target;
} as StringDecoderConstructor;

/** Node's `Received ...` clause for ERR_INVALID_ARG_TYPE. Verified against v24.18. */
function receivedOf(actual: unknown): string {
    if (actual === null) return 'null';
    if (actual === undefined) return 'undefined';
    const t = typeof actual;
    if (t === 'string') return `type string ('${actual as string}')`;
    if (t === 'number') return `type number (${Object.is(actual, -0) ? '-0' : String(actual)})`;
    if (t === 'bigint') return `type bigint (${String(actual)}n)`;
    if (t === 'boolean') return `type boolean (${String(actual)})`;
    if (t === 'symbol') return `type symbol (${String(actual)})`;
    if (t === 'function') return `function ${(actual as { name?: string }).name ?? ''}`;
    if (t === 'object') {
        if (Object.getPrototypeOf(actual) === null) return '[Object: null prototype] {}';
        const ctor = (actual as object).constructor;
        return `an instance of ${ctor && ctor.name ? ctor.name : 'Object'}`;
    }
    return `type ${t}`;
}

/**
 * Node accepts only strings and ArrayBuffer VIEWS here — a raw ArrayBuffer and
 * `null` both throw. `end(buf)` shares this check because Node routes any
 * non-undefined argument through `write`.
 */
function assertByteSource(buf: unknown): void {
    if (typeof buf === 'string' || ArrayBuffer.isView(buf)) return;
    const err = new TypeError(
        'The "buf" argument must be an instance of Buffer, TypedArray, or DataView. '
        + `Received ${receivedOf(buf)}`,
    ) as TypeError & { code?: string };
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
}

StringDecoder.prototype.write = function write(this: StringDecoder, buf: Buffer | ByteView): string {
    if (typeof buf === 'string') return buf;
    assertByteSource(buf);
    if (this.encoding === 'hex') {
        return crypto.hexEncode(toUint8Array(buf));
    }

    let bytes = concatBytes(this._pending, toUint8Array(buf));
    this._pending = null;

    if (this.encoding === 'base64' || this.encoding === 'base64url') {
        const remainder = bytes.byteLength % 3;
        if (remainder > 0) {
            this._pending = bytes.subarray(bytes.byteLength - remainder);
            bytes = bytes.subarray(0, bytes.byteLength - remainder);
        }
        return bytes.byteLength === 0 ? '' : base64Encode(bytes, this.encoding === 'base64url');
    }

    if (isUtf16Encoding(this.encoding)) {
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

    // ascii masks the high bit and latin1 is 1:1; both are stateless, so no
    // boundary buffering is needed and the WHATWG Decoder would wrongly
    // replace bytes >= 0x80 with U+FFFD.
    if (this.encoding === 'ascii') return algorithm.asciiDecodeLoose(bytes);
    if (this.encoding === 'latin1') return algorithm.latin1DecodeLoose(bytes);

    if (isUtf8Encoding(this.encoding)) {
        const trailing = utf8TrailingBytes(bytes);
        if (trailing > 0) {
            this._pending = bytes.subarray(bytes.byteLength - trailing);
            bytes = bytes.subarray(0, bytes.byteLength - trailing);
        }
        // Malformed bytes need WHATWG replacement; see decodeUtf8.
        return bytes.byteLength === 0 ? '' : decodeUtf8(bytes);
    }

    if (bytes.byteLength === 0) return '';
    const decoder = this._decoder;
    return decoder ? decoder.decode(bytes) : '';
};

StringDecoder.prototype.end = function end(this: StringDecoder, buf?: Buffer | ByteView): string {
    // Node routes any non-undefined argument through write's validation, so
    // null/ArrayBuffer/number all throw. A string is returned as-is but still
    // PRECEDES the flush of any held partial: end('S') is 'S\uFFFD'.
    let prefix = '';
    if (buf !== undefined) {
        assertByteSource(buf);
        if (typeof buf === 'string') { prefix = buf; buf = undefined; }
    }

    if (this.encoding === 'hex') {
        return prefix + (buf && toUint8Array(buf).byteLength > 0
            ? crypto.hexEncode(toUint8Array(buf))
            : '');
    }

    // utf8: flush what completes, then one replacement char for a held partial.
    if (isUtf8Encoding(this.encoding)) {
        const extra = buf ? toUint8Array(buf) : null;
        let text = extra && extra.byteLength > 0 ? this.write(extra) : '';
        if (this._pending) {
            text += '\uFFFD';
            this._pending = null;
        }
        return prefix + text;
    }

    let out = '';
    let bytes = this._pending;
    this._pending = null;
    if (buf && toUint8Array(buf).byteLength > 0) {
        bytes = concatBytes(bytes, toUint8Array(buf));
    }
    if (this.encoding === 'base64' || this.encoding === 'base64url') {
        return prefix + (bytes && bytes.byteLength > 0 ? base64Encode(bytes, this.encoding === 'base64url') : '');
    }
    if (isUtf16Encoding(this.encoding)) {
        return prefix + (bytes && bytes.byteLength > 0 ? decodeUtf16le(bytes) : '');
    }
    // ascii/latin1 have no native decoder (createDecoder returns null), so they
    // must decode here or `end(buf)` would silently drop every byte.
    if (this.encoding === 'ascii' || this.encoding === 'latin1') {
        if (!bytes || bytes.byteLength === 0) return prefix;
        return prefix + (this.encoding === 'ascii'
            ? algorithm.asciiDecodeLoose(bytes)
            : algorithm.latin1DecodeLoose(bytes));
    }
    if (bytes && bytes.byteLength > 0) {
        const decoder = this._decoder;
        if (decoder) out += decoder.decode(bytes, { stream: true });
    }
    out += this._decoder?.decode() ?? '';
    this._decoder = createDecoder(this.encoding);
    return prefix + out;
};

/**
 * Undocumented legacy surface Node still exposes, derived from `_pending`.
 * `lastNeed` is the bytes still missing, `lastTotal` the full sequence length;
 * both are 0 when nothing is held. Values verified against Node v24.18.
 */
function pendingNeed(target: StringDecoder): [number, number] {
    const pending = target._pending;
    if (!pending || pending.byteLength === 0) return [0, 0];
    const held = pending.byteLength;
    if (isUtf16Encoding(target.encoding)) {
        // An odd byte count means one byte of a unit is missing; an even count
        // means a held high surrogate still needs its whole low unit.
        return held % 2 === 1 ? [1, 2] : [2, 4];
    }
    if (target.encoding === 'base64' || target.encoding === 'base64url') {
        return [3 - held, 3];
    }
    const lead = pending[0] ?? 0;
    const total = (lead & 0b1111_1000) === 0b1111_0000 ? 4 :
        (lead & 0b1111_0000) === 0b1110_0000 ? 3 :
        (lead & 0b1110_0000) === 0b1100_0000 ? 2 : 0;
    return total === 0 ? [0, 0] : [total - held, total];
}

Object.defineProperties(StringDecoder.prototype, {
    lastNeed: {
        configurable: true,
        enumerable: true,
        get(this: StringDecoder) { return pendingNeed(this)[0]; },
    },
    lastTotal: {
        configurable: true,
        enumerable: true,
        get(this: StringDecoder) { return pendingNeed(this)[1]; },
    },
    lastChar: {
        configurable: true,
        enumerable: true,
        get(this: StringDecoder) {
            const out = new Uint8Array(4);
            if (this._pending) out.set(this._pending.subarray(0, 4));
            return out;
        },
    },
});

Object.defineProperty(StringDecoder.prototype, 'constructor', {
    value: StringDecoder,
    writable: true,
    configurable: true,
});

// `export type` (not `export interface`) so `export * from './mod'` cannot
// materialise these as undefined runtime exports.
export type { StringDecoderConstructor };

export default {
    StringDecoder,
};
