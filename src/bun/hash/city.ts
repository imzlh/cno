import { hashInputBytes, readUint32LE, readUint64LE, seed64, type HashInput } from './input';

const MASK64 = 0xffff_ffff_ffff_ffffn;
const K0 = 0xc3a5_c85c_97cb_3127n;
const K1 = 0xb492_b66f_be98_f273n;
const K2 = 0x9ae1_6a3b_2f90_404fn;
const C1 = 0xcc9e_2d51;
const C2 = 0x1b87_3593;

function uint64(value: bigint): bigint {
    return value & MASK64;
}

function rotate32(value: number, shift: number): number {
    return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

function rotate64(value: bigint, shift: number): bigint {
    const unsigned = uint64(value);
    return shift === 0 ? unsigned : uint64((unsigned >> BigInt(shift)) | (unsigned << BigInt(64 - shift)));
}

function multiply32(left: number, right: number): number {
    return Math.imul(left, right) >>> 0;
}

function fmix(value: number): number {
    value ^= value >>> 16;
    value = multiply32(value, 0x85eb_ca6b);
    value ^= value >>> 13;
    value = multiply32(value, 0xc2b2_ae35);
    value ^= value >>> 16;
    return value >>> 0;
}

function mur(value: number, hash: number): number {
    value = multiply32(value, C1);
    value = rotate32(value, 17);
    value = multiply32(value, C2);
    hash = (hash ^ value) >>> 0;
    hash = rotate32(hash, 19);
    return (multiply32(hash, 5) + 0xe654_6b64) >>> 0;
}

function city32Length0To4(bytes: Uint8Array): number {
    let b = 0;
    let c = 9;
    for (const byte of bytes) {
        const signedByte = byte < 128 ? byte : byte - 256;
        b = (multiply32(b, C1) + signedByte) >>> 0;
        c = (c ^ b) >>> 0;
    }
    return fmix(mur(b, mur(bytes.length, c)));
}

function city32Length5To12(bytes: Uint8Array): number {
    const length = bytes.length;
    let a = length;
    let b = length * 5;
    let c = 9;
    const d = b;
    a = (a + readUint32LE(bytes, 0)) >>> 0;
    b = (b + readUint32LE(bytes, length - 4)) >>> 0;
    c = (c + readUint32LE(bytes, (length >> 1) & 4)) >>> 0;
    return fmix(mur(c, mur(b, mur(a, d))));
}

function city32Length13To24(bytes: Uint8Array): number {
    const length = bytes.length;
    const a = readUint32LE(bytes, (length >> 1) - 4);
    const b = readUint32LE(bytes, 4);
    const c = readUint32LE(bytes, length - 8);
    const d = readUint32LE(bytes, length >> 1);
    const e = readUint32LE(bytes, 0);
    const f = readUint32LE(bytes, length - 4);
    return fmix(mur(f, mur(e, mur(d, mur(c, mur(b, mur(a, length)))))));
}

export function cityHash32(data: HashInput): number {
    const bytes = hashInputBytes(data);
    const length = bytes.length;
    if (length <= 24) {
        if (length <= 4) return city32Length0To4(bytes);
        return length <= 12 ? city32Length5To12(bytes) : city32Length13To24(bytes);
    }

    let hash = length >>> 0;
    let g = multiply32(C1, length);
    let f = g;
    const a0 = multiply32(rotate32(multiply32(readUint32LE(bytes, length - 4), C1), 17), C2);
    const a1 = multiply32(rotate32(multiply32(readUint32LE(bytes, length - 8), C1), 17), C2);
    const a2 = multiply32(rotate32(multiply32(readUint32LE(bytes, length - 16), C1), 17), C2);
    const a3 = multiply32(rotate32(multiply32(readUint32LE(bytes, length - 12), C1), 17), C2);
    const a4 = multiply32(rotate32(multiply32(readUint32LE(bytes, length - 20), C1), 17), C2);

    hash ^= a0;
    hash = (multiply32(rotate32(hash, 19), 5) + 0xe654_6b64) >>> 0;
    hash ^= a2;
    hash = (multiply32(rotate32(hash, 19), 5) + 0xe654_6b64) >>> 0;
    g ^= a1;
    g = (multiply32(rotate32(g, 19), 5) + 0xe654_6b64) >>> 0;
    g ^= a3;
    g = (multiply32(rotate32(g, 19), 5) + 0xe654_6b64) >>> 0;
    f = (f + a4) >>> 0;
    f = (multiply32(rotate32(f, 19), 5) + 0xe654_6b64) >>> 0;

    let offset = 0;
    let iterations = Math.floor((length - 1) / 20);
    do {
        const x0 = multiply32(rotate32(multiply32(readUint32LE(bytes, offset), C1), 17), C2);
        const x1 = readUint32LE(bytes, offset + 4);
        const x2 = multiply32(rotate32(multiply32(readUint32LE(bytes, offset + 8), C1), 17), C2);
        const x3 = multiply32(rotate32(multiply32(readUint32LE(bytes, offset + 12), C1), 17), C2);
        const x4 = readUint32LE(bytes, offset + 16);
        hash ^= x0;
        hash = (multiply32(rotate32(hash, 18), 5) + 0xe654_6b64) >>> 0;
        f = multiply32(rotate32((f + x1) >>> 0, 19), C1);
        g = (g + x2) >>> 0;
        g = (multiply32(rotate32(g, 18), 5) + 0xe654_6b64) >>> 0;
        hash ^= (x3 + x1) >>> 0;
        hash = (multiply32(rotate32(hash, 19), 5) + 0xe654_6b64) >>> 0;
        g ^= x4;
        g = multiply32(g >>> 24 | (g >>> 8 & 0xff00) | (g << 8 & 0xff0000) | g << 24, 5);
        hash = ((hash + multiply32(x4, 5)) >>> 24 | ((hash + multiply32(x4, 5)) >>> 8 & 0xff00)
            | ((hash + multiply32(x4, 5)) << 8 & 0xff0000) | ((hash + multiply32(x4, 5)) << 24)) >>> 0;
        f = (f + x0) >>> 0;
        [f, hash, g] = [g, f, hash];
        offset += 20;
    } while (--iterations !== 0);

    g = multiply32(rotate32(g, 11), C1);
    g = multiply32(rotate32(g, 17), C1);
    f = multiply32(rotate32(f, 11), C1);
    f = multiply32(rotate32(f, 17), C1);
    hash = (multiply32(rotate32((hash + g) >>> 0, 19), 5) + 0xe654_6b64) >>> 0;
    hash = multiply32(rotate32(hash, 17), C1);
    hash = (multiply32(rotate32((hash + f) >>> 0, 19), 5) + 0xe654_6b64) >>> 0;
    return multiply32(rotate32(hash, 17), C1);
}

function shiftMix(value: bigint): bigint {
    return value ^ (value >> 47n);
}

function hashLen16(left: bigint, right: bigint, multiplier = 0x9ddf_ea08_eb38_2d69n): bigint {
    let a = uint64((left ^ right) * multiplier);
    a ^= a >> 47n;
    let b = uint64((right ^ a) * multiplier);
    b ^= b >> 47n;
    return uint64(b * multiplier);
}

function hashLength0To16(bytes: Uint8Array): bigint {
    const length = bytes.length;
    if (length >= 8) {
        const multiplier = uint64(K2 + BigInt(length * 2));
        const a = uint64(readUint64LE(bytes, 0) + K2);
        const b = readUint64LE(bytes, length - 8);
        const c = uint64(rotate64(b, 37) * multiplier + a);
        const d = uint64((rotate64(a, 25) + b) * multiplier);
        return hashLen16(c, d, multiplier);
    }
    if (length >= 4) {
        const multiplier = uint64(K2 + BigInt(length * 2));
        const a = BigInt(readUint32LE(bytes, 0));
        return hashLen16(BigInt(length) + (a << 3n), BigInt(readUint32LE(bytes, length - 4)), multiplier);
    }
    if (length > 0) {
        const y = BigInt(bytes[0] + (bytes[length >> 1] << 8));
        const z = BigInt(length + (bytes[length - 1] << 2));
        return uint64(shiftMix(uint64(y * K2) ^ uint64(z * K0)) * K2);
    }
    return K2;
}

function hashLength17To32(bytes: Uint8Array): bigint {
    const length = bytes.length;
    const multiplier = uint64(K2 + BigInt(length * 2));
    const a = uint64(readUint64LE(bytes, 0) * K1);
    const b = readUint64LE(bytes, 8);
    const c = uint64(readUint64LE(bytes, length - 8) * multiplier);
    const d = uint64(readUint64LE(bytes, length - 16) * K2);
    return hashLen16(
        uint64(rotate64(a + b, 43) + rotate64(c, 30) + d),
        uint64(a + rotate64(b + K2, 18) + c),
        multiplier,
    );
}

function weakHash32(bytes: Uint8Array, offset: number, a: bigint, b: bigint): [bigint, bigint] {
    const w = readUint64LE(bytes, offset);
    const x = readUint64LE(bytes, offset + 8);
    const y = readUint64LE(bytes, offset + 16);
    const z = readUint64LE(bytes, offset + 24);
    a = uint64(a + w);
    b = rotate64(uint64(b + a + z), 21);
    const c = a;
    a = uint64(a + x + y);
    b = uint64(b + rotate64(a, 44));
    return [uint64(a + z), uint64(b + c)];
}

function byteSwap64(value: bigint): bigint {
    let result = 0n;
    for (let i = 0; i < 8; i++) {
        result = (result << 8n) | (value & 0xffn);
        value >>= 8n;
    }
    return result;
}

function hashLength33To64(bytes: Uint8Array): bigint {
    const length = bytes.length;
    const mul = uint64(K2 + BigInt(length * 2));
    let a = uint64(readUint64LE(bytes, 0) * K2);
    let b = readUint64LE(bytes, 8);
    const c = readUint64LE(bytes, length - 24);
    const d = readUint64LE(bytes, length - 32);
    const e = uint64(readUint64LE(bytes, 16) * K2);
    const f = uint64(readUint64LE(bytes, 24) * 9n);
    const g = readUint64LE(bytes, length - 8);
    const h = uint64(readUint64LE(bytes, length - 16) * mul);
    const u = uint64(rotate64(a + g, 43) + (rotate64(b, 30) + c) * 9n);
    const v = uint64((a + g ^ d) + f + 1n);
    const w = uint64(byteSwap64(uint64((u + v) * mul)) + h);
    const x = uint64(rotate64(e + f, 42) + c);
    const y = uint64((byteSwap64(uint64((v + w) * mul)) + g) * mul);
    const z = uint64(e + f + c);
    a = uint64(byteSwap64(uint64((x + z) * mul + y)) + b);
    b = uint64(shiftMix(uint64((z + a) * mul + d + h)) * mul);
    return uint64(b + x);
}

function cityHash64Unseeded(bytes: Uint8Array): bigint {
    const length = bytes.length;
    if (length <= 16) return hashLength0To16(bytes);
    if (length <= 32) return hashLength17To32(bytes);
    if (length <= 64) return hashLength33To64(bytes);

    let x = readUint64LE(bytes, length - 40);
    let y = uint64(readUint64LE(bytes, length - 16) + readUint64LE(bytes, length - 56));
    let z = hashLen16(uint64(readUint64LE(bytes, length - 48) + BigInt(length)), readUint64LE(bytes, length - 24));
    let v = weakHash32(bytes, length - 64, BigInt(length), z);
    let w = weakHash32(bytes, length - 32, uint64(y + K1), x);
    x = uint64(x * K1 + readUint64LE(bytes, 0));
    const end = Math.floor((length - 1) / 64) * 64;
    let offset = 0;
    do {
        x = uint64(rotate64(x + y + v[0] + readUint64LE(bytes, offset + 8), 37) * K1);
        y = uint64(rotate64(y + v[1] + readUint64LE(bytes, offset + 48), 42) * K1);
        x ^= w[1];
        y = uint64(y + v[0] + readUint64LE(bytes, offset + 40));
        z = uint64(rotate64(z + w[0], 33) * K1);
        v = weakHash32(bytes, offset, uint64(v[1] * K1), uint64(x + w[0]));
        w = weakHash32(bytes, offset + 32, uint64(z + w[1]), uint64(y + readUint64LE(bytes, offset + 16)));
        [z, x] = [x, z];
        offset += 64;
    } while (offset !== end);
    return hashLen16(
        uint64(hashLen16(v[0], w[0]) + shiftMix(y) * K1 + z),
        uint64(hashLen16(v[1], w[1]) + x),
    );
}

export function cityHash64(data: HashInput, seed?: bigint): bigint {
    const bytes = hashInputBytes(data);
    return hashLen16(uint64(cityHash64Unseeded(bytes) - K2), seed64(seed));
}
