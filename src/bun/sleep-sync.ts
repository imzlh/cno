const os = import.meta.use('os');

function invalidArgument(message: string): TypeError & { code: string } {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

export function sleepSync(milliseconds: number): void {
    if (typeof milliseconds !== 'number') {
        throw invalidArgument('milliseconds must be a number');
    }

    // Bun truncates fractional milliseconds and saturates to a signed 32-bit integer.
    const duration = Number.isNaN(milliseconds)
        ? 0
        : Math.max(-2147483648, Math.min(2147483647, Math.trunc(milliseconds)));
    if (duration < 0) {
        throw invalidArgument(`argument to sleepSync must not be negative, got ${duration}`);
    }
    os.sleep(duration);
}
