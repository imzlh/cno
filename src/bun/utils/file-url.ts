import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from '../../node/url/mod';

const urlHrefGetter = Object.getOwnPropertyDescriptor(URL.prototype, 'href')?.get;
const urlProtocolGetter = Object.getOwnPropertyDescriptor(URL.prototype, 'protocol')?.get;
const urlHostnameGetter = Object.getOwnPropertyDescriptor(URL.prototype, 'hostname')?.get;
const urlPathnameDescriptor = Object.getOwnPropertyDescriptor(URL.prototype, 'pathname');
const urlPathnameGetter = urlPathnameDescriptor?.get;
const urlPathnameSetter = urlPathnameDescriptor?.set;
const URLConstructor = URL;
const URIErrorConstructor = URIError;

function isURL(value: unknown): value is URL {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null ||
        !urlProtocolGetter || !urlHostnameGetter || !urlPathnameGetter) {
        return false;
    }
    try {
        Reflect.apply(urlProtocolGetter, value, []);
        Reflect.apply(urlHostnameGetter, value, []);
        Reflect.apply(urlPathnameGetter, value, []);
        return true;
    } catch {
        return false;
    }
}

function describeReceived(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    const type = typeof value;
    if (type === 'string') return `type string ('${value as string}')`;
    if (type === 'number' || type === 'boolean' || type === 'bigint' || type === 'symbol') {
        return `type ${type} (${String(value)}${type === 'bigint' ? 'n' : ''})`;
    }
    if (type === 'function') return `function ${(value as Function).name}`;
    const object = value as { constructor?: { name?: string } };
    return `an instance of ${object.constructor?.name ?? 'Object'}`;
}

function invalidUrlArgument(value: unknown): TypeError & { code: string } {
    return Object.assign(
        new TypeError(`The "url" argument must be of type string. Received ${describeReceived(value)}`),
        { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

function invalidScheme(): TypeError & { code: string } {
    return Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
}

function preprocessUrlString(value: string): string {
    return value
        .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
        .replace(/[\t\n\r]/g, '');
}

function escapeMalformedPathPercents(url: URL | string): string {
    const parsed = typeof url === 'string' ? new URLConstructor(url) : url;
    const pathname = Reflect.apply(urlPathnameGetter!, parsed, []);
    if (!/%(?![0-9a-f]{2})/i.test(pathname)) {
        if (typeof url === 'string') return url;
        const hostname = Reflect.apply(urlHostnameGetter!, parsed, []);
        return `file://${hostname}${pathname}`;
    }

    const escaped = pathname.replace(/%(?![0-9a-f]{2})/gi, '%25');
    const normalized = new URLConstructor(`file://${Reflect.apply(urlHostnameGetter!, parsed, [])}${pathname}`);
    Reflect.apply(urlPathnameSetter!, normalized, [escaped]);
    return Reflect.apply(urlHrefGetter!, normalized, []);
}

/** Convert a filesystem path to a file URL using the host platform's rules. */
export const pathToFileURL = (path: string): URL => {
    if (typeof path === 'symbol') throw new TypeError('Cannot convert a symbol to a string');
    return nodePathToFileURL(String(path));
};

/** Bun accepts only file URLs, unlike cno's Node helper's runtime-specific schemes. */
export const fileURLToPath = (url: URL | string): string => {
    if (typeof url === 'string') {
        url = preprocessUrlString(url);
        if (!/^file:/i.test(url)) throw invalidScheme();
    } else if (!isURL(url)) {
        throw invalidUrlArgument(url);
    } else if (urlProtocolGetter && Reflect.apply(urlProtocolGetter, url, []) !== 'file:') {
        throw invalidScheme();
    }
    const normalized = escapeMalformedPathPercents(url);
    try {
        return nodeFileURLToPath(normalized);
    } catch (error) {
        // Bun preserves malformed percent escapes, but maps invalid UTF-8 byte
        // sequences to an empty path instead of surfacing decodeURIComponent's URIError.
        if (error instanceof URIErrorConstructor) return '';
        throw error;
    }
};
