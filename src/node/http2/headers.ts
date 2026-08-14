/**
 * node:http2 header validation and conversion helpers.
 *
 * Mirrors node/lib/internal/http2/compat.js plus the header<->pair conversions
 * and the content-length integrity check the stream classes rely on.
 */

import type { H2Header } from '@cnojs/http/h2-native';
import { invalidArgType, invalidArgValue } from './errors';

/* ── Node header-validation helpers (compat layer) ──────────────
 * These mirror node/lib/internal/http2/compat.js. Measured against node
 * v24.18.0 rather than ported blind; each divergence is commented.
 */

// Node: checkIsHttpToken() — RFC 7230 3.2.6 tchar set.
export const HTTP_TOKEN_RE = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;

export const PSEUDO_HEADERS = new Set([':status', ':method', ':scheme', ':authority', ':path', ':protocol']);

export function validateHeaderNameArg(name: unknown): string {
    if (typeof name !== 'string') throw invalidArgType('name', 'of type string', name);
    return name;
}

/**
 * Node's assertValidHeader. Runs on the ALREADY-TRIMMED, lowercased name, so
 * `' '` and `''` both land on the empty-token branch while `' a'` is fine.
 */
export function assertValidHeader(name: string, value: unknown): void {
    if (name === '' || name.includes(' ')) {
        throw Object.assign(
            new TypeError(`Header name must be a valid HTTP token ["${name}"]`),
            { code: 'ERR_INVALID_HTTP_TOKEN' },
        );
    }
    if (PSEUDO_HEADERS.has(name)) {
        throw Object.assign(
            new TypeError('Cannot set HTTP/2 pseudo-headers'),
            { code: 'ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED' },
        );
    }
    if (value === undefined || value === null) {
        throw Object.assign(
            new TypeError(`Invalid value "${String(value)}" for header "${name}"`),
            { code: 'ERR_HTTP2_INVALID_HEADER_VALUE' },
        );
    }
}

/** Node: only `connection` is policed here, and only `trailers` survives. */
export function isConnectionHeaderAllowed(name: string, value: unknown): boolean {
    return name !== 'connection' || value === 'trailers';
}

// Node's validateLinkHeaderValue: each entry must be `<uri>` plus optional
// `; key=value` params. Anything else is ERR_INVALID_ARG_VALUE on 'hints'.
export const LINK_VALUE_RE = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s]+(?:=(?:"[^"]*"|[^;"\s]*))?)*$/;
export const LINK_HINT_REASON = 'must be an array or string of format "</styles.css>; rel=preload; as=style"';

export function validateLinkHeaderFormat(value: unknown): string {
    if (typeof value !== 'string' || !LINK_VALUE_RE.test(value.trim())) {
        throw invalidArgValue('hints', value, LINK_HINT_REASON);
    }
    return value;
}

export function validateLinkHeaderValue(hints: unknown): string {
    if (typeof hints === 'string') return validateLinkHeaderFormat(hints);
    if (Array.isArray(hints)) {
        if (hints.length === 0) return '';
        return hints.map(validateLinkHeaderFormat).join(', ');
    }
    return validateLinkHeaderFormat(hints);
}

export function headerObject(pairs: H2Header[]): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [n, v] of pairs) {
        const key = n.toLowerCase();
        const prev = out[key];
        if (prev === undefined) out[key] = v;
        else if (Array.isArray(prev)) prev.push(v);
        else out[key] = [prev, v];
    }
    return out;
}

export function toHeaderPairs(headers: Record<string, unknown>): H2Header[] {
    const pairs: H2Header[] = [];
    for (const [k, v] of Object.entries(headers)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            for (const item of v) pairs.push([k, String(item)]);
        } else {
            pairs.push([k, String(v)]);
        }
    }
    return pairs;
}

/**
 * Declared `content-length`, or null when absent/unusable.
 *
 * Load-bearing for data integrity, not just a nicety. @cnojs/http/h2 records
 * end-of-body in a single `ended` flag that is set identically by a real
 * END_STREAM, by acceptEnd(), and by acceptClose() — and acceptClose() only
 * raises a stream error when the RST_STREAM code is non-zero. nghttp2's
 * cb_stream_close (http/ext-h2/http2.c:388) fires for every close with the wire
 * code verbatim, so a peer that sends HEADERS + partial DATA + RST_STREAM(0)
 * produces a stream that is byte-for-byte indistinguishable from a clean
 * finish: the consumer sees `end`, readableEnded === true, and no error.
 * nghttp2's own content-length validation cannot cover this — it only runs on a
 * real END_STREAM, and RST_STREAM is a legitimate early termination.
 *
 * Comparing delivered bytes against the declared length is therefore the only
 * signal available at this layer. It also catches the opposite direction: h2's
 * acceptData() guards on `closed` but not on `ended`, so DATA arriving after
 * END_STREAM is appended to a body the consumer has not read yet.
 */
export function declaredContentLength(pairs: H2Header[] | null): number | null {
    if (!pairs) return null;
    let found: number | null = null;
    for (const [name, value] of pairs) {
        if (name.toLowerCase() !== 'content-length') continue;
        // Must be a bare non-negative integer; anything else is not a length we
        // can hold the peer to, and a duplicate that disagrees is unusable.
        if (!/^\d+$/.test(value.trim())) return null;
        const n = Number(value.trim());
        if (!Number.isSafeInteger(n)) return null;
        if (found !== null && found !== n) return null;
        found = n;
    }
    return found;
}

export function contentLengthMismatch(
    id: number, expected: number, actual: number,
): Error & { code: string } {
    return Object.assign(
        new Error(
            `HTTP/2 stream ${id} body is ${actual} bytes but content-length declared `
            + `${expected} (stream ended without a complete body)`,
        ),
        { code: 'ERR_HTTP2_STREAM_ERROR' },
    );
}
