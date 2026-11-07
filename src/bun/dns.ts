const nativeDns = import.meta.use('dns');
const os = import.meta.use('os');

// Bun exposes stable flags. circu.js converts these bridge bits to the host
// AI_* values, which differ on platforms such as Windows.
const V4MAPPED = 8;
const ALL = 16;
const ADDRCONFIG = 32;
const SUPPORTED_FLAGS = V4MAPPED | ALL | ADDRCONFIG;

export type DNSLookupOptions = NonNullable<Parameters<typeof import('bun').dns.lookup>[1]>;
type DNSLookupResult = Awaited<ReturnType<typeof import('bun').dns.lookup>>;
type RuntimeLookupOptions = DNSLookupOptions & { protocol?: unknown; socktype?: unknown };
type DNSException = Error & {
    code: string;
    errno: number;
    syscall: 'getaddrinfo';
    hostname?: string;
};

const stringValueOf = String.prototype.valueOf;
const mathTrunc = Math.trunc;
const codedErrorPrototypes = new Map<string, object>();

function codedError<T extends Error>(error: T, code: string): T & { code: string } {
    const key = `${error.name}:${code}`;
    let prototype = codedErrorPrototypes.get(key);
    if (prototype === undefined) {
        prototype = Object.create(Object.getPrototypeOf(error));
        Object.defineProperties(prototype, {
            name: { value: error.name, writable: true, enumerable: true, configurable: true },
            code: { value: code, writable: true, enumerable: true, configurable: true },
            toString: {
                value(this: Error & { code: string }) {
                    return `${this.name} [${this.code}]: ${this.message}`;
                },
                writable: true,
                enumerable: true,
                configurable: true,
            },
        });
        codedErrorPrototypes.set(key, prototype!);
    }
    Object.setPrototypeOf(error, prototype!);
    return error as T & { code: string };
}

function invalidType(message: string): TypeError & { code: string } {
    return codedError(new TypeError(message), 'ERR_INVALID_ARG_TYPE');
}

function normalizeHostname(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value !== 'object' || value === null) throw invalidType('hostname must be a string');
    try {
        // Brand-check first: a Proxy around a String object is not a boxed string.
        Reflect.apply(stringValueOf, value, []);
    } catch {
        throw invalidType('hostname must be a string');
    }
    return String(value);
}

function readOption(options: unknown, property: PropertyKey): unknown {
    if (options == null) return undefined;
    return (options as Record<PropertyKey, unknown>)[property];
}

function dnsException(code: string, message: string, hostname?: string): DNSException {
    const errno = code === 'ENOTFOUND' ? 4 : code === 'EBADFAMILY' ? 9 : code === 'ECONNREFUSED' ? 11 : 0;
    const error = new Error(message) as DNSException;
    Object.defineProperties(error, {
        code: { value: `DNS_${code}`, writable: true, enumerable: true },
        syscall: { value: 'getaddrinfo', writable: true, enumerable: true },
        ...(hostname === undefined ? {} : { hostname: { value: hostname, writable: true, enumerable: true } }),
        errno: { value: errno, writable: true, enumerable: true },
        name: { value: 'DNSException', writable: true, enumerable: true, configurable: true },
    });
    return error;
}

function normalizedInteger(value: number): number {
    return Number.isNaN(value) ? 0 : mathTrunc(value);
}

function portText(value: number): string {
    if (value === Infinity || value >= 9_223_372_036_854_776_000) return '9223372036854775807';
    if (value === -Infinity || value <= -9_223_372_036_854_776_000) return '-9223372036854775808';
    return String(mathTrunc(value));
}

