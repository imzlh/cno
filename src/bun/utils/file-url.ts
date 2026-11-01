import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from '../../node/url/mod';

/** Convert a filesystem path to a file URL using the host platform's rules. */
export function pathToFileURL(path: string): URL {
    return nodePathToFileURL(path);
}

/** Bun accepts only file URLs, unlike cno's Node helper's runtime-specific schemes. */
export function fileURLToPath(url: URL | string): string {
    if (typeof url === 'string' && !/^file:/i.test(url)) {
        throw new TypeError('The URL must be of scheme file');
    }
    if (typeof url !== 'string' && url instanceof URL && url.protocol !== 'file:') {
        throw new TypeError('The URL must be of scheme file');
    }
    return nodeFileURLToPath(url);
}
