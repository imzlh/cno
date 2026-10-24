const os = import.meta.use('os');

/**
 * Reads an environment variable, mapping the missing-variable error to
 * `undefined`. The host throws ENOENT rather than returning null.
 */
export function getEnv(name: string): string | undefined {
    try {
        return os.getenv(name);
    } catch {
        return undefined;
    }
}
