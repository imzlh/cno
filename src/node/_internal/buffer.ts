/**
 * Shared buffer utilities for Node.js polyfill modules.
 * Consolidates duplicate concatChunks implementations.
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
 * WHATWG UTF-8 decode with U+FFFD replacement.
 *
 * `engine.decodeString` is WTF-8-tolerant (it leaks lone surrogates), and the
 * native `text` Decoder gets the *error granularity* wrong in both directions:
 * a truncated 4-byte lead swallows the following byte (`F1 41` → one U+FFFD,
 * dropping the 'A'), while `F1 80 80 41` emits three U+FFFD where the spec's
 * maximal-subpart rule requires one. So malformed input is decoded here.
 *
 * `bytesIsUtf8` gates this: well-formed UTF-8 (which cannot encode a surrogate)
 * keeps the fast native path, and only genuinely malformed bytes pay for the
 * per-byte scan.
 */
export function utf8DecodeReplace(bytes: Uint8Array): string {
    if (algorithm.bytesIsUtf8(bytes)) return engineDecode(bytes);
    return replaceMalformed(bytes);
}

/**
 * `engine.decodeString` returns a bare `0` when it cannot allocate its result.
 * Exposing that as `undefined` made a failed decode look like an empty string
 * to callers; throw the error Node's own `'buffer'.toString` would.
 */
function engineDecode(bytes: Uint8Array): string {
    const out = engine.decodeString(bytes);
    if (typeof out !== 'string') throw withCode(new RangeError('Invalid string length'), 'ERR_STRING_TOO_LONG');
    return out;
}

// The old decoder handled EVERY byte in JS and pushed one string per byte, so
// one malformed sequence cost ~10ms more for every byte after it (9.7s on 1MB
// of "A" + 0xE9, 750k bytes in 15625 runs). Segments fix the part that was
// quadratic in the input: a well-formed run is one native decode, and only the
// maximal invalid subpart at a fault is written out here. The fault SCAN is
// still linear in the text between faults (a JS step is ~3us however it is
// done -- a byte read or a one-position regex alike), so the bill is roughly
// "3us per well-formed sequence between faults + 12us per fault" instead of
// "11us per byte".
//
// A stray continuation byte and a truncated tail are one U+FFFD. A lead with
// one or more valid continuations is maximal over (lead, second): the valid
// scalars keep their native decoding, and the lead and the byte that ended the
// sequence are each a U+FFFD -- the same shape Node builds.
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
            // A valid lead swallows its continuation bytes into ONE U+FFFD:
            // `e4 bd` is one replacement. A UTF-16 surrogate encoding (`ed a0`)
            // is structurally invalid, so Node replaces those bytes one by one.
            const need = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
            if (lead === 0xed && at + 1 < bytes.length && bytes[at + 1] >= 0xa0) {
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
 * `from`, or -1.
 *
 * One JS step is ~3us per position here, so this is the minimal byte-wise
 * scan: only called once `bytesIsUtf8` has proved the input is not all ASCII,
 * it stops at the first stray continuation byte or overlong lead instead of
 * validating further, and skips over each valid multi-byte sequence.
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
 * and `base64`, so U+3C3D behaves as '=' (a terminator) and U+0644 as 'D' (a
 * valid digit). Measured against node v24.18.0: decoding a string directly and
 * decoding its masked form agree on 986470 injected-codepoint cases with zero
 * divergence, so masking *is* the rule rather than an approximation.
 *
 * Without this, `Buffer.from('SGVs\ud83dbG8=', 'base64')` returned 5 bytes here
 * against Node's 3 — a silent length divergence, no throw on either side.
 *
 * Both steps stay in native code. latin1 *encoding* keeps the low byte (the same
 * property `stringToBytes` relies on for 'ascii'/'latin1'), so an encode->decode
 * round trip IS the mask — verified against a per-character loop on all 65536
 * code units in both runtimes, 0 mismatches.
 *
 * That matters for more than tidiness: a per-character JS scan costs ~3.4us per
 * character in QuickJS, so masking a 4KB input in JS measured 23-25ms against
 * 0.49ms for the untouched path. One non-ASCII character would have bought a 48x
 * slowdown on every decode — a DoS shape, not a cost. The native round trip is
 * 136us, cheaper than the base64 decode it precedes.
 */
const NON_LATIN1 = /[^\u0000-\u00FF]/;

export function narrowToLatin1(str: string): string {
    if (!NON_LATIN1.test(str)) return str;
    return algorithm.latin1DecodeLoose(algorithm.latin1EncodeLoose(str));
}

/**
 * `hex`/`base64` string -> bytes with Node's semantics. Every Node surface that
 * accepts an encoding name for a string input must route through these rather
 * than calling `algorithm.*DecodeLoose` directly: the native decoders are
 * deliberately looser than Node on both the code-unit width and the padding
 * rule, so a direct call is a parser differential against Node.
 */
export function hexToBytes(str: string): Uint8Array {
    return algorithm.hexDecodeLoose(narrowToLatin1(str));
}

export function base64ToBytes(str: string): Uint8Array {
    // Node stops at the first '=': "QQ==QQ==" is one byte, "=QUJD" is empty.
    // `base64DecodeLoose` instead skips '=' and keeps consuming, so a hostile
    // string decodes to more bytes here than in Node (a parser differential).
    // The narrowing must happen *first* so a masked '=' terminates too.
    const narrowed = narrowToLatin1(str);
    const pad = narrowed.indexOf('=');
    return algorithm.base64DecodeLoose(pad === -1 ? narrowed : narrowed.slice(0, pad));
}
