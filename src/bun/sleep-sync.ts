const os = import.meta.use('os');

export function sleepSync(milliseconds: number): void {
    if (typeof milliseconds !== 'number') {
        throw new TypeError("Expected milliseconds to be a number for 'sleepSync'.");
    }

    // Bun truncates fractional milliseconds and saturates to a signed 32-bit integer.
    const duration = Number.isNaN(milliseconds)
        ? 0
        : Math.max(-2147483648, Math.min(2147483647, Math.trunc(milliseconds)));
    if (duration < 0) {
        throw new TypeError(`argument to sleepSync must not be negative, got ${duration}`);
    }
    os.sleep(duration);
}
