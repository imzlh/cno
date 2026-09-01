/**
 * DNS module internal helpers shared between mod.ts and promises.ts
 */

const dns = import.meta.use('dns');
const timers = import.meta.use('timers');
const uverror = import.meta.use('error');

import { toErrnoException } from '../_internal/errno';

export type DefaultResultOrder = 'ipv4first' | 'ipv6first' | 'verbatim';

export const typeMap = {
    A: dns.A,
    AAAA: dns.AAAA,
    CAA: dns.CAA,
    CNAME: dns.CNAME,
    MX: dns.MX,
    NAPTR: dns.NAPTR,
    NS: dns.NS,
    PTR: dns.PTR,
    SOA: dns.SOA,
    SRV: dns.SRV,
    TXT: dns.TXT,
    ANY: dns.ANY,
} as const;

export type Rrtype = keyof typeof typeMap;

export type AbortableDnsQuery = Promise<CModuleDNS.DNSAnswer[]> & {
    abort: () => void;
};

export interface NodeCaaRecord {
    critical: number;
    issue?: string;
    issuewild?: string;
    iodef?: string;
    contactemail?: string;
    contactphone?: string;
}

export interface NodeMxRecord {
    priority: number;
    exchange: string;
}

export interface NodeNaptrRecord {
    flags: string;
    service: string;
    regexp: string;
    replacement: string;
    order: number;
    preference: number;
}

export interface NodeSoaRecord {
    nsname: string;
    hostmaster: string;
    serial: number;
    refresh: number;
    retry: number;
    expire: number;
    minttl: number;
}

export interface NodeSrvRecord {
    priority: number;
    weight: number;
    port: number;
    name: string;
}

export type NodeAnyRecord =
    | ({ type: 'A' | 'AAAA'; address: string; ttl: number })
    | ({ type: 'CAA' } & NodeCaaRecord)
    | { type: 'CNAME' | 'NS' | 'PTR'; value: string }
    | ({ type: 'MX' } & NodeMxRecord)
    | ({ type: 'NAPTR' } & NodeNaptrRecord)
    | ({ type: 'SOA' } & NodeSoaRecord)
    | ({ type: 'SRV' } & NodeSrvRecord)
    | { type: 'TXT'; entries: string[] };

export type ShapedDnsAnswers =
    | string[]
    | NodeAnyRecord[]
    | NodeCaaRecord[]
    | NodeMxRecord[]
    | NodeNaptrRecord[]
    | NodeSoaRecord
    | NodeSrvRecord[]
    | string[][]
    | null;

export interface DnsResultMap {
    A: string[];
    AAAA: string[];
    ANY: NodeAnyRecord[];
    CAA: NodeCaaRecord[];
    CNAME: string[];
    MX: NodeMxRecord[];
    NAPTR: NodeNaptrRecord[];
    NS: string[];
    PTR: string[];
    SOA: NodeSoaRecord | null;
    SRV: NodeSrvRecord[];
    TXT: string[][];
}

export interface NormalizedLookupOptions {
    family: 0 | 4 | 6;
    all: boolean;
    hints: number;
    order: DefaultResultOrder;
}

export interface ResolverOptions {
    timeout?: number;
    tries?: number;
    maxTimeout?: number;
}

const DNS_QUERY_TIMEOUT_MS = 2000;
const DEFAULT_RESOLVER_TRIES = 4;

const VALID_HINTS = dns.V4MAPPED | dns.ALL | dns.ADDRCONFIG;
const RETRYABLE_DNS_CODES = new Set([
    'ETIMEOUT', 'EAI_AGAIN', 'ESERVFAIL', 'ECONNREFUSED', 'ECONNRESET',
    'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EIO', 'EBADRESP',
]);

export function isAddressAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.AddressAnswer {
    return (answer.type === dns.A || answer.type === dns.AAAA) && 'address' in answer;
}

function isCnameAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.CNameAnswer {
    return answer.type === dns.CNAME;
}

function isCaaAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.CaaAnswer {
    return answer.type === dns.CAA;
}

function isMxAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.MxAnswer {
    return answer.type === dns.MX;
}

function isNaptrAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.NaptrAnswer {
    return answer.type === dns.NAPTR;
}

function isNsAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.NsAnswer {
    return answer.type === dns.NS;
}

function isPtrAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.PtrAnswer {
    return answer.type === dns.PTR;
}

function isSoaAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.SoaAnswer {
    return answer.type === dns.SOA;
}

function isSrvAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.SrvAnswer {
    return answer.type === dns.SRV;
}

export function isTxtAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.TxtAnswer {
    return answer.type === dns.TXT;
}

function invalidArgType(message: string): TypeError & { code: string } {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

function invalidArgValue(message: string): TypeError & { code: string } {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_VALUE' });
}

export function validateHostname(hostname: unknown): asserts hostname is string {
    if (typeof hostname !== 'string') {
        throw invalidArgType(`The "name" argument must be of type string. Received ${String(hostname)}`);
    }
}

export function normalizeLookupFamily(family: unknown, allowNames = false): 0 | 4 | 6 {
    if (allowNames && family === 'IPv4') return 4;
    if (allowNames && family === 'IPv6') return 6;
    if (family === 0 || family === 4 || family === 6) return family;
    throw invalidArgValue(`The property 'options.family' must be one of: 0, 4, 6. Received ${String(family)}`);
}

export function normalizeLookupOptions(
    options: unknown,
    defaultOrder: DefaultResultOrder = 'verbatim',
    allowFamilyNames = false,
): NormalizedLookupOptions {
    if (options === undefined || options === null) {
        return { family: 0, all: false, hints: 0, order: defaultOrder };
    }
    if (typeof options === 'number') {
        return { family: normalizeLookupFamily(options, allowFamilyNames), all: false, hints: 0, order: defaultOrder };
    }
    if (typeof options !== 'object') {
        throw invalidArgType(`The "options" argument must be of type object or integer. Received type ${typeof options}`);
    }

    const family = normalizeLookupFamily(Reflect.get(options, 'family') ?? 0, allowFamilyNames);
    const rawAll = Reflect.get(options, 'all');
    if (rawAll != null && typeof rawAll !== 'boolean') {
        throw invalidArgType(`The "options.all" property must be of type boolean. Received type ${typeof rawAll}`);
    }

    const rawHints = Reflect.get(options, 'hints');
    let hints = 0;
    if (rawHints != null) {
        if (typeof rawHints !== 'number') {
            throw invalidArgType(`The "options.hints" property must be of type number. Received type ${typeof rawHints}`);
        }
        hints = rawHints >>> 0;
        if ((hints & ~VALID_HINTS) !== 0) {
            // Node reports the uint32-coerced value, not the raw argument, so
            // 8.5 surfaces as 8 and -1 as 4294967295.
            throw invalidArgValue(`The argument 'hints' is invalid. Received ${String(hints)}`);
        }
    }

    const rawOrder = Reflect.get(options, 'order');
    const rawVerbatim = Reflect.get(options, 'verbatim');
    if (rawVerbatim != null && typeof rawVerbatim !== 'boolean') {
        throw invalidArgType(`The "options.verbatim" property must be of type boolean. Received type ${typeof rawVerbatim}`);
    }

    let order = defaultOrder;
    if (rawOrder != null) {
        validateDefaultResultOrder(rawOrder);
        order = rawOrder;
    } else if (rawVerbatim != null) {
        order = rawVerbatim ? 'verbatim' : 'ipv4first';
    }

    return { family, all: rawAll ?? false, hints, order };
}

export function orderLookupAddresses(
    addresses: readonly CModuleDNS.ResolvedAddress[],
    order: DefaultResultOrder,
): CModuleDNS.ResolvedAddress[] {
    if (order === 'verbatim') return [...addresses];
    const preferredFamily = order === 'ipv4first' ? 4 : 6;
    return [
        ...addresses.filter(address => address.family === preferredFamily),
        ...addresses.filter(address => address.family !== preferredFamily),
    ];
}

export function validateRrtype(rrtype: unknown): Rrtype {
    if (typeof rrtype !== 'string') throw invalidArgType('The "rrtype" argument must be of type string');
    if (!Object.hasOwn(typeMap, rrtype)) throw invalidArgValue(`The argument 'rrtype' is invalid. Received '${rrtype}'`);
    return rrtype as Rrtype;
}

export function validateDefaultResultOrder(order: unknown): asserts order is DefaultResultOrder {
    if (order !== 'verbatim' && order !== 'ipv4first' && order !== 'ipv6first') {
        throw invalidArgValue(
            `The argument 'dnsOrder' must be one of: 'verbatim', 'ipv4first', 'ipv6first'. Received ${
                typeof order === 'string' ? `'${order}'` : String(order)
            }`,
        );
    }
}

function validatePort(raw: string): number {
    if (!/^\d+$/.test(raw)) throw invalidIpAddress(`Invalid DNS server port: ${raw}`);
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalidIpAddress(`Invalid DNS server port: ${raw}`);
    return port;
}

function invalidIpAddress(message: string): TypeError & { code: string } {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_IP_ADDRESS' });
}

function outOfRange(name: string, value: unknown): RangeError & { code: string } {
    return Object.assign(
        new RangeError(`The value of "${name}" is out of range. Received ${String(value)}`),
        { code: 'ERR_OUT_OF_RANGE' },
    );
}

function isIPv4(host: string): boolean {
    const parts = host.split('.');
    return parts.length === 4 && parts.every((part) => {
        if (!/^\d+$/.test(part)) return false;
        const value = Number(part);
        return value >= 0 && value <= 255 && String(value) === part;
    });
}

function isIPv6(host: string): boolean {
    const zoneSeparator = host.indexOf('%');
    if (zoneSeparator !== -1) {
        if (zoneSeparator === host.length - 1 || zoneSeparator !== host.lastIndexOf('%')) return false;
        host = host.slice(0, zoneSeparator);
    }
    const separator = host.indexOf('::');
    if (separator !== -1 && separator !== host.lastIndexOf('::')) return false;

    let value = host;
    const lastColon = value.lastIndexOf(':');
    const tail = value.slice(lastColon + 1);
    if (tail.includes('.')) {
        if (!isIPv4(tail)) return false;
        value = `${value.slice(0, lastColon)}:0:0`;
    }

    const compressed = value.includes('::');
    const segments = value.split(':').filter(Boolean);
    if (!segments.every(segment => /^[0-9a-fA-F]{1,4}$/.test(segment))) return false;
    const count = segments.length;
    return compressed ? count < 8 : count === 8;
}

export function getAddressFamily(address: string): 0 | 4 | 6 {
    if (isIPv4(address)) return 4;
    if (isIPv6(address)) return 6;
    return 0;
}

export function validateLookupServiceAddress(address: unknown): asserts address is string {
    if (typeof address === 'string' && getAddressFamily(address) !== 0) return;
    throw invalidArgValue(
        `The argument 'address' is invalid. Received ${typeof address === 'string' ? `'${address}'` : String(address)}`,
    );
}

export function normalizeLookupServicePort(port: unknown): number {
    const numeric = typeof port === 'number' || typeof port === 'string' ? Number(port) : Number.NaN;
    if ((typeof port === 'string' && port.trim().length === 0)
        || !Number.isInteger(numeric) || numeric < 0 || numeric > 65535) {
        const error: NodeJS.ErrnoException = new RangeError(`Port should be >= 0 and < 65536. Received ${String(port)}.`);
        error.code = 'ERR_SOCKET_BAD_PORT';
        throw error;
    }
    return numeric;
}

export interface DnsServerEndpoint {
    host: string;
    port: number;
}

export function parseServer(server: string): DnsServerEndpoint {
    if (server.startsWith('[')) {
        const match = /^\[([^\]]+)\](?::([^:]+))?$/.exec(server);
        if (!match || !isIPv6(match[1])) throw invalidIpAddress(`Invalid IP address: ${server}`);
        return { host: match[1], port: match[2] === undefined ? 53 : validatePort(match[2]) };
    }

    const firstColon = server.indexOf(':');
    const lastColon = server.lastIndexOf(':');
    if (firstColon !== -1 && firstColon === lastColon) {
        const host = server.slice(0, firstColon);
        if (!isIPv4(host)) throw invalidIpAddress(`Invalid IP address: ${server}`);
        return { host, port: validatePort(server.slice(firstColon + 1)) };
    }
    if (isIPv4(server) || isIPv6(server)) return { host: server, port: 53 };
    throw invalidIpAddress(`Invalid IP address: ${server}`);
}

