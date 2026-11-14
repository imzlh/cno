// Bun.CookieMap subset: header parsing, get/set/delete/has, iteration, and
// Set-Cookie generation for changed entries.

import type { CookieInit, CookieSameSite, CookieStoreDeleteOptions } from 'bun';

export type { CookieInit, CookieSameSite, CookieStoreDeleteOptions };

const engine = import.meta.use('engine');

interface CookieRecord {
    name: string;
    value: string;
    domain?: string;
    path: string;
    expires?: Date;
    maxAge?: number;
    secure: boolean;
    sameSite: CookieSameSite;
    httpOnly: boolean;
    partitioned: boolean;
}

interface CookieIterationSource {
    cookies: CookieRecord[];
    deletions: number;
}

interface CookieIteratorState {
    source: CookieIterationSource;
    index: number;
    deletions: number;
    kind: 'entries' | 'keys' | 'values';
    done: boolean;
}

// RFC 6265 cookie-name token: no controls, whitespace, or separators.
const INVALID_NAME = /[\x00-\x20\x7f()<>@,;:\\"/[\]?={}]/;
const INVALID_ATTRIBUTE = /[\x00-\x1f\x7f;]/;
const DateConstructor = Date;
const dateGetTime = Date.prototype.getTime;
const dateGetUTCDay = Date.prototype.getUTCDay;
const dateGetUTCDate = Date.prototype.getUTCDate;
const dateGetUTCMonth = Date.prototype.getUTCMonth;
const dateGetUTCFullYear = Date.prototype.getUTCFullYear;
const dateGetUTCHours = Date.prototype.getUTCHours;
const dateGetUTCMinutes = Date.prototype.getUTCMinutes;
const dateGetUTCSeconds = Date.prototype.getUTCSeconds;
const EPOCH = new DateConstructor(0);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cookieMapInstances = new WeakSet<object>();
const cookieIteratorStates = new WeakMap<object, CookieIteratorState>();

function invalidThis(method: string): never {
    throw Object.assign(
        new TypeError(`Can only call CookieMap.${method} on instances of CookieMap`),
        { code: 'ERR_INVALID_THIS' },
    );
}

function assertInstance(value: unknown, method: string): void {
    if (typeof value !== 'object' || value === null || !cookieMapInstances.has(value)) invalidThis(method);
}

function missingArguments(): TypeError {
    return Object.assign(new TypeError('Not enough arguments'), { code: 'ERR_MISSING_ARGS' });
}

function asString(value: unknown, symbolMessage = 'Cannot convert a Symbol value to a string'): string {
    if (typeof value === 'symbol') throw new TypeError(symbolMessage);
    return `${value}`;
}

function optionsObject(value: unknown, nullIsEmpty: boolean): CookieInit {
    if (value === undefined || nullIsEmpty && value === null) return {};
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
        throw new TypeError('Options must be an object');
    }
    return value as CookieInit;
}

function createCookieIterator(
    source: CookieIterationSource,
    kind: CookieIteratorState['kind'],
): IterableIterator<[string, string]> | IterableIterator<string> {
    const iterator = Object.create(cookieIteratorPrototype) as IterableIterator<[string, string]>;
    cookieIteratorStates.set(iterator, { source, index: 0, deletions: source.deletions, kind, done: false });
    return iterator;
}

const iteratorParent = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
const cookieIteratorPrototype = Object.create(iteratorParent) as { next: () => IteratorResult<unknown> };
Object.defineProperties(cookieIteratorPrototype, {
    next: {
        configurable: true,
        enumerable: true,
        writable: true,
        value: function next(this: object): IteratorResult<unknown> {
            const state = typeof this === 'object' && this !== null ? cookieIteratorStates.get(this) : undefined;
            if (!state) {
                throw Object.assign(
                    new TypeError('Cannot call next() on a non-Iterator object'),
                    { code: 'ERR_INVALID_THIS' },
                );
            }
            if (state.done) return { value: undefined, done: true };
            state.index = Math.max(0, state.index - (state.source.deletions - state.deletions));
            state.deletions = state.source.deletions;
            const cookie = state.source.cookies[state.index++];
            if (!cookie) {
                state.done = true;
                return { value: undefined, done: true };
            }
            const value = state.kind === 'keys' ? cookie.name
                : state.kind === 'values' ? cookie.value
                    : [cookie.name, cookie.value];
            return { value, done: false };
        },
    },
    [Symbol.toStringTag]: {
        configurable: true,
        value: 'CookieMap Iterator',
    },
});

function validateName(name: string): void {
    if (name.length === 0 || INVALID_NAME.test(name)) {
        throw new TypeError(`Invalid cookie name: ${JSON.stringify(name)}`);
    }
}

