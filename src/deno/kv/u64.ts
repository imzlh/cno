export const MAX_U64 = (1n << 64n) - 1n;
export const DENO_CUSTOM_INSPECT = Symbol.for('Deno.customInspect');

export class KvU64 implements Deno.KvU64 {
    readonly value: bigint;

    constructor(value: bigint) {
        if (typeof value !== 'bigint') {
            throw new TypeError('Deno.KvU64 value must be a bigint');
        }
        if (value < 0n || value > MAX_U64) {
            throw new RangeError('Deno.KvU64 value must be in range 0 to 2^64-1');
        }
        this.value = value;
    }

    valueOf(): bigint {
        return this.value;
    }

    toString(): string {
        return this.value.toString();
    }

    [DENO_CUSTOM_INSPECT](): string {
        return `[Deno.KvU64: ${this.value}n]`;
    }
}

Object.defineProperty(KvU64.prototype, Symbol.toStringTag, {
    value: 'Deno.KvU64',
    configurable: true,
});

export function isKvU64(value: unknown): value is KvU64 {
    return value instanceof KvU64;
}

