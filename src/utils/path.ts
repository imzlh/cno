
/**
 * Join path segments
 */
export function join(...segments: string[]): string {
    return segments
        .filter(Boolean)
        .join('/')
        .replace(/\/+/g, '/');
}

/**
 * Get directory name from path
 */
export function dirname(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash > 0 ? normalized.substring(0, lastSlash) : '.';
}

/**
 * Get file extension
 */
export function getExtension(path: string): string {
    const lastDot = path.lastIndexOf('.');
    return lastDot > 0 ? path.substring(lastDot) : '';
}

/**
 * Normalize path (resolve . and ..)
 */
export function normalize(path: string): string {
    const parts = path.split('/').filter(p => p && p !== '.');
    const result: string[] = [];

    for (const part of parts) {
        if (part === '..') {
            if (result.length > 0 && result.at(-1) !== '..') {
                result.pop();
            } else if (!path.startsWith('/')) {
                result.push('..');
            }
        } else {
            result.push(part);
        }
    }

    let normalized = result.join('/');
    if (path.startsWith('/') && !normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }

    return normalized || '.';
}