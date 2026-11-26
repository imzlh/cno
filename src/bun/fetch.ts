import { normalizeTlsOptions } from './tls';

const webFetch = globalThis.fetch;
const unsupportedOptions = [
    'verbose', 'session', 's3', 'unix', 'protocol', 'decompress', 'compress', 'maxRedirects', 'timeout',
] as const;

function proxyOptions(value: unknown): { url: string } | false | undefined {
    if (value === false) return false;
    let url = value;
    if (value !== null && typeof value === 'object' && !(value instanceof URL)) {
        const options = value as Record<string, unknown>;
        url = options.url;
        if (url === undefined || url === null) return undefined;
        if (options.headers !== undefined) throw new TypeError('Bun.fetch: custom proxy headers are unsupported.');
        if (options.respectNoProxy !== undefined && options.respectNoProxy !== true) {
            throw new TypeError('Bun.fetch: proxy respectNoProxy must be true when supplied.');
        }
    } else if (value === undefined || value === null || value === '' || typeof value === 'number') {
        return undefined;
    }
    if (typeof url !== 'string' && !(url instanceof URL)) throw new TypeError('Bun.fetch: proxy must name an HTTP or HTTPS URL.');
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new TypeError('Bun.fetch: only HTTP and HTTPS proxies are supported.');
    }
    return { url: parsed.href };
}

export const fetch: typeof globalThis.fetch = async function fetch(input, init = undefined) {
    const options = init !== null && (typeof init === 'object' || typeof init === 'function')
        ? init as RequestInit & Record<string, unknown>
        : undefined;
    if (options === undefined) return webFetch(input);
    for (const name of unsupportedOptions) {
        if (Reflect.get(options, name) !== undefined) {
            throw new TypeError(`Bun.fetch: unsupported Bun-specific option "${name}".`);
        }
    }

    const proxy = proxyOptions(options.proxy);
    const tlsInput = options.tls;
    const tls = tlsInput !== null && typeof tlsInput === 'object'
        ? normalizeTlsOptions(tlsInput, 'client')
        : undefined;
    if (tls?.alpnProtocols !== undefined || tls?.servername !== undefined) {
        throw new TypeError('Bun.fetch: custom TLS ALPN and serverName are unsupported.');
    }
    if (proxy === false && tls === undefined) {
        return webFetch(input, new Proxy({} as RequestInit, {
            get(_target, name) {
                return name === 'client' ? null : Reflect.get(options, name, options);
            },
            has(_target, name) {
                return name === 'client' || Reflect.has(options, name);
            },
        }));
    }
    if ((proxy === undefined || proxy === false) && tls === undefined) return webFetch(input, options);
    if (options.client !== undefined && options.client !== null) {
        throw new TypeError('Bun.fetch: a host client cannot be combined with proxy or TLS options.');
    }

    const client = Deno.createHttpClient({ proxy: proxy === false ? undefined : proxy, caCerts: tls?.caCerts, cert: tls?.cert, key: tls?.key });
    try {
        // Preserve dictionary getters' receivers while supplying the host client.
        const clientInit = new Proxy({} as RequestInit, {
            get(_target, name) {
                return name === 'client' ? client : Reflect.get(options, name, options);
            },
            has(_target, name) {
                return name === 'client' || Reflect.has(options, name);
            },
        });
        return await webFetch(input, clientInit);
    } finally {
        // In-flight response bodies retain the pool through the host lease.
        client.close();
    }
};
