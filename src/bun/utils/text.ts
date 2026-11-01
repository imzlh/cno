export interface StringWidthOptions {
    ambiguousIsNarrow?: boolean;
    countAnsiEscapeCodes?: boolean;
    perCodePoint?: boolean;
}

/** Strip terminal control sequences, including OSC hyperlinks and C1 CSI. */
export function stripANSI(text: string): string {
    if (typeof text !== 'string') throw new TypeError('Expected a string');
    let result = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code !== 0x1b && code !== 0x9b && code !== 0x9d && code !== 0x90 &&
            code !== 0x98 && code !== 0x9e && code !== 0x9f) continue;
        const escapeStart = i;
        let command = code;
        if (code === 0x1b) {
            if (i + 1 === text.length) continue;
            command = text.charCodeAt(++i);
        }
        if (command === 0x5b || command === 0x9b) {
            // A CSI consists of parameters/intermediates followed by a final byte.
            let j = i + 1;
            while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++;
            if (j === text.length || text.charCodeAt(j) < 0x40 || text.charCodeAt(j) > 0x7e) {
                i = j - 1;
                continue;
            }
            i = j;
        } else if ([0x5d, 0x50, 0x58, 0x5e, 0x5f, 0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(command)) {
            const osc = command === 0x5d || command === 0x9d;
            let j = i + 1;
            for (; j < text.length; j++) {
                if (text.charCodeAt(j) === 0x9c || (osc && text.charCodeAt(j) === 7)) break;
                if (text.charCodeAt(j) === 0x1b && text[j + 1] === '\\') { j++; break; }
            }
            // An unterminated control string must not swallow the remaining text.
            if (j === text.length) { i = j - 1; continue; }
            i = j;
        } else if (code === 0x1b) {
            let j = i;
            while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
            if (j === text.length || text.charCodeAt(j) < 0x30 || text.charCodeAt(j) > 0x7e) continue;
            i = j;
        }
        result += text.slice(start, escapeStart);
        start = i + 1;
    }
    return result + text.slice(start);
}

function isWide(code: number): boolean {
    return code >= 0x1100 && (
        code <= 0x115f || code === 0x2329 || code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x16fe0 && code <= 0x16fe4) || (code >= 0x17000 && code <= 0x18dff) ||
        (code >= 0x1aff0 && code <= 0x1afff) || (code >= 0x1b000 && code <= 0x1b2ff) ||
        (code >= 0x1f200 && code <= 0x1f251) || (code >= 0x20000 && code <= 0x3fffd)
    );
}

const zeroWidth = /[\p{Mark}\p{Cf}]/u;
const emojiPresentation = /\p{Emoji_Presentation}/u;
const extendedPictographic = /\p{Extended_Pictographic}/u;
const graphemeExtend = /[\p{Grapheme_Extend}\p{Emoji_Modifier}]/u;

const ZWJ = 0x200d;
const ZWNJ = 0x200c;
const VS16 = 0xfe0f;
const COMBINING_KEYCAP = 0x20e3;

// Common East Asian Ambiguous ranges (Latin-1 symbols, Greek, box drawing, blocks, arrows).
// This is a subset of the full EastAsianWidth "A" table, not the complete list.
const ambiguousRanges: ReadonlyArray<readonly [number, number]> = [
    [0xa1, 0xa1], [0xa4, 0xa4], [0xa7, 0xa8], [0xaa, 0xaa], [0xad, 0xae],
    [0xb0, 0xb4], [0xb6, 0xba], [0xbc, 0xbf], [0xc6, 0xc6], [0xd0, 0xd0],
    [0xd7, 0xd8], [0xde, 0xe1], [0xe6, 0xe6], [0xe8, 0xea], [0xec, 0xed],
    [0xf0, 0xf0], [0xf2, 0xf3], [0xf7, 0xfa], [0xfc, 0xfc], [0xfe, 0xfe],
    [0x391, 0x3a1], [0x3a3, 0x3a9], [0x3b1, 0x3c1], [0x3c3, 0x3c9],
    [0x2190, 0x2195], [0x2460, 0x24e9], [0x2500, 0x254b], [0x2550, 0x2573],
    [0x2580, 0x258f], [0x25a0, 0x25a1], [0x25b2, 0x25b3], [0x25cb, 0x25cb],
];

