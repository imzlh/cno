import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from '../../node/url/mod';

const urlHrefGetter = Object.getOwnPropertyDescriptor(URL.prototype, 'href')?.get;
const urlProtocolGetter = Object.getOwnPropertyDescriptor(URL.prototype, 'protocol')?.get;

function isURL(value: unknown): value is URL {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !urlHrefGetter || !urlProtocolGetter) {
        return false;
    }
    try {
        Reflect.apply(urlHrefGetter, value, []);
        Reflect.apply(urlProtocolGetter, value, []);
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

/** Convert a filesystem path to a file URL using the host platform's rules. */
export function pathToFileURL(path: string): URL {
    if (typeof path === 'symbol') throw new TypeError('Cannot convert a symbol to a string');
    return nodePathToFileURL(String(path));
}

/** Bun accepts only file URLs, unlike cno's Node helper's runtime-specific schemes. */
export function fileURLToPath(url: URL | string): string {
    if (typeof url === 'string') {
        if (!/^file:/i.test(url)) throw invalidScheme();
    } else if (!isURL(url)) {
        throw invalidUrlArgument(url);
    } else if (urlProtocolGetter && Reflect.apply(urlProtocolGetter, url, []) !== 'file:') {
        throw invalidScheme();
    }
    return nodeFileURLToPath(url);
}
