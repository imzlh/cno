/**
 * Byte index of the first LF (0x0a) at or after `offset`, or -1 when none exists.
 * Accepts an ArrayBuffer or any ArrayBuffer view, and reads the view's bytes only.
 */
export function indexOfLine(buffer: ArrayBufferLike | ArrayBufferView, offset: number | bigint = 0): number {
    let bytes: Uint8Array;
    if (ArrayBuffer.isView(buffer)) {
        bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (
        buffer instanceof ArrayBuffer
        || (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer)
    ) {
        bytes = new Uint8Array(buffer);
    } else {
        throw new TypeError('Expected an ArrayBuffer or ArrayBufferView');
    }
    if (typeof offset === 'bigint') {
        if (offset < 0n) offset = 0;
        else if (offset >= BigInt(bytes.length)) return -1;
        else offset = Number(offset);
    } else {
        offset = Number(offset);
        if (offset === Infinity) return -1;
        if (!Number.isFinite(offset) || offset < 0) offset = 0;
        else offset = Math.trunc(offset);
    }
    return bytes.indexOf(0x0a, offset);
}
