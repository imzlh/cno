/**
 * Node.js assert module
 */

const console = import.meta.use('console');
import { deepEqual as _deepEqual } from '../_internal/deep-equal';
// The Myers-diff composer and assert's exact inspect option set. These live in
// util because util.inspect produces the indented one-property-per-line
// rendering the diff operates on. The `console` builtin's inspect is NOT a
// substitute: it ignores maxArrayLength/sorted and renders a 3-element array as
// "[... 3 more items\n]".
import { inspectDiff, inspectForAssert } from '../util/diff';

type PropertyRecord = Record<PropertyKey, unknown>;

// Internal helpers to reduce boilerplate
function msg(m?: unknown): string | undefined {
    if (typeof m === 'string') return m;
    return m instanceof Error ? m.message : undefined;
}

/**
 * Message extractor for the comparison assertions. When the caller supplies an
 * Error, Node throws *that instance* rather than wrapping it in an
 * AssertionError, so `catch (e) { e instanceof MyError }` keeps working. This
 * throws from the argument position, which is always evaluated immediately
 * before the AssertionError would have been thrown.
 */
function messageOrThrow(m?: unknown): string | undefined {
    if (m instanceof Error) throw m;
    return typeof m === 'string' ? m : undefined;
}

/** The throws/rejects family renders an Error message as "Name: message". */
function matcherMessage(m?: unknown): string | undefined {
    if (typeof m === 'string') return m;
    if (m instanceof Error) return `${m.name}: ${m.message}`;
    return undefined;
}

/**
 * The parenthesised name in "Missing expected exception (TypeError)."
 *
 * Node names constructors and named predicate functions, and an Error *instance*
 * by its constructor. RegExps, plain-object matchers and anonymous functions get
 * no suffix, since there is no useful name to report.
 */
function matcherName(error: unknown): string {
    if (typeof error === 'function') return error.name ? ` (${error.name})` : '';
    if (error instanceof Error) {
        const name = error.constructor?.name;
        return name ? ` (${name})` : '';
    }
    return '';
}

/** Node throws a TypeError (not an AssertionError) for bad argument types. */
function invalidArgType(message: string): TypeError {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

function checkArgs(min: number, actual: number): void {
    if (actual < min) {
        // Node: TypeError with code ERR_MISSING_ARGS, not an AssertionError.
        throw Object.assign(
            new TypeError('The "actual" and "expected" arguments must be specified'),
            { code: 'ERR_MISSING_ARGS' },
        );
    }
}

function inspectForAssertion(value: unknown, seen = new WeakSet<object>()): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `'${value}'`;
    // Object.is, not <0: String(-0) is '0', which would make a -0/0 mismatch
    // render as two identical values.
    if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
    if (typeof value !== 'object') return String(value);

    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return `[ ${value.map(item => inspectForAssertion(item, seen)).join(', ')} ]`;
    }
    // toISOString() throws RangeError on an Invalid Date. Building the *failure
    // message* must never throw, or the AssertionError is replaced by a
    // RangeError and the real comparison result is lost.
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
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

// Node's generated-message shapes, measured on v24.18.0. See
// tests/node/assert-message-shapes.test.ts for the pinned expectations.
const OPERATOR_HEADERS: Record<string, string> = {
    strictEqual: 'Expected values to be strictly equal:',
    deepStrictEqual: 'Expected values to be strictly deep-equal:',
    deepEqual: 'Expected values to be loosely deep-equal:',
};
const NEGATED_HEADERS: Record<string, string> = {
    notStrictEqual: 'Expected "actual" to be strictly unequal to:',
    notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
    notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
};

/**
 * `strictEqual` and `notStrictEqual` swap in a "reference-equal" wording when
 * both operands are objects, or both are functions — measured on Node v24.18.0.
 * A function compared against a plain object does NOT qualify, which is why this
 * cannot be a single isObjectLike() test.
 */
function bothReferenceTypes(actual: unknown, expected: unknown): boolean {
    const bothObjects = typeof actual === 'object' && actual !== null
        && typeof expected === 'object' && expected !== null;
    const bothFunctions = typeof actual === 'function' && typeof expected === 'function';
    return bothObjects || bothFunctions;
}

