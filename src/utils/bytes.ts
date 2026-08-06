/**
 * Shared byte utilities.
 */

const algorithm = import.meta.use('algorithm');
const engine = import.meta.use('engine');
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const uint8Subarray = Uint8Array.prototype.subarray;
const arrayBufferSlice = ArrayBuffer.prototype.slice;

function typedArraySlot<T>(getter: ((this: unknown) => T) | undefined, bytes: globalThis.Uint8Array): T {
    if (!getter) throw new TypeError('TypedArray internal slot is unavailable');
    return Reflect.apply(getter, bytes, []);
}

function byteView(bytes: globalThis.Uint8Array): { buffer: ArrayBufferLike; byteOffset: number; byteLength: number } {
    return {
        buffer: typedArraySlot(typedArrayBufferGetter, bytes),
        byteOffset: typedArraySlot(typedArrayByteOffsetGetter, bytes),
        byteLength: typedArraySlot(typedArrayByteLengthGetter, bytes),
    };
}

function subarray(bytes: globalThis.Uint8Array, start: number, end?: number): globalThis.Uint8Array {
    return Reflect.apply(uint8Subarray, bytes, end === undefined ? [start] : [start, end]);
}

export function toOwnedBytes(bytes: globalThis.Uint8Array): globalThis.Uint8Array<ArrayBuffer> {
    const { byteLength } = byteView(bytes);
    const buffer = new ArrayBuffer(byteLength);
    const out = new globalThis.Uint8Array(buffer);
    out.set(bytes);
    return out;
}

export function arrayBufferBackedBytes(bytes: globalThis.Uint8Array): globalThis.Uint8Array<ArrayBuffer> {
    const { buffer, byteOffset, byteLength } = byteView(bytes);
    if (engine.isArrayBuffer(buffer)) {
        return new globalThis.Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength);
    }
    return toOwnedBytes(bytes);
}

export function concatChunks(chunks: globalThis.Uint8Array[]): globalThis.Uint8Array<ArrayBuffer> {
    return toOwnedBytes(algorithm.bytesConcat(chunks));
}

export function bytesToArrayBuffer(bytes: globalThis.Uint8Array, requestedLength?: number): ArrayBuffer {
    const { buffer, byteOffset, byteLength } = byteView(bytes);
    const length = requestedLength ?? byteLength;
    if (engine.isArrayBuffer(buffer)) {
        return Reflect.apply(arrayBufferSlice, buffer, [byteOffset, byteOffset + length]);
    }
    return toOwnedBytes(subarray(bytes, 0, length)).buffer;
}

/**
 * `engine.encodeString` emits WTF-8 for unpaired surrogates; the encoding spec
 * substitutes U+FFFD. Both regexes stay native: `LONE_SURROGATE` is one pass
 * that only matches an unpaired unit, so ASCII/BMP and well-formed astral text
 * return untouched, and `SURROGATE_SEQ` consumes valid pairs first.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SURROGATE_SEQ = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

export function sanitizeSurrogates(str: string): string {
    if (!LONE_SURROGATE.test(str)) return str;
    return str.replace(SURROGATE_SEQ, (m) => (m.length === 2 ? m : '�'));
}

/** WHATWG UTF-8 sequence shape: length plus the tighter bound on the 2nd byte. */
function utf8SeqInfo(lead: number): { len: number; lo: number; hi: number } {
    if (lead >= 0xc2 && lead <= 0xdf) return { len: 2, lo: 0x80, hi: 0xbf };
    if (lead >= 0xe0 && lead <= 0xef) return { len: 3, lo: lead === 0xe0 ? 0xa0 : 0x80, hi: lead === 0xed ? 0x9f : 0xbf };
    if (lead >= 0xf0 && lead <= 0xf4) return { len: 4, lo: lead === 0xf0 ? 0x90 : 0x80, hi: lead === 0xf4 ? 0x8f : 0xbf };
    return { len: 0, lo: 0, hi: 0 };   // 0x80..0xC1 stray/overlong lead, 0xF5..0xFF
}

/**
 * WHATWG "UTF-8 decode": one U+FFFD per **maximal subpart**, then the byte that
 * broke the sequence is *reprocessed*. `engine.decodeString` is WTF-8-tolerant
 * (it hands back lone surrogates) and the native `text.Decoder` replaces per
 * byte and swallows the breaking byte, so neither matches on malformed input.
 *
 * `bytesIsUtf8` is a native validity gate cheaper than the decode, so valid
 * input — the hot path — is one native call and the JS loop only ever walks
 * malformed regions.
 */
export function utf8Decode(bytes: globalThis.Uint8Array, fatal = false): string {
    if (algorithm.bytesIsUtf8(bytes)) return engine.decodeString(bytes);
    if (fatal) throw new TypeError('The encoded data was not valid for encoding utf-8');
    return utf8DecodeSlow(bytes);
}

