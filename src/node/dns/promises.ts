/**
 * Node.js dns/promises API
 */

const dns = import.meta.use('dns');
const os = import.meta.use('os');
const timers = import.meta.use('timers');
import { toErrnoException } from '../_internal/errno';
import {
    type DefaultResultOrder,
    type Rrtype,
    abortQueryQuietly,
    typeMap,
    isAddressAnswer,
    normalizeLookupOptions,
    normalizeServers,
    shapeAnswers,
    reverseName,
    validateRrtype,
} from './_internal';
import type { AnyRecord, CaaRecord, LookupOptions, MxRecord, NaptrRecord, SoaRecord, SrvRecord } from './mod';
import {
    getDefaultResultOrder as getDefaultResultOrderSync,
    getServers as getServersSync,
    lookupService as lookupServiceCallback,
    setDefaultResultOrder as setDefaultResultOrderSync,
    setServers as setServersSync,
} from './mod';

type LookupAddress = { address: string; family: number };
const DNS_QUERY_TIMEOUT_MS = 2000;

function query(hostname: string, type: number): Promise<CModuleDNS.DNSAnswer[]> {
    const req = dns.query(hostname, type);
    const id = timers.setTimeout(() => abortQueryQuietly(req), DNS_QUERY_TIMEOUT_MS);
    return req.finally(() => timers.clearTimeout(id));
}

function wantsTtl(options: unknown): boolean {
    if (typeof options !== 'object' || options === null) return false;
    return Reflect.get(options, 'ttl') === true;
}

export function lookup(hostname: string, options?: LookupOptions | number): Promise<LookupAddress | LookupAddress[]> {
    const { family, all } = normalizeLookupOptions(options);

    return (async () => {
        try {
            const addresses = await dns.resolve(hostname, {
                family: family === 0 ? os.AF_UNSPEC : family === 4 ? os.AF_INET : os.AF_INET6,
            });
            const mapped = addresses.map(a => ({ address: a.ip, family: a.family }));

            if (all) {
                return mapped;
            }

            const first = mapped[0];
            if (!first) {
                throw toErrnoException(new Error(`ENOTFOUND ${hostname}`), 'lookup', hostname);
            }
            return first;
        } catch (err) {
            throw toErrnoException(err, 'lookup', hostname);
        }
    })();
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
export function resolve(hostname: string, rrtype: string): Promise<string[] | AnyRecord[] | CaaRecord[] | MxRecord[] | NaptrRecord[] | SoaRecord | SrvRecord[] | string[][]>;
export async function resolve(hostname: string, rrtype: string = 'A'): Promise<string[] | AnyRecord[] | CaaRecord[] | MxRecord[] | NaptrRecord[] | SoaRecord | SrvRecord[] | string[][]> {
    const normalizedRrtype: Rrtype = validateRrtype(rrtype);
    try {
        const answers = await query(hostname, typeMap[normalizedRrtype]);
        const result = shapeAnswers(normalizedRrtype, answers);
        if (normalizedRrtype === 'SOA' && !result) {
            throw new Error(`ENODATA ${hostname}`);
        }
        return result;
    } catch (err) {
        throw toErrnoException(err, 'resolve', hostname);
    }
}

export async function resolve4(hostname: string, options?: { ttl?: boolean }): Promise<string[] | Array<{ address: string; ttl: number }>> {
    try {
        const answers = await query(hostname, dns.A);
        const addresses = answers.filter(isAddressAnswer);
        return wantsTtl(options)
            ? addresses.map(a => ({ address: a.address, ttl: a.ttl }))
            : addresses.map(a => a.address);
    } catch (err) {
        throw toErrnoException(err, 'resolve4', hostname);
    }
}

export async function resolve6(hostname: string, options?: { ttl?: boolean }): Promise<string[] | Array<{ address: string; ttl: number }>> {
    try {
        const answers = await query(hostname, dns.AAAA);
        const addresses = answers.filter(isAddressAnswer);
        return wantsTtl(options)
            ? addresses.map(a => ({ address: a.address, ttl: a.ttl }))
            : addresses.map(a => a.address);
    } catch (err) {
        throw toErrnoException(err, 'resolve6', hostname);
    }
}

export async function resolveCname(hostname: string): Promise<string[]> {
    return await resolve(hostname, 'CNAME');
}

export async function resolveMx(hostname: string): Promise<MxRecord[]> {
    return await resolve(hostname, 'MX');
}

export async function resolveNaptr(hostname: string): Promise<NaptrRecord[]> {
    return await resolve(hostname, 'NAPTR');
}

export async function resolveNs(hostname: string): Promise<string[]> {
    return await resolve(hostname, 'NS');
}

export async function resolveTxt(hostname: string): Promise<string[][]> {
    return await resolve(hostname, 'TXT');
}

export async function resolveSrv(hostname: string): Promise<SrvRecord[]> {
    return await resolve(hostname, 'SRV');
}

export async function resolvePtr(hostname: string): Promise<string[]> {
    return await resolve(hostname, 'PTR');
}

export async function resolveSoa(hostname: string): Promise<SoaRecord> {
    return await resolve(hostname, 'SOA');
}

export async function reverse(ip: string): Promise<string[]> {
    if (ip === '127.0.0.1' || ip === '::1') return ['localhost'];
    return await resolve(reverseName(ip), 'PTR');
}

export function lookupService(address: string, port: number): Promise<{ hostname: string; service: string }> {
    return new Promise((resolve, reject) => {
        lookupServiceCallback(address, port, (err, hostname, service) => {
            if (err) reject(err);
            else resolve({ hostname, service });
        });
    });
}

export class Resolver {
    private _servers = getServersSync();

    getServers(): string[] {
        return [...this._servers];
    }

    setServers(servers: string[]): void {
        this._servers = normalizeServers(servers);
    }
}

export function getServers(): string[] {
    return getServersSync();
}

export function setServers(servers: string[]): void {
    setServersSync(servers);
}

export function getDefaultResultOrder(): DefaultResultOrder {
    return getDefaultResultOrderSync();
}

export function setDefaultResultOrder(order: DefaultResultOrder): void {
    setDefaultResultOrderSync(order);
}

export * as default from './promises';
