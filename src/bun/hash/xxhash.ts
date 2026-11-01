import { hashInputBytes, readUint32LE, readUint64LE, seed32, seed64, type HashInput } from './input';

const P1 = 0x9e3779b1, P2 = 0x85ebca77, P3 = 0xc2b2ae3d, P4 = 0x27d4eb2f, P5 = 0x165667b1;
const rot32 = (x: number, n: number): number => (x << n | x >>> (32 - n)) >>> 0;
const round32 = (acc: number, input: number): number => Math.imul(rot32((acc + Math.imul(input, P2)) >>> 0, 13), P1) >>> 0;

export function xxHash32(data: HashInput, seed?: number): number {
    const b = hashInputBytes(data), len = b.length, s = seed32(seed);
    let h: number, i = 0;
    if (len >= 16) {
        let v1 = (s + P1 + P2) >>> 0, v2 = (s + P2) >>> 0, v3 = s, v4 = (s - P1) >>> 0;
        do {
            v1 = round32(v1, readUint32LE(b, i)); v2 = round32(v2, readUint32LE(b, i + 4));
            v3 = round32(v3, readUint32LE(b, i + 8)); v4 = round32(v4, readUint32LE(b, i + 12)); i += 16;
        } while (i <= len - 16);
        h = (rot32(v1, 1) + rot32(v2, 7) + rot32(v3, 12) + rot32(v4, 18)) >>> 0;
    } else h = (s + P5) >>> 0;
    h = (h + len) >>> 0;
    while (i + 4 <= len) { h = Math.imul(rot32((h + Math.imul(readUint32LE(b, i), P3)) >>> 0, 17), P4) >>> 0; i += 4; }
    while (i < len) { h = Math.imul(rot32((h + Math.imul(b[i++], P5)) >>> 0, 11), P1) >>> 0; }
    h ^= h >>> 15; h = Math.imul(h, P2); h ^= h >>> 13; h = Math.imul(h, P3); return (h ^ h >>> 16) >>> 0;
}

const MASK = 0xffff_ffff_ffff_ffffn;
const Q1 = 0x9e3779b185ebca87n, Q2 = 0xc2b2ae3d27d4eb4fn, Q3 = 0x165667b19e3779f9n, Q4 = 0x85ebca77c2b2ae63n, Q5 = 0x27d4eb2f165667c5n;
const u = (x: bigint): bigint => x & MASK;
const rot64 = (x: bigint, n: bigint): bigint => u((u(x) << n) | (u(x) >> (64n - n)));
const round64 = (acc: bigint, input: bigint): bigint => u(rot64(u(acc + input * Q2), 31n) * Q1);
const merge64 = (acc: bigint, value: bigint): bigint => u((acc ^ round64(0n, value)) * Q1 + Q4);

export function xxHash64(data: HashInput, seed?: bigint): bigint {
    const b = hashInputBytes(data), len = b.length, s = seed64(seed);
    let h: bigint, i = 0;
    if (len >= 32) {
        let v1 = u(s + Q1 + Q2), v2 = u(s + Q2), v3 = s, v4 = u(s - Q1);
        do {
            v1 = round64(v1, readUint64LE(b, i)); v2 = round64(v2, readUint64LE(b, i + 8));
            v3 = round64(v3, readUint64LE(b, i + 16)); v4 = round64(v4, readUint64LE(b, i + 24)); i += 32;
        } while (i <= len - 32);
        h = u(rot64(v1, 1n) + rot64(v2, 7n) + rot64(v3, 12n) + rot64(v4, 18n));
        h = merge64(merge64(merge64(merge64(h, v1), v2), v3), v4);
    } else h = u(s + Q5);
    h = u(h + BigInt(len));
    while (i + 8 <= len) { h = u(rot64(h ^ round64(0n, readUint64LE(b, i)), 27n) * Q1 + Q4); i += 8; }
    if (i + 4 <= len) { h = u(rot64(h ^ u(BigInt(readUint32LE(b, i)) * Q1), 23n) * Q2 + Q3); i += 4; }
    while (i < len) { h = u(rot64(h ^ u(BigInt(b[i++]) * Q5), 11n) * Q1); }
    h ^= h >> 33n; h = u(h * Q2); h ^= h >> 29n; h = u(h * Q3); return h ^ h >> 32n;
}