function isAmbiguous(code: number): boolean {
    let low = 0;
    let high = ambiguousRanges.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const [start, end] = ambiguousRanges[mid];
        if (code < start) high = mid - 1;
        else if (code > end) low = mid + 1;
        else return true;
    }
    return false;
}

/** Width of one code point on its own: 0 for controls, marks and format characters. */
function codePointWidth(code: number, ambiguousIsNarrow: boolean): number {
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return 0;
    const char = String.fromCodePoint(code);
    if (zeroWidth.test(char)) return 0;
    if (isWide(code) || emojiPresentation.test(char)) return 2;
    return !ambiguousIsNarrow && isAmbiguous(code) ? 2 : 1;
}

function isExtendedPictographic(code: number): boolean {
    return extendedPictographic.test(String.fromCodePoint(code));
}

function isRegionalIndicator(code: number): boolean {
    return code >= 0x1f1e6 && code <= 0x1f1ff;
}

function isTag(code: number): boolean {
    return code >= 0xe0020 && code <= 0xe007f;
}

/** Characters that can form a keycap sequence with U+FE0F and U+20E3. */
function isKeycapBase(code: number): boolean {
    return code === 0x23 || code === 0x2a || (code >= 0x30 && code <= 0x39);
}

function isGraphemeExtend(code: number): boolean {
    return code === ZWNJ || isTag(code) || graphemeExtend.test(String.fromCodePoint(code));
}

/**
 * End index (exclusive) of the extended grapheme cluster starting at `start`.
 * Implements the UAX #29 rules needed for emoji: combining marks, emoji modifiers,
 * ZWJ joins between pictographic characters (GB11), and regional-indicator pairs (GB12/13).
 */
function graphemeEnd(code: number[], start: number): number {
    const base = code[start];
    let i = start + 1;
    if (isRegionalIndicator(base) && i < code.length && isRegionalIndicator(code[i])) i++;
    const joinable = isExtendedPictographic(base);
    while (i < code.length) {
        const cp = code[i];
        // A ZWJ joins the next pictographic only when the cluster starts with one.
        if (code[i - 1] === ZWJ && joinable && isExtendedPictographic(cp)) { i++; continue; }
        if (cp === ZWJ || isGraphemeExtend(cp)) { i++; continue; }
        break;
    }
    return i;
}

function graphemeWidth(cluster: number[], ambiguousIsNarrow: boolean): number {
    const base = cluster[0];
    // Text-default characters become emoji (2 cells) with VS16, keycap or tag selectors.
    const hasPresentationSelector = cluster.some(cp => cp === VS16 || cp === COMBINING_KEYCAP || isTag(cp));
    if (hasPresentationSelector && (isExtendedPictographic(base) || isKeycapBase(base))) return 2;
    // The widest member wins, so ZWJ sequences and flags take the width of their emoji.
    let width = 0;
    for (const cp of cluster) width = Math.max(width, codePointWidth(cp, ambiguousIsNarrow));
    return width;
}

/**
 * Terminal cell width. By default, each extended grapheme cluster counts once, so emoji
 * ZWJ sequences, skin tones, flags and keycaps measure as one emoji. With `perCodePoint`,
 * every code point counts on its own, so `"👨‍👩‍👧‍👦"` measures 8.
 */
export function stringWidth(text: string, options: StringWidthOptions = {}): number {
    if (typeof text !== 'string') throw new TypeError('Expected a string');
    if (!options.countAnsiEscapeCodes) text = stripANSI(text);
    const ambiguousIsNarrow = options.ambiguousIsNarrow !== false;
    const code = Array.from(text, char => char.codePointAt(0)!);
    let width = 0;
    if (options.perCodePoint) {
        for (const cp of code) width += codePointWidth(cp, ambiguousIsNarrow);
        return width;
    }
    for (let start = 0; start < code.length;) {
        const end = graphemeEnd(code, start);
        width += graphemeWidth(code.slice(start, end), ambiguousIsNarrow);
        start = end;
    }
    return width;
}

