/**
 * node:http2 — real HTTP/2 via @cnojs/http h2 adapter (nghttp2 Session).
 * Cleartext prior-knowledge (h2c) and TLS+ALPN h2 when the socket is already TLS.
 */

const engine = import.meta.use('engine');

import { EventEmitter } from '../events';
import { Duplex, Readable, Writable } from '../stream';
import { Buffer } from '../buffer';
import { Socket, Server as NetServer, connect as netConnect } from '../net';
import * as tls from '../tls';
import type { TLSSocket } from '../tls';
import { H2Connection, type H2Stream as ProtocolH2Stream } from '@cnojs/http/h2';
import { TcpSocket } from '@cnojs/http/socket';
import { h2Available } from '@cnojs/http/h2-native';
import type { H2Header } from '@cnojs/http/h2-native';

export const constants = {
    // NGHTTP2 error / setting / flag / state codes
    NGHTTP2_CANCEL: 8,
    NGHTTP2_COMPRESSION_ERROR: 9,
    NGHTTP2_CONNECT_ERROR: 10,
    NGHTTP2_DEFAULT_WEIGHT: 16,
    NGHTTP2_ENHANCE_YOUR_CALM: 11,
    NGHTTP2_ERR_FRAME_SIZE_ERROR: -522,
    NGHTTP2_FLAG_ACK: 1,
    NGHTTP2_FLAG_END_HEADERS: 4,
    NGHTTP2_FLAG_END_STREAM: 1,
    NGHTTP2_FLAG_NONE: 0,
    NGHTTP2_FLAG_PADDED: 8,
    NGHTTP2_FLAG_PRIORITY: 32,
    NGHTTP2_FLOW_CONTROL_ERROR: 3,
    NGHTTP2_FRAME_SIZE_ERROR: 6,
    NGHTTP2_HTTP_1_1_REQUIRED: 13,
    NGHTTP2_INADEQUATE_SECURITY: 12,
    NGHTTP2_INTERNAL_ERROR: 2,
    NGHTTP2_NO_ERROR: 0,
    NGHTTP2_PROTOCOL_ERROR: 1,
    NGHTTP2_REFUSED_STREAM: 7,
    NGHTTP2_SESSION_CLIENT: 1,
    NGHTTP2_SESSION_SERVER: 0,
    NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
    NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
    NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
    NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
    NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
    NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
    NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
    NGHTTP2_SETTINGS_TIMEOUT: 4,
    NGHTTP2_STREAM_CLOSED: 5,
    NGHTTP2_STREAM_STATE_CLOSED: 7,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
    NGHTTP2_STREAM_STATE_IDLE: 1,
    NGHTTP2_STREAM_STATE_OPEN: 2,
    NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
    NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4,

    // Default and boundary setting values
    DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0,
    DEFAULT_SETTINGS_ENABLE_PUSH: 1,
    DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
    DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535,
    DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295,
    DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384,
    DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,
    MAX_INITIAL_WINDOW_SIZE: 2147483647,
    MAX_MAX_FRAME_SIZE: 16777215,
    MIN_MAX_FRAME_SIZE: 16384,

    // Padding strategies
    PADDING_STRATEGY_ALIGNED: 1,
    PADDING_STRATEGY_CALLBACK: 1,
    PADDING_STRATEGY_MAX: 2,
    PADDING_STRATEGY_NONE: 0,

    // Header field names
    HTTP2_HEADER_ACCEPT: "accept",
    HTTP2_HEADER_ACCEPT_CHARSET: "accept-charset",
    HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding",
    HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language",
    HTTP2_HEADER_ACCEPT_RANGES: "accept-ranges",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: "access-control-allow-credentials",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: "access-control-allow-headers",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: "access-control-allow-methods",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: "access-control-allow-origin",
    HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: "access-control-expose-headers",
    HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: "access-control-max-age",
    HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: "access-control-request-headers",
    HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: "access-control-request-method",
    HTTP2_HEADER_AGE: "age",
    HTTP2_HEADER_ALLOW: "allow",
    HTTP2_HEADER_ALT_SVC: "alt-svc",
    HTTP2_HEADER_AUTHORITY: ":authority",
    HTTP2_HEADER_AUTHORIZATION: "authorization",
    HTTP2_HEADER_CACHE_CONTROL: "cache-control",
    HTTP2_HEADER_CONNECTION: "connection",
    HTTP2_HEADER_CONTENT_DISPOSITION: "content-disposition",
    HTTP2_HEADER_CONTENT_ENCODING: "content-encoding",
    HTTP2_HEADER_CONTENT_LANGUAGE: "content-language",
    HTTP2_HEADER_CONTENT_LENGTH: "content-length",
    HTTP2_HEADER_CONTENT_LOCATION: "content-location",
    HTTP2_HEADER_CONTENT_MD5: "content-md5",
    HTTP2_HEADER_CONTENT_RANGE: "content-range",
    HTTP2_HEADER_CONTENT_SECURITY_POLICY: "content-security-policy",
    HTTP2_HEADER_CONTENT_TYPE: "content-type",
    HTTP2_HEADER_COOKIE: "cookie",
    HTTP2_HEADER_DATE: "date",
    HTTP2_HEADER_DNT: "dnt",
    HTTP2_HEADER_EARLY_DATA: "early-data",
    HTTP2_HEADER_ETAG: "etag",
    HTTP2_HEADER_EXPECT: "expect",
    HTTP2_HEADER_EXPECT_CT: "expect-ct",
    HTTP2_HEADER_EXPIRES: "expires",
    HTTP2_HEADER_FORWARDED: "forwarded",
    HTTP2_HEADER_FROM: "from",
    HTTP2_HEADER_HOST: "host",
    HTTP2_HEADER_HTTP2_SETTINGS: "http2-settings",
    HTTP2_HEADER_IF_MATCH: "if-match",
    HTTP2_HEADER_IF_MODIFIED_SINCE: "if-modified-since",
    HTTP2_HEADER_IF_NONE_MATCH: "if-none-match",
    HTTP2_HEADER_IF_RANGE: "if-range",
    HTTP2_HEADER_IF_UNMODIFIED_SINCE: "if-unmodified-since",
    HTTP2_HEADER_KEEP_ALIVE: "keep-alive",
    HTTP2_HEADER_LAST_MODIFIED: "last-modified",
    HTTP2_HEADER_LINK: "link",
    HTTP2_HEADER_LOCATION: "location",
    HTTP2_HEADER_MAX_FORWARDS: "max-forwards",
    HTTP2_HEADER_METHOD: ":method",
    HTTP2_HEADER_ORIGIN: "origin",
    HTTP2_HEADER_PATH: ":path",
    HTTP2_HEADER_PREFER: "prefer",
    HTTP2_HEADER_PRIORITY: "priority",
    HTTP2_HEADER_PROTOCOL: ":protocol",
    HTTP2_HEADER_PROXY_AUTHENTICATE: "proxy-authenticate",
    HTTP2_HEADER_PROXY_AUTHORIZATION: "proxy-authorization",
    HTTP2_HEADER_PROXY_CONNECTION: "proxy-connection",
    HTTP2_HEADER_PURPOSE: "purpose",
    HTTP2_HEADER_RANGE: "range",
    HTTP2_HEADER_REFERER: "referer",
    HTTP2_HEADER_REFRESH: "refresh",
    HTTP2_HEADER_RETRY_AFTER: "retry-after",
    HTTP2_HEADER_SCHEME: ":scheme",
    HTTP2_HEADER_SERVER: "server",
    HTTP2_HEADER_SET_COOKIE: "set-cookie",
    HTTP2_HEADER_STATUS: ":status",
    HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: "strict-transport-security",
    HTTP2_HEADER_TE: "te",
    HTTP2_HEADER_TIMING_ALLOW_ORIGIN: "timing-allow-origin",
    HTTP2_HEADER_TK: "tk",
    HTTP2_HEADER_TRAILER: "trailer",
    HTTP2_HEADER_TRANSFER_ENCODING: "transfer-encoding",
    HTTP2_HEADER_UPGRADE: "upgrade",
    HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: "upgrade-insecure-requests",
    HTTP2_HEADER_USER_AGENT: "user-agent",
    HTTP2_HEADER_VARY: "vary",
    HTTP2_HEADER_VIA: "via",
    HTTP2_HEADER_WARNING: "warning",
    HTTP2_HEADER_WWW_AUTHENTICATE: "www-authenticate",
    HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: "x-content-type-options",
    HTTP2_HEADER_X_FORWARDED_FOR: "x-forwarded-for",
    HTTP2_HEADER_X_FRAME_OPTIONS: "x-frame-options",
    HTTP2_HEADER_X_XSS_PROTECTION: "x-xss-protection",

    // Request methods
    HTTP2_METHOD_ACL: "ACL",
    HTTP2_METHOD_BASELINE_CONTROL: "BASELINE-CONTROL",
    HTTP2_METHOD_BIND: "BIND",
    HTTP2_METHOD_CHECKIN: "CHECKIN",
    HTTP2_METHOD_CHECKOUT: "CHECKOUT",
    HTTP2_METHOD_CONNECT: "CONNECT",
    HTTP2_METHOD_COPY: "COPY",
    HTTP2_METHOD_DELETE: "DELETE",
    HTTP2_METHOD_GET: "GET",
    HTTP2_METHOD_HEAD: "HEAD",
    HTTP2_METHOD_LABEL: "LABEL",
    HTTP2_METHOD_LINK: "LINK",
    HTTP2_METHOD_LOCK: "LOCK",
    HTTP2_METHOD_MERGE: "MERGE",
    HTTP2_METHOD_MKACTIVITY: "MKACTIVITY",
    HTTP2_METHOD_MKCALENDAR: "MKCALENDAR",
    HTTP2_METHOD_MKCOL: "MKCOL",
    HTTP2_METHOD_MKREDIRECTREF: "MKREDIRECTREF",
    HTTP2_METHOD_MKWORKSPACE: "MKWORKSPACE",
    HTTP2_METHOD_MOVE: "MOVE",
    HTTP2_METHOD_OPTIONS: "OPTIONS",
    HTTP2_METHOD_ORDERPATCH: "ORDERPATCH",
    HTTP2_METHOD_PATCH: "PATCH",
    HTTP2_METHOD_POST: "POST",
    HTTP2_METHOD_PRI: "PRI",
    HTTP2_METHOD_PROPFIND: "PROPFIND",
    HTTP2_METHOD_PROPPATCH: "PROPPATCH",
    HTTP2_METHOD_PUT: "PUT",
    HTTP2_METHOD_REBIND: "REBIND",
    HTTP2_METHOD_REPORT: "REPORT",
    HTTP2_METHOD_SEARCH: "SEARCH",
    HTTP2_METHOD_TRACE: "TRACE",
    HTTP2_METHOD_UNBIND: "UNBIND",
    HTTP2_METHOD_UNCHECKOUT: "UNCHECKOUT",
    HTTP2_METHOD_UNLINK: "UNLINK",
    HTTP2_METHOD_UNLOCK: "UNLOCK",
    HTTP2_METHOD_UPDATE: "UPDATE",
    HTTP2_METHOD_UPDATEREDIRECTREF: "UPDATEREDIRECTREF",
    HTTP2_METHOD_VERSION_CONTROL: "VERSION-CONTROL",

    // Status codes
    HTTP_STATUS_ACCEPTED: 202,
    HTTP_STATUS_ALREADY_REPORTED: 208,
    HTTP_STATUS_BAD_GATEWAY: 502,
    HTTP_STATUS_BAD_REQUEST: 400,
    HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509,
    HTTP_STATUS_CONFLICT: 409,
    HTTP_STATUS_CONTINUE: 100,
    HTTP_STATUS_CREATED: 201,
    HTTP_STATUS_EARLY_HINTS: 103,
    HTTP_STATUS_EXPECTATION_FAILED: 417,
    HTTP_STATUS_FAILED_DEPENDENCY: 424,
    HTTP_STATUS_FORBIDDEN: 403,
    HTTP_STATUS_FOUND: 302,
    HTTP_STATUS_GATEWAY_TIMEOUT: 504,
    HTTP_STATUS_GONE: 410,
    HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505,
    HTTP_STATUS_IM_USED: 226,
    HTTP_STATUS_INSUFFICIENT_STORAGE: 507,
    HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
    HTTP_STATUS_LENGTH_REQUIRED: 411,
    HTTP_STATUS_LOCKED: 423,
    HTTP_STATUS_LOOP_DETECTED: 508,
    HTTP_STATUS_METHOD_NOT_ALLOWED: 405,
    HTTP_STATUS_MISDIRECTED_REQUEST: 421,
    HTTP_STATUS_MOVED_PERMANENTLY: 301,
    HTTP_STATUS_MULTIPLE_CHOICES: 300,
    HTTP_STATUS_MULTI_STATUS: 207,
    HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511,
    HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203,
    HTTP_STATUS_NOT_ACCEPTABLE: 406,
    HTTP_STATUS_NOT_EXTENDED: 510,
    HTTP_STATUS_NOT_FOUND: 404,
    HTTP_STATUS_NOT_IMPLEMENTED: 501,
    HTTP_STATUS_NOT_MODIFIED: 304,
    HTTP_STATUS_NO_CONTENT: 204,
    HTTP_STATUS_OK: 200,
    HTTP_STATUS_PARTIAL_CONTENT: 206,
    HTTP_STATUS_PAYLOAD_TOO_LARGE: 413,
    HTTP_STATUS_PAYMENT_REQUIRED: 402,
    HTTP_STATUS_PERMANENT_REDIRECT: 308,
    HTTP_STATUS_PRECONDITION_FAILED: 412,
    HTTP_STATUS_PRECONDITION_REQUIRED: 428,
    HTTP_STATUS_PROCESSING: 102,
    HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407,
    HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416,
    HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
    HTTP_STATUS_REQUEST_TIMEOUT: 408,
    HTTP_STATUS_RESET_CONTENT: 205,
    HTTP_STATUS_SEE_OTHER: 303,
    HTTP_STATUS_SERVICE_UNAVAILABLE: 503,
    HTTP_STATUS_SWITCHING_PROTOCOLS: 101,
    HTTP_STATUS_TEAPOT: 418,
    HTTP_STATUS_TEMPORARY_REDIRECT: 307,
    HTTP_STATUS_TOO_EARLY: 425,
    HTTP_STATUS_TOO_MANY_REQUESTS: 429,
    HTTP_STATUS_UNAUTHORIZED: 401,
    HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451,
    HTTP_STATUS_UNPROCESSABLE_ENTITY: 422,
    HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415,
    HTTP_STATUS_UPGRADE_REQUIRED: 426,
    HTTP_STATUS_URI_TOO_LONG: 414,
    HTTP_STATUS_USE_PROXY: 305,
    HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506,
};

