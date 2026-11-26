import { sanitizeSurrogates, utf8Decode } from '../../utils/bytes';
import { blobBytesOf } from '../blob-intrinsics';
import { isBunFile } from '../file';
import { parseDocuments } from './vendor/yaml-parser';

const engine = import.meta.use('engine');

type BrandGetter<T> = (this: unknown) => T;
type ParsedNode = {
    [key: symbol]: symbol;
    value?: any;
    source?: string;
    anchor?: string;
    tag?: string;
    type?: string;
    items: Array<ParsedNode & { key: ParsedNode }>;
};
type Reference = { count: number; name: string; emitted: boolean };
type Rendered = { text: string; block: boolean };

const nodeType = Symbol.for('yaml.node.type');
const scalarType = Symbol.for('yaml.scalar');
const aliasType = Symbol.for('yaml.alias');
const sequenceType = Symbol.for('yaml.seq');
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get! as BrandGetter<number>;
const sharedBufferLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get as BrandGetter<number>
    : undefined;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get! as BrandGetter<number>;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get! as BrandGetter<number>;
const dataBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const dataOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get! as BrandGetter<number>;
const dataLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get! as BrandGetter<number>;
const isView = ArrayBuffer.isView;
const numberValue = Number.prototype.valueOf;
const stringValue = String.prototype.valueOf;
const booleanValue = Boolean.prototype.valueOf;
const bigintValue = BigInt.prototype.valueOf;
const emptyBytes = new Uint8Array();