export interface SliceAnsiOptions {
    ellipsis?: string;
    ambiguousIsNarrow?: boolean;
}

export interface WrapAnsiOptions {
    hard?: boolean;
    wordWrap?: boolean;
    trim?: boolean;
    ambiguousIsNarrow?: boolean;
}

/** A tokenized piece of input: an escape sequence (zero width) or one grapheme cluster. */
type AnsiItem =
    | { kind: 'esc'; raw: string }
    | { kind: 'text'; text: string; width: number; space: boolean };

/** Open style per attribute key, plus the open OSC 8 hyperlink under `LINK_KEY`. */
type StyleState = Map<string, string>;

const LINK_KEY = 'link';
const LINK_CLOSE = '\x1b]8;;\x07';
const SGR_CLOSE: Readonly<Record<string, string>> = {
    bold: '\x1b[22m', dim: '\x1b[22m', italic: '\x1b[23m', underline: '\x1b[24m',
    blink: '\x1b[25m', inverse: '\x1b[27m', hidden: '\x1b[28m', strike: '\x1b[29m',
    overline: '\x1b[55m', fg: '\x1b[39m', bg: '\x1b[49m',
};
const SGR_SET = new Map<number, string>([
    [1, 'bold'], [2, 'dim'], [3, 'italic'], [4, 'underline'], [21, 'underline'],
    [5, 'blink'], [6, 'blink'], [7, 'inverse'], [8, 'hidden'], [9, 'strike'], [53, 'overline'],
]);
const SGR_UNSET = new Map<number, string>([
    [23, 'italic'], [24, 'underline'], [25, 'blink'], [27, 'inverse'],
    [28, 'hidden'], [29, 'strike'], [55, 'overline'],
]);

function isEscapeStart(code: number): boolean {
    return code === 0x1b || code === 0x9b || code === 0x9d || code === 0x90 ||
        code === 0x98 || code === 0x9e || code === 0x9f;
}