function validateAttribute(name: string, value: string): void {
    if (INVALID_ATTRIBUTE.test(value)) throw new TypeError(`Invalid cookie ${name}: contains invalid characters`);
}

// Bun percent-encodes cookie values rather than rejecting delimiter, control,
// whitespace, non-ASCII, or percent characters.
function encodeValue(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hexDigit(byte: number): number {
    if (byte >= 48 && byte <= 57) return byte - 48;
    if (byte >= 65 && byte <= 70) return byte - 55;
    if (byte >= 97 && byte <= 102) return byte - 87;
    return -1;
}

function decodeValue(value: string): string {
    if (!value.includes('%')) return value;
    const bytes = engine.encodeString(value);
    let length = 0;
    for (let i = 0; i < bytes.length; i++) {
        let byte = bytes[i];
        if (byte === 37) {
            byte = 255;
            // Malformed escapes consume two following bytes when available.
            if (i + 2 < bytes.length) {
                const hi = hexDigit(bytes[i + 1]), lo = hexDigit(bytes[i + 2]);
                if (hi >= 0 && lo >= 0) byte = hi * 16 + lo;
                i += 2;
            }
        }
        bytes[length++] = byte;
    }
    let result = '';
    for (let i = 0; i < length;) {
        const first = bytes[i++];
        if (first < 128) { result += String.fromCharCode(first); continue; }
        const size = first >= 192 && first < 224 ? 2
            : first >= 224 && first < 240 ? 3
                : first >= 240 && first < 248 ? 4 : 1;
        let code = first & (127 >> size);
        let consumed = 1;
        while (consumed < size && i < length && (bytes[i] & 192) === 128) {
            code = code * 64 + (bytes[i++] & 63);
            consumed++;
        }
        // Bun replaces an invalid UTF-8 sequence once, including overlong ones.
        const minimum = size === 2 ? 128 : size === 3 ? 2048 : 65536;
        result += size === 1 || consumed !== size || code < minimum || code > 0x10ffff
            || code >= 0xd800 && code <= 0xdfff ? '\ufffd' : String.fromCodePoint(code);
    }
    return result;
}

function toDate(expires: number | Date | string): Date {
    let time: number | undefined;
    try {
        time = Reflect.apply(dateGetTime, expires, []) as number;
    } catch {}
    const date = time !== undefined
        ? new DateConstructor(time)
        : typeof expires === 'number'
            ? new DateConstructor(expires * 1000)
            : new DateConstructor(expires);
    if (Number.isNaN(Reflect.apply(dateGetTime, date, []))) throw new RangeError('Invalid cookie expires date');
    return date;
}

function httpDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${DAYS[Reflect.apply(dateGetUTCDay, date, [])]}, ${pad(Reflect.apply(dateGetUTCDate, date, []))} ${MONTHS[Reflect.apply(dateGetUTCMonth, date, [])]} `
        + `${Reflect.apply(dateGetUTCFullYear, date, [])} ${pad(Reflect.apply(dateGetUTCHours, date, []))}:${pad(Reflect.apply(dateGetUTCMinutes, date, []))}:`
        + `${pad(Reflect.apply(dateGetUTCSeconds, date, []))} GMT`;
}

function record(name: string, value: string, options: CookieInit = {}): CookieRecord {
    const domainValue = options.domain;
    const domain = domainValue == null ? undefined : asString(domainValue);
    const pathValue = options.path;
    const path = pathValue == null ? '/' : asString(pathValue);
    const expiresValue = options.expires;
    const maxAgeValue = options.maxAge;
    const secure = Boolean(options.secure);
    const httpOnly = Boolean(options.httpOnly);
    const partitioned = Boolean(options.partitioned);
    const sameSiteValue = options.sameSite;
    const sameSite = sameSiteValue == null ? 'lax' : asString(sameSiteValue).toLowerCase();

    validateName(name);
    if (domain !== undefined) validateAttribute('domain', domain);
    validateAttribute('path', path);
    if (sameSite !== 'strict' && sameSite !== 'lax' && sameSite !== 'none') {
        throw new TypeError("Invalid sameSite value. Must be 'strict', 'lax', or 'none'");
    }
    return {
        name,
        value,
        domain: domain || undefined,
        path,
        expires: expiresValue == null ? undefined : toDate(expiresValue),
        maxAge: typeof maxAgeValue === 'number' && !Number.isNaN(maxAgeValue) ? maxAgeValue : undefined,
        secure,
        sameSite: sameSite as CookieSameSite,
        httpOnly,
        partitioned,
    };
}

function serialize(cookie: CookieRecord): string {
    const parts = [`${cookie.name}=${encodeValue(cookie.value)}`];
    if (cookie.domain) parts.push(`Domain=${cookie.domain}`);
    if (cookie.path) parts.push(`Path=${cookie.path}`);
    if (cookie.expires) parts.push(`Expires=${httpDate(cookie.expires)}`);
    if (cookie.maxAge !== undefined) parts.push(`Max-Age=${cookie.maxAge}`);
    if (cookie.secure) parts.push('Secure');
    if (cookie.httpOnly) parts.push('HttpOnly');
    if (cookie.partitioned) parts.push('Partitioned');
    parts.push(`SameSite=${cookie.sameSite[0].toUpperCase()}${cookie.sameSite.slice(1)}`);
    return parts.join('; ');
}

function parseHeader(header: string): [string, string][] {
    const pairs: [string, string][] = [];
    for (const segment of header.split(';')) {
        const eq = segment.indexOf('=');
        if (eq === -1) continue;
        const name = segment.slice(0, eq).trim();
        if (name === '') continue;
        pairs.push([name, decodeValue(segment.slice(eq + 1).trim())]);
    }
    return pairs;
}

export class CookieMap implements Iterable<[string, string]> {
    readonly #cookies: CookieRecord[] = [];
    readonly #iterationSource: CookieIterationSource = { cookies: this.#cookies, deletions: 0 };
    // Names touched by set/delete since construction, in last-touch order.
    readonly #changed = new Map<string, CookieRecord>();

    #markChanged(name: string, cookie: CookieRecord): void {
        this.#changed.delete(name);
        this.#changed.set(name, cookie);
    }

    constructor(init?: string[][] | Record<string, string> | string) {
        cookieMapInstances.add(this);
        if (init === undefined || init === null) return;
        if (typeof init === 'string') {
            for (const [name, value] of parseHeader(init)) this.#cookies.push(record(name, value));
        } else if (Array.isArray(init)) {
            for (let i = 0; i < init.length; i++) {
                const pair = init[i];
                if (!Array.isArray(pair)) throw new TypeError('Expected each element to be an array of two strings');
                if (pair.length !== 2) throw new TypeError('Expected arrays of exactly two strings');
                const name = asString(pair[0], 'Cannot convert a symbol to a string');
                const value = asString(pair[1], 'Cannot convert a symbol to a string');
                this.#cookies.push(record(name, value));
            }
        } else if (typeof init === 'object' || typeof init === 'function') {
            for (const name of Object.getOwnPropertyNames(init)) {
                const value = asString((init as Record<string, unknown>)[name], 'Cannot convert a symbol to a string');
                this.#cookies.push(record(name, value));
            }
        } else {
            throw new TypeError('Invalid initializer type');
        }
    }

    get size(): number {
        if (!cookieMapInstances.has(this)) throw new TypeError('Type error');
        return this.#cookies.length;
    }

    get(name: string): string | null {
        assertInstance(this, 'get');
        const key = asString(name);
        return this.#cookies.find(cookie => cookie.name === key)?.value ?? null;
    }

    has(name: string): boolean {
        assertInstance(this, 'has');
        const key = asString(name);
        return this.#cookies.some(cookie => cookie.name === key);
    }

    set(name: string, value: string, options?: CookieInit): void;
    set(options: CookieInit): void;
    set(nameOrOptions: string | CookieInit, value?: string, options: CookieInit = {}): void {
        assertInstance(this, 'set');
        if (arguments.length === 0) return;
        let cookie: CookieRecord;
        if (typeof nameOrOptions === 'string') {
            if (arguments.length < 2) throw missingArguments();
            const stringValue = asString(value);
            cookie = record(nameOrOptions, stringValue, optionsObject(options, true));
        } else {
            if ((typeof nameOrOptions !== 'object' || nameOrOptions === null) && typeof nameOrOptions !== 'function') {
                throw missingArguments();
            }
            if (!('name' in nameOrOptions)) throw new TypeError('name is required');
            const name = asString(nameOrOptions.name);
            const optionValue = 'value' in nameOrOptions ? asString(nameOrOptions.value) : '';
            cookie = record(name, optionValue, nameOrOptions);
        }
        const index = this.#cookies.findIndex(current => current.name === cookie.name);
        if (cookie.value === '') {
            let removedAny = false;
            for (let i = this.#cookies.length - 1; i >= 0; i--) {
                if (this.#cookies[i].name === cookie.name) {
                    this.#cookies.splice(i, 1);
                    removedAny = true;
                }
            }
            if (removedAny) this.#iterationSource.deletions++;
        } else {
            // Bun lists newly changed cookies before untouched constructor entries,
            // including when an existing name is updated.
            if (index < 0) this.#cookies.unshift(cookie);
            else {
                for (let i = this.#cookies.length - 1; i >= 0; i--) {
                    if (this.#cookies[i].name === cookie.name) this.#cookies.splice(i, 1);
                }
                this.#cookies.unshift(cookie);
            }
        }
        this.#markChanged(cookie.name, cookie);
    }

    delete(name: string): void;
    delete(options: CookieStoreDeleteOptions): void;
    delete(name: string, options: Omit<CookieStoreDeleteOptions, 'name'>): void;
    delete(nameOrOptions: string | CookieStoreDeleteOptions, options: Omit<CookieStoreDeleteOptions, 'name'> = {}): void {
        assertInstance(this, 'delete');
        if (arguments.length === 0) return;
        let name: unknown;
        let deleteOptions: CookieStoreDeleteOptions;
        if (typeof nameOrOptions === 'string') {
            name = nameOrOptions;
            deleteOptions = optionsObject(options, false) as CookieStoreDeleteOptions;
        } else if (typeof nameOrOptions === 'object' && nameOrOptions !== null || typeof nameOrOptions === 'function') {
            deleteOptions = nameOrOptions as CookieStoreDeleteOptions;
            name = deleteOptions.name;
        } else {
            throw new TypeError('Cookie name is required');
        }
        const domainValue = deleteOptions.domain;
        const domain = domainValue == null ? undefined : asString(domainValue);
        const pathValue = deleteOptions.path;
        const path = pathValue == null ? '/' : asString(pathValue);
        if (typeof name !== 'string') throw new TypeError('Cookie name is required');
        validateName(name);
        if (domain !== undefined) validateAttribute('domain', domain);
        validateAttribute('path', path);
        const removed: CookieRecord = {
            name,
            value: '',
            domain: domain || undefined,
            path,
            expires: new DateConstructor(Reflect.apply(dateGetTime, EPOCH, [])),
            secure: false,
            sameSite: 'lax',
            httpOnly: false,
            partitioned: false,
        };
        let removedAny = false;
        for (let i = this.#cookies.length - 1; i >= 0; i--) {
            if (this.#cookies[i].name === name) {
                this.#cookies.splice(i, 1);
                removedAny = true;
            }
        }
        if (removedAny) this.#iterationSource.deletions++;
        this.#markChanged(name, removed);
    }

    toSetCookieHeaders(): string[] {
        assertInstance(this, 'toSetCookieHeaders');
        return [...this.#changed.values()].map(serialize);
    }

    toJSON(): Record<string, string> {
        assertInstance(this, 'toJSON');
        const json: Record<string, string> = {};
        for (const { name, value } of this.#cookies) {
            if (!Object.prototype.hasOwnProperty.call(json, name)) {
                Object.defineProperty(json, name, { value, enumerable: true, configurable: true, writable: true });
            }
        }
        return json;
    }

    entries(): IterableIterator<[string, string]> {
        assertInstance(this, 'entries');
        return createCookieIterator(this.#iterationSource, 'entries') as IterableIterator<[string, string]>;
    }

    keys(): IterableIterator<string> {
        assertInstance(this, 'keys');
        return createCookieIterator(this.#iterationSource, 'keys') as IterableIterator<string>;
    }

    values(): IterableIterator<string> {
        assertInstance(this, 'values');
        return createCookieIterator(this.#iterationSource, 'values') as IterableIterator<string>;
    }

    forEach(callback: (value: string, key: string, map: CookieMap) => void, thisArg: unknown = undefined): void {
        assertInstance(this, 'forEach');
        if (typeof callback !== 'function') {
            throw Object.assign(
                new TypeError('Cannot call callback on a non-function'),
                { code: 'ERR_INVALID_ARG_TYPE' },
            );
        }
        for (const [name, value] of this.entries()) callback.call(thisArg, value, name, this);
    }
}

for (const property of [
    'get', 'toSetCookieHeaders', 'has', 'set', 'delete',
    'entries', 'keys', 'values', 'forEach', 'toJSON',
] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(CookieMap.prototype, property);
    if (descriptor) Object.defineProperty(CookieMap.prototype, property, { ...descriptor, enumerable: true });
}

const sizeDescriptor = Object.getOwnPropertyDescriptor(CookieMap.prototype, 'size');
if (sizeDescriptor) {
    Object.defineProperty(CookieMap.prototype, 'size', {
        ...sizeDescriptor,
        enumerable: true,
        configurable: false,
    });
}

Object.defineProperties(CookieMap.prototype, {
    [Symbol.iterator]: {
        configurable: true,
        value: CookieMap.prototype.entries,
        writable: true,
    },
    [Symbol.toStringTag]: {
        configurable: true,
        value: 'CookieMap',
    },
});
