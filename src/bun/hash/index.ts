import { adler32, crc32 } from './checksums';
import { cityHash32, cityHash64 } from './city';
import type { HashInput } from './input';
import { murmur32v2, murmur32v3, murmur64v2 } from './murmur';
import { xxHash32, xxHash64 } from './xxhash';
import { wyhash } from './wyhash';

export interface BunHash {
    (data: HashInput, seed?: number | bigint): bigint;
    wyhash(data: HashInput, seed?: bigint): bigint;
    adler32(data: HashInput): number;
    crc32(data: HashInput, seed?: number): number;
    cityHash32(data: HashInput): number;
    cityHash64(data: HashInput, seed?: bigint): bigint;
    xxHash32(data: HashInput, seed?: number): number;
    xxHash64(data: HashInput, seed?: bigint): bigint;
    murmur32v2(data: HashInput, seed?: number): number;
    murmur64v2(data: HashInput, seed?: bigint): bigint;
    murmur32v3(data: HashInput, seed?: number): number;
}

function hash(data: HashInput, seed?: number | bigint): bigint {
    return wyhash(data, seed as bigint | undefined);
}

Object.defineProperties(hash, {
    wyhash: { configurable: true, enumerable: true, value: wyhash, writable: true },
    adler32: { configurable: true, enumerable: true, value: adler32, writable: true },
    crc32: { configurable: true, enumerable: true, value: crc32, writable: true },
    cityHash32: { configurable: true, enumerable: true, value: cityHash32, writable: true },
    cityHash64: { configurable: true, enumerable: true, value: cityHash64, writable: true },
    xxHash32: { configurable: true, enumerable: true, value: xxHash32, writable: true },
    xxHash64: { configurable: true, enumerable: true, value: xxHash64, writable: true },
    murmur32v2: { configurable: true, enumerable: true, value: murmur32v2, writable: true },
    murmur64v2: { configurable: true, enumerable: true, value: murmur64v2, writable: true },
    murmur32v3: { configurable: true, enumerable: true, value: murmur32v3, writable: true },
});

export { adler32, crc32, cityHash32, cityHash64, xxHash32, xxHash64, murmur32v2, murmur32v3, murmur64v2, wyhash };
export type { HashInput };
export const bunHash = hash as BunHash;
export default bunHash;
