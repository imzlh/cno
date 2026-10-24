/**
 * Error helpers shared across the Node polyfill.
 *
 * `code` lives in this module rather than in each caller so that the declared
 * return type carries it: a function typed `(): TypeError` loses `code` at
 * every call site even though the property is set at runtime.
 */

// Node attaches a `.code` to nearly every error it throws; bare Error/TypeError
// is a detectable divergence for callers that branch on err.code.
export function withCode<E extends Error>(error: E, code: string): E & { code: string } {
    const err = error as E & { code: string };
    err.code = code;
    return err;
}
