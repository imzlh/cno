const os = import.meta.use('os');
const mathTrunc = Math.trunc;

function invalidArgument(message: string): TypeError & { code: string } {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

export const sleepSync = (milliseconds: number): void => {
    if (typeof milliseconds !== 'number') {
        throw invalidArgument('milliseconds must be a number');
    }

    // Bun truncates fractional milliseconds and saturates to a signed 32-bit integer.
    const duration = milliseconds !== milliseconds
        ? 0
        : milliseconds <= -2147483648
            ? -2147483648
            : milliseconds >= 2147483647
                ? 2147483647
                : mathTrunc(milliseconds);
    if (duration < 0) {
        throw invalidArgument(`argument to sleepSync must not be negative, got ${duration}`);
    }
    os.sleep(duration);
};
