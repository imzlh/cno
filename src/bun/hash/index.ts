import { hashInputBytes, seed32, seed64, type HashInput } from './input';

const algo = import.meta.use('algorithm');
const zlib = import.meta.use('zlib');

type OfficialHash = typeof import('bun').hash;
export type BunHash = ((...args: Parameters<OfficialHash>) => ReturnType<OfficialHash>)
    & Pick<OfficialHash,
        | 'wyhash' | 'adler32' | 'crc32' | 'cityHash32' | 'cityHash64'
        | 'xxHash32' | 'xxHash64' | 'murmur32v2' | 'murmur64v2' | 'murmur32v3'>;

/** Zig's Wyhash-compatible implementation used by Bun.hash. */
export const wyhash = (data: HashInput, seed: bigint | undefined = undefined): bigint => {
    return algo.wyhash(hashInputBytes(data), seed64(seed));
};

export const adler32 = (data: HashInput): number => {
    return zlib.adler32(hashInputBytes(data));
};

export const crc32 = (data: HashInput, seed: number | undefined = undefined): number => {
    return zlib.crc32(hashInputBytes(data), seed32(seed));
};

export const cityHash32 = (data: HashInput): number => {
    return algo.cityHash32(hashInputBytes(data));
};

export const cityHash64 = (data: HashInput, seed: bigint | undefined = undefined): bigint => {
    return algo.cityHash64(hashInputBytes(data), seed64(seed));
};

export const xxHash32 = (data: HashInput, seed: number | undefined = undefined): number => {
    return algo.xxHash32(hashInputBytes(data), seed32(seed));
};

export const xxHash64 = (data: HashInput, seed: bigint | undefined = undefined): bigint => {
    return algo.xxHash64(hashInputBytes(data), seed64(seed));
};

export const murmur32v2 = (data: HashInput, seed: number | undefined = undefined): number => {
    return algo.murmur32v2(hashInputBytes(data), seed32(seed));
};

export const murmur64v2 = (data: HashInput, seed: bigint | undefined = undefined): bigint => {
    return algo.murmur64v2(hashInputBytes(data), seed64(seed));
};

export const murmur32v3 = (data: HashInput, seed: number | undefined = undefined): number => {
    return algo.murmur3(hashInputBytes(data), seed32(seed));
};

const hash = (data: HashInput, seed: number | bigint | undefined = undefined): bigint => {
    return wyhash(data, seed as bigint | undefined);
};

Object.defineProperties(hash, {
    wyhash: { configurable: true, enumerable: true, value: wyhash, writable: true },
    adler32: { configurable: true, enumerable: true, value: adler32, writable: true },
    crc32: { configurable: true, enumerable: true, value: crc32, writable: true },
    cityHash32: { configurable: true, enumerable: true, value: cityHash32, writable: true },
    cityHash64: { configurable: true, enumerable: true, value: cityHash64, writable: true },
    xxHash32: { configurable: true, enumerable: true, value: xxHash32, writable: true },
    xxHash64: { configurable: true, enumerable: true, value: xxHash64, writable: true },
    murmur32v2: { configurable: true, enumerable: true, value: murmur32v2, writable: true },
    murmur32v3: { configurable: true, enumerable: true, value: murmur32v3, writable: true },
    murmur64v2: { configurable: true, enumerable: true, value: murmur64v2, writable: true },
});

export type { HashInput };
export const bunHash = hash as BunHash;
export default bunHash;
