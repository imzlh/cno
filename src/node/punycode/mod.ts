/**
 * Node.js punycode module (RFC 3492 Bootstring encoding)
 * Ported from the algorithm Node.js itself vendors (mathiasbynens/punycode.js)
 */

const BASE = 36, T_MIN = 1, T_MAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;
const DELIMITER = '-';
const REGEX_NON_ASCII = /[^\0-\x7E]/;
const REGEX_SEPARATORS = /[\x2E。．｡]/g;
const MAX_INT = 2147483647;

function error(type: string): never {
    throw new RangeError(type === 'overflow' ? 'Overflow: input needs wider integers to process'
        : type === 'not-basic' ? 'Illegal input >= 0x80 (not a basic code point)'
        : 'Invalid input');
}

function ucs2decode(s: string): number[] {
    const out: number[] = [];
    let i = 0;
    while (i < s.length) {
        const c = s.charCodeAt(i++);
        if (c >= 0xD800 && c <= 0xDBFF && i < s.length) {
            const t = s.charCodeAt(i);
            if ((t & 0xFC00) === 0xDC00) { out.push(((c & 0x3FF) << 10) + (t & 0x3FF) + 0x10000); i++; continue; }
        }
        out.push(c);
    }
    return out;
}

const ucs2encode = (arr: number[]): string => String.fromCodePoint(...arr);

const digitToBasic = (digit: number, flag: number): number =>
    digit + 22 + 75 * (digit < 26 ? 1 : 0) - ((flag !== 0 ? 1 : 0) << 5);

function basicToDigit(cp: number): number {
    if (cp >= 0x30 && cp < 0x3A) return 26 + (cp - 0x30);
    if (cp >= 0x41 && cp < 0x5B) return cp - 0x41;
    if (cp >= 0x61 && cp < 0x7B) return cp - 0x61;
    return BASE;
}

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
    let k = 0;
    delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - T_MIN));
    return Math.floor(k + (BASE - T_MIN + 1) * delta / (delta + SKEW));
}

function decode(input: string): string {
    const output: number[] = [];
    const inputLength = input.length;
    let n = INITIAL_N, i = 0, bias = INITIAL_BIAS;

    let basic = input.lastIndexOf(DELIMITER);
    if (basic < 0) basic = 0;
    for (let j = 0; j < basic; j++) {
        const cc = input.charCodeAt(j);
        if (cc >= 0x80) error('not-basic');
        output.push(cc);
    }

    for (let index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
        const oldi = i;
        for (let w = 1, k = BASE; ; k += BASE) {
            if (index >= inputLength) error('invalid-input');
            const digit = basicToDigit(input.charCodeAt(index++));
            if (digit >= BASE) error('invalid-input');
            if (digit > Math.floor((MAX_INT - i) / w)) error('overflow');
            i += digit * w;
            const t = k <= bias ? T_MIN : (k >= bias + T_MAX ? T_MAX : k - bias);
            if (digit < t) break;
            const baseMinusT = BASE - t;
            if (w > Math.floor(MAX_INT / baseMinusT)) error('overflow');
            w *= baseMinusT;
        }
        const out = output.length + 1;
        bias = adapt(i - oldi, out, oldi === 0);
        if (Math.floor(i / out) > MAX_INT - n) error('overflow');
        n += Math.floor(i / out);
        i %= out;
        output.splice(i++, 0, n);
    }
    return ucs2encode(output);
}

function encode(input: string): string {
    const output: string[] = [];
    const inputArr = ucs2decode(input);
    const inputLength = inputArr.length;
    let n = INITIAL_N, delta = 0, bias = INITIAL_BIAS;

    for (const c of inputArr) if (c < 0x80) output.push(String.fromCharCode(c));

    const basicLength = output.length;
    let handledCPCount = basicLength;
    if (basicLength) output.push(DELIMITER);

    while (handledCPCount < inputLength) {
        let m = MAX_INT;
        for (const c of inputArr) if (c >= n && c < m) m = c;

        const handledCPCountPlusOne = handledCPCount + 1;
        if (m - n > Math.floor((MAX_INT - delta) / handledCPCountPlusOne)) error('overflow');
        delta += (m - n) * handledCPCountPlusOne;
        n = m;

        for (const c of inputArr) {
            if (c < n && ++delta > MAX_INT) error('overflow');
            if (c === n) {
                let q = delta;
                for (let k = BASE; ; k += BASE) {
                    const t = k <= bias ? T_MIN : (k >= bias + T_MAX ? T_MAX : k - bias);
                    if (q < t) break;
                    const qMinusT = q - t, baseMinusT = BASE - t;
                    output.push(String.fromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0)));
                    q = Math.floor(qMinusT / baseMinusT);
                }
                output.push(String.fromCharCode(digitToBasic(q, handledCPCount === basicLength ? 1 : 0)));
                bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
                delta = 0;
                handledCPCount++;
            }
        }
        delta++; n++;
    }
    return output.join('');
}

function mapDomain(s: string, fn: (label: string) => string): string {
    const parts = s.split('@');
    let result = '';
    if (parts.length > 1) { result = parts[0] + '@'; s = parts[1]!; }
    const labels = s.replace(REGEX_SEPARATORS, '.').split('.');
    return result + labels.map(fn).join('.');
}

function toUnicode(input: string): string {
    return mapDomain(input, label =>
        REGEX_NON_ASCII.test(label) ? label : (label.slice(0, 4) === 'xn--' ? decode(label.slice(4).toLowerCase()) : label));
}

function toASCII(input: string): string {
    return mapDomain(input, label =>
        REGEX_NON_ASCII.test(label) ? 'xn--' + encode(label) : label);
}

export const ucs2 = { decode: ucs2decode, encode: ucs2encode };
export { decode, encode, toASCII, toUnicode };
export const version = '2.3.1';

export default { ucs2, decode, encode, toASCII, toUnicode, version };
