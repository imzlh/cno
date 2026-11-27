const keyObjects = new WeakSet<object>();

export function markKeyObject(value: object): void {
    keyObjects.add(value);
}

export function isKeyObject(value: unknown): value is object {
    return value !== null && typeof value === 'object' && keyObjects.has(value);
}
