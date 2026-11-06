/**
 * Nanoseconds elapsed since process start, as an integer Number.
 * Backed by the original performance.now(), so later global overrides cannot
 * replace the monotonic clock. Values above 2^53 ns (about 104 days) lose
 * integer exactness.
 */
const performanceNow = globalThis.performance.now.bind(globalThis.performance);
const floor = Math.floor;

export const nanoseconds = (): number => floor(performanceNow() * 1_000_000);
