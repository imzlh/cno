/**
 * BLAKE2b (RFC 7693) with a configurable digest length and optional key.
 * The native crypto binding only exposes the fixed 512-bit one-shot digest,
 * so `blake2b256` and Bun's keyed-blake2b256 mode run here. Checked against
 * the RFC 7693 appendix vectors and node's blake2b512.
 *
 * 64-bit words are carried as little-endian uint32 pairs: word w lives at
 * indices 2w (low) and 2w+1 (high) of `state`, `v`, and `m`.
 */

const IV = new Uint32Array([
    0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85,
    0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
    0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
    0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

// 10 rows; round r uses row r % 10.
const SIGMA = new Uint8Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
    11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
    7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
    9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
    2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
    12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
    13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
    6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
    10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
]);

const BLOCK_BYTES = 128;
const WORD32 = 2 ** 32;

/** v[a] += v[b] + (xl | xh << 32), mod 2^64. */
function add64(v: Uint32Array, a: number, b: number, xl: number, xh: number): void {
    const al = 2 * a;
    const sum = v[al]! + v[2 * b]! + xl; // < 3 * 2^32, exact as a JS number
    v[al] = sum >>> 0;
    v[al + 1] = (v[al + 1]! + v[2 * b + 1]! + xh + Math.floor(sum / WORD32)) >>> 0;
}

/** v[w] = ROTR64(v[w] ^ v[o], shift). */
function xorRotateRight(v: Uint32Array, w: number, o: number, shift: number): void {
    const wl = 2 * w;
    const ol = 2 * o;
    let lo = v[wl]! ^ v[ol]!;
    let hi = v[wl + 1]! ^ v[ol + 1]!;
    if (shift >= 32) {
        // Rotating by 32 swaps the halves; compose for shifts beyond that.
        const swap = lo;
        lo = hi;
        hi = swap;
        shift -= 32;
        if (shift === 0) {
            v[wl] = lo;
            v[wl + 1] = hi;
            return;
        }
    }
    const right = 32 - shift;
    v[wl] = ((hi << right) | (lo >>> shift)) >>> 0;
    v[wl + 1] = ((lo << right) | (hi >>> shift)) >>> 0;
}

/** One BLAKE2b G mixing step over 64-bit lanes. */
function mix(
    v: Uint32Array,
    a: number, b: number, c: number, d: number,
    xl: number, xh: number, yl: number, yh: number,
): void {
    add64(v, a, b, xl, xh);
    xorRotateRight(v, d, a, 32);
    add64(v, c, d, 0, 0);
    xorRotateRight(v, b, c, 24);
    add64(v, a, b, yl, yh);
    xorRotateRight(v, d, a, 16);
    add64(v, c, d, 0, 0);
    xorRotateRight(v, b, c, 63);
}

