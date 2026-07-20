/**
 * Node.js querystring module
 * URL query string parsing and stringifying
 */

import { Buffer } from '../buffer';

function hexValue(code: number): number {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    if (code >= 97 && code <= 102) return code - 87;
    return -1;
}

function isContinuation(byte: number): boolean {
    return byte >= 0x80 && byte <= 0xBF;
}

function consumeInvalid(bytes: number[], start: number): number {
    let end = start + 1;
    while (end < bytes.length) {
        const byte = bytes[end];
        if (byte === undefined || !isContinuation(byte)) break;
        end++;
    }
    return end;
}

function decodeUtf8Bytes(bytes: number[]): string {
    let out = '';
    for (let i = 0; i < bytes.length;) {
        const b1 = bytes[i];
        if (b1 === undefined) break;
        if (b1 < 0x80) {
            out += String.fromCharCode(b1);
            i++;
            continue;
        }

        const b2 = bytes[i + 1];
        if (b1 >= 0xC2 && b1 <= 0xDF && b2 !== undefined && isContinuation(b2)) {
            out += String.fromCodePoint(((b1 & 0x1F) << 6) | (b2 & 0x3F));
            i += 2;
            continue;
        }

        if (b1 >= 0xE0 && b1 <= 0xEF && i + 2 < bytes.length) {
            const b2 = bytes[i + 1];
            const b3 = bytes[i + 2];
            if (b2 === undefined || b3 === undefined) {
                out += '\uFFFD';
                i = consumeInvalid(bytes, i);
                continue;
            }
            const validSecond = b1 === 0xE0 ? b2 >= 0xA0 && b2 <= 0xBF
                : b1 === 0xED ? b2 >= 0x80 && b2 <= 0x9F
                : isContinuation(b2);
            if (validSecond && isContinuation(b3)) {
                out += String.fromCodePoint(((b1 & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F));
                i += 3;
                continue;
            }
        }

        if (b1 >= 0xF0 && b1 <= 0xF4 && i + 3 < bytes.length) {
            const b2 = bytes[i + 1];
            const b3 = bytes[i + 2];
            const b4 = bytes[i + 3];
            if (b2 === undefined || b3 === undefined || b4 === undefined) {
                out += '\uFFFD';
                i = consumeInvalid(bytes, i);
                continue;
            }
            const validSecond = b1 === 0xF0 ? b2 >= 0x90 && b2 <= 0xBF
                : b1 === 0xF4 ? b2 >= 0x80 && b2 <= 0x8F
                : isContinuation(b2);
            if (validSecond && isContinuation(b3) && isContinuation(b4)) {
                out += String.fromCodePoint(((b1 & 0x07) << 18) | ((b2 & 0x3F) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F));
                i += 4;
                continue;
            }
        }

        out += '\uFFFD';
        i = consumeInvalid(bytes, i);
    }
    return out;
}

function fallbackDecode(input: string): string {
    let out = '';
    let bytes: number[] = [];
    const flush = () => {
        if (bytes.length === 0) return;
        out += decodeUtf8Bytes(bytes);
        bytes = [];
    };

    for (let i = 0; i < input.length; i++) {
        if (input.charCodeAt(i) === 37 && i + 2 < input.length) {
            const hi = hexValue(input.charCodeAt(i + 1));
            const lo = hexValue(input.charCodeAt(i + 2));
            if (hi !== -1 && lo !== -1) {
                bytes.push((hi << 4) | lo);
                i += 2;
                continue;
            }
        }
        flush();
        out += input[i];
    }
    flush();
    return out;
}

function decodePart(input: string, decode: (s: string) => string): string {
    const normalized = input.includes('+') ? input.replace(/\+/g, '%20') : input;
    try {
        return decode(normalized);
    } catch {
        return fallbackDecode(normalized);
    }
}

function normalizeDelimiter(value: unknown, fallback: string): string {
    return value ? String(value) : fallback;
}

export function parse(str: string, sep = '&', eq = '=', options?: { maxKeys?: number; decodeURIComponent?: (s: string) => string }): Record<string, string | string[]> {
    const decode = options?.decodeURIComponent ?? decodeURIComponent;
    const maxKeys = options?.maxKeys ?? 1000;
    const keyLimit = maxKeys > 0 ? maxKeys : Infinity;
    const result: Record<string, string | string[]> = Object.create(null);
    if (typeof str !== 'string' || str.length === 0) return result;

    sep = normalizeDelimiter(sep, '&');
    eq = normalizeDelimiter(eq, '=');

    let count = 0;
    for (const pair of str.split(sep)) {
        if (pair.length === 0) continue;
        if (count >= keyLimit) break;
        const idx = pair.indexOf(eq);
        const rawKey = idx >= 0 ? pair.substring(0, idx) : pair;
        const rawVal = idx >= 0 ? pair.substring(idx + eq.length) : '';
        const key = decodePart(rawKey, decode);
        const val = decodePart(rawVal, decode);
        const existing = result[key];
        if (existing !== undefined) {
            result[key] = Array.isArray(existing) ? [...existing, val] : [existing, val];
        } else {
            result[key] = val;
        }
        count++;
    }
    return result;
}

function stringifyPrimitive(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string') return String(value);
    return '';
}

export function stringify(obj: Record<string, unknown>, sep = '&', eq = '=', options?: { encodeURIComponent?: (s: string) => string }): string {
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return '';
    sep = normalizeDelimiter(sep, '&');
    eq = normalizeDelimiter(eq, '=');

    const encode = options?.encodeURIComponent ?? encodeURIComponent;
    const pairs: string[] = [];
    for (const [key, val] of Object.entries(obj)) {
        if (Array.isArray(val)) {
            for (const v of val) {
                pairs.push(`${encode(key)}${eq}${encode(stringifyPrimitive(v))}`);
            }
        } else {
            pairs.push(`${encode(key)}${eq}${encode(stringifyPrimitive(val))}`);
        }
    }
    return pairs.join(sep);
}

// Node qsEscape: encodeURIComponent alphabet, leave !'()* unescaped (RFC 2396).
// Iterate code points (not UTF-16 units) so surrogate pairs encode as UTF-8.
const QS_UNESCAPED = /[A-Za-z0-9\-_.!~*'()]/;

export function escape(str: string): string {
    const input = typeof str === 'string' ? str : String(str);
    let out = '';
    for (const ch of input) {
        const code = ch.codePointAt(0)!;
        if (code < 0x80 && QS_UNESCAPED.test(ch)) {
            out += ch;
            continue;
        }
        if (code < 0x80) {
            out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
            continue;
        }
        // Full code point (incl. emoji surrogate pairs) → UTF-8 percent sequences.
        out += encodeURIComponent(ch);
    }
    return out;
}

export function unescape(str: string): string {
    const input = typeof str === 'string' ? str : String(str);
    return decodePart(input, decodeURIComponent);
}

// Node keeps these historical aliases as the same function objects.
export const decode = parse;
export const encode = stringify;

export function unescapeBuffer(str: string, decodeSpaces = false): Buffer {
    const input = typeof str === 'string' ? str : String(str);
    const out = Buffer.allocUnsafe(input.length);
    let index = 0;
    let outIndex = 0;
    let hasHex = false;

    while (index < input.length) {
        let value = input.charCodeAt(index);
        if (value === 0x2b && decodeSpaces) {
            out[outIndex++] = 0x20;
            index++;
            continue;
        }
        if (value === 0x25 && index + 2 < input.length) {
            const high = hexValue(input.charCodeAt(index + 1));
            const low = hexValue(input.charCodeAt(index + 2));
            if (high >= 0 && low >= 0) {
                value = high * 16 + low;
                hasHex = true;
                index += 3;
                out[outIndex++] = value;
                continue;
            }
        }
        out[outIndex++] = value;
        index++;
    }

    return hasHex ? out.subarray(0, outIndex) : out;
}
