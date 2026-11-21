import type { XML as XMLTypes } from 'bun';
import { utf8Decode } from '../../utils/bytes';
import { blobBytesOf } from '../blob-intrinsics';
import { isBunFile } from '../file';

const native = import.meta.use('xml');
const engine = import.meta.use('engine');
const text = import.meta.use('text');
const algorithm = import.meta.use('algorithm');

type XMLInput = Parameters<typeof XMLTypes.parse>[0];

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const sharedLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;
const declarationPattern = /^\uFEFF?<\?xml[\t\r\n ][^?]*\?>/;
const encodingPattern = /\bencoding[\t\r\n ]*=[\t\r\n ]*(['"])([^'"]+)\1/;
const utf8Encodings = new Set(['utf-8', 'utf8', 'ascii', 'us-ascii']);
const latin1Encodings = new Set(['iso-8859-1', 'iso_8859-1', 'latin1']);
const xmlWhitespace = /^[\t\r\n ]*$/;
const invalidCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const nameStart = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const xmlName = new RegExp(`^[${nameStart}][${nameStart}.0-9\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`, 'u');
const escapes: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;',
};
const maxDepth = 4096;

interface CompactFrame {
    name: string;
    value: XMLTypes.Element;
    text: string;
    hasAttributes: boolean;
    hasElements: boolean;
}

interface SerializedElement {
    name: string;
    attributes: string[];
    children: Array<string | SerializedElement>;
    hasText: boolean;
}

function binaryInput(input: unknown): Uint8Array | undefined {
    if (ArrayBuffer.isView(input)) {
        try {
            return new Uint8Array(
                Reflect.apply(typedBuffer, input, []),
                Reflect.apply(typedOffset, input, []),
                Reflect.apply(typedLength, input, []),
            );
        } catch {
            try {
                return new Uint8Array(
                    Reflect.apply(dataBuffer, input, []),
                    Reflect.apply(dataOffset, input, []),
                    Reflect.apply(dataLength, input, []),
                );
            } catch {
                return new Uint8Array();
            }
        }
    }
    if (engine.isArrayBuffer(input)) return new Uint8Array(input as ArrayBuffer);
    if (sharedLength && input !== null && typeof input === 'object') {
        try {
            const length = Reflect.apply(sharedLength, input, []);
            return new Uint8Array(input as SharedArrayBuffer, 0, length);
        } catch {
            // The intrinsic getter distinguishes shared buffers from other objects.
        }
    }
    return blobBytesOf(input);
}

function xmlSource(input: unknown): string {
    if (input == null || isBunFile(input)) {
        throw new TypeError('input must be a string, ArrayBuffer, ArrayBufferView or Blob');
    }
    let source: string;
    if (typeof input === 'string') source = input;
        else {
        let bytes = binaryInput(input);
        if (!bytes) source = String(input);
        else {
            if (!engine.isArrayBuffer(bytes.buffer)) bytes = Uint8Array.from(bytes);
            const utf16Bom = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
            const little = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0);
            const big = (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c);
            const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
            const offset = utf8Bom ? 3 : 0;
            let head = '';
            if (little || big) {
                try {
                    head = new text.Decoder(little ? 'UTF-16LE' : 'UTF-16BE', { fatal: true }).decode(bytes);
                } catch {
                    throw new SyntaxError('XML Parse error: Invalid byte encoding');
                }
            } else if (/^<\?xml[\t\r\n ]/.test(engine.decodeString(bytes.subarray(offset, offset + 6)))) {
                let end = offset + 6;
                while (end < bytes.length && !(bytes[end] === 0x3f && bytes[end + 1] === 0x3e)) end++;
                head = engine.decodeString(bytes.subarray(offset, end + 2));
            }
            let encoding = encodingPattern.exec(declarationPattern.exec(head)?.[0] ?? '')?.[2].toLowerCase();
            if (utf8Bom && encoding && !utf8Encodings.has(encoding)) {
                throw new SyntaxError('XML Parse error: Encoding conflicts with byte-order mark');
            }
            try {
                if (little || big) source = new text.Decoder(little ? 'UTF-16LE' : 'UTF-16BE', { fatal: true }).decode(bytes);
                else if (encoding && latin1Encodings.has(encoding)) source = algorithm.latin1DecodeLoose(bytes);
                else source = utf8Decode(bytes, true);
            } catch {
                throw new SyntaxError('XML Parse error: Invalid byte encoding');
            }
            encoding = encodingPattern.exec(declarationPattern.exec(source)?.[0] ?? '')?.[2].toLowerCase();
            const utf16Encoding = encoding === 'utf-16' || encoding === 'utf-16le' || encoding === 'utf-16be';
            if (encoding && !utf8Encodings.has(encoding) && !latin1Encodings.has(encoding) && !utf16Encoding) {
                throw new SyntaxError(`XML Parse error: Unsupported encoding '${encoding}'`);
            }
            if ((little || big) && !utf16Bom && !utf16Encoding) {
                throw new SyntaxError('XML Parse error: Encoding conflicts with document bytes');
            }
            if (utf16Bom && encoding && !utf16Encoding) {
                throw new SyntaxError('XML Parse error: Encoding conflicts with byte-order mark');
            }
            if (encoding && utf16Encoding !== (little || big)) {
                throw new SyntaxError('XML Parse error: Encoding conflicts with document bytes');
            }
        }
    }
    const declaration = declarationPattern.exec(source);
    if (declaration) {
        const encoding = encodingPattern.exec(declaration[0])?.[2];
        if (encoding && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) {
            throw new SyntaxError('XML Parse error: Invalid encoding name');
        }
        source = declaration[0].replace(encodingPattern, 'encoding="UTF-8"') + source.slice(declaration[0].length);
    }
    return source;
}

