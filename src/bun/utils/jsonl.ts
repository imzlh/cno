/**
 * Partial implementation of Bun 1.4.4 `Bun.JSONL.parse` and `Bun.JSONL.parseChunk`.
 *
 * Behavior was derived from the Bun 1.4.4 oracle, not from documentation alone.
 * Known deviations are listed in the report that accompanies this file.
 *
 * Offsets: string input counts UTF-16 code units; byte input counts bytes.
 * `read` is the absolute offset just past the last committed top-level value,
 * or the window start when nothing was committed.
 */

export interface JSONLParseChunkResult {
    /** Top-level values committed before the first incomplete or invalid input. */
    values: unknown[];
    /** Absolute offset past the last committed value. */
    read: number;
    /** True when all input in the window was consumed without error or pending value. */
    done: boolean;
    /** SyntaxError for invalid input, otherwise null. */
    error: SyntaxError | null;
}

export type JSONLInput = string | ArrayBufferView | ArrayBufferLike;

const FAILURE_MESSAGE = 'Failed to parse JSONL';
const INCOMPLETE = -1;
const ERROR = -2;
// Single punctuation that the oracle leaves pending when it is the final byte.
const PENDING_PUNCTUATION = new Set([',', ':', ';', '=', '(', ')', '.', '-', '[', '{', ']', '}'].map((c) => c.charCodeAt(0)));
const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

function isDigit(code: number): boolean {
    return code >= 0x30 && code <= 0x39;
}

function isLetter(code: number): boolean {
    return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x24;
}

