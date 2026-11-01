import { hashInputBytes, readUint32LE, readUint64LE, seed32, seed64, type HashInput } from './input';

function rotateLeft32(value: number, shift: number): number {
    return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function multiply32(left: number, right: number): number {
    return Math.imul(left, right) >>> 0;
}

export function murmur32v3(data: HashInput, seed?: number): number {
    const bytes = hashInputBytes(data);
    const blockEnd = bytes.length & ~3;
    let hash = seed32(seed);

    for (let offset = 0; offset < blockEnd; offset += 4) {
        let block = readUint32LE(bytes, offset);
        block = multiply32(block, 0xcc9e_2d51);
        block = rotateLeft32(block, 15);
        block = multiply32(block, 0x1b87_3593);
        hash ^= block;
        hash = (multiply32(rotateLeft32(hash, 13), 5) + 0xe654_6b64) >>> 0;
    }

    let tail = 0;
    switch (bytes.length & 3) {
        case 3:
            tail ^= bytes[blockEnd + 2] << 16;
        // falls through
        case 2:
            tail ^= bytes[blockEnd + 1] << 8;
        // falls through
        case 1:
            tail ^= bytes[blockEnd];
            tail = multiply32(tail, 0xcc9e_2d51);
            tail = rotateLeft32(tail, 15);
            tail = multiply32(tail, 0x1b87_3593);
            hash ^= tail;
    }

    hash ^= bytes.length;
    hash ^= hash >>> 16;
    hash = multiply32(hash, 0x85eb_ca6b);
    hash ^= hash >>> 13;
    hash = multiply32(hash, 0xc2b2_ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

export function murmur32v2(data: HashInput, seed?: number): number {
    const bytes = hashInputBytes(data);
    const m = 0x5bd1e995;
    let hash = (seed32(seed) ^ bytes.length) >>> 0;
    let offset = 0;
    for (; offset + 4 <= bytes.length; offset += 4) {
        let k = multiply32(readUint32LE(bytes, offset), m);
        k ^= k >>> 24;
        k = multiply32(k, m);
        hash = multiply32(hash, m) ^ k;
    }
    const remaining = bytes.length - offset;
    if (remaining >= 3) hash ^= bytes[offset + 2] << 16;
    if (remaining >= 2) hash ^= bytes[offset + 1] << 8;
    if (remaining >= 1) hash = multiply32(hash ^ bytes[offset], m);
    hash ^= hash >>> 13;
    hash = multiply32(hash, m);
    return (hash ^ (hash >>> 15)) >>> 0;
}

export function murmur64v2(data: HashInput, seed?: bigint): bigint {
    const bytes = hashInputBytes(data);
    const mask = 0xffff_ffff_ffff_ffffn;
    const m = 0xc6a4_a793_5bd1_e995n;
    let hash = (seed64(seed) ^ (BigInt(bytes.length) * m)) & mask;
    let offset = 0;
    for (; offset + 8 <= bytes.length; offset += 8) {
        let k = (readUint64LE(bytes, offset) * m) & mask;
        k ^= k >> 47n;
        k = (k * m) & mask;
        hash = ((hash ^ k) * m) & mask;
    }
    if (offset < bytes.length) {
        let tail = 0n;
        for (let i = 0; offset + i < bytes.length; i++) tail |= BigInt(bytes[offset + i]) << BigInt(i * 8);
        hash = ((hash ^ tail) * m) & mask;
    }
    hash ^= hash >> 47n;
    hash = (hash * m) & mask;
    return hash ^ (hash >> 47n);
}
