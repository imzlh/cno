import { utf8Decode } from '../../utils/bytes';

type BrandGetter<T> = (this: unknown) => T;

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get! as BrandGetter<number>;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get as BrandGetter<number> | undefined
    : undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get! as BrandGetter<number>;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get! as BrandGetter<number>;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get! as BrandGetter<number>;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get! as BrandGetter<number>;
const arrayBufferIsView = ArrayBuffer.isView;
const NumberConstructor = Number;
const StringConstructor = String;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const booleanValueOf = Boolean.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;
const emptyBytes = new Uint8Array();

function rawBuffer(value: unknown): { bytes: Uint8Array; shared: boolean } | undefined {
    try {
        const byteLength = Reflect.apply(arrayBufferByteLength, value, []);
        return { bytes: byteLength === 0 ? emptyBytes : new Uint8Array(value as ArrayBuffer, 0, byteLength), shared: false };
    } catch {
        if (!sharedArrayBufferByteLength) return undefined;
        try {
            const byteLength = Reflect.apply(sharedArrayBufferByteLength, value, []);
            return { bytes: byteLength === 0 ? emptyBytes : new Uint8Array(value as SharedArrayBuffer, 0, byteLength), shared: true };
        } catch {
            return undefined;
        }
    }
}

function viewBytes(value: ArrayBufferView): { bytes: Uint8Array; shared: boolean } {
    let buffer: ArrayBufferLike;
    let byteOffset: number;
    let byteLength: number;
    try {
        buffer = Reflect.apply(typedArrayBuffer, value, []);
        byteOffset = Reflect.apply(typedArrayByteOffset, value, []);
        byteLength = Reflect.apply(typedArrayByteLength, value, []);
    } catch {
        try {
            buffer = Reflect.apply(dataViewBuffer, value, []);
            byteOffset = Reflect.apply(dataViewByteOffset, value, []);
            byteLength = Reflect.apply(dataViewByteLength, value, []);
        } catch {
            // Bun parses detached and out-of-bounds views as empty input.
            return { bytes: emptyBytes, shared: false };
        }
    }
    const raw = rawBuffer(buffer);
    const bytes = byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
    return { bytes, shared: raw?.shared ?? false };
}

function decodeBinary(input: unknown): string | undefined {
    if (input === null || (typeof input !== 'object' && typeof input !== 'function')) return undefined;
    const normalized = arrayBufferIsView(input) ? viewBytes(input) : rawBuffer(input);
    if (!normalized) return undefined;
    const bytes = normalized.shared ? Uint8Array.from(normalized.bytes) : normalized.bytes;
    try {
        return utf8Decode(bytes, true);
    } catch (error) {
        if (error instanceof TypeError) throw new SyntaxError('JSON5 Parse error: Invalid UTF-8 byte sequence');
        throw error;
    }
}

const identifierStart = /[$_\p{ID_Start}]/u;
const identifierPart = /[$_\u200c\u200d\p{ID_Continue}]/u;

class Parser {
    private i = 0;
    constructor(private source: string) {}
    private error(message = 'Unexpected token'): never { throw new SyntaxError(`JSON5 Parse error: ${message}`); }
    private space() {
        while (this.i < this.source.length) {
            if (/\s/u.test(this.source[this.i])) { this.i++; continue; }
            if (this.source.startsWith('//', this.i)) {
                this.i += 2;
                while (this.i < this.source.length && !/[\n\r\u2028\u2029]/u.test(this.source[this.i])) this.i++;
                continue;
            }
            if (this.source.startsWith('/*', this.i)) {
                const end = this.source.indexOf('*/', this.i + 2);
                if (end < 0) this.error('Unexpected end of input');
                this.i = end + 2; continue;
            }
            break;
        }
    }
    private escape(): string {
        const c = this.source[this.i++];
        if (c === undefined) this.error('Unterminated string');
        const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
        if (c in escapes) return escapes[c];
        if (c === '\n' || c === '\u2028' || c === '\u2029') return '';
        if (c === '\r') { if (this.source[this.i] === '\n') this.i++; return ''; }
        if (c === '0' && !/[0-9]/.test(this.source[this.i] ?? '')) return '\0';
        if (/[0-9]/.test(c)) this.error('Octal escape sequences are not allowed in JSON5');
        if (c === 'x' || c === 'u') {
            const count = c === 'x' ? 2 : 4;
            const hex = this.source.slice(this.i, this.i + count);
            if (hex.length !== count || !/^[0-9a-f]+$/i.test(hex)) this.error(c === 'u' ? 'Invalid unicode escape: expected 4 hex digits' : 'Invalid hexadecimal escape');
            this.i += count; return String.fromCharCode(parseInt(hex, 16));
        }
        return c;
    }
    private string(): string {
        const quote = this.source[this.i++]; let result = '';
        while (this.i < this.source.length) {
            const c = this.source[this.i++];
            if (c === quote) return result;
            if (c === '\\') result += this.escape();
            else if (c === '\n' || c === '\r') this.error('Unterminated string');
            else result += c;
        }
        return this.error('Unterminated string');
    }
    private identifier(): string {
        let value = '';
        while (this.i < this.source.length) {
            let c: string;
            if (this.source[this.i] === '\\') {
                this.i++;
                if (this.source[this.i] !== 'u') this.error();
                c = this.escape();
            } else {
                c = String.fromCodePoint(this.source.codePointAt(this.i)!);
                if (!(value ? identifierPart : identifierStart).test(c)) break;
                this.i += c.length;
            }
            if (!(value ? identifierPart : identifierStart).test(c)) this.error();
            value += c;
        }
        if (!value) this.error();
        return value;
    }
    private value(): any {
        this.space();
        const c = this.source[this.i];
        if (c === undefined) return this.error('Unexpected end of input');
        if (c === '"' || c === "'") return this.string();
        if (c === '{' || c === '[') {
            this.i++; const object = c === '{'; const result: any = object ? {} : [];
            this.space(); if (this.source[this.i] === (object ? '}' : ']')) { this.i++; return result; }
            while (true) {
                if (object) {
                    this.space(); const key = this.source[this.i] === '"' || this.source[this.i] === "'" ? this.string() : this.identifier();
                    this.space(); if (this.source[this.i++] !== ':') this.error();
                    Object.defineProperty(result, key, { value: this.value(), writable: true, enumerable: true, configurable: true });
                } else result.push(this.value());
                this.space(); const next = this.source[this.i++];
                if (next === (object ? '}' : ']')) return result;
                if (next !== ',') this.error(next === undefined ? 'Unexpected end of input' : 'Unexpected token');
                this.space(); if (this.source[this.i] === (object ? '}' : ']')) { this.i++; return result; }
            }
        }
        const rest = this.source.slice(this.i);
        const match = /^[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
        if (match) {
            const token = match[0];
            if (/^[+-]?0\d/.test(token)) this.error('Leading zeros are not allowed in JSON5');
            this.i += token.length;
            if (/^[+-]?0[xX]/.test(token)) return (token[0] === '-' ? -1 : 1) * parseInt(token.replace(/^[+-]/, ''), 16);
            return Number(token);
        }
        for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
            if (rest.startsWith(word)) { this.i += word.length; return value; }
        }
        return this.error();
    }
    parse(): any {
        const value = this.value(); this.space();
        if (this.i !== this.source.length) this.error('Unexpected token after JSON5 value');
        return value;
    }
}