function compress(
    state: Uint32Array,
    v: Uint32Array,
    m: Uint32Array,
    block: DataView,
    counter: number,
    last: boolean,
): void {
    for (let i = 0; i < 16; i++) {
        m[2 * i] = block.getUint32(i * 8, true);
        m[2 * i + 1] = block.getUint32(i * 8 + 4, true);
    }
    // v = h || IV with the 64-bit words laid out as uint32 pairs.
    for (let i = 0; i < 16; i++) {
        v[i] = state[i];
        v[i + 16] = IV[i];
    }
    // v[12] ^= t (low half at index 24, high half at 25); v[13] stays zero.
    v[24] ^= counter % WORD32;
    v[25] ^= Math.floor(counter / WORD32);
    if (last) {
        v[28] = ~v[28]!;
        v[29] = ~v[29]!;
    }

    for (let round = 0; round < 12; round++) {
        const s = (round % 10) * 16;
        const w = (i: number): number => SIGMA[s + i]!;
        mix(v, 0, 4, 8, 12, m[2 * w(0)]!, m[2 * w(0) + 1]!, m[2 * w(1)]!, m[2 * w(1) + 1]!);
        mix(v, 1, 5, 9, 13, m[2 * w(2)]!, m[2 * w(2) + 1]!, m[2 * w(3)]!, m[2 * w(3) + 1]!);
        mix(v, 2, 6, 10, 14, m[2 * w(4)]!, m[2 * w(4) + 1]!, m[2 * w(5)]!, m[2 * w(5) + 1]!);
        mix(v, 3, 7, 11, 15, m[2 * w(6)]!, m[2 * w(6) + 1]!, m[2 * w(7)]!, m[2 * w(7) + 1]!);
        mix(v, 0, 5, 10, 15, m[2 * w(8)]!, m[2 * w(8) + 1]!, m[2 * w(9)]!, m[2 * w(9) + 1]!);
        mix(v, 1, 6, 11, 12, m[2 * w(10)]!, m[2 * w(10) + 1]!, m[2 * w(11)]!, m[2 * w(11) + 1]!);
        mix(v, 2, 7, 8, 13, m[2 * w(12)]!, m[2 * w(12) + 1]!, m[2 * w(13)]!, m[2 * w(13) + 1]!);
        mix(v, 3, 4, 9, 14, m[2 * w(14)]!, m[2 * w(14) + 1]!, m[2 * w(15)]!, m[2 * w(15) + 1]!);
    }

    for (let i = 0; i < 16; i++) state[i] ^= v[i] ^ v[i + 16];
}

/**
 * One-shot keyed or unkeyed BLAKE2b. The byte counter includes the padded key
 * block, matching the reference implementation.
 */
export function blake2b(
    digestLength: number,
    data: Uint8Array,
    key?: Uint8Array,
): Uint8Array<ArrayBuffer> {
    if (!Number.isInteger(digestLength) || digestLength < 1 || digestLength > 64) {
        throw new RangeError('blake2b digest length must be an integer from 1 to 64');
    }
    const keyLength = key?.byteLength ?? 0;
    if (keyLength > 64) throw new RangeError('blake2b key must be at most 64 bytes');
    // RFC 7693 allows kk=0: an explicitly empty key must hash like no key.
    const keyedKey = keyLength > 0 ? key : undefined;

    const state = new Uint32Array(IV);
    // Parameter block: digest_length | key_length | fanout=1 | depth=1.
    state[0] ^= 0x01010000 | (keyLength << 8) | digestLength;

    const v = new Uint32Array(32);
    const m = new Uint32Array(32);
    const blockBytes = new Uint8Array(BLOCK_BYTES);
    const block = new DataView(blockBytes.buffer);

    const total = data.byteLength;
    let counter = 0;
    if (keyedKey && total > 0) {
        blockBytes.set(keyedKey);
        compress(state, v, m, block, BLOCK_BYTES, false);
    }

    let offset = 0;
    while (total - offset > BLOCK_BYTES) {
        blockBytes.set(data.subarray(offset, offset + BLOCK_BYTES));
        compress(state, v, m, block, (keyedKey ? BLOCK_BYTES : 0) + offset + BLOCK_BYTES, false);
        offset += BLOCK_BYTES;
    }

    // The scratch may hold an earlier block; the final block is zero-padded.
    // Reference semantics: with a key and no message, the padded key block
    // itself is the one and only (final) compressed block.
    blockBytes.fill(0);
    blockBytes.set(total === 0 && keyedKey ? keyedKey : data.subarray(offset));
    counter = (keyedKey ? BLOCK_BYTES : 0) + total;
    compress(state, v, m, block, counter, true);

    const digest = new Uint8Array(digestLength);
    const out = new DataView(digest.buffer);
    for (let i = 0; i < digestLength; i++) {
        out.setUint8(i, (state[i >> 2]! >>> ((i & 3) * 8)) & 0xff);
    }
    return digest;
}

/** BLAKE2b-256, the algorithm Bun exposes as `CryptoHasher("blake2b256")`. */
export function blake2b256(data: Uint8Array, key?: Uint8Array): Uint8Array<ArrayBuffer> {
    return blake2b(32, data, key);
}
