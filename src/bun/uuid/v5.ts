import { Buffer } from '../../node/buffer';

const crypto = import.meta.use('crypto');
type Binary = ArrayBuffer | SharedArrayBuffer | ArrayBufferView;
type Encoding = 'hex' | 'base64' | 'base64url' | 'buffer' | 'utf8' | 'utf-8' | 'ascii' | 'latin1' | 'binary' | 'ucs2' | 'ucs-2' | 'utf16le';
const namespaces: Record<string, string> = {
    dns: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    url: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
    oid: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
    x500: '6ba7b814-9dad-11d1-80b4-00c04fd430c8',
};

function isBinary(value: unknown): value is Binary {
    if (ArrayBuffer.isView(value)) return true;
    try { Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(value); return true; } catch { /* not an ArrayBuffer */ }
    if (typeof SharedArrayBuffer === 'undefined') return false;
    try { Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!.call(value); return true; } catch { return false; }
}

function bytes(value: Binary): Uint8Array {
    return ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
}

function isString(value: unknown): value is string {
    if (typeof value === 'string') return true;
    if (typeof value !== 'object' || value === null) return false;
    try { String.prototype.valueOf.call(value); return true; } catch { return false; }
}

function error(message: string, code: string): TypeError {
    return Object.assign(new TypeError(message), { code });
}

interface RandomUUIDv5 {
    (name: string | Binary, namespace: string | Binary, encoding: 'buffer'): Buffer;
    (name: string | Binary, namespace: string | Binary, encoding?: Exclude<Encoding, 'buffer'>): string;
}

export const randomUUIDv5 = {
  randomUUIDv5(name: string | Binary, namespace: string | Binary, encoding?: Encoding): string | Buffer {
    if (!isString(name) && !isBinary(name)) throw error('name must be a string, ArrayBuffer or ArrayBufferView', 'ERR_INVALID_ARG_TYPE');
    const nameBytes = isString(name) ? Buffer.from(String(name), 'utf8') : bytes(name);
    if (!isString(namespace) && !isBinary(namespace)) throw error('namespace must be a string, ArrayBuffer or ArrayBufferView', 'ERR_INVALID_ARG_TYPE');
    const namespaceString = isString(namespace) ? String(namespace) : undefined;
    const format = isString(encoding) ? String(encoding).toLowerCase() : 'hex';
    if (!['hex', 'base64', 'base64url', 'buffer', 'utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'ucs2', 'ucs-2', 'utf16le'].includes(format)) {
        throw error('Encoding must be one of base64, base64url, hex, or buffer', 'ERR_UNKNOWN_ENCODING');
    }
    let namespaceBytes: Uint8Array;
    if (namespaceString !== undefined) {
        const value = Object.hasOwn(namespaces, namespaceString.toLowerCase())
            ? namespaces[namespaceString.toLowerCase()]
            : namespaceString;
        if (value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw error('Invalid UUID format for namespace', 'ERR_INVALID_ARG_VALUE');
        namespaceBytes = Buffer.from(value.replace(/-/g, ''), 'hex');
    } else {
        namespaceBytes = bytes(namespace as Binary);
        if (namespaceBytes.byteLength !== 16) throw error('Namespace must be exactly 16 bytes', 'ERR_INVALID_ARG_VALUE');
    }
    const input = new Uint8Array(16 + nameBytes.byteLength);
    input.set(namespaceBytes);
    input.set(nameBytes, 16);
    const result = Buffer.from(crypto.sha1(input)).subarray(0, 16);
    result[6] = (result[6] & 0x0f) | 0x50;
    result[8] = (result[8] & 0x3f) | 0x80;
    if (format === 'buffer') return result;
    if (format !== 'hex') return result.toString(format as BufferEncoding);
    const hex = result.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
}.randomUUIDv5 as RandomUUIDv5;
