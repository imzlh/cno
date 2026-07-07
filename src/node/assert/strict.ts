import {
    assert,
    AssertionError,
    CallTracker,
    deepStrictEqual,
    doesNotMatch,
    doesNotReject,
    doesNotThrow,
    fail,
    ifError,
    match,
    notDeepStrictEqual,
    notStrictEqual,
    ok,
    partialDeepStrictEqual,
    rejects,
    strictEqual,
    throws,
} from './mod';

export {
    assert,
    AssertionError,
    CallTracker,
    deepStrictEqual,
    doesNotMatch,
    doesNotReject,
    doesNotThrow,
    fail,
    ifError,
    match,
    notDeepStrictEqual,
    notStrictEqual,
    ok,
    partialDeepStrictEqual,
    rejects,
    strictEqual,
    throws,
};

export const equal = strictEqual;
export const notEqual = notStrictEqual;
export const deepEqual = deepStrictEqual;
export const notDeepEqual = notDeepStrictEqual;

const strictBase = Object.assign(assert, {
    AssertionError,
    CallTracker,
    ok,
    fail,
    equal,
    notEqual,
    strictEqual,
    notStrictEqual,
    deepEqual,
    notDeepEqual,
    deepStrictEqual,
    notDeepStrictEqual,
    throws,
    doesNotThrow,
    rejects,
    doesNotReject,
    match,
    doesNotMatch,
    ifError,
    partialDeepStrictEqual,
});
const strict = Object.assign(strictBase, { strict: strictBase });

export default strict;
