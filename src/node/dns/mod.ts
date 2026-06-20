/**
 * Node.js dns module
 * Based on CModuleDNS implementation
 */

const dns = import.meta.use('dns');
const os = import.meta.use('os');
import { toErrnoException } from '../_internal/errno';
import * as promises from './promises';

// ============================================================================
// Constants
// ============================================================================

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

// ============================================================================
// Resolution options
// ============================================================================

export interface ResolveOptions {
    ttl?: boolean;
}

export interface LookupOptions {
    family?: number;
    hints?: number;
    all?: boolean;
    verbatim?: boolean;
}

export interface LookupOneOptions extends LookupOptions {
    all?: false;
}

export interface LookupAllOptions extends LookupOptions {
    all: true;
}

// ============================================================================
// Resolution record types
// ============================================================================

export interface MxRecord {
    priority: number;
    exchange: string;
}

export interface NaptrRecord {
    flags: string;
    service: string;
    regexp: string;
    replacement: string;
    order: number;
    preference: number;
}

export interface SoaRecord {
    nsname: string;
    hostmaster: string;
    serial: number;
    refresh: number;
    retry: number;
    expire: number;
    minttl: number;
}

export interface SrvRecord {
    priority: number;
    weight: number;
    port: number;
    name: string;
}

export interface TxtRecord {
    [index: number]: string;
}

export interface AnyRecord {
    type: number;
    value: string;
}

// ============================================================================
// lookup - basic name resolution
// ============================================================================

export function lookup(hostname: string, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
export function lookup(hostname: string, options: LookupOneOptions, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
export function lookup(hostname: string, options: LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void): void;
export function lookup(hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family: number) => void): void;
export function lookup(hostname: string, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const family = options?.family ?? 0;
    const all = options?.all ?? false;

    dns.resolve(hostname, { family: family === 0 ? os.AF_UNSPEC : family === 4 ? os.AF_INET : os.AF_INET6 }).then(
        addresses => {
            if (all) {
                callback(null, addresses.map(a => ({ address: a.ip, family: a.family })));
            } else {
                const addr = addresses[0];
                if (addr) {
                    callback(null, addr.ip, addr.family);
                } else {
                    callback(toErrnoException(new Error(`ENOTFOUND ${hostname}`), 'lookup', hostname), '', 0);
                }
            }
        },
        err => callback(toErrnoException(err, 'lookup', hostname))
    );
}

export function lookupSync(hostname: string, options?: LookupOptions): string | Array<{ address: string; family: number }> {
    const family = options?.family ?? 0;
    const all = options?.all ?? false;

    let addresses: CModuleStreams.AddressInfo[];
    try {
        addresses = dns.resolveSync(hostname, { family: family === 0 ? os.AF_UNSPEC : family === 4 ? os.AF_INET : os.AF_INET6 });
    } catch (err) {
        throw toErrnoException(err, 'lookup', hostname);
    }

    if (all) {
        return addresses.map(a => ({ address: a.ip, family: a.family }));
    }

    return addresses[0]?.ip ?? '';
}

// ============================================================================
// resolve - resolve specific record types
// ============================================================================

export function resolve(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'A', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'AAAA', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'ANY', callback: (err: NodeJS.ErrnoException | null, addresses: AnyRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'CNAME', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'MX', callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'NAPTR', callback: (err: NodeJS.ErrnoException | null, addresses: NaptrRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'NS', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'PTR', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'SOA', callback: (err: NodeJS.ErrnoException | null, addresses: SoaRecord) => void): void;
export function resolve(hostname: string, rrtype: 'SRV', callback: (err: NodeJS.ErrnoException | null, addresses: SrvRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'TXT', callback: (err: NodeJS.ErrnoException | null, addresses: TxtRecord[]) => void): void;
export function resolve(hostname: string, rrtype?: any, callback?: any): void {
    if (typeof rrtype === 'function') {
        callback = rrtype;
        rrtype = 'A';
    }

    const typeMap: Record<string, number> = {
        'A': dns.A,
        'AAAA': dns.AAAA,
        'CNAME': dns.CNAME,
        'MX': dns.MX,
        'NAPTR': dns.NAPTR,
        'NS': dns.NS,
        'PTR': dns.PTR,
        'SOA': dns.SOA,
        'SRV': dns.SRV,
        'TXT': dns.TXT,
        'ANY': dns.A,
    };

    const queryType = typeMap[rrtype] ?? dns.A;

    dns.query(hostname, queryType).then(
        answers => {
            if (rrtype === 'A' || rrtype === 'AAAA') {
                callback(null, answers.map((a: any) => a.address));
            } else if (rrtype === 'CNAME') {
                callback(null, answers.map((a: any) => a.cname));
            } else if (rrtype === 'MX') {
                callback(null, answers.map((a: any) => ({ priority: a.priority, exchange: a.exchange })));
            } else if (rrtype === 'NS') {
                callback(null, answers.map((a: any) => a.ns));
            } else if (rrtype === 'PTR') {
                callback(null, answers.map((a: any) => a.ptr));
            } else if (rrtype === 'SOA') {
                const a = answers[0] as CModuleDNS.SoaAnswer;
                callback(null, {
                    nsname: a.name,
                    hostmaster: a.admin,
                    serial: a.serial,
                    refresh: a.refresh,
                    retry: a.retry,
                    expire: a.expire,
                    minttl: a.minimum,
                });
            } else if (rrtype === 'SRV') {
                callback(null, answers.map((a: any) => ({
                    priority: a.priority,
                    weight: a.weight,
                    port: a.port,
                    name: a.target,
                })));
            } else if (rrtype === 'TXT') {
                callback(null, answers.map((a: any) => [a.txt]));
            } else {
                callback(null, answers);
            }
        },
        err => callback(toErrnoException(err, 'resolve', hostname))
    );
}

// ============================================================================
// resolve4 / resolve6
// ============================================================================

export function resolve4(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve4(hostname: string, options: { ttl: true }, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; ttl: number }>) => void): void;
export function resolve4(hostname: string, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    dns.query(hostname, dns.A).then(
        answers => {
            if (options?.ttl) {
                callback(null, answers.map((a: any) => ({ address: a.address, ttl: a.ttl })));
            } else {
                callback(null, answers.map((a: any) => a.address));
            }
        },
        err => callback(toErrnoException(err, 'resolve4'))
    );
}

export function resolve6(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve6(hostname: string, options: { ttl: true }, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; ttl: number }>) => void): void;
export function resolve6(hostname: string, options?: any, callback?: any): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    dns.query(hostname, dns.AAAA).then(
        answers => {
            if (options?.ttl) {
                callback(null, answers.map((a: any) => ({ address: a.address, ttl: a.ttl })));
            } else {
                callback(null, answers.map((a: any) => a.address));
            }
        },
        err => callback(toErrnoException(err, 'resolve6'))
    );
}

// ============================================================================
// resolveCname / resolveMx / resolveNs / resolveTxt / resolveSrv / resolvePtr / resolveSoa
// ============================================================================

export function resolveCname(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
    resolve(hostname, 'CNAME', callback);
}

export function resolveMx(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void): void {
    resolve(hostname, 'MX', callback);
}

export function resolveNs(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
    resolve(hostname, 'NS', callback);
}

export function resolveTxt(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[][]) => void): void {
    dns.query(hostname, dns.TXT).then(
        answers => callback(null, answers.map((a: any) => [a.txt])),
        err => callback(toErrnoException(err, 'resolveTxt'), [])
    );
}

