/**
 * CNO compress lib — Compression/decompression
 */

const zlib = import.meta.use('zlib');

const cnoCompress = {
    deflate: (data: Uint8Array | ArrayBuffer, level?: number) => zlib.deflate(data, level),
    inflate: (data: Uint8Array | ArrayBuffer) => zlib.inflate(data),
    gzip: (data: Uint8Array | ArrayBuffer, level?: number) => zlib.gzip(data, level),
    gunzip: (data: Uint8Array | ArrayBuffer) => zlib.gunzip(data),

    createDeflate: (level?: number) => zlib.createDeflate(level),
    createGzip: (level?: number) => zlib.createGzip(level),
    createInflate: () => zlib.createInflate(),
    createGunzip: () => zlib.createGunzip(),

    crc32: (data: Uint8Array | ArrayBuffer, crc?: number) => zlib.crc32(data, crc),
    adler32: (data: Uint8Array | ArrayBuffer, adler?: number) => zlib.adler32(data, adler),

    NO_COMPRESSION: zlib.NO_COMPRESSION,
    BEST_SPEED: zlib.BEST_SPEED,
    BEST_COMPRESSION: zlib.BEST_COMPRESSION,
    DEFAULT_COMPRESSION: zlib.DEFAULT_COMPRESSION,
};

Reflect.set(CNO, 'compress', cnoCompress);
