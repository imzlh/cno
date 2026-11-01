/**
 * Nanoseconds elapsed since process start, as an integer Number.
 * Backed by performance.now(), so the value is monotonic. Precision is limited
 * by the platform clock, and values above 2^53 ns (about 104 days) lose integer exactness.
 */
export function nanoseconds(): number {
    return Math.floor(performance.now() * 1_000_000);
}
