const nativeDns = import.meta.use('dns');
const os = import.meta.use('os');

export type DNSLookupOptions = NonNullable<Parameters<typeof import('bun').dns.lookup>[1]>;
type DNSLookupResult = Awaited<ReturnType<typeof import('bun').dns.lookup>>;

function codedError<T extends Error>(error: T, code: string): T {
    return Object.assign(error, { code });
}

function lookup(hostname: string, options?: DNSLookupOptions): Promise<DNSLookupResult> {
    if (typeof hostname !== 'string' || hostname.length === 0) {
        throw codedError(new TypeError(`Expected hostname to be a ${typeof hostname === 'string' ? 'non-empty string' : 'string'} for 'lookup'.`), 'ERR_INVALID_ARG_TYPE');
    }
    if (hostname.includes('\0')) {
        const error = codedError(new Error(`getaddrinfo ENOTFOUND ${hostname}`), 'DNS_ENOTFOUND');
        error.name = 'DNSException';
        return Promise.reject(error);
    }
    const family = options?.family;
    let nativeFamily: number;
    if (family == null || family === 0 || family === 'any') nativeFamily = os.AF_UNSPEC;
    else if (family === 4 || (typeof family === 'string' && family.toLowerCase() === 'ipv4')) nativeFamily = os.AF_INET;
    else if (family === 6 || (typeof family === 'string' && family.toLowerCase() === 'ipv6')) nativeFamily = os.AF_INET6;
    else throw new Error('Invalid options passed to lookup(): InvalidFamily');

    const backend = options?.backend;
    if (backend != null && !['libc', 'c-ares', 'system', 'getaddrinfo'].includes(backend)) {
        throw new Error('Invalid options passed to lookup(): InvalidBackend');
    }
    if (backend === 'c-ares') {
        throw new TypeError('Bun.dns.lookup: the c-ares backend is unsupported by this runtime.');
    }
    const socketType = options?.socketType;
    if (socketType != null && socketType !== 'tcp' && socketType !== 'udp') {
        throw new Error('Invalid options passed to lookup(): InvalidSocketType');
    }
    const port = options?.port;
    if (port != null && (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)) {
        throw codedError(new RangeError(typeof port !== 'number' ? 'Invalid port number' : `Port number out of range: ${port}`), 'ERR_SOCKET_BAD_PORT');
    }
    const flags = options?.flags;
    const supportedFlags = nativeDns.ADDRCONFIG | nativeDns.ALL | nativeDns.V4MAPPED;
    if (
        flags != null
        && (
            typeof flags !== 'number'
            || !Number.isSafeInteger(flags)
            || flags < 0
            || flags > supportedFlags
            || (flags & ~supportedFlags) !== 0
        )
    ) {
        throw codedError(new TypeError(`The "flags" argument is invalid. Received type ${typeof flags} (${String(flags)})`), 'ERR_INVALID_ARG_VALUE');
    }

    return nativeDns.resolve(hostname, { family: nativeFamily, hints: flags }).then(
        addresses => addresses.map(({ ip, family }) => ({ address: ip, family: family as 4 | 6, ttl: 0 })),
        (cause: unknown) => {
            const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : 'EAI_FAIL';
            const error = codedError(new Error(`getaddrinfo ${code}`), `DNS_${code}`);
            error.name = 'DNSException';
            throw error;
        },
    );
}

export const dns = {
    lookup,
    ADDRCONFIG: nativeDns.ADDRCONFIG,
    ALL: nativeDns.ALL,
    V4MAPPED: nativeDns.V4MAPPED,
};
