/**
 * Node.js assert module
 */

const console = import.meta.use('console');

export type AssertPredicate = RegExp | (new () => object) | ((thrown: unknown) => boolean) | object | Error;

export interface AssertionErrorOptions {
    message?: string;
    actual?: unknown;
    expected?: unknown;
    operator?: string;
    stackStartFn?: Function;
    diff?: 'simple' | 'full';
    generatedMessage?: boolean;
}

export class AssertionError extends Error {
    actual: unknown;
    expected: unknown;
    generatedMessage: boolean;
    code: 'ERR_ASSERTION' = 'ERR_ASSERTION';
    operator: string;

    constructor(options: AssertionErrorOptions = {}) {
        // Auto-generate a message from actual/operator/expected when none is
        // provided — matches Node.js behaviour (e.g. "1 equal 2", "'deno' match /node/").
        let message = options.message;
        if (message == null && (options.actual !== undefined || options.expected !== undefined)) {
            message = `${console.inspect(options.actual)} ${options.operator || ''} ${console.inspect(options.expected)}`.trim();
        }
        super(message || 'Assertion failed');
        this.name = 'AssertionError';
        this.actual = options.actual;
        this.expected = options.expected;
        this.operator = options.operator || '';
        this.generatedMessage = !options.message;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, options.stackStartFn || AssertionError);
        }
    }
}

function innerOk(fn: Function, argLen: number, value: unknown, message?: string | Error): void {
    if (argLen === 0) {
        throw new AssertionError({
            message: 'No value argument passed to `assert.ok()`',
            generatedMessage: true
        });
    }
    if (!value) {
        throw new AssertionError({
            actual: value,
            expected: true,
            message: typeof message === 'string' ? message : message?.message,
            operator: '==',
            generatedMessage: !message
        });
    }
}

export function ok(value: unknown, message?: string | Error): asserts value {
    innerOk(ok, arguments.length, value, message);
}

export function fail(message?: string | Error): never;
export function fail(actual: unknown, expected: unknown, message?: string | Error, operator?: string): never;
export function fail(actual?: unknown, expected?: unknown, message?: string | Error, operator?: string): never {
    const msg = arguments.length === 1 ? actual : message;
    throw new AssertionError({
        message: typeof msg === 'string' ? msg : (msg as Error)?.message,
        actual: arguments.length > 1 ? actual : undefined,
        expected: arguments.length > 1 ? expected : undefined,
        operator: operator || 'fail',
        generatedMessage: !msg
    });
}

export function equal(actual: unknown, expected: unknown, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }
    if (actual != expected) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: '==',
            generatedMessage: !message
        });
    }
}

export function notEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }
    if (actual == expected) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: '!=',
            generatedMessage: !message
        });
    }
}

export function strictEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }
    if (!Object.is(actual, expected)) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'strictEqual',
            generatedMessage: !message
        });
    }
}

export function notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }
    if (Object.is(actual, expected)) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'notStrictEqual',
            generatedMessage: !message
        });
    }
}

