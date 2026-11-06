const engine = import.meta.use('engine');

export type PeekStatus = 'fulfilled' | 'pending' | 'rejected';

interface PromiseRead {
    status: PeekStatus;
    value: unknown;
}

let nativeConsole: { inspect(value: unknown): string } | undefined;

/**
 * Reads a value's settled state synchronously. Non-promises and fulfilled
 * promises report their value, pending promises report the promise itself, and
 * rejected promises report the rejection reason.
 */
function read(value: unknown): PromiseRead {
    if (!engine.isPromise(value)) return { status: 'fulfilled', value };

    let result: unknown;
    try {
        result = engine.promiseResult(value as Promise<unknown>);
    } catch (reason) {
        return { status: 'rejected', value: reason };
    }
    if (result !== null) return { status: 'fulfilled', value: result };

    // promiseResult returns null for both pending and fulfilled-with-null.
    // The native inspector prints `<pending>` only for the pending case.
    nativeConsole ??= import.meta.use('console') as { inspect(value: unknown): string };
    return String(nativeConsole.inspect(value)).includes('<pending>')
        ? { status: 'pending', value }
        : { status: 'fulfilled', value: null };
}

const peekValue = (value: unknown): unknown => read(value).value;

const peekStatus = (value: unknown): PeekStatus => read(value).status;

// Arrow functions match Bun's non-constructable native functions.
Object.defineProperty(peekStatus, 'name', { value: '' });
export const peek = Object.defineProperties(peekValue, {
    name: { value: '' },
    status: { value: peekStatus, enumerable: true, writable: false, configurable: false },
}) as typeof peekValue & { readonly status: typeof peekStatus };
