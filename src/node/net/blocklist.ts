/**
 * node:net BlockList and SocketAddress.
 *
 * Self-contained apart from the shared IP parsers in ./_shared — no native
 * modules, no Socket/Server dependency, no module-level mutable state.
 */

import { isIPv4, isIPv6, parseIpv6Parts } from './_shared';

type BlockListFamily = 'ipv4' | 'ipv6';
type BlockListRule = {
    family: BlockListFamily;
    start: bigint;
    end: bigint;
    rule: string;
};

function parseIpv4(address: string): bigint | null {
    if (!isIPv4(address)) return null;
    const parts = address.split('.').map((part) => Number(part));
    const [a, b, c, d] = parts;
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    return BigInt(((a << 24) >>> 0) + (b << 16) + (c << 8) + d);
}

function parseIpv6(address: string): bigint | null {
    const parts = parseIpv6Parts(address);
    if (!parts) return null;
    let value = 0n;
    for (const part of parts) {
        value = (value << 16n) + BigInt(part);
    }
    return value;
}

function parseBlockListAddress(address: string, type?: string): { family: BlockListFamily; value: bigint; normalized: string } {
    // Node's `type` parameter DEFAULTS TO 'ipv4' — it does not auto-detect the
    // family. Measured on node v24.18.0: addAddress('::1') with no type throws
    // ERR_INVALID_ADDRESS, and check('::1') with no type is false even when a
    // matching IPv6 rule exists. cno auto-detected, which silently installed
    // rules node rejects and answered true where node answers false.
    if (type !== undefined && typeof type !== 'string') {
        const received = type === null ? 'null' : `type ${typeof type} (${String(type)})`;
        throw Object.assign(
            new TypeError(`The "family" argument must be of type string. Received ${received}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    const requested = (type ?? 'ipv4').toLowerCase();
    if (requested !== 'ipv4' && requested !== 'ipv6') {
        throw Object.assign(
            new TypeError('The "type" argument must be either "ipv4" or "ipv6"'),
            { code: 'ERR_INVALID_ARG_VALUE' },
        );
    }

    if (typeof address !== 'string') {
        const received = address === null ? 'null' : `type ${typeof address} (${String(address)})`;
        throw Object.assign(
            new TypeError(`The "address" argument must be of type string. Received ${received}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    const text = address;
    const ipv4 = parseIpv4(text);
    if (ipv4 !== null) {
        if (requested === 'ipv6') throw invalidAddressError();
        return { family: 'ipv4', value: ipv4, normalized: text };
    }

    const ipv6 = parseIpv6(text);
    if (ipv6 !== null) {
        if (requested === 'ipv4') throw invalidAddressError();
        return { family: 'ipv6', value: ipv6, normalized: text.toLowerCase() };
    }

    throw invalidAddressError();
}

function blockListMaxBits(family: BlockListFamily): number {
    return family === 'ipv4' ? 32 : 128;
}

// Node tags both of these; a bare TypeError/RangeError leaves callers that
// branch on err.code unable to tell a bad address from any other failure.
function invalidAddressError(): TypeError {
    return Object.assign(new TypeError('Invalid IP address'), { code: 'ERR_INVALID_ADDRESS' });
}

function blockListLabel(family: BlockListFamily): string {
    return family === 'ipv4' ? 'IPv4' : 'IPv6';
}

// An IPv4-mapped IPv6 address is exactly the ::ffff:0:0/96 prefix. Measured
// against node v24.18.0: rules are stored verbatim (`bl.rules` keeps the family
// and spelling it was given), and the mapped/plain equivalence is resolved at
// CHECK time, in BOTH directions:
//   addAddress('1.2.3.4')            + check('::ffff:1.2.3.4','ipv6') -> true
//   addAddress('::ffff:1.2.3.4','ipv6') + check('1.2.3.4','ipv4')     -> true
// and identically for addRange and addSubnet, including the range edges. A
// *pure* v6 rule (2001:db8::1) checked with a v4 address stays false, so the
// equivalence applies only to the mapped prefix and must not be widened.
// BlockList exists solely for access control, so a miss here is a bypass: a
// blocked IPv4 peer reconnecting over IPv6 presents the mapped form.
const V4_MAPPED_LOW = 0xffff00000000n;
const V4_MAPPED_HIGH = 0xffffffffffffn;

/**
 * Every (family, value) pair a checked address must be tested under: itself,
 * plus its counterpart across the v4-mapped boundary when one exists.
 */
function blockListCandidates(
    family: BlockListFamily,
    value: bigint,
): Array<{ family: BlockListFamily; value: bigint }> {
    if (family === 'ipv4') {
        return [{ family, value }, { family: 'ipv6', value: V4_MAPPED_LOW | value }];
    }
    if (value >= V4_MAPPED_LOW && value <= V4_MAPPED_HIGH) {
        return [{ family, value }, { family: 'ipv4', value: value & 0xffffffffn }];
    }
    return [{ family, value }];
}

export class BlockList {
    #rules: BlockListRule[] = [];

    addAddress(address: string, type?: string): void {
        const parsed = parseBlockListAddress(address, type);
        this.#rules.push({
            family: parsed.family,
            start: parsed.value,
            end: parsed.value,
            rule: `Address: ${blockListLabel(parsed.family)} ${parsed.normalized}`,
        });
    }

    addRange(start: string, end: string, type?: string): void {
        const from = parseBlockListAddress(start, type);
        const to = parseBlockListAddress(end, type);
        if (from.family !== to.family) throw invalidAddressError();
        if (from.value > to.value) {
            throw Object.assign(
                new RangeError('Start address must be less than or equal to end address'),
                { code: 'ERR_INVALID_ARG_VALUE' },
            );
        }
        this.#rules.push({
            family: from.family,
            start: from.value,
            end: to.value,
            rule: `Range: ${blockListLabel(from.family)} ${from.normalized}-${to.normalized}`,
        });
    }

    addSubnet(net: string, prefix: number, type?: string): void {
        const parsed = parseBlockListAddress(net, type);
        const max = blockListMaxBits(parsed.family);
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
            throw new RangeError('Subnet prefix is out of range');
        }

        const hostBits = BigInt(max - prefix);
        const allBits = (1n << BigInt(max)) - 1n;
        const hostMask = hostBits === 0n ? 0n : (1n << hostBits) - 1n;
        const network = parsed.value & (allBits ^ hostMask);
        this.#rules.push({
            family: parsed.family,
            start: network,
            end: network | hostMask,
            rule: `Subnet: ${blockListLabel(parsed.family)} ${parsed.normalized}/${prefix}`,
        });
    }

    check(address: string, type?: string): boolean {
        // Node returns false for an address it cannot parse rather than throwing
        // — a check() that throws turns a deny-list miss into a crash at the
        // call site, so the failure mode matters.
        let parsed;
        try {
            parsed = parseBlockListAddress(address, type);
        } catch {
            return false;
        }
        const candidates = blockListCandidates(parsed.family, parsed.value);
        return this.#rules.some((rule) =>
            candidates.some((candidate) =>
                rule.family === candidate.family
                && candidate.value >= rule.start
                && candidate.value <= rule.end
            )
        );
    }

    get rules(): string[] {
        return this.#rules.map((rule) => rule.rule);
    }
}

