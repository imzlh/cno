/**
 * Node.js assert module
 */

const console = import.meta.use('console');
import { deepEqual as _deepEqual } from '../_internal/deep-equal';

// Internal helpers to reduce boilerplate
function msg(m?: string | Error): string | undefined {
    return typeof m === 'string' ? m : m?.message;
}

function checkArgs(min: number, actual: number): void {
    if (actual < min) {
        throw new AssertionError({ message: 'actual and expected arguments required', generatedMessage: true });
    }
}

function inspectForAssertion(value: unknown, seen = new WeakSet<object>()): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `'${value}'`;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
    if (typeof value !== 'object') return String(value);

    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return `[ ${value.map(item => inspectForAssertion(item, seen)).join(', ')} ]`;
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return value.toString();
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value instanceof Map) {
        const entries = Array.from(value, ([key, item]) => `${inspectForAssertion(key, seen)} => ${inspectForAssertion(item, seen)}`);
        return `Map(${value.size}) { ${entries.join(', ')} }`;
    }
    if (value instanceof Set) {
        const entries = Array.from(value, item => inspectForAssertion(item, seen));
        return `Set(${value.size}) { ${entries.join(', ')} }`;
    }

    try {
        const keys = Reflect.ownKeys(value);
        const entries = keys.map(key => {
            const label = typeof key === 'symbol' ? `[${key.toString()}]` : String(key);
            return `${label}: ${inspectForAssertion((value as any)[key], seen)}`;
        });
        const prefix = Object.getPrototypeOf(value) === null ? '[Object: null prototype] ' : '';
        return `${prefix}{ ${entries.join(', ')} }`;
    } catch {
        return console.inspect(value);
    }
}

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
            message = `${inspectForAssertion(options.actual)} ${options.operator || ''} ${inspectForAssertion(options.expected)}`.trim();
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
            message: msg(message),
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
    const m = arguments.length === 1 ? actual : message;
    throw new AssertionError({
        message: msg(m as string | Error),
        actual: arguments.length > 1 ? actual : undefined,
        expected: arguments.length > 1 ? expected : undefined,
        operator: operator || 'fail',
        generatedMessage: !m
    });
}

export function equal(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);
    if (actual != expected) {
        throw new AssertionError({
            actual,
            expected,
            message: msg(message),
            operator: '==',
            generatedMessage: !message
        });
    }
}

export function notEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);
    if (actual == expected) {
        throw new AssertionError({
            actual,
            expected,
            message: msg(message),
            operator: '!=',
            generatedMessage: !message
        });
    }
}

export function strictEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T {
    checkArgs(2, arguments.length);
    if (!Object.is(actual, expected)) {
        throw new AssertionError({
            actual,
            expected,
            message: msg(message),
            operator: 'strictEqual',
            generatedMessage: !message
        });
    }
}

export function notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);
    if (Object.is(actual, expected)) {
        throw new AssertionError({
            actual,
            expected,
            message: msg(message),
            operator: 'notStrictEqual',
            generatedMessage: !message
        });
    }
}

export function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);
    if (!_deepEqual(actual, expected, false)) {
        throw new AssertionError({
            actual,
            expected,
            message: msg(message),
            operator: 'deepEqual',
            generatedMessage: !message
        });
    }
}

export function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);
    if (_deepEqual(actual, expected, false)) {
        throw new AssertionError({
            actual,
            expected,
            message: msg(message),
            operator: 'notDeepEqual',
            generatedMessage: !message
        });
    }
}

export function deepStrictEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T {
    checkArgs(2, arguments.length);
    if (!_deepEqual(actual, expected, true)) {
        throw new AssertionError({
            actual,
            expected,
            message: msg(message),
            operator: 'deepStrictEqual',
            generatedMessage: !message
        });
    }
}

export function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);
    if (_deepEqual(actual, expected, true)) {
        throw new AssertionError({
            actual,
            expected,
            message: msg(message),
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
                    message: msg(message),
                    operator: 'throws',
                    generatedMessage: !message
                });
            }
        } else {
            if (!(error as (thrown: unknown) => boolean)(err)) {
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: msg(message),
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
                message: msg(message),
                operator: 'throws',
                generatedMessage: !message
            });
        }
        const str = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (!error.test(str)) {
            throw new AssertionError({
                actual: err,
                expected: error,
                message: msg(message),
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
                        message: msg(message),
                        operator: 'throws',
                        generatedMessage: !message
                    });
                }
            } else if (!_deepEqual(actualValue, expectedValue, true)) {
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: msg(message),
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
        const m = typeof error === 'string' || error instanceof Error ? error : message;
        throw new AssertionError({
            message: msg(m as string | Error) || 'Missing expected exception',
            operator: 'throws',
            generatedMessage: !m
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

    const m = (typeof error === 'string' || error instanceof Error) ? error : message;

    try {
        block();
    } catch (err: unknown) {
        throw new AssertionError({
            actual: err,
            expected: undefined,
            message: msg(m as string | Error) || 'Got unwanted exception',
            operator: 'doesNotThrow',
            generatedMessage: !m
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
        const m = typeof error === 'string' || error instanceof Error ? error : message;
        throw new AssertionError({
            message: msg(m as string | Error) || 'Missing expected rejection',
            operator: 'rejects',
            generatedMessage: !m
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
    const m = (typeof error === 'string' || error instanceof Error) ? error : message;

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
            message: msg(m as string | Error) || 'Got unwanted rejection',
            operator: 'doesNotReject',
            generatedMessage: !m
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
            message: msg(message),
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
            message: msg(message),
            operator: 'doesNotMatch',
            generatedMessage: !message
        });
    }
}

export function partialDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);

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
            message: msg(message),
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