export function parseJSON5(input: unknown): any {
    if (input == null) throw new TypeError('input must be a string, ArrayBuffer, ArrayBufferView or Blob');
    const binary = decodeBinary(input);
    const text = binary === undefined ? `${input}` : binary;
    return new Parser(text).parse();
}

function quote(value: string): string {
    return "'" + value.replace(/[\x00-\x1f\x7f'\\\u2028\u2029]/g, c => {
        const escapes: Record<string, string> = { "'": "\\'", '\\': '\\\\', '\0': '\\0', '\v': '\\v', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
        const code = c.charCodeAt(0);
        return escapes[c] ?? (code <= 127 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16)}`);
    }) + "'";
}
// Bun quotes astral identifier keys even though the parser accepts them.
const validIdentifier = /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u;
function isBareKey(value: string): boolean {
    return validIdentifier.test(value) && !/[\ud800-\udfff]/.test(value);
}
function hasBoxedValue(value: object, valueOf: (this: any) => any): boolean {
    try { valueOf.call(value); return true; } catch { return false; }
}
export function stringifyJSON5(value: any, replacer?: unknown, space?: unknown): string | undefined {
    if (replacer != null) throw new Error('JSON5.stringify does not support the replacer argument');
    let gap = '';
    if (space !== null && (typeof space === 'object' || typeof space === 'function')) {
        if (hasBoxedValue(space, numberValueOf)) space = NumberConstructor(space);
        else if (hasBoxedValue(space, stringValueOf)) space = StringConstructor(space);
    }
    if (typeof space === 'number') gap = ' '.repeat(Math.min(10, Math.max(0, Math.floor(space) || 0)));
    else if (typeof space === 'string') gap = space.slice(0, 10);
    const stack = new Set<object>();
    function serialize(item: any, depth: number, key: string): string | undefined {
        if (item && typeof item === 'object') {
            if (hasBoxedValue(item, numberValueOf)) item = NumberConstructor(item);
            else if (hasBoxedValue(item, stringValueOf)) item = StringConstructor(item);
            else if (hasBoxedValue(item, booleanValueOf)) item = Reflect.apply(booleanValueOf, item, []);
            else if (hasBoxedValue(item, bigintValueOf)) throw new Error('JSON5.stringify cannot serialize BigInt');
        }
        if (item === null) return 'null';
        if (typeof item === 'string') return quote(item);
        if (typeof item === 'number' || typeof item === 'boolean') return StringConstructor(item);
        if (typeof item === 'bigint') throw new Error('JSON5.stringify cannot serialize BigInt');
        if (typeof item !== 'object') return undefined;
        if (stack.has(item)) throw new Error('Converting circular structure to JSON5');
        stack.add(item);
        const array = Array.isArray(item); const parts: string[] = [];
        if (array) {
            for (let i = 0; i < item.length; i++) parts.push(serialize(item[i], depth + 1, StringConstructor(i)) ?? 'null');
        } else {
            for (const key of Object.keys(item)) {
                const v = serialize(item[key], depth + 1, key);
                if (v !== undefined) parts.push((isBareKey(key) ? key : quote(key)) + (gap ? ': ' : ':') + v);
            }
        }
        stack.delete(item);
        const open = array ? '[' : '{', close = array ? ']' : '}';
        if (!parts.length) return open + close;
        if (!gap) return open + parts.join(',') + close;
        return open + '\n' + gap.repeat(depth + 1) + parts.join(',\n' + gap.repeat(depth + 1)) + ',\n' + gap.repeat(depth) + close;
    }
    return serialize(value, 0, '');
}
export const JSON5 = {
    parse(input: unknown): any { return parseJSON5(input); },
    stringify(value: any, replacer?: unknown, space?: unknown): string | undefined {
        return stringifyJSON5(value, replacer, space);
    },
};
