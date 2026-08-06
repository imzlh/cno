// URL API Polyfill for QuickJS ng
// Full implementation of URL and URLSearchParams, supports special path formats

import { Blob, blobBytesSymbol } from './formdata';
import { sanitizeSurrogates } from '../utils/bytes';

const textMod = import.meta.use('text');
const utf8Encoder = new textMod.Encoder('utf-8');

/**
 * Percent-decode to bytes, then UTF-8 decode. The spec percent-decodes a byte
 * sequence and substitutes U+FFFD for malformed input; `String.fromCharCode`
 * per byte would instead hand back Latin-1 characters, and
 * `engine.decodeString` would leak WTF-8 lone surrogates.
 */
const percentDecodeUtf8 = (str: string): string => {
    const source = utf8Encoder.encode(sanitizeSurrogates(str));
    const out = new Uint8Array(source.length);
    let length = 0;
    for (let i = 0; i < source.length;) {
        // '%' followed by two hex digits — all ASCII, so a byte scan is safe.
        if (source[i] === 0x25 && i + 2 < source.length) {
            const hi = hexValue(source[i + 1]!);
            const lo = hexValue(source[i + 2]!);
            if (hi >= 0 && lo >= 0) {
                out[length++] = (hi << 4) | lo;
                i += 3;
                continue;
            }
        }
        out[length++] = source[i]!;
        i++;
    }
    return new textMod.Decoder().decode(out.subarray(0, length));
};

const hexValue = (byte: number): number => {
    if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
    if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
    if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
    return -1;
};

// ==================== Utility Functions ====================