function decodeInput(input: unknown): string {
    if (isBunFile(input)) {
        throw Object.assign(new TypeError('File blob cannot be used here'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    const blob = blobBytesOf(input);
    if (blob !== undefined) return utf8Decode(blob);
    if (input !== null && typeof input === 'object') {
        let buffer: ArrayBufferLike;
        let offset = 0;
        let length: number;
        let shared = false;
        if (isView(input)) {
            try {
                const data = engine.isDataView(input);
                buffer = Reflect.apply(data ? dataBuffer : typedBuffer, input, []);
                offset = Reflect.apply(data ? dataOffset : typedOffset, input, []);
                length = Reflect.apply(data ? dataLength : typedLength, input, []);
            } catch {
                return '';
            }
            if (sharedBufferLength) {
                try { Reflect.apply(sharedBufferLength, buffer, []); shared = true; } catch {}
            }
        } else {
            try {
                length = Reflect.apply(arrayBufferLength, input, []);
            } catch {
                if (!sharedBufferLength) return sanitizeSurrogates(`${input}`);
                try { length = Reflect.apply(sharedBufferLength, input, []); shared = true; }
                catch { return sanitizeSurrogates(`${input}`); }
            }
            buffer = input as ArrayBufferLike;
        }
        const bytes = length === 0 ? emptyBytes : new Uint8Array(buffer, offset, length);
        return utf8Decode(shared ? Uint8Array.from(bytes) : bytes);
    }
    return sanitizeSurrogates(`${input}`);
}

function documentValue(contents: ParsedNode | null): any {
    const anchors = new Map<string, any>();
    const active = new Set<object>();
    function convert(node: ParsedNode | null): any {
        if (node === null) return null;
        const kind = node[nodeType];
        if (kind === aliasType) {
            if (!anchors.has(node.source!)) throw new SyntaxError('YAML Parse error: Unresolved alias');
            return anchors.get(node.source!);
        }
        if (kind === scalarType) {
            let value = node.value;
            if (node.tag && node.type !== 'PLAIN') value = node.source;
            else if (node.tag === 'tag:yaml.org,2002:int' || node.tag === 'tag:yaml.org,2002:float') {
                const source = node.source!;
                if (/^[-+]?\.(?:inf|nan)$/i.test(source)) {
                    value = /nan$/i.test(source) ? NaN : source[0] === '-' ? -Infinity : Infinity;
                } else if (numeric.test(source)) {
                    const sign = source[0] === '-' ? -1 : 1;
                    const unsigned = source.replace(/^[-+]/, '');
                    value = sign * (/^0x/i.test(unsigned) ? parseInt(unsigned.slice(2), 16)
                        : /^0o/i.test(unsigned) ? parseInt(unsigned.slice(2), 8) : Number(unsigned));
                } else value = source;
            }
            if (node.anchor) anchors.set(node.anchor, value);
            return value;
        }
        const sequence = kind === sequenceType;
        const result: any = sequence ? [] : {};
        if (node.anchor) anchors.set(node.anchor, result);
        active.add(result);
        if (sequence) {
            for (const item of node.items) result.push(convert(item));
        } else {
            const merges: object[] = [];
            for (const pair of node.items) {
                const key = String(convert(pair.key));
                const value = convert(pair.value);
                const isMergeKey = key === '<<' && pair.key.type === 'PLAIN' && pair.key.tag === undefined;
                if (isMergeKey && value !== null && typeof value === 'object') {
                    for (const source of Array.isArray(value) ? value : [value]) {
                        if (active.has(source)) throw new SyntaxError('YAML Parse error: Merge key cannot reference an enclosing node');
                        if (source !== null && typeof source === 'object' && !Array.isArray(source)) merges.push(source);
                    }
                } else if (key === '__proto__') {
                    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
                } else result[key] = value;
            }
            for (const source of merges) {
                for (const key of Object.keys(source)) {
                    if (!Object.hasOwn(result, key)) {
                        Object.defineProperty(result, key, {
                            value: Reflect.get(source, key), enumerable: true, writable: true, configurable: true,
                        });
                    }
                }
            }
        }
        active.delete(result);
        return result;
    }
    return convert(contents);
}

function unbox(value: any): any {
    if (value === null || typeof value !== 'object') return value;
    let number = false;
    let string = false;
    try { Reflect.apply(numberValue, value, []); number = true; } catch {}
    if (number) return Number(value);
    try { Reflect.apply(stringValue, value, []); string = true; } catch {}
    if (string) return String(value);
    try { return Reflect.apply(booleanValue, value, []); } catch {}
    try { return Reflect.apply(bigintValue, value, []); } catch {}
    return value;
}

const reserved = /^(?:y|yes|n|no|true|false|on|off|null|~|[-+]?\.(?:inf|nan))$/i;
const numeric = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[-+]?[0-9]+)?|0x[0-9a-f]+|0o[0-7]+)$/i;
const unsafeString = /^[\s\-?:,\[\]{}#&*!|<>'"%@`]|[\s]$|[\x00-\x1f\x7f\u0085\u00a0\u2028\u2029,\[\]{}#'"]|:(?:\s|$)/u;
const escapes: Record<string, string> = {
    '\0': '\\0', '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v',
    '\f': '\\f', '\r': '\\r', '\x1b': '\\e', '"': '\\"', '\\': '\\\\',
    '\x85': '\\N', '\xa0': '\\_', '\u2028': '\\L', '\u2029': '\\P',
};

function quote(value: string): string {
    if (value !== '' && value !== '...' && !reserved.test(value) && !numeric.test(value) && !unsafeString.test(value)) return value;
    return '"' + value.replace(/[\x00-\x1f\x7f\u0085\u00a0\u2028\u2029"\\]/g, character =>
        escapes[character] ?? `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`) + '"';
}

export const YAML = {
    parse(input: unknown): any {
        const documents = parseDocuments(decodeInput(input), {
            schema: 'core', uniqueKeys: false, resolveKnownTags: false, prettyErrors: false, logLevel: 'silent',
            customTags(tags: any[]) {
                return tags.map(tag => tag.format === 'OCT' || tag.format === 'HEX' ? {
                    ...tag,
                    test: tag.format === 'OCT' ? /^[-+]?0o[0-7]+$/ : /^[-+]?0x[0-9a-fA-F]+$/,
                    resolve(source: string) {
                        const signed = source[0] === '-' || source[0] === '+';
                        return (source[0] === '-' ? -1 : 1) * parseInt(source.slice(signed ? 3 : 2), tag.format === 'OCT' ? 8 : 16);
                    },
                } : tag);
            },
        });
        const values = [];
        for (const document of documents) {
            const error = document.errors[0];
            if (error) {
                throw new SyntaxError(`YAML Parse error: ${error.code === 'TAB_AS_INDENT'
                    ? 'Tab characters cannot be used as indentation' : error.message}`);
            }
            values.push(documentValue(document.contents));
        }
        return values.length === 0 ? null : values.length === 1 ? values[0] : values;
    },
    stringify(value: any, replacer?: unknown, space?: unknown): string | undefined {
        if (replacer != null) throw new Error('YAML.stringify does not support the replacer argument');
        space = unbox(space);
        const gap = typeof space === 'number' ? ' '.repeat(Math.min(10, Math.max(0, Math.floor(space) || 0)))
            : typeof space === 'string' ? space.slice(0, 10) : '';
        const references = new Map<object, Reference>();
        let fallback = 0;
        function scan(item: any, name: string): void {
            item = unbox(item);
            if (item === null || typeof item !== 'object') return;
            const previous = references.get(item);
            if (previous) { previous.count++; return; }
            references.set(item, {
                count: 1, name: /^[a-zA-Z0-9_.-]+$/.test(name) ? name : `value${fallback++}`, emitted: false,
            });
            if (!engine.isProxy(item) && Array.isArray(item)) {
                let index = 0;
                for (let position = 0; position < item.length; position++) {
                    const element = item[position];
                    if (element === undefined || typeof element === 'function' || typeof element === 'symbol') continue;
                    scan(element, `item${index++}`);
                }
            } else {
                for (const key of Object.keys(item)) scan(item[key], key);
            }
        }
        scan(value, 'root');
        const names = new Set<string>();
        for (const reference of references.values()) {
            if (reference.count < 2) continue;
            const base = reference.name;
            let suffix = 1;
            while (names.has(reference.name)) reference.name = `${base}_${suffix++}`;
            names.add(reference.name);
        }
        const rendering = new Set<object>();
        function render(item: any, levels: number, columns: number): Rendered | undefined {
            const indent = gap.repeat(levels) + ' '.repeat(columns);
            item = unbox(item);
            let text: string;
            switch (typeof item) {
                case 'string': return { text: quote(item), block: false };
                case 'boolean': return { text: String(item), block: false };
                case 'number':
                    text = Number.isNaN(item) ? '.nan' : item === Infinity ? '.inf' : item === -Infinity ? '-.inf'
                        : Object.is(item, -0) ? '-0' : String(item);
                    return { text, block: false };
                case 'bigint': throw new Error('YAML.stringify cannot serialize BigInt');
                case 'object': if (item === null) return { text: 'null', block: false }; break;
                default: return undefined;
            }
            const reference = references.get(item);
            const anchor = reference && reference.count > 1 ? reference.name : '';
            if (anchor && reference!.emitted) return { text: `*${anchor}`, block: true };
            if (rendering.has(item)) throw new TypeError('YAML.stringify encountered a circular structure added during serialization');
            rendering.add(item);
            if (reference) reference.emitted = true;
            const array = !engine.isProxy(item) && Array.isArray(item);
            const parts: string[] = [];
            if (array) {
                for (let position = 0; position < item.length; position++) {
                    const child = render(item[position], levels, columns + 2);
                    if (child) parts.push(gap ? `- ${child.text}` : child.text);
                }
            } else {
                for (const key of Object.keys(item)) {
                    const child = render(item[key], levels + 1, columns);
                    const childIndent = gap.repeat(levels + 1) + ' '.repeat(columns);
                    if (child) parts.push(quote(key) + (gap && child.block ? `:\n${childIndent}` : ': ') + child.text);
                }
            }
            const block = gap !== '' && parts.length > 0;
            text = block ? parts.join('\n' + indent)
                : (array ? '[' : '{') + parts.join(',') + (array ? ']' : '}');
            if (anchor) text = `&${anchor}` + (gap ? '\n' + indent : ' ') + text;
            rendering.delete(item);
            return { text, block: block || gap !== '' && anchor !== '' };
        }
        return render(value, 0, 0)?.text;
    },
};
