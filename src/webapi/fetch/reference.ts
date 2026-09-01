export function clearReferenceIfCurrent<T>(current: T | null, expected: T): T | null {
    return current === expected ? null : current;
}