/** Exclusive end of the escape sequence starting at `i`, or -1 if it is not a complete one. */
function escapeEnd(text: string, i: number): number {
    const len = text.length;
    let command = text.charCodeAt(i);
    let body = i + 1;
    if (command === 0x1b) {
        if (i + 1 >= len) return -1;
        command = text.charCodeAt(i + 1);
        body = i + 2;
    }
    if (command === 0x5b || command === 0x9b) {
        let j = body;
        while (j < len && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++;
        if (j >= len || text.charCodeAt(j) < 0x40 || text.charCodeAt(j) > 0x7e) return -1;
        return j + 1;
    }
    if ([0x5d, 0x50, 0x58, 0x5e, 0x5f, 0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(command)) {
        const osc = command === 0x5d || command === 0x9d;
        for (let j = body; j < len; j++) {
            const c = text.charCodeAt(j);
            if (c === 0x9c || (osc && c === 7)) return j + 1;
            if (c === 0x1b && text[j + 1] === '\\') return j + 2;
        }
        return -1;
    }
    if (text.charCodeAt(i) === 0x1b) {
        let j = i + 1;
        while (j < len && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
        if (j >= len || text.charCodeAt(j) < 0x30 || text.charCodeAt(j) > 0x7e) return -1;
        return j + 1;
    }
    return -1;
}

function tokenize(input: string, ambiguousIsNarrow: boolean): AnsiItem[] {
    const items: AnsiItem[] = [];
    const pushText = (run: string): void => {
        const cps = Array.from(run, char => char.codePointAt(0)!);
        const chars = Array.from(run);
        for (let start = 0; start < cps.length;) {
            const end = graphemeEnd(cps, start);
            const text = chars.slice(start, end).join('');
            items.push({
                kind: 'text',
                text,
                width: graphemeWidth(cps.slice(start, end), ambiguousIsNarrow),
                space: text === ' ',
            });
            start = end;
        }
    };
    let runStart = 0;
    for (let i = 0; i < input.length;) {
        const end = isEscapeStart(input.charCodeAt(i)) ? escapeEnd(input, i) : -1;
        if (end > i) {
            pushText(input.slice(runStart, i));
            items.push({ kind: 'esc', raw: input.slice(i, end) });
            i = end;
            runStart = end;
        } else {
            i++;
        }
    }
    pushText(input.slice(runStart));
    return items;
}

/** Applies one escape sequence to the style state. Unsupported sequences are ignored. */
function applyEscape(state: StyleState, raw: string): void {
    const oscStart = raw.charCodeAt(0) === 0x9d ? 1 : raw.startsWith('\x1b]') ? 2 : -1;
    if (oscStart > 0) {
        const payload = raw.slice(oscStart).replace(/(\x07|\x9c|\x1b\\)$/, '');
        if (payload.startsWith('8;')) {
            // OSC 8 is `8;params;uri`. An empty URI closes the hyperlink.
            const sep = payload.indexOf(';', 2);
            const uri = sep === -1 ? '' : payload.slice(sep + 1);
            if (uri === '') state.delete(LINK_KEY);
            else state.set(LINK_KEY, raw);
        }
        return;
    }
    const csiStart = raw.charCodeAt(0) === 0x9b ? 1 : raw.startsWith('\x1b[') ? 2 : -1;
    if (csiStart < 0 || !raw.endsWith('m')) return;
    const params = raw.slice(csiStart, -1);
    if (!/^[0-9;:]*$/.test(params)) return;
    const parts = params === '' ? ['0'] : params.split(';');
    for (let k = 0; k < parts.length; k++) {
        const part = parts[k];
        const code = Number.parseInt(part, 10) || 0;
        if (code === 0) {
            for (const key of [...state.keys()]) if (key !== LINK_KEY) state.delete(key);
        } else if (code === 22) {
            state.delete('bold');
            state.delete('dim');
        } else if (code === 4 && /^4:0*$/.test(part)) {
            state.delete('underline');
        } else if (SGR_SET.has(code)) {
            state.set(SGR_SET.get(code)!, `\x1b[${part}m`);
        } else if (SGR_UNSET.has(code)) {
            state.delete(SGR_UNSET.get(code)!);
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            state.set('fg', `\x1b[${part}m`);
        } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
            state.set('bg', `\x1b[${part}m`);
        } else if (code === 39) {
            state.delete('fg');
        } else if (code === 49) {
            state.delete('bg');
        } else if (code === 38 || code === 48) {
            // Colon sub-parameters stay in one token. Semicolon form uses `5;n` or `2;r;g;b`.
            const argCount = part.includes(':') ? 0 : parts[k + 1] === '5' ? 2 : parts[k + 1] === '2' ? 4 : -1;
            if (argCount < 0 || k + argCount >= parts.length) continue;
            const seq = parts.slice(k, k + argCount + 1).join(';');
            state.set(code === 38 ? 'fg' : 'bg', `\x1b[${seq}m`);
            k += argCount;
        }
    }
}

function sgrOpen(state: StyleState): string {
    let out = '';
    for (const [key, open] of state) if (key !== LINK_KEY) out += open;
    return out;
}

function sgrClose(state: StyleState): string {
    const seen = new Set<string>();
    let out = '';
    for (const key of state.keys()) {
        if (key === LINK_KEY) continue;
        const close = SGR_CLOSE[key] ?? '';
        if (close !== '' && !seen.has(close)) {
            seen.add(close);
            out += close;
        }
    }
    return out;
}

function widthOf(items: readonly AnsiItem[]): number {
    let width = 0;
    for (const item of items) if (item.kind === 'text') width += item.width;
    return width;
}

function columnIndex(value: number | undefined, total: number, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number') throw new TypeError('Expected a number');
    const index = Number.isNaN(value) ? 0 : Math.trunc(value);
    if (index < 0) return Math.max(total + index, 0);
    return Math.min(index, total);
}

function sliceOptions(
    options: string | boolean | SliceAnsiOptions | undefined,
    ambiguousPosition: boolean | undefined,
): { ellipsis: string; ambiguousIsNarrow: boolean } {
    if (typeof options === 'string') return { ellipsis: options, ambiguousIsNarrow: ambiguousPosition ?? true };
    if (typeof options === 'boolean') return { ellipsis: '', ambiguousIsNarrow: options };
    if (options && typeof options === 'object') {
        const ellipsis = options.ellipsis ?? '';
        if (typeof ellipsis !== 'string') throw new TypeError('Expected ellipsis to be a string');
        return { ellipsis, ambiguousIsNarrow: options.ambiguousIsNarrow ?? true };
    }
    return { ellipsis: '', ambiguousIsNarrow: ambiguousPosition ?? true };
}

/**
 * Slice by terminal columns while keeping SGR styles and OSC 8 hyperlinks valid.
 * Styles open before the slice are re-opened at its start, and styles still open at
 * its end are closed. Wide graphemes that straddle an edge are dropped. Negative
 * indices count from the end. With `ellipsis`, each cut edge is marked with the
 * ellipsis, which takes columns from the content. It is drawn inside SGR styles and
 * outside the hyperlink.
 */
export function sliceAnsi(
    input: string,
    start?: number,
    end?: number,
    options?: string | boolean | SliceAnsiOptions,
    ambiguousIsNarrow?: boolean,
): string {
    if (typeof input !== 'string') throw new TypeError('Expected a string');
    const slice = sliceOptions(options, ambiguousIsNarrow);
    const items = tokenize(input, slice.ambiguousIsNarrow);
    const total = widthOf(items);
    const from = columnIndex(start, total, 0);
    const to = columnIndex(end, total, total);
    if (from >= to) return '';

    const ellipsisWidth = slice.ellipsis === '' ? 0 : stringWidth(slice.ellipsis, { ambiguousIsNarrow: slice.ambiguousIsNarrow });
    const cutLeft = slice.ellipsis !== '' && from > 0;
    const cutRight = slice.ellipsis !== '' && to < total;
    // When the window is too narrow for both marks, drop them instead of overflowing.
    const marksFit = ellipsisWidth * (Number(cutLeft) + Number(cutRight)) <= to - from;
    const leftMark = cutLeft && marksFit ? slice.ellipsis : '';
    const rightMark = cutRight && marksFit ? slice.ellipsis : '';
    const contentStart = from + (leftMark ? ellipsisWidth : 0);
    const contentEnd = to - (rightMark ? ellipsisWidth : 0);

    const state: StyleState = new Map();
    let col = 0;
    let i = 0;
    // Apply every escape before the content window so the styles in effect at its start are known.
    for (; i < items.length && col < contentStart; i++) {
        const item = items[i];
        if (item.kind === 'esc') applyEscape(state, item.raw);
        else col += item.width;
    }
    const openSgr = sgrOpen(state);
    const openLink = state.get(LINK_KEY) ?? '';

    let body = '';
    let visible = false;
    for (; i < items.length; i++) {
        const item = items[i];
        if (col >= contentEnd) break;
        if (item.kind === 'esc') {
            body += item.raw;
            applyEscape(state, item.raw);
            continue;
        }
        if (col >= contentStart && col + item.width <= contentEnd) {
            body += item.text;
            visible = true;
        }
        col += item.width;
    }
    if (!visible && !leftMark && !rightMark) return '';
    const closeLink = state.has(LINK_KEY) ? LINK_CLOSE : '';
    return openSgr + leftMark + openLink + body + closeLink + rightMark + sgrClose(state);
}

/**
 * Wrap to `columns` terminal cells while keeping SGR styles and OSC 8 hyperlinks valid
 * on every row. Each row re-opens the styles active at its start and closes the ones
 * still open at its end. Existing `\n` characters always start a new row.
 */
export function wrapAnsi(input: string, columns: number, options: WrapAnsiOptions = {}): string {
    if (typeof input !== 'string') throw new TypeError('Expected a string');
    if (typeof columns !== 'number' || Number.isNaN(columns)) throw new TypeError('Expected a number of columns');
    const width = Math.max(1, Math.floor(columns));
    const hard = options.hard ?? false;
    const wordWrap = options.wordWrap ?? true;
    const trim = options.trim ?? true;
    const ambiguousIsNarrow = options.ambiguousIsNarrow ?? true;

    const state: StyleState = new Map();
    const rows: string[] = [];
    let row: AnsiItem[] = [];
    let rowWidth = 0;
    let rowHasText = false;
    let rowStart: StyleState = new Map();
    // Escapes and spaces that wait for the next placement decision. Breaks drop the spaces.
    let pending: AnsiItem[] = [];
    // Escapes and non-space graphemes of the word being collected.
    let word: AnsiItem[] = [];
    const isEscape = (item: AnsiItem): boolean => item.kind === 'esc';

    const emit = (item: AnsiItem): void => {
        row.push(item);
        if (item.kind === 'esc') {
            applyEscape(state, item.raw);
        } else {
            rowWidth += item.width;
            rowHasText = true;
        }
    };
    const flushPending = (): void => {
        for (const item of pending) emit(item);
        pending = [];
    };
    const finishRow = (): void => {
        let items = row;
        if (trim) {
            // Drop visible spaces at both edges and keep escapes, so the state stays accurate.
            items = items.slice();
            const isSpace = (item: AnsiItem): boolean => item.kind === 'text' && item.space;
            for (let k = 0; k < items.length;) {
                if (isSpace(items[k])) items.splice(k, 1);
                else if (items[k].kind === 'esc') k++;
                else break;
            }
            for (let k = items.length - 1; k >= 0;) {
                if (isSpace(items[k])) items.splice(k, 1);
                else if (items[k].kind === 'esc') k--;
                else break;
            }
        }
        if (items.length > 0) {
            const body = items.map(item => (item.kind === 'esc' ? item.raw : item.text)).join('');
            const openLink = rowStart.get(LINK_KEY) ?? '';
            rows.push(sgrOpen(rowStart) + openLink + body + (state.has(LINK_KEY) ? LINK_CLOSE : '') + sgrClose(state));
        } else {
            rows.push('');
        }
        row = [];
        rowWidth = 0;
        rowHasText = false;
        rowStart = new Map(state);
    };
    // Breaks the row before `item` when it would overflow. Pending escapes move to the new row.
    const placeChar = (item: AnsiItem & { kind: 'text' }): void => {
        const pendingWidth = widthOf(pending);
        if (rowHasText && rowWidth + pendingWidth + item.width > width) {
            if (trim) pending = pending.filter(isEscape);
            finishRow();
        }
        flushPending();
        emit(item);
    };
    const placeWord = (): void => {
        const current = word;
        word = [];
        const wordWidth = widthOf(current);
        const pendingWidth = widthOf(pending);
        if (rowHasText && rowWidth + pendingWidth + wordWidth <= width) {
            flushPending();
            for (const item of current) emit(item);
            return;
        }
        if (rowHasText) {
            if (trim) {
                pending = pending.filter(isEscape);
            } else {
                // Untrimmed spaces at a break stay on the old row while they fit. The rest are dropped.
                const fits: AnsiItem[] = [];
                let room = width - rowWidth;
                for (const item of pending) {
                    if (item.kind === "esc") fits.push(item);
                    else if (item.width <= room) { fits.push(item); room -= item.width; }
                }
                pending = fits;
                flushPending();
            }
            finishRow();
        }
        if (trim) pending = pending.filter(isEscape);
        if (wordWidth <= width || !hard) {
            flushPending();
            for (const item of current) emit(item);
            return;
        }
        for (const item of current) {
            if (item.kind === 'esc') pending.push(item);
            else placeChar(item);
        }
    };
    const endLine = (): void => {
        if (word.length > 0) placeWord();
        if (trim) pending = pending.filter(isEscape);
        flushPending();
        finishRow();
    };

    for (const item of tokenize(input, ambiguousIsNarrow)) {
        if (item.kind === 'esc') {
            if (word.length > 0) word.push(item);
            else pending.push(item);
            continue;
        }
        if (item.text === '\n') {
            endLine();
            continue;
        }
        if (!wordWrap) {
            placeChar(item);
            continue;
        }
        if (item.space) {
            if (word.length > 0) placeWord();
            pending.push(item);
            continue;
        }
        word.push(item);
    }
    endLine();
    return rows.join('\n');
}
