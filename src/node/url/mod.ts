/**
 * Node.js url module
 */

const { URL, URLSearchParams } = globalThis;

export { URL, URLSearchParams };

export function parse(urlStr: string, parseQueryString?: boolean, slashesDenoteHost?: boolean): {
    protocol?: string;
    host?: string;
    auth?: string;
    hostname?: string;
    port?: string;
    pathname?: string;
    path?: string;
    query?: string | Record<string, string>;
    hash?: string;
} {
    const url = new URL(urlStr);
    const result: any = {
        protocol: url.protocol,
        host: url.host,
        auth: url.username ? (url.password ? `${url.username}:${url.password}` : url.username) : undefined,
        hostname: url.hostname,
        port: url.port || undefined,
        pathname: url.pathname,
        path: url.pathname + url.search,
        hash: url.hash.replace('#', '') || undefined,
    };

    if (parseQueryString) {
        result.query = {};
        url.searchParams.forEach((value, key) => {
            result.query[key] = value;
        });
    } else {
        result.query = url.search.replace('?', '') || undefined;
    }

    return result;
}

export function resolve(from: string, to: string): string {
    const base = new URL(from);
    return new URL(to, base).toString();
}

export function format(url: string | URL, options?: {
    auth?: boolean;
    fragment?: boolean;
    search?: boolean;
    unicode?: boolean;
}): string {
    if (typeof url === 'string') {
        url = new URL(url);
    }

    let result = url.toString();

    if (options) {
        if (options.fragment === false) {
            const idx = result.indexOf('#');
            if (idx !== -1) result = result.slice(0, idx);
        }
        if (options.search === false) {
            const idx = result.indexOf('?');
            if (idx !== -1) result = result.slice(0, idx);
        }
        if (options.auth === false) {
            try {
                const u = new URL(result);
                if (u.username) {
                    result = `${u.protocol}//${u.host}${u.pathname}${u.search}${u.hash}`;
                }
            } catch {}
        }
    }

    return result;
}

export function domainToASCII(domain: string): string {
    try {
        const url = new URL(`https://${domain}`);
        return url.hostname;
    } catch {
        return domain;
    }
}

export function domainToUnicode(domain: string): string {
    try {
        // Try to decode punycode: if hostname differs from input, it had punycode
        const url = new URL(`https://${domain}`);
        return url.hostname;
    } catch {
        return domain;
    }
}

export function fileURLToPath(url: string | URL): string {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.protocol !== 'file:') {
        throw new TypeError('URL must be a file URL');
    }

    let path = decodeURIComponent(parsed.pathname);

    if (process.platform === 'win32') {
        if (parsed.hostname) {
            return `\\\\${parsed.hostname}${path.replace(/\//g, '\\')}`;
        }
        if (path.startsWith('/')) {
            path = path.slice(1);
        }
        path = path.replace(/\//g, '\\');
    } else if (parsed.hostname) {
        path = `//${parsed.hostname}${path}`;
    }

    return path;
}

export function pathToFileURL(filepath: string): URL {
    let pathname = filepath;

    if (process.platform === 'win32') {
        pathname = pathname.replace(/\\/g, '/');
        if (pathname.match(/^[a-zA-Z]:/)) {
            pathname = `/${pathname}`;
        }
    }

    if (!pathname.startsWith('/')) {
        pathname = `/${pathname}`;
    }

    const url = new URL(`file://${pathname}`);
    return url;
}

export function urlToHttpOptions(url: URL): {
    protocol?: string;
    hostname?: string;
    host?: string;
    port?: number | undefined;
    pathname?: string;
    path?: string;
    search?: string | undefined;
    username?: string;
    password?: string;
} {
    const result: any = {
        protocol: url.protocol,
        hostname: url.hostname,
        host: url.host,
        port: url.port ? parseInt(url.port) : undefined,
        pathname: url.pathname,
        path: url.pathname + url.search,
        search: url.search || undefined,
    };

    if (url.username) {
        result.username = url.username;
        if (url.password) {
            result.password = url.password;
        }
    }

    return result;
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
