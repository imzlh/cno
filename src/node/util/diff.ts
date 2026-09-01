/**
 * Myers line diff, ported from Node's `internal/assert/myers_diff` and
 * `internal/util/diff`.
 *
 * `assert`'s error messages need `+ actual` / `- expected` line markers, and in
 * Node that machinery lives under util rather than in assert itself. Exposing it
 * here keeps the same layering: `assert` gets a single call site.
 */

import { inspect } from './inspect';

export const kNopLinesToCollapse = 5;

export const kOperations = {
    DELETE: -1,
    NOP: 0,
    INSERT: 1,
} as const;

export type DiffOperation = -1 | 0 | 1;
export type DiffEntry = [DiffOperation, string];

function areLinesEqual(actual: string, expected: string, checkCommaDisparity: boolean): boolean {
    if (actual === expected) return true;
    if (checkCommaDisparity) {
        return `${actual},` === expected || actual === `${expected},`;
    }
    return false;
}

/**
 * Computes the Myers diff between two line arrays.
 *
 * Returns entries in reverse order (as Node does): each entry is
 * `[operation, line]` where operation is -1 delete, 0 keep, 1 insert.
 */
export function myersDiff(
    actual: string[],
    expected: string[],
    checkCommaDisparity = false,
): DiffEntry[] {
    const actualLength = actual.length;
    const expectedLength = expected.length;
    const max = actualLength + expectedLength;

    if (max > 2 ** 31 - 1) {
        throw new RangeError(
            `The value of "myersDiff input size" is out of range. It must be < 2^31. Received ${max}`,
        );
    }

    const v = new Int32Array(2 * max + 1);
    const trace: Int32Array[] = [];

    for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
        trace.push(new Int32Array(v));

        for (let diagonalIndex = -diffLevel; diagonalIndex <= diffLevel; diagonalIndex += 2) {
            const offset = diagonalIndex + max;
            const previousOffset = v[offset - 1];
            const nextOffset = v[offset + 1];
            let x = diagonalIndex === -diffLevel ||
                (diagonalIndex !== diffLevel && previousOffset < nextOffset)
                ? nextOffset
                : previousOffset + 1;
            let y = x - diagonalIndex;

            while (
                x < actualLength &&
                y < expectedLength &&
                areLinesEqual(actual[x], expected[y], checkCommaDisparity)
            ) {
                x++;
                y++;
            }

            v[offset] = x;

            if (x >= actualLength && y >= expectedLength) {
                return backtrack(trace, actual, expected, checkCommaDisparity, max);
            }
        }
    }
    return [];
}

function backtrack(
    trace: Int32Array[],
    actual: string[],
    expected: string[],
    checkCommaDisparity: boolean,
    max: number,
): DiffEntry[] {
    let x = actual.length;
    let y = expected.length;
    const result: DiffEntry[] = [];

    for (let diffLevel = trace.length - 1; diffLevel >= 0; diffLevel--) {
        const v = trace[diffLevel];
        const diagonalIndex = x - y;
        const offset = diagonalIndex + max;

        let prevDiagonalIndex: number;
        if (
            diagonalIndex === -diffLevel ||
            (diagonalIndex !== diffLevel && v[offset - 1] < v[offset + 1])
        ) {
            prevDiagonalIndex = diagonalIndex + 1;
        } else {
            prevDiagonalIndex = diagonalIndex - 1;
        }

        const prevX = v[prevDiagonalIndex + max];
        const prevY = prevX - prevDiagonalIndex;

        while (x > prevX && y > prevY) {
            const actualItem = actual[x - 1];
            const value = checkCommaDisparity && !actualItem.endsWith(',')
                ? expected[y - 1]
                : actualItem;
            result.push([kOperations.NOP, value]);
            x--;
            y--;
        }

        if (diffLevel > 0) {
            if (x > prevX) {
                result.push([kOperations.INSERT, actual[--x]]);
            } else {
                result.push([kOperations.DELETE, expected[--y]]);
            }
        }
    }

    return result;
}

export interface PrintedDiff {
    message: string;
    skipped: boolean;
}

/**
 * Renders a Myers diff with Node's `+`/`-`/` ` line markers, collapsing runs of
 * more than `kNopLinesToCollapse` unchanged lines into `...`.
 */
export function printMyersDiff(diff: DiffEntry[], _operator?: string): PrintedDiff {
    let message = '';
    let skipped = false;
    let nopCount = 0;

    for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
        const operation = diff[diffIdx][0];
        const value = diff[diffIdx][1];
        const previousOperation = diffIdx < diff.length - 1 ? diff[diffIdx + 1][0] : null;

        // Avoid grouping if only one line would have been grouped otherwise.
        if (previousOperation === kOperations.NOP && operation !== previousOperation) {
            if (nopCount === kNopLinesToCollapse + 1) {
                message += `  ${diff[diffIdx + 1][1]}\n`;
            } else if (nopCount === kNopLinesToCollapse + 2) {
                message += `  ${diff[diffIdx + 2][1]}\n`;
                message += `  ${diff[diffIdx + 1][1]}\n`;
            } else if (nopCount >= kNopLinesToCollapse + 3) {
                message += `...\n`;
                message += `  ${diff[diffIdx + 1][1]}\n`;
                skipped = true;
            }
            nopCount = 0;
        }

        if (operation === kOperations.INSERT) {
            message += `+ ${value}\n`;
        } else if (operation === kOperations.DELETE) {
            message += `- ${value}\n`;
        } else if (operation === kOperations.NOP) {
            if (nopCount < kNopLinesToCollapse) {
                message += `  ${value}\n`;
            }
            nopCount++;
        }
    }

    message = message.replace(/\s+$/, '');
    return { message: `\n${message}`, skipped };
}