function isHex(code: number): boolean {
    return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isJSONSpace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Scans one window of input. Scanner methods return an end offset, INCOMPLETE, or ERROR. */
class Scanner {
    /** Start of the top-level value being scanned. Only that value may commit a partial number. */
    topStart = -1;
    /** Mantissa end of a top-level number whose exponent is malformed. */
    partialEnd = -1;

    constructor(
        private readonly source: string | Uint8Array,
        readonly end: number,
    ) {}

    code(index: number): number {
        return typeof this.source === 'string' ? this.source.charCodeAt(index) : this.source[index];
    }

    slice(start: number, stop: number): string {
        return typeof this.source === 'string'
            ? this.source.slice(start, stop)
            : UTF8.decode(this.source.subarray(start, stop));
    }

    skipSpace(index: number): number {
        while (index < this.end && isJSONSpace(this.code(index))) index++;
        return index;
    }

    value(index: number): number {
        if (index >= this.end) return INCOMPLETE;
        const code = this.code(index);
        switch (code) {
            case 0x7b: return this.object(index);
            case 0x5b: return this.array(index);
            case 0x22: return this.string(index);
            case 0x74: return this.literal(index, 'true');
            case 0x66: return this.literal(index, 'false');
            case 0x6e: return this.literal(index, 'null');
        }
        if (code === 0x2d || isDigit(code)) return this.number(index);
        return this.unexpected(index);
    }

    /** A token that cannot appear at this position. A bare-word run is pending only at the window end. */
    unexpected(index: number): number {
        const code = this.code(index);
        if (isLetter(code) || isDigit(code)) {
            let stop = index;
            while (stop < this.end && (isLetter(this.code(stop)) || isDigit(this.code(stop)))) stop++;
            return stop === this.end ? INCOMPLETE : ERROR;
        }
        if (code === 0x22) {
            const stop = this.string(index);
            if (stop < 0) return stop;
            return stop === this.end ? INCOMPLETE : ERROR;
        }
        if (index + 1 === this.end && PENDING_PUNCTUATION.has(code)) return INCOMPLETE;
        return ERROR;
    }

    literal(index: number, word: string): number {
        for (let k = 0; k < word.length; k++) {
            if (index + k >= this.end) return INCOMPLETE;
            if (this.code(index + k) !== word.charCodeAt(k)) return this.unexpected(index);
        }
        return index + word.length;
    }

    number(index: number): number {
        let stop = index;
        if (this.code(stop) === 0x2d) {
            stop++;
            if (stop >= this.end) return INCOMPLETE;
        }
        if (!isDigit(this.code(stop))) return ERROR;
        if (this.code(stop) === 0x30) {
            stop++;
        } else {
            while (stop < this.end && isDigit(this.code(stop))) stop++;
        }
        let mantissaEnd = stop;
        if (stop < this.end && this.code(stop) === 0x2e) {
            stop++;
            if (stop >= this.end) return INCOMPLETE;
            if (!isDigit(this.code(stop))) return ERROR;
            while (stop < this.end && isDigit(this.code(stop))) stop++;
            mantissaEnd = stop;
        }
        if (stop < this.end && (this.code(stop) === 0x65 || this.code(stop) === 0x45)) {
            stop++;
            if (stop < this.end && (this.code(stop) === 0x2b || this.code(stop) === 0x2d)) stop++;
            if (stop >= this.end || !isDigit(this.code(stop))) {
                // Oracle commits a top-level mantissa before reporting a bad exponent.
                if (index === this.topStart) {
                    this.partialEnd = mantissaEnd;
                    return ERROR;
                }
                return stop >= this.end ? INCOMPLETE : ERROR;
            }
            while (stop < this.end && isDigit(this.code(stop))) stop++;
        }
        return stop;
    }

    string(index: number): number {
        let stop = index + 1;
        while (true) {
            if (stop >= this.end) return INCOMPLETE;
            const code = this.code(stop);
            if (code === 0x22) return stop + 1;
            if (code < 0x20) return ERROR;
            if (code !== 0x5c) {
                stop++;
                continue;
            }
            stop++;
            if (stop >= this.end) return INCOMPLETE;
            const escape = this.code(stop);
            if (escape === 0x75) {
                for (let k = 1; k <= 4; k++) {
                    if (stop + k >= this.end || !isHex(this.code(stop + k))) return ERROR;
                }
                stop += 5;
            } else if (escape === 0x22 || escape === 0x5c || escape === 0x2f ||
                escape === 0x62 || escape === 0x66 || escape === 0x6e || escape === 0x72 || escape === 0x74) {
                stop++;
            } else {
                return ERROR;
            }
        }
    }

    array(index: number): number {
        let stop = this.skipSpace(index + 1);
        if (stop >= this.end) return INCOMPLETE;
        if (this.code(stop) === 0x5d) return stop + 1;
        while (true) {
            const next = this.value(stop);
            if (next < 0) return next;
            stop = this.skipSpace(next);
            if (stop >= this.end) return INCOMPLETE;
            const code = this.code(stop);
            if (code === 0x5d) return stop + 1;
            if (code !== 0x2c) return this.unexpected(stop);
            stop = this.skipSpace(stop + 1);
            if (stop >= this.end) return INCOMPLETE;
        }
    }

    object(index: number): number {
        let stop = this.skipSpace(index + 1);
        if (stop >= this.end) return INCOMPLETE;
        if (this.code(stop) === 0x7d) return stop + 1;
        while (true) {
            if (this.code(stop) !== 0x22) return this.unexpected(stop);
            const keyEnd = this.string(stop);
            if (keyEnd < 0) return keyEnd;
            stop = this.skipSpace(keyEnd);
            if (stop >= this.end) return INCOMPLETE;
            if (this.code(stop) !== 0x3a) return this.unexpected(stop);
            stop = this.skipSpace(stop + 1);
            if (stop >= this.end) return INCOMPLETE;
            const valueEnd = this.value(stop);
            if (valueEnd < 0) return valueEnd;
            stop = this.skipSpace(valueEnd);
            if (stop >= this.end) return INCOMPLETE;
            const code = this.code(stop);
            if (code === 0x7d) return stop + 1;
            if (code !== 0x2c) return this.unexpected(stop);
            stop = this.skipSpace(stop + 1);
            if (stop >= this.end) return INCOMPLETE;
        }
    }
}

type NormalizedInput = { source: string | Uint8Array } | { invalid: true };

function normalize(input: unknown, method: string): NormalizedInput {
    if (typeof input === 'string') return { source: input };
    if (ArrayBuffer.isView(input)) {
        // DataView is rejected by the oracle; other views are read as raw bytes.
        if (input instanceof DataView) return { invalid: true };
        return { source: new Uint8Array(input.buffer, input.byteOffset, input.byteLength) };
    }
    if (input instanceof ArrayBuffer) return { invalid: true };
    if (input === null || input === undefined) {
        throw new TypeError(`JSONL.${method} requires a string argument`);
    }
    return { source: `${input as string}` };
}

function clampOffset(value: unknown, fallback: number, max: number): number {
    if (typeof value !== 'number') return fallback;
    return Math.min(Math.floor(value), max);
}

function runScan(
    source: string | Uint8Array,
    start: unknown,
    end: unknown,
): JSONLParseChunkResult {
    const length = source.length;
    const stop = typeof end === 'number' && end >= 0 ? clampOffset(end, length, length) : length;
    const from = typeof start === 'number' && start >= 0 ? clampOffset(start, 0, length) : 0;
    const values: unknown[] = [];
    if (from >= stop) return { values, read: stop, done: true, error: null };

    let read = from;
    let position = from;
    if (typeof source !== 'string' && from === 0 && stop >= 3 &&
        source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) {
        // The oracle skips a UTF-8 byte order mark at the start of byte input.
        position = 3;
        read = 3;
    }

    const scanner = new Scanner(source, stop);
    while (true) {
        while (position < stop && isJSONSpace(scanner.code(position))) position++;
        if (position >= stop) return { values, read, done: true, error: null };
        scanner.topStart = position;
        const next = scanner.value(position);
        if (next === INCOMPLETE) return { values, read, done: false, error: null };
        if (next === ERROR) {
            if (scanner.partialEnd >= 0) {
                values.push(JSON.parse(scanner.slice(position, scanner.partialEnd)));
                read = scanner.partialEnd;
            }
            return { values, read, done: false, error: new SyntaxError(FAILURE_MESSAGE) };
        }
        values.push(JSON.parse(scanner.slice(position, next)));
        read = next;
        // Top-level values are separated by a line feed. Other trailing bytes are an error.
        let separator = next;
        while (separator < stop && (scanner.code(separator) === 0x20 ||
            scanner.code(separator) === 0x09 || scanner.code(separator) === 0x0d)) separator++;
        if (separator >= stop) return { values, read, done: true, error: null };
        if (scanner.code(separator) !== 0x0a) {
            return { values, read, done: false, error: new SyntaxError(FAILURE_MESSAGE) };
        }
        position = separator + 1;
    }
}

/** Parses JSON Lines input and returns values, throwing only when no value precedes an error. */
export function parseJSONL(input: JSONLInput | string): unknown[] {
    const normalized = normalize(input, 'parse');
    if ('invalid' in normalized) throw new SyntaxError(FAILURE_MESSAGE);
    const result = runScan(normalized.source, 0, undefined);
    if (result.error && result.values.length === 0) throw result.error;
    return result.values;
}

/** Streaming parse. Never throws for malformed input; reports it through `error`. */
export function parseJSONLChunk(input: JSONLInput | string, start?: number, end?: number): JSONLParseChunkResult {
    const normalized = normalize(input, 'parseChunk');
    if ('invalid' in normalized) {
        return { values: [], read: 0, done: false, error: new SyntaxError(FAILURE_MESSAGE) };
    }
    return runScan(normalized.source, start, end);
}

export const JSONL = { parse: parseJSONL, parseChunk: parseJSONLChunk };