function appendCompactText(frame: CompactFrame): void {
    if (frame.text && (!frame.hasElements || !xmlWhitespace.test(frame.text))) {
        const previous = Object.hasOwn(frame.value, '#text') ? frame.value['#text'] : '';
        Object.defineProperty(frame.value, '#text', {
            value: (typeof previous === 'string' ? previous : '') + frame.text, enumerable: true, configurable: true, writable: true,
        });
    }
    frame.text = '';
}

function parse(input: XMLInput, options?: XMLTypes.ParseOptions & { compact?: true }): XMLTypes.Document;
function parse(input: XMLInput, options: XMLTypes.ParseOptions & { compact: false }): XMLTypes.Node;
function parse(input: XMLInput, options?: XMLTypes.ParseOptions): XMLTypes.Document | XMLTypes.Node;
function parse(input: unknown, options?: XMLTypes.ParseOptions | null): XMLTypes.Document | XMLTypes.Node {
    if (options != null && typeof options !== 'object') throw new TypeError('XML.parse options must be an object');
    const compact = options?.compact;
    if (compact !== undefined && typeof compact !== 'boolean') {
        throw new TypeError(`The "compact" property must be of type boolean, got ${typeof compact}`);
    }
    if (options) {
        for (const name of Reflect.ownKeys(options)) {
            if (name !== 'compact') throw new TypeError(`XML.parse: unsupported option "${String(name)}"`);
        }
    }
    const source = xmlSource(input);
    const parser = new native.Parser();
    const values: CompactFrame[] = [];
    const nodes: XMLTypes.Node[] = [];
    let result: XMLTypes.Document | XMLTypes.Node | undefined;
    parser.on('startDoctype', (_name, systemId, publicId) => {
        if (systemId !== null || publicId !== null) throw new SyntaxError('XML Parse error: External DTDs and entities are unsupported');
    });
    parser.on('entityDeclaration', (_name, _parameter, _value, systemId, publicId) => {
        if (systemId !== null || publicId !== null) throw new SyntaxError('XML Parse error: External DTDs and entities are unsupported');
    });
    parser.on('startElement', (name, attributes) => {
        if ((compact === false ? nodes.length : values.length) >= maxDepth) throw new RangeError('XML elements are nested too deeply');
        if (compact === false) {
            nodes.push({ name, attributes, children: [] });
        } else {
            const parent = values[values.length - 1];
            if (parent) {
                parent.hasElements = true;
                appendCompactText(parent);
            }
            const value: XMLTypes.Element = {};
            const names = Object.keys(attributes);
            for (const key of names) {
                Object.defineProperty(value, '@' + key, {
                    value: attributes[key], enumerable: true, configurable: true, writable: true,
                });
            }
            values.push({ name, value, text: '', hasAttributes: names.length > 0, hasElements: false });
        }
    });
    parser.on('characterData', data => {
        if (compact === false) {
            const node = nodes[nodes.length - 1];
            if (!node) return;
            const last = node.children.length - 1;
            if (typeof node.children[last] === 'string') node.children[last] += data;
            else node.children.push(data);
        } else {
            const frame = values[values.length - 1];
            if (frame) frame.text += data;
        }
    });
    parser.on('endElement', () => {
        if (compact === false) {
            const node = nodes.pop()!;
            const parent = nodes[nodes.length - 1];
            if (parent) parent.children.push(node);
            else result = node;
        } else {
            const frame = values.pop()!;
            let value: XMLTypes.Value;
            if (!frame.hasAttributes && !frame.hasElements) value = frame.text;
            else {
                appendCompactText(frame);
                value = frame.value;
            }
            const parent = values[values.length - 1];
            const container = parent?.value ?? {};
            if (Object.hasOwn(container, frame.name)) {
                const previous = container[frame.name];
                if (Array.isArray(previous)) previous.push(value);
                else Object.defineProperty(container, frame.name, {
                    value: [previous, value], enumerable: true, configurable: true, writable: true,
                });
            } else {
                Object.defineProperty(container, frame.name, { value, enumerable: true, configurable: true, writable: true });
            }
            if (!parent) result = container as XMLTypes.Document;
        }
    });
    if (compact === false) {
        parser.on('comment', comment => {
            const parent = nodes[nodes.length - 1];
            if (parent) parent.children.push({ comment });
        });
        parser.on('processingInstruction', (target, data) => {
            const parent = nodes[nodes.length - 1];
            if (parent) parent.children.push({ target, data });
        });
    }
    try {
        parser.parse(source);
    } catch (error) {
        if (error instanceof RangeError || error instanceof SyntaxError) throw error;
        throw new SyntaxError(error instanceof Error ? error.message : String(error));
    }
    return result!;
}

