/**
 * Shared buffer utilities for Node.js polyfill modules.
 */

import { withCode } from './errors';

const algorithm = import.meta.use('algorithm');
const engine = import.meta.use('engine');

export function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    const out = new Uint8Array(buffer);
    out.set(bytes);
    return out;
}

export function arrayBufferBackedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (bytes.buffer instanceof ArrayBuffer) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return toOwnedBytes(bytes);
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
    return arrayBufferBackedBytes(algorithm.bytesConcat(chunks));
}

export function describeEncoding(encoding: unknown): string {
    if (encoding === null) return 'null';
    if (Array.isArray(encoding)) return encoding.length === 0 ? '[]' : `[ ${encoding.join(', ')} ]`;
    if (typeof encoding === 'object') {
        const keys = Object.keys(encoding as object);
        return keys.length === 0
            ? '{}'
            : `{ ${keys.map((key) => `${key}: ${(encoding as Record<string, unknown>)[key]}`).join(', ')} }`;
    }
    return String(encoding);
}

export function viewToUint8Array(view: ArrayBufferView): Uint8Array<ArrayBuffer> {
    if (view.buffer instanceof ArrayBuffer) return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}


/**
 * WHATWG UTF-8 decode with U+FFFD replacement. `engine.decodeString` leaks lone
 * surrogates and the native `text` decoder gets error granularity wrong, so
 * only well-formed input (gated by `bytesIsUtf8`) takes the native fast path.
 */
export function utf8DecodeReplace(bytes: Uint8Array): string {
    if (algorithm.bytesIsUtf8(bytes)) return engineDecode(bytes);
    return replaceMalformed(bytes);
}

/**
 * `engine.decodeString` returns a bare `0` when it cannot allocate.
 */
function engineDecode(bytes: Uint8Array): string {
    const out = engine.decodeString(bytes);
    if (typeof out !== 'string') throw withCode(new RangeError('Invalid string length'), 'ERR_STRING_TOO_LONG');
    return out;
}

// Decode well-formed runs natively and write out only the maximal invalid
// subpart at each fault. A stray continuation byte or a truncated tail is one
// U+FFFD; a valid lead swallows its valid continuations into one, except a
// surrogate encoding (`ed a0`), whose bytes Node replaces one by one.
function replaceMalformed(bytes: Uint8Array): string {
    let out = '';
    let start = 0;
    let at = -1;
    for (;;) {
        at = nextFault(bytes, start);
        if (at < 0) break;
        if (at > start) out += engineDecode(bytes.subarray(start, at));
        const lead = bytes[at];
        if (lead >= 0xc2 && lead <= 0xf4) {
            // A valid lead swallows its continuation bytes into ONE U+FFFD
            // (`e4 bd` is one replacement); a UTF-16 surrogate encoding is
            // structurally invalid, so Node replaces those bytes one by one.
            const need = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
            if (lead === 0xed && at + 1 < bytes.length && bytes[at + 1] >= 0xa0) {
                out += '�';
                start = at + 1;
                continue;
            }
            // `f4 90`.. is above U+10FFFF; it is not a 4-byte prefix at all.
            if (lead === 0xf4 && at + 1 < bytes.length && bytes[at + 1] > 0x8f) {
                out += '�';
                start = at + 1;
                continue;
            }
            let consumed = 0;
            while (consumed < need && at + 1 + consumed < bytes.length) {
                const next = bytes[at + 1 + consumed];
                if (next < 0x80 || next > 0xbf) break;
                consumed++;
            }
            out += '�';
            start = at + consumed + 1;
        } else {
            out += '�';
            start = at + 1;
        }
    }
    if (start < bytes.length) out += engineDecode(bytes.subarray(start));
    return out;
}

/**
 * Offset of the first byte that begins an ill-formed sequence at or after
 * `from`, or -1. Only called on input `bytesIsUtf8` rejected; stops at the
 * first fault and skips valid multi-byte sequences (a JS step is ~3us, so the
 * scan must stay per-sequence, not per-byte).
 */
function nextFault(bytes: Uint8Array, from: number): number {
    let at = firstNonAscii(bytes, from);
    const len = bytes.length;
    while (at >= 0) {
        const lead = bytes[at];
        if (lead < 0xc2) return at;
        const need = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : lead < 0xf5 ? 3 : -1;
        if (need < 0 || at + need >= len) return at;
        const p1 = bytes[at + 1];
        const lo = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
        const hi = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
        if (p1 < lo || p1 > hi) return at;
        const p2 = need > 1 ? bytes[at + 2] : 0;
        const p3 = need > 2 ? bytes[at + 3] : 0;
        if (need > 1 && (p2 < 0x80 || p2 > 0xbf)) return at;
        if (need > 2 && (p3 < 0x80 || p3 > 0xbf)) return at;
        at = firstNonAscii(bytes, at + need + 1);
    }
    return -1;
}

function firstNonAscii(bytes: Uint8Array, from: number): number {
    for (let i = from; i < bytes.length; i++) {
        const c = bytes[i];
        if (c >= 0x80) return i;
    }
    return -1;
}


/**
 * Node narrows every UTF-16 code unit to its low 8 bits before decoding `hex`
 * and `base64`, so U+3C3D behaves as '=' and U+0644 as 'D'. A latin1
 * encode->decode round trip is that mask, done natively; a JS per-character
 * scan would cost ~3.4us each (a DoS shape on large inputs).
 */
const NON_LATIN1 = /[^\u0000-\u00FF]/;

export function narrowToLatin1(str: string): string {
    if (!NON_LATIN1.test(str)) return str;
    return algorithm.latin1DecodeLoose(algorithm.latin1EncodeLoose(str));
}

/**
 * `hex`/`base64` string -> bytes with Node's semantics. Every Node surface that
 * takes an encoding name for a string input must route through these, not
 * `algorithm.*DecodeLoose` directly: the native decoders are looser than Node
 * on code-unit width and padding, so a direct call is a parser differential.
 */
export function hexToBytes(str: string): Uint8Array {
    return algorithm.hexDecodeLoose(narrowToLatin1(str));
}

export function base64ToBytes(str: string): Uint8Array {
    // Node stops at the first '=': "QQ==QQ==" is one byte, "=QUJD" is empty.
    // `base64DecodeLoose` skips '=' and keeps consuming, so cut here first;
    // after narrowing, a masked '=' terminates too.
    const narrowed = narrowToLatin1(str);
    const pad = narrowed.indexOf('=');
    return algorithm.base64DecodeLoose(pad === -1 ? narrowed : narrowed.slice(0, pad));
}
