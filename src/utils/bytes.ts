/**
 * Shared byte utilities.
 */

const algorithm = import.meta.use('algorithm');

export function toOwnedBytes(bytes: globalThis.Uint8Array): globalThis.Uint8Array<ArrayBuffer> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    const out = new globalThis.Uint8Array(buffer);
    out.set(bytes);
    return out;
}

export function arrayBufferBackedBytes(bytes: globalThis.Uint8Array): globalThis.Uint8Array<ArrayBuffer> {
    if (bytes.buffer instanceof ArrayBuffer) {
        return new globalThis.Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return toOwnedBytes(bytes);
}

export function concatChunks(chunks: globalThis.Uint8Array[]): globalThis.Uint8Array<ArrayBuffer> {
    return toOwnedBytes(algorithm.bytesConcat(chunks));
}

export function bytesToArrayBuffer(bytes: globalThis.Uint8Array, byteLength = bytes.byteLength): ArrayBuffer {
    if (bytes.buffer instanceof ArrayBuffer) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + byteLength);
    }
    return toOwnedBytes(bytes.subarray(0, byteLength)).buffer;
}
