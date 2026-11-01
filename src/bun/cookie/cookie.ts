export type CookieSameSite = 'strict' | 'lax' | 'none';
export interface CookieOptions {
    name?: string;
    value?: string;
    domain?: string;
    path?: string;
    expires?: Date | number | string;
    maxAge?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: CookieSameSite;
    partitioned?: boolean;
}

const invalidName = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;
const invalidPath = /[^\x20-\x7e]|;/;
const invalidDomain = /[^a-z0-9.\-]/;
const sameSiteError = "Invalid sameSite value. Must be 'strict', 'lax', or 'none'";
const asString = (value: unknown): string => {
    if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    return `${value}`;
};
const instances = new WeakSet<object>();
function missingArguments(): TypeError {
    return Object.assign(new TypeError('Not enough arguments'), { code: 'ERR_MISSING_ARGS' });
}

export class Cookie {
    #name: string;
    #value = '';
    #domain: string | undefined;
    #path = '/';
    #expires: Date | undefined;
    #maxAge: number | undefined;
    #secure = false;
    #httpOnly = false;
    #sameSite: CookieSameSite = 'lax';
    #partitioned = false;

    constructor(name: string, value: string, options?: CookieOptions);
    constructor(init: CookieOptions | string);
    constructor(nameOrInit: string | CookieOptions, value?: string, options: CookieOptions = {}) {
        instances.add(this);
        if (arguments.length === 0 || (arguments.length === 1 && nameOrInit == null)) throw missingArguments();
        if (arguments.length === 1 && typeof nameOrInit === 'string') {
            if (!nameOrInit) throw new TypeError('Invalid cookie string: empty');
            const parsed = Cookie.parse(nameOrInit);
            this.#name = parsed.name;
            this.#value = parsed.value;
            this.#domain = parsed.domain;
            this.#path = parsed.path;
            this.#expires = parsed.expires;
            this.#maxAge = parsed.maxAge;
            this.#secure = parsed.secure;
            this.#httpOnly = parsed.httpOnly;
            this.#sameSite = parsed.sameSite;
            this.#partitioned = parsed.partitioned;
            return;
        }
        if (arguments.length === 1 && typeof nameOrInit !== 'object' && typeof nameOrInit !== 'function') throw missingArguments();
        if (arguments.length > 1 && options != null && typeof options !== 'object' && typeof options !== 'function') throw new TypeError('Options must be an object');
        const init = (arguments.length === 1 ? nameOrInit : options) as CookieOptions ?? {};
        const name = arguments.length === 1 ? init.name : nameOrInit;
        if (arguments.length === 1 && !('name' in init)) throw new TypeError('name is required');
        this.#name = asString(name);
        if (!this.#name) throw new TypeError('name is required');
        if (invalidName.test(this.#name)) throw new TypeError('Invalid cookie name: contains invalid characters');
        this.value = arguments.length === 1 ? ('value' in init ? init.value : '') as string : value as string;
        if (init.domain != null) this.domain = init.domain;
        if (init.path != null) this.path = init.path;
        if (init.expires != null) this.expires = init.expires;
        // Constructor accepts non-finite numbers, unlike the setter.
        if (typeof init.maxAge === 'number') this.#maxAge = init.maxAge;
        if (init.secure != null) this.secure = init.secure;
        if (init.httpOnly != null) this.httpOnly = init.httpOnly;
        if (init.sameSite != null) this.sameSite = init.sameSite;
        if (init.partitioned != null) this.partitioned = init.partitioned;
    }

    static parse(input: string): Cookie {
        if (arguments.length === 0) throw missingArguments();
        const text = asString(input);
        if (text.trim() !== text || /[\x00-\x08\x0a-\x1f\x7f]/.test(text)) throw new TypeError('cookie string is not a valid HTTP header value');
        const parts = text.split(';');
        const first = parts.shift()!;
        const eq = first.indexOf('=');
        if (eq < 0) throw new TypeError(text.length === 1 ? 'Invalid cookie string: empty' : text === '' ? 'Invalid cookie name: contains invalid characters' : "Invalid cookie string: no '=' found");
        const name = first.slice(0, eq).trim();
        if (!name) throw new TypeError(text.length === 1 ? 'Invalid cookie string: empty' : 'Invalid cookie string: name cannot be empty');
        const cookie = new Cookie(name, first.slice(eq + 1).trim());
        for (const part of parts) {
            const i = part.indexOf('=');
            const key = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
            const val = i < 0 ? '' : part.slice(i + 1).trim();
            switch (key) {
                case 'domain': if (val) cookie.domain = val.toLowerCase(); break;
                case 'path': if (val.startsWith('/')) cookie.path = val; break;
                case 'expires': { const date = new Date(val); if (/[a-z]/i.test(val) && !Number.isNaN(date.getTime())) cookie.expires = date; break; }
                case 'max-age': {
                    const digits = /^[+-]?\d+/.exec(val)?.[0];
                    if (digits) {
                        const n = BigInt(digits);
                        if (n >= -9223372036854775808n && n <= 9223372036854775807n) cookie.maxAge = Number(n);
                    }
                    break;
                }
                case 'secure': cookie.secure = true; break;
                case 'httponly': cookie.httpOnly = true; break;
                case 'partitioned': cookie.partitioned = true; break;
                case 'samesite': if (['strict', 'lax', 'none'].includes(val.toLowerCase())) cookie.sameSite = val.toLowerCase() as CookieSameSite; break;
            }
        }
        return cookie;
    }
    static from(name: string, value: string, options?: CookieOptions): Cookie {
        if (arguments.length < 2) throw missingArguments();
        return new Cookie(name, value, options);
    }
    get name(): string { return this.#name; }
    get value(): string { return this.#value; }
    set value(value: string) { this.#value = asString(value); }
    get domain(): string | undefined { return this.#domain; }
    set domain(value: string | undefined) {
        const string = asString(value);
        if (invalidDomain.test(string)) throw new TypeError('Invalid cookie domain: contains invalid characters');
        this.#domain = string || undefined;
    }
    get path(): string { return this.#path; }
    set path(value: string) {
        const string = asString(value);
        if (invalidPath.test(string)) throw new TypeError('Invalid cookie path: contains invalid characters');
        this.#path = string;
    }
    get expires(): Date | undefined { return this.#expires && new Date(this.#expires.getTime()); }
    set expires(value: Date | number | string | undefined) {
        if (value == null) { this.#expires = undefined; return; }
        let date: Date;
        if (value instanceof Date) {
            if (Number.isNaN(value.getTime())) throw new RangeError('expires must be a valid Date (or Number)');
            date = new Date(value.getTime());
        } else if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new RangeError('expires must be a valid Number (or Date)');
            date = new Date(value * 1000);
        } else if (typeof value === 'string') {
            date = new Date(value);
            if (Number.isNaN(date.getTime())) throw new TypeError('Invalid cookie expiration date');
        } else throw new TypeError(`The argument 'expires' Invalid expires value. Must be a Date or a number. Received ${typeof value === 'symbol' ? String(value) : JSON.stringify(value)}`);
        this.#expires = Number.isNaN(date.getTime()) ? undefined : date;
    }
    get maxAge(): number | undefined { return this.#maxAge; }
    set maxAge(value: number | undefined) {
        if (value == null) { this.#maxAge = undefined; return; }
        const n = +value;
        if (!Number.isFinite(n)) throw new TypeError('The provided value is non-finite');
        this.#maxAge = n;
    }
    get secure(): boolean { return this.#secure; }
    set secure(value: boolean) { this.#secure = Boolean(value); }
    get httpOnly(): boolean { return this.#httpOnly; }
    set httpOnly(value: boolean) { this.#httpOnly = Boolean(value); }
    get sameSite(): CookieSameSite { return this.#sameSite; }
    set sameSite(value: CookieSameSite) {
        const s = asString(value).toLowerCase();
        if (s !== 'strict' && s !== 'lax' && s !== 'none') throw new TypeError(sameSiteError);
        this.#sameSite = s;
    }
    get partitioned(): boolean { return this.#partitioned; }
    set partitioned(value: boolean) { this.#partitioned = Boolean(value); }
    isExpired(): boolean { return this.#maxAge !== undefined && !Number.isNaN(this.#maxAge) ? this.#maxAge <= 0 : this.#expires !== undefined && this.#expires.getTime() <= Date.now(); }
    toString(): string { return this.#serialize(); }
    toJSON(): CookieOptions {
        const result: CookieOptions = Object.assign(Object.create(null), { name: this.#name, value: this.#value });
        if (this.#domain !== undefined) result.domain = this.#domain;
        result.path = this.#path;
        if (this.#expires !== undefined) result.expires = new Date(this.#expires.getTime());
        if (this.#maxAge !== undefined && !Number.isNaN(this.#maxAge)) result.maxAge = this.#maxAge;
        result.secure = this.#secure;
        result.sameSite = this.#sameSite;
        result.httpOnly = this.#httpOnly;
        result.partitioned = this.#partitioned;
        return result;
    }
    serialize(): string { return this.#serialize(); }
    #serialize(): string {
        const parts = [`${this.#name}=${encodeURIComponent(this.#value)}`];
        if (this.#domain) parts.push(`Domain=${this.#domain}`);
        if (this.#path) parts.push(`Path=${this.#path}`);
        if (this.#expires) parts.push(`Expires=${this.#expires.toUTCString()}`);
        if (this.#maxAge !== undefined && !Number.isNaN(this.#maxAge)) parts.push(`Max-Age=${this.#maxAge}`);
        if (this.#secure) parts.push('Secure');
        if (this.#httpOnly) parts.push('HttpOnly');
        if (this.#partitioned) parts.push('Partitioned');
        parts.push(`SameSite=${this.#sameSite[0].toUpperCase()}${this.#sameSite.slice(1)}`);
        return parts.join('; ');
    }
}
for (const name of Object.getOwnPropertyNames(Cookie.prototype)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(Cookie.prototype, name)!;
    const wrap = (fn: Function): Function => {
        const wrapped = function (this: object, ...args: unknown[]) {
            if (!instances.has(this)) throw Object.assign(new TypeError(`Can only call Cookie.${name} on instances of Cookie`), { code: 'ERR_INVALID_THIS' });
            return fn.apply(this, args);
        };
        Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
        Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true });
        return wrapped;
    };
    if (descriptor.value) descriptor.value = wrap(descriptor.value);
    if (descriptor.get) descriptor.get = wrap(descriptor.get) as () => unknown;
    if (descriptor.set) descriptor.set = wrap(descriptor.set) as (value: unknown) => void;
    descriptor.enumerable = true;
    Object.defineProperty(Cookie.prototype, name, descriptor);
}
Object.defineProperty(Cookie.prototype, Symbol.toStringTag, { value: 'Cookie', configurable: true });
