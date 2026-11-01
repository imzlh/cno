/**
 * Byte index of the first LF (0x0a) at or after `offset`, or -1 when none exists.
 * Accepts an ArrayBuffer or any ArrayBuffer view, and reads the view's bytes only.
 */
export function indexOfLine(buffer: ArrayBuffer | ArrayBufferView, offset: number = 0): number {
    let bytes: Uint8Array;
    if (ArrayBuffer.isView(buffer)) {
        bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (buffer instanceof ArrayBuffer) {
        bytes = new Uint8Array(buffer);
    } else {
        throw new TypeError('Expected an ArrayBuffer or ArrayBufferView');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new RangeError('Expected offset to be a non-negative safe integer');
    }
    return bytes.indexOf(0x0a, offset);
}