function _deepEqual(actual: unknown, expected: unknown, strict: boolean, skipPrototype: boolean = false, seen?: WeakSet<object>): boolean {
    if (Object.is(actual, expected)) return true;
    if (!strict && actual == expected) return true;
    if (actual === null || expected === null) return false;
    if (typeof actual !== 'object' && typeof expected !== 'object') {
        return strict ? Object.is(actual, expected) : actual == expected;
    }
    if (typeof actual !== 'object' || typeof expected !== 'object') return false;

    // Boxed primitives (Number/Boolean/String) — compare their primitive values
    // via `valueOf()`. Without this, `new Number(1)` and `new Number(2)` would
    // appear equal because Object.keys() returns [] for both.
    if (actual instanceof Number && expected instanceof Number) {
        return Object.is(actual.valueOf(), expected.valueOf());
    }
    if (actual instanceof Boolean && expected instanceof Boolean) {
        return Object.is(actual.valueOf(), expected.valueOf());
    }
    if (actual instanceof String && expected instanceof String) {
        return Object.is(actual.valueOf(), expected.valueOf());
    }

    // Circular reference protection
    const _seen = seen ?? new WeakSet();
    if (_seen.has(actual as object) && _seen.has(expected as object)) return true;
    _seen.add(actual as object);
    _seen.add(expected as object);

    if (!skipPrototype && Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) {
        return false;
    }

    if (actual instanceof Date && expected instanceof Date) {
        return actual.getTime() === expected.getTime();
    }
    if (actual instanceof RegExp && expected instanceof RegExp) {
        return actual.source === expected.source && actual.flags === expected.flags;
    }
    if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
        if (actual.byteLength !== expected.byteLength) return false;
        const actualView = new Uint8Array(actual.buffer as ArrayBuffer, actual.byteOffset, actual.byteLength);
        const expectedView = new Uint8Array(expected.buffer as ArrayBuffer, expected.byteOffset, expected.byteLength);
        for (let i = 0; i < actualView.length; i++) {
            if (actualView[i] !== expectedView[i]) return false;
        }
        return true;
    }
    if (actual instanceof Map && expected instanceof Map) {
        if (actual.size !== expected.size) return false;
        for (const [key, value] of actual) {
            if (!expected.has(key) || !_deepEqual(value, expected.get(key), strict, skipPrototype, _seen)) return false;
        }
        return true;
    }
    if (actual instanceof Set && expected instanceof Set) {
        if (actual.size !== expected.size) return false;
        for (const value of actual) {
            // .has() uses reference equality, so use _deepEqual for objects
            let found = false;
            for (const expVal of expected) {
                if (_deepEqual(value, expVal, strict, skipPrototype, _seen)) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }
    if (Array.isArray(actual) !== Array.isArray(expected)) return false;

    const actualKeys = Object.keys(actual as object);
    const expectedKeys = Object.keys(expected as object);
    if (actualKeys.length !== expectedKeys.length) return false;

    for (const key of actualKeys) {
        if (!Object.prototype.hasOwnProperty.call(expected, key)) return false;
        if (!_deepEqual((actual as any)[key], (expected as any)[key], strict, skipPrototype, _seen)) return false;
    }

    if (strict) {
        const actualSymbols = Object.getOwnPropertySymbols(actual as object);
        const expectedSymbols = Object.getOwnPropertySymbols(expected as object);
        if (actualSymbols.length !== expectedSymbols.length) return false;
        for (const sym of actualSymbols) {
            if (!Object.prototype.hasOwnProperty.call(expected, sym)) return false;
            if (!_deepEqual((actual as any)[sym], (expected as any)[sym], strict, skipPrototype, _seen)) return false;
        }
    }
    return true;
}

export function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }
    if (!_deepEqual(actual, expected, false)) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'deepEqual',
            generatedMessage: !message
        });
    }
}

export function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }
    if (_deepEqual(actual, expected, false)) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'notDeepEqual',
            generatedMessage: !message
        });
    }
}

export function deepStrictEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }
    if (!_deepEqual(actual, expected, true)) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'deepStrictEqual',
            generatedMessage: !message
        });
    }
}

export function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }
    if (_deepEqual(actual, expected, true)) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'notDeepStrictEqual',
            generatedMessage: !message
        });
    }
}

function _checkError(err: unknown, error: AssertPredicate, message?: string | Error): void {
    if (typeof error === 'function') {
        if (error === Error || error.prototype instanceof Error) {
            if (!(err instanceof error)) {
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: typeof message === 'string' ? message : message?.message,
                    operator: 'throws',
                    generatedMessage: !message
                });
            }
        } else {
            if (!(error as (thrown: unknown) => boolean)(err)) {
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: typeof message === 'string' ? message : message?.message,
                    operator: 'throws',
                    generatedMessage: !message
                });
            }
        }
    } else if (error instanceof RegExp) {
        if (typeof err !== 'object' || err === null) {
            throw new AssertionError({
                actual: err,
                expected: error,
                message: typeof message === 'string' ? message : message?.message,
                operator: 'throws',
                generatedMessage: !message
            });
        }
        const str = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (!error.test(str)) {
            throw new AssertionError({
                actual: err,
                expected: error,
                message: typeof message === 'string' ? message : message?.message,
                operator: 'throws',
                generatedMessage: !message
            });
        }
    } else if (typeof error === 'object' && error !== null) {
        const keys = Object.keys(error);
        for (const key of keys) {
            const actualValue = (err as any)[key];
            const expectedValue = (error as any)[key];
            if (expectedValue instanceof RegExp) {
                if (typeof actualValue !== 'string' || !expectedValue.test(actualValue)) {
                    throw new AssertionError({
                        actual: err,
                        expected: error,
                        message: typeof message === 'string' ? message : message?.message,
                        operator: 'throws',
                        generatedMessage: !message
                    });
                }
            } else if (!_deepEqual(actualValue, expectedValue, true)) {
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: typeof message === 'string' ? message : message?.message,
                    operator: 'throws',
                    generatedMessage: !message
                });
            }
        }
    }
}

