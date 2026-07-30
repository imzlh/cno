/**
 * Shared buffer utilities for Node.js polyfill modules.
 * Consolidates duplicate concatChunks implementations.
 */

const algorithm = import.meta.use('algorithm');

export function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    const out = new Uint8Array(buffer);
    out.set(bytes);
    return out;
}

export function arrayBufferBackedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (bytes.buffer instanceof ArrayBuffer) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return toOwnedBytes(bytes);
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
    return arrayBufferBackedBytes(algorithm.bytesConcat(chunks));
}

export function viewToUint8Array(view: ArrayBufferView): Uint8Array<ArrayBuffer> {
    if (view.buffer instanceof ArrayBuffer) return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}