function normalizeServer(server: unknown): string {
    if (typeof server !== 'string') {
        throw invalidArgType(`DNS server must be a string. Received ${typeof server}`);
    }
    const endpoint = parseServer(server);
    if (endpoint.port === 53) return endpoint.host;
    return endpoint.host.includes(':') ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`;
}

export function normalizeServers(servers: unknown): string[] {
    if (!Array.isArray(servers)) {
        throw invalidArgType(
            `The "servers" argument must be an instance of Array. Received type ${typeof servers}${
                typeof servers === 'string' ? ` ('${servers}')` : ''
            }`,
        );
    }
    return servers.map(normalizeServer);
}

let defaultServers = (dns as any).__default_dnssrv as string[];
let defaultResultOrder: DefaultResultOrder = 'verbatim';

export function getDefaultServers(): string[] {
    return [...defaultServers];
}

export function setDefaultServers(servers: unknown): void {
    defaultServers = normalizeServers(servers);
}

export function getDefaultLookupOrder(): DefaultResultOrder {
    return defaultResultOrder;
}

export function setDefaultLookupOrder(order: unknown): void {
    validateDefaultResultOrder(order);
    defaultResultOrder = order;
}

function dnsSyscall(rrtype: Rrtype): string {
    const suffix = rrtype === 'ANY' ? 'Any' : rrtype === 'CAA' ? 'Caa' : rrtype[0] + rrtype.slice(1).toLowerCase();
    return `query${suffix}`;
}

export function createDnsError(code: string, syscall: string, hostname: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException & { hostname?: string } = new Error(`${syscall} ${code} ${hostname}`);
    error.code = code;
    error.syscall = syscall;
    error.hostname = hostname;
    // Node attaches the platform UV errno when one exists (e.g. EINVAL is
    // -4071 on Windows, -22 on Linux); c-ares-only codes have none.
    const errno = Reflect.get(uverror.errno as unknown as Record<string, number | undefined>, code);
    if (typeof errno === 'number') error.errno = errno;
    return error;
}

function normalizeDnsError(error: unknown, syscall: string, hostname: string): NodeJS.ErrnoException {
    const normalized = toErrnoException(error, syscall);
    const rawCode = normalized.code;
    const code = rawCode === 'EAI_NONAME' || rawCode === 'EAI_NODATA' || rawCode === 'ENONAME'
        ? 'ENOTFOUND'
        : rawCode ?? 'UNKNOWN';
    const result = createDnsError(code, syscall, hostname);
    result.errno = normalized.errno;
    result.stack = normalized.stack;
    return result;
}

export function normalizeLookupError(error: unknown, hostname: string): NodeJS.ErrnoException {
    const normalized = toErrnoException(error, 'getaddrinfo');
    const rawCode = normalized.code;
    const code = rawCode === 'EAI_NONAME' || rawCode === 'EAI_NODATA' || rawCode === 'ENONAME'
        ? 'ENOTFOUND'
        : rawCode ?? 'UNKNOWN';
    const result = createDnsError(code, 'getaddrinfo', hostname);
    result.errno = normalized.errno;
    result.stack = normalized.stack;
    return result;
}

export function normalizeLookupServiceError(
    error: unknown,
    address: string,
    includeHostname = true,
): NodeJS.ErrnoException {
    const normalized = toErrnoException(error, 'getnameinfo');
    const rawCode = normalized.code;
    const code = rawCode === 'EAI_NONAME' || rawCode === 'EAI_NODATA' || rawCode === 'ENONAME'
        ? 'ENOTFOUND'
        : rawCode ?? 'UNKNOWN';
    const result: NodeJS.ErrnoException & { hostname?: string } = new Error(
        `getnameinfo ${code}${includeHostname ? ` ${address}` : ''}`,
    );
    result.code = code;
    result.errno = normalized.errno;
    result.syscall = 'getnameinfo';
    if (includeHostname) result.hostname = address;
    result.stack = normalized.stack;
    return result;
}

export interface NormalizedResolverOptions {
    timeout: number;
    tries: number;
    maxTimeout: number;
}

function normalizedTimeout(value: number): number {
    // Node treats -1 and 0 as the channel default. Keep a finite timer here.
    return value <= 0 ? DNS_QUERY_TIMEOUT_MS : value;
}

function normalizeQueryOptions(options: number | ResolverOptions | undefined): NormalizedResolverOptions {
    if (typeof options === 'number') {
        return { timeout: normalizedTimeout(options), tries: 1, maxTimeout: 0 };
    }
    return normalizeResolverOptions(options);
}

function errorCode(error: unknown): string | undefined {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' ? code : undefined;
}

function canRetryDnsError(error: unknown): boolean {
    return RETRYABLE_DNS_CODES.has(errorCode(error) ?? '');
}

function timeoutForAttempt(options: NormalizedResolverOptions, attempt: number): number {
    const shift = Math.min(attempt, 30);
    const scaled = Math.min(options.timeout * (2 ** shift), 0x7fffffff);
    return options.maxTimeout > 0 ? Math.min(scaled, options.maxTimeout) : scaled;
}

export function queryDns(
    hostname: string,
    rrtype: Rrtype,
    servers: readonly string[],
    options?: number | ResolverOptions,
): AbortableDnsQuery {
    validateHostname(hostname);
    const endpoints = (servers.length > 0 ? servers : defaultServers).map(parseServer);
    const config = normalizeQueryOptions(options);
    const syscall = dnsSyscall(rrtype);
    let settled = false;
    let cancelled = false;
    let currentQuery: ReturnType<typeof dns.query> | undefined;
    let currentTimer: number | undefined;
    let currentAttempt = 0;
    let resolveOuter!: (value: CModuleDNS.DNSAnswer[]) => void;
    let rejectOuter!: (error: NodeJS.ErrnoException) => void;

    const promise = new Promise<CModuleDNS.DNSAnswer[]>((resolve, reject) => {
        resolveOuter = resolve;
        rejectOuter = reject;
    });

    const clearAttempt = () => {
        if (currentTimer !== undefined) {
            timers.clearTimeout(currentTimer);
            currentTimer = undefined;
        }
        currentQuery = undefined;
    };

    const settleReject = (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearAttempt();
        rejectOuter(error);
    };

    const settleResolve = (answers: CModuleDNS.DNSAnswer[]) => {
        if (settled) return;
        settled = true;
        clearAttempt();
        resolveOuter(answers);
    };

    const totalAttempts = Math.max(1, endpoints.length * config.tries);
    const startAttempt = () => {
        if (settled || cancelled) return;
        const attempt = currentAttempt++;
        if (attempt >= totalAttempts) {
            settleReject(createDnsError('ETIMEOUT', syscall, hostname));
            return;
        }
        const serverIndex = attempt % endpoints.length;
        const retryIndex = Math.floor(attempt / endpoints.length);
        const endpoint = endpoints[serverIndex];
        let request: ReturnType<typeof dns.query>;
        try {
            request = dns.query(hostname, typeMap[rrtype], endpoint.host, endpoint.port);
        } catch (error) {
            const normalized = normalizeDnsError(error, syscall, hostname);
            if (canRetryDnsError(normalized) && attempt + 1 < totalAttempts) {
                timers.setTimeout(startAttempt, 0);
            } else {
                settleReject(normalized);
            }
            return;
        }

        currentQuery = request;
        const attemptTimeout = timeoutForAttempt(config, retryIndex);
        currentTimer = timers.setTimeout(() => {
            if (settled || currentQuery !== request) return;
            abortQueryQuietly(request);
            clearAttempt();
            if (currentAttempt < totalAttempts) timers.setTimeout(startAttempt, 0);
            else settleReject(createDnsError('ETIMEOUT', syscall, hostname));
        }, attemptTimeout);

        request.then(
            answers => {
                if (settled || currentQuery !== request) return;
                settleResolve(answers);
            },
            error => {
                if (settled || currentQuery !== request) return;
                const normalized = normalizeDnsError(error, syscall, hostname);
                clearAttempt();
                if (canRetryDnsError(normalized) && currentAttempt < totalAttempts) {
                    timers.setTimeout(startAttempt, 0);
                } else {
                    settleReject(normalized);
                }
            },
        );
    };

    const abort = () => {
        if (settled || cancelled) return;
        cancelled = true;
        abortQueryQuietly(currentQuery ?? { abort: undefined });
        settleReject(createDnsError('ECANCELLED', syscall, hostname));
    };

    startAttempt();
    return Object.assign(promise, { abort });
}

export function abortQueryQuietly(req: { abort?: () => void }): void {
    try {
        req.abort?.();
    } catch {
        // Cancellation is best-effort; the native promise owns settlement.
    }
}

function caaRecord(answer: CModuleDNS.CaaAnswer): NodeCaaRecord {
    const record: NodeCaaRecord = { critical: answer.flags };
    if (answer.tag === 'issue') record.issue = answer.value;
    else if (answer.tag === 'issuewild') record.issuewild = answer.value;
    else if (answer.tag === 'iodef') record.iodef = answer.value;
    else if (answer.tag === 'contactemail') record.contactemail = answer.value;
    else if (answer.tag === 'contactphone') record.contactphone = answer.value;
    return record;
}

function soaRecord(answer: CModuleDNS.SoaAnswer): NodeSoaRecord {
    return {
        nsname: answer.primary,
        hostmaster: answer.admin,
        serial: answer.serial,
        refresh: answer.refresh,
        retry: answer.retry,
        expire: answer.expire,
        minttl: answer.minimum,
    };
}

function srvRecord(answer: CModuleDNS.SrvAnswer): NodeSrvRecord {
    return { priority: answer.priority, weight: answer.weight, port: answer.port, name: answer.target };
}

function txtEntries(answer: CModuleDNS.TxtAnswer): string[] {
    if (answer.entries) return [...answer.entries];
    const entries: string[] = [];
    let offset = 0;
    while (offset < answer.txt.length) {
        const length = answer.txt.charCodeAt(offset);
        if (length > answer.txt.length - offset - 1) return [answer.txt];
        entries.push(answer.txt.slice(offset + 1, offset + length + 1));
        offset += length + 1;
    }
    return entries;
}

function shapeAnyAnswers(answers: readonly CModuleDNS.DNSAnswer[]): NodeAnyRecord[] {
    const records: NodeAnyRecord[] = [];
    for (const answer of answers) {
        if (isAddressAnswer(answer) && answer.type === dns.A) records.push({ type: 'A', address: answer.address, ttl: answer.ttl });
        else if (isAddressAnswer(answer) && answer.type === dns.AAAA) records.push({ type: 'AAAA', address: answer.address, ttl: answer.ttl });
        else if (isCaaAnswer(answer)) records.push({ type: 'CAA', ...caaRecord(answer) });
        else if (isCnameAnswer(answer)) records.push({ type: 'CNAME', value: answer.cname });
        else if (isMxAnswer(answer)) records.push({ type: 'MX', priority: answer.priority, exchange: answer.exchange });
        else if (isNaptrAnswer(answer)) records.push({
            type: 'NAPTR', flags: answer.flags, service: answer.services, regexp: answer.regexp,
            replacement: answer.replacement, order: answer.order, preference: answer.preference,
        });
        else if (isNsAnswer(answer)) records.push({ type: 'NS', value: answer.ns });
        else if (isPtrAnswer(answer)) records.push({ type: 'PTR', value: answer.ptr });
        else if (isSoaAnswer(answer)) records.push({ type: 'SOA', ...soaRecord(answer) });
        else if (isSrvAnswer(answer)) records.push({ type: 'SRV', ...srvRecord(answer) });
        else if (isTxtAnswer(answer)) records.push({ type: 'TXT', entries: txtEntries(answer) });
    }
    return records;
}

export function shapeAnswers<T extends Rrtype>(rrtype: T, answers: readonly CModuleDNS.DNSAnswer[]): DnsResultMap[T];
export function shapeAnswers(rrtype: Rrtype, answers: readonly CModuleDNS.DNSAnswer[]): ShapedDnsAnswers;
export function shapeAnswers(rrtype: Rrtype, answers: readonly CModuleDNS.DNSAnswer[]): ShapedDnsAnswers {
    if (rrtype === 'A') return answers.filter(isAddressAnswer).filter(answer => answer.type === dns.A).map(answer => answer.address);
    if (rrtype === 'AAAA') return answers.filter(isAddressAnswer).filter(answer => answer.type === dns.AAAA).map(answer => answer.address);
    if (rrtype === 'CNAME') return answers.filter(isCnameAnswer).map(answer => answer.cname);
    if (rrtype === 'CAA') return answers.filter(isCaaAnswer).map(caaRecord);
    if (rrtype === 'MX') return answers.filter(isMxAnswer).map(answer => ({ priority: answer.priority, exchange: answer.exchange }));
    if (rrtype === 'NAPTR') return answers.filter(isNaptrAnswer).map(answer => ({
        flags: answer.flags, service: answer.services, regexp: answer.regexp, replacement: answer.replacement,
        order: answer.order, preference: answer.preference,
    }));
    if (rrtype === 'NS') return answers.filter(isNsAnswer).map(answer => answer.ns);
    if (rrtype === 'PTR') return answers.filter(isPtrAnswer).map(answer => answer.ptr);
    if (rrtype === 'SOA') {
        const answer = answers.find(isSoaAnswer);
        return answer ? soaRecord(answer) : null;
    }
    if (rrtype === 'SRV') return answers.filter(isSrvAnswer).map(srvRecord);
    if (rrtype === 'TXT') return answers.filter(isTxtAnswer).map(txtEntries);
    return shapeAnyAnswers(answers);
}

export function normalizeResolverOptions(options: unknown): NormalizedResolverOptions {
    if (typeof options !== 'object' || options === null) {
        return { timeout: DNS_QUERY_TIMEOUT_MS, tries: DEFAULT_RESOLVER_TRIES, maxTimeout: 0 };
    }
    const timeout = Reflect.get(options, 'timeout') ?? -1;
    if (typeof timeout !== 'number') {
        throw invalidArgType(
            `The "options.timeout" property must be of type number. Received type ${typeof timeout}${
                typeof timeout === 'string' ? ` ('${timeout}')` : ''
            }`,
        );
    }
    if (!Number.isInteger(timeout) || timeout < -1 || timeout > 0x7fffffff) {
        throw outOfRange('options.timeout', timeout);
    }

    const tries = Reflect.get(options, 'tries');
    if (tries !== undefined) {
        if (typeof tries !== 'number') throw invalidArgType(`The "options.tries" property must be of type number. Received type ${typeof tries}`);
        if (!Number.isInteger(tries) || tries < 1 || tries > 0x7fffffff) {
            throw outOfRange('options.tries', tries);
        }
    }

    const maxTimeout = Reflect.get(options, 'maxTimeout');
    if (maxTimeout !== undefined) {
        if (typeof maxTimeout !== 'number') throw invalidArgType(`The "options.maxTimeout" property must be of type number. Received type ${typeof maxTimeout}`);
        if (!Number.isInteger(maxTimeout) || maxTimeout < 0 || maxTimeout > 0xffffffff) {
            throw outOfRange('options.maxTimeout', maxTimeout);
        }
    }
    return {
        timeout: normalizedTimeout(timeout),
        tries: tries ?? DEFAULT_RESOLVER_TRIES,
        maxTimeout: maxTimeout ?? 0,
    };
}

export class ResolverQuery {
    private readonly pending = new Set<AbortableDnsQuery>();
    private servers: string[];
    private localAddressV4?: string;
    private localAddressV6?: string;
    readonly timeout: number;
    readonly tries: number;
    readonly maxTimeout: number;

    constructor(servers: readonly string[], options?: ResolverOptions) {
        this.servers = [...servers];
        const normalized = normalizeResolverOptions(options);
        this.timeout = normalized.timeout;
        this.tries = normalized.tries;
        this.maxTimeout = normalized.maxTimeout;
    }

    getServers(): string[] {
        return [...this.servers];
    }

    setServers(servers: unknown): void {
        this.servers = normalizeServers(servers);
    }

    /**
     * Records the requested source addresses after Node's validation rules.
     * cno's resolver cannot bind a source address, so this is parity-only.
     */
    setLocalAddress(ipv4?: string, ipv6?: string): void {
        if (ipv4 !== undefined) {
            if (typeof ipv4 !== 'string' || !isIPv4(ipv4)) {
                throw invalidIpAddress(`Invalid IP address: ${String(ipv4)}`);
            }
            this.localAddressV4 = ipv4;
        }
        if (ipv6 !== undefined) {
            if (typeof ipv6 !== 'string' || !isIPv6(ipv6)) {
                throw invalidIpAddress(`Invalid IP address: ${String(ipv6)}`);
            }
            this.localAddressV6 = ipv6;
        }
    }

    query(hostname: string, rrtype: Rrtype): AbortableDnsQuery {
        const request = queryDns(hostname, rrtype, this.servers, {
            timeout: this.timeout,
            tries: this.tries,
            maxTimeout: this.maxTimeout,
        });
        this.pending.add(request);
        request.then(
            () => this.pending.delete(request),
            () => this.pending.delete(request),
        );
        return request;
    }

    cancel(): void {
        for (const request of this.pending) request.abort();
    }
}

export function expandIPv6(ip: string): string {
    const zoneSeparator = ip.indexOf('%');
    if (zoneSeparator !== -1) ip = ip.slice(0, zoneSeparator);
    const lastColon = ip.lastIndexOf(':');
    let normalized = ip;
    if (ip.slice(lastColon + 1).includes('.')) {
        const bytes = ip.slice(lastColon + 1).split('.').map(Number);
        normalized = `${ip.slice(0, lastColon)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
    }
    if (normalized.includes('::')) {
        const [left, right] = normalized.split('::');
        const leftParts = left ? left.split(':') : [];
        const rightParts = right ? right.split(':') : [];
        const missing = 8 - leftParts.length - rightParts.length;
        return [...leftParts, ...Array(missing).fill('0'), ...rightParts]
            .map(part => part.padStart(4, '0')).join('');
    }
    return normalized.split(':').map(part => part.padStart(4, '0')).join('');
}

export function reverseName(ip: string): string {
    if (isIPv6(ip)) return expandIPv6(ip).split('').reverse().join('.') + '.ip6.arpa';
    if (isIPv4(ip)) return ip.split('.').reverse().join('.') + '.in-addr.arpa';
    throw createDnsError('EINVAL', 'getHostByAddr', ip);
}