/** As above, for the single operand the negated assertions report. */
function isReferenceType(value: unknown): boolean {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * How the negated assertions attach their single rendered value.
 *
 * The strict forms inline it after the colon only when it is short and fits on
 * one line, and add a trailing newline when it is multi-line. Thresholds
 * measured on v24.18.0: 5 characters inline, 6 block ('xxx' inlines, 'xxxx'
 * does not). Loose `notDeepEqual` is different again — always block, never a
 * trailing newline, whatever the length.
 */
function attachNegatedValue(header: string, rendered: string, loose: boolean): string {
    if (loose) return `${header}\n\n${rendered}`;
    if (rendered.includes('\n')) return `${header}\n\n${rendered}\n`;
    if (rendered.length <= 5) return `${header} ${rendered}`;
    return `${header}\n\n${rendered}`;
}

/**
 * The inspect options Node's assert uses, and the Myers-diff composer built to
 * match `createErrDiff`.
 */
function isObjectLike(value: unknown): boolean {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function inspectForDiff(value: unknown): string {
    try {
        return inspectForAssert(value);
    } catch {
        // Never let message construction throw: a crash here would replace the
        // AssertionError and lose the comparison result entirely.
        return inspectForAssertion(value);
    }
}

/**
 * Node's `+ actual - expected` structural diff, composed exactly as
 * createErrDiff does. This block is what a developer reads to find out what
 * differed, so it is worth far more than the one-line form it replaces.
 */
function buildStructuralDiff(header: string, actual: unknown, expected: unknown): string {
    let result;
    try {
        result = inspectDiff(actual, expected);
    } catch {
        return `${header}\n\n${inspectForDiff(actual)} !== ${inspectForDiff(expected)}\n`;
    }
    const legend = result.header ?? '+ actual - expected';
    const skipped = result.skipped ? '\n... Skipped lines' : '';
    return `${header}\n${legend}${skipped}\n${result.message}\n`;
}

/**
 * Builds Node's generated message for a failed comparison.
 *
 * The `+ actual - expected` form is used when the two values *look* alike, which
 * is what makes an otherwise-baffling failure readable: `strictEqual(0, -0)`
 * previously rendered as "0 strictEqual 0", reporting two identical-looking
 * values as unequal.
 *
 * Node renders object operands as a multi-line structural diff; that requires
 * util.inspect's indented output, so objects are rendered on one line here.
 */
/**
 * `strictEqual` and `deepStrictEqual` keep the generated detail even when the
 * caller supplies a message, so the custom text explains *why* the assertion
 * matters while the detail still shows what differed. Node does this only for
 * these two; every other assertion replaces the message entirely.
 */
function withDetail(custom: string | undefined, actual: unknown, expected: unknown, operator: string): string | undefined {
    if (custom === undefined) return undefined;
    const generated = buildGeneratedMessage(actual, expected, operator);
    const header = OPERATOR_HEADERS[operator];
    // Swap the header line for the caller's message, keeping the rest verbatim.
    const detail = header && generated.startsWith(header)
        ? generated.slice(header.length)
        : `\n\n${generated}`;
    return `${custom}${detail}`;
}

function buildGeneratedMessage(actual: unknown, expected: unknown, operator: string): string {
    const negated = NEGATED_HEADERS[operator];
    if (negated) {
        // notStrictEqual on a reference type reports the reference, not the value.
        const header = operator === 'notStrictEqual' && isReferenceType(actual)
            ? 'Expected "actual" not to be reference-equal to "expected":'
            : negated;
        return attachNegatedValue(header, inspectForDiff(actual), operator === 'notDeepEqual');
    }

    let header = OPERATOR_HEADERS[operator];
    if (!header) {
        // Loose equal/notEqual and any custom operator keep the terse form,
        // which is what Node emits for them ("1 == 2").
        return `${inspectForAssertion(actual)} ${operator || ''} ${inspectForAssertion(expected)}`.trim();
    }

    if (operator === 'strictEqual' && bothReferenceTypes(actual, expected)) {
        // Structurally equal but a different reference: there is nothing to diff,
        // so say so outright rather than printing two identical blocks.
        if (_deepEqual(actual, expected, true)) {
            return `Values have same structure but are not reference-equal:\n\n${inspectForDiff(actual)}\n`;
        }
        header = 'Expected "actual" to be reference-equal to "expected":';
    }

    // Loose deepEqual shows both sides in full rather than a diff.
    if (operator === 'deepEqual') {
        return `${header}\n\n${inspectForDiff(actual)}\n\nshould loosely deep-equal\n\n${inspectForDiff(expected)}`;
    }

    // Everything else — objects and primitives alike — goes through Node's own
    // rules, which pick between `actual !== expected`, a stacked +/- pair with a
    // `^` column indicator, and the full line diff. Branching on the input types
    // here instead would get `null` vs an object wrong: that pair takes the
    // marked form because the object side is multi-line, not because of its type.
    return buildStructuralDiff(header, actual, expected);
}

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
        // provided — matches Node.js behaviour. An operator is enough on its own:
        // notDeepStrictEqual(undefined, undefined) has to report "undefined"
        // rather than falling through to a bare "Assertion failed".
        let message = options.message;
        if (message == null && (options.actual !== undefined || options.expected !== undefined || options.operator)) {
            message = buildGeneratedMessage(options.actual, options.expected, options.operator || '');
        }
        super(message ?? 'Assertion failed');
        // Node carries `name` on the instance but leaves it non-enumerable, so
        // Object.keys(err) lists only the assertion fields.
        // `__proto__: null` is load-bearing, not defensive style: `defineProperty`
        // resolves descriptor fields with HasProperty, which walks the prototype
        // chain, so a plain literal carrying `value`/`writable` also picks up any
        // `get`/`set` polluted onto `Object.prototype` and dies with "Cannot both
        // specify accessors and a value or writable attribute". Node and Deno both
        // survive `Object.prototype.get = fn` here (OBSERVED).
        Object.defineProperty(this, 'name', {
            __proto__: null,
            value: 'AssertionError',
            enumerable: false,
            writable: true,
            configurable: true,
        } as PropertyDescriptor);
        this.generatedMessage = options.generatedMessage ?? !options.message;
        this.actual = options.actual;
        this.expected = options.expected;
        // Node omits `operator` entirely when the caller gave none.
        if (options.operator !== undefined) this.operator = options.operator;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, options.stackStartFn || AssertionError);
        }
    }
}

