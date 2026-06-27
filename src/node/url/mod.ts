/**
 * Node.js url module compatibility.
 *
 * WHATWG URL objects come from the runtime web API polyfill. This module keeps
 * Node's legacy url.parse/format/resolve helpers and the file URL helpers
 * separate so Node semantics do not depend on quirks in that polyfill.
 */

const { URL, URLSearchParams } = globalThis;

export { URL, URLSearchParams };

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
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
            }
        } else {
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
    }
    return pairs.join('&');
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

export function parse(urlStr: string, parseQueryString = false, slashesDenoteHost = false): UrlWithStringQuery | UrlWithParsedQuery {
    if (typeof urlStr !== 'string') {
        throw new TypeError('The "url" argument must be of type string.');
    }

    let rest = urlStr.trim();
    const result: UrlWithStringQuery = {
        protocol: null,
        slashes: null,
        auth: null,
        host: null,
        port: null,
        hostname: null,
        hash: null,
        search: null,
        query: parseQueryString ? '' : null,
        pathname: null,
        path: null,
        href: '',
    };

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
        result.query = parseQueryString ? parseQuery(query) as any : query;
        rest = rest.slice(0, queryIndex);
    } else if (parseQueryString) {
        result.query = Object.create(null) as any;
    }

    if (rest || result.host || result.protocol) {
        result.pathname = rest || (result.host ? '/' : null);
    }
    if (result.pathname !== null || result.search !== null) {
        result.path = `${result.pathname ?? ''}${result.search ?? ''}`;
    }

    result.href = format(result);
    return result as UrlWithStringQuery | UrlWithParsedQuery;
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
    if (url instanceof URL) {
        return formatWhatwgUrl(url, options);
    }

    const protocol = normalizeProtocol(url.protocol);
    const slashes = Boolean(url.slashes) || (protocol !== null && SLASHED_PROTOCOLS.has(protocol));
    let out = protocol ?? '';

    let host = url.host ?? null;
    if (!host && url.hostname) {
        host = url.hostname;
        if (url.port) host += `:${url.port}`;
    }

    if (slashes || host) {
        out += '//';
        if (url.auth) out += `${encodeAuth(String(url.auth)).replace(UNSAFE_AUTH, encodeURIComponent)}@`;
        if (host) out += host;
    }

    let pathname = url.pathname ?? '';
    if (pathname && host && !pathname.startsWith('/')) pathname = `/${pathname}`;
    out += pathname;

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
        const base = parse(from);
        const target = parse(to);
        if (target.search && !target.pathname) {
            base.search = target.search;
            base.query = target.query as any;
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
    const codePoints = Array.from(input, ch => ch.codePointAt(0)!);
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

    try {
        const labels = splitDomain(input);
        let invalid = false;
        const converted = labels.map(label => {
            if (label === '') return '';
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
    return value instanceof URL;
}

function assertFileUrl(value: URL): void {
    if (value.protocol !== 'file:') {
        throw new TypeError('The URL must be of scheme file');
    }
}

function runtimeSpecToLocalPath(spec: string): string | null {
    try {
        const cts = (globalThis as any)[Symbol.for('cts.internal')];
        if (typeof cts?.specToLocalPath === 'function') {
            return cts.specToLocalPath(spec);
        }
    } catch {}
    return null;
}

function decodePathname(pathname: string): string {
    if (/%2f|%5c/i.test(pathname)) {
        throw new TypeError('File URL path must not include encoded / or \\ characters');
    }
    return decodeURIComponent(pathname);
}

export function fileURLToPath(url: string | URL): string {
    if (typeof url !== 'string' && !isUrl(url)) {
        throw new TypeError('The "url" argument must be of type string or an instance of URL');
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
    let pathname = decodePathname(parsed.pathname);

    if (process.platform === 'win32') {
        pathname = pathname.replace(/\//g, '\\');
        if (hostname) return `\\\\${hostname}${pathname}`;
        if (/^\\[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1);
        return pathname;
    }

    if (hostname && hostname !== 'localhost') {
        throw new TypeError('File URL host must be "localhost" or empty on this platform');
    }
    return pathname;
}

function getCwd(): string {
    const proc = (globalThis as any).process;
    if (proc && typeof proc.cwd === 'function') return proc.cwd();
    try {
        return import.meta.use('os').cwd;
    } catch {
        return '/';
    }
}

function encodeFilePath(pathname: string): string {
    return encodeURI(pathname).replace(/[?#]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function pathToFileURL(filepath: string): URL {
    if (typeof filepath !== 'string') {
        throw new TypeError('The "path" argument must be of type string');
    }

    let path = filepath;
    if (!path.startsWith('/') && !WINDOWS_DRIVE_RE.test(path) && !path.startsWith('\\\\')) {
        const cwd = getCwd();
        path = `${cwd.replace(/[\\/]+$/, '')}/${path}`;
    }

    if (process.platform === 'win32') {
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
    URLSearchParams,
    parse,
    resolve,
    format,
    domainToASCII,
    domainToUnicode,
    fileURLToPath,
    pathToFileURL,
    urlToHttpOptions,
};
