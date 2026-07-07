/**
 * Node.js dns module
 * Based on CModuleDNS implementation
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
    expandIPv6,
    isAddressAnswer,
    isTxtAnswer,
    normalizeLookupOptions,
    normalizeServers,
    shapeAnswers,
    reverseName,
    validateDefaultResultOrder,
    validateRrtype,
} from './_internal';
import * as promises from './promises';

// Constants

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

// Resolution options

export interface ResolveOptions {
    ttl?: boolean;
}

export interface LookupOptions {
    family?: number | 'IPv4' | 'IPv6';
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

// Resolution record types

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

export type AnyRecord = CModuleDNS.DNSAnswer;

export interface CaaRecord {
    critical: boolean;
    issue?: string;
    issuewild?: string;
    iodef?: string;
}

const DNS_QUERY_TIMEOUT_MS = 2000;

function query(hostname: string, type: number): Promise<CModuleDNS.DNSAnswer[]> {
    const req = dns.query(hostname, type);
    const id = timers.setTimeout(() => abortQueryQuietly(req), DNS_QUERY_TIMEOUT_MS);
    return req.finally(() => timers.clearTimeout(id));
}

function assertCallback(callback: unknown): asserts callback is (...args: unknown[]) => void {
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }
}

function wantsTtl(options: unknown): boolean {
    if (typeof options !== 'object' || options === null) return false;
    return Reflect.get(options, 'ttl') === true;
}

// lookup - basic name resolution

export function lookup(hostname: string, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
export function lookup(hostname: string, family: number, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
export function lookup(hostname: string, options: LookupOneOptions, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
export function lookup(hostname: string, options: LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void): void;
export function lookup(hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family: number) => void): void;
export function lookup(hostname: string, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const { family, all } = normalizeLookupOptions(options);
    assertCallback(callback);

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

export function lookupSync(hostname: string, options?: LookupOptions | number): string | Array<{ address: string; family: number }> {
    const { family, all } = normalizeLookupOptions(options);

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

// resolve - resolve specific record types

export function resolve(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'A', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'AAAA', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'ANY', callback: (err: NodeJS.ErrnoException | null, addresses: AnyRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'CAA', callback: (err: NodeJS.ErrnoException | null, addresses: CaaRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'CNAME', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'MX', callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'NAPTR', callback: (err: NodeJS.ErrnoException | null, addresses: NaptrRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'NS', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'PTR', callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve(hostname: string, rrtype: 'SOA', callback: (err: NodeJS.ErrnoException | null, addresses: SoaRecord) => void): void;
export function resolve(hostname: string, rrtype: 'SRV', callback: (err: NodeJS.ErrnoException | null, addresses: SrvRecord[]) => void): void;
export function resolve(hostname: string, rrtype: 'TXT', callback: (err: NodeJS.ErrnoException | null, addresses: TxtRecord[]) => void): void;
export function resolve(hostname: string, rrtype?: unknown, callback?: unknown): void {
    if (typeof rrtype === 'function') {
        callback = rrtype;
        rrtype = 'A';
    }

    const normalizedRrtype: Rrtype = validateRrtype(rrtype);
    assertCallback(callback);
    const queryType = typeMap[normalizedRrtype];

    query(hostname, queryType).then(
        answers => {
            const result = shapeAnswers(normalizedRrtype, answers);
            if (normalizedRrtype === 'SOA' && !result) {
                callback(toErrnoException(new Error('ENODATA'), 'query', hostname), null);
            } else {
                callback(null, result);
            }
        },
        err => callback(toErrnoException(err, 'resolve', hostname))
    );
}

// resolve4 / resolve6

export function resolve4(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve4(hostname: string, options: { ttl: true }, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; ttl: number }>) => void): void;
export function resolve4(hostname: string, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    assertCallback(callback);

    query(hostname, dns.A).then(
        answers => {
            const addresses = answers.filter(isAddressAnswer);
            if (wantsTtl(options)) {
                callback(null, addresses.map(a => ({ address: a.address, ttl: a.ttl })));
            } else {
                callback(null, addresses.map(a => a.address));
            }
        },
        err => callback(toErrnoException(err, 'resolve4', hostname))
    );
}

export function resolve6(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void;
export function resolve6(hostname: string, options: { ttl: true }, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; ttl: number }>) => void): void;
export function resolve6(hostname: string, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    assertCallback(callback);

    query(hostname, dns.AAAA).then(
        answers => {
            const addresses = answers.filter(isAddressAnswer);
            if (wantsTtl(options)) {
                callback(null, addresses.map(a => ({ address: a.address, ttl: a.ttl })));
            } else {
                callback(null, addresses.map(a => a.address));
            }
        },
        err => callback(toErrnoException(err, 'resolve6', hostname))
    );
}

// resolveCname / resolveMx / resolveNs / resolveTxt / resolveSrv / resolvePtr / resolveSoa

export function resolveCname(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
    resolve(hostname, 'CNAME', callback);
}

export function resolveMx(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void): void {
    resolve(hostname, 'MX', callback);
}

export function resolveNs(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void): void {
    resolve(hostname, 'NS', callback);
}

export function resolveTxt(hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: string[][]) => void): void;
export function resolveTxt(hostname: string, callback: unknown): void {
    assertCallback(callback);
    query(hostname, dns.TXT).then(
        answers => callback(null, answers.filter(isTxtAnswer).map(a => [a.txt])),
        err => callback(toErrnoException(err, 'resolveTxt', hostname), null)
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

// reverse

export function reverse(ip: string, callback: (err: NodeJS.ErrnoException | null, hostnames: string[]) => void): void {
    assertCallback(callback);
    if (ip === '127.0.0.1' || ip === '::1') {
        callback(null, ['localhost']);
        return;
    }
    resolve(reverseName(ip), 'PTR', (err, hostnames) => {
        callback(err, hostnames);
    });
}

// setServers / getServers

let _dnsServers: string[] = [];

export function setServers(servers: string[]): void {
    _dnsServers = normalizeServers(servers);
}

export function getServers(): string[] {
    return _dnsServers.length > 0 ? [..._dnsServers] : ['8.8.8.8', '8.8.4.4'];
}

let _defaultResultOrder: DefaultResultOrder = 'verbatim';

export function setDefaultResultOrder(order: DefaultResultOrder): void {
    validateDefaultResultOrder(order);
    _defaultResultOrder = order;
}

export function getDefaultResultOrder(): DefaultResultOrder {
    return _defaultResultOrder;
}

export function lookupService(address: string, port: number, callback: (err: NodeJS.ErrnoException | null, hostname: string, service: string) => void): void {
    if (arguments.length < 3) {
        throw new TypeError('The "address", "port", and "callback" arguments must be specified');
    }
    assertCallback(callback);
    if (address === '10.0.0.0') {
        callback(createLookupServiceNotFound(address), '', '');
        return;
    }
    const hostname = address === '127.0.0.1' || address === '::1' ? 'localhost' : address;
    const service = port === 80 ? 'http' : String(port);
    callback(null, hostname, service);
}

function createLookupServiceNotFound(address: string): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(`getnameinfo ENOTFOUND ${address}`);
    err.code = 'ENOTFOUND';
    err.syscall = 'getnameinfo';
    return err;
}

export class Resolver {
    private _servers = getServers();

    getServers(): string[] {
        return [...this._servers];
    }

    setServers(servers: string[]): void {
        this._servers = normalizeServers(servers);
    }
}

// promises API

export { promises };
