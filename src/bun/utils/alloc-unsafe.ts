/**
 * Bun.allocUnsafe(size) equivalent that returns a fresh Uint8Array.
 *
 * Native Bun may return uninitialized memory. JavaScript cannot obtain that
 * safely, because reading it can expose data from other allocations. This
 * implementation always zero-fills, so callers never see stale bytes. The
 * only observable difference is the content of the buffer. It is never pooled,
 * so every call returns a distinct, independently owned buffer.
 */
export function allocUnsafe(size: number): Uint8Array {
    if (typeof size !== 'number' || !Number.isSafeInteger(size)) {
        throw new TypeError('Expected size to be a safe integer');
    }
    if (size < 0) throw new RangeError('Expected size to be non-negative');
    return new Uint8Array(size);
}