// SocketAddress (Node 15+)

export interface SocketAddressInit {
    address?: string;
    port?: number;
    family?: 'ipv4' | 'ipv6';
    flowlabel?: number;
}

export class SocketAddress {
    readonly address: string;
    readonly port: number;
    readonly family: 'ipv4' | 'ipv6';
    readonly flowlabel: number;

    constructor(options?: SocketAddressInit) {
        const opts = options ?? {};
        if (opts.family !== undefined && opts.family !== 'ipv4' && opts.family !== 'ipv6') {
            throw new TypeError(`The property 'options.family' is invalid. Received ${String(opts.family)}`);
        }
        const family: 'ipv4' | 'ipv6' = opts.family ?? 'ipv4';

        const address = opts.address ?? (family === 'ipv6' ? '::' : '127.0.0.1');
        if ((family === 'ipv4' && !isIPv4(address)) || (family === 'ipv6' && !isIPv6(address))) {
            throw new TypeError('Invalid socket address');
        }

        const port = opts.port ?? 0;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new RangeError('Port should be >= 0 and < 65536');
        }
        const flowlabel = opts.flowlabel ?? 0;
        if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xfffff) {
            throw new RangeError('flowlabel should be >= 0 and < 1048576');
        }

        this.address = address;
        this.port = port;
        this.family = family;
        this.flowlabel = flowlabel;
    }
}