// Node exposes each constant as non-writable/non-configurable, while the
// object itself stays extensible and unfrozen. Verified on node v24.18.0.
for (const constantName of Object.keys(constants)) {
    Object.defineProperty(constants, constantName, {
        value: (constants as Record<string, unknown>)[constantName],
        writable: false,
        enumerable: true,
        configurable: false,
    });
}
// Marks header values that must never enter the HPACK dynamic table.
// Node uses an unregistered symbol, so match that rather than Symbol.for.
export const sensitiveHeaders = Symbol('sensitiveHeaders');

// Node's ERR_INVALID_ARG_TYPE "Received …" suffix, for the common cases.
function describeReceived(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'string') return `type string ('${value as string}')`;
    if (type === 'number' || type === 'boolean' || type === 'bigint' || type === 'symbol') {
        return `type ${type} (${String(value)})`;
    }
    if (type === 'function') return `function ${(value as () => void).name}`;
    const name = Object.getPrototypeOf(value) === null ? null : (value as object).constructor?.name;
    return name ? `an instance of ${name}` : '[Object: null prototype] {}';
}

/* ── Node-shaped errors ───────────────────────────────────────────
 * Every error on the connection/server path carries a `.code`. Callers in this
 * module's ecosystem branch on `err.code`, and a bare `Error` makes an h2
 * failure indistinguishable from an unrelated one.
 */

