/**
 * Node.js dns module
 */

const dns = import.meta.use('dns');
const os = import.meta.use('os');
const timers = import.meta.use('timers');

import {
    type DefaultResultOrder,
    type NodeAnyRecord,
    type NodeCaaRecord,
    type NodeMxRecord,
    type NodeNaptrRecord,
    type NodeSoaRecord,
    type NodeSrvRecord,
    type ResolverOptions,
    type Rrtype,
    ResolverQuery,
    createDnsError,
    getAddressFamily,
    getDefaultLookupOrder,
    getDefaultServers,
    isAddressAnswer,
    normalizeLookupError,
    normalizeLookupOptions,
    normalizeLookupServiceError,
    normalizeLookupServicePort,
    orderLookupAddresses,
    queryDns,
    reverseName,
    shapeAnswers,
    setDefaultLookupOrder,
    setDefaultServers,
    validateHostname,
    validateLookupServiceAddress,
    validateRrtype,
} from './_internal';
import * as promises from './promises';

export const NODATA = 'ENODATA';
export const FORMERR = 'EFORMERR';
export const SERVFAIL = 'ESERVFAIL';
export const NOTFOUND = 'ENOTFOUND';
export const NOTIMP = 'ENOTIMP';
export const REFUSED = 'EREFUSED';
export const BADQUERY = 'EBADQUERY';
export const BADNAME = 'EBADNAME';
export const BADFAMILY = 'EBADFAMILY';
export const BADRESP = 'EBADRESP';
export const CONNREFUSED = 'ECONNREFUSED';
export const TIMEOUT = 'ETIMEOUT';
export const EOF = 'EOF';
export const FILE = 'EFILE';
export const NOMEM = 'ENOMEM';
export const DESTRUCTION = 'EDESTRUCTION';
export const BADSTR = 'EBADSTR';
export const BADFLAGS = 'EBADFLAGS';
export const NONAME = 'ENONAME';
export const BADHINTS = 'EBADHINTS';
export const NOTINITIALIZED = 'ENOTINITIALIZED';
export const LOADIPHLPAPI = 'ELOADIPHLPAPI';
export const ADDRGETNETWORKPARAMS = 'EADDRGETNETWORKPARAMS';
export const CANCELLED = 'ECANCELLED';
export const V4MAPPED = 8;
export const ALL = 16;
export const ADDRCONFIG = 32;

export interface ResolveOptions {
    ttl?: boolean;
}

export interface LookupOptions {
    family?: number | 'IPv4' | 'IPv6';
    hints?: number;
    all?: boolean;
    verbatim?: boolean;
    order?: DefaultResultOrder;
}

export interface LookupOneOptions extends LookupOptions {
    all?: false;
}

export interface LookupAllOptions extends LookupOptions {
    all: true;
}

export type MxRecord = NodeMxRecord;
export type NaptrRecord = NodeNaptrRecord;
export type SoaRecord = NodeSoaRecord;
export type SrvRecord = NodeSrvRecord;
export type AnyRecord = NodeAnyRecord;
export type CaaRecord = NodeCaaRecord;

export interface TxtRecord {
    [index: number]: string;
}

type ResolveResult = ReturnType<typeof shapeAnswers>;
type DnsCallback = (error: NodeJS.ErrnoException | null, result: ResolveResult) => void;
type QuerySource = (hostname: string, rrtype: Rrtype) => Promise<CModuleDNS.DNSAnswer[]>;

function assertCallback(callback: unknown): asserts callback is (...args: unknown[]) => void {
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }
}

function wantsTtl(options: unknown): boolean {
    return typeof options === 'object' && options !== null && Boolean(Reflect.get(options, 'ttl'));
}

function globalQuery(hostname: string, rrtype: Rrtype): Promise<CModuleDNS.DNSAnswer[]> {
    return queryDns(hostname, rrtype, getDefaultServers());
}

function completeResolve(
    hostname: string,
    rrtype: Rrtype,
    callback: DnsCallback,
    query: QuerySource,
): void {
    query(hostname, rrtype).then(
        answers => {
            const result = shapeAnswers(rrtype, answers);
            if (rrtype === 'SOA' && result === null) {
                callback(createDnsError(NODATA, 'querySoa', hostname), null);
            } else {
                callback(null, result);
            }
        },
        error => callback(error, null),
    );
}

