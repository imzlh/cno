// Bun.CookieMap subset: header parsing, get/set/delete/has, iteration, and
// Set-Cookie generation for changed entries.

export type CookieSameSite = 'strict' | 'lax' | 'none';

export interface CookieInit {
    name?: string;
    value?: string;
    domain?: string;
    /** Defaults to '/'. An empty string leaves the path to the browser. */
    path?: string;
    /** Milliseconds since the epoch, or a Date, or a date string. */
    expires?: number | Date | string;
    secure?: boolean;
    /** Defaults to 'lax'. */
    sameSite?: CookieSameSite;
    httpOnly?: boolean;
    partitioned?: boolean;
    maxAge?: number;
}

export interface CookieStoreDeleteOptions {
    name: string;
    domain?: string | null;
    path?: string;
}

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

// RFC 6265 cookie-name token: no controls, whitespace, or separators.
const INVALID_NAME = /[\x00-\x20\x7f()<>@,;:\\"/[\]?={}]/;
const INVALID_ATTRIBUTE = /[\x00-\x1f\x7f;]/;
const EPOCH = new Date(0);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

function toDate(expires: number | Date | string): Date {
    const date = expires instanceof Date
        ? new Date(expires.getTime())
        : typeof expires === 'number'
            ? new Date(expires)
            : new Date(expires);
    if (Number.isNaN(date.getTime())) throw new RangeError('Invalid cookie expires date');
    return date;
}

function httpDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} `
        + `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:`
        + `${pad(date.getUTCSeconds())} GMT`;
}

function record(name: string, value: string, options: CookieInit = {}): CookieRecord {
    validateName(name);
    if (options.domain !== undefined) validateAttribute('domain', options.domain);
    if (options.path !== undefined) validateAttribute('path', options.path);
    if (options.sameSite !== undefined &&
        options.sameSite !== 'strict' && options.sameSite !== 'lax' && options.sameSite !== 'none') {
        throw new TypeError("Invalid sameSite value. Must be 'strict', 'lax', or 'none'");
    }
    return {
        name,
        value,
        domain: options.domain || undefined,
        path: options.path ?? '/',
        expires: options.expires === undefined ? undefined : toDate(options.expires),
        maxAge: options.maxAge !== undefined && !Number.isNaN(options.maxAge) ? options.maxAge : undefined,
        secure: options.secure ?? false,
        sameSite: options.sameSite ?? 'lax',
        httpOnly: options.httpOnly ?? false,
        partitioned: options.partitioned ?? false,
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
    parts.push(`SameSite=${cookie.sameSite[0].toUpperCase()}${cookie.sameSite.slice(1)}`);
    if (cookie.partitioned) parts.push('Partitioned');
    return parts.join('; ');
}

function parseHeader(header: string): [string, string][] {
    const pairs: [string, string][] = [];
    for (const segment of header.split(';')) {
        const eq = segment.indexOf('=');
        if (eq === -1) continue;
        const name = segment.slice(0, eq).trim();
        if (name === '') continue;
        pairs.push([name, segment.slice(eq + 1).trim()]);
    }
    return pairs;
}

export class CookieMap implements Iterable<[string, string]> {
    readonly #cookies = new Map<string, CookieRecord>();
    // Names touched by set/delete since construction, in first-touch order.
    readonly #changed = new Map<string, CookieRecord>();

    constructor(init?: string[][] | Record<string, string> | string) {
        if (init === undefined || init === null) return;
        if (typeof init === 'string') {
            for (const [name, value] of parseHeader(init)) this.#cookies.set(name, record(name, value));
        } else if (Array.isArray(init)) {
            for (const pair of init) {
                if (!Array.isArray(pair) || pair.length !== 2) {
                    throw new TypeError('CookieMap array init entries must be [name, value] pairs');
                }
                const [name, value] = pair;
                this.#cookies.set(String(name), record(String(name), String(value)));
            }
        } else if (typeof init === 'object') {
            for (const [name, value] of Object.entries(init)) {
                this.#cookies.set(name, record(name, String(value)));
            }
        } else {
            throw new TypeError('CookieMap init must be a string, string[][], or record');
        }
    }

    get size(): number {
        return this.#cookies.size;
    }

    get(name: string): string | null {
        return this.#cookies.get(String(name))?.value ?? null;
    }

    has(name: string): boolean {
        return this.#cookies.has(String(name));
    }

    set(name: string, value: string, options?: CookieInit): void;
    set(options: CookieInit): void;
    set(nameOrOptions: string | CookieInit, value?: string, options?: CookieInit): void {
        let cookie: CookieRecord;
        if (typeof nameOrOptions === 'string') {
            cookie = record(nameOrOptions, String(value), options);
        } else {
            const { name, value: optionValue, ...rest } = nameOrOptions ?? {};
            if (typeof name !== 'string') throw new TypeError('CookieMap.set options require a string name');
            cookie = record(name, optionValue ?? '', rest);
        }
        const existed = this.#cookies.has(cookie.name);
        this.#cookies.set(cookie.name, cookie);
        // Bun lists newly changed cookies before untouched constructor entries,
        // while updates retain the existing key position.
        if (!existed) {
            const ordered = new Map<string, CookieRecord>([[cookie.name, cookie]]);
            for (const [name, current] of this.#cookies) if (name !== cookie.name) ordered.set(name, current);
            this.#cookies.clear();
            for (const [name, current] of ordered) this.#cookies.set(name, current);
        }
        this.#changed.set(cookie.name, cookie);
    }

    delete(name: string): void;
    delete(options: CookieStoreDeleteOptions): void;
    delete(name: string, options: Omit<CookieStoreDeleteOptions, 'name'>): void;
    delete(nameOrOptions: string | CookieStoreDeleteOptions, options?: Omit<CookieStoreDeleteOptions, 'name'>): void {
        const name = typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions?.name;
        if (typeof name !== 'string') throw new TypeError('CookieMap.delete requires a name');
        validateName(name);
        const deleteOptions = typeof nameOrOptions === 'string' ? options : nameOrOptions;
        const path = deleteOptions?.path ?? '/';
        const domain = deleteOptions?.domain ?? undefined;
        if (domain !== undefined) validateAttribute('domain', domain);
        validateAttribute('path', path);
        const removed: CookieRecord = {
            name,
            value: '',
            domain: domain || undefined,
            path,
            expires: new Date(EPOCH.getTime()),
            secure: false,
            sameSite: 'lax',
            httpOnly: false,
            partitioned: false,
        };
        this.#cookies.delete(name);
        this.#changed.set(name, removed);
    }

    toSetCookieHeaders(): string[] {
        return [...this.#changed.values()].map(serialize);
    }

    toJSON(): Record<string, string> {
        const json: Record<string, string> = {};
        for (const [name, cookie] of this.#cookies) json[name] = cookie.value;
        return json;
    }

    entries(): IterableIterator<[string, string]> {
        return [...this.#cookies].map(([name, cookie]): [string, string] => [name, cookie.value])[Symbol.iterator]();
    }

    keys(): IterableIterator<string> {
        return this.#cookies.keys();
    }

    values(): IterableIterator<string> {
        return [...this.#cookies.values()].map(cookie => cookie.value)[Symbol.iterator]();
    }

    forEach(callback: (value: string, key: string, map: CookieMap) => void): void {
        for (const [name, value] of this.entries()) callback(value, name, this);
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries();
    }

    get [Symbol.toStringTag](): string {
        return 'CookieMap';
    }
}