/**
 * Public-shaped helper matching Node's `util.diff`: returns the diff in forward
 * order, or `[]` when the inputs are identical.
 */
export function diff(actual: string | string[], expected: string | string[]): DiffEntry[] {
    if (actual === expected) return [];
    const a = Array.isArray(actual) ? actual : String(actual).split('\n');
    const e = Array.isArray(expected) ? expected : String(expected).split('\n');
    return myersDiff(a, e).reverse();
}

/**
 * Node's `inspectValue` from internal/assert/assertion_error: the exact option
 * set assert uses, which yields indented multi-line output suitable for a
 * line-by-line diff. Verified byte-identical to Node on 33/34 shapes (the one
 * difference is V8 stack text inside a throwing getter).
 */
export function inspectForAssert(value: unknown): string {
    return inspect(value, {
        compact: false,
        customInspect: false,
        depth: 1000,
        maxArrayLength: Infinity,
        // assert compares only enumerable properties.
        showHidden: false,
        showProxy: false,
        sorted: true,
        // Inspect getters, since assert also compares them.
        getters: true,
    });
}

const kMaxShortStringLength = 12;

/**
 * Node's isSimpleDiff: when both sides render on a single line and at least one
 * is not an object, assert prints `actual !== expected` rather than a marked
 * diff.
 */
function isSimpleDiff(
    actual: unknown,
    inspectedActualLines: string[],
    expected: unknown,
    inspectedExpectedLines: string[],
): boolean {
    if (inspectedActualLines.length > 1 || inspectedExpectedLines.length > 1) return false;
    return typeof actual !== 'object' || actual === null ||
        typeof expected !== 'object' || expected === null;
}

/** Node's getStackedDiff: two stacked lines plus a `^` column indicator. */
function getStackedDiff(actual: string, expected: string): { message: string } {
    let message = `\n+ ${actual}\n- ${expected}`;
    const stringsLen = actual.length + expected.length;
    const showIndicator = stringsLen <= 80;

    if (showIndicator) {
        let indicatorIdx = -1;
        for (let i = 0; i < actual.length; i++) {
            if (actual[i] !== expected[i]) {
                // Node skips the indicator for the first characters, where the
                // difference is already obvious (3 to account for the quote).
                if (i >= 3) indicatorIdx = i;
                break;
            }
        }
        if (indicatorIdx !== -1) {
            message += `\n${' '.repeat(indicatorIdx + 2)}^`;
        }
    }
    return { message };
}

/** Node's getSimpleDiff. */
function getSimpleDiff(
    originalActual: unknown,
    actual: string,
    originalExpected: unknown,
    expected: string,
): { message: string; header?: string } {
    let stringsLen = actual.length + expected.length;
    // Account for the quotes wrapping strings.
    if (typeof originalActual === 'string') stringsLen -= 2;
    if (typeof originalExpected === 'string') stringsLen -= 2;
    if (stringsLen <= kMaxShortStringLength && (originalActual !== 0 || originalExpected !== 0)) {
        return { message: `${actual} !== ${expected}`, header: '' };
    }
    return getStackedDiff(actual, expected);
}

/**
 * One-call helper for assert's `buildGeneratedMessage`: inspects both sides with
 * assert's options and returns Node's diff body, choosing between the simple
 * one-line form and the `+ actual` / `- expected` marked form exactly as Node
 * does.
 *
 * Compose the final message as Node's createErrDiff does:
 *   `${errorMessage}\n${header}${skipped ? '\n... Skipped lines' : ''}\n${message}\n`
 * where `header` is `'+ actual - expected'` unless this returns `header: ''`.
 */
export function inspectDiff(
    actual: unknown,
    expected: unknown,
): {
    actual: string;
    expected: string;
    message: string;
    header?: string;
    skipped: boolean;
    identical: boolean;
} {
    const inspectedActual = inspectForAssert(actual);
    const inspectedExpected = inspectForAssert(expected);
    const splitActual = inspectedActual.split('\n');
    const splitExpected = inspectedExpected.split('\n');

    if (isSimpleDiff(actual, splitActual, expected, splitExpected)) {
        const simple = getSimpleDiff(actual, splitActual[0], expected, splitExpected[0]);
        return {
            actual: inspectedActual,
            expected: inspectedExpected,
            message: simple.message,
            header: simple.header,
            skipped: false,
            // Callers must only reach here after an equality check has failed
            // (as assert does). Flag the degenerate case rather than silently
            // emitting "X !== X".
            identical: inspectedActual === inspectedExpected,
        };
    }

    if (inspectedActual === inspectedExpected) {
        // Structurally equal but not the same reference.
        return {
            actual: inspectedActual,
            expected: inspectedExpected,
            message: inspectedActual,
            header: '',
            skipped: false,
            identical: true,
        };
    }

    const checkCommaDisparity = actual !== null && typeof actual === 'object';
    const entries = myersDiff(splitActual, splitExpected, checkCommaDisparity);
    const printed = printMyersDiff(entries);
    return {
        actual: inspectedActual,
        expected: inspectedExpected,
        message: printed.message,
        skipped: printed.skipped,
        identical: false,
    };
}
