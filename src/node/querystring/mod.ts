/**
 * Node.js querystring module
 * URL query string parsing and stringifying
 *
 * Ported from Node's lib/querystring.js. parse() is a single-pass state machine
 * rather than a split()-based reimplementation, because Node's separator and
 * equals matching is order-dependent in ways split() cannot express (see the
 * sepIdx/eqIdx note inside parse()).
 */

import { Buffer } from '../buffer';

// unhexTable[c] is the value of hex digit c, or -1. isHexTable[c] is 1 for
// [0-9A-Fa-f]. Node ships these as literal typed arrays; building them once at
// load is equivalent and less error-prone than transcribing 256 entries.
const unhexTable = new Int8Array(256).fill(-1);
const isHexTable = new Int8Array(256);
for (let i = 0; i < 10; i++) { unhexTable[48 + i] = i; isHexTable[48 + i] = 1; }
for (let i = 0; i < 6; i++) {
    unhexTable[65 + i] = 10 + i; isHexTable[65 + i] = 1; // A-F
    unhexTable[97 + i] = 10 + i; isHexTable[97 + i] = 1; // a-f
}

// Node's unescapeBuffer writes every UTF-16 code unit into a byte buffer, so
// each unit is TRUNCATED to its low 8 bits (`out[outIndex++] = currentChar`).
// A literal U+4E2D becomes the single byte 0x2D, and that truncated byte joins
// the same stream as the percent-decoded bytes before one UTF-8 decode. Hence
// Node's unescape('%zz中') === '%zz-'.
export function unescapeBuffer(str: string, decodeSpaces = false): Buffer {
    const input = typeof str === 'string' ? str : String(str);
    const out = Buffer.allocUnsafe(input.length);
    let index = 0;
    let outIndex = 0;
    let currentChar: number;
    let nextChar: number;
    let hexHigh: number;
    let hexLow: number;
    const maxLength = input.length - 2;
    let hasHex = false;

    while (index < input.length) {
        currentChar = input.charCodeAt(index);
        if (currentChar === 43 /* + */ && decodeSpaces) {
            out[outIndex++] = 32; // ' '
            index++;
            continue;
        }
        if (currentChar === 37 /* % */ && index < maxLength) {
            currentChar = input.charCodeAt(++index);
            hexHigh = unhexTable[currentChar]!;
            if (!(hexHigh >= 0)) {
                out[outIndex++] = 37; // '%'
                continue;
            } else {
                nextChar = input.charCodeAt(++index);
                hexLow = unhexTable[nextChar]!;
                if (!(hexLow >= 0)) {
                    out[outIndex++] = 37; // '%'
                    index--;
                } else {
                    hasHex = true;
                    currentChar = hexHigh * 16 + hexLow;
                }
            }
        }
        out[outIndex++] = currentChar;
        index++;
    }

    return hasHex ? out.subarray(0, outIndex) : out;
}

// Node's qsUnescape. It does NOT map `+` to a space unless decodeSpaces is set
// AND decodeURIComponent threw; only parse() rewrites `+` up front.
function qsUnescape(str: string, decodeSpaces?: boolean): string {
    const input = typeof str === 'string' ? str : String(str);
    try {
        return decodeURIComponent(input);
    } catch {
        return unescapeBuffer(input, decodeSpaces).toString();
    }
}

// Node qsEscape: encodeURIComponent alphabet, leave !'()*~ unescaped (RFC 2396).
const QS_UNESCAPED = /[A-Za-z0-9\-_.!~*'()]/;

const hex = (byte: number): string => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;

function invalidUri(): URIError & { code: string } {
    return Object.assign(new URIError('URI malformed'), { code: 'ERR_INVALID_URI' });
}

function qsEscape(str: string): string {
    let input: string;
    if (typeof str === 'string') input = str;
    else if (typeof str === 'object' && str !== null) input = String(str);
    // Mirrors Node's `str += ''`, which throws for a Symbol.
    else input = `${str as string}`;

    let out = '';
    // Node walks UTF-16 code units: any unit in D800..DFFF is taken as a pair
    // lead, so a trailing lone surrogate throws while a mid-string one is
    // blindly combined with the next unit.
    for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        if (c < 0x80) {
            out += QS_UNESCAPED.test(input[i]!) ? input[i] : hex(c);
            continue;
        }
        if (c < 0x800) {
            out += hex(0xC0 | (c >> 6)) + hex(0x80 | (c & 0x3F));
            continue;
        }
        if (c < 0xD800 || c >= 0xE000) {
            out += hex(0xE0 | (c >> 12)) + hex(0x80 | ((c >> 6) & 0x3F)) + hex(0x80 | (c & 0x3F));
            continue;
        }
        i++;
        if (i >= input.length) throw invalidUri();
        const cp = 0x10000 + (((c & 0x3FF) << 10) | (input.charCodeAt(i) & 0x3FF));
        out += hex(0xF0 | (cp >> 18)) + hex(0x80 | ((cp >> 12) & 0x3F))
            + hex(0x80 | ((cp >> 6) & 0x3F)) + hex(0x80 | (cp & 0x3F));
    }
    return out;
}