function resolveTyped(hostname: unknown, rrtype: Rrtype, callback: unknown, query: QuerySource): void {
    validateHostname(hostname);
    assertCallback(callback);
    completeResolve(hostname, rrtype, callback, query);
}

function resolveAddress(
    hostname: unknown,
    rrtype: 'A' | 'AAAA',
    options: unknown,
    callback: unknown,
    query: QuerySource,
): void {
    validateHostname(hostname);
    assertCallback(callback);
    query(hostname, rrtype).then(
        answers => {
            const addressType = rrtype === 'A' ? dns.A : dns.AAAA;
            const addresses = answers.filter(isAddressAnswer).filter(answer => answer.type === addressType);
            callback(null, wantsTtl(options)
                ? addresses.map(answer => ({ address: answer.address, ttl: answer.ttl }))
                : addresses.map(answer => answer.address));
        },
        error => callback(error, null),
    );
}

export function lookup(hostname: string, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
export function lookup(hostname: string, family: number, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
export function lookup(hostname: string, options: LookupOneOptions, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
export function lookup(hostname: string, options: LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void): void;
export function lookup(hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family: number) => void): void;
export function lookup(hostname: unknown, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    if (hostname && typeof hostname !== 'string') {
        throw new TypeError(`The "hostname" argument must be of type string. Received ${String(hostname)}`);
    }
    if (typeof hostname === 'string' && hostname.includes('\0')) {
        throw new TypeError('The "hostname" argument must be a string without null bytes');
    }
    assertCallback(callback);
    const normalized = normalizeLookupOptions(options, getDefaultLookupOrder(), true);

    if (!hostname) {
        timers.setTimeout(() => {
            if (normalized.all) callback(null, []);
            else callback(null, null, normalized.family === 6 ? 6 : 4);
        }, 0);
        return;
    }
    if (typeof hostname !== 'string') {
        throw new TypeError(`The "hostname" argument must be of type string. Received ${String(hostname)}`);
    }
    const matchedFamily = getAddressFamily(hostname);
    if (matchedFamily !== 0) {
        timers.setTimeout(() => {
            const result = { address: hostname, family: matchedFamily };
            if (normalized.all) callback(null, [result]);
            else callback(null, result.address, result.family);
        }, 0);
        return;
    }

    dns.resolve(hostname, {
        family: normalized.family === 0 ? os.AF_UNSPEC : normalized.family === 4 ? os.AF_INET : os.AF_INET6,
        hints: normalized.hints,
    }).then(
        addresses => {
            const ordered = orderLookupAddresses(addresses, normalized.order);
            if (normalized.all) {
                callback(null, ordered.map(address => ({ address: address.ip, family: address.family })));
                return;
            }
            const address = ordered[0];
            if (!address) callback(createDnsError(NOTFOUND, 'getaddrinfo', hostname));
            else callback(null, address.ip, address.family);
        },
        error => callback(normalizeLookupError(error, hostname)),
    );
}

Object.defineProperty(lookup, Symbol.for('nodejs.util.promisify.customArgs'), {
    value: ['address', 'family'],
    enumerable: false,
});

export function lookupSync(hostname: string, options?: LookupOptions | number): string | Array<{ address: string; family: number }> {
    if (typeof hostname !== 'string') {
        throw new TypeError(`The "hostname" argument must be of type string. Received ${String(hostname)}`);
    }
    const normalized = normalizeLookupOptions(options, getDefaultLookupOrder(), true);
    const matchedFamily = getAddressFamily(hostname);
    if (matchedFamily !== 0) {
        if (normalized.all) return [{ address: hostname, family: matchedFamily }];
        return hostname;
    }
    let addresses: CModuleDNS.ResolvedAddress[];
    try {
        addresses = dns.resolveSync(hostname, {
            family: normalized.family === 0 ? os.AF_UNSPEC : normalized.family === 4 ? os.AF_INET : os.AF_INET6,
            hints: normalized.hints,
        });
    } catch (error) {
        throw normalizeLookupError(error, hostname);
    }
    const ordered = orderLookupAddresses(addresses, normalized.order);
    if (normalized.all) return ordered.map(address => ({ address: address.ip, family: address.family }));
    const address = ordered[0];
    if (!address) throw createDnsError(NOTFOUND, 'getaddrinfo', hostname);
    return address.ip;
}

export function resolve(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'A' | 'AAAA' | 'CNAME' | 'NS' | 'PTR', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'ANY', callback: (err: NodeJS.ErrnoException | null, addresses: AnyRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'CAA', callback: (err: NodeJS.ErrnoException | null, addresses: CaaRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'MX', callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'NAPTR', callback: (err: NodeJS.ErrnoException | null, addresses: NaptrRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'SOA', callback: (err: NodeJS.ErrnoException | null, addresses: SoaRecord) => void): void;
export function resolve(hostname: string, rrtype: 'SRV', callback: (err: NodeJS.ErrnoException | null, addresses: SrvRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'TXT', callback: (err: NodeJS.ErrnoException | null, addresses: string[][]) => void): void;
export function resolve(hostname: string, rrtype?: unknown, callback?: unknown): void {
    if (typeof rrtype === 'function') {
        callback = rrtype;
        rrtype = 'A';
    }
    if (rrtype === undefined) rrtype = 'A';
    const normalizedRrtype = validateRrtype(rrtype);
    resolveTyped(hostname, normalizedRrtype, callback, globalQuery);
}

export function resolve4(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve4(hostname: string, options: { ttl: true }, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; ttl: number }>) => void): void;
export function resolve4(hostname: string, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    resolveAddress(hostname, 'A', options, callback, globalQuery);
}

export function resolve6(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve6(hostname: string, options: { ttl: true }, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; ttl: number }>) => void): void;
export function resolve6(hostname: string, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    resolveAddress(hostname, 'AAAA', options, callback, globalQuery);
}

export function resolveAny(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: AnyRecord[]) => void): void {
    resolveTyped(hostname, 'ANY', callback, globalQuery);
}

export function resolveCaa(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: CaaRecord[]) => void): void {
    resolveTyped(hostname, 'CAA', callback, globalQuery);
}

export function resolveCname(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
    resolveTyped(hostname, 'CNAME', callback, globalQuery);
}

export function resolveMx(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void): void {
    resolveTyped(hostname, 'MX', callback, globalQuery);
}

export function resolveNaptr(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: NaptrRecord[]) => void): void {
    resolveTyped(hostname, 'NAPTR', callback, globalQuery);
}

export function resolveNs(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
    resolveTyped(hostname, 'NS', callback, globalQuery);
}

export function resolvePtr(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
    resolveTyped(hostname, 'PTR', callback, globalQuery);
}

export function resolveSoa(hostname: string, callback: (err: NodeJS.ErrnoException | null, address: SoaRecord) => void): void {
    resolveTyped(hostname, 'SOA', callback, globalQuery);
}

export function resolveSrv(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: SrvRecord[]) => void): void {
    resolveTyped(hostname, 'SRV', callback, globalQuery);
}

