/**
 * Node.js url module compatibility.
 *
 * URL and URLSearchParams come from the runtime (webapi polyfill on globalThis).
 * Legacy parse/format/resolve and file-URL helpers are built on top of them.
 * Do not subclass globalThis.URL — QuickJS rejects super() with "not a function".
 */

import { Buffer } from '../buffer';
import path from '../path';

export const URLSearchParams = globalThis.URLSearchParams;
export const URLPattern = globalThis.URLPattern;
type ParsedQuery = Record<string, string | string[]>;

interface UrlWithStringQuery {
    protocol: string | null;
    slashes: boolean | null;
    auth: string | null;
    host: string | null;
    port: string | null;
    hostname: string | null;
    hash: string | null;
    search: string | null;
    query: string | null;
    pathname: string | null;
    path: string | null;
    href: string;
}

interface UrlWithParsedQuery extends Omit<UrlWithStringQuery, 'query'> {
    query: ParsedQuery;
}

type MutableParsedUrl = Omit<UrlWithStringQuery, 'query'> & {
    query: string | ParsedQuery | null;
};

type UrlObject = Partial<Omit<UrlWithStringQuery, 'query'>> & {
    query?: string | Record<string, unknown> | null;
};

const SLASHED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'gopher:', 'file:', 'ws:', 'wss:']);
const HOSTLESS_PROTOCOLS = new Set(['javascript:']);
const UNSAFE_AUTH = /[/?#]/g;

function stringifyQuery(query: Record<string, unknown>): string {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(stringifyQueryPrimitive(item))}`);
            }
        } else {
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(stringifyQueryPrimitive(value))}`);
        }
    }
    return pairs.join('&');
}

function stringifyQueryPrimitive(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string') return String(value);
    return '';
}