function innerOk(fn: AssertCallable, argLen: number, value: unknown, message?: string | Error): void {
    if (argLen === 0) {
        throw new AssertionError({
            message: 'No value argument passed to `assert.ok()`',
            expected: true,
            operator: '==',
            generatedMessage: true
        });
    }
    if (!value) {
        // Node reads the call site's source to echo the expression here. Without
        // that, name the operand instead of rendering "false == true", which
        // says nothing about what was actually tested.
        throw new AssertionError({
            actual: value,
            expected: true,
            message: messageOrThrow(message)
                ?? `The expression evaluated to a falsy value:\n\n  assert.ok(${inspectForAssertion(value)})\n`,
            operator: '==',
            generatedMessage: !message
        });
    }
}

export function ok(value: unknown, message?: string | Error): asserts value {
    innerOk(ok as AssertCallable, arguments.length, value, message);
}

export function fail(message?: string | Error): never;
export function fail(actual: unknown, expected: unknown, message?: string | Error, operator?: string): never;
export function fail(actual?: unknown, expected?: unknown, message?: string | Error, operator?: string): never {
    const m = arguments.length === 1 ? actual : message;
    const custom = messageOrThrow(m);
    throw new AssertionError({
        // Node's no-argument default is 'Failed'.
        message: custom ?? (arguments.length > 1 ? undefined : 'Failed'),
        actual: arguments.length > 1 ? actual : undefined,
        expected: arguments.length > 1 ? expected : undefined,
        operator: operator || 'fail',
        generatedMessage: !custom
    });
}

export function equal(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);
    // Node's loose equal treats NaN as equal to itself, even though NaN != NaN.
    if (actual != expected && !(Number.isNaN(actual) && Number.isNaN(expected))) {
        throw new AssertionError({
            actual,
            expected,
            message: messageOrThrow(message),
            operator: '==',
            generatedMessage: !message
        });
    }
}

