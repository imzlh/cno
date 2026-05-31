/**
 * Deno KV Types
 * Based on Deno 1.40+ KV API
 */

const engine = import.meta.use('engine');
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type KvKeyPart = string | number | bigint | boolean | Uint8Array;
export type KvKey = readonly KvKeyPart[];

export interface KvEntry<T = unknown> {
    key: KvKey;
    value: T;
    versionstamp: string;
}

export interface KvEntryMaybe<T = unknown> {
    key: KvKey;
    value: T | null;
    versionstamp: string | null;
}

export type KvConsistency = "strong" | "eventual";

export interface KvGetOptions {
    consistency?: KvConsistency;
}

export interface KvListOptions {
    limit?: number;
    cursor?: string;
    reverse?: boolean;
    consistency?: KvConsistency;
    batchSize?: number;
}

export interface KvListSelector {
    prefix?: KvKey;
    start?: KvKey;
    end?: KvKey;
}

export interface KvSetOptions {
    expireIn?: number;
}

export interface KvCommitResult {
    ok: true;
    versionstamp: string;
}

export interface KvCommitError {
    ok: false;
}

export type KvCommitResultOrError = KvCommitResult | KvCommitError;

export interface AtomicCheck {
    key: KvKey;
    versionstamp: string | null;
}

export interface KvQueueOptions {
    delay?: number;
    keysIfUndelivered?: KvKey[];
    backoffSchedule?: number[];
}

export interface KvQueueMessage {
    data: unknown;
    id: string;
    retryCount?: number;
    scheduledAt?: number;
}

export interface KvWatchOptions {
    raw?: boolean;
}

export type RawKey = Uint8Array;

export interface InternalEntry {
    key: RawKey;
    value: Uint8Array;
    versionstamp: string;
    expireAt: number | null;
}

const KEY_PART_TYPE_ORDER: Record<string, number> = {
    'boolean': 0,
    'number': 1,
    'bigint': 2,
    'string': 3,
    'Uint8Array': 4,
};

const TYPE_PREFIXES: Record<string, number> = {
    'boolean': 0x10,
    'number': 0x20,
    'bigint': 0x30,
    'string': 0x40,
    'Uint8Array': 0x50,
};

let versionstampCounter = 0;
let lastTimestamp = 0;

export function generateVersionstamp(): string {
    const now = Date.now();
    if (now === lastTimestamp) {
        versionstampCounter = (versionstampCounter + 1) & 0xFFFF;
    } else {
        versionstampCounter = 0;
        lastTimestamp = now;
    }
    const timestamp = now.toString(16).padStart(12, '0');
    const counter = versionstampCounter.toString(16).padStart(4, '0');
    return `${timestamp}${counter}0000`;
}

export function serializeLegacyKey(key: Deno.KvKey): string {
    return JSON.stringify(key, (_, v) => {
        if (typeof v === 'bigint') return { __kv_type: 'bigint', value: v.toString() };
        if (v instanceof Uint8Array) return { __kv_type: 'Uint8Array', value: Array.from(v) };
        return v;
    });
}

export function deserializeLegacyKey(rawKey: string): Deno.KvKey {
    return JSON.parse(rawKey, (_, v) => {
        if (v && typeof v === 'object' && v.__kv_type) {
            switch (v.__kv_type) {
                case 'bigint': return BigInt(v.value);
                case 'Uint8Array': return new Uint8Array(v.value);
            }
        }
        return v;
    }) as Deno.KvKey;
}

function appendBytes(target: number[], bytes: Uint8Array): void {
    for (const byte of bytes) target.push(byte);
}

function encodeEscapedBytes(target: number[], bytes: Uint8Array): void {
    for (const byte of bytes) {
        if (byte === 0) target.push(0, 0xFF);
        else target.push(byte);
    }
    target.push(0, 0);
}

