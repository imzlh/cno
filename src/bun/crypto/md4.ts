/**
 * MD4 (RFC 1320). The native crypto binding has no MD4, so `Bun.MD4` uses this
 * one-shot implementation. It is checked against the RFC vectors and Bun's output.
 */

const ROUND2_ORDER = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
const ROUND3_ORDER = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
const SHIFTS_1 = [3, 7, 11, 19];
const SHIFTS_2 = [3, 5, 9, 13];
const SHIFTS_3 = [3, 9, 11, 15];

function rotateLeft(value: number, shift: number): number {
    return (value << shift) | (value >>> (32 - shift));
}

export function md4(data: Uint8Array): Uint8Array<ArrayBuffer> {
    const paddedLength = Math.ceil((data.byteLength + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(data);
    padded[data.byteLength] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, (data.byteLength * 8) % 2 ** 32, true);
    view.setUint32(paddedLength - 4, Math.floor(data.byteLength / 2 ** 29), true);

    let a0 = 0x67452301 | 0;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476 | 0;
    const x = new Int32Array(16);

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let i = 0; i < 16; i++) x[i] = view.getInt32(offset + i * 4, true);
        let a = a0, b = b0, c = c0, d = d0;

        // Each step computes a new `a`, then the roles rotate: (a, b, c, d) -> (d, new, b, c).
        for (let i = 0; i < 16; i++) {
            const t = rotateLeft((a + ((b & c) | (~b & d)) + x[i]) | 0, SHIFTS_1[i & 3]);
            a = d; d = c; c = b; b = t;
        }
        for (let i = 0; i < 16; i++) {
            const t = rotateLeft((a + ((b & c) | (b & d) | (c & d)) + x[ROUND2_ORDER[i]] + 0x5a827999) | 0, SHIFTS_2[i & 3]);
            a = d; d = c; c = b; b = t;
        }
        for (let i = 0; i < 16; i++) {
            const t = rotateLeft((a + (b ^ c ^ d) + x[ROUND3_ORDER[i]] + 0x6ed9eba1) | 0, SHIFTS_3[i & 3]);
            a = d; d = c; c = b; b = t;
        }

        a0 = (a0 + a) | 0;
        b0 = (b0 + b) | 0;
        c0 = (c0 + c) | 0;
        d0 = (d0 + d) | 0;
    }

    const digest = new Uint8Array(16);
    const out = new DataView(digest.buffer);
    out.setInt32(0, a0, true);
    out.setInt32(4, b0, true);
    out.setInt32(8, c0, true);
    out.setInt32(12, d0, true);
    return digest;
}
