/**
 * DNS module internal helpers shared between mod.ts and promises.ts
 */

const dns = import.meta.use('dns');

export type DefaultResultOrder = 'ipv4first' | 'ipv6first' | 'verbatim';

// Record type string → native DNS query type constant
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
    ANY: dns.A,
} as const;

export type Rrtype = keyof typeof typeMap;

export type AbortableDnsQuery = Promise<CModuleDNS.DNSAnswer[]> & {
    abort?: () => void;
};

interface NodeCaaRecord {
    critical: boolean;
    issue?: string;
    issuewild?: string;
    iodef?: string;
}

interface NodeMxRecord {
    priority: number;
    exchange: string;
}

interface NodeNaptrRecord {
    flags: string;
    service: string;
    regexp: string;
    replacement: string;
    order: number;
    preference: number;
}

interface NodeSoaRecord {
    nsname: string;
    hostmaster: string;
    serial: number;
    refresh: number;
    retry: number;
    expire: number;
    minttl: number;
}

interface NodeSrvRecord {
    priority: number;
    weight: number;
    port: number;
    name: string;
}

export type ShapedDnsAnswers =
    | string[]
    | CModuleDNS.DNSAnswer[]
    | NodeCaaRecord[]
    | NodeMxRecord[]
    | NodeNaptrRecord[]
    | NodeSoaRecord
    | NodeSrvRecord[]
    | string[][]
    | null;

export function isAddressAnswer(answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.AddressAnswer {
    return answer.type === dns.A || answer.type === dns.AAAA;
}

export function abortQueryQuietly(req: AbortableDnsQuery): void {
    try {
        req.abort?.();
    } catch {
        // Timeout cleanup is best-effort; the query promise still owns errors.
    }
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

export function normalizeLookupFamily(family: unknown): 0 | 4 | 6 {
    if (family === 'IPv4') return 4;
    if (family === 'IPv6') return 6;
    if (family === 0 || family === 4 || family === 6) return family;
    throw new TypeError(`The property 'options.family' must be one of: 0, 4, 6, 'IPv4', 'IPv6'. Received ${String(family)}`);
}

export function normalizeLookupOptions(options: unknown): { family: 0 | 4 | 6; all: boolean } {
    if (options === undefined || options === null) return { family: 0, all: false };
    if (typeof options === 'number') {
        return { family: normalizeLookupFamily(options), all: false };
    }
    if (typeof options !== 'object') {
        throw new TypeError(`The "options" argument must be of type object or integer. Received type ${typeof options}`);
    }

    const family = Reflect.get(options, 'family') ?? 0;
    return { family: normalizeLookupFamily(family), all: Boolean(Reflect.get(options, 'all')) };
}

export function validateRrtype(rrtype: unknown): Rrtype {
    if (typeof rrtype !== 'string') throw new TypeError('The "rrtype" argument must be of type string');
    const normalized = rrtype.toUpperCase();
    if (!(normalized in typeMap)) throw new TypeError(`The argument 'rrtype' is invalid. Received '${rrtype}'`);
    return normalized as Rrtype;
}

export function validateDefaultResultOrder(order: unknown): asserts order is DefaultResultOrder {
    if (order !== 'verbatim' && order !== 'ipv4first' && order !== 'ipv6first') {
        throw new TypeError(`The argument 'dnsOrder' must be one of: 'verbatim', 'ipv4first', 'ipv6first'. Received ${String(order)}`);
    }
}

function validatePort(raw: string): number {
    if (!/^\d+$/.test(raw)) throw new TypeError(`Invalid DNS server port: ${raw}`);
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError(`Invalid DNS server port: ${raw}`);
    return port;
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
    return host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host);
}

function normalizeServer(server: unknown): string {
    if (typeof server !== 'string') {
        throw new TypeError(`DNS server must be a string. Received ${typeof server}`);
    }

    if (server.startsWith('[')) {
        const match = /^\[([^\]]+)\](?::([^:]+))?$/.exec(server);
        if (!match || !isIPv6(match[1])) throw new TypeError(`Invalid IP address: ${server}`);
        if (match[2] !== undefined) validatePort(match[2]);
        return match[2] === undefined ? `[${match[1]}]` : `[${match[1]}]:${match[2]}`;
    }

    const colon = server.lastIndexOf(':');
    if (colon > -1 && server.indexOf(':') === colon) {
        const host = server.slice(0, colon);
        const port = validatePort(server.slice(colon + 1));
        if (!isIPv4(host)) throw new TypeError(`Invalid IP address: ${host}`);
        return port === 53 ? host : `${host}:${port}`;
    }

    if (!isIPv4(server) && !isIPv6(server)) throw new TypeError(`Invalid IP address: ${server}`);
    return server;
}

