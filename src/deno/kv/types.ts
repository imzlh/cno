/**
 * Deno KV Types
 * Based on Deno 1.40+ KV API
 */

import { arrayBufferBackedBytes, concatChunks, toOwnedBytes } from '../../utils/bytes';
import { KvU64, isKvU64 } from './u64';

const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');
const bjson = import.meta.use('bjson');
const crypto = import.meta.use('crypto');

export type KvKeyPart = Deno.KvKeyPart;
export type KvKey = Deno.KvKey;

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

export interface KvQueueEntry {
    id: string;
    data: unknown;
    retryCount: number;
    scheduledAt: number;
    undeliveredKeys?: KvKey[];
    backoffSchedule?: number[];
}

export enum OP {
    CHECK = 0,
    SET,
    DELETE,
    SUM,
    MAX,
    MIN,
    ENQUEUE
}

export const KV_QUEUE_PREFIX = '__kv_queue__';
export const MAX_KV_DELAY = 30 * 24 * 60 * 60 * 1000;
export const MAX_KV_KEY_BYTES = 2048;
export const MAX_KV_VALUE_BYTES = 64 * 1024;
export const DEFAULT_QUEUE_BACKOFF = [100, 200, 400, 800];
export const COMMIT_VERSIONSTAMP_KEY = Symbol('Deno.Kv.commitVersionstamp');
const KV_U64_VALUE_PREFIX = new Uint8Array([0x43, 0x4e, 0x4f, 0x4b, 0x56, 0x55, 0x36, 0x34, 0x00]);

function hasPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
    if (value.byteLength < prefix.byteLength) return false;
    for (let i = 0; i < prefix.byteLength; i++) {
        if (value[i] !== prefix[i]) return false;
    }
    return true;
}

