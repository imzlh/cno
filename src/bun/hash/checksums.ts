import { hashInputBytes, seed32, type HashInput } from './input';

const ADLER_BASE = 65_521;
const ADLER_NMAX = 5_552;

export function adler32(data: HashInput): number {
    const bytes = hashInputBytes(data);
    let a = 1;
    let b = 0;
    let offset = 0;

    // Periodic reduction keeps both sums within exact integer arithmetic.
    while (offset < bytes.length) {
        const end = Math.min(offset + ADLER_NMAX, bytes.length);
        while (offset < end) {
            a += bytes[offset++];
            b += a;
        }
        a %= ADLER_BASE;
        b %= ADLER_BASE;
    }
    return ((b << 16) | a) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
    }
    CRC32_TABLE[value] = crc >>> 0;
}

export function crc32(data: HashInput, seed?: number): number {
    const bytes = hashInputBytes(data);
    let crc = (seed32(seed) ^ 0xffff_ffff) >>> 0;
    for (let index = 0; index < bytes.length; index++) {
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]) & 0xff];
    }
    return (crc ^ 0xffff_ffff) >>> 0;
}
