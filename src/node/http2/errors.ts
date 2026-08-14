/**
 * node:http2 error factories, the h2-availability gate, and the warn-once flags.
 *
 * The two `{fired: boolean}` flags live here and nowhere else: they are mutable
 * module state, and a duplicate copy would make the same warning fire twice.
 */

import { h2Available } from '@cnojs/http/h2-native';

// Node's ERR_INVALID_ARG_TYPE "Received …" suffix, for the common cases.
export function describeReceived(value: unknown): string {
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

export function invalidArgType(name: string, expected: string, value: unknown): TypeError & { code: string } {
    return Object.assign(
        new TypeError(`The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`),
        { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

export function invalidUrl(input: unknown): TypeError & { code: string; input?: string } {
    return Object.assign(new TypeError('Invalid URL'), {
        code: 'ERR_INVALID_URL',
        input: typeof input === 'string' ? input : String(input),
    });
}

export function unsupportedProtocol(protocol: string): Error & { code: string } {
    return Object.assign(new Error(`protocol "${protocol}" is unsupported.`), {
        code: 'ERR_HTTP2_UNSUPPORTED_PROTOCOL',
    });
}

export function h2Unavailable(): Error & { code: string } {
    // Message text is load-bearing for existing tests; the code is the new part.
    return Object.assign(
        new Error('HTTP/2 is not available in this build (compile with -DCNO_EMBED_EXT_H2=ON)'),
        { code: 'ERR_HTTP2_UNAVAILABLE' },
    );
}

export function h2Error(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

export function ensureH2(): void {
    if (!h2Available()) throw h2Unavailable();
}

export function invalidArgValue(name: string, value: unknown, reason?: string): TypeError & { code: string } {
    const shown = typeof value === 'string' ? `'${value}'` : describeReceived(value);
    return Object.assign(
        new TypeError(`The argument '${name}' ${reason ?? 'is invalid'}. Received ${shown}`),
        { code: 'ERR_INVALID_ARG_VALUE' },
    );
}

export function headersSentError(): Error & { code: string } {
    return Object.assign(
        new Error('Response has already been initiated.'),
        { code: 'ERR_HTTP2_HEADERS_SENT' },
    );
}

export function warnOnce(flag: { fired: boolean }, message: string): void {
    if (flag.fired) return;
    flag.fired = true;
    try {
        process.emitWarning(message, 'UnsupportedWarning');
    } catch {
        /* emitWarning unavailable */
    }
}

export const connectionHeaderWarned = { fired: false };
export const statusMessageWarned = { fired: false };

export function statusMessageWarn(): void {
    warnOnce(statusMessageWarned, 'Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)');
}

export function invalidStatus(code: number): RangeError & { code: string } {
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
export function validateStatusCode(code: unknown): number {
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

export function invalidSettingValue(name: string, value: unknown): RangeError & { code: string } {
    return Object.assign(
        new RangeError(`Invalid value for setting "${name}": ${String(value)}`),
        { code: 'ERR_HTTP2_INVALID_SETTING_VALUE' },
    );
}

export function tooManyCustomSettings(): RangeError & { code: string } {
    return Object.assign(
        new RangeError('Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS'),
        { code: 'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS' },
    );
}