export function notEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    checkArgs(2, arguments.length);
    if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
        throw new AssertionError({
            actual,
            expected,
            message: messageOrThrow(message),
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
            message: withDetail(messageOrThrow(message), actual, expected, 'strictEqual'),
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
            message: messageOrThrow(message),
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
            message: messageOrThrow(message),
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
            message: messageOrThrow(message),
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
            message: withDetail(messageOrThrow(message), actual, expected, 'deepStrictEqual'),
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
            message: messageOrThrow(message),
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
                // Node names both constructors and appends the thrown message.
                const received = err instanceof Error ? err.name : typeof err;
                const detail = err instanceof Error ? `\n\nError message:\n\n${err.message}` : '';
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: matcherMessage(message)
                        ?? `The error is expected to be an instance of "${error.name}". Received "${received}"${detail}`,
                    operator: 'throws',
                    generatedMessage: !message
                });
            }
        } else {
            if ((error as (thrown: unknown) => boolean)(err) !== true) {
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: matcherMessage(message),
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
                message: matcherMessage(message),
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
                    message: matcherMessage(message),
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
                        message: matcherMessage(message),
                        operator: 'throws',
                        generatedMessage: !message
                    });
                }
            } else if (!_deepEqual(actualValue, expectedValue, true)) {
                throw new AssertionError({
                    actual: err,
                    expected: error,
                    message: matcherMessage(message),
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

// Node reports two distinct errors here: a bad `block` argument is
// ERR_INVALID_ARG_TYPE, while a function returning a non-promise is
// ERR_INVALID_RETURN_VALUE.
function describeValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') return 'an instance of ' + (Reflect.get(value, 'constructor') as { name?: string } | undefined)?.name;
    return `type ${typeof value} (${inspectForAssertion(value)})`;
}

function resolveRejectsPromise(block: unknown): Promise<unknown> {
    if (typeof block !== 'function') {
        if (isPromiseLike(block)) return block;
        const err = new TypeError(
            `The "promiseFn" argument must be of type function or an instance of Promise. Received ${describeValue(block)}`,
        ) as TypeError & { code?: string };
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
    }
    const returned = (block as () => unknown)();
    if (isPromiseLike(returned)) return returned;
    const err = new TypeError(
        `Expected instance of Promise to be returned from the "promiseFn" function but got ${describeValue(returned)}.`,
    ) as TypeError & { code?: string };
    err.code = 'ERR_INVALID_RETURN_VALUE';
    throw err;
}

export function throws(block: () => unknown, message?: string | Error): void;
export function throws(block: () => unknown, error: AssertPredicate, message?: string | Error): void;
export function throws(block: () => unknown, error?: AssertPredicate | string | Error, message?: string | Error): void {
    if (typeof block !== 'function') {
        // Node: TypeError/ERR_INVALID_ARG_TYPE naming the "fn" argument.
        throw invalidArgType(`The "fn" argument must be of type function. Received ${describeValue(block)}`);
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
        // Node's shape, measured on v24.18.0: "Missing expected exception" plus
        // the constructor name in parens when `error` names one, then the custom
        // message after a colon. A string second argument IS the custom message
        // (there is no matcher), so it takes the no-parens form. `generatedMessage`
        // is false in every case — Node builds this text itself.
        const named = hasErrorMatcher(error) ? matcherName(error) : '';
        const custom = matcherMessage(m);
        throw new AssertionError({
            message: `Missing expected exception${named}${custom ? `: ${custom}` : '.'}`,
            operator: 'throws',
            generatedMessage: false,
            actual: undefined,
            expected: error
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
        throw invalidArgType(`The "fn" argument must be of type function. Received ${describeValue(block)}`);
    }

    const m = typeof error === 'string' ? error : message;

    try {
        block();
    } catch (err: unknown) {
        if (hasErrorMatcher(error) && !matchesError(err, error)) {
            throw err;
        }
        // Node's shape, measured on v24.18.0: "Got unwanted exception" then the
        // custom message after a colon, then the thrown error's message on a
        // second line. `generatedMessage` is false in every case.
        const custom = matcherMessage(m);
        const actualMessage = err instanceof Error ? err.message : inspectForAssertion(err);
        throw new AssertionError({
            actual: err,
            expected: undefined,
            message: `Got unwanted exception${custom ? `: ${custom}` : '.'}\nActual message: ${JSON.stringify(actualMessage)}`,
            operator: 'doesNotThrow',
            generatedMessage: false
        });
    }
}

export function ifError(value: unknown): asserts value is null | undefined {
    if (value !== null && value !== undefined) {
        // Node builds this text itself and reports generatedMessage: false.
        const detail = value instanceof Error ? value.message : inspectForAssertion(value);
        throw new AssertionError({
            actual: value,
            expected: null,
            operator: 'ifError',
            message: `ifError got unwanted exception: ${detail}`,
            generatedMessage: false
        });
    }
}

export function rejects(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
export function rejects(block: (() => Promise<unknown>) | Promise<unknown>, error: AssertPredicate, message?: string | Error): Promise<void>;
export async function rejects(block: (() => Promise<unknown>) | Promise<unknown>, error?: AssertPredicate | string | Error, message?: string | Error): Promise<void> {
    const promise = resolveRejectsPromise(block);

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
        // Same shape family as throws(); measured on v24.18.0.
        const named = hasErrorMatcher(error) ? matcherName(error) : '';
        const custom = matcherMessage(m);
        throw new AssertionError({
            message: `Missing expected rejection${named}${custom ? `: ${custom}` : '.'}`,
            operator: 'rejects',
            generatedMessage: false
        });
    }

    if (hasErrorMatcher(error)) {
        _checkError(err, error, message);
    }
}

export function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
export function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, error: AssertPredicate, message?: string | Error): Promise<void>;
export async function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, error?: AssertPredicate | string | Error, message?: string | Error): Promise<void> {
    const m = typeof error === 'string' ? error : message;
    const promise = resolveRejectsPromise(block);

    try {
        await promise;
    } catch (err: unknown) {
        if (hasErrorMatcher(error) && !matchesError(err, error)) {
            throw err;
        }
        const custom = matcherMessage(m);
        const actualMessage = err instanceof Error ? err.message : inspectForAssertion(err);
        throw new AssertionError({
            actual: err,
            expected: undefined,
            message: `Got unwanted rejection${custom ? `: ${custom}` : '.'}\nActual message: ${JSON.stringify(actualMessage)}`,
            operator: 'doesNotReject',
            generatedMessage: false
        });
    }
}

export function match(string: string, regexp: RegExp, message?: string | Error): void {
    // Node's shapes, measured on v24.18.0: a bad `string` is an AssertionError,
    // but a bad or missing `regexp` is a TypeError/ERR_INVALID_ARG_TYPE.
    if (typeof string !== 'string') {
        throw new AssertionError({
            actual: string,
            expected: 'string',
            message: `The "string" argument must be of type string. Received ${describeValue(string)}`,
            operator: 'match',
            generatedMessage: false
        });
    }
    if (!(regexp instanceof RegExp)) {
        throw invalidArgType(
            `The "regexp" argument must be an instance of RegExp. Received ${describeValue(regexp)}`,
        );
    }
    if (!regexp.test(string)) {
        throw new AssertionError({
            actual: string,
            expected: regexp,
            message: messageOrThrow(message)
                ?? `The input did not match the regular expression ${regexp}. Input:\n\n${inspectForAssertion(string)}\n`,
            operator: 'match',
            generatedMessage: !message
        });
    }
}

export function doesNotMatch(string: string, regexp: RegExp, message?: string | Error): void {
    if (typeof string !== 'string') {
        throw new AssertionError({
            actual: string,
            expected: 'string',
            message: `The "string" argument must be of type string. Received ${describeValue(string)}`,
            operator: 'doesNotMatch',
            generatedMessage: false
        });
    }
    if (!(regexp instanceof RegExp)) {
        throw invalidArgType(
            `The "regexp" argument must be an instance of RegExp. Received ${describeValue(regexp)}`,
        );
    }
    if (regexp.test(string)) {
        throw new AssertionError({
            actual: string,
            expected: regexp,
            message: messageOrThrow(message)
                ?? `The input was expected to not match the regular expression ${regexp}. Input:\n\n${inspectForAssertion(string)}\n`,
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
            message: messageOrThrow(message),
            operator: 'partialDeepStrictEqual',
            generatedMessage: !message
        });
    }
}

export function assert(cond: unknown, message?: string | Error): asserts cond {
    innerOk(assert as AssertCallable, arguments.length, cond, message);
}

interface TrackedCall {
    thisArg: unknown;
    arguments: unknown[];
}

interface CallExpectation {
    callback: AssertCallable;
    wrapper: AssertCallable;
    exact: number;
    name: string;
    /** Every invocation's receiver and arguments, as Node records them. */
    tracked: TrackedCall[];
}

export class CallTracker {
    #expectations: CallExpectation[] = [];

    /** Node keys getCalls()/reset() off the *wrapper* as well as the original. */
    #find(fn: AssertCallable): CallExpectation | undefined {
        return this.#expectations.find(e => e.wrapper === fn || e.callback === fn);
    }

    calls(fn?: AssertCallable | number, num: number = 1) {
        // Node allows calls(exact) with the function omitted. The placeholder must
        // stay genuinely anonymous: assigning an arrow to a named binding would
        // give it that binding's name via JS name inference, and that name then
        // surfaces in the report() text.
        let callback: AssertCallable;
        let exact: number;
        if (typeof fn === 'number') {
            exact = fn;
            callback = (0, function () {}) as AssertCallable;
        } else {
            callback = fn ?? ((0, function () {}) as AssertCallable);
            exact = num;
        }

        const exp = {
            callback,
            exact,
            // Node falls back to 'calls' for an anonymous function.
            name: callback.name || 'calls',
            tracked: [] as TrackedCall[],
        } as CallExpectation;

        // The wrapper must be a bare function: Node adds no own properties and
        // preserves the original's `name` and `length` so that code reflecting
        // over the callback still sees the right arity.
        const wrapper = function (this: unknown, ...args: unknown[]) {
            exp.tracked.push({ thisArg: this, arguments: args });
            return Reflect.apply(exp.callback, this, args);
        } as AssertCallable;
        // Null-prototype descriptors for the same reason as AssertionError's `name`
        // above: a value-only literal inherits a polluted `Object.prototype.get`
        // and defineProperty then rejects it as accessor-plus-value.
        Object.defineProperty(wrapper, 'name', { __proto__: null, value: callback.name, configurable: true } as PropertyDescriptor);
        Object.defineProperty(wrapper, 'length', { __proto__: null, value: callback.length, configurable: true } as PropertyDescriptor);

        exp.wrapper = wrapper;
        this.#expectations.push(exp);
        return wrapper;
    }

    reset(fn?: AssertCallable) {
        if (fn === undefined) {
            for (const exp of this.#expectations) exp.tracked.length = 0;
            return;
        }
        const exp = this.#find(fn);
        if (exp) exp.tracked.length = 0;
    }

    /** Node's report(): one entry per expectation whose count is wrong. */
    report(): { message: string; actual: number; expected: number; operator: string; stack: object }[] {
        const out: { message: string; actual: number; expected: number; operator: string; stack: object }[] = [];
        for (const exp of this.#expectations) {
            const actual = exp.tracked.length;
            if (actual !== exp.exact) {
                out.push({
                    message: `Expected the ${exp.name} function to be executed ${exp.exact} time(s) but was executed ${actual} time(s).`,
                    actual,
                    expected: exp.exact,
                    operator: exp.name,
                    stack: {},
                });
            }
        }
        return out;
    }

    /**
     * The receiver and arguments of every recorded call. Node freezes the array
     * and each entry, so a caller cannot corrupt the tracker's own records, and
     * throws ERR_INVALID_ARG_VALUE for a function it is not tracking.
     */
    getCalls(fn: AssertCallable): readonly TrackedCall[] {
        const exp = this.#find(fn);
        if (!exp) {
            throw Object.assign(
                new TypeError('The argument \'fn\' must be a tracked function. Received function'),
                { code: 'ERR_INVALID_ARG_VALUE' },
            );
        }
        return Object.freeze(exp.tracked.map(call => Object.freeze({
            thisArg: call.thisArg,
            arguments: Object.freeze(call.arguments.slice()) as unknown as unknown[],
        })));
    }

    verify(): void {
        const errors = this.report();
        if (errors.length) {
            throw new AssertionError({
                message: errors.map(e => e.message).join('\n'),
                operator: 'CallTracker.verify',
                generatedMessage: false,
            });
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
    innerOk(strictAssert as AssertCallable, arguments.length, condition, message);
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
// @ts-ignore
strict.strict = strict;
assert.strict = strict;