function decodeEscapedBytes(data: Uint8Array, offset: number): { bytes: Uint8Array; offset: number } {
    const out: number[] = [];
    while (offset < data.length) {
        const byte = data[offset++]!;
        if (byte !== 0) {
            out.push(byte);
            continue;
        }
        if (offset >= data.length) throw new TypeError('Invalid escaped key encoding');
        const next = data[offset++]!;
        if (next === 0xFF) {
            out.push(0);
            continue;
        }
        if (next === 0) {
            return { bytes: new Uint8Array(out), offset };
        }
        throw new TypeError('Invalid escaped key encoding');
    }
    throw new TypeError('Unexpected end of key encoding');
}

function encodeNumber(value: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, Object.is(value, -0) ? 0 : value, false);
    if (value < 0) {
        for (let i = 0; i < out.length; i++) out[i] = (~out[i]) & 0xFF;
    } else {
        out[0] ^= 0x80;
    }
    return out;
}

function decodeNumber(data: Uint8Array, offset: number): { value: number; offset: number } {
    const bytes = data.slice(offset, offset + 8);
    if (bytes.length !== 8) throw new TypeError('Invalid number key encoding');
    const negative = (bytes[0] & 0x80) === 0;
    if (negative) {
        for (let i = 0; i < bytes.length; i++) bytes[i] = (~bytes[i]) & 0xFF;
    } else {
        bytes[0] ^= 0x80;
    }
    return {
        value: new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false),
        offset: offset + 8,
    };
}

function bigintToBytes(value: bigint): Uint8Array {
    let hex = value.toString(16);
    if (hex.length === 0) hex = '0';
    if (hex.length % 2) hex = `0${hex}`;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out.length ? out : new Uint8Array([0]);
}

function bytesToBigint(bytes: Uint8Array): bigint {
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return BigInt(`0x${hex || '0'}`);
}

function u32be(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
}

function readU32be(data: Uint8Array, offset: number): { value: number; offset: number } {
    if (offset + 4 > data.length) throw new TypeError('Invalid bigint key encoding');
    return {
        value: new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false),
        offset: offset + 4,
    };
}

function encodeBigint(value: bigint): Uint8Array {
    const negative = value < 0n;
    const magnitude = bigintToBytes(negative ? -value : value);
    const out: number[] = [TYPE_PREFIXES.bigint, negative ? 0x00 : 0x01];
    appendBytes(out, u32be(negative ? 0xFFFFFFFF - magnitude.length : magnitude.length));
    if (negative) {
        for (const byte of magnitude) out.push((~byte) & 0xFF);
    } else {
        appendBytes(out, magnitude);
    }
    return new Uint8Array(out);
}

function decodeBigint(data: Uint8Array, offset: number): { value: bigint; offset: number } {
    if (offset >= data.length) throw new TypeError('Invalid bigint key encoding');
    const sign = data[offset++]!;
    const lenInfo = readU32be(data, offset);
    offset = lenInfo.offset;
    const length = sign === 0x00 ? 0xFFFFFFFF - lenInfo.value : lenInfo.value;
    const bytes = data.slice(offset, offset + length);
    if (bytes.length !== length) throw new TypeError('Invalid bigint key payload');
    if (sign === 0x00) {
        for (let i = 0; i < bytes.length; i++) bytes[i] = (~bytes[i]) & 0xFF;
        return { value: -bytesToBigint(bytes), offset: offset + length };
    }
    return { value: bytesToBigint(bytes), offset: offset + length };
}

export function serializeKey(key: Deno.KvKey): RawKey {
    const out: number[] = [];
    for (const part of key) {
        const type = getKeyPartType(part as KvKeyPart);
        switch (type) {
            case 'boolean':
                out.push(TYPE_PREFIXES.boolean, (part as boolean) ? 1 : 0);
                break;
            case 'number':
                out.push(TYPE_PREFIXES.number);
                appendBytes(out, encodeNumber(part as number));
                break;
            case 'bigint':
                appendBytes(out, encodeBigint(part as bigint));
                break;
            case 'string':
                out.push(TYPE_PREFIXES.string);
                encodeEscapedBytes(out, textEncoder.encode(part as string));
                break;
            case 'Uint8Array':
                out.push(TYPE_PREFIXES.Uint8Array);
                encodeEscapedBytes(out, part as Uint8Array);
                break;
            default:
                throw new TypeError(`Unsupported key part type: ${type}`);
        }
    }
    return new Uint8Array(out);
}

