import { Buffer } from '../../node/buffer';

const crypto = import.meta.use('crypto');
type Binary = ArrayBuffer | SharedArrayBuffer | ArrayBufferView;
type Encoding = 'hex' | 'base64' | 'base64url' | 'buffer' | 'utf8' | 'utf-8' | 'ascii' | 'latin1' | 'binary' | 'ucs2' | 'ucs-2' | 'utf16le';
type BrandGetter<T> = (this: unknown) => T;

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get! as BrandGetter<number>;
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
const emptyBytes = new Uint8Array();
const namespaces: Record<string, string> = {
    dns: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    url: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
    oid: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
    x500: '6ba7b814-9dad-11d1-80b4-00c04fd430c8',
};

function rawBufferByteLength(value: unknown): number | undefined {
    try {
        return Reflect.apply(arrayBufferByteLength, value, []);
    } catch {
        if (sharedArrayBufferByteLength === undefined) return undefined;
        try {
            return Reflect.apply(sharedArrayBufferByteLength, value, []);
        } catch {
            return undefined;
        }
    }
}

function isBinary(value: unknown): value is Binary {
    if (rawBufferByteLength(value) !== undefined) return true;
    try {
        Reflect.apply(typedArrayBuffer, value, []);
        return true;
    } catch {
        try {
            Reflect.apply(dataViewBuffer, value, []);
            return true;
        } catch {
            return false;
        }
    }
}

function bytes(value: Binary): Uint8Array {
    const bufferLength = rawBufferByteLength(value);
    if (bufferLength !== undefined) {
        return bufferLength === 0 ? emptyBytes : new Uint8Array(value as ArrayBufferLike, 0, bufferLength);
    }
    try {
        const buffer = Reflect.apply(typedArrayBuffer, value, []);
        const byteOffset = Reflect.apply(typedArrayByteOffset, value, []);
        const byteLength = Reflect.apply(typedArrayByteLength, value, []);
        return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
    } catch {
        try {
            const buffer = Reflect.apply(dataViewBuffer, value, []);
            const byteOffset = Reflect.apply(dataViewByteOffset, value, []);
            const byteLength = Reflect.apply(dataViewByteLength, value, []);
            return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
        } catch {
            // Bun treats detached and out-of-bounds views as empty inputs.
            return emptyBytes;
        }
    }
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
    const digest = new Uint8Array(crypto.sha1(input), 0, 16);
    const result = new Buffer(16);
    result.set(digest);
    result[6] = (result[6] & 0x0f) | 0x50;
    result[8] = (result[8] & 0x3f) | 0x80;
    if (format === 'buffer') return result;
    if (format === 'ucs2' || format === 'ucs-2' || format === 'utf16le') {
        let value = '';
        for (let i = 0; i < result.length; i += 2) value += String.fromCharCode(result[i] | (result[i + 1] << 8));
        return value;
    }
    if (format !== 'hex') return result.toString(format as BufferEncoding);
    const hex = result.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
}.randomUUIDv5 as RandomUUIDv5;
