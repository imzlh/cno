/**
 * Deno KV Types
 * Based on Deno 1.40+ KV API
 */

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

export type RawKey = string;

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

const TYPE_PREFIXES: Record<string, string> = {
    'boolean': '\x00',
    'number': '\x01',
    'bigint': '\x02',
    'string': '\x03',
    'Uint8Array': '\x04',
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

export function serializeKey(key: Deno.KvKey): RawKey {
    return JSON.stringify(key, (_, v) => {
        if (typeof v === 'bigint') return { __kv_type: 'bigint', value: v.toString() };
        if (v instanceof Uint8Array) return { __kv_type: 'Uint8Array', value: Array.from(v) };
        return v;
    });
}

export function deserializeKey(rawKey: RawKey): Deno.KvKey {
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

const JSON_SERIALIZER = (_key: string, v: unknown): unknown => {
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

const JSON_DESERIALIZER = (_key: string, v: unknown): unknown => {
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
    const json = JSON.stringify(value, JSON_SERIALIZER);
    return new TextEncoder().encode(json);
}

export function deserializeValue<T>(data: Uint8Array): T {
    const json = new TextDecoder().decode(data);
    return JSON.parse(json, JSON_DESERIALIZER) as T;
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
            return Number((a as bigint) - (b as bigint));
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

export function encodeKeyPart(part: Deno.KvKeyPart): string {
    const type = getKeyPartType(part as KvKeyPart);
    const prefix = TYPE_PREFIXES[type];
    
    switch (type) {
        case 'boolean':
            return prefix + ((part as boolean) ? '\x01' : '\x00');
        case 'number': {
            const buf = new ArrayBuffer(8);
            new DataView(buf).setFloat64(0, part as number, false);
            return prefix + String.fromCharCode(...new Uint8Array(buf));
        }
        case 'bigint': {
            const str = (part as bigint).toString(16);
            const sign = (part as bigint) >= 0n ? '\x01' : '\x00';
            return prefix + sign + str.padStart(32, '0');
        }
        case 'string':
            return prefix + (part as string);
        case 'Uint8Array': {
            const arr = part as Uint8Array;
            return prefix + String.fromCharCode(...arr);
        }
        default:
            return prefix;
    }
}

export function encodeKey(key: Deno.KvKey): string {
    return key.map(encodeKeyPart).join('\x00');
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
