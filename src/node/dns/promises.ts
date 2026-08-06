/**
 * Node.js dns/promises API
 */

const dns = import.meta.use('dns');
const os = import.meta.use('os');

import {
    type DefaultResultOrder,
    type NodeAnyRecord,
    type NodeCaaRecord,
    type NodeMxRecord,
    type NodeNaptrRecord,
    type NodeSoaRecord,
    type NodeSrvRecord,
    type DnsResultMap,
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
import type { LookupOptions } from './mod';

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

export type LookupAddress = { address: string | null; family: number };
export type AnyRecord = NodeAnyRecord;
export type CaaRecord = NodeCaaRecord;
export type MxRecord = NodeMxRecord;
export type NaptrRecord = NodeNaptrRecord;
export type SoaRecord = NodeSoaRecord;
export type SrvRecord = NodeSrvRecord;

type QuerySource = (hostname: string, rrtype: Rrtype) => Promise<CModuleDNS.DNSAnswer[]>;

function wantsTtl(options: unknown): boolean {
    return typeof options === 'object' && options !== null && Boolean(Reflect.get(options, 'ttl'));
}

function globalQuery(hostname: string, rrtype: Rrtype): Promise<CModuleDNS.DNSAnswer[]> {
    return queryDns(hostname, rrtype, getDefaultServers());
}

function shaped<T extends Rrtype>(hostname: string, rrtype: T, query: QuerySource): Promise<DnsResultMap[T]> {
    return query(hostname, rrtype).then(answers => shapeAnswers(rrtype, answers));
}

function typed<T extends Rrtype>(hostname: unknown, rrtype: T, source: QuerySource): Promise<DnsResultMap[T]> {
    validateHostname(hostname);
    return shaped(hostname, rrtype, source);
}

export function lookup(hostname: string, options?: LookupOptions | number): Promise<LookupAddress | LookupAddress[]> {
    if (hostname && typeof hostname !== 'string') {
        throw Object.assign(
            new TypeError(`The "hostname" argument must be of type string. Received type ${typeof hostname} (${String(hostname)})`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    if (typeof hostname === 'string' && hostname.includes('\0')) {
        throw Object.assign(
            new TypeError('The "hostname" argument must be a string without null bytes'),
            { code: 'ERR_INVALID_ARG_VALUE' },
        );
    }
    const normalized = normalizeLookupOptions(options, getDefaultLookupOrder());
    if (!hostname) {
        return Promise.resolve(normalized.all ? [] : { address: null, family: normalized.family === 6 ? 6 : 4 });
    }
    const matchedFamily = getAddressFamily(hostname);
    if (matchedFamily !== 0) {
        const result = { address: hostname, family: matchedFamily };
        return Promise.resolve(normalized.all ? [result] : result);
    }
    return dns.resolve(hostname, {
        family: normalized.family === 0 ? os.AF_UNSPEC : normalized.family === 4 ? os.AF_INET : os.AF_INET6,
        hints: normalized.hints,
    }).then(
        addresses => {
            const ordered = orderLookupAddresses(addresses, normalized.order);
            if (normalized.all) return ordered.map(address => ({ address: address.ip, family: address.family }));
            const address = ordered[0];
            if (!address) throw createDnsError('ENOTFOUND', 'getaddrinfo', hostname);
            return { address: address.ip, family: address.family };
        },
        error => { throw normalizeLookupError(error, hostname); },
    );
}

export function resolve(hostname: string): Promise<string[]>;
export function resolve(hostname: string, rrtype: 'A' | 'AAAA' | 'CNAME' | 'NS' | 'PTR'): Promise<string[]>;
export function resolve(hostname: string, rrtype: 'ANY'): Promise<AnyRecord[]>;
export function resolve(hostname: string, rrtype: 'CAA'): Promise<CaaRecord[]>;
export function resolve(hostname: string, rrtype: 'MX'): Promise<MxRecord[]>;
export function resolve(hostname: string, rrtype: 'NAPTR'): Promise<NaptrRecord[]>;
export function resolve(hostname: string, rrtype: 'SOA'): Promise<SoaRecord>;
export function resolve(hostname: string, rrtype: 'SRV'): Promise<SrvRecord[]>;
export function resolve(hostname: string, rrtype: 'TXT'): Promise<string[][]>;
export function resolve(hostname: string, rrtype: string): Promise<unknown>;
export async function resolve(hostname: string, rrtype = 'A'): Promise<unknown> {
    const normalized = validateRrtype(rrtype);
    return typed(hostname, normalized, globalQuery);
}

export async function resolve4(hostname: string, options?: { ttl?: boolean }): Promise<string[] | Array<{ address: string; ttl: number }>> {
    validateHostname(hostname);
    const answers = await globalQuery(hostname, 'A');
    const addresses = answers.filter(isAddressAnswer).filter(answer => answer.type === dns.A);
    return wantsTtl(options) ? addresses.map(answer => ({ address: answer.address, ttl: answer.ttl })) : addresses.map(answer => answer.address);
}

export async function resolve6(hostname: string, options?: { ttl?: boolean }): Promise<string[] | Array<{ address: string; ttl: number }>> {
    validateHostname(hostname);
    const answers = await globalQuery(hostname, 'AAAA');
    const addresses = answers.filter(isAddressAnswer).filter(answer => answer.type === dns.AAAA);
    return wantsTtl(options) ? addresses.map(answer => ({ address: answer.address, ttl: answer.ttl })) : addresses.map(answer => answer.address);
}

export async function resolveAny(hostname: string): Promise<AnyRecord[]> {
    return typed(hostname, 'ANY', globalQuery);
}

export async function resolveCaa(hostname: string): Promise<CaaRecord[]> {
    return typed(hostname, 'CAA', globalQuery);
}

export async function resolveCname(hostname: string): Promise<string[]> {
    return typed(hostname, 'CNAME', globalQuery);
}

export async function resolveMx(hostname: string): Promise<MxRecord[]> {
    return typed(hostname, 'MX', globalQuery);
}

export async function resolveNaptr(hostname: string): Promise<NaptrRecord[]> {
    return typed(hostname, 'NAPTR', globalQuery);
}

export async function resolveNs(hostname: string): Promise<string[]> {
    return typed(hostname, 'NS', globalQuery);
}

export async function resolvePtr(hostname: string): Promise<string[]> {
    return typed(hostname, 'PTR', globalQuery);
}

export async function resolveSoa(hostname: string): Promise<SoaRecord> {
    const result = await typed(hostname, 'SOA', globalQuery);
    if (result === null) throw createDnsError('ENODATA', 'querySoa', hostname);
    return result;
}

export async function resolveSrv(hostname: string): Promise<SrvRecord[]> {
    return typed(hostname, 'SRV', globalQuery);
}

export async function resolveTxt(hostname: string): Promise<string[][]> {
    return typed(hostname, 'TXT', globalQuery);
}

export async function reverse(ip: string): Promise<string[]> {
    if (ip === '127.0.0.1' || ip === '::1') return ['localhost'];
    return typed(reverseName(ip), 'PTR', globalQuery);
}

export function lookupService(address: string, port: number): Promise<{ hostname: string; service: string }> {
    if (arguments.length !== 2) {
        const error: NodeJS.ErrnoException = new TypeError('The "address" and "port" arguments must be specified');
        error.code = 'ERR_MISSING_ARGS';
        throw error;
    }
    validateLookupServiceAddress(address);
    const normalizedPort = normalizeLookupServicePort(port);
    let request: Promise<{ hostname: string; service: string }>;
    try {
        request = dns.lookupService(address, normalizedPort);
    } catch (error) {
        return Promise.reject(normalizeLookupServiceError(error, address, false));
    }
    return request.catch(error => {
        throw normalizeLookupServiceError(error, address, false);
    });
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

    /** Parity-only; see the note on dns.Resolver#setLocalAddress. */
    setLocalAddress(ipv4?: string, ipv6?: string): void {
        this.resolver.setLocalAddress(ipv4, ipv6);
    }

    private query = (hostname: string, rrtype: Rrtype): Promise<CModuleDNS.DNSAnswer[]> => this.resolver.query(hostname, rrtype);

    resolve(hostname: string, rrtype = 'A'): Promise<unknown> {
        return typed(hostname, validateRrtype(rrtype), this.query);
    }

    resolve4(hostname: string, options?: { ttl?: boolean }): Promise<string[] | Array<{ address: string; ttl: number }>> {
        validateHostname(hostname);
        return this.query(hostname, 'A').then(answers => {
            const addresses = answers.filter(isAddressAnswer).filter(answer => answer.type === dns.A);
            return wantsTtl(options) ? addresses.map(answer => ({ address: answer.address, ttl: answer.ttl })) : addresses.map(answer => answer.address);
        });
    }

    resolve6(hostname: string, options?: { ttl?: boolean }): Promise<string[] | Array<{ address: string; ttl: number }>> {
        validateHostname(hostname);
        return this.query(hostname, 'AAAA').then(answers => {
            const addresses = answers.filter(isAddressAnswer).filter(answer => answer.type === dns.AAAA);
            return wantsTtl(options) ? addresses.map(answer => ({ address: answer.address, ttl: answer.ttl })) : addresses.map(answer => answer.address);
        });
    }

    resolveAny(hostname: string): Promise<AnyRecord[]> { return typed(hostname, 'ANY', this.query); }
    resolveCaa(hostname: string): Promise<CaaRecord[]> { return typed(hostname, 'CAA', this.query); }
    resolveCname(hostname: string): Promise<string[]> { return typed(hostname, 'CNAME', this.query); }
    resolveMx(hostname: string): Promise<MxRecord[]> { return typed(hostname, 'MX', this.query); }
    resolveNaptr(hostname: string): Promise<NaptrRecord[]> { return typed(hostname, 'NAPTR', this.query); }
    resolveNs(hostname: string): Promise<string[]> { return typed(hostname, 'NS', this.query); }
    resolvePtr(hostname: string): Promise<string[]> { return typed(hostname, 'PTR', this.query); }
    async resolveSoa(hostname: string): Promise<SoaRecord> {
        const result = await typed(hostname, 'SOA', this.query);
        if (result === null) throw createDnsError('ENODATA', 'querySoa', hostname);
        return result;
    }
    resolveSrv(hostname: string): Promise<SrvRecord[]> { return typed(hostname, 'SRV', this.query); }
    resolveTxt(hostname: string): Promise<string[][]> { return typed(hostname, 'TXT', this.query); }
    reverse(ip: string): Promise<string[]> {
        if (ip === '127.0.0.1' || ip === '::1') return Promise.resolve(['localhost']);
        return typed(reverseName(ip), 'PTR', this.query);
    }
}

export function getServers(): string[] {
    return getDefaultServers();
}

export function setServers(servers: string[]): void {
    setDefaultServers(servers);
}

export function getDefaultResultOrder(): DefaultResultOrder {
    return getDefaultLookupOrder();
}

export function setDefaultResultOrder(order: DefaultResultOrder): void {
    setDefaultLookupOrder(order);
}

export * as default from './promises';
