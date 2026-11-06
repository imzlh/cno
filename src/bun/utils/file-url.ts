import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from '../../node/url/mod';

/** Convert a filesystem path to a file URL using the host platform's rules. */
export function pathToFileURL(path: string): URL {
    if (typeof path === 'symbol') throw new TypeError('Cannot convert a symbol to a string');
    return nodePathToFileURL(String(path));
}

/** Bun accepts only file URLs, unlike cno's Node helper's runtime-specific schemes. */
export function fileURLToPath(url: URL | string): string {
    if (typeof url === 'string' && !/^file:/i.test(url)) {
        throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
    }
    if (typeof url !== 'string' && url instanceof URL && url.protocol !== 'file:') {
        throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
    }
    return nodeFileURLToPath(url);
}