export function resolveSrv(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: SrvRecord[]) => void): void {
    resolve(hostname, 'SRV', callback);
}

export function resolvePtr(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
    resolve(hostname, 'PTR', callback);
}

export function resolveSoa(hostname: string, callback: (err: NodeJS.ErrnoException | null, address: SoaRecord) => void): void {
    resolve(hostname, 'SOA', callback);
}

export function resolveNaptr(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: NaptrRecord[]) => void): void {
    resolve(hostname, 'NAPTR', callback);
}

// ============================================================================
// reverse
// ============================================================================

export function reverse(ip: string, callback: (err: NodeJS.ErrnoException | null, hostnames: string[]) => void): void {
    // Reverse DNS lookup
    const ptrName = ip.split('.').reverse().join('.') + '.in-addr.arpa';
    resolve(ptrName, 'PTR', callback);
}

// ============================================================================
// setServers / getServers
// ============================================================================

let _dnsServers: string[] = [];

export function setServers(servers: string[]): void {
    _dnsServers = servers;
}

export function getServers(): string[] {
    return _dnsServers.length > 0 ? [..._dnsServers] : ['8.8.8.8', '8.8.4.4'];
}

let _defaultResultOrder: 'ipv4first' | 'verbatim' = 'ipv4first';

export function setDefaultResultOrder(order: 'ipv4first' | 'verbatim'): void {
    _defaultResultOrder = order;
}

// ============================================================================
// promises API
// ============================================================================

export { promises };