const lookup = (hostnameValue: unknown, options?: DNSLookupOptions): Promise<DNSLookupResult> => {
    const hostname = normalizeHostname(hostnameValue);
    const runtimeOptions = options as RuntimeLookupOptions | undefined;

    // Bun reads options in this order and type-checks before validating values.
    const port = readOption(runtimeOptions, 'port');
    if (port != null && typeof port !== 'number') throw invalidType('LookupOptions.port must be a number');
    const family = readOption(runtimeOptions, 'family');
    if (family != null && typeof family !== 'string' && typeof family !== 'number') {
        throw invalidType('LookupOptions.family must be of type string or number');
    }
    let socketType = readOption(runtimeOptions, 'socketType');
    if (socketType === undefined) socketType = readOption(runtimeOptions, 'socktype');
    if (socketType != null && typeof socketType !== 'string' && typeof socketType !== 'number') {
        throw invalidType('LookupOptions.socketType must be of type string or number');
    }
    const protocol = readOption(runtimeOptions, 'protocol');
    if (protocol != null && typeof protocol !== 'string' && typeof protocol !== 'number') {
        throw invalidType('LookupOptions.protocol must be of type string or number');
    }
    const backend = readOption(runtimeOptions, 'backend');
    if (backend != null && typeof backend !== 'string') throw invalidType('LookupOptions.backend must be a string');
    const flags = readOption(runtimeOptions, 'flags');
    if (flags != null && typeof flags !== 'number') throw invalidType('LookupOptions.flags must be a number');

    if (hostname.length === 0) {
        throw invalidType("Expected hostname to be a non-empty string for 'lookup'.");
    }

    if (typeof port === 'number') {
        if (Number.isNaN(port)) throw codedError(new RangeError('Invalid port number'), 'ERR_SOCKET_BAD_PORT');
        const normalizedPort = mathTrunc(port);
        if (normalizedPort < 0 || normalizedPort > 65535 || !Number.isFinite(normalizedPort)) {
            throw codedError(new RangeError(`Port number out of range: ${portText(port)}`), 'ERR_SOCKET_BAD_PORT');
        }
    }

    const normalizedFamily = typeof family === 'number' ? normalizedInteger(family) : family;
    let nativeFamily: number;
    if (normalizedFamily == null || normalizedFamily === 0 || normalizedFamily === '' || normalizedFamily === 'any') {
        nativeFamily = os.AF_UNSPEC;
    } else if (normalizedFamily === 4 || normalizedFamily === 'ipv4' || normalizedFamily === 'IPv4') {
        nativeFamily = os.AF_INET;
    } else if (normalizedFamily === 6 || normalizedFamily === 'ipv6' || normalizedFamily === 'IPv6') {
        nativeFamily = os.AF_INET6;
    } else {
        throw new Error('Invalid options passed to lookup(): InvalidFamily');
    }

    const normalizedSocketType = typeof socketType === 'number' ? normalizedInteger(socketType) : socketType;
    if (normalizedSocketType != null && normalizedSocketType !== '' && normalizedSocketType !== 0
        && normalizedSocketType !== 1 && normalizedSocketType !== 2
        && normalizedSocketType !== 'tcp' && normalizedSocketType !== 'udp') {
        throw new Error('Invalid options passed to lookup(): InvalidSocketType');
    }

    const normalizedProtocol = typeof protocol === 'number' ? normalizedInteger(protocol) : protocol;
    if (normalizedProtocol != null && normalizedProtocol !== '' && normalizedProtocol !== 0
        && normalizedProtocol !== 6 && normalizedProtocol !== 17
        && normalizedProtocol !== 'tcp' && normalizedProtocol !== 'udp') {
        throw new Error('Invalid options passed to lookup(): InvalidProtocol');
    }

    if (backend != null && backend !== ''
        && backend !== 'libc' && backend !== 'c-ares' && backend !== 'system' && backend !== 'getaddrinfo') {
        throw new Error('Invalid options passed to lookup(): InvalidBackend');
    }

    const normalizedFlags = typeof flags === 'number' ? normalizedInteger(flags) : 0;
    if (!Number.isFinite(normalizedFlags) || normalizedFlags < 0 || normalizedFlags > SUPPORTED_FLAGS
        || (normalizedFlags & ~SUPPORTED_FLAGS) !== 0) {
        throw codedError(
            new TypeError(`The "flags" argument is invalid. Received type number (${String(flags)})`),
            'ERR_INVALID_ARG_VALUE',
        );
    }

    if (hostname.includes('\0')) {
        return Promise.reject(dnsException('ENOTFOUND', `getaddrinfo ENOTFOUND ${hostname}`, hostname));
    }

    return nativeDns.resolve(hostname, { family: nativeFamily, hints: normalizedFlags }).then(
        addresses => addresses.map(({ ip, family: addressFamily }) => ({
            address: ip,
            family: addressFamily as 4 | 6,
            ttl: 0,
        })),
        (cause: unknown) => {
            const rawCode = typeof cause === 'object' && cause !== null && 'code' in cause
                ? String(cause.code)
                : 'EAI_FAIL';
            const code = rawCode === 'EAI_ADDRFAMILY' || rawCode === 'EAI_FAMILY' ? 'EBADFAMILY' : rawCode;
            throw dnsException(code, `getaddrinfo ${code}`, code === 'ENOTFOUND' ? hostname : undefined);
        },
    );
};

export const dns = Object.defineProperties({}, {
    lookup: { value: lookup, writable: true, enumerable: true },
    ADDRCONFIG: { value: ADDRCONFIG, writable: true, enumerable: true },
    ALL: { value: ALL, writable: true, enumerable: true },
    V4MAPPED: { value: V4MAPPED, writable: true, enumerable: true },
}) as {
    lookup: typeof lookup;
    ADDRCONFIG: number;
    ALL: number;
    V4MAPPED: number;
};
