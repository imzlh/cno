/**
 * Node.js url module compatibility.
 *
 * URL and URLSearchParams come from the runtime (webapi polyfill on globalThis).
 * Legacy parse/format/resolve and file-URL helpers are built on top of them.
 * Do not subclass globalThis.URL — QuickJS rejects super() with "not a function".
 */

import { Buffer } from '../buffer';

export const URLSearchParams = globalThis.URLSearchParams;
export const URLPattern = globalThis.URLPattern;
type ParsedQuery = Record<string, string | string[]>;

export interface UrlWithStringQuery {
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

export interface UrlWithParsedQuery extends Omit<UrlWithStringQuery, 'query'> {
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
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

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

function formatHostname(hostname: string): string {
    return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
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

function findHostEnd(rest: string): number {
    const slash = rest.search(/[/?#]/);
    return slash === -1 ? rest.length : slash;
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

    parseHost(): void {
        if (!this.host) return;
        const info = splitHost(this.host);
        this.hostname = info.hostname || null;
        this.port = info.port;
    }
}

export function parse(urlStr: string, parseQueryString = false, slashesDenoteHost = false): Url {
    if (typeof urlStr !== 'string') {
        throw new TypeError('The "url" argument must be of type string.');
    }

    let rest = urlStr.trim();
    const result = new Url();
    result.query = parseQueryString ? '' : null;

    const protoMatch = /^([a-z0-9.+-]+:)/i.exec(rest);
    if (protoMatch) {
        result.protocol = protoMatch[1].toLowerCase();
        rest = rest.slice(protoMatch[0].length);
    }

    const slashes = rest.startsWith('//');
    const hasHost = slashes && (slashesDenoteHost || !result.protocol || SLASHED_PROTOCOLS.has(result.protocol));
    if (hasHost && !HOSTLESS_PROTOCOLS.has(result.protocol ?? '')) {
        result.slashes = true;
        rest = rest.slice(2);

        const hostEnd = findHostEnd(rest);
        let hostPart = rest.slice(0, hostEnd);
        rest = rest.slice(hostEnd);

        const at = hostPart.lastIndexOf('@');
        if (at !== -1) {
            result.auth = decodeAuth(hostPart.slice(0, at));
            hostPart = hostPart.slice(at + 1);
        }

        const hostInfo = splitHost(hostPart);
        result.host = hostInfo.host || null;
        result.hostname = hostInfo.hostname || null;
        result.port = hostInfo.port;
    } else if (result.protocol && !HOSTLESS_PROTOCOLS.has(result.protocol)) {
        const at = rest.lastIndexOf('@');
        const firstPathChar = rest.search(/[/?#]/);
        if (at !== -1 && (firstPathChar === -1 || at < firstPathChar)) {
            result.auth = decodeAuth(rest.slice(0, at));
            rest = rest.slice(at + 1);
            const hostEnd = findHostEnd(rest);
            const hostInfo = splitHost(rest.slice(0, hostEnd));
            result.host = hostInfo.host || null;
            result.hostname = hostInfo.hostname || null;
            result.port = hostInfo.port;
            rest = rest.slice(hostEnd);
        }
    }

    const hashIndex = rest.indexOf('#');
    if (hashIndex !== -1) {
        result.hash = rest.slice(hashIndex);
        rest = rest.slice(0, hashIndex);
    }

    const queryIndex = rest.indexOf('?');
    if (queryIndex !== -1) {
        result.search = rest.slice(queryIndex);
        const query = rest.slice(queryIndex + 1);
        result.query = parseQueryString ? parseQuery(query) : query;
        rest = rest.slice(0, queryIndex);
    } else if (parseQueryString) {
        const query: ParsedQuery = Object.create(null);
        result.query = query;
    }

    if (rest || result.host || result.protocol) {
        result.pathname = rest || (result.host ? '/' : null);
    }
    if (result.pathname !== null || result.search !== null) {
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
    const slashes = Boolean(url.slashes) || (protocol !== null && SLASHED_PROTOCOLS.has(protocol));
    let out = protocol ?? '';

    let host = url.host ?? null;
    if (!host && url.hostname) {
        host = formatHostname(String(url.hostname));
        if (url.port) host += `:${url.port}`;
    }

    if (slashes || host) {
        out += '//';
        if (url.auth) out += `${encodeAuth(String(url.auth)).replace(UNSAFE_AUTH, encodeURIComponent)}@`;
        if (host) out += host;
    }

    let pathname = url.pathname ?? '';
    if (pathname && host && !pathname.startsWith('/')) pathname = `/${pathname}`;
    out += encodePathname(pathname);

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

    try {
        return new URL(to, new URL(from)).href;
    } catch {
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

function validAsciiLabel(label: string): boolean {
    return label.length <= 63 && /^[A-Za-z0-9_-]*$/.test(label);
}

export function domainToASCII(domain: string): string {
    const input = String(domain);
    if (input === '') return '';
    if (/^\[[0-9A-Fa-f:.]+\]$/.test(input)) return input;

    try {
        const labels = splitDomain(input);
        let invalid = false;
        const converted = labels.map(label => {
            if (label === '') return '';
            if (/^xn--/i.test(label)) {
                if (!/^[\x00-\x7F]+$/.test(label)) {
                    invalid = true;
                    return '';
                }
                punyDecode(label.slice(4));
            }
            if (/^[\x00-\x7F]+$/.test(label)) {
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
    const input = String(domain);
    if (input === '') return '';

    try {
        return splitDomain(input).map(label => {
            if (label.toLowerCase().startsWith('xn--')) {
                return punyDecode(label.slice(4));
            }
            return label;
        }).join('.');
    } catch {
        return '';
    }
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

export interface FileURLPathOptions {
    windows?: boolean;
}

export function fileURLToPath(url: string | URL, options?: FileURLPathOptions): string {
    if (typeof url !== 'string' && !isUrl(url)) {
        throw urlError(
            'The "path" argument must be of type string or an instance of URL',
            'ERR_INVALID_ARG_TYPE',
        );
    }

    if (typeof url === 'string' && !/^[a-z][a-z0-9.+-]*:/i.test(url)) {
        return url;
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
            'File URL host must be "localhost" or empty on this platform',
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
        throw urlError(
            'The "path" argument must be of type string or an instance of URL',
            'ERR_INVALID_ARG_TYPE',
        );
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
            'File URL host must be "localhost" or empty on this platform',
            'ERR_INVALID_FILE_URL_HOST',
        );
    }
    return decoded;
}

function getCwd(): string {
    const proc = Reflect.get(globalThis, 'process');
    const cwd = (proc && (typeof proc === 'object' || typeof proc === 'function'))
        ? Reflect.get(proc, 'cwd')
        : undefined;
    if (typeof cwd === 'function') return String(Reflect.apply(cwd, proc, []));
    try {
        return import.meta.use('os').cwd;
    } catch {
        return '/';
    }
}

function encodeFilePath(pathname: string): string {
    return encodeURI(pathname).replace(/[?#]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function pathToFileURL(filepath: string, options?: FileURLPathOptions): URL {
    if (typeof filepath !== 'string') {
        throw new TypeError('The "path" argument must be of type string');
    }

    let path = filepath;
    if (!path.startsWith('/') && !WINDOWS_DRIVE_RE.test(path) && !path.startsWith('\\\\')) {
        const cwd = getCwd();
        path = `${cwd.replace(/[\\/]+$/, '')}/${path}`;
    }

    const windows = options?.windows ?? process.platform === 'win32';
    if (windows) {
        path = path.replace(/\\/g, '/');
        if (path.startsWith('//')) {
            const withoutSlashes = path.slice(2);
            const slash = withoutSlashes.indexOf('/');
            const host = slash === -1 ? withoutSlashes : withoutSlashes.slice(0, slash);
            const rest = slash === -1 ? '/' : withoutSlashes.slice(slash);
            return new URL(`file://${host}${encodeFilePath(rest)}`);
        }
        if (/^[a-zA-Z]:/.test(path)) path = `/${path}`;
    }

    if (!path.startsWith('/')) path = `/${path}`;
    return new URL(`file://${encodeFilePath(path)}`);
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
        protocol: url.protocol,
        hostname: url.hostname,
        hash: url.hash,
        search: url.search,
        pathname: url.pathname,
        path: `${url.pathname}${url.search}`,
        href: url.href,
    };

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
