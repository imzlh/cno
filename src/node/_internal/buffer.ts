/**
 * Shared buffer utilities for Node.js polyfill modules.
 * Consolidates duplicate concatChunks implementations.
 */

const algorithm = import.meta.use('algorithm');

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

const engine = import.meta.use('engine');

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
    if (algorithm.bytesIsUtf8(bytes)) return engine.decodeString(bytes);

    const out: string[] = [];
    let codepoint = 0;
    let needed = 0;
    let seen = 0;
    let lower = 0x80;
    let upper = 0xbf;

    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i]!;
        if (needed === 0) {
            if (byte <= 0x7f) {
                out.push(String.fromCharCode(byte));
            } else if (byte >= 0xc2 && byte <= 0xdf) {
                needed = 1;
                codepoint = byte & 0x1f;
            } else if (byte >= 0xe0 && byte <= 0xef) {
                if (byte === 0xe0) lower = 0xa0;
                else if (byte === 0xed) upper = 0x9f;
                needed = 2;
                codepoint = byte & 0x0f;
            } else if (byte >= 0xf0 && byte <= 0xf4) {
                if (byte === 0xf0) lower = 0x90;
                else if (byte === 0xf4) upper = 0x8f;
                needed = 3;
                codepoint = byte & 0x07;
            } else {
                out.push('�');
            }
            continue;
        }
        if (byte < lower || byte > upper) {
            // One replacement char for the maximal subpart, then reprocess
            // this byte as a fresh sequence start.
            codepoint = 0;
            needed = 0;
            seen = 0;
            lower = 0x80;
            upper = 0xbf;
            out.push('�');
            i--;
            continue;
        }
        lower = 0x80;
        upper = 0xbf;
        codepoint = (codepoint << 6) | (byte & 0x3f);
        if (++seen === needed) {
            out.push(String.fromCodePoint(codepoint));
            codepoint = 0;
            needed = 0;
            seen = 0;
        }
    }
    // A sequence still open at the end of input is an error.
    if (needed !== 0) out.push('�');
    return out.join('');
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