function stringifyPrimitive(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string') return String(value);
    return '';
}

function stringify(
    obj: Record<string, unknown>,
    sep?: string,
    eq?: string,
    options?: { encodeURIComponent?: (s: string) => string },
): string {
    // Node checks `typeof obj === 'object'` only, so a function yields ''.
    if (obj === null || typeof obj !== 'object') return '';
    const sepStr = sep ? String(sep) : '&';
    const eqStr = eq ? String(eq) : '=';

    // A non-function encodeURIComponent option is ignored, not called.
    const encode = typeof options?.encodeURIComponent === 'function'
        ? options.encodeURIComponent
        : qsEscape;
    const pairs: string[] = [];
    for (const [key, val] of Object.entries(obj)) {
        if (Array.isArray(val)) {
            for (const v of val) {
                pairs.push(`${encode(key)}${eqStr}${encode(stringifyPrimitive(v))}`);
            }
        } else {
            pairs.push(`${encode(key)}${eqStr}${encode(stringifyPrimitive(val))}`);
        }
    }
    return pairs.join(sepStr);
}

function charCodes(str: string): number[] {
    const ret = new Array<number>(str.length);
    for (let i = 0; i < str.length; i++) ret[i] = str.charCodeAt(i);
    return ret;
}

const defSepCodes = [38]; // &
const defEqCodes = [61]; // =

function decodeStr(s: string, decoder: (s: string) => string): string {
    try {
        return decoder(s);
    } catch {
        return qsUnescape(s, true);
    }
}

type ParsedQuery = Record<string, string | string[]>;

function addKeyVal(
    obj: ParsedQuery,
    key: string,
    value: string,
    keyEncoded: boolean,
    valEncoded: boolean,
    decode: (s: string) => string,
): void {
    // The *Encoded flags gate decoding: Node only calls the decoder once it has
    // seen a plausible %XX (or a custom decoder is in use). Decoding
    // unconditionally is observably different — 'a+中%zz' holds no valid escape,
    // so Node leaves the literal char alone instead of byte-truncating it.
    if (key.length > 0 && keyEncoded) key = decodeStr(key, decode);
    if (value.length > 0 && valEncoded) value = decodeStr(value, decode);

    const curValue = obj[key];
    if (curValue === undefined) {
        obj[key] = value;
    } else if (Array.isArray(curValue)) {
        curValue[curValue.length] = value;
    } else {
        obj[key] = [curValue, value];
    }
}