function parseQuery(query: string): ParsedQuery {
    const out: ParsedQuery = Object.create(null);
    if (!query) return out;
    for (const part of query.split('&')) {
        const eq = part.indexOf('=');
        const rawKey = eq === -1 ? part : part.slice(0, eq);
        const rawValue = eq === -1 ? '' : part.slice(eq + 1);
        const key = safeDecode(rawKey.replace(/\+/g, ' '));
        const value = safeDecode(rawValue.replace(/\+/g, ' '));
        const existing = out[key];
        if (existing === undefined) {
            out[key] = value;
        } else if (Array.isArray(existing)) {
            existing.push(value);
        } else {
            out[key] = [existing, value];
        }
    }
    return out;
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function encodeAuth(value: string): string {
    return encodeURIComponent(value).replace(/%3A/gi, ':');
}

function encodePathname(value: string): string {
    return value.replace(/[?#]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Node brackets a colon-bearing hostname unless it is ALREADY bracketed at both
// ends, so a half-open `[a:b` becomes `[[a:b]`.
function isIpv6Hostname(hostname: string): boolean {
    return hostname.charCodeAt(0) === 0x5b /* [ */ &&
        hostname.charCodeAt(hostname.length - 1) === 0x5d /* ] */;
}

function formatHostname(hostname: string): string {
    return hostname.includes(':') && !isIpv6Hostname(hostname) ? `[${hostname}]` : hostname;
}

function decodeAuth(value: string): string {
    return safeDecode(value);
}

function normalizeProtocol(protocol: string | null | undefined): string | null {
    if (!protocol) return null;
    return protocol.endsWith(':') ? protocol.toLowerCase() : `${protocol.toLowerCase()}:`;
}

function splitHost(host: string): { host: string; hostname: string; port: string | null } {
    if (!host) return { host, hostname: '', port: null };

    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        if (end !== -1) {
            const hostname = host.slice(1, end).toLowerCase();
            const rest = host.slice(end + 1);
            const port = rest.startsWith(':') && /^\d*$/.test(rest.slice(1)) ? rest.slice(1) || null : null;
            return {
                host: `[${hostname}]${port !== null ? `:${port}` : ''}`,
                hostname,
                port,
            };
        }
    }

    const lastColon = host.lastIndexOf(':');
    let hostname = host;
    let port: string | null = null;
    if (lastColon > -1 && /^\d*$/.test(host.slice(lastColon + 1))) {
        hostname = host.slice(0, lastColon);
        port = host.slice(lastColon + 1) || null;
    }

    hostname = hostname.toLowerCase();
    return {
        host: `${hostname}${port !== null ? `:${port}` : ''}`,
        hostname,
        port,
    };
}

// --- Legacy url.parse internals, ported from Node's lib/url.js ------------

const PROTOCOL_RE = /^[a-z0-9.+-]+:/i;
const PORT_RE = /:[0-9]*$/;
// `//user@host` is always read as a host, even with no protocol.
const HOST_RE = /^\/\/[^@/]+@[^@/]+/;
const SIMPLE_PATH_RE = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;
const HOSTNAME_MAX_LEN = 255;
const FORBIDDEN_HOST_CHARS = /[\0\t\n\r #%/:<>?@[\\\]^|]/;
const FORBIDDEN_HOST_CHARS_IPV6 = /[\0\t\n\r #%/<>?@\\^|]/;

// RFC 2396 delimiters + unwise chars, auto-escaped in the post-host remainder.
const AUTO_ESCAPE: Record<string, string> = {
    '\t': '%09', '\n': '%0A', '\r': '%0D', ' ': '%20', '"': '%22', "'": '%27',
    '<': '%3C', '>': '%3E', '\\': '%5C', '^': '%5E', '`': '%60',
    '{': '%7B', '|': '%7C', '}': '%7D',
};
const AUTO_ESCAPE_RE = /[\t\n\r "'<>\\^`{|}]/g;

function autoEscapeStr(rest: string): string {
    return rest.replace(AUTO_ESCAPE_RE, ch => AUTO_ESCAPE[ch]);
}

// A char that can never appear in a hostname moves that tail into the path.
function trimHostname(result: Url, rest: string, hostname: string): string {
    for (let i = 0; i < hostname.length; i++) {
        const ch = hostname[i];
        if (ch === '/' || ch === '\\' || ch === '#' || ch === '?' || ch === ':') {
            result.hostname = hostname.slice(0, i);
            return `/${hostname.slice(i)}${rest}`;
        }
    }
    return rest;
}

function parseHostPart(result: Url, rest: string, urlStr: string): string {
    let hostEnd = -1;
    let atSign = -1;
    let nonHost = -1;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        // WHATWG URL strips tab/LF/CR; legacy parse copies that.
        if (ch === '\t' || ch === '\n' || ch === '\r') {
            rest = rest.slice(0, i) + rest.slice(i + 1);
            i -= 1;
            continue;
        }
        if (' "%\';<>\\^`{|}'.includes(ch)) {
            if (nonHost === -1) nonHost = i;
        } else if (ch === '#' || ch === '/' || ch === '?') {
            if (nonHost === -1) nonHost = i;
            hostEnd = i;
        } else if (ch === '@') {
            atSign = i;
            nonHost = -1;
        }
        if (hostEnd !== -1) break;
    }

    let start = 0;
    if (atSign !== -1) {
        result.auth = decodeAuth(rest.slice(0, atSign));
        start = atSign + 1;
    }
    if (nonHost === -1) {
        result.host = rest.slice(start);
        rest = '';
    } else {
        result.host = rest.slice(start, nonHost);
        rest = rest.slice(nonHost);
    }

    result.parseHost();
    if (typeof result.hostname !== 'string') result.hostname = '';

    const hostname = result.hostname;
    const ipv6 = hostname.startsWith('[') && hostname.endsWith(']');
    if (!ipv6) rest = trimHostname(result, rest, hostname);

    if ((result.hostname ?? '').length > HOSTNAME_MAX_LEN) {
        result.hostname = '';
    } else {
        result.hostname = (result.hostname ?? '').toLowerCase();
    }

    if (result.hostname !== '') {
        if (ipv6) {
            if (FORBIDDEN_HOST_CHARS_IPV6.test(result.hostname)) {
                throw urlError(`Invalid URL: ${urlStr}`, 'ERR_INVALID_URL');
            }
        } else {
            // IDNA: punycode only the labels that need it. Legacy parse is
            // lenient about disallowed ASCII, unlike url.domainToASCII.
            result.hostname = lenientDomainToASCII(result.hostname);
            if (result.hostname === '' || FORBIDDEN_HOST_CHARS.test(result.hostname)) {
                throw urlError(`Invalid URL: ${urlStr}`, 'ERR_INVALID_URL');
            }
        }
    }

    result.host = `${result.hostname ?? ''}${result.port ? `:${result.port}` : ''}`;

    if (ipv6) {
        result.hostname = (result.hostname ?? '').slice(1, -1);
        if (rest[0] !== '/') rest = `/${rest}`;
    }
    return rest;
}

// Re-export the runtime URL. Subclassing globalThis.URL breaks on QuickJS
// (super() → "not a function"), which killed fileURLToPath / createRequire.
export const URL = globalThis.URL;

export class Url {
    protocol: string | null = null;
    slashes: boolean | null = null;
    auth: string | null = null;
    host: string | null = null;
    port: string | null = null;
    hostname: string | null = null;
    hash: string | null = null;
    search: string | null = null;
    query: string | ParsedQuery | null = null;
    pathname: string | null = null;
    path: string | null = null;
    href = '';

    parse(urlStr: string, parseQueryString = false, slashesDenoteHost = false): this {
        const parsed = parse(urlStr, parseQueryString, slashesDenoteHost);
        Object.assign(this, parsed);
        return this;
    }

    format(): string {
        return format(this);
    }

    resolve(relative: string): string {
        return resolve(this.href, relative);
    }

    resolveObject(relative: string | Url): Url {
        const result = resolveObject(this.href, typeof relative === 'string' ? relative : relative.href);
        return typeof result === 'string' ? parse(result, false, true) : result;
    }

    // Node splits the port with /:[0-9]*$/, so "ho:st" keeps a null port.
    parseHost(): void {
        const host = this.host ?? '';
        const match = PORT_RE.exec(host);
        let rest = host;
        if (match) {
            const port = match[0];
            if (port !== ':') this.port = port.slice(1);
            rest = rest.slice(0, rest.length - port.length);
        }
        if (rest) this.hostname = rest;
    }
}

export function parse(urlStr: string, parseQueryString = false, slashesDenoteHost = false): Url {
    if (typeof urlStr !== 'string') {
        throw new TypeError('The "url" argument must be of type string.');
    }

    const result = new Url();
    // Backslashes before the query string become forward slashes (browser parity).
    const split = urlStr.search(/[?#]/);
    let rest = split === -1
        ? urlStr.replace(/\\/g, '/')
        : urlStr.slice(0, split).replace(/\\/g, '/') + urlStr.slice(split);
    rest = rest.replace(/^[\s ﻿\0- ]+|[\s ﻿\0- ]+$/g, '');

    const hasHash = rest.includes('#');
    const hasAt = rest.slice(0, split === -1 ? rest.length : split).includes('@');
    if (!slashesDenoteHost && !hasHash && !hasAt) {
        const simple = SIMPLE_PATH_RE.exec(rest);
        if (simple) {
            result.path = rest;
            result.href = rest;
            result.pathname = simple[1];
            if (simple[2]) {
                result.search = simple[2];
                result.query = parseQueryString ? parseQuery(simple[2].slice(1)) : simple[2].slice(1);
            } else if (parseQueryString) {
                result.query = Object.create(null) as ParsedQuery;
            }
            return result;
        }
    }

    const protoMatch = PROTOCOL_RE.exec(rest);
    let proto: string | null = null;
    if (protoMatch) {
        proto = protoMatch[0].toLowerCase();
        result.protocol = proto;
        rest = rest.slice(protoMatch[0].length);
    }

    let slashes = false;
    if (slashesDenoteHost || proto || HOST_RE.test(rest)) {
        slashes = rest.startsWith('//');
        if (slashes && !(proto && HOSTLESS_PROTOCOLS.has(proto))) {
            rest = rest.slice(2);
            result.slashes = true;
        }
    }

    if (!HOSTLESS_PROTOCOLS.has(proto ?? '') && (slashes || (proto && !SLASHED_PROTOCOLS.has(proto)))) {
        rest = parseHostPart(result, rest, urlStr);
    }

    if (!HOSTLESS_PROTOCOLS.has(proto ?? '')) rest = autoEscapeStr(rest);

    const hashIndex = rest.indexOf('#');
    const queryIndex = rest.indexOf('?');
    if (hashIndex !== -1) result.hash = rest.slice(hashIndex);
    if (queryIndex !== -1 && (hashIndex === -1 || queryIndex < hashIndex)) {
        result.search = hashIndex === -1 ? rest.slice(queryIndex) : rest.slice(queryIndex, hashIndex);
        const query = result.search.slice(1);
        result.query = parseQueryString ? parseQuery(query) : query;
    } else if (parseQueryString) {
        result.query = Object.create(null) as ParsedQuery;
    }

    const firstIdx = queryIndex !== -1 && (hashIndex === -1 || queryIndex < hashIndex) ? queryIndex : hashIndex;
    if (firstIdx === -1) {
        if (rest.length > 0) result.pathname = rest;
    } else if (firstIdx > 0) {
        result.pathname = rest.slice(0, firstIdx);
    }
    if (proto && SLASHED_PROTOCOLS.has(proto) && result.hostname && !result.pathname) {
        result.pathname = '/';
    }

    if (result.pathname || result.search) {
        result.path = `${result.pathname ?? ''}${result.search ?? ''}`;
    }

    result.href = format(result);
    return result;
}

function formatWhatwgUrl(url: URL, options?: {
    auth?: boolean;
    fragment?: boolean;
    search?: boolean;
    unicode?: boolean;
}): string {
    let href = url.href;

    if (options?.auth === false && (url.username || url.password)) {
        const auth = `${url.username}${url.password ? `:${url.password}` : ''}@`;
        const marker = href.indexOf(auth);
        if (marker !== -1) href = href.slice(0, marker) + href.slice(marker + auth.length);
    }
    if (options?.search === false) {
        const hash = href.indexOf('#');
        const query = href.indexOf('?');
        if (query !== -1 && (hash === -1 || query < hash)) {
            href = href.slice(0, query) + (hash === -1 ? '' : href.slice(hash));
        }
    }
    if (options?.fragment === false) {
        const hash = href.indexOf('#');
        if (hash !== -1) href = href.slice(0, hash);
    }
    if (options?.unicode === true) {
        const host = url.hostname;
        if (host.startsWith('xn--') || host.includes('.xn--')) {
            href = href.replace(host, domainToUnicode(host));
        }
    }

    return href;
}

export function format(url: string | URL | UrlObject, options?: {
    auth?: boolean;
    fragment?: boolean;
    search?: boolean;
    unicode?: boolean;
}): string {
    if (typeof url === 'string') {
        return formatWhatwgUrl(new URL(url), options);
    }
    // Prefer WHATWG URL instances over legacy UrlObject duck-types.
    if (url instanceof globalThis.URL) {
        return formatWhatwgUrl(url as URL, options);
    }

    const protocol = normalizeProtocol(url.protocol);

    // Node builds the authority as a single unit: `auth` is only ever emitted
    // as a prefix of a NON-EMPTY host, so `{protocol:'http:',auth:'u:p'}`
    // formats as `http:` and drops the credentials entirely.
    const auth = url.auth
        ? `${encodeAuth(String(url.auth)).replace(UNSAFE_AUTH, encodeURIComponent)}@`
        : '';
    let host = '';
    if (url.host) {
        host = `${auth}${String(url.host)}`;
    } else if (url.hostname) {
        host = `${auth}${formatHostname(String(url.hostname))}`;
        if (url.port) host += `:${url.port}`;
    }

    let pathname = url.pathname ?? '';

    // Node gates the "//" and the implied leading slash behind TWO conditions,
    // not one: the protocol must want slashes, AND there must be something to
    // separate (an explicit `slashes` flag or a real host). A slashed protocol
    // with neither — `{protocol:'http:',pathname:'b'}` — stays `http:b`, and a
    // bare host with no slashed protocol — `{host:'a',pathname:'b'}` — stays
    // `ab`. Gating the leading slash on `host` alone produced `http://` and
    // `a/b` for those.
    if (Boolean(url.slashes) || (protocol !== null && SLASHED_PROTOCOLS.has(protocol))) {
        if (url.slashes || host) {
            if (pathname && !pathname.startsWith('/')) pathname = `/${pathname}`;
            host = `//${host}`;
        } else if (protocol === 'file:') {
            // Node's carve-out tests `protocol` starting with "file"; among the
            // slashed protocols that reach here, only `file:` qualifies.
            host = '//';
        }
    }

    let out = `${protocol ?? ''}${host}${encodePathname(pathname)}`;

    let search = url.search ?? null;
    if (!search && url.query && typeof url.query === 'object') {
        const query = stringifyQuery(url.query);
        if (query) search = `?${query}`;
    }
    if (search) out += search.startsWith('?') ? search : `?${search}`;

    if (url.hash) {
        const hash = String(url.hash);
        out += hash.startsWith('#') ? hash : `#${hash}`;
    }

    return out;
}

function resolveRelativePath(basePath: string, relativePath: string): string {
    if (relativePath.startsWith('/')) return relativePath;
    const stack = basePath.split('/');
    if (!basePath.endsWith('/')) stack.pop();
    for (const part of relativePath.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (stack.length > 1) stack.pop();
        } else {
            stack.push(part);
        }
    }
    return stack.join('/') || '/';
}

export function resolve(from: string, to: string): string {
    if (typeof from !== 'string' || typeof to !== 'string') {
        throw new TypeError('The "url" argument must be of type string.');
    }

    // Node's `new URL(from)` throws for a bare path, falling through to the
    // legacy resolver. cno's URL accepts bare paths as file:, so gate on a scheme.
    if (PROTOCOL_RE.test(from)) {
        try {
            return new URL(to, new URL(from)).href;
        } catch {}
    }
    if (/^[a-z][a-z0-9.+-]*:/i.test(to) || to.startsWith('//')) return to;
    const base = parse(from) as MutableParsedUrl;
    const target = parse(to) as MutableParsedUrl;
    if (target.search && !target.pathname) {
        base.search = target.search;
        base.query = target.query;
        base.hash = target.hash;
        base.path = `${base.pathname ?? ''}${target.search}`;
        return format(base);
    }
    base.pathname = resolveRelativePath(base.pathname ?? '/', to);
    base.search = null;
    base.query = null;
    base.hash = target.hash;
    base.path = base.pathname;
    return format(base);
}

export function resolveObject(from: string, to: string | Url): string | Url {
    if (!from) return typeof to === 'string' ? to : to.href;
    const relative = typeof to === 'string' ? to : to.href;
    return parse(resolve(from, relative), false, true);
}

// Punycode (RFC 3492), enough for Node-compatible domain helpers.

const PC_BASE = 36;
const PC_TMIN = 1;
const PC_TMAX = 26;
const PC_SKEW = 38;
const PC_DAMP = 700;
const PC_INITIAL_BIAS = 72;
const PC_INITIAL_N = 128;
const PC_DELIMITER = '-';

function punyAdapt(delta: number, numPoints: number, firstTime: boolean): number {
    delta = firstTime ? Math.floor(delta / PC_DAMP) : delta >> 1;
    delta += Math.floor(delta / numPoints);

    let k = 0;
    while (delta > ((PC_BASE - PC_TMIN) * PC_TMAX) >> 1) {
        delta = Math.floor(delta / (PC_BASE - PC_TMIN));
        k += PC_BASE;
    }

    return k + Math.floor(((PC_BASE - PC_TMIN + 1) * delta) / (delta + PC_SKEW));
}

function digitToBasic(digit: number): string {
    return String.fromCharCode(digit + 22 + 75 * Number(digit < 26));
}

function basicToDigit(code: number): number {
    if (code >= 48 && code <= 57) return code - 22;
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 97;
    return PC_BASE;
}

function punyEncode(input: string): string {
    const codePoints = Array.from(input, ch => ch.codePointAt(0)).filter((code): code is number => code !== undefined);
    const output: string[] = [];
    let n = PC_INITIAL_N;
    let delta = 0;
    let bias = PC_INITIAL_BIAS;

    for (const cp of codePoints) {
        if (cp < 0x80) output.push(String.fromCharCode(cp));
    }

    const basicLength = output.length;
    let handled = basicLength;
    if (basicLength > 0) output.push(PC_DELIMITER);

    while (handled < codePoints.length) {
        let m = Infinity;
        for (const cp of codePoints) {
            if (cp >= n && cp < m) m = cp;
        }

        delta += (m - n) * (handled + 1);
        n = m;

        for (const cp of codePoints) {
            if (cp < n) {
                delta++;
                continue;
            }
            if (cp !== n) continue;

            let q = delta;
            for (let k = PC_BASE; ; k += PC_BASE) {
                const t = k <= bias ? PC_TMIN : k >= bias + PC_TMAX ? PC_TMAX : k - bias;
                if (q < t) break;
                output.push(digitToBasic(t + ((q - t) % (PC_BASE - t))));
                q = Math.floor((q - t) / (PC_BASE - t));
            }
            output.push(digitToBasic(q));
            bias = punyAdapt(delta, handled + 1, handled === basicLength);
            delta = 0;
            handled++;
        }

        delta++;
        n++;
    }

    return output.join('');
}

function punyDecode(input: string): string {
    const output: number[] = [];
    const delimiter = input.lastIndexOf(PC_DELIMITER);
    let index = 0;

    if (delimiter !== -1) {
        for (let i = 0; i < delimiter; i++) {
            const cp = input.charCodeAt(i);
            if (cp >= 0x80) throw new RangeError('Illegal input');
            output.push(cp);
        }
        index = delimiter + 1;
    }

    let n = PC_INITIAL_N;
    let i = 0;
    let bias = PC_INITIAL_BIAS;

    while (index < input.length) {
        const oldi = i;
        let w = 1;

        for (let k = PC_BASE; ; k += PC_BASE) {
            if (index >= input.length) throw new RangeError('Bad input');
            const digit = basicToDigit(input.charCodeAt(index++));
            if (digit >= PC_BASE) throw new RangeError('Bad input');
            i += digit * w;
            const t = k <= bias ? PC_TMIN : k >= bias + PC_TMAX ? PC_TMAX : k - bias;
            if (digit < t) break;
            w *= PC_BASE - t;
        }

        const outLen = output.length + 1;
        bias = punyAdapt(i - oldi, outLen, oldi === 0);
        n += Math.floor(i / outLen);
        i %= outLen;
        output.splice(i, 0, n);
        i++;
    }

    return String.fromCodePoint(...output);
}

function splitDomain(domain: string): string[] {
    return domain.split(/[.\u3002\uff0e\uff61]/);
}

// UTS-46 with UseSTD3ASCIIRules=false: only controls, space, DEL and the
// forbidden host code points are disallowed. `! " $ & ' ( ) * + , ; = ` { } ~`
// are all legal in a domain label, which Node's domainToASCII confirms.
const DISALLOWED_DOMAIN_ASCII = /[\0-\x20\x7F#%/:<>?@[\\\]^|]/;

function validAsciiLabel(label: string): boolean {
    return !DISALLOWED_DOMAIN_ASCII.test(label);
}

// UTS-46 also disallows C1 controls, so an A-label decoding to them
// (`xn--a` → U+0080) is not a valid domain.
const DISALLOWED_ULABEL = /[\0-\x20\x7F-\x9F#%/:<>?@[\\\]^|]/;

// Returns the U-label, or null when the A-label is not a valid one.
function decodeALabel(label: string): string | null {
    if (!/^[\x00-\x7F]+$/.test(label)) return null;
    let decoded: string;
    try {
        decoded = punyDecode(label.slice(4));
    } catch {
        return null;
    }
    if (decoded === '' || DISALLOWED_ULABEL.test(decoded)) return null;
    // A valid A-label must re-encode to itself.
    if (`xn--${punyEncode(decoded)}`.toLowerCase() !== label.toLowerCase()) return null;
    return decoded;
}

// Legacy url.parse uses a LENIENT IDNA: disallowed ASCII passes through
// untouched (`http://a\bb/p` keeps its host), only non-ASCII can fail.
// Returns '' on failure, which the caller turns into ERR_INVALID_URL.
function lenientDomainToASCII(domain: string): string {
    const out: string[] = [];
    for (const label of splitDomain(domain)) {
        if (/^xn--/i.test(label)) {
            if (decodeALabel(label) === null) return '';
            out.push(label.toLowerCase());
        } else if (/^[\x00-\x7F]*$/.test(label)) {
            out.push(label.toLowerCase());
        } else if (/[\x7F-\x9F]/.test(label)) {
            return '';
        } else {
            try {
                out.push(`xn--${punyEncode(label)}`.toLowerCase());
            } catch {
                return '';
            }
        }
    }
    return out.join('.');
}

export function domainToASCII(domain: string): string {
    let input = String(domain);
    if (input === '') return '';
    if (/^\[[0-9A-Fa-f:.]+\]$/.test(input)) return input;

    // The URL host parser strips tab/LF/CR and stops at a path/query/fragment
    // delimiter, so `a/b` yields `a` rather than failing outright.
    input = input.replace(/[\t\n\r]/g, '');
    const stop = input.search(/[#/?\\]/);
    if (stop !== -1) input = input.slice(0, stop);
    if (input === '') return '';

    try {
        const labels = splitDomain(input);
        let invalid = false;
        const converted = labels.map(label => {
            if (label === '') return '';
            if (/^xn--/i.test(label) && decodeALabel(label) === null) {
                invalid = true;
                return '';
            }
            if (/^[\x00-\x7F]+$/.test(label)) {
                // Node runs UTS-46 with VerifyDnsLength=false, so a long ASCII label passes.
                if (validAsciiLabel(label)) return label.toLowerCase();
                invalid = true;
                return '';
            }
            const ascii = `xn--${punyEncode(label)}`;
            if (ascii.length <= 63) return ascii.toLowerCase();
            invalid = true;
            return '';
        });
        return invalid ? '' : converted.join('.');
    } catch {
        return '';
    }
}

export function domainToUnicode(domain: string): string {
    let input = String(domain);
    if (input === '') return '';

    input = input.replace(/[\t\n\r]/g, '');
    const stop = input.search(/[#/?\\]/);
    if (stop !== -1) input = input.slice(0, stop);
    if (input === '') return '';

    const converted: string[] = [];
    for (const label of splitDomain(input)) {
        if (/^xn--/i.test(label)) {
            const decoded = decodeALabel(label);
            if (decoded === null) return '';
            converted.push(decoded);
        } else {
            if (/^[\x00-\x7F]*$/.test(label) && !validAsciiLabel(label)) return '';
            converted.push(label.toLowerCase());
        }
    }
    return converted.join('.');
}

function isUrl(value: unknown): value is URL {
    if (value instanceof globalThis.URL) return true;
    // Duck-type URL-like (e.g. cross-realm / partial mocks).
    if (value !== null && typeof value === 'object') {
        const href = Reflect.get(value, 'href');
        const protocol = Reflect.get(value, 'protocol');
        return typeof href === 'string' && typeof protocol === 'string';
    }
    return false;
}

function urlError(message: string, code: string): TypeError & { code: string } {
    return Object.assign(new TypeError(message), { code });
}

// Node's ERR_INVALID_ARG_TYPE "Received …" suffix, for the common cases.
function describeReceived(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'string') return `type string ('${value as string}')`;
    if (type === 'number' || type === 'boolean' || type === 'bigint' || type === 'symbol') {
        return `type ${type} (${String(value)})`;
    }
    if (type === 'function') return `function ${(value as () => void).name}`;
    const name = Object.getPrototypeOf(value) === null ? null : (value as object).constructor?.name;
    return name ? `an instance of ${name}` : '[Object: null prototype] {}';
}

function invalidPathType(value: unknown, allowUrl: boolean): TypeError & { code: string } {
    const expected = allowUrl ? 'string or an instance of URL' : 'string';
    return urlError(
        `The "path" argument must be of type ${expected}. Received ${describeReceived(value)}`,
        'ERR_INVALID_ARG_TYPE',
    );
}

function assertFileUrl(value: URL): void {
    if (value.protocol !== 'file:') {
        throw urlError('The URL must be of scheme file', 'ERR_INVALID_URL_SCHEME');
    }
}

function runtimeSpecToLocalPath(spec: string): string | null {
    try {
        const cts = Reflect.get(globalThis, Symbol.for('cts.internal'));
        const specToLocalPath = cts && (typeof cts === 'object' || typeof cts === 'function')
            ? Reflect.get(cts, 'specToLocalPath')
            : undefined;
        if (typeof specToLocalPath === 'function') {
            const path = Reflect.apply(specToLocalPath, cts, [spec]);
            return typeof path === 'string' ? path : null;
        }
    } catch {}
    return null;
}

function decodePathname(pathname: string, windows: boolean): string {
    if (windows ? /%2f|%5c/i.test(pathname) : /%2f/i.test(pathname)) {
        throw urlError(
            windows
                ? 'File URL path must not include encoded \\ or / characters'
                : 'File URL path must not include encoded / characters',
            'ERR_INVALID_FILE_URL_PATH',
        );
    }
    return decodeURIComponent(pathname);
}

interface FileURLPathOptions {
    windows?: boolean;
}

export function fileURLToPath(url: string | URL, options?: FileURLPathOptions): string {
    if (typeof url !== 'string' && !isUrl(url)) {
        throw invalidPathType(url, true);
    }

    // A Windows drive path parses as scheme "c:" in Node's URL (so: not file:),
    // but cno's URL accepts it as a file: path — reject it explicitly.
    if (typeof url === 'string' && /^[A-Za-z]:[\\/]/.test(url)) {
        throw urlError('The URL must be of scheme file', 'ERR_INVALID_URL_SCHEME');
    }

    if (typeof url === 'string' && !/^[a-z][a-z0-9.+-]*:/i.test(url)) {
        throw urlError('Invalid URL', 'ERR_INVALID_URL');
    }

    const raw = typeof url === 'string' ? url : url.href;
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.protocol !== 'file:') {
        if (parsed.protocol === 'npm:' || parsed.protocol === 'jsr:') {
            const localPath = runtimeSpecToLocalPath(raw);
            if (localPath) return localPath;
            return raw;
        }
        if (parsed.protocol === 'data:' || parsed.protocol === 'base64:') {
            return raw;
        }
    }
    assertFileUrl(parsed);

    const hostname = parsed.hostname;
    const windows = options?.windows ?? process.platform === 'win32';
    let pathname = decodePathname(parsed.pathname, windows);

    if (windows) {
        pathname = pathname.replace(/\//g, '\\');
        if (hostname && hostname !== 'localhost') return `\\\\${domainToUnicode(hostname)}${pathname}`;
        const letter = pathname.charAt(1).toLowerCase();
        if (!/^[a-z]$/.test(letter) || pathname.charAt(2) !== ':') {
            throw urlError('File URL path must be absolute', 'ERR_INVALID_FILE_URL_PATH');
        }
        pathname = pathname.slice(1);
        return pathname;
    }

    if (hostname && hostname !== 'localhost') {
        throw urlError(
            `File URL host must be "localhost" or empty on ${process.platform}`,
            'ERR_INVALID_FILE_URL_HOST',
        );
    }
    return pathname;
}

function percentDecodeBuffer(pathname: string): Buffer {
    const encoded = Buffer.from(pathname, 'utf8');
    const output = Buffer.allocUnsafe(encoded.length);
    let outIndex = 0;
    for (let index = 0; index < encoded.length; index++) {
        const value = encoded[index];
        if (value === 0x25 && index + 2 < encoded.length) {
            const high = encoded[index + 1];
            const low = encoded[index + 2];
            const highValue = high === undefined ? -1 : hexDigit(high);
            const lowValue = low === undefined ? -1 : hexDigit(low);
            if (highValue >= 0 && lowValue >= 0) {
                output[outIndex++] = highValue * 16 + lowValue;
                index += 2;
                continue;
            }
        }
        output[outIndex++] = value;
    }
    return output.subarray(0, outIndex);
}

function hexDigit(value: number): number {
    if (value >= 0x30 && value <= 0x39) return value - 0x30;
    if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
    if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
    return -1;
}

export function fileURLToPathBuffer(url: string | URL, options?: FileURLPathOptions): Buffer {
    if (typeof url !== 'string' && !isUrl(url)) {
        throw invalidPathType(url, true);
    }
    const parsed = typeof url === 'string' ? new URL(url) : url;
    assertFileUrl(parsed);
    const windows = options?.windows ?? process.platform === 'win32';
    let pathname = parsed.pathname;
    if (windows) pathname = pathname.replace(/\//g, '\\');
    const decoded = percentDecodeBuffer(pathname);
    const hostname = parsed.hostname;
    if (windows) {
        if (hostname && hostname !== 'localhost') {
            return Buffer.concat([
                Buffer.from('\\\\', 'ascii'),
                Buffer.from(domainToUnicode(hostname), 'utf8'),
                decoded,
            ]);
        }
        const letter = decoded[1];
        if (letter === undefined ||
            (letter | 0x20) < 0x61 || (letter | 0x20) > 0x7a || decoded[2] !== 0x3a) {
            throw urlError('File URL path must be absolute', 'ERR_INVALID_FILE_URL_PATH');
        }
        return decoded.subarray(1);
    }
    if (hostname && hostname !== 'localhost') {
        throw urlError(
            `File URL host must be "localhost" or empty on ${process.platform}`,
            'ERR_INVALID_FILE_URL_HOST',
        );
    }
    return decoded;
}

// Node's file-URL encode set (Ada `href_from_file`): everything else becomes
// UTF-8 percent-escapes, including `%`, `~`, `[`, `]`, `|`, `^`.
const FILE_URL_UNSAFE = /[^A-Za-z0-9!$&'()*+,\-./:;=@_]/gu;

function encodeFilePath(pathname: string): string {
    return pathname.replace(FILE_URL_UNSAFE, ch => {
        let out = '';
        for (const byte of Buffer.from(ch, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
        return out;
    });
}

function invalidArgValue(value: string, reason: string): TypeError & { code: string } {
    const quoted = `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return Object.assign(
        new TypeError(`The argument 'path' ${reason}. Received ${quoted}`),
        { code: 'ERR_INVALID_ARG_VALUE' },
    );
}

export function pathToFileURL(filepath: string, options?: FileURLPathOptions): URL {
    if (typeof filepath !== 'string') {
        throw invalidPathType(filepath, false);
    }

    const windows = options?.windows ?? process.platform === 'win32';
    const pathApi = windows ? path.win32 : path.posix;
    if (!pathApi) throw new Error('path API is unavailable');
    // A UNC path is never run through resolve(); everything else is, which is
    // what supplies the current drive for `/tmp/x`, `C:a`, and relative paths.
    const isUnc = windows && filepath.startsWith('\\\\');
    let resolved = isUnc ? filepath : pathApi.resolve(filepath);

    if (windows && resolved.startsWith('\\\\')) {
        // `\\?\` is a local-path prefix, not a server name — unlike `\\?\UNC\`.
        if (resolved.startsWith('\\\\?\\') && !resolved.startsWith('\\\\?\\UNC\\')) {
            return new URL(`file:///${encodeFilePath(resolved.slice(4).replace(/\\/g, '/'))}`);
        }
        const prefixLength = resolved.startsWith('\\\\?\\UNC\\') ? 8 : 2;
        const hostEnd = resolved.indexOf('\\', prefixLength);
        if (hostEnd === -1) throw invalidArgValue(resolved, 'Missing UNC resource path');
        if (hostEnd === prefixLength) throw invalidArgValue(resolved, 'Empty UNC servername');
        const host = domainToASCII(resolved.slice(prefixLength, hostEnd));
        return new URL(`file://${host}${encodeFilePath(resolved.slice(hostEnd).replace(/\\/g, '/'))}`);
    }

    // resolve() strips a trailing separator; Node puts it back.
    const last = filepath.charCodeAt(filepath.length - 1);
    if ((last === 0x2f || (windows && last === 0x5c)) && !resolved.endsWith(pathApi.sep)) resolved += '/';

    if (windows) resolved = resolved.replace(/\\/g, '/');
    if (!resolved.startsWith('/')) resolved = `/${resolved}`;
    return new URL(`file://${encodeFilePath(resolved)}`);
}

export function urlToHttpOptions(url: URL): {
    protocol?: string;
    hostname?: string;
    hash?: string;
    search?: string;
    pathname?: string;
    path?: string;
    href?: string;
    port?: number;
    auth?: string;
} {
    if (!isUrl(url)) {
        throw new TypeError('The "url" argument must be an instance of URL');
    }

    // `hostname` feeds straight into net.connect/dns, which want the bare
    // address — Node strips the IPv6 brackets here, so `http://[::1]:8/` must
    // yield `::1`, not `[::1]`. Passing the bracketed form through produced a
    // hostname no resolver accepts.
    const hostname = url.hostname.startsWith('[')
        ? url.hostname.slice(1, -1)
        : url.hostname;

    const options: {
        protocol?: string;
        hostname?: string;
        hash?: string;
        search?: string;
        pathname?: string;
        path?: string;
        href?: string;
        port?: number;
        auth?: string;
    } = {
        // Null prototype, like Node: these options objects are routinely built
        // from untrusted URLs and then probed with `opts.foo`, so an inherited
        // Object.prototype member must never answer for a missing option.
        __proto__: null,
        // Node spreads the URL first so a user subclass's own enumerable
        // properties survive; every field below then overrides it.
        ...url,
        protocol: url.protocol,
        hostname,
        hash: url.hash,
        search: url.search,
        pathname: url.pathname,
        path: `${url.pathname}${url.search}`,
        href: url.href,
    } as never;

    if (url.port) options.port = Number(url.port);
    if (url.username || url.password) {
        options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    }

    return options;
}

export default {
    URL,
    URLPattern,
    URLSearchParams,
    Url,
    parse,
    resolve,
    resolveObject,
    format,
    domainToASCII,
    domainToUnicode,
    fileURLToPath,
    fileURLToPathBuffer,
    pathToFileURL,
    urlToHttpOptions,
};

// `export type` (not `export interface`) so `export * from './mod'`
// cannot materialise these as undefined runtime exports.
export type {
    UrlWithStringQuery,
    UrlWithParsedQuery,
    FileURLPathOptions,
};