export function resolveTxt(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[][]) => void): void {
    resolveTyped(hostname, 'TXT', callback, globalQuery);
}

export function reverse(ip: string, callback: (err: NodeJS.ErrnoException | null, hostnames: string[]) => void): void {
    assertCallback(callback);
    if (ip === '127.0.0.1' || ip === '::1') {
        timers.setTimeout(() => callback(null, ['localhost']), 0);
        return;
    }
    const hostname = reverseName(ip);
    resolveTyped(hostname, 'PTR', callback, globalQuery);
}

export function setServers(servers: string[]): void {
    setDefaultServers(servers);
}

export function getServers(): string[] {
    return getDefaultServers();
}

export function setDefaultResultOrder(order: DefaultResultOrder): void {
    setDefaultLookupOrder(order);
}

export function getDefaultResultOrder(): DefaultResultOrder {
    return getDefaultLookupOrder();
}

export function lookupService(address: string, port: number, callback: (err: NodeJS.ErrnoException | null, hostname: string, service: string) => void): void;
export function lookupService(address: string, port: number, callback: unknown): void {
    if (arguments.length !== 3) {
        const error: NodeJS.ErrnoException = new TypeError('The "address", "port", and "callback" arguments must be specified');
        error.code = 'ERR_MISSING_ARGS';
        throw error;
    }
    validateLookupServiceAddress(address);
    const normalizedPort = normalizeLookupServicePort(port);
    assertCallback(callback);
    let request: Promise<{ hostname: string; service: string }>;
    try {
        request = dns.lookupService(address, normalizedPort);
    } catch (error) {
        throw normalizeLookupServiceError(error, address);
    }
    request.then(
        result => callback(null, result.hostname, result.service),
        error => callback(normalizeLookupServiceError(error, address)),
    );
}