export function throws(block: () => unknown, message?: string | Error): void;
export function throws(block: () => unknown, error: AssertPredicate, message?: string | Error): void;
export function throws(block: () => unknown, error?: AssertPredicate | string | Error, message?: string | Error): void {
    if (typeof block !== 'function') {
        throw new AssertionError({
            message: 'The "block" argument must be of type function',
            generatedMessage: true
        });
    }

    let err: unknown;
    let threw = false;

    try {
        block();
    } catch (e) {
        threw = true;
        err = e;
    }

    if (!threw) {
        const msg = typeof error === 'string' || error instanceof Error ? error : message;
        throw new AssertionError({
            message: typeof msg === 'string' ? msg : msg?.message || 'Missing expected exception',
            operator: 'throws',
            generatedMessage: !msg
        });
    }

    if (error !== undefined && typeof error !== 'string' && !(error instanceof Error)) {
        _checkError(err, error, message);
    }
}

export function doesNotThrow(block: () => unknown, message?: string | Error): void;
export function doesNotThrow(block: () => unknown, error: AssertPredicate, message?: string | Error): void;
export function doesNotThrow(block: () => unknown, error?: AssertPredicate | string | Error, message?: string | Error): void {
    if (typeof block !== 'function') {
        throw new AssertionError({
            message: 'The "block" argument must be of type function',
            generatedMessage: true
        });
    }

    let msg: string | Error | undefined;
    if (typeof error === 'string' || error instanceof Error) msg = error;
    else msg = message;

    try {
        block();
    } catch (err: unknown) {
        throw new AssertionError({
            actual: err,
            expected: undefined,
            message: typeof msg === 'string' ? msg : msg?.message || 'Got unwanted exception',
            operator: 'doesNotThrow',
            generatedMessage: !msg
        });
    }
}

export function ifError(value: unknown): asserts value is null | undefined {
    if (value !== null && value !== undefined) {
        throw new AssertionError({
            actual: value,
            expected: null,
            operator: 'ifError',
            generatedMessage: true
        });
    }
}

export function rejects(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
export function rejects(block: (() => Promise<unknown>) | Promise<unknown>, error: AssertPredicate, message?: string | Error): Promise<void>;
export async function rejects(block: (() => Promise<unknown>) | Promise<unknown>, error?: AssertPredicate | string | Error, message?: string | Error): Promise<void> {
    let promise: Promise<unknown>;

    if (typeof block === 'function') {
        try {
            promise = block();
        } catch (err) {
            throw new AssertionError({
                message: 'The "block" argument must return a Promise',
                generatedMessage: true
            });
        }
    } else {
        promise = block;
    }

    let err: unknown;
    let threw = false;

    try {
        await promise;
    } catch (e) {
        threw = true;
        err = e;
    }

    if (!threw) {
        const msg = typeof error === 'string' || error instanceof Error ? error : message;
        throw new AssertionError({
            message: typeof msg === 'string' ? msg : msg?.message || 'Missing expected rejection',
            operator: 'rejects',
            generatedMessage: !msg
        });
    }

    if (error !== undefined && typeof error !== 'string' && !(error instanceof Error)) {
        _checkError(err, error, message);
    }
}

export function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
export function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, error: AssertPredicate, message?: string | Error): Promise<void>;
export async function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, error?: AssertPredicate | string | Error, message?: string | Error): Promise<void> {
    let promise: Promise<unknown>;
    let msg: string | Error | undefined;

    if (typeof error === 'string' || error instanceof Error) msg = error;
    else msg = message;

    if (typeof block === 'function') {
        try {
            promise = block();
        } catch (err) {
            throw new AssertionError({
                message: 'The "block" argument must return a Promise',
                generatedMessage: true
            });
        }
    } else {
        promise = block;
    }

    try {
        await promise;
    } catch (err: unknown) {
        throw new AssertionError({
            actual: err,
            expected: undefined,
            message: typeof msg === 'string' ? msg : msg?.message || 'Got unwanted rejection',
            operator: 'doesNotReject',
            generatedMessage: !msg
        });
    }
}

export function match(string: string, regexp: RegExp, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'string and regexp arguments required',
            generatedMessage: true
        });
    }
    if (typeof string !== 'string') {
        throw new AssertionError({
            actual: string,
            expected: 'string',
            message: 'The "string" argument must be of type string',
            operator: 'match',
            generatedMessage: true
        });
    }
    if (!(regexp instanceof RegExp)) {
        throw new AssertionError({
            actual: regexp,
            expected: 'RegExp',
            message: 'The "regexp" argument must be of type RegExp',
            operator: 'match',
            generatedMessage: true
        });
    }
    if (!regexp.test(string)) {
        throw new AssertionError({
            actual: string,
            expected: regexp,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'match',
            generatedMessage: !message
        });
    }
}

