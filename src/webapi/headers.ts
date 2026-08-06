type HeaderValue = string | string[];
type HeaderRecord = Record<string, HeaderValue | undefined>;
type HeaderPair = [string, HeaderValue];
type HeadersLike = {
    forEach(callbackfn: (value: string, key: string) => void): void;
};

const SEPARATORS = '()<>@,;:\\"/[]?={}';

function isTokenCode(code: number): boolean {
    return code > 0x20 && code < 0x7f && SEPARATORS.indexOf(String.fromCharCode(code)) === -1;
}

function normalizeHeaderName(value: unknown): string {
    const name = String(value);
    if (name.length === 0) throw new TypeError('Invalid header name');
    for (let i = 0; i < name.length; i++) {
        if (!isTokenCode(name.charCodeAt(i))) throw new TypeError('Invalid header name');
    }
    return name.toLowerCase();
}

function normalizeHeaderValue(value: unknown): string {
    let result = String(value);
    let start = 0;
    let end = result.length;
    while (start < end && (result.charCodeAt(start) === 0x09 || result.charCodeAt(start) === 0x20)) start++;
    while (end > start && (result.charCodeAt(end - 1) === 0x09 || result.charCodeAt(end - 1) === 0x20)) end--;
    result = result.slice(start, end);
    for (let i = 0; i < result.length; i++) {
        const code = result.charCodeAt(i);
        if (code === 0x00 || code === 0x0a || code === 0x0d || code > 0xff) {
            throw new TypeError('Invalid header value');
        }
    }
    return result;
}

function readHeaderPair(value: unknown): [unknown, unknown] {
    if (value === null || value === undefined) {
        throw new TypeError('Header init sequence must contain name/value pairs');
    }
    const iterator = Reflect.get(Object(value), Symbol.iterator);
    if (typeof iterator !== 'function') {
        throw new TypeError('Header init sequence must contain name/value pairs');
    }
    const pair = Array.from(value as Iterable<unknown>);
    if (pair.length !== 2) {
        throw new TypeError('Header init sequence must contain name/value pairs');
    }
    return [pair[0], pair[1]];
}

function isIterable(value: unknown): value is Iterable<unknown> {
    return typeof value === 'object' && value !== null && typeof Reflect.get(value, Symbol.iterator) === 'function';
}

function isHeadersLike(value: unknown): value is HeadersLike {
    if (!value || typeof value !== 'object') return false;
    return (value instanceof Headers || Object.prototype.toString.call(value) === '[object Headers]')
        && typeof Reflect.get(value, 'forEach') === 'function';
}

export type HeadersGuard = 'none' | 'immutable' | 'request' | 'response';

export class Headers implements globalThis.Headers {
    #map = new Map<string, string[]>();
    #guard: HeadersGuard = 'none';

    /** `immutable` makes every mutation throw, as the spec requires. */
    static setGuard(headers: Headers, guard: HeadersGuard): void {
        headers.#guard = guard;
    }

    constructor(init?: HeadersInit | HeaderRecord | Array<HeaderPair> | Headers) {
        if (init === undefined) return;
        if (init === null) throw new TypeError('Headers init cannot be null');

        if (isHeadersLike(init)) {
            init.forEach((value, name) => this.append(name, value));
            return;
        }

        if (isIterable(init)) {
            for (const item of init) {
                const [name, value] = readHeaderPair(item);
                this.append(String(name), Array.isArray(value) ? value.join(', ') : String(value));
            }
            return;
        }

        if (typeof init === 'object') {
            for (const name of Object.keys(init)) {
                const value = (init as HeaderRecord)[name];
                this.append(name, Array.isArray(value) ? value.join(', ') : String(value));
            }
            return;
        }

        throw new TypeError('Invalid Headers init');
    }

    // Validation of name/value happens before the guard check, matching the spec order.
    #checkMutable(): void {
        if (this.#guard === 'immutable') throw new TypeError('immutable');
    }

    append(name: string, value: string): void {
        if (arguments.length < 2) throw new TypeError('Headers.append requires 2 arguments');
        const key = normalizeHeaderName(name);
        const next = normalizeHeaderValue(value);
        this.#checkMutable();
        const values = this.#map.get(key);
        if (key === 'set-cookie') {
            if (values) values.push(next);
            else this.#map.set(key, [next]);
        } else if (values) {
            values[0] = `${values[0]}, ${next}`;
        } else {
            this.#map.set(key, [next]);
        }
    }

    set(name: string, value: string): void {
        if (arguments.length < 2) throw new TypeError('Headers.set requires 2 arguments');
        const key = normalizeHeaderName(name);
        const next = normalizeHeaderValue(value);
        this.#checkMutable();
        this.#map.set(key, [next]);
    }

    get(name: string): string | null {
        if (arguments.length < 1) throw new TypeError('Headers.get requires 1 argument');
        const values = this.#map.get(normalizeHeaderName(name));
        return values ? values.join(', ') : null;
    }

    has(name: string): boolean {
        if (arguments.length < 1) throw new TypeError('Headers.has requires 1 argument');
        return this.#map.has(normalizeHeaderName(name));
    }

    delete(name: string): void {
        if (arguments.length < 1) throw new TypeError('Headers.delete requires 1 argument');
        const key = normalizeHeaderName(name);
        this.#checkMutable();
        this.#map.delete(key);
    }

    forEach<ThisArg = this>(
        callbackfn: (this: ThisArg, value: string, key: string, parent: this) => void,
        thisArg?: ThisArg,
    ): void {
        if (arguments.length < 1 || typeof callbackfn !== 'function') {
            throw new TypeError('Headers.forEach requires a callback');
        }
        for (const [name, value] of this.entries()) {
            callbackfn.call(thisArg as ThisArg, value, name, this);
        }
    }

    *entries(): IterableIterator<[string, string]> {
        let index = 0;
        while (true) {
            const entries: Array<[string, string]> = [];
            const names = Array.from(this.#map.keys()).sort((a, b) => a.localeCompare(b));
            for (const name of names) {
                const values = this.#map.get(name);
                if (values === undefined) continue;
                if (name === 'set-cookie') {
                    for (const value of values) entries.push([name, value]);
                } else {
                    entries.push([name, values[0] ?? '']);
                }
            }
            const entry = entries[index++];
            if (!entry) return;
            yield entry;
        }
    }

    *keys(): IterableIterator<string> {
        for (const [name] of this.entries()) yield name;
    }

    *values(): IterableIterator<string> {
        for (const [, value] of this.entries()) yield value;
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries();
    }

    getSetCookie(): string[] {
        return [...(this.#map.get('set-cookie') ?? [])];
    }

    get [Symbol.toStringTag]() {
        return 'Headers';
    }
}