export function deserializeKey(rawKey: RawKey): Deno.KvKey {
    const key: KvKeyPart[] = [];
    let offset = 0;
    while (offset < rawKey.length) {
        const tag = rawKey[offset++]!;
        switch (tag) {
            case TYPE_PREFIXES.boolean:
                if (offset >= rawKey.length) throw new TypeError('Invalid boolean key encoding');
                key.push(rawKey[offset++] === 1);
                break;
            case TYPE_PREFIXES.number: {
                const decoded = decodeNumber(rawKey, offset);
                key.push(decoded.value);
                offset = decoded.offset;
                break;
            }
            case TYPE_PREFIXES.bigint: {
                const decoded = decodeBigint(rawKey, offset);
                key.push(decoded.value);
                offset = decoded.offset;
                break;
            }
            case TYPE_PREFIXES.string: {
                const decoded = decodeEscapedBytes(rawKey, offset);
                key.push(textDecoder.decode(decoded.bytes));
                offset = decoded.offset;
                break;
            }
            case TYPE_PREFIXES.Uint8Array: {
                const decoded = decodeEscapedBytes(rawKey, offset);
                key.push(decoded.bytes);
                offset = decoded.offset;
                break;
            }
            default:
                throw new TypeError(`Unknown key tag: ${tag}`);
        }
    }
    return key as Deno.KvKey;
}

