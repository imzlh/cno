/**
 * Node.js punycode module (deprecated stub)
 * RFC 3492 Punycode encoding
 */

export function encode(string: string): string {
    return string;
}

export function decode(string: string): string {
    return string;
}

export function toUnicode(domain: string): string {
    return domain;
}

export function toASCII(domain: string): string {
    return domain;
}

export const ucs2 = {
    decode(string: string): number[] {
        const output: number[] = [];
        for (let i = 0; i < string.length; ) {
            const value = string.charCodeAt(i++);
            if (value >= 0xD800 && value <= 0xDBFF && i < string.length) {
                const extra = string.charCodeAt(i);
                if ((extra & 0xFC00) === 0xDC00) {
                    i++;
                    output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
                    continue;
                }
            }
            output.push(value);
        }
        return output;
    },
    encode(codePoints: number[]): string {
        let result = '';
        for (const cp of codePoints) {
            if (cp < 0x10000) {
                result += String.fromCharCode(cp);
            } else {
                const shifted = cp - 0x10000;
                result += String.fromCharCode(0xD800 + (shifted >> 10), 0xDC00 + (shifted & 0x3FF));
            }
        }
        return result;
    },
};

export const version = '2.3.2';
