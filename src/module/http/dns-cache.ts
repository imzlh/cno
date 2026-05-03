const dns  = import.meta.use("dns");
const os   = import.meta.use("os");

interface DnsAddress {
    ip:     string;
    family: number;
    ttl?:   number;
}

interface CacheEntry {
    addresses: DnsAddress[];
    expiresAt: number;
}

const DEFAULT_TTL_MS = 300_000;

class DnsCache {
    private cache = new Map<string, CacheEntry>();

    async resolve(hostname: string, options?: { family?: number }): Promise<DnsAddress[]> {
        const key = `${hostname}:${options?.family ?? os.AF_UNSPEC}`;

        const cached = this.cache.get(key);
        if (cached && Date.now() < cached.expiresAt) {
            return cached.addresses;
        }

        const addrs = await dns.resolve(hostname, options as any);
        if (!addrs?.length) return addrs;

        const ttl = this.inferTtl(addrs);
        this.cache.set(key, {
            addresses: addrs,
            expiresAt: Date.now() + ttl
        });

        return addrs;
    }

    invalidate(hostname: string): void {
        for (const key of this.cache.keys()) {
            if (key.startsWith(hostname + ":")) {
                this.cache.delete(key);
            }
        }
    }

    clear(): void {
        this.cache.clear();
    }

    getStats(): { size: number; entries: Array<{ hostname: string; ttlRemaining: number }> } {
        const now = Date.now();
        return {
            size: this.cache.size,
            entries: [...this.cache.entries()].map(([key, entry]) => ({
                hostname: key.split(":")[0],
                ttlRemaining: Math.max(0, entry.expiresAt - now)
            }))
        };
    }

    private inferTtl(addrs: DnsAddress[]): number {
        const ttls = addrs
            .map(a => (a as any).ttl)
            .filter((t): t is number => typeof t === "number" && t > 0);

        if (ttls.length > 0) {
            return Math.min(...ttls) * 1000;
        }
        return DEFAULT_TTL_MS;
    }
}

export const dnsCache = new DnsCache();

export type { DnsAddress };