function scalar(value: unknown, context: string): string | undefined {
    if (value == null || typeof value === 'function' || typeof value === 'symbol' || value === undefined) return undefined;
    if (engine.isDate(value)) return Date.prototype.toISOString.call(value);
    if (typeof value === 'object') throw new Error(`XML.stringify: ${context} must be a string, number, boolean, bigint, Date, or null`);
    return String(value);
}

function escapeValue(value: string, attribute = false): string {
    if (invalidCharacter.test(value)) throw new Error('XML.stringify: Invalid XML character');
    return value.replace(attribute ? /[&<>"\t\n\r]/g : /[&<>\r]/g, character => escapes[character]);
}

function checkName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || !xmlName.test(name)) throw new Error(`XML.stringify: Invalid XML name '${String(name)}'`);
}

function stringify(value: XMLTypes.NodeInput | XMLTypes.Document, replacer?: null, space?: string | number): string;
function stringify(value: unknown, replacer?: null, space?: string | number): string | undefined;
function stringify(value: unknown, replacer?: null, space?: string | number): string | undefined {
    if (replacer != null) throw new TypeError('XML.stringify replacer must be null or undefined');
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('XML.stringify expects an object: a { name, attributes, children } node or an object with a single root element key');
    }
    const indent = typeof space === 'number' ? ' '.repeat(Math.min(10, Math.max(0, Math.trunc(space) || 0)))
        : typeof space === 'string' ? space.slice(0, 10) : '';
    const active = new Set<object>();

    function render(value: string | SerializedElement, depth: number): string {
        if (typeof value === 'string') return value;
        const opening = '<' + value.name + value.attributes.join('');
        if (!value.children.length) return opening + '/>';
        const children = value.children.map(child => render(child, value.hasText ? depth : depth + 1));
        if (!indent || value.hasText) return opening + '>' + children.join('') + '</' + value.name + '>';
        const padding = '\n' + indent.repeat(depth + 1);
        return opening + '>' + padding + children.join(padding) + '\n' + indent.repeat(depth) + '</' + value.name + '>';
    }

    function compactElement(name: string, input: unknown, depth: number): string | SerializedElement {
        if (input === undefined || typeof input === 'function' || typeof input === 'symbol') return '';
        checkName(name);
        if (depth >= maxDepth) throw new RangeError('XML elements are nested too deeply');
        if (input === null) return '<' + name + '/>';
        if (typeof input !== 'object' || engine.isDate(input)) {
            const content = scalar(input, 'text')!;
            return content ? '<' + name + '>' + escapeValue(content) + '</' + name + '>' : '<' + name + '/>';
        }
        if (Array.isArray(input)) throw new Error('XML.stringify: Arrays cannot be nested');
        if (active.has(input)) throw new Error('XML.stringify: Circular structure');
        active.add(input);
        try {
            const attributes: string[] = [];
            const children: Array<string | SerializedElement> = [];
            let hasText = false;
            for (const key of Object.keys(input)) {
                const entry = Reflect.get(input, key);
                if (key.startsWith('@')) {
                    const content = scalar(entry, 'an attribute value');
                    if (content === undefined) continue;
                    checkName(key.slice(1));
                    attributes.push(' ' + key.slice(1) + '="' + escapeValue(content, true) + '"');
                } else if (key === '#text') {
                    const content = scalar(entry, '#text');
                    if (content) {
                        children.push(escapeValue(content));
                        hasText = true;
                    }
                } else if (Array.isArray(entry)) {
                    for (const item of entry) {
                        const rendered = compactElement(key, item, depth + 1);
                        if (rendered) children.push(rendered);
                    }
                } else {
                    const rendered = compactElement(key, entry, depth + 1);
                    if (rendered) children.push(rendered);
                }
            }
            return { name, attributes, children, hasText };
        } finally {
            active.delete(input);
        }
    }

    function treeElement(input: XMLTypes.NodeInput, depth: number, name: unknown = input.name): SerializedElement {
        if (depth >= maxDepth) throw new RangeError('XML elements are nested too deeply');
        if (active.has(input)) throw new Error('XML.stringify: Circular structure');
        checkName(name);
        active.add(input);
        try {
            const attributes: string[] = [];
            const children: Array<string | SerializedElement> = [];
            let hasText = false;
            const sourceAttributes = input.attributes;
            if (sourceAttributes != null) {
                if (typeof sourceAttributes !== 'object' || Array.isArray(sourceAttributes)) throw new Error('XML.stringify: attributes must be an object');
                for (const key of Object.keys(sourceAttributes)) {
                    const content = scalar(sourceAttributes[key], 'an attribute value');
                    if (content === undefined) continue;
                    checkName(key);
                    attributes.push(' ' + key + '="' + escapeValue(content, true) + '"');
                }
            }
            const sourceChildren = input.children;
            if (sourceChildren != null && !Array.isArray(sourceChildren)) throw new Error('XML.stringify: children must be an array');
            for (const child of sourceChildren ?? []) {
                if (child == null || typeof child === 'function' || typeof child === 'symbol') continue;
                if (typeof child !== 'object' || engine.isDate(child)) {
                    children.push(escapeValue(scalar(child, 'text')!));
                    hasText = true;
                } else if ('name' in child) children.push(treeElement(child as XMLTypes.NodeInput, depth + 1));
                else if ('comment' in child) {
                    const comment = scalar(child.comment, 'comment') ?? '';
                    if (invalidCharacter.test(comment) || comment.includes('--') || comment.endsWith('-')) throw new Error('XML.stringify: Invalid XML comment');
                    children.push('<!--' + comment + '-->');
                } else if ('target' in child) {
                    checkName(child.target);
                    const data = scalar(child.data, 'processing instruction data') ?? '';
                    if (/^xml$/i.test(child.target) || invalidCharacter.test(data) || data.includes('?>')) throw new Error('XML.stringify: Invalid processing instruction');
                    children.push('<?' + child.target + (data ? ' ' + data : '') + '?>');
                } else throw new Error('XML.stringify: Invalid child node');
            }
            return { name, attributes, children, hasText };
        } finally {
            active.delete(input);
        }
    }

    if ('children' in value || 'attributes' in value) {
        const name = Reflect.get(value, 'name');
        if (typeof name === 'string') return render(treeElement(value as XMLTypes.NodeInput, 0, name), 0);
    }
    const roots = Object.entries(value).filter(([, entry]) => {
        return entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol';
    });
    if (roots.length !== 1) throw new Error('XML.stringify: the top-level object must have one key naming the root element');
    return render(compactElement(roots[0][0], roots[0][1], 0), 0);
}

export const XML = { parse, stringify };
