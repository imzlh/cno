import { hashInputBytes, readUint32LE, readUint64LE, seed64, type HashInput } from './input';

const MASK64 = 0xffff_ffff_ffff_ffffn;
const SECRET0 = BigInt('0xa076' + '1d6478bd642f');
const SECRET1 = BigInt('0xe703' + '7ed1a0b428db');
const SECRET2 = BigInt('0x8ebc' + '6af09c88c6e3');
const SECRET3 = BigInt('0x5899' + '65cc75374cc3');

function uint64(value: bigint): bigint {
    return value & MASK64;
}

function multiply128(left: bigint, right: bigint): [bigint, bigint] {
    const product = uint64(left) * uint64(right);
    return [product & MASK64, product >> 64n];
}

function mix(left: bigint, right: bigint): bigint {
    const [low, high] = multiply128(left, right);
    return low ^ high;
}

function readShort(bytes: Uint8Array): bigint {
    const length = bytes.length;
    return (BigInt(bytes[0]) << 16n)
        | (BigInt(bytes[length >> 1]) << 8n)
        | BigInt(bytes[length - 1]);
}

/** Zig's Wyhash-compatible implementation used by Bun.hash. */
export function wyhash(data: HashInput, seed?: bigint): bigint {
    const bytes = hashInputBytes(data);
    const length = bytes.length;
    let state0 = typeof seed === 'number' && seed < 0 ? 0n : seed64(seed);
    state0 ^= mix(state0 ^ SECRET0, SECRET1);
    let a: bigint;
    let b: bigint;

    if (length <= 16) {
        if (length >= 4) {
            const quarter = (length >> 3) << 2;
            const end = length - 4;
            a = (BigInt(readUint32LE(bytes, 0)) << 32n)
                | BigInt(readUint32LE(bytes, quarter));
            b = (BigInt(readUint32LE(bytes, end)) << 32n)
                | BigInt(readUint32LE(bytes, end - quarter));
        } else if (length > 0) {
            a = readShort(bytes);
            b = 0n;
        } else {
            a = 0n;
            b = 0n;
        }
    } else {
        const state: [bigint, bigint, bigint] = [state0, state0, state0];
        let offset = 0;

        if (length >= 48) {
            while (offset + 48 < length) {
                state[0] = mix(readUint64LE(bytes, offset) ^ SECRET1, readUint64LE(bytes, offset + 8) ^ state[0]);
                state[1] = mix(readUint64LE(bytes, offset + 16) ^ SECRET2, readUint64LE(bytes, offset + 24) ^ state[1]);
                state[2] = mix(readUint64LE(bytes, offset + 32) ^ SECRET3, readUint64LE(bytes, offset + 40) ^ state[2]);
                offset += 48;
            }
            state[0] ^= state[1] ^ state[2];
        }

        let remaining = length - offset;
        while (remaining > 16) {
            state[0] = mix(
                readUint64LE(bytes, offset) ^ SECRET1,
                readUint64LE(bytes, offset + 8) ^ state[0],
            );
            offset += 16;
            remaining -= 16;
        }
        a = readUint64LE(bytes, length - 16);
        b = readUint64LE(bytes, length - 8);
        state0 = state[0];
    }

    a ^= SECRET1;
    b ^= state0;
    [a, b] = multiply128(a, b);
    return mix(a ^ SECRET0 ^ BigInt(length), b ^ SECRET1);
}