export function rawKeyToCursor(rawKey: RawKey): string {
    return Array.from(rawKey, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function cursorToRawKey(cursor: string): RawKey {
    if (cursor.length % 2 !== 0) throw new TypeError('Invalid cursor');
    const out = new Uint8Array(cursor.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(cursor.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function compareRawKeys(a: RawKey, b: RawKey): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

const LEGACY_JSON_SERIALIZER = (_key: string, v: unknown): unknown => {
    if (typeof v === 'bigint') return { __kv_type: 'bigint', value: v.toString() };
    if (v instanceof Uint8Array) return { __kv_type: 'Uint8Array', value: Array.from(v) };
    if (v instanceof Date) return { __kv_type: 'Date', value: v.toISOString() };
    if (v instanceof Map) return { __kv_type: 'Map', value: Array.from(v.entries()) };
    if (v instanceof Set) return { __kv_type: 'Set', value: Array.from(v.values()) };
    if (typeof v === 'symbol') return { __kv_type: 'symbol', value: v.description };
    if (typeof v === 'function') return undefined;
    return v;
};

interface KvSerializedValue {
    __kv_type: 'bigint' | 'Uint8Array' | 'Date' | 'Map' | 'Set' | 'symbol';
    value: unknown;
}

function isKvSerializedValue(v: unknown): v is KvSerializedValue {
    return v !== null && typeof v === 'object' && '__kv_type' in v;
}

const LEGACY_JSON_DESERIALIZER = (_key: string, v: unknown): unknown => {
    if (isKvSerializedValue(v)) {
        switch (v.__kv_type) {
            case 'bigint': return BigInt(v.value as string);
            case 'Uint8Array': return new Uint8Array(v.value as number[]);
            case 'Date': return new Date(v.value as string);
            case 'Map': return new Map(v.value as [unknown, unknown][]);
            case 'Set': return new Set(v.value as unknown[]);
            case 'symbol': return Symbol(v.value as string | undefined);
        }
    }
    return v;
};

export function serializeValue(value: unknown): Uint8Array {
    return engine.serialize(value);
}

export function deserializeValue<T>(data: Uint8Array): T {
    try {
        return engine.deserialize(new Uint8Array(data)) as T;
    } catch {
        const json = textDecoder.decode(data);
        return JSON.parse(json, LEGACY_JSON_DESERIALIZER) as T;
    }
}

export function serializeLegacyValue(value: unknown): Uint8Array {
    const json = JSON.stringify(value, LEGACY_JSON_SERIALIZER);
    return textEncoder.encode(json);
}

export function compareKeys(a: KvKey, b: KvKey): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const cmp = compareKeyPart(a[i], b[i]);
        if (cmp !== 0) return cmp;
    }
    return a.length - b.length;
}

export function compareKeyPart(a: KvKeyPart, b: KvKeyPart): number {
    const typeA = getKeyPartType(a);
    const typeB = getKeyPartType(b);

    if (typeA !== typeB) {
        return KEY_PART_TYPE_ORDER[typeA] - KEY_PART_TYPE_ORDER[typeB];
    }

    switch (typeA) {
        case 'boolean':
            return (a as boolean) === (b as boolean) ? 0 : (a as boolean) ? 1 : -1;
        case 'number': {
            const numA = a as number;
            const numB = b as number;
            if (Number.isNaN(numA)) return Number.isNaN(numB) ? 0 : -1;
            if (Number.isNaN(numB)) return 1;
            return numA - numB;
        }
        case 'bigint':
            return (a as bigint) < (b as bigint) ? -1 : ((a as bigint) > (b as bigint) ? 1 : 0);
        case 'string':
            return (a as string).localeCompare(b as string);
        case 'Uint8Array': {
            const arrA = a as Uint8Array;
            const arrB = b as Uint8Array;
            const minLen = Math.min(arrA.length, arrB.length);
            for (let i = 0; i < minLen; i++) {
                if (arrA[i] !== arrB[i]) return arrA[i] - arrB[i];
            }
            return arrA.length - arrB.length;
        }
        default:
            return 0;
    }
}

export function getKeyPartType(part: KvKeyPart): string {
    if (typeof part === 'boolean') return 'boolean';
    if (typeof part === 'number') return 'number';
    if (typeof part === 'bigint') return 'bigint';
    if (typeof part === 'string') return 'string';
    if (part instanceof Uint8Array) return 'Uint8Array';
    return 'unknown';
}

export function keyStartsWith(key: Deno.KvKey, prefix: Deno.KvKey): boolean {
    if (prefix.length > key.length) return false;
    for (let i = 0; i < prefix.length; i++) {
        if (!keyPartsEqual(key[i], prefix[i])) return false;
    }
    return true;
}

export function keyPartsEqual(a: Deno.KvKeyPart, b: Deno.KvKeyPart): boolean {
    if (a === b) return true;
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
    return false;
}

export function encodeKeyPart(part: Deno.KvKeyPart): Uint8Array {
    return serializeKey([part]);
}

export function encodeKey(key: Deno.KvKey): Uint8Array {
    return serializeKey(key);
}

export function isValidKeyPart(part: unknown): part is Deno.KvKeyPart {
    if (typeof part === 'string') return true;
    if (typeof part === 'number') return Number.isFinite(part);
    if (typeof part === 'bigint') return true;
    if (typeof part === 'boolean') return true;
    if (part instanceof Uint8Array) return true;
    return false;
}

export function validateKey(key: Deno.KvKey): void {
    if (!Array.isArray(key)) {
        throw new TypeError('Key must be an array');
    }
    if (key.length === 0) {
        throw new TypeError('Key cannot be empty');
    }
    for (let i = 0; i < key.length; i++) {
        if (!isValidKeyPart(key[i])) {
            throw new TypeError(`Invalid key part at index ${i}: ${typeof key[i]}`);
        }
    }
}

export function isValidValue(value: unknown): boolean {
    if (value === undefined) return false;
    if (typeof value === 'function') return false;
    return true;
}

export function validateValue(value: unknown): void {
    if (!isValidValue(value)) {
        throw new TypeError('Value cannot be undefined or a function');
    }
}