function validateDelay(name: string, value: number | undefined): number {
    if (value === undefined) return 0;
    if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative integer`);
    }
    if (value > MAX_KV_DELAY) {
        throw new TypeError(`${name} cannot exceed 30 days`);
    }
    return value;
}

export function validateExpireIn(expireIn: number | undefined): void {
    if (expireIn === undefined) return;
    validateDelay('expireIn', expireIn);
}

export function normalizeQueueOptions(options?: KvQueueOptions): Required<Pick<KvQueueOptions, 'delay' | 'backoffSchedule'>> & { keysIfUndelivered?: KvKey[] } {
    const delay = validateDelay('delay', options?.delay);
    const rawBackoff = options?.backoffSchedule ?? DEFAULT_QUEUE_BACKOFF;
    if (!Array.isArray(rawBackoff)) throw new TypeError('backoffSchedule must be an array');
    const backoffSchedule = rawBackoff.map(delay => validateDelay('backoffSchedule values', delay));

    const keysIfUndelivered = options?.keysIfUndelivered;
    if (keysIfUndelivered !== undefined) {
        if (!Array.isArray(keysIfUndelivered)) throw new TypeError('keysIfUndelivered must be an array');
        for (const key of keysIfUndelivered) validateKey(key);
    }

    return {
        delay,
        keysIfUndelivered: keysIfUndelivered?.slice(),
        backoffSchedule,
    };
}

export function prepareQueueEntry(data: unknown, options?: KvQueueOptions): { key: KvKey; entry: KvQueueEntry; delay: number } {
    const queueOptions = normalizeQueueOptions(options);
    const id = crypto.randomUUID();
    const scheduledAt = Date.now() + queueOptions.delay;
    const entry: KvQueueEntry = {
        id,
        data,
        retryCount: 0,
        scheduledAt,
        undeliveredKeys: queueOptions.keysIfUndelivered,
        backoffSchedule: queueOptions.backoffSchedule,
    };
    return {
        key: [KV_QUEUE_PREFIX, scheduledAt, id],
        entry,
        delay: queueOptions.delay,
    };
}

export interface KvWatchOptions {
    raw?: boolean;
}

export type RawKey = Uint8Array<ArrayBuffer>;

export type AtomicDbOperation =
    | { type: 'check'; key: RawKey; versionstamp: string | null }
    | { type: 'set'; key: RawKey; value: Uint8Array; expireIn?: number }
    | { type: 'delete'; key: RawKey }
    | { type: 'sum' | 'max' | 'min'; key: RawKey; operand: bigint };

export interface InternalEntry {
    key: RawKey;
    value: Uint8Array<ArrayBuffer>;
    versionstamp: string;
    expireAt: number | null;
}

const KEY_PART_TYPE_ORDER: Record<string, number> = {
    'Uint8Array': 0,
    'string': 1,
    'bigint': 2,
    'number': 3,
    'boolean': 4,
};

const TYPE_PREFIXES: Record<string, number> = {
    'Uint8Array': 0x10,
    'string': 0x20,
    'bigint': 0x30,
    'number': 0x40,
    'boolean': 0x50,
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

function appendBytes(target: number[], bytes: Uint8Array<ArrayBuffer>): void {
    for (const byte of bytes) target.push(byte);
}

function encodeEscapedBytes(target: number[], bytes: Uint8Array<ArrayBuffer>): void {
    for (const byte of bytes) {
        if (byte === 0) target.push(0, 0xFF);
        else target.push(byte);
    }
    target.push(0, 0);
}

function readByte(data: Uint8Array<ArrayBuffer>, offset: number, message: string): number {
    const byte = data[offset];
    if (byte === undefined) throw new TypeError(message);
    return byte;
}

function decodeEscapedBytes(data: Uint8Array<ArrayBuffer>, offset: number): { bytes: Uint8Array<ArrayBuffer>; offset: number } {
    const out: number[] = [];
    while (offset < data.length) {
        const byte = readByte(data, offset++, 'Invalid escaped key encoding');
        if (byte !== 0) {
            out.push(byte);
            continue;
        }
        if (offset >= data.length) throw new TypeError('Invalid escaped key encoding');
        const next = readByte(data, offset++, 'Invalid escaped key encoding');
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

function encodeNumber(value: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, Object.is(value, -0) ? 0 : value, false);
    if (value < 0) {
        algorithm.bytesInvert(out);
    } else {
        out[0] ^= 0x80;
    }
    return out;
}

function decodeNumber(data: Uint8Array<ArrayBuffer>, offset: number): { value: number; offset: number } {
    const bytes = data.slice(offset, offset + 8);
    if (bytes.length !== 8) throw new TypeError('Invalid number key encoding');
    const negative = (bytes[0] & 0x80) === 0;
    if (negative) {
        algorithm.bytesInvert(bytes);
    } else {
        bytes[0] ^= 0x80;
    }
    return {
        value: new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false),
        offset: offset + 8,
    };
}

function bigintToBytes(value: bigint): Uint8Array<ArrayBuffer> {
    let hex = value.toString(16);
    if (hex.length === 0) hex = '0';
    if (hex.length % 2) hex = `0${hex}`;
    const out = arrayBufferBackedBytes(new Uint8Array(crypto.hexDecode(hex)));
    return out.length ? out : new Uint8Array([0]);
}

function bytesToBigint(bytes: Uint8Array<ArrayBuffer>): bigint {
    const hex = crypto.hexEncode(bytes);
    return BigInt(`0x${hex || '0'}`);
}

function u32be(value: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
}

function readU32be(data: Uint8Array<ArrayBuffer>, offset: number): { value: number; offset: number } {
    if (offset + 4 > data.length) throw new TypeError('Invalid bigint key encoding');
    return {
        value: new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false),
        offset: offset + 4,
    };
}

function encodeBigint(value: bigint): Uint8Array<ArrayBuffer> {
    const negative = value < 0n;
    const magnitude = bigintToBytes(negative ? -value : value);
    const header = new Uint8Array(6);
    header[0] = TYPE_PREFIXES.bigint;
    header[1] = negative ? 0x00 : 0x01;
    header.set(u32be(negative ? 0xFFFFFFFF - magnitude.length : magnitude.length), 2);
    if (negative) {
        const payload = magnitude.slice();
        algorithm.bytesInvert(payload);
        return concatChunks([header, payload]);
    }
    return concatChunks([header, magnitude]);
}

function decodeBigint(data: Uint8Array<ArrayBuffer>, offset: number): { value: bigint; offset: number } {
    if (offset >= data.length) throw new TypeError('Invalid bigint key encoding');
    const sign = readByte(data, offset++, 'Invalid bigint key encoding');
    const lenInfo = readU32be(data, offset);
    offset = lenInfo.offset;
    const length = sign === 0x00 ? 0xFFFFFFFF - lenInfo.value : lenInfo.value;
    const bytes = data.slice(offset, offset + length);
    if (bytes.length !== length) throw new TypeError('Invalid bigint key payload');
    if (sign === 0x00) {
        algorithm.bytesInvert(bytes);
        return { value: -bytesToBigint(bytes), offset: offset + length };
    }
    return { value: bytesToBigint(bytes), offset: offset + length };
}

export function serializeKey(key: Deno.KvKey): RawKey {
    const out: number[] = [];
    for (const part of key) {
        if (typeof part === 'boolean') {
            out.push(TYPE_PREFIXES.boolean, part ? 1 : 0);
        } else if (typeof part === 'number') {
            out.push(TYPE_PREFIXES.number);
            appendBytes(out, encodeNumber(part));
        } else if (typeof part === 'bigint') {
            appendBytes(out, encodeBigint(part));
        } else if (typeof part === 'string') {
            out.push(TYPE_PREFIXES.string);
            encodeEscapedBytes(out, engine.encodeString(part));
        } else if (part instanceof Uint8Array) {
            out.push(TYPE_PREFIXES.Uint8Array);
            encodeEscapedBytes(out, arrayBufferBackedBytes(part));
        } else {
            throw new TypeError(`Unsupported key part type: ${getKeyPartType(part)}`);
        }
    }
    const encoded = new Uint8Array(out);
    if (encoded.byteLength > MAX_KV_KEY_BYTES) {
        throw new TypeError(`Key exceeds maximum serialized length of ${MAX_KV_KEY_BYTES} bytes`);
    }
    return encoded;
}

export function deserializeKey(rk: RawKey): Deno.KvKey {
    const key: KvKeyPart[] = [];
    let offset = 0;
    const rawKey = rk;
    while (offset < rawKey.length) {
        const tag = readByte(rawKey, offset++, 'Invalid key encoding');
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
                key.push(engine.decodeString(decoded.bytes));
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
    return crypto.hexEncode(new Uint8Array(rawKey));
}

export function cursorToRawKey(cursor: string): RawKey {
    if (cursor.length % 2 !== 0) throw new TypeError('Invalid cursor');
    return arrayBufferBackedBytes(new Uint8Array(crypto.hexDecode(cursor)));
}

export function compareRawKeys(a: RawKey, b: RawKey): number {
    return algorithm.bytesCompare(a, b);
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

export function serializeValue(value: unknown): Uint8Array<ArrayBuffer> {
    let encoded: Uint8Array<ArrayBuffer>;
    if (isKvU64(value)) {
        encoded = concatChunks([
            KV_U64_VALUE_PREFIX,
            engine.encodeString(value.value.toString()),
        ]);
    } else {
        encoded = toOwnedBytes(bjson.encode(value));
    }
    if (encoded.byteLength > MAX_KV_VALUE_BYTES) {
        throw new TypeError(`Value exceeds maximum serialized length of ${MAX_KV_VALUE_BYTES} bytes`);
    }
    return encoded;
}

export function deserializeValue<T>(data: Uint8Array<ArrayBuffer>): T {
    if (hasPrefix(data, KV_U64_VALUE_PREFIX)) {
        const raw = data.slice(KV_U64_VALUE_PREFIX.byteLength);
        return new KvU64(BigInt(engine.decodeString(raw))) as T;
    }
    return bjson.decode(new Uint8Array(data)) as T;
}

export function serializeLegacyValue(value: unknown): Uint8Array<ArrayBuffer> {
    const json = JSON.stringify(value, LEGACY_JSON_SERIALIZER);
    return engine.encodeString(json);
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

    if (typeof a === 'boolean' && typeof b === 'boolean') {
        return a === b ? 0 : a ? 1 : -1;
    }
    if (typeof a === 'number' && typeof b === 'number') {
        if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1;
        if (Number.isNaN(b)) return 1;
        return a - b;
    }
    if (typeof a === 'bigint' && typeof b === 'bigint') {
        return a < b ? -1 : (a > b ? 1 : 0);
    }
    if (typeof a === 'string' && typeof b === 'string') {
        return algorithm.bytesCompare(engine.encodeString(a), engine.encodeString(b));
    }
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
        return algorithm.bytesCompare(a, b);
    }
    return 0;
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
        return algorithm.bytesEqual(a, b);
    }
    return false;
}

export function encodeKeyPart(part: Deno.KvKeyPart): Uint8Array<ArrayBuffer> {
    return serializeKey([part]);
}

export function encodeKey(key: Deno.KvKey): Uint8Array<ArrayBuffer> {
    return serializeKey(key);
}

export function isCommitVersionstampKeyPart(part: unknown): boolean {
    return part === COMMIT_VERSIONSTAMP_KEY;
}

export function resolveCommitVersionstampKey(key: Deno.KvKey, versionstamp: string): Deno.KvKey {
    if (!key.some(isCommitVersionstampKeyPart)) return key;
    if (key[key.length - 1] !== COMMIT_VERSIONSTAMP_KEY) {
        throw new TypeError('Invalid key part at index ' + key.findIndex(isCommitVersionstampKeyPart) + ': symbol');
    }
    return [...key.slice(0, -1), versionstamp] as Deno.KvKey;
}

export function isValidKeyPart(part: unknown): part is Deno.KvKeyPart {
    if (typeof part === 'string') return true;
    if (typeof part === 'number') return Number.isFinite(part);
    if (typeof part === 'bigint') return true;
    if (typeof part === 'boolean') return true;
    if (part instanceof Uint8Array) return true;
    return false;
}

export function validateKey(key: Deno.KvKey, options?: { allowEmpty?: boolean; allowCommitVersionstamp?: boolean }): void {
    if (!Array.isArray(key)) {
        throw new TypeError('Key must be an array');
    }
    if (key.length === 0 && !options?.allowEmpty) {
        throw new TypeError('Key cannot be empty');
    }
    for (let i = 0; i < key.length; i++) {
        if (isCommitVersionstampKeyPart(key[i])) {
            if (options?.allowCommitVersionstamp && i === key.length - 1) continue;
            throw new TypeError(`Invalid key part at index ${i}: symbol`);
        }
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
