/**
 * Node.js assert module
 */

const console = import.meta.use('console');
import { deepEqual as _deepEqual } from '../_internal/deep-equal';

type PropertyRecord = Record<PropertyKey, unknown>;

// Internal helpers to reduce boilerplate
function msg(m?: unknown): string | undefined {
    if (typeof m === 'string') return m;
    return m instanceof Error ? m.message : undefined;
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
        const record = value as PropertyRecord;
        const keys = Reflect.ownKeys(value);
        const entries = keys.map(key => {
            const label = typeof key === 'symbol' ? `[${key.toString()}]` : String(key);
            return `${label}: ${inspectForAssertion(record[key], seen)}`;
        });
        const prefix = Object.getPrototypeOf(value) === null ? '[Object: null prototype] ' : '';
        return `${prefix}{ ${entries.join(', ')} }`;
    } catch {
        return console.inspect(value);
    }
}

export type AssertPredicate = RegExp | (new () => object) | ((thrown: unknown) => boolean) | object | Error;
type AssertCallable = (...args: unknown[]) => unknown;

export interface AssertionErrorOptions {
    message?: string;
    actual?: unknown;
    expected?: unknown;
    operator?: string;
    stackStartFn?: AssertCallable;
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

function innerOk(fn: AssertCallable, argLen: number, value: unknown, message?: string | Error): void {
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
        message: msg(m),
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

function expectedErrorKeys(error: object): string[] {
    const keys = Object.keys(error);
    if (error instanceof Error) {
        for (const key of ['name', 'message']) {
            if (!keys.includes(key)) keys.unshift(key);
        }
    }
    return keys;
}

function hasProperty(value: object | Function | undefined, key: string): boolean {
    return value !== undefined && key in value;
}

function _checkError(err: unknown, error: AssertPredicate, message?: string | Error): void {
    if (typeof error === 'function') {
        const prototype = Reflect.get(error, 'prototype');
        if (error === Error || (prototype && prototype instanceof Error)) {
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
            if ((error as (thrown: unknown) => boolean)(err) !== true) {
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
        const keys = expectedErrorKeys(error);
        const actualRecord = (typeof err === 'object' || typeof err === 'function') && err !== null
            ? err as PropertyRecord
            : undefined;
        const expectedRecord = error as PropertyRecord;
        for (const key of keys) {
            if (!hasProperty(actualRecord, key)) {
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: msg(message),
                    operator: 'throws',
                    generatedMessage: !message
                });
            }
            const actualValue = actualRecord?.[key];
            const expectedValue = expectedRecord[key];
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

function matchesError(err: unknown, error: AssertPredicate): boolean {
    try {
        _checkError(err, error);
        return true;
    } catch (caught) {
        if (caught instanceof AssertionError) return false;
        throw caught;
    }
}

function hasErrorMatcher(error: AssertPredicate | string | Error | undefined): error is AssertPredicate {
    return error !== undefined && typeof error !== 'string';
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
    return typeof Reflect.get(value, 'then') === 'function';
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
        const m = typeof error === 'string' ? error : message;
        throw new AssertionError({
            message: msg(m) || 'Missing expected exception',
            operator: 'throws',
            generatedMessage: !m
        });
    }

    if (hasErrorMatcher(error)) {
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

    const m = typeof error === 'string' ? error : message;

    try {
        block();
    } catch (err: unknown) {
        if (hasErrorMatcher(error) && !matchesError(err, error)) {
            throw err;
        }
        throw new AssertionError({
            actual: err,
            expected: undefined,
            message: msg(m) || 'Got unwanted exception',
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
        promise = block();
    } else {
        promise = block;
    }
    if (!isPromiseLike(promise)) {
        throw new TypeError('Expected instance of Promise to be returned from the "promiseFn" function');
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
        const m = typeof error === 'string' ? error : message;
        throw new AssertionError({
            message: msg(m) || 'Missing expected rejection',
            operator: 'rejects',
            generatedMessage: !m
        });
    }

    if (hasErrorMatcher(error)) {
        _checkError(err, error, message);
    }
}

export function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
export function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, error: AssertPredicate, message?: string | Error): Promise<void>;
export async function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, error?: AssertPredicate | string | Error, message?: string | Error): Promise<void> {
    let promise: Promise<unknown>;
    const m = typeof error === 'string' ? error : message;

    if (typeof block === 'function') {
        promise = block();
    } else {
        promise = block;
    }
    if (!isPromiseLike(promise)) {
        throw new TypeError('Expected instance of Promise to be returned from the "promiseFn" function');
    }

    try {
        await promise;
    } catch (err: unknown) {
        if (hasErrorMatcher(error) && !matchesError(err, error)) {
            throw err;
        }
        throw new AssertionError({
            actual: err,
            expected: undefined,
            message: msg(m) || 'Got unwanted rejection',
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

        const actualRecord = a as PropertyRecord;
        const expectedRecord = e as PropertyRecord;
        for (const key of Object.keys(e)) {
            if (!Object.prototype.hasOwnProperty.call(a, key)) return false;
            if (!compare(actualRecord[key], expectedRecord[key])) return false;
        }

        for (const sym of Object.getOwnPropertySymbols(e)) {
            if (!Object.prototype.hasOwnProperty.call(a, sym)) return false;
            if (!compare(actualRecord[sym], expectedRecord[sym])) return false;
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

export function assert(cond: unknown, message?: string | Error): asserts cond {
    innerOk(assert, arguments.length, cond, message);
}

interface CallExpectation {
    callback: AssertCallable;
    atLeast: number;
    calls: number;
}

export class CallTracker {
    #expectations: CallExpectation[] = [];

    calls(fn?: AssertCallable, num: number = 1) {
        const exp: CallExpectation = { callback: fn ?? (() => {}), atLeast: num, calls: 0 };
        this.#expectations.push(exp);
        const wrapper = Object.assign(function (this: unknown, ...args: unknown[]) {
            exp.calls++;
            return Reflect.apply(exp.callback, this, args);
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
assert.ok = ok;
assert.fail = fail;
assert.equal = equal;
assert.notEqual = notEqual;
assert.strictEqual = strictEqual;
assert.notStrictEqual = notStrictEqual;
assert.deepEqual = deepEqual;
assert.notDeepEqual = notDeepEqual;
assert.deepStrictEqual = deepStrictEqual;
assert.notDeepStrictEqual = notDeepStrictEqual;
assert.throws = throws;
assert.doesNotThrow = doesNotThrow;
assert.rejects = rejects;
assert.doesNotReject = doesNotReject;
assert.match = match;
assert.doesNotMatch = doesNotMatch;
assert.ifError = ifError;
assert.AssertionError = AssertionError;
assert.CallTracker = CallTracker;
assert.partialDeepStrictEqual = partialDeepStrictEqual;

// assert.strict — strict mode sub-namespace where equal/notEqual/deepEqual/notDeepEqual
// use their strict counterparts. Created as a separate object so assert.equal
// (loose equality) is unaffected.
function strictAssert(condition: unknown, message?: string | Error): asserts condition {
    innerOk(strictAssert, arguments.length, condition, message);
}
export const strict = Object.assign(strictAssert, {
    ok, fail,
    equal: strictEqual, notEqual: notStrictEqual,
    strictEqual, notStrictEqual,
    deepEqual: deepStrictEqual, notDeepEqual: notDeepStrictEqual,
    deepStrictEqual, notDeepStrictEqual,
    throws, doesNotThrow, rejects, doesNotReject,
    match, doesNotMatch, ifError,
    AssertionError, CallTracker, partialDeepStrictEqual,
});
strict.strict = strict;
assert.strict = strict;