function utf8DecodeSlow(bytes: globalThis.Uint8Array): string {
    const n = byteView(bytes).byteLength;
    let out = '';
    let runStart = 0;   // start of the pending all-valid run, decoded in one native call
    let i = 0;

    while (i < n) {
        const blockEnd = i + 8192 <= n ? i + 8192 : n;
        if (blockEnd - i > 1) {
            if (algorithm.bytesIsUtf8(subarray(bytes, i, blockEnd))) { i = blockEnd; continue; }
            // A failed check may only mean `blockEnd` split a sequence; retry aligned.
            let e = blockEnd, back = 0;
            while (back < 3 && e > i && (bytes[e]! & 0xc0) === 0x80) { e--; back++; }
            if (e > i && e < blockEnd && algorithm.bytesIsUtf8(subarray(bytes, i, e))) { i = e; continue; }
        }

        while (i < blockEnd) {
            const b = bytes[i]!;
            if (b <= 0x7f) { i++; continue; }
            const { len, lo, hi } = utf8SeqInfo(b);

            let k = 1;
            if (len !== 0) {
                for (; k < len; k++) {
                    if (i + k >= n) break;                  // truncated at end of buffer
                    const c = bytes[i + k]!;
                    if (k === 1 ? (c < lo || c > hi) : (c < 0x80 || c > 0xbf)) break;
                }
                if (k === len) { i += len; continue; }       // whole sequence is valid
            }

            if (i > runStart) out += engine.decodeString(subarray(bytes, runStart, i));
            out += '�';
            i += k;         // consume the lead plus the accepted continuations only
            runStart = i;
            break;          // one error handled; let the native fast-forward resume
        }
    }

    if (n > runStart) out += engine.decodeString(subarray(bytes, runStart, n));
    return out;
}

/**
 * Length of the trailing bytes that are a *valid prefix* of an unfinished
 * sequence, i.e. the ones a streaming decode must hold back for the next chunk.
 * A tail that is already invalid is not held back — it must error now.
 */
export function utf8PendingTail(bytes: globalThis.Uint8Array): number {
    const n = byteView(bytes).byteLength;
    for (let back = 1; back <= 3 && back <= n; back++) {
        const lead = bytes[n - back]!;
        if (lead <= 0x7f || (lead & 0xc0) === 0x80) continue;   // ASCII or continuation
        const { len, lo, hi } = utf8SeqInfo(lead);
        if (len === 0 || len <= back) return 0;                 // invalid lead, or complete
        for (let k = 1; k < back; k++) {
            const c = bytes[n - back + k]!;
            if (k === 1 ? (c < lo || c > hi) : (c < 0x80 || c > 0xbf)) return 0;
        }
        return back;
    }
    return 0;
}

/** windows-1252: latin1 plus the 0x80–0x9F window. Native CP1252 leaves the five
 *  WHATWG-mapped C1 holes (0x81/8D/8F/90/9D) as U+FFFD, so decode it here. */
const CP1252_HIGH =
    '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021'
    + '\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
    + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014'
    + '\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

const MAC_CYRILLIC_HIGH =
    '\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417'
    + '\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f'
    + '\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427'
    + '\u0428\u0429\u042a\u042b\u042c\u042d\u042e\u042f'
    + '\u2020\u00b0\u0490\u00a3\u00a7\u2022\u00b6\u0406'
    + '\u00ae\u00a9\u2122\u0402\u0452\u2260\u0403\u0453'
    + '\u221e\u00b1\u2264\u2265\u0456\u00b5\u0491\u0408'
    + '\u0404\u0454\u0407\u0457\u0409\u0459\u040a\u045a'
    + '\u0458\u0405\u00ac\u221a\u0192\u2248\u2206\u00ab'
    + '\u00bb\u2026\u00a0\u040b\u045b\u040c\u045c\u0455'
    + '\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u201e'
    + '\u040e\u045e\u040f\u045f\u2116\u0401\u0451\u044f'
    + '\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437'
    + '\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f'
    + '\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447'
    + '\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u20ac';

export type SingleByteEncoding = 'windows-1252' | 'x-user-defined' | 'x-mac-cyrillic';

export function decodeSingleByte(bytes: globalThis.Uint8Array, encoding: SingleByteEncoding): string {
    const latin1 = algorithm.latin1DecodeLoose(bytes);
    if (encoding === 'x-user-defined') {
        return latin1.replace(/[\u0080-\u00ff]/g, (c) => String.fromCharCode(0xf700 + c.charCodeAt(0)));
    }
    const high = encoding === 'windows-1252' ? CP1252_HIGH : MAC_CYRILLIC_HIGH;
    const range = encoding === 'windows-1252' ? /[\u0080-\u009f]/g : /[\u0080-\u00ff]/g;
    return latin1.replace(range, (c) => high[c.charCodeAt(0) - 0x80]!);
}