export class Resolver {
    private readonly resolver: ResolverQuery;

    constructor(options?: ResolverOptions) {
        this.resolver = new ResolverQuery(getDefaultServers(), options);
    }

    cancel(): void {
        this.resolver.cancel();
    }

    getServers(): string[] {
        return this.resolver.getServers();
    }

    setServers(servers: string[]): void {
        this.resolver.setServers(servers);
    }

    private query = (hostname: string, rrtype: Rrtype): Promise<CModuleDNS.DNSAnswer[]> => this.resolver.query(hostname, rrtype);

    resolve(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
    resolve(hostname: string, rrtype: string, callback: (err: NodeJS.ErrnoException | null, addresses: ResolveResult) => void): void;
    resolve(hostname: string, rrtype?: unknown, callback?: unknown): void {
        if (typeof rrtype === 'function') {
            callback = rrtype;
            rrtype = 'A';
        }
        if (rrtype === undefined) rrtype = 'A';
        resolveTyped(hostname, validateRrtype(rrtype), callback, this.query);
    }

    resolve4(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
    resolve4(hostname: string, options: ResolveOptions, callback: (err: NodeJS.ErrnoException | null, addresses: string[] | Array<{ address: string; ttl: number }>) => void): void;
    resolve4(hostname: string, options?: unknown, callback?: unknown): void {
        if (typeof options === 'function') {
            callback = options;
            options = undefined;
        }
        resolveAddress(hostname, 'A', options, callback, this.query);
    }

    resolve6(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
    resolve6(hostname: string, options: ResolveOptions, callback: (err: NodeJS.ErrnoException | null, addresses: string[] | Array<{ address: string; ttl: number }>) => void): void;
    resolve6(hostname: string, options?: unknown, callback?: unknown): void {
        if (typeof options === 'function') {
            callback = options;
            options = undefined;
        }
        resolveAddress(hostname, 'AAAA', options, callback, this.query);
    }

    resolveAny(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: AnyRecord[]) => void): void {
        resolveTyped(hostname, 'ANY', callback, this.query);
    }

    resolveCaa(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: CaaRecord[]) => void): void {
        resolveTyped(hostname, 'CAA', callback, this.query);
    }

    resolveCname(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
        resolveTyped(hostname, 'CNAME', callback, this.query);
    }

    resolveMx(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void): void {
        resolveTyped(hostname, 'MX', callback, this.query);
    }

    resolveNaptr(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: NaptrRecord[]) => void): void {
        resolveTyped(hostname, 'NAPTR', callback, this.query);
    }

    resolveNs(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
        resolveTyped(hostname, 'NS', callback, this.query);
    }

    resolvePtr(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
        resolveTyped(hostname, 'PTR', callback, this.query);
    }

    resolveSoa(hostname: string, callback: (err: NodeJS.ErrnoException | null, address: SoaRecord) => void): void {
        resolveTyped(hostname, 'SOA', callback, this.query);
    }

    resolveSrv(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: SrvRecord[]) => void): void {
        resolveTyped(hostname, 'SRV', callback, this.query);
    }

    resolveTxt(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[][]) => void): void {
        resolveTyped(hostname, 'TXT', callback, this.query);
    }

    reverse(ip: string, callback: (err: NodeJS.ErrnoException | null, hostnames: string[]) => void): void {
        assertCallback(callback);
        if (ip === '127.0.0.1' || ip === '::1') {
            timers.setTimeout(() => callback(null, ['localhost']), 0);
            return;
        }
        resolveTyped(reverseName(ip), 'PTR', callback, this.query);
    }
}

export { promises };