const USERINFO_ENCODE_SET = /[^\w.~!$&'()*+,;=:-]/g;
const PATH_ENCODE_SET = /[^\w.~!$&'()*+,;=:@\/%-]/g;
// Backslash is a separator only for special schemes. In a hierarchical
// non-special URL it is ordinary path data and serializes literally.
const NON_SPECIAL_PATH_ENCODE_SET = /[^\w.~!$&'()*+,;=:@\/%\\-]/g;
const FRAGMENT_ENCODE_SET = /[^\w.~!$&'()*+,;=:@\/?%-]/g;
const objectUrlStore = new Map<string, Blob>();
let objectUrlCounter = 0;
const denoCustomInspect = Symbol.for('Deno.customInspect');

const isWindowsDriveLetter = (str: string): boolean => {
    return str.length === 2 &&
        /[a-zA-Z]/.test(str[0]) &&
        (str[1] === ':' || str[1] === '|');
};



const percentEncode = (str: string, encodeSet: RegExp): string => {
    let result = '';
    for (const char of str) {
        encodeSet.lastIndex = 0;
        const shouldEncode = encodeSet.test(char);
        encodeSet.lastIndex = 0;
        if (!shouldEncode) {
            result += char;
            continue;
        }
        try {
            result += encodeURIComponent(char).replace(/[!'()*]/g, (value) =>
                `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
            );
        } catch {
            result += '%EF%BF%BD';
        }
    }
    return result;
};

function createObjectUrlId(): string {
    objectUrlCounter++;
    return `blob:/cno-${Date.now().toString(36)}-${objectUrlCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function resolveObjectURL(url: string | globalThis.URL): Blob | null {
    try {
        return objectUrlStore.get(new URL(String(url)).href) ?? null;
    } catch {
        return null;
    }
}

export function resolveObjectURLBytes(url: string | globalThis.URL): { type: string; bytes: Uint8Array } | null {
    const blob = resolveObjectURL(url);
    if (!blob) return null;
    return { type: blob.type, bytes: blob[blobBytesSymbol]() };
}

const percentDecode = (str: string): string => {
    try {
        return decodeURIComponent(str);
    } catch {
        return percentDecodeUtf8(str);
    }
};

const URL_TEXT_ENCODE_SET = /[^\x21-\x7E]/;

// Lone surrogates make encodeURIComponent throw; the URL spec UTF-8-encodes
// them as U+FFFD instead.
const formUrlEncode = (str: string): string => {
    return encodeURIComponent(sanitizeSurrogates(str))
        .replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%20/g, '+');
};

const formUrlDecode = (str: string): string => {
    const normalized = str.replace(/\+/g, ' ').replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
    try {
        return decodeURIComponent(normalized);
    } catch {
        // Malformed UTF-8 in the escapes — decode to bytes and substitute U+FFFD.
        return percentDecodeUtf8(str.replace(/\+/g, ' '));
    }
};

const isIterable = (value: unknown): value is Iterable<unknown> => {
    if (value === null || value === undefined) return false;
    const iterator = Reflect.get(Object(value), Symbol.iterator);
    return typeof iterator === 'function';
};

/** `C:` / `c|` — a normalized Windows drive letter as a single path segment. */
const isWindowsDriveSegment = (segment: string | undefined): segment is string =>
    typeof segment === 'string' && /^[a-zA-Z][:|]$/.test(segment);

/**
 * Dot-segment classification, per the WHATWG URL path state.
 *
 * A single-dot segment is `.` or `%2e`; a double-dot segment is `..`, `.%2e`,
 * `%2e.` or `%2e%2e` — all ASCII case-insensitive. EVERYTHING else, including
 * the empty string, is an ordinary segment that must be preserved verbatim.
 * Treating `''` as a dot segment collapsed `/prefix//key.txt` to
 * `/prefix/key.txt` and `//x` to `/x`, which for an S3-style object key or any
 * server that distinguishes `//` names a different resource. The empty segment
 * is also what carries a trailing slash: `/a/b/` splits to `['a','b','']`.
 *
 * Compared with `toLowerCase` (never `toLocaleLowerCase`) against literal
 * ASCII, so the result does not depend on the host locale.
 */
const SINGLE_DOT_SEGMENTS = new Set(['.', '%2e']);
const DOUBLE_DOT_SEGMENTS = new Set(['..', '.%2e', '%2e.', '%2e%2e']);

/** 0 = ordinary segment, 1 = single-dot, 2 = double-dot. */
const dotSegmentKind = (segment: string): number => {
    // Every dot form is at most 6 characters, so longer segments skip the
    // lowercasing allocation entirely.
    if (segment.length === 0 || segment.length > 6) return 0;
    const lower = segment.toLowerCase();
    if (DOUBLE_DOT_SEGMENTS.has(lower)) return 2;
    if (SINGLE_DOT_SEGMENTS.has(lower)) return 1;
    return 0;
};

function requireArguments(name: string, actual: number, required: number): void {
    if (actual >= required) return;
    throw new TypeError(`${name} requires at least ${required} argument${required === 1 ? '' : 's'}`);
}

/**
 * URL parse failures must carry `code: 'ERR_INVALID_URL'` like Node's, or every
 * `catch (e) { if (e.code === 'ERR_INVALID_URL') ... }` in the wild silently
 * takes the wrong branch. Node also exposes the offending input as `.input`.
 */
function invalidUrl(message: string, input?: string): TypeError {
    const err = new TypeError(message) as TypeError & { code?: string; input?: string };
    err.code = 'ERR_INVALID_URL';
    if (input !== undefined) err.input = input;
    return err;
}

const normalizeWindowsPath = (path: string): string => {
    // C:\aaa\bbb -> C:/aaa/bbb
    // /C:\aaa -> C:/aaa
    // /C:/aaa -> C:/aaa

    path = path.replace(/\\/g, '/');

    // Remove leading slash (if followed by a drive letter)
    if (path.startsWith('/') && isWindowsDriveLetter(path.slice(1, 3))) {
        path = path.slice(1);
    }

    // Handle C| format
    if (isWindowsDriveLetter(path.slice(0, 2)) && path[1] === '|') {
        path = path[0] + ':' + path.slice(2);
    }

    return path;
};


// ==================== URLSearchParams ====================

class URLSearchParams implements URLSearchParams {
    #params: Array<[string, string]> = [];
    #updateCallback?: () => void;

    constructor(init?: string | URLSearchParams | Record<string, string> | Iterable<[string, string]>) {
        if (init === undefined || init === null) {
            return;
        }

        if (typeof init === 'string') {
            this.#parseQuery(init);
        } else if (init instanceof URLSearchParams) {
            this.#params = [...init.#params];
        } else if (typeof init === 'object') {
            if (isIterable(init)) {
                for (const pair of init) {
                    if (!isIterable(pair)) throw new TypeError('Each query pair must be iterable');
                    const values = [...pair];
                    if (values.length !== 2) {
                        throw new TypeError('Each query pair must contain exactly two items');
                    }
                    this.#params.push([String(values[0]), String(values[1])]);
                }
            } else {
                for (const [key, value] of Object.entries(init)) {
                    this.#params.push([key, String(value)]);
                }
            }
        }
    }

    #parseQuery(query: string): void {
        query = query.replace(/^\?/, '');

        if (!query) return;

        const pairs = query.split('&');
        for (const pair of pairs) {
            if (!pair) continue;

            const index = pair.indexOf('=');
            if (index === -1) {
                this.#params.push([formUrlDecode(pair), '']);
            } else {
                const key = formUrlDecode(pair.slice(0, index));
                const value = formUrlDecode(pair.slice(index + 1));
                this.#params.push([key, value]);
            }
        }
    }

    #notifyUpdate(): void {
        this.#updateCallback?.();
    }

    append(name: string, value: string): void {
        requireArguments('URLSearchParams.append', arguments.length, 2);
        this.#params.push([String(name), String(value)]);
        this.#notifyUpdate();
    }

    delete(name: string, value?: string): void {
        requireArguments('URLSearchParams.delete', arguments.length, 1);
        const nameStr = String(name);

        if (value !== undefined) {
            const valueStr = String(value);
            this.#params = this.#params.filter(
                ([k, v]) => !(k === nameStr && v === valueStr)
            );
        } else {
            this.#params = this.#params.filter(([k]) => k !== nameStr);
        }

        this.#notifyUpdate();
    }

    get(name: string): string | null {
        requireArguments('URLSearchParams.get', arguments.length, 1);
        const nameStr = String(name);
        const entry = this.#params.find(([k]) => k === nameStr);
        return entry ? entry[1] : null;
    }

    getAll(name: string): string[] {
        requireArguments('URLSearchParams.getAll', arguments.length, 1);
        const nameStr = String(name);
        return this.#params
            .filter(([k]) => k === nameStr)
            .map(([, v]) => v);
    }

    has(name: string, value?: string): boolean {
        requireArguments('URLSearchParams.has', arguments.length, 1);
        const nameStr = String(name);

        if (value !== undefined) {
            const valueStr = String(value);
            return this.#params.some(([k, v]) => k === nameStr && v === valueStr);
        }

        return this.#params.some(([k]) => k === nameStr);
    }

    set(name: string, value: string): void {
        requireArguments('URLSearchParams.set', arguments.length, 2);
        const nameStr = String(name);
        const valueStr = String(value);

        let found = false;
        this.#params = this.#params.filter(([k]) => {
            if (k === nameStr) {
                if (!found) {
                    found = true;
                    return true;
                }
                return false;
            }
            return true;
        });

        if (found) {
            const index = this.#params.findIndex(([k]) => k === nameStr);
            this.#params[index] = [nameStr, valueStr];
        } else {
            this.#params.push([nameStr, valueStr]);
        }

        this.#notifyUpdate();
    }

    sort(): void {
        this.#params.sort((a, b) => {
            if (a[0] < b[0]) return -1;
            if (a[0] > b[0]) return 1;
            return 0;
        });
        this.#notifyUpdate();
    }

    toString(): string {
        return this.#params
            .map(([key, value]) => {
                const encodedKey = formUrlEncode(key);
                const encodedValue = formUrlEncode(value);
                return `${encodedKey}=${encodedValue}`;
            })
            .join('&');
    }

    *entries(): URLSearchParamsIterator<[string, string]> {
        let index = 0;
        while (index < this.#params.length) {
            const [key, value] = this.#params[index];
            index++;
            yield [key, value];
        }
    }

    *keys(): URLSearchParamsIterator<string> {
        let index = 0;
        while (index < this.#params.length) {
            const [key] = this.#params[index];
            index++;
            yield key;
        }
    }

    *values(): URLSearchParamsIterator<string> {
        let index = 0;
        while (index < this.#params.length) {
            const [, value] = this.#params[index];
            index++;
            yield value;
        }
    }

    forEach(callback: (value: string, key: string, parent: this) => void, thisArg?: unknown): void {
        requireArguments('URLSearchParams.forEach', arguments.length, 1);
        for (const [key, value] of this.#params) {
            callback.call(thisArg, value, key, this);
        }
    }


    [Symbol.iterator](): URLSearchParamsIterator<[string, string]> {
        return this.entries();
    }

    get size(): number {
        return this.#params.length;
    }

    _setUpdateCallback(callback: () => void): void {
        this.#updateCallback = callback;
    }

    _replaceFromQuery(query: string): void {
        this.#params = [];
        this.#parseQuery(query);
    }

    _getParams(): Array<[string, string]> {
        return [...this.#params];
    }
    
    get [Symbol.toStringTag]() {
        return 'URLSearchParams';
    }
}

const SPECIAL_SCHEMES: Record<string, number> = {
    'ftp': 21,
    'file': -1,
    'http': 80,
    'https': 443,
    'ws': 80,
    'wss': 443
};

class URL implements globalThis.URL {
    #scheme = '';
    #username = '';
    #password = '';
    #host = '';
    #port = '';
    #path: string[] = [];
    /**
     * "Cannot-be-a-base" URLs (`data:`, `mailto:`, `blob:` — any non-special
     * scheme not followed by `//`) keep an opaque path: one verbatim string that
     * is never split, normalized, or given a leading `/`.
     */
    #opaquePath: string | null = null;
    #hasQuery = false;
    #query: string | null = null;
    #fragment = '';
    #hasFragment = false;
    #searchParams: URLSearchParams;

    static parse(url: string, base?: string | globalThis.URL): URL | null {
        try {
            return new URL(url, base);
        } catch {
            return null;
        }
    }

    static canParse(url: string, base?: string): boolean {
        try {
            new URL(url, base);
            return true;
        } catch {
            return false;
        }
    }

    constructor(url: string | globalThis.URL, base?: string | globalThis.URL) {
        this.#searchParams = new URLSearchParams();
        this.#searchParams._setUpdateCallback(() => {
            this.#query = this.#searchParams.toString();
            this.#hasQuery = this.#query !== '';
        });

        this.#parse(String(url), base);
    }

    #parse(input: string, base?: string | globalThis.URL): void {
        // Spec order: strip leading/trailing C0-controls-and-space, then remove
        // ALL tab/LF/CR from anywhere in the input.
        //
        // JS `.trim()` is wrong in both directions here: it strips Unicode spaces
        // the spec keeps (`#a ` must survive as `#a%C2%A0`, not become `#a`)
        // and keeps C0 controls the spec strips (`#a\u0000` must become `#a`).
        // And without the tab/LF/CR removal, `ht\ttp://x` throws where Node
        // parses it as `http://x/`.
        input = String(input)
            .replace(/^[\u0000- ]+/, '')
            .replace(/[\u0000- ]+$/, '')
            .replace(/[\t\n\r]/g, '');

        // Standard URL parsing
        const baseUrl = base ? (typeof base === 'string' ? new URL(base) : base as URL) : null;

        // Handle special formats (only when there is no base URL)
        if (!baseUrl) {
            if (this.#isWindowsPath(input)) {
                this.#parseWindowsPath(input);
                return;
            }

            if (this.#isUnixPath(input)) {
                this.#parseUnixPath(input);
                return;
            }
        }

        // Extract fragment
        const fragmentIndex = input.indexOf('#');
        if (fragmentIndex !== -1) {
            this.#hasFragment = true;
            this.#fragment = input.slice(fragmentIndex + 1);
            input = input.slice(0, fragmentIndex);
        }

        // Extract query
        const queryIndex = input.indexOf('?');
        if (queryIndex !== -1) {
            this.#hasQuery = true;
            this.#query = input.slice(queryIndex + 1);
            input = input.slice(0, queryIndex);
        }

        // Parse scheme
        const schemeMatch = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
        // Track whether the scheme came from the input or was inherited from the
        // base. The opaque-path branch below must only fire for a scheme spelled
        // out in the input: with an inherited scheme the spec is still in a
        // relative state, so `new URL('/a','git://base/x')` keeps the base's
        // authority (`git://base/a`) rather than becoming an opaque `git:/a`.
        const schemeFromInput = schemeMatch !== null;
        if (schemeMatch) {
            this.#scheme = schemeMatch[1].toLowerCase();
            input = input.slice(schemeMatch[0].length);
            while (input.startsWith(':')) {
                input = input.slice(1);
            }
        } else if (baseUrl) {
            this.#scheme = baseUrl.#scheme;
        } else {
            throw invalidUrl('Invalid URL: no scheme');
        }

        // Special scheme handling
        const isSpecial = this.#scheme in SPECIAL_SCHEMES;

        // A non-special scheme has an opaque path only when what follows the
        // scheme does NOT start with `/`. Per WHATWG, `/` enters "path or
        // authority state" and builds a list path, so `foo:/a/b` is a valid
        // base: `new URL('./x','foo:/a/b')` is `foo:/a/x`, not an error.
        // Testing for `//` instead misclassified every path-absolute
        // non-special URL — which is every `pack:/…` `import.meta.url`.
        // Only fires for a scheme spelled out in the input; an inherited scheme
        // means we are resolving a relative reference, which is not opaque.
        if (!isSpecial && schemeFromInput && !input.startsWith('/')) {
            this.#opaquePath = input;
            if (this.#query !== null) {
                this.#searchParams._replaceFromQuery(this.#query);
            }
            return;
        }

        // Relative reference against a base with an OPAQUE path: per the spec's
        // "no scheme state", ONLY a fragment-only reference is valid — anything
        // else is a parse failure. Node and Deno both throw for './x', '../x',
        // '/x', 'x', '?q' and even ''.
        //
        // The previous predicate tested `this.#fragment === null`, which is dead
        // code: #fragment initializes to '' and is only ever assigned a string,
        // so the guard never fired. That let '' and '?q' fall through to the
        // verbatim-copy branch below and silently produce
        // `data:text/plain,hello` / `data:text/plain,hello?q` where both oracles
        // throw. Test the explicit #hasFragment / #hasQuery flags instead.
        if (!isSpecial && !schemeFromInput && baseUrl !== null && baseUrl.#opaquePath !== null) {
            if (input !== '' || this.#hasQuery || !this.#hasFragment) {
                throw invalidUrl('Invalid URL');
            }
            // Fragment-only against an opaque base keeps the base path verbatim.
            this.#opaquePath = baseUrl.#opaquePath;
            if (this.#query === null && baseUrl.#hasQuery) {
                this.#query = baseUrl.#query;
                this.#hasQuery = true;
            }
            if (this.#query !== null) {
                this.#searchParams._replaceFromQuery(this.#query);
            }
            return;
        }

        // Parse authority
        if (input.startsWith('//')) {
            input = input.slice(2);

            const authorityEnd = input.search(isSpecial ? /[/?#\\]/ : /[/?#]/);
            const authority = authorityEnd === -1 ? input : input.slice(0, authorityEnd);
            const rest = authorityEnd === -1 ? '' : input.slice(authorityEnd);

            // "file host state": a Windows drive letter is never a host — it starts
            // the path (`file://C:/x` is `file:///C:/x`), and `localhost` drops.
            if (this.#scheme === 'file' && isWindowsDriveLetter(authority)) {
                input = '/' + authority + rest;
            } else {
                input = rest;
                this.#parseAuthority(authority);
                if (this.#scheme === 'file' && this.#host.toLowerCase() === 'localhost') {
                    this.#host = '';
                }
            }
        } else if (baseUrl && this.#scheme === baseUrl.#scheme) {
            this.#username = baseUrl.#username;
            this.#password = baseUrl.#password;
            this.#host = baseUrl.#host;
            this.#port = baseUrl.#port;
            this.#path = [...baseUrl.#path];
            if (input && !input.startsWith('/')) {
                if (this.#path.length > 0) {
                    this.#path.pop();
                }
            }
        }

        // Parse path
        if (input) {
            this.#parsePath(input, isSpecial);
        }

        // Update searchParams
        if (this.#query !== null) {
            this.#searchParams._replaceFromQuery(this.#query);
        }
    }

    #isWindowsPath(str: string): boolean {
        return /^[a-zA-Z]:[\/\\]/.test(str) || /^[a-zA-Z]\|[\/\\]/.test(str);
    }

    #isUnixPath(str: string): boolean {
        return str.startsWith('/') && !str.startsWith('//');
    }

    #parseWindowsPath(path: string): void {
        this.#scheme = 'file';
        path = normalizeWindowsPath(path);

        // C:/aaa/bbb -> ['C:','aaa','bbb']; the pathname getter adds the leading '/'
        this.#path = path.split('/').filter(p => p);
    }

    #parseUnixPath(path: string): void {
        this.#scheme = 'file';
        // Drop the leading empty segment only; the pathname getter adds the leading '/'
        this.#path = path.split('/').slice(1);
    }

    #parseAuthority(authority: string): void {
        // Extract userinfo
        const atIndex = authority.lastIndexOf('@');
        if (atIndex !== -1) {
            const userinfo = authority.slice(0, atIndex);
            authority = authority.slice(atIndex + 1);

            const colonIndex = userinfo.indexOf(':');
            if (colonIndex === -1) {
                this.#username = percentDecode(userinfo);
            } else {
                this.#username = percentDecode(userinfo.slice(0, colonIndex));
                this.#password = percentDecode(userinfo.slice(colonIndex + 1));
            }
        }

        // Extract host and port
        if (authority.startsWith('[')) {
            // IPv6
            const endBracket = authority.indexOf(']');
            if (endBracket === -1) {
                throw invalidUrl('Invalid URL: unclosed IPv6 address');
            }
            this.#host = authority.slice(0, endBracket + 1).toLowerCase();
            authority = authority.slice(endBracket + 1);
        } else {
            const colonIndex = authority.lastIndexOf(':');
            if (colonIndex === -1) {
                this.#host = authority.toLowerCase();
            } else {
                this.#host = authority.slice(0, colonIndex).toLowerCase();
                authority = authority.slice(colonIndex);
            }
        }

        // Extract port
        if (authority.startsWith(':')) {
            const portStr = authority.slice(1);
            if (portStr && /^\d+$/.test(portStr)) {
                const port = parseInt(portStr, 10);
                if (port > 65535) {
                    throw invalidUrl('Invalid URL: invalid port');
                }
                // Only set when non-default port
                const defaultPort = SPECIAL_SCHEMES[this.#scheme];
                if (defaultPort !== port) {
                    this.#port = String(port);
                }
            } else if (portStr) {
                throw invalidUrl('Invalid URL: invalid port');
            }
        }
    }

    #parsePath(path: string, isSpecial: boolean): void {
        // Special schemes treat `\` as a path separator (query/fragment are already split off).
        if (isSpecial) path = path.replace(/\\/g, '/');

        if (path.startsWith('/')) {
            // An absolute reference resets the path — except that for `file:` the
            // spec's path-start state PRESERVES a Windows drive letter from the
            // base. Without this, `new URL('/x','file:///C:/dir/f.txt')` yields
            // `file:///x` instead of Node's `file:///C:/x`, silently losing the
            // drive on the Windows module-resolution path.
            const baseDrive = this.#scheme === 'file' && isWindowsDriveSegment(this.#path[0])
                ? this.#path[0]
                : null;
            this.#path = baseDrive !== null ? [baseDrive] : [];
            path = path.slice(1);
        }

        if (!path) return;

        const segments = path.split('/');
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i]!;
            // The spec's path state appends the empty string after a FINAL dot
            // segment, because the separator the dot sat behind remains: a
            // reference of `a/..` against `https://h/a/b` is `https://h/a/`,
            // not `https://h/a`. Dropping it resolved every such reference one
            // segment short. This is not a non-special quirk — it applies to
            // `foo:/a/b` + '..' (=> `foo:/`) identically.
            const isLast = i === segments.length - 1;
            const kind = dotSegmentKind(segment);
            if (kind === 2) {
                // Spec "shorten a URL's path": pop a segment, for EVERY scheme.
                // Specialness is not part of the rule. A non-special URL with a
                // list path (`foo:/a/b`, which is every `pack:/…`) shortens
                // exactly like a special one, so `new URL('../x','pack:/a/b')`
                // is `pack:/x`. Pushing '..' verbatim instead produced
                // `pack:/a/../x` — a garbage id that no manifest lookup matches.
                // Only an OPAQUE path (`foo:a/b`) keeps '..' literally, and
                // #parsePath is never reached for one.
                //
                // The one carve-out is the spec's own: shortening stops at a
                // `file:` Windows drive letter, so `..` can never escape it
                // (`file:///C:/a/b` + '../../x' stays `file:///C:/x`).
                const onlyDrive = this.#scheme === 'file' && this.#path.length === 1
                    && isWindowsDriveSegment(this.#path[0]);
                if (this.#path.length > 0 && !onlyDrive) {
                    this.#path.pop();
                }
                if (isLast) this.#path.push('');
            } else if (kind === 1) {
                if (isLast) this.#path.push('');
            } else {
                // Ordinary segment — INCLUDING the empty string, which is both a
                // meaningful `//` component and the carrier of a trailing slash.
                this.#path.push(segment);
            }
        }

        // A leading Windows drive letter normalizes `C|` to `C:`.
        const first = this.#path[0];
        if (this.#scheme === 'file' && first !== undefined && isWindowsDriveLetter(first) && first[1] === '|') {
            this.#path[0] = first[0] + ':';
        }

        // No trailing-slash fixup here on purpose. `/a/b/` splits to
        // ['a','b',''] and that final empty segment is now pushed by the loop
        // like any other, so the slash survives on its own. Re-pushing '' here
        // as the old code did would double it to `/a/b//`. The dot-segment half
        // of that old rule moved into the loop, where it can also see the
        // percent-encoded forms (`a/%2e%2e` => `/a/`) the string compare missed.
    }

    // ==================== Getters ====================

    get href(): string {
        return this.toString();
    }

    set href(value: string) {
        this.#scheme = ''; this.#host = ''; this.#port = '';
        this.#username = ''; this.#password = '';
        this.#path = []; this.#opaquePath = null; this.#query = null; this.#hasQuery = false; this.#fragment = '';
        this.#hasFragment = false;
        this.#parse(value);
    }

    get origin(): string {
        if (this.#scheme === 'blob') {
            try {
                const url = new URL(this.pathname);
                return url.origin;
            } catch {
                return 'null';
            }
        }

        if (this.#scheme === 'file') {
            return 'null';
        }

        if (!(this.#scheme in SPECIAL_SCHEMES)) {
            return 'null';
        }

        let origin = `${this.#scheme}://${this.#host}`;
        if (this.#port) {
            origin += `:${this.#port}`;
        }
        return origin;
    }

    get protocol(): string {
        return this.#scheme + ':';
    }

    set protocol(value: string) {
        const scheme = String(value).replace(/:$/, '').toLowerCase();
        if (scheme && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) {
            this.#scheme = scheme;
        }
    }

    get username(): string {
        return this.#username;
    }

    set username(value: string) {
        if (this.#scheme === 'file') return;
        this.#username = percentEncode(String(value), USERINFO_ENCODE_SET);
    }

    get password(): string {
        return this.#password;
    }

    set password(value: string) {
        if (this.#scheme === 'file') return;
        this.#password = percentEncode(String(value), USERINFO_ENCODE_SET);
    }

    get host(): string {
        if (!this.#host) return '';
        return this.#port ? `${this.#host}:${this.#port}` : this.#host;
    }

    set host(value: string) {
        if (this.#scheme === 'file') return;

        const str = String(value);
        let hostPart: string;
        let portStr = '';

        if (str.startsWith('[')) {
            const endBracket = str.indexOf(']');
            if (endBracket === -1) {
                this.#host = str.toLowerCase();
                this.#port = '';
                return;
            }
            hostPart = str.slice(0, endBracket + 1).toLowerCase();
            if (str[endBracket + 1] === ':') portStr = str.slice(endBracket + 2);
        } else {
            const colonIndex = str.lastIndexOf(':');
            if (colonIndex === -1) {
                hostPart = str.toLowerCase();
            } else {
                hostPart = str.slice(0, colonIndex).toLowerCase();
                portStr = str.slice(colonIndex + 1);
            }
        }

        this.#host = hostPart;
        if (portStr && /^\d+$/.test(portStr)) {
            const port = parseInt(portStr, 10);
            if (port <= 65535) {
                const defaultPort = SPECIAL_SCHEMES[this.#scheme];
                this.#port = defaultPort === port ? '' : String(port);
            }
        } else {
            this.#port = '';
        }
    }

    get hostname(): string {
        return this.#host;
    }

    set hostname(value: string) {
        if (this.#scheme === 'file') return;
        this.#host = String(value).toLowerCase();
    }

    get port(): string {
        return this.#port;
    }

    set port(value: string) {
        if (this.#scheme === 'file') return;

        const portStr = String(value);
        if (!portStr) {
            this.#port = '';
            return;
        }

        if (/^\d+$/.test(portStr)) {
            const port = parseInt(portStr, 10);
            if (port <= 65535) {
                const defaultPort = SPECIAL_SCHEMES[this.#scheme];
                this.#port = defaultPort === port ? '' : String(port);
            }
        }
    }

    get pathname(): string {
        // Opaque paths serialize verbatim — no leading '/', no re-encoding.
        if (this.#opaquePath !== null) return this.#opaquePath;

        if (this.#scheme === 'file') {
            if (this.#path.length === 0) return '/';
            return percentEncode('/' + this.#path.join('/'), PATH_ENCODE_SET);
        }

        if (this.#path.length === 0) return '/';
        const encodeSet = this.#scheme in SPECIAL_SCHEMES ? PATH_ENCODE_SET : NON_SPECIAL_PATH_ENCODE_SET;
        return '/' + this.#path.map(p => percentEncode(p, encodeSet)).join('/');
    }

    set pathname(value: string) {
        // Spec: the pathname setter is a no-op on an opaque path.
        if (this.#opaquePath !== null) return;

        if (this.#scheme === 'file') {
            this.#path = String(value).split('/').filter(p => p);
            return;
        }

        this.#path = [];
        this.#parsePath(String(value), this.#scheme in SPECIAL_SCHEMES);
    }

    get search(): string {
        if (this.#query === null || this.#query === '') return '';
        return '?' + percentEncode(this.#query, URL_TEXT_ENCODE_SET);
    }

    set search(value: string) {
        const str = String(value);
        if (!str) {
            this.#query = null;
            this.#hasQuery = false;
            this.#searchParams._replaceFromQuery('');
            return;
        }

        this.#query = str.startsWith('?') ? str.slice(1) : str;
        this.#hasQuery = true;
        this.#searchParams._replaceFromQuery(this.#query);
    }

    get searchParams(): URLSearchParams {
        return this.#searchParams;
    }

    get hash(): string {
        if (!this.#fragment) return '';
        return '#' + percentEncode(this.#fragment, URL_TEXT_ENCODE_SET);
    }

    set hash(value: string) {
        const str = String(value);
        if (!str) {
            this.#fragment = '';
            this.#hasFragment = false;
            return;
        }
        this.#hasFragment = true;
        this.#fragment = percentEncode(
            str.startsWith('#') ? str.slice(1) : str,
            FRAGMENT_ENCODE_SET
        );
    }

    // ==================== Methods ====================

    toString(): string {
        let result = this.#scheme + ':';

        if (this.#host || this.#scheme === 'file' || (this.#scheme in SPECIAL_SCHEMES)) {
            result += '//';
            if (this.#username || this.#password) {
                result += percentEncode(this.#username, USERINFO_ENCODE_SET);
                if (this.#password) {
                    result += ':' + percentEncode(this.#password, USERINFO_ENCODE_SET);
                }
                result += '@';
            }

            result += this.#host;

            if (this.#port) {
                result += ':' + this.#port;
            }
        }

        result += this.pathname;

        if (this.#hasQuery) result += '?' + percentEncode(this.#query ?? '', URL_TEXT_ENCODE_SET);

        if (this.#hasFragment) {
            result += '#' + percentEncode(this.#fragment, URL_TEXT_ENCODE_SET);
        }

        return result;
    }

    toJSON(): string {
        return this.toString();
    }

    static createObjectURL(blob: Blob): string {
        if (!(blob instanceof Blob)) {
            throw new TypeError('URL.createObjectURL requires a Blob');
        }
        const url = new URL(createObjectUrlId()).href;
        objectUrlStore.set(url, blob);
        return url;
    }

    static revokeObjectURL(url: string): void {
        try {
            objectUrlStore.delete(new URL(String(url)).href);
        } catch {
            // Browser-compatible no-op for invalid or unknown object URLs.
        }
    }
    
    get [Symbol.toStringTag]() {
        return 'URL';
    }

    [denoCustomInspect]() {
        return `URL {
  href: ${JSON.stringify(this.href)},
  origin: ${JSON.stringify(this.origin)},
  protocol: ${JSON.stringify(this.protocol)},
  username: ${JSON.stringify(this.username)},
  password: ${JSON.stringify(this.password)},
  host: ${JSON.stringify(this.host)},
  hostname: ${JSON.stringify(this.hostname)},
  port: ${JSON.stringify(this.port)},
  pathname: ${JSON.stringify(this.pathname)},
  hash: ${JSON.stringify(this.hash)},
  search: ${JSON.stringify(this.search)}
}`;
    }
}

Reflect.set(globalThis, 'URL', URL);
Reflect.set(globalThis, 'URLSearchParams', URLSearchParams);

export {
    URL,
    URLSearchParams,
};