// Parameters are declared optional rather than defaulted so the emitted arity
// matches Node's (parse.length === 4); `?` is type-only and erases.
function parse(
    qs: string,
    sep?: string,
    eq?: string,
    options?: { maxKeys?: number; decodeURIComponent?: (s: string) => string },
): ParsedQuery {
    const obj: ParsedQuery = Object.create(null);

    if (typeof qs !== 'string' || qs.length === 0) return obj;

    const sepCodes = !sep ? defSepCodes : charCodes(String(sep));
    const eqCodes = !eq ? defEqCodes : charCodes(String(eq));
    const sepLen = sepCodes.length;
    const eqLen = eqCodes.length;

    // -1 stands in for "unlimited". A non-integer maxKeys never reaches 0, so it
    // is also effectively unlimited, and an empty pair still spends budget.
    let pairs = 1000;
    if (options && typeof options.maxKeys === 'number') {
        pairs = options.maxKeys > 0 ? options.maxKeys : -1;
    }

    let decode: (s: string) => string = qsUnescape;
    if (options && typeof options.decodeURIComponent === 'function') {
        decode = options.decodeURIComponent;
    }
    const customDecode = decode !== qsUnescape;

    let lastPos = 0;
    let sepIdx = 0;
    let eqIdx = 0;
    let key = '';
    let value = '';
    let keyEncoded = customDecode;
    let valEncoded = customDecode;
    // A custom decoder is handed '%20'; the built-in one gets a real space. That
    // is why a custom decodeURIComponent sees 'a%20b' for input 'a+b'.
    const plusChar = customDecode ? '%20' : ' ';
    let encodeCheck = 0;

    for (let i = 0; i < qs.length; i++) {
        const code = qs.charCodeAt(i);

        // Separator matching wins: because the eq test lives in the else branch,
        // a char that advances the sep prefix is NEVER tested as eq. With
        // sep='ab', eq='a', the 'a' in 'k%ad' starts a sep match and so never
        // splits the pair — split()+indexOf() cannot reproduce that.
        if (code === sepCodes[sepIdx]) {
            if (++sepIdx === sepLen) {
                const end = i - sepIdx + 1;
                if (eqIdx < eqLen) {
                    // Never matched the whole eq: this text is key, not value.
                    if (lastPos < end) {
                        key += qs.slice(lastPos, end);
                    } else if (key.length === 0) {
                        // An empty substring between separators still costs budget.
                        if (--pairs === 0) return obj;
                        lastPos = i + 1;
                        sepIdx = eqIdx = 0;
                        continue;
                    }
                } else if (lastPos < end) {
                    value += qs.slice(lastPos, end);
                }

                addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

                if (--pairs === 0) return obj;
                keyEncoded = valEncoded = customDecode;
                key = value = '';
                encodeCheck = 0;
                lastPos = i + 1;
                sepIdx = eqIdx = 0;
            }
        } else {
            sepIdx = 0;
            if (eqIdx < eqLen) {
                if (code === eqCodes[eqIdx]) {
                    if (++eqIdx === eqLen) {
                        const end = i - eqIdx + 1;
                        if (lastPos < end) key += qs.slice(lastPos, end);
                        encodeCheck = 0;
                        lastPos = i + 1;
                    }
                    continue;
                } else {
                    eqIdx = 0;
                    if (!keyEncoded) {
                        // Find one valid %XX to decide whether decoding is needed.
                        if (code === 37 /* % */) {
                            encodeCheck = 1;
                            continue;
                        } else if (encodeCheck > 0) {
                            if (isHexTable[code] === 1) {
                                if (++encodeCheck === 3) keyEncoded = true;
                                continue;
                            } else {
                                encodeCheck = 0;
                            }
                        }
                    }
                }
                if (code === 43 /* + */) {
                    if (lastPos < i) key += qs.slice(lastPos, i);
                    key += plusChar;
                    lastPos = i + 1;
                    continue;
                }
            }
            if (code === 43 /* + */) {
                if (lastPos < i) value += qs.slice(lastPos, i);
                value += plusChar;
                lastPos = i + 1;
            } else if (!valEncoded) {
                if (code === 37 /* % */) {
                    encodeCheck = 1;
                } else if (encodeCheck > 0) {
                    if (isHexTable[code] === 1) {
                        if (++encodeCheck === 3) valEncoded = true;
                    } else {
                        encodeCheck = 0;
                    }
                }
            }
        }
    }

    // Leftover data. If a full separator was already matched, trailing text is
    // neither key nor value and is dropped.
    if (lastPos < qs.length) {
        if (eqIdx < eqLen) key += qs.slice(lastPos);
        else if (sepIdx < sepLen) value += qs.slice(lastPos);
    } else if (eqIdx === 0 && key.length === 0) {
        return obj;
    }

    addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

    return obj;
}

// Node exports qsEscape/qsUnescape under the escape/unescape names because both
// are JS globals; the function objects keep their original .name.
export { qsEscape as escape, qsUnescape as unescape, parse, stringify };

// Node keeps these historical aliases as the same function objects.
export const decode = parse;
export const encode = stringify;
