/**
 * DNS module internal helpers shared between mod.ts and promises.ts
 */

const dns = import.meta.use('dns');

// Record type string → native DNS query type constant
export const typeMap: Record<string, number> = {
    A: dns.A,
    AAAA: dns.AAAA,
    CNAME: dns.CNAME,
    MX: dns.MX,
    NAPTR: dns.NAPTR,
    NS: dns.NS,
    PTR: dns.PTR,
    SOA: dns.SOA,
    SRV: dns.SRV,
    TXT: dns.TXT,
    ANY: dns.A,
};

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
export function shapeAnswers(rrtype: string, answers: any[]): any {
    if (rrtype === 'A' || rrtype === 'AAAA') {
        return answers.map(a => a.address);
    }
    if (rrtype === 'CNAME') {
        return answers.map(a => a.cname);
    }
    if (rrtype === 'MX') {
        return answers.map(a => ({ priority: a.priority, exchange: a.exchange }));
    }
    if (rrtype === 'NAPTR') {
        return answers.map(a => ({
            flags: a.flags,
            service: a.service,
            regexp: a.regexp,
            replacement: a.replacement,
            order: a.order,
            preference: a.preference,
        }));
    }
    if (rrtype === 'NS') {
        return answers.map(a => a.ns);
    }
    if (rrtype === 'PTR') {
        return answers.map(a => a.ptr);
    }
    if (rrtype === 'SOA') {
        const a = answers[0] as CModuleDNS.SoaAnswer | undefined;
        if (!a) return null;
        return {
            nsname: a.name,
            hostmaster: a.admin,
            serial: a.serial,
            refresh: a.refresh,
            retry: a.retry,
            expire: a.expire,
            minttl: a.minimum,
        };
    }
    if (rrtype === 'SRV') {
        return answers.map(a => ({
            priority: a.priority,
            weight: a.weight,
            port: a.port,
            name: a.target,
        }));
    }
    if (rrtype === 'TXT') {
        return answers.map(a => [a.txt]);
    }
    return answers;
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
