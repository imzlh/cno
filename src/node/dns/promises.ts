/**
 * Node.js dns/promises API
 */

const dns = import.meta.use('dns');
const os = import.meta.use('os');
import { toErrnoException } from '../_internal/errno';
import { typeMap, shapeAnswers, reverseName } from './_internal';
import type { AnyRecord, LookupOptions, MxRecord, NaptrRecord, SoaRecord, SrvRecord } from './mod';

type LookupAddress = { address: string; family: number };

export async function lookup(hostname: string, options?: LookupOptions): Promise<LookupAddress | LookupAddress[]> {
    const family = options?.family ?? 0;
    const all = options?.all ?? false;

    try {
        const addresses = await dns.resolve(hostname, {
            family: family === 0 ? os.AF_UNSPEC : family === 4 ? os.AF_INET : os.AF_INET6,
        });
        const mapped = addresses.map((a: any) => ({ address: a.ip, family: a.family }));

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
}

export async function resolve(hostname: string, rrtype: string = 'A'): Promise<string[] | AnyRecord[] | MxRecord[] | NaptrRecord[] | SoaRecord | SrvRecord[] | string[][]> {
    try {
        const answers = await dns.query(hostname, typeMap[rrtype] ?? dns.A);
        const result = shapeAnswers(rrtype, answers);
        if (rrtype === 'SOA' && !result) {
            throw new Error(`ENODATA ${hostname}`);
        }
        return result;
    } catch (err) {
        throw toErrnoException(err, 'resolve', hostname);
    }
}

export async function resolve4(hostname: string, options?: { ttl?: boolean }): Promise<string[] | Array<{ address: string; ttl: number }>> {
    try {
        const answers = await dns.query(hostname, dns.A);
        return options?.ttl
            ? answers.map((a: any) => ({ address: a.address, ttl: a.ttl }))
            : answers.map((a: any) => a.address);
    } catch (err) {
        throw toErrnoException(err, 'resolve4', hostname);
    }
}

export async function resolve6(hostname: string, options?: { ttl?: boolean }): Promise<string[] | Array<{ address: string; ttl: number }>> {
    try {
        const answers = await dns.query(hostname, dns.AAAA);
        return options?.ttl
            ? answers.map((a: any) => ({ address: a.address, ttl: a.ttl }))
            : answers.map((a: any) => a.address);
    } catch (err) {
        throw toErrnoException(err, 'resolve6', hostname);
    }
}

export async function resolveCname(hostname: string): Promise<string[]> {
    return await resolve(hostname, 'CNAME') as string[];
}

export async function resolveMx(hostname: string): Promise<MxRecord[]> {
    return await resolve(hostname, 'MX') as MxRecord[];
}

export async function resolveNaptr(hostname: string): Promise<NaptrRecord[]> {
    return await resolve(hostname, 'NAPTR') as NaptrRecord[];
}

export async function resolveNs(hostname: string): Promise<string[]> {
    return await resolve(hostname, 'NS') as string[];
}

export async function resolveTxt(hostname: string): Promise<string[][]> {
    return await resolve(hostname, 'TXT') as string[][];
}

export async function resolveSrv(hostname: string): Promise<SrvRecord[]> {
    return await resolve(hostname, 'SRV') as SrvRecord[];
}

export async function resolvePtr(hostname: string): Promise<string[]> {
    return await resolve(hostname, 'PTR') as string[];
}

export async function resolveSoa(hostname: string): Promise<SoaRecord> {
    return await resolve(hostname, 'SOA') as SoaRecord;
}

export async function reverse(ip: string): Promise<string[]> {
    return await resolve(reverseName(ip), 'PTR') as string[];
}

export * as default from './promises';