export function doesNotMatch(string: string, regexp: RegExp, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'string and regexp arguments required',
            generatedMessage: true
        });
    }
    if (typeof string !== 'string') {
        throw new AssertionError({
            actual: string,
            expected: 'string',
            message: 'The "string" argument must be of type string',
            operator: 'doesNotMatch',
            generatedMessage: true
        });
    }
    if (!(regexp instanceof RegExp)) {
        throw new AssertionError({
            actual: regexp,
            expected: 'RegExp',
            message: 'The "regexp" argument must be of type RegExp',
            operator: 'doesNotMatch',
            generatedMessage: true
        });
    }
    if (regexp.test(string)) {
        throw new AssertionError({
            actual: string,
            expected: regexp,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'doesNotMatch',
            generatedMessage: !message
        });
    }
}

export function partialDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    if (arguments.length < 2) {
        throw new AssertionError({
            message: 'actual and expected arguments required',
            generatedMessage: true
        });
    }

    const compare = (a: unknown, e: unknown): boolean => {
        if (e === null || e === undefined) return Object.is(a, e);
        if (typeof e !== 'object') return Object.is(a, e);

        if (typeof a !== 'object' || a === null) return false;

        for (const key of Object.keys(e as object)) {
            if (!Object.prototype.hasOwnProperty.call(a, key)) return false;
            if (!compare((a as any)[key], (e as any)[key])) return false;
        }

        for (const sym of Object.getOwnPropertySymbols(e as object)) {
            if (!Object.prototype.hasOwnProperty.call(a, sym)) return false;
            if (!compare((a as any)[sym], (e as any)[sym])) return false;
        }

        return true;
    };

    if (!compare(actual, expected)) {
        throw new AssertionError({
            actual,
            expected,
            message: typeof message === 'string' ? message : message?.message,
            operator: 'partialDeepStrictEqual',
            generatedMessage: !message
        });
    }
}

export function assert(cond: any, message = 'Assertion failed'): asserts cond {
    if (!cond) {
        throw new AssertionError({
            actual: cond,
            expected: true,
            message: typeof message === 'string' ? message : (message as any)?.message,
            operator: '==',
            generatedMessage: !message
        });
    }
}

interface CallExpectation {
    callback: Function;
    atLeast: number;
    calls: number;
}

export class CallTracker {
    #expectations: CallExpectation[] = [];

    calls(fn?: Function, num: number = 1) {
        const exp: CallExpectation = { callback: fn ?? (() => {}), atLeast: num, calls: 0 };
        this.#expectations.push(exp);
        const wrapper = Object.assign(function (this: unknown, ...args: unknown[]) {
            exp.calls++;
            return exp.callback.apply(this, args);
        }, { callback: exp.callback, atLeast: exp.atLeast });
        return wrapper;
    }

    reset() {
        for (const exp of this.#expectations) exp.calls = 0;
    }

    get callCount() {
        return this.#expectations.reduce((sum, exp) => sum + exp.calls, 0);
    }

    verify(): void {
        const errors: string[] = [];
        for (const exp of this.#expectations) {
            if (exp.calls < exp.atLeast) {
                errors.push(`Expected at least ${exp.atLeast} calls but got ${exp.calls}`);
            }
        }
        if (errors.length) {
            throw new AssertionError({ message: errors.join('\n'), operator: 'CallTracker.verify' });
        }
    }
}

// Mount all assertion methods on the assert function itself
// so `const a = require('assert'); a.ok(true)` works (Node.js compat).
(assert as any).ok = ok;
(assert as any).fail = fail;
(assert as any).equal = equal;
(assert as any).notEqual = notEqual;
(assert as any).strictEqual = strictEqual;
(assert as any).notStrictEqual = notStrictEqual;
(assert as any).deepEqual = deepEqual;
(assert as any).notDeepEqual = notDeepEqual;
(assert as any).deepStrictEqual = deepStrictEqual;
(assert as any).notDeepStrictEqual = notDeepStrictEqual;
(assert as any).throws = throws;
(assert as any).doesNotThrow = doesNotThrow;
(assert as any).rejects = rejects;
(assert as any).doesNotReject = doesNotReject;
(assert as any).match = match;
(assert as any).doesNotMatch = doesNotMatch;
(assert as any).ifError = ifError;
(assert as any).AssertionError = AssertionError;
(assert as any).CallTracker = CallTracker;
(assert as any).partialDeepStrictEqual = partialDeepStrictEqual;