function invalidArgType(name: string, expected: string, value: unknown): TypeError & { code: string } {
    return Object.assign(
        new TypeError(`The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`),
        { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

function invalidUrl(input: unknown): TypeError & { code: string; input?: string } {
    return Object.assign(new TypeError('Invalid URL'), {
        code: 'ERR_INVALID_URL',
        input: typeof input === 'string' ? input : String(input),
    });
}

function unsupportedProtocol(protocol: string): Error & { code: string } {
    return Object.assign(new Error(`protocol "${protocol}" is unsupported.`), {
        code: 'ERR_HTTP2_UNSUPPORTED_PROTOCOL',
    });
}

function h2Unavailable(): Error & { code: string } {
    // Message text is load-bearing for existing tests; the code is the new part.
    return Object.assign(
        new Error('HTTP/2 is not available in this build (compile with -DCNO_EMBED_EXT_H2=ON)'),
        { code: 'ERR_HTTP2_UNAVAILABLE' },
    );
}

function h2Error(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

function ensureH2(): void {
    if (!h2Available()) throw h2Unavailable();
}

/* ── Node header-validation helpers (compat layer) ──────────────
 * These mirror node/lib/internal/http2/compat.js. Measured against node
 * v24.18.0 rather than ported blind; each divergence is commented.
 */

// Node: checkIsHttpToken() — RFC 7230 3.2.6 tchar set.
const HTTP_TOKEN_RE = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;

const PSEUDO_HEADERS = new Set([':status', ':method', ':scheme', ':authority', ':path', ':protocol']);

function invalidArgValue(name: string, value: unknown, reason?: string): TypeError & { code: string } {
    const shown = typeof value === 'string' ? `'${value}'` : describeReceived(value);
    return Object.assign(
        new TypeError(`The argument '${name}' ${reason ?? 'is invalid'}. Received ${shown}`),
        { code: 'ERR_INVALID_ARG_VALUE' },
    );
}

function validateHeaderNameArg(name: unknown): string {
    if (typeof name !== 'string') throw invalidArgType('name', 'of type string', name);
    return name;
}

function headersSentError(): Error & { code: string } {
    return Object.assign(
        new Error('Response has already been initiated.'),
        { code: 'ERR_HTTP2_HEADERS_SENT' },
    );
}

/**
 * Node's assertValidHeader. Runs on the ALREADY-TRIMMED, lowercased name, so
 * `' '` and `''` both land on the empty-token branch while `' a'` is fine.
 */
function assertValidHeader(name: string, value: unknown): void {
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
function isConnectionHeaderAllowed(name: string, value: unknown): boolean {
    return name !== 'connection' || value === 'trailers';
}

function warnOnce(flag: { fired: boolean }, message: string): void {
    if (flag.fired) return;
    flag.fired = true;
    try {
        process.emitWarning(message, 'UnsupportedWarning');
    } catch {
        /* emitWarning unavailable */
    }
}

const connectionHeaderWarned = { fired: false };
const statusMessageWarned = { fired: false };

function statusMessageWarn(): void {
    warnOnce(statusMessageWarned, 'Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)');
}

function invalidStatus(code: number): RangeError & { code: string } {
    return Object.assign(
        new RangeError(`Invalid status code: ${code}`),
        { code: 'ERR_HTTP2_STATUS_INVALID' },
    );
}

/**
 * Node's `set statusCode`: coerce with `|0`, reject 1xx and anything outside
 * 100..599. `|0` is what makes '200' → 200 and 200.9 → 200, and what turns
 * NaN/null/undefined/true into 0 → ERR_HTTP2_STATUS_INVALID.
 */
function validateStatusCode(code: unknown): number {
    const n = (code as number) | 0;
    if (n >= 100 && n < 200) {
        throw Object.assign(
            new RangeError('Responding with 1xx status codes is not supported'),
            { code: 'ERR_HTTP2_INFO_STATUS_NOT_ALLOWED' },
        );
    }
    if (n < 100 || n > 599) throw invalidStatus(n);
    return n;
}

// Node's validateLinkHeaderValue: each entry must be `<uri>` plus optional
// `; key=value` params. Anything else is ERR_INVALID_ARG_VALUE on 'hints'.
const LINK_VALUE_RE = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s]+(?:=(?:"[^"]*"|[^;"\s]*))?)*$/;
const LINK_HINT_REASON = 'must be an array or string of format "</styles.css>; rel=preload; as=style"';

function validateLinkHeaderFormat(value: unknown): string {
    if (typeof value !== 'string' || !LINK_VALUE_RE.test(value.trim())) {
        throw invalidArgValue('hints', value, LINK_HINT_REASON);
    }
    return value;
}

function validateLinkHeaderValue(hints: unknown): string {
    if (typeof hints === 'string') return validateLinkHeaderFormat(hints);
    if (Array.isArray(hints)) {
        if (hints.length === 0) return '';
        return hints.map(validateLinkHeaderFormat).join(', ');
    }
    return validateLinkHeaderFormat(hints);
}

function headerObject(pairs: H2Header[]): Record<string, string | string[]> {
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

/**
 * `req.socket` / `res.socket` for the compat classes.
 *
 * Node returns a Proxy over the Http2Stream that forwards a fixed whitelist of
 * socket properties to the session's real socket and everything else to the
 * stream. It caches that Proxy on the stream, which is what makes
 * `req.socket === res.socket` hold for one request — so the cache is keyed on
 * the stream here too, not on the request.
 *
 * DELIBERATE DIVERGENCE: when the session's real socket is reachable we return
 * it directly instead of wrapping it. Node's Proxy exists to keep `destroy()`
 * and friends pointed at the stream rather than tearing down the whole
 * connection; we get the same by preferring the socket only for the read-only
 * address/encryption properties. Returning a live socket makes
 * `req.socket.remoteAddress` work, which is the single most common use of this
 * property (logging, rate-limiting) and which throws on Node whenever the
 * session socket is not wired up.
 */
const proxySocketCache = new WeakMap<object, object>();

const SOCKET_PASSTHROUGH = new Set([
    'address', 'localAddress', 'localPort', 'remoteAddress', 'remoteFamily',
    'remotePort', 'encrypted', 'authorized', 'authorizationError',
    'getPeerCertificate', 'getCipher', 'getProtocol', 'alpnProtocol',
    'servername', 'bytesRead', 'bytesWritten', 'ref', 'unref',
]);

function sessionSocketFor(state: { stream: ServerHttp2Stream }): unknown {
    const stream = state.stream as unknown as {
        session?: { socket?: unknown };
    } & object;
    const cached = proxySocketCache.get(stream);
    if (cached) return cached;
    const real = stream.session?.socket as Record<string, unknown> | undefined;
    const proxy = new Proxy(stream, {
        get(target, prop, recv) {
            if (real && typeof prop === 'string' && SOCKET_PASSTHROUGH.has(prop)) {
                const v = (real as Record<string, unknown>)[prop];
                return typeof v === 'function' ? (v as () => unknown).bind(real) : v;
            }
            const v = Reflect.get(target, prop, recv);
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v;
        },
        set(target, prop, value) {
            if (real && typeof prop === 'string' && SOCKET_PASSTHROUGH.has(prop)) {
                (real as Record<string, unknown>)[prop] = value;
                return true;
            }
            return Reflect.set(target, prop, value);
        },
        has(target, prop) {
            if (real && typeof prop === 'string' && SOCKET_PASSTHROUGH.has(prop)) return prop in real;
            return Reflect.has(target, prop);
        },
    });
    proxySocketCache.set(stream, proxy);
    return proxy;
}


function toHeaderPairs(headers: Record<string, unknown>): H2Header[] {
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
function declaredContentLength(pairs: H2Header[] | null): number | null {
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

function contentLengthMismatch(
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

/** Steal TCP from a Node Socket so nghttp2 owns the read loop (no dual onread). */
function takeTcpForH2(socket: Socket): TcpSocket {
    const tcp = socket._tcp;
    if (!tcp) throw h2Error('ERR_HTTP2_SOCKET_UNBOUND', 'socket has no TCP handle');
    // Same ownership model as node:http ServerImpl.socketForCoreRequest:
    // Node facade keeps addresses; wire I/O is exclusive to the protocol layer.
    socket._httpOwned = {
        close: () => {
            try {
                tcp.close();
            } catch {
                /* already closed */
            }
        },
    };
    try {
        tcp.stopRead();
    } catch {
        /* not reading */
    }
    Reflect.set(tcp, 'onread', null);
    Reflect.set(socket, '_tcpReadStarted', false);
    const transport = new TcpSocket(tcp);
    transport.close = () => socket.destroy();
    return transport;
}

/**
 * Steal a completed TLSSocket into TcpSocket for H2.
 * Detaches Node duplex pumps so only nghttp2 + TcpSocket own cipher/plain I/O.
 */
function takeTlsForH2(tlsSocket: TLSSocket): TcpSocket {
    const underlying = tlsSocket._underlying;
    const sslPipe = tlsSocket._sslPipe;
    if (!underlying || !sslPipe) {
        throw h2Error('ERR_HTTP2_SOCKET_UNBOUND', 'TLS socket is not ready for HTTP/2');
    }
    try {
        if (underlying instanceof Socket) {
            try {
                underlying.pause();
            } catch {
                /* */
            }
            const tcp = underlying._tcp;
            if (!tcp) throw h2Error('ERR_HTTP2_SOCKET_UNBOUND', 'TLS underlying has no TCP handle');
            try {
                tcp.stopRead();
            } catch {
                /* */
            }
            Reflect.set(tcp, 'onread', null);
            Reflect.set(underlying, '_tcpReadStarted', false);
            underlying._httpOwned = {
                close: () => {
                    try {
                        tcp.close();
                    } catch {
                        /* */
                    }
                },
            };
            const transport = new TcpSocket(tcp);
            transport.sslPipe = sslPipe;
            tlsSocket._sslPipe = null;
            tlsSocket._underlying = null;
            const destroyTlsSocket = tlsSocket.destroy.bind(tlsSocket);
            let closing = false;
            tlsSocket.destroy = (error?: Error) => {
                if (closing) return tlsSocket;
                closing = true;
                try {
                    underlying.destroy(error);
                } finally {
                    destroyTlsSocket(error);
                }
                return tlsSocket;
            };
            transport.close = () => { tlsSocket.destroy(); };
            return transport;
        }
        // Raw CModuleStreams.Stream under TLS
        const stream = underlying as CModuleStreams.Stream;
        try {
            stream.stopRead();
        } catch {
            /* */
        }
        Reflect.set(stream, 'onread', null);
        const transport = new TcpSocket(stream);
        transport.sslPipe = sslPipe;
        tlsSocket._sslPipe = null;
        tlsSocket._underlying = null;
        const destroyTlsSocket = tlsSocket.destroy.bind(tlsSocket);
        let closing = false;
        tlsSocket.destroy = (error?: Error) => {
            if (closing) return tlsSocket;
            closing = true;
            try {
                stream.close();
            } finally {
                destroyTlsSocket(error);
            }
            return tlsSocket;
        };
        transport.close = () => { tlsSocket.destroy(); };
        return transport;
    } catch (e) {
        throw e;
    }
}

function isTlsSocket(socket: unknown): socket is TLSSocket {
    return !!socket && typeof socket === 'object'
        && Reflect.get(socket, 'encrypted') === true
        && Reflect.get(socket, '_sslPipe') != null;
}

/* ── Client stream ────────────────────────────────────────────── */

class ClientHttp2Stream extends Duplex {
    readonly id: number;
    private readonly h2Stream: ProtocolH2Stream;
    private readonly requestMethod: string;
    private bodyPumpStarted = false;
    private drainWaiter: (() => void) | null = null;

    constructor(h2Stream: ProtocolH2Stream, requestMethod = 'GET') {
        super({ allowHalfOpen: true });
        this.h2Stream = h2Stream;
        this.id = h2Stream.id;
        this.requestMethod = requestMethod.toUpperCase();
        h2Stream.whenError(error => this.destroy(error));
        h2Stream.whenHeaders((headers, _ended) => {
            this.emit('response', headerObject(headers), 0);
            // EOF is pushed by pumpBody alone. bodyChunks() returns immediately
            // when the stream is already ended, so an `ended` HEADERS still
            // reaches EOF — and routing every end through one place keeps the
            // content-length check below authoritative instead of racing a
            // second push(null) that would emit a clean `end` first.
            void this.pumpBody();
        });
    }

    /** Responses that carry no body regardless of content-length (RFC 9110 §8.6). */
    private expectsNoBody(): boolean {
        if (this.requestMethod === 'HEAD' || this.requestMethod === 'CONNECT') return true;
        const pairs = this.h2Stream.headerList;
        if (!pairs) return false;
        for (const [name, value] of pairs) {
            if (name !== ':status') continue;
            const status = Number(value);
            return status === 204 || status === 304 || (status >= 100 && status < 200);
        }
        return false;
    }

    private async pumpBody(): Promise<void> {
        if (this.bodyPumpStarted) return;
        this.bodyPumpStarted = true;
        let received = 0;
        try {
            for await (const chunk of this.h2Stream.bodyChunks()) {
                received += chunk.byteLength;
                if (!this.push(Buffer.from(chunk)) && !this.destroyed) {
                    // Stop pulling until _read() asks again. Draining regardless
                    // would move unbounded growth into this Readable's buffer.
                    await new Promise<void>(resolve => { this.drainWaiter = resolve; });
                }
            }
            // See declaredContentLength: a response truncated by RST_STREAM(0) is
            // otherwise delivered as a complete one, which silently corrupts any
            // caller that trusts the body it just read.
            const declared = this.expectsNoBody()
                ? null
                : declaredContentLength(this.h2Stream.headerList);
            if (declared !== null && declared !== received) {
                this.destroy(contentLengthMismatch(this.id, declared, received));
                return;
            }
            this.push(null);
        } catch (e) {
            this.destroy(e instanceof Error ? e : new Error(String(e)));
        }
    }

    private releaseDrain(): void {
        const waiter = this.drainWaiter;
        this.drainWaiter = null;
        waiter?.();
    }

    _read(): void {
        if (this.drainWaiter) this.releaseDrain();
        else void this.pumpBody();
    }

    _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
        this.releaseDrain();
        cb(err);
    }

    _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        try {
            const buf = typeof chunk === 'string'
                ? engine.encodeString(chunk)
                : chunk instanceof Uint8Array
                    ? chunk
                    : Buffer.from(String(chunk));
            this.h2Stream.sendData(buf, false);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    _final(cb: (e?: Error | null) => void): void {
        try {
            this.h2Stream.sendData(new Uint8Array(0), true);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    close(code?: number): void {
        this.h2Stream.abort(code ?? 0);
        this.destroy();
    }
}

/* ── Server stream (Node Http2Stream-ish) ─────────────────────── */

class ServerHttp2Stream extends Duplex {
    readonly id: number;
    private readonly h2Stream: ProtocolH2Stream;
    private responded = false;
    private bodyPumpStarted = false;
    private drainWaiter: (() => void) | null = null;

    constructor(h2Stream: ProtocolH2Stream) {
        super({ allowHalfOpen: true });
        this.h2Stream = h2Stream;
        this.id = h2Stream.id;
        h2Stream.whenError(error => this.destroy(error));
        void this.pumpBody();
    }

    private async pumpBody(): Promise<void> {
        if (this.bodyPumpStarted) return;
        this.bodyPumpStarted = true;
        let received = 0;
        try {
            for await (const chunk of this.h2Stream.bodyChunks()) {
                received += chunk.byteLength;
                if (!this.push(Buffer.from(chunk)) && !this.destroyed) {
                    // Load-bearing: h2.ts has no transport backpressure, so its
                    // 16 MiB server body cap only fires while bytes stay buffered
                    // there. Draining unconditionally would defeat that cap and
                    // grow this Readable without bound instead.
                    await new Promise<void>(resolve => { this.drainWaiter = resolve; });
                }
            }
            // bodyChunks() returned without throwing, which h2.ts does for a real
            // END_STREAM and for acceptClose(0) alike. A declared length that does
            // not match what arrived is the only way to tell a truncated body from
            // a complete one, so fail the stream rather than emit a clean `end`.
            const declared = declaredContentLength(this.h2Stream.headerList);
            if (declared !== null && declared !== received) {
                this.destroy(contentLengthMismatch(this.id, declared, received));
                return;
            }
            this.push(null);
        } catch (e) {
            this.destroy(e instanceof Error ? e : new Error(String(e)));
        }
    }

    private releaseDrain(): void {
        const waiter = this.drainWaiter;
        this.drainWaiter = null;
        waiter?.();
    }

    _read(): void {
        if (this.drainWaiter) this.releaseDrain();
        else void this.pumpBody();
    }

    _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
        this.releaseDrain();
        cb(err);
    }

    _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        try {
            if (!this.responded) {
                this.respond({ ':status': 200 });
            }
            const buf = typeof chunk === 'string'
                ? engine.encodeString(chunk)
                : chunk instanceof Uint8Array
                    ? chunk
                    : Buffer.from(String(chunk));
            this.h2Stream.sendData(buf, false);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    _final(cb: (e?: Error | null) => void): void {
        try {
            if (!this.responded) {
                this.respond({ ':status': 200 }, { endStream: true });
            } else {
                this.h2Stream.sendData(new Uint8Array(0), true);
            }
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    respond(headers: Record<string, unknown>, options?: { endStream?: boolean }): void {
        this.respondPairs(toHeaderPairs(headers), options);
    }

    respondPairs(pairs: H2Header[], options?: { endStream?: boolean }): void {
        if (this.responded) throw new Error('HTTP/2 headers already sent');
        this.responded = true;
        if (!pairs.some(([n]) => n === ':status' || n === constants.HTTP2_HEADER_STATUS)) {
            pairs.unshift([':status', '200']);
        }
        this.h2Stream.respond(pairs, options?.endStream === true);
    }

    end(chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
        return Duplex.prototype.end.call(this, chunk, encodingOrCb, cb) as this;
    }

    close(code?: number): void {
        this.h2Stream.abort(code ?? 0);
        this.destroy();
    }
}

/**
 * Node-compatible request view layered over the protocol stream.
 *
 * Prototype accessors, not instance fields. Node exposes all of these as
 * getters on Http2ServerRequest.prototype, and the difference is observable in
 * three ways real code depends on:
 *   - `'method' in Object.getPrototypeOf(req)` — how some libraries feature-test
 *     an incoming-message-alike before deciding which adapter to use;
 *   - enumerability: instance fields land in Object.keys(req) / spreads /
 *     JSON.stringify(req), so a plain `{...req}` picked up a frozen snapshot of
 *     the headers instead of nothing;
 *   - write-through: Node backs `method`/`url` with `headers[':method']` and
 *     `headers[':path']`, so connect/express rewriting `req.url` is visible to
 *     anything that later reads the header object. With independent fields the
 *     two silently disagreed.
 */
class Http2ServerRequest extends Readable {
    /** Backing state. Non-enumerable so it stays out of Object.keys/spread. */
    private readonly _s!: {
        stream: ServerHttp2Stream;
        headers: Record<string, string | string[]>;
        rawHeaders: string[];
        trailers: Record<string, string | string[]>;
        rawTrailers: string[];
        aborted: boolean;
        closed: boolean;
        socket: unknown;
    };

    /**
     * Accepts Node's documented 4-arg form `(stream, headers, options,
     * rawHeaders)` as well as this module's original `(stream, pairs)` where
     * `pairs` is an iterable of [name, value]. Discriminated on Array.isArray:
     * Node's 2nd argument is always a plain object, so the two never collide.
     */
    constructor(
        stream: ServerHttp2Stream,
        headers: H2Header[] | Record<string, string | string[]>,
        _options?: unknown,
        rawHeaders?: string[],
    ) {
        super();
        let headerObj: Record<string, string | string[]>;
        let raw: string[];
        if (Array.isArray(headers)) {
            headerObj = headerObject(headers as H2Header[]);
            // Node's rawHeaders includes the pseudo-headers; the previous
            // implementation stripped them, which lost :method/:path/:authority.
            raw = [];
            for (const [name, value] of headers as H2Header[]) raw.push(name, value);
        } else {
            headerObj = headers ?? {};
            if (Array.isArray(rawHeaders)) {
                raw = rawHeaders;
            } else {
                raw = [];
                for (const k of Object.keys(headerObj)) {
                    const v = headerObj[k];
                    if (Array.isArray(v)) for (const item of v) raw.push(k, item);
                    else raw.push(k, v as string);
                }
            }
        }
        Object.defineProperty(this, '_s', {
            value: {
                stream,
                headers: headerObj,
                rawHeaders: raw,
                trailers: {},
                rawTrailers: [],
                aborted: false,
                closed: false,
                socket: undefined,
            },
            enumerable: false, writable: false, configurable: false,
        });
        stream.on('data', (chunk: unknown) => this.push(chunk));
        stream.on('end', () => this.push(null));
        stream.on('error', (error: unknown) =>
            this.destroy(error instanceof Error ? error : new Error(String(error))));
        stream.on('close', () => {
            this._s.closed = true;
            if (!this.readableEnded) {
                this._s.aborted = true;
                this.emit('aborted');
            }
        });
        // Trailers arrive after the body; mirror them onto the request the way
        // node:http does, so `req.trailers` is populated by the time 'end' fires.
        stream.on('trailers', (trailers: Record<string, string | string[]>) => {
            Object.assign(this._s.trailers, trailers);
            for (const k of Object.keys(trailers)) {
                const v = trailers[k];
                if (Array.isArray(v)) for (const item of v) this._s.rawTrailers.push(k, item);
                else this._s.rawTrailers.push(k, v as string);
            }
        });
    }

    get stream(): ServerHttp2Stream { return this._s.stream; }
    get headers(): Record<string, string | string[]> { return this._s.headers; }
    get rawHeaders(): string[] { return this._s.rawHeaders; }
    get trailers(): Record<string, string | string[]> { return this._s.trailers; }
    get rawTrailers(): string[] { return this._s.rawTrailers; }
    get httpVersion(): string { return '2.0'; }
    get httpVersionMajor(): number { return 2; }
    get httpVersionMinor(): number { return 0; }
    get aborted(): boolean { return this._s.aborted; }

    get complete(): boolean {
        return this._s.aborted || this.readableEnded || this._s.closed
            || this._s.stream.destroyed === true;
    }

    get method(): string { return this._s.headers[':method'] as string; }

    set method(method: string) {
        if (typeof method !== 'string') throw invalidArgType('method', 'of type string', method);
        if (method.trim() === '') throw invalidArgValue('method', method);
        this._s.headers[':method'] = method;
    }

    get url(): string { return this._s.headers[':path'] as string; }
    set url(url: string) { this._s.headers[':path'] = url; }

    /** HTTP/2's replacement for the Host header: `:authority`, else `host`. */
    get authority(): string | string[] | undefined {
        return this._s.headers[':authority'] ?? this._s.headers.host;
    }

    get scheme(): string | string[] | undefined { return this._s.headers[':scheme']; }

    get socket(): unknown { return sessionSocketFor(this._s); }
    get connection(): unknown { return this.socket; }

    setTimeout(msecs: number, callback?: () => void): this {
        if (!this._s.closed) this._s.stream.setTimeout?.(msecs, callback);
        return this;
    }

    _read(): void {
        // The protocol stream is push-driven by nghttp2 callbacks.
    }
}


/** Node-compatible response view layered over the protocol stream. */
class Http2ServerResponse extends Writable {
    readonly stream: ServerHttp2Stream;
    statusCode = 200;
    statusMessage = '';
    headersSent = false;
    finished = false;
    private headers = new Map<string, { name: string; values: string[] }>();

    constructor(stream: ServerHttp2Stream) {
        super();
        this.stream = stream;
    }

    setHeader(name: string, value: string | number | readonly string[]): this {
        if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
        const values = Array.isArray(value) ? value.map(String) : [String(value)];
        this.headers.set(name.toLowerCase(), { name, values });
        return this;
    }

    getHeader(name: string): string | string[] | undefined {
        const entry = this.headers.get(name.toLowerCase());
        if (!entry) return undefined;
        return entry.values.length === 1 ? entry.values[0] : [...entry.values];
    }

    removeHeader(name: string): void {
        if (this.headersSent) throw new Error('Cannot remove headers after they are sent to the client');
        this.headers.delete(name.toLowerCase());
    }

    writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | Record<string, unknown>,
        headers?: Record<string, unknown>,
    ): this {
        if (this.headersSent) throw new Error('Cannot write headers after they are sent to the client');
        this.statusCode = statusCode;
        if (typeof statusMessageOrHeaders === 'string') {
            this.statusMessage = statusMessageOrHeaders;
        } else if (statusMessageOrHeaders) {
            headers = statusMessageOrHeaders;
        }
        if (headers) {
            for (const [name, value] of Object.entries(headers)) {
                if (value === undefined || value === null) continue;
                this.setHeader(name, Array.isArray(value) ? value.map(String) : String(value));
            }
        }
        const pairs: H2Header[] = [[':status', String(statusCode)]];
        for (const { name, values } of this.headers.values()) {
            const lower = name.toLowerCase();
            if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive'
                || lower === 'proxy-connection' || lower === 'upgrade') continue;
            for (const value of values) pairs.push([name, value]);
        }
        this.stream.respondPairs(pairs, { endStream: false });
        this.headersSent = true;
        return this;
    }

    _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            if (!this.headersSent) this.writeHead(this.statusCode, this.statusMessage || undefined);
            this.stream.write(chunk, encoding, callback);
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    _final(callback: (error?: Error | null) => void): void {
        try {
            if (!this.headersSent) {
                this.writeHead(this.statusCode, this.statusMessage || undefined);
                this.stream.end(() => {
                    this.finished = true;
                    callback();
                });
                return;
            }
            this.stream.end(() => {
                this.finished = true;
                callback();
            });
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    destroy(error?: Error | null): this {
        try {
            this.stream.close();
        } catch {
            /* already closed */
        }
        return super.destroy(error) as this;
    }
}

/* ── Session base ─────────────────────────────────────────────── */

class Http2Session extends EventEmitter {
    protected conn: H2Connection | null = null;
    protected socket: Socket | null = null;
    closed = false;
    destroyed = false;
    type: number;
    /** Set once a transport is attached; before that Node reports undefined. */
    protected _alpnProtocol: string | false | undefined;
    protected _encrypted: boolean | undefined;
    protected _connecting = true;
    remoteSettings: Record<string, number | boolean> = {};
    localSettings: Record<string, number | boolean>;
    pendingSettingsAck = false;
    /** Settings requested before a transport existed; flushed on attach. */
    private queuedSettings: Array<Record<string, unknown>> = [];
    private settingsAckWaiters: Array<(s: Http2Session) => void> = [];
    private timeoutMs = 0;
    private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    private _originSet: string[] | undefined;

    constructor(type: number, initialSettings?: Record<string, unknown>) {
        super();
        this.type = type;
        // Node seeds localSettings from the defaults merged with what the
        // session was constructed with, not with `{}`.
        this.localSettings = getDefaultSettings();
        if (initialSettings) this.mergeLocalSettings(initialSettings);
    }

    /** Validate then fold into localSettings (throws before mutating). */
    private mergeLocalSettings(settings: Record<string, unknown>): void {
        const validated: Record<string, number | boolean> = {};
        for (const [name, raw] of Object.entries(settings)) {
            if (raw === undefined) continue;
            if (name === 'customSettings') {
                customSettingEntries(raw);
                continue;
            }
            const id = SETTING_NAME_TO_ID[name];
            if (id === undefined) continue;
            const value = settingsValueAsUint32(id, raw);
            validated[name] = (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL)
                ? value !== 0
                : value;
        }
        Object.assign(this.localSettings, validated);
    }

    /** Live: undefined until a transport is attached (matches Node). */
    get alpnProtocol(): string | false | undefined {
        return this._alpnProtocol;
    }

    get encrypted(): boolean | undefined {
        return this._encrypted;
    }

    get connecting(): boolean {
        return this._connecting;
    }

    /** Node reports `{}` while connecting; afterwards, what the session knows. */
    get state(): Record<string, number> {
        const session = this.conn?.session;
        if (!session) return {};
        const out: Record<string, number> = {};
        // nghttp2 exposes only the connection-level windows through this build.
        const local = session.localWnd;
        const remote = session.remoteWnd;
        if (typeof local === 'number') {
            out['effectiveLocalWindowSize'] = local;
            out['localWindowSize'] = local;
        }
        if (typeof remote === 'number') out['remoteWindowSize'] = remote;
        if (typeof session.nextStreamId === 'number') out['nextStreamID'] = session.nextStreamId;
        return out;
    }

    /** Node: undefined unless an ORIGIN frame was received. Never populated here. */
    get originSet(): string[] | undefined {
        return this._encrypted ? (this._originSet ?? []) : undefined;
    }

    /** Called by subclasses/attach paths once a transport exists. */
    protected onTransportAttached(secure: boolean, alpn?: string | false): void {
        this._connecting = false;
        this._encrypted = secure;
        this._alpnProtocol = secure ? (alpn ?? 'h2') : false;
        const queued = this.queuedSettings;
        this.queuedSettings = [];
        for (const s of queued) this.sendSettings(s);
    }

    /** Push SETTINGS onto the wire and arm the ack flag. */
    private sendSettings(settings: Record<string, unknown>): void {
        const session = this.conn?.session;
        if (!session) {
            this.queuedSettings.push(settings);
            return;
        }
        this.pendingSettingsAck = true;
        const prevOnSettings = session.onsettings;
        session.onsettings = (isAck: boolean) => {
            if (typeof prevOnSettings === 'function') prevOnSettings(isAck);
            if (!isAck) return;
            this.pendingSettingsAck = false;
            const waiters = this.settingsAckWaiters;
            this.settingsAckWaiters = [];
            for (const w of waiters) w(this);
            this.emit('localSettings', this.localSettings);
        };
        // `configure` only understands the named RFC 7540 settings.
        session.configure(settings as Parameters<typeof session.configure>[0]);
    }

    /**
     * Change SETTINGS mid-session. Validation is eager and identical to
     * getPackedSettings, so a bad value throws before anything is queued.
     */
    settings(
        settings: Record<string, unknown>,
        callback?: (err: Error | null, s: Http2Session, duration: number) => void,
    ): void {
        if (settings === null || typeof settings !== 'object') {
            throw invalidArgType('settings', 'of type object', settings);
        }
        if (callback !== undefined && typeof callback !== 'function') {
            throw invalidArgType('callback', 'of type function', callback);
        }
        if (this.destroyed) {
            throw h2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
        }
        this.mergeLocalSettings(settings);
        const start = Date.now();
        if (callback) {
            this.settingsAckWaiters.push(s => callback(null, s, Date.now() - start));
        }
        this.sendSettings(settings);
    }

    setLocalWindowSize(windowSize: number): void {
        if (typeof windowSize !== 'number') {
            throw invalidArgType('windowSize', 'of type number', windowSize);
        }
        if (!Number.isInteger(windowSize) || windowSize < 0 || windowSize > 0x7fffffff) {
            throw Object.assign(
                new RangeError(`The value of "windowSize" is out of range. Received ${windowSize}`),
                { code: 'ERR_OUT_OF_RANGE' },
            );
        }
        const session = this.conn?.session;
        if (!session) return;
        const current = typeof session.localWnd === 'number' ? session.localWnd : 0;
        const delta = windowSize - current;
        if (delta !== 0) session.wndUpdate(0, delta);
    }

    setTimeout(msecs: number, callback?: () => void): this {
        if (typeof msecs !== 'number') {
            throw invalidArgType('msecs', 'of type number', msecs);
        }
        if (callback !== undefined && typeof callback !== 'function') {
            throw invalidArgType('callback', 'of type function', callback);
        }
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.timeoutMs = msecs;
        if (callback) this.once('timeout', callback);
        if (msecs > 0) {
            this.timeoutTimer = setTimeout(() => {
                this.timeoutTimer = null;
                this.emit('timeout');
            }, msecs);
            // A session timeout must not by itself hold the loop open.
            (this.timeoutTimer as { unref?: () => void }).unref?.();
        }
        return this;
    }

    get timeout(): number {
        return this.timeoutMs;
    }

    ref(): this {
        (this.socket as { ref?: () => void } | null)?.ref?.();
        return this;
    }

    unref(): this {
        (this.socket as { unref?: () => void } | null)?.unref?.();
        return this;
    }

    close(cb?: () => void): void {
        if (this.closed) {
            if (cb) queueMicrotask(cb);
            return;
        }
        this.closed = true;
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.conn?.close();
        this.conn = null;
        this.emit('close');
        if (cb) queueMicrotask(cb);
    }

    destroy(error?: Error): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.closed = true;
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.conn?.destroy();
        this.conn = null;
        if (error) this.emit('error', error);
        this.emit('close');
    }

    ping(payload?: Buffer | Uint8Array, cb?: (err: Error | null, duration: number, payload: Buffer) => void): boolean {
        if (!this.conn) return false;
        const start = Date.now();
        this.conn.session.onping = (isAck, p) => {
            if (!isAck) return;
            cb?.(null, Date.now() - start, Buffer.from(p));
        };
        this.conn.session.ping(payload instanceof Uint8Array ? payload : undefined);
        return true;
    }

    goaway(code?: number): void {
        this.conn?.session.goaway(code ?? 0);
    }
}

/* ── Client session ───────────────────────────────────────────── */

class ClientHttp2Session extends Http2Session {
    private authority = 'localhost';

    constructor(initialSettings?: Record<string, unknown>) {
        super(constants.NGHTTP2_SESSION_CLIENT, initialSettings);
    }

    setAuthority(value: string): void {
        this.authority = value;
    }

    attach(socket: Socket, secure: boolean): void {
        this.socket = socket;
        try {
            socket.pause();
        } catch {
            /* */
        }
        const transport = takeTcpForH2(socket);
        this.conn = new H2Connection(transport, false, secure);
        this.conn.on({
            onError: err => this.emit('error', err),
            onClose: () => this.close(),
        });
        this.onTransportAttached(secure);
        queueMicrotask(() => this.emit('connect', this, socket));
    }

    attachTls(tlsSocket: TLSSocket): void {
        this.socket = tlsSocket as unknown as Socket;
        const alpn = tlsSocket.alpnProtocol;
        if (alpn && alpn !== 'h2' && alpn !== 'h2c') {
            throw h2Error(
                'ERR_HTTP2_ALPN_MISMATCH',
                `http2.connect: negotiated ALPN '${alpn}', expected h2`,
            );
        }
        const transport = takeTlsForH2(tlsSocket);
        this.conn = new H2Connection(transport, false, true);
        this.conn.on({
            onError: err => this.emit('error', err),
            onClose: () => this.close(),
        });
        this.onTransportAttached(true, alpn || 'h2');
        queueMicrotask(() => this.emit('connect', this, tlsSocket));
    }

    request(
        headers: Record<string, unknown>,
        options?: { endStream?: boolean },
    ): ClientHttp2Stream {
        if (!this.conn) {
            throw h2Error('ERR_HTTP2_INVALID_SESSION', 'HTTP/2 session is not connected');
        }
        const pairs = toHeaderPairs(headers);
        const method = pairs.find(([n]) => n === ':method')?.[1] ?? 'GET';
        if (!pairs.some(([n]) => n === ':method')) pairs.unshift([':method', method]);
        if (!pairs.some(([n]) => n === ':path')) pairs.push([':path', '/']);
        if (!pairs.some(([n]) => n === ':scheme')) {
            pairs.push([':scheme', this.encrypted ? 'https' : 'http']);
        }
        if (!pairs.some(([n]) => n === ':authority')) {
            pairs.push([':authority', this.authority]);
        }
        // GET/HEAD default endStream; POST needs endStream:false then write+end
        const end = options?.endStream ?? (method === 'GET' || method === 'HEAD');
        const h2s = this.conn.request(pairs, end);
        return new ClientHttp2Stream(h2s, method);
    }
}

/* ── Server ───────────────────────────────────────────────────── */

type StreamListener = (
    stream: ServerHttp2Stream,
    headers: Record<string, string | string[]>,
    flags: number,
) => void;

type RequestListener = (
    request: Http2ServerRequest,
    response: Http2ServerResponse,
) => void;

/** Bind nghttp2 session to an accepted transport; emit stream/session on `host`. */
function attachServerSession(
    host: EventEmitter,
    sessions: Set<Http2Session>,
    socket: Socket | TLSSocket,
    secure: boolean,
    requestListener: RequestListener | null,
    streamListener: StreamListener | null,
): Http2Session | null {
    let transport: TcpSocket;
    try {
        if (secure || isTlsSocket(socket)) {
            transport = takeTlsForH2(socket as TLSSocket);
            secure = true;
        } else {
            transport = takeTcpForH2(socket as Socket);
        }
    } catch (e) {
        host.emit('error', e);
        try {
            (socket as Socket).destroy?.();
        } catch {
            /* */
        }
        return null;
    }
    const conn = new H2Connection(transport, true, secure);
    const session = new Http2Session(constants.NGHTTP2_SESSION_SERVER);
    session['conn'] = conn;
    session['socket'] = socket as Socket;
    session['onTransportAttached'](
        secure,
        secure ? ((socket as TLSSocket).alpnProtocol || 'h2') : undefined,
    );
    sessions.add(session);
    conn.on({
        onError: err => host.emit('sessionError', err, session),
        onClose: () => {
            sessions.delete(session);
            session.close();
        },
    });
    conn.onStreamOpen = stream => {
        stream.whenHeaders((hdrs, _ended) => {
            const obj = headerObject(hdrs);
            const serverStream = new ServerHttp2Stream(stream);
            host.emit('stream', serverStream, obj, 0, hdrs);
            if (streamListener) streamListener(serverStream, obj, 0);
            if (requestListener || host.listenerCount('request') > 0) {
                const request = new Http2ServerRequest(serverStream, hdrs);
                const response = new Http2ServerResponse(serverStream);
                host.emit('request', request, response);
                if (requestListener) Reflect.apply(requestListener, host, [request, response]);
            }
        });
    };
    host.emit('session', session);
    return session;
}

class Http2Server extends NetServer {
    private streamListener: StreamListener | null = null;
    private requestListener: RequestListener | null = null;
    private sessions = new Set<Http2Session>();

    constructor(
        options?: Record<string, unknown> | StreamListener | RequestListener,
        onRequest?: StreamListener | RequestListener,
    ) {
        // pauseOnConnect: accept path must not start Node's TCP read before H2
        // attaches. `checkH2` runs inside the super() argument list so the gate
        // is checked before a net.Server is constructed and thrown away.
        super(Http2Server.checkH2({ pauseOnConnect: true }));
        if (typeof options === 'function') {
            this.requestListener = options as RequestListener;
        } else if (typeof onRequest === 'function') {
            this.requestListener = onRequest as RequestListener;
        }
        this.on('connection', (socket: Socket) => {
            attachServerSession(this, this.sessions, socket, false, this.requestListener, this.streamListener);
        });
    }

    private static checkH2<T>(value: T): T {
        ensureH2();
        return value;
    }

    close(cb?: (err?: Error) => void): this {
        for (const s of this.sessions) s.close();
        this.sessions.clear();
        return super.close(cb);
    }
}

/**
 * TLS + ALPN h2 server (Node Http2SecureServer).
 *
 * Extends tls.Server so `instanceof tls.Server` holds and the TLS server
 * surface (listen/address/close/ref/unref/getConnections/maxConnections) is
 * inherited rather than re-implemented over a private delegate. Critically,
 * this class is the ONLY thing createSecureServer can return: a secure server
 * request must never be silently satisfied by a cleartext listener.
 */
class Http2SecureServer extends tls.Server {
    private sessions = new Set<Http2Session>();
    private streamListener: StreamListener | null = null;
    private requestListener: RequestListener | null = null;
    /** Retained so setSecureContext can rebuild the underlying context. */
    private secureOptions: Record<string, unknown>;

    constructor(
        options: Record<string, unknown>,
        onRequest?: RequestListener | StreamListener,
    ) {
        const opts = options ?? {};
        const alpn = Array.isArray(opts['ALPNProtocols'])
            ? (opts['ALPNProtocols'] as string[])
            : ['h2'];
        // ensureH2 inside the super() arguments: no TLS listener is built when
        // the h2 gate is shut.
        super(Http2SecureServer.tlsOptions(opts, alpn));
        this.secureOptions = opts;
        if (typeof onRequest === 'function') {
            this.requestListener = onRequest as RequestListener;
        }
        this.on('secureConnection', (tlsSocket: TLSSocket) => {
            const negotiated = tlsSocket.alpnProtocol;
            // Fail closed unless ALPN is h2 (or empty after a broken peer).
            if (negotiated && negotiated !== 'h2' && negotiated !== 'h2c') {
                tlsSocket.destroy();
                return;
            }
            attachServerSession(
                this,
                this.sessions,
                tlsSocket,
                true,
                this.requestListener,
                this.streamListener,
            );
        });
    }

    private static tlsOptions(
        opts: Record<string, unknown>,
        alpn: string[],
    ): Record<string, unknown> {
        ensureH2();
        return {
            key: opts['key'] as string | Buffer | undefined,
            cert: opts['cert'] as string | Buffer | undefined,
            ca: opts['ca'] as string | Buffer | undefined,
            requestCert: opts['requestCert'] as boolean | undefined,
            rejectUnauthorized: opts['rejectUnauthorized'] as boolean | undefined,
            ciphers: opts['ciphers'] as string | undefined,
            minVersion: opts['minVersion'] as string | undefined,
            maxVersion: opts['maxVersion'] as string | undefined,
            allowHalfOpen: opts['allowHalfOpen'] as boolean | undefined,
            ALPNProtocols: alpn,
        };
    }

    /** Node's tls.Server method; absent before. Rebuilds the TLS context. */
    setSecureContext(options: Record<string, unknown>): void {
        if (options === null || typeof options !== 'object') {
            throw invalidArgType('options', 'of type object', options);
        }
        this.secureOptions = { ...this.secureOptions, ...options };
        const alpn = Array.isArray(this.secureOptions['ALPNProtocols'])
            ? (this.secureOptions['ALPNProtocols'] as string[])
            : ['h2'];
        const rebuilt = tls.createServer(
            Http2SecureServer.tlsOptions(this.secureOptions, alpn),
        ) as unknown as { _secureContext: unknown };
        (this as unknown as { _secureContext: unknown })._secureContext = rebuilt._secureContext;
    }

    /** Node accepts and validates these; the wire change needs the h2 build. */
    updateSettings(settings: Record<string, unknown>): void {
        if (settings === null || typeof settings !== 'object') {
            throw invalidArgType('settings', 'of type object', settings);
        }
        // Validate with the same machinery as getPackedSettings so a bad value
        // is rejected here rather than silently ignored.
        getPackedSettings(settings as Parameters<typeof getPackedSettings>[0]);
        this.secureOptions = { ...this.secureOptions, settings };
    }

    close(cb?: (err?: Error) => void): this {
        for (const s of this.sessions) s.close();
        this.sessions.clear();
        return super.close(cb) as this;
    }
}

export function createServer(
    options?: Record<string, unknown> | RequestListener | StreamListener,
    onRequest?: RequestListener | StreamListener,
): Http2Server {
    if (options !== undefined && options !== null
        && typeof options !== 'function' && typeof options !== 'object') {
        throw invalidArgType('options', 'of type object', options);
    }
    if (onRequest !== undefined && typeof onRequest !== 'function') {
        throw invalidArgType('onRequestHandler', 'of type function', onRequest);
    }
    return new Http2Server(options, onRequest);
}

export function createSecureServer(
    options?: Record<string, unknown>,
    onRequest?: RequestListener | StreamListener,
): Http2SecureServer {
    // Node: createSecureServer(fn) is ERR_INVALID_ARG_TYPE, not a handler.
    if (typeof options === 'function') {
        throw invalidArgType('options', 'of type object', options);
    }
    if (options !== undefined && options !== null && typeof options !== 'object') {
        throw invalidArgType('options', 'of type object', options);
    }
    if (onRequest !== undefined && typeof onRequest !== 'function') {
        throw invalidArgType('onRequestHandler', 'of type function', onRequest);
    }
    const opts: Record<string, unknown> = options ?? {};
    // A partial credential pair is a configuration mistake that would otherwise
    // surface as an opaque OpenSSL error at handshake time. Node lets OpenSSL
    // raise it; we raise the coherent, codeful error eagerly. Absent-or-
    // undefined-both is NOT an error (Node succeeds): the resulting TLS server
    // fails every handshake, which is the safe outcome.
    const hasKey = opts['key'] !== undefined && opts['key'] !== null;
    const hasCert = opts['cert'] !== undefined && opts['cert'] !== null;
    if (hasKey !== hasCert) {
        throw h2Error(
            'ERR_MISSING_ARGS',
            'http2.createSecureServer requires both key and cert, or neither',
        );
    }
    return new Http2SecureServer(opts, onRequest);
}

/** http:/https: only — matches Node's connect() protocol allowlist. */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

export interface ResolvedConnectTarget {
    protocol: string;
    /** Dial host — honours options.host/options.hostname overrides. */
    host: string;
    /** Dial port — honours options.port override. */
    port: number;
    secure: boolean;
    /** The `:authority` pseudo-header value (from the URL, not the dial target). */
    authority: string;
}

/**
 * Validate `authority` and resolve the dial target.
 *
 * Exported (double-underscore = internal/test surface, as with
 * __forceH2Unavailable) so the resolution table is observable without a build
 * that has the h2 native extension. Called by connect() BEFORE ensureH2, so a
 * caller gets a useful argument error rather than a build-config message.
 */
export function __resolveConnectTarget(
    authority: unknown,
    options?: Record<string, unknown>,
): ResolvedConnectTarget {
    const opts = options ?? {};

    let url: URL | { protocol?: unknown; hostname?: unknown; host?: unknown; port?: unknown };
    if (typeof authority === 'string') {
        // Node hands the string straight to the URL parser: no `http://`
        // prefixing. '127.0.0.1:1' and 'not a url' are ERR_INVALID_URL, and a
        // prefix would instead have accepted them as cleartext.
        try {
            url = new URL(authority);
        } catch {
            throw invalidUrl(authority);
        }
    } else if (authority instanceof URL) {
        url = authority;
    } else if (
        authority !== null
        && typeof authority === 'object'
        && !Array.isArray(authority)
    ) {
        url = authority as { protocol?: unknown; hostname?: unknown; host?: unknown; port?: unknown };
    } else {
        // null / number / boolean / symbol / array. Node's own no-argument case
        // is an unguarded deref that throws a bare TypeError with no .code; we
        // give it the same codeful error as every other bad type instead.
        throw invalidArgType(
            'authority',
            'of type string or an instance of URL or Object',
            authority,
        );
    }

    // Node's object branch defaults to https: — the secure choice. The old code
    // defaulted to cleartext, so connect({port:8080}) dialled h2c.
    const rawProtocol = url.protocol ?? opts['protocol'] ?? 'https:';
    const protocol = String(rawProtocol).toLowerCase();
    if (!SUPPORTED_PROTOCOLS.has(protocol)) throw unsupportedProtocol(protocol);

    const secure = protocol === 'https:';
    const rawHost = url.hostname ?? url.host ?? 'localhost';
    const urlHost = String(rawHost) || 'localhost';
    if (!urlHost) throw invalidUrl(authority);

    const rawPort = url.port;
    const urlPort = (rawPort === undefined || rawPort === null || rawPort === '')
        ? (secure ? 443 : 80)
        : Number(rawPort);
    if (!Number.isInteger(urlPort) || urlPort < 0 || urlPort > 65535) {
        throw Object.assign(
            new RangeError(`Invalid port: ${String(rawPort)}`),
            { code: 'ERR_SOCKET_BAD_PORT' },
        );
    }

    // Node never elides the port: `http://h/` sends `:authority: h:80`
    // (measured on v24.18.0). The old `port === 80 || port === 443` test
    // consulted no scheme and elided 443-on-http and 80-on-https.
    const authorityHeader = typeof opts['authority'] === 'string'
        ? (opts['authority'] as string)
        : `${urlHost}:${urlPort}`;

    // options.host/port redirect the dial without changing :authority — Node
    // passes them through to net/tls.connect (measured: connect(url, {port})
    // dials `port` and still sends the URL's authority).
    const dialHostRaw = opts['host'] ?? opts['hostname'];
    const host = typeof dialHostRaw === 'string' && dialHostRaw ? dialHostRaw : urlHost;
    let port = urlPort;
    if (opts['port'] !== undefined && opts['port'] !== null) {
        const p = Number(opts['port']);
        if (!Number.isInteger(p) || p < 0 || p > 65535) {
            throw Object.assign(
                new RangeError(`Invalid port: ${String(opts['port'])}`),
                { code: 'ERR_SOCKET_BAD_PORT' },
            );
        }
        port = p;
    }

    return { protocol, host, port, secure, authority: authorityHeader };
}

export function connect(
    authority: string | URL,
    options?: Record<string, unknown> | ((session: ClientHttp2Session, socket: Socket) => void),
    listener?: (session: ClientHttp2Session, socket: Socket) => void,
): ClientHttp2Session {
    let opts: Record<string, unknown> = {};
    let cb = listener;
    if (typeof options === 'function') {
        cb = options;
        opts = {};
    } else if (options) {
        opts = options;
    }

    // Argument validation FIRST: a caller with a bad authority deserves the
    // argument error, not a build-configuration message, and it makes the
    // validation order observable in builds without the h2 extension.
    const target = __resolveConnectTarget(authority, opts);
    if (cb !== undefined && typeof cb !== 'function') {
        throw invalidArgType('listener', 'of type function', cb);
    }
    ensureH2();

    const { host, port, secure } = target;

    const session = new ClientHttp2Session(opts['settings'] as Record<string, unknown> | undefined);
    if (cb) session.once('connect', cb as (session: ClientHttp2Session, socket: Socket) => void);

    session.setAuthority(target.authority);

    if (secure) {
        const createConnection = opts['createConnection'];
        if (typeof createConnection === 'function') {
            const sock = createConnection(opts, () => {}) as Socket | TLSSocket;
            const attach = () => {
                try {
                    if (isTlsSocket(sock)) session.attachTls(sock);
                    else session.attach(sock as Socket, true);
                } catch (e) {
                    session.emit('error', e);
                }
            };
            if (isTlsSocket(sock) && sock.alpnProtocol) {
                queueMicrotask(attach);
            } else {
                sock.once('secureConnect', attach);
                sock.once('connect', attach);
                if ((sock as Socket).readyState === 'open' && isTlsSocket(sock) && sock._handshakeComplete) {
                    queueMicrotask(attach);
                }
            }
            sock.on('error', err => session.emit('error', err));
            return session;
        }

        const tlsSocket = tls.connect({
            host,
            port,
            servername: (opts['servername'] as string) ?? host,
            rejectUnauthorized: (opts['rejectUnauthorized'] as boolean | undefined) ?? true,
            ca: opts['ca'] as string | Buffer | undefined,
            cert: opts['cert'] as string | Buffer | undefined,
            key: opts['key'] as string | Buffer | undefined,
            ALPNProtocols: (opts['ALPNProtocols'] as string[]) ?? ['h2'],
        }, () => {
            try {
                session.attachTls(tlsSocket);
            } catch (e) {
                session.emit('error', e);
            }
        });
        tlsSocket.on('error', err => session.emit('error', err));
        return session;
    }

    const socket = netConnect({ port, host }, () => {
        session.attach(socket, false);
    });
    socket.on('error', err => session.emit('error', err));
    return session;
}

export type { ClientHttp2Session, Http2Server, ClientHttp2Stream, ServerHttp2Stream };
export type { Http2SecureServer };

// Node exports these as values (subclassable / instanceof-checkable), not just types.
export { Http2ServerRequest, Http2ServerResponse };

/**
 * Adopt an already-connected socket as a server-side HTTP/2 session.
 * Node's signature; the caller owns the socket's TLS handshake.
 */
export function performServerHandshake(
    socket: Socket | TLSSocket,
    options: Record<string, unknown> = {},
): Http2Session {
    ensureH2();
    const host = new EventEmitter();
    const sessions = new Set<Http2Session>();
    const session = attachServerSession(
        host,
        sessions,
        socket,
        Boolean(options['secure']) || isTlsSocket(socket),
        null,
        null,
    );
    if (!session) throw h2Error('ERR_HTTP2_ERROR', 'HTTP/2 server handshake failed');
    return session;
}

/** RFC 7540 SETTINGS identifiers (also nghttp2 / Node constants). */
const SETTINGS_HEADER_TABLE_SIZE = 0x1;
const SETTINGS_ENABLE_PUSH = 0x2;
const SETTINGS_MAX_CONCURRENT_STREAMS = 0x3;
const SETTINGS_INITIAL_WINDOW_SIZE = 0x4;
const SETTINGS_MAX_FRAME_SIZE = 0x5;
const SETTINGS_MAX_HEADER_LIST_SIZE = 0x6;
const SETTINGS_ENABLE_CONNECT_PROTOCOL = 0x8;

const SETTING_NAME_TO_ID: Record<string, number> = {
    headerTableSize: SETTINGS_HEADER_TABLE_SIZE,
    enablePush: SETTINGS_ENABLE_PUSH,
    maxConcurrentStreams: SETTINGS_MAX_CONCURRENT_STREAMS,
    initialWindowSize: SETTINGS_INITIAL_WINDOW_SIZE,
    maxFrameSize: SETTINGS_MAX_FRAME_SIZE,
    maxHeaderListSize: SETTINGS_MAX_HEADER_LIST_SIZE,
    maxHeaderSize: SETTINGS_MAX_HEADER_LIST_SIZE,
    enableConnectProtocol: SETTINGS_ENABLE_CONNECT_PROTOCOL,
};

const SETTING_ID_TO_NAME: Record<number, string> = {
    [SETTINGS_HEADER_TABLE_SIZE]: 'headerTableSize',
    [SETTINGS_ENABLE_PUSH]: 'enablePush',
    [SETTINGS_MAX_CONCURRENT_STREAMS]: 'maxConcurrentStreams',
    [SETTINGS_INITIAL_WINDOW_SIZE]: 'initialWindowSize',
    [SETTINGS_MAX_FRAME_SIZE]: 'maxFrameSize',
    [SETTINGS_MAX_HEADER_LIST_SIZE]: 'maxHeaderListSize',
    [SETTINGS_ENABLE_CONNECT_PROTOCOL]: 'enableConnectProtocol',
};

function invalidSettingValue(name: string, value: unknown): RangeError & { code: string } {
    return Object.assign(
        new RangeError(`Invalid value for setting "${name}": ${String(value)}`),
        { code: 'ERR_HTTP2_INVALID_SETTING_VALUE' },
    );
}

function settingsValueAsUint32(id: number, value: unknown): number {
    const name = SETTING_ID_TO_NAME[id] ?? String(id);
    // Node accepts ONLY booleans for the two flag settings: 0/1/'1'/null all
    // raise ERR_HTTP2_INVALID_SETTING_VALUE (measured on node v24.18.0).
    if (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL) {
        if (typeof value !== 'boolean') throw invalidSettingValue(name, value);
        return value ? 1 : 0;
    }
    if (typeof value === 'boolean') throw invalidSettingValue(name, value);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff || !Number.isInteger(n)) {
        throw invalidSettingValue(name, value);
    }
    if (id === SETTINGS_MAX_FRAME_SIZE && (n < 16384 || n > 16777215)) {
        throw invalidSettingValue(name, n);
    }
    if (id === SETTINGS_INITIAL_WINDOW_SIZE && n > 0x7fffffff) {
        throw invalidSettingValue(name, n);
    }
    return n >>> 0;
}

/** Node's internal MAX_ADDITIONAL_SETTINGS: >10 custom entries is an error. */
const MAX_ADDITIONAL_SETTINGS = 10;

function tooManyCustomSettings(): RangeError & { code: string } {
    return Object.assign(
        new RangeError('Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS'),
        { code: 'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS' },
    );
}

/**
 * Validate and collect `customSettings` (unknown SETTINGS ids) for packing.
 * Node keys these by numeric id; ids must be uint16 and values uint32.
 */
function customSettingEntries(raw: unknown): Array<[number, number]> {
    if (raw === null || typeof raw !== 'object') return [];
    const keys = Object.keys(raw as Record<string, unknown>);
    if (keys.length > MAX_ADDITIONAL_SETTINGS) throw tooManyCustomSettings();
    const entries: Array<[number, number]> = [];
    for (const key of keys) {
        const id = Number(key);
        if (!Number.isInteger(id) || id < 0 || id > 0xffff) {
            throw invalidSettingValue('customSettings:id', key);
        }
        // A custom id that duplicates a named setting is ambiguous; Node fails
        // here too, but with an unrelated ERR_INVALID_ARG_TYPE from an internal
        // path, so we raise the coherent error instead.
        if (SETTING_ID_TO_NAME[id] !== undefined) {
            throw invalidSettingValue('customSettings:id', key);
        }
        const value = (raw as Record<string, unknown>)[key];
        if (typeof value === 'boolean') {
            throw invalidSettingValue('customSettings:value', value);
        }
        const n = Number(value);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 0xffffffff) {
            throw invalidSettingValue('customSettings:value', value);
        }
        entries.push([id, n >>> 0]);
    }
    return entries;
}

export function getDefaultSettings(): Record<string, number | boolean> {
    // Node returns a null-prototype object.
    const out = Object.create(null) as Record<string, number | boolean>;
    out['headerTableSize'] = constants.DEFAULT_SETTINGS_HEADER_TABLE_SIZE;
    out['enablePush'] = true;
    out['initialWindowSize'] = 65535;
    out['maxFrameSize'] = 16384;
    out['maxConcurrentStreams'] = 4294967295;
    out['maxHeaderSize'] = constants.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE;
    out['maxHeaderListSize'] = constants.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE;
    out['enableConnectProtocol'] = false;
    return out;
}

/**
 * Serialize HTTP/2 SETTINGS parameters to the SETTINGS frame payload
 * (sequence of 6-byte entries: 2-byte id BE + 4-byte value BE).
 * Matches Node.js `http2.getPackedSettings`.
 */
export function getPackedSettings(
    settings?: Record<string, number | boolean | Record<string, number> | undefined>,
): Buffer {
    // Node treats a missing/undefined argument as {} and returns an empty
    // buffer; only null and non-objects are ERR_INVALID_ARG_TYPE.
    if (settings === undefined) return Buffer.alloc(0);
    if (settings === null || typeof settings !== 'object') {
        throw Object.assign(
            new TypeError(`The "settings" argument must be of type object. Received ${describeReceived(settings)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    const entries: Array<[number, number]> = [];
    for (const [name, raw] of Object.entries(settings)) {
        if (raw === undefined) continue;
        if (name === 'customSettings') continue;
        const id = SETTING_NAME_TO_ID[name];
        if (id === undefined) continue;
        entries.push([id, settingsValueAsUint32(id, raw)]);
    }
    for (const entry of customSettingEntries(settings['customSettings'])) {
        entries.push(entry);
    }
    // Stable order by identifier (Node sorts by id)
    entries.sort((a, b) => a[0] - b[0]);
    // maxHeaderSize aliases maxHeaderListSize — pack once
    const seen = new Set<number>();
    const unique: Array<[number, number]> = [];
    for (const e of entries) {
        if (seen.has(e[0])) continue;
        seen.add(e[0]);
        unique.push(e);
    }
    const out = Buffer.allocUnsafe(unique.length * 6);
    let off = 0;
    for (const [id, val] of unique) {
        out.writeUInt16BE(id, off);
        out.writeUInt32BE(val, off + 2);
        off += 6;
    }
    return out;
}

/**
 * Parse SETTINGS frame payload bytes into a settings object.
 * Unknown identifiers are ignored. Boolean settings become boolean.
 */
export function getUnpackedSettings(
    buf: Buffer | Uint8Array,
): Record<string, number | boolean | Record<string, number>> {
    if (!(buf instanceof Uint8Array)) {
        throw Object.assign(
            new TypeError('The "buf" argument must be an instance of Buffer or TypedArray. '
                + `Received ${describeReceived(buf)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    const u8 = buf;
    if (u8.byteLength % 6 !== 0) {
        throw Object.assign(
            new RangeError('Packed settings length must be a multiple of six'),
            { code: 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH' },
        );
    }
    const view = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    const out: Record<string, number | boolean | Record<string, number>> = {};
    // Node surfaces unrecognized ids under `customSettings`, keyed by numeric
    // id, created lazily at the first unknown id (so key order follows the
    // wire scan) with last-one-wins on duplicates.
    let custom: Record<string, number> | undefined;
    for (let i = 0; i < view.length; i += 6) {
        const id = view.readUInt16BE(i);
        const val = view.readUInt32BE(i + 2);
        const name = SETTING_ID_TO_NAME[id];
        if (!name) {
            if (custom === undefined) {
                custom = {};
                out['customSettings'] = custom;
            }
            custom[String(id)] = val;
            continue;
        }
        // Node emits maxHeaderSize before its maxHeaderListSize alias.
        if (id === SETTINGS_MAX_HEADER_LIST_SIZE) {
            out['maxHeaderSize'] = val;
            out['maxHeaderListSize'] = val;
            continue;
        }
        if (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL) {
            out[name] = val !== 0;
        } else {
            out[name] = val;
        }
    }
    return out;
}