export function normalizeServers(servers: unknown): string[] {
    if (!Array.isArray(servers)) {
        throw new TypeError(`The "servers" argument must be an instance of Array. Received ${typeof servers}`);
    }
    return servers.map(normalizeServer);
}

/**
 * Expand abbreviated IPv6 address to full 8-segment form.
 * e.g. "::1" → "00000000000000000000000000000001"
 */
export function expandIPv6(ip: string): string {
    if (ip.includes('::')) {
        const [left, right] = ip.split('::');
        const leftParts = left ? left.split(':') : [];
        const rightParts = right ? right.split(':') : [];
        const missing = 8 - leftParts.length - rightParts.length;
        return [...leftParts, ...Array(missing).fill('0'), ...rightParts]
            .map(p => p.padStart(4, '0')).join('');
    }
    return ip.split(':').map(p => p.padStart(4, '0')).join('');
}

/**
 * Transform raw DNS answers into Node.js-shaped records based on rrtype.
 * Returns null for SOA when no answers are present.
 */
export function shapeAnswers(rrtype: Rrtype, answers: readonly CModuleDNS.DNSAnswer[]): ShapedDnsAnswers {
    if (rrtype === 'A' || rrtype === 'AAAA') {
        return answers.filter(isAddressAnswer).map(a => a.address);
    }
    if (rrtype === 'CNAME') {
        return answers.filter(isCnameAnswer).map(a => a.cname);
    }
    if (rrtype === 'CAA') {
        return answers.filter(isCaaAnswer).map(a => ({
            critical: (a.flags & 0x80) !== 0,
            issue: a.tag === 'issue' ? a.value : undefined,
            issuewild: a.tag === 'issuewild' ? a.value : undefined,
            iodef: a.tag === 'iodef' ? a.value : undefined,
        }));
    }
    if (rrtype === 'MX') {
        return answers.filter(isMxAnswer).map(a => ({ priority: a.priority, exchange: a.exchange }));
    }
    if (rrtype === 'NAPTR') {
        return answers.filter(isNaptrAnswer).map(a => ({
            flags: a.flags,
            service: a.services,
            regexp: a.regexp,
            replacement: a.replacement,
            order: a.order,
            preference: a.preference,
        }));
    }
    if (rrtype === 'NS') {
        return answers.filter(isNsAnswer).map(a => a.ns);
    }
    if (rrtype === 'PTR') {
        return answers.filter(isPtrAnswer).map(a => a.ptr);
    }
    if (rrtype === 'SOA') {
        const a = answers.find(isSoaAnswer);
        if (!a) return null;
        return {
            nsname: a.primary,
            hostmaster: a.admin,
            serial: a.serial,
            refresh: a.refresh,
            retry: a.retry,
            expire: a.expire,
            minttl: a.minimum,
        };
    }
    if (rrtype === 'SRV') {
        return answers.filter(isSrvAnswer).map(a => ({
            priority: a.priority,
            weight: a.weight,
            port: a.port,
            name: a.target,
        }));
    }
    if (rrtype === 'TXT') {
        return answers.filter(isTxtAnswer).map(a => [a.txt]);
    }
    return [...answers];
}

/**
 * Build PTR name for reverse DNS lookup.
 */
export function reverseName(ip: string): string {
    if (ip.includes(':')) {
        return expandIPv6(ip).split('').reverse().join('.') + '.ip6.arpa';
    }
    return ip.split('.').reverse().join('.') + '.in-addr.arpa';
}
