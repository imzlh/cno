/** A deliberately partial implementation of Bun 1.4.4's color utility.
 * Unsupported output formats throw instead of returning approximations. */
const engine = import.meta.use('engine');
type RGBA = [number, number, number, number];
const names: Record<string, string> = {
    black: '000000', silver: 'c0c0c0', gray: '808080', grey: '808080', white: 'ffffff',
    maroon: '800000', red: 'ff0000', purple: '800080', fuchsia: 'ff00ff', magenta: 'ff00ff',
    green: '008000', lime: '00ff00', olive: '808000', yellow: 'ffff00', navy: '000080',
    blue: '0000ff', teal: '008080', aqua: '00ffff', cyan: '00ffff', orange: 'ffa500',
    rebeccapurple: '663399', transparent: '00000000',
};
const formats = ['[r,g,b,a]', '[rgb]', '[rgba]', '{r,g,b}', '{rgb}', '{rgba}', 'ansi_256', 'ansi-256', 'ansi_16', 'ansi-16', 'ansi_16m', 'ansi-16m', 'ansi-24bit', 'ansi-truecolor', 'ansi', 'ansi256', 'css', 'hex', 'HEX', 'hsl', 'lab', 'number', 'rgb', 'rgba'];
const clamp = (x: number, max: number) => Math.max(0, Math.min(max, Number.isNaN(x) ? 0 : x));
const byte = (x: number) => Math.trunc(clamp(x, 255));
const xtermCubeLevels = [0, 95, 135, 175, 215, 255];
// xterm's default 16-entry palette: the reference colors Bun's ansi-16 output
// approximates. Entries 8-15 are the bright variants mapped to SGR 90-97.
const ansi16Palette: readonly (readonly [number, number, number])[] = [
    [0x00, 0x00, 0x00], [0xcd, 0x00, 0x00], [0x00, 0xcd, 0x00], [0xcd, 0xcd, 0x00],
    [0x00, 0x00, 0xee], [0xcd, 0x00, 0xcd], [0x00, 0xcd, 0xcd], [0xe5, 0xe5, 0xe5],
    [0x7f, 0x7f, 0x7f], [0xff, 0x00, 0x00], [0x00, 0xff, 0x00], [0xff, 0xff, 0x00],
    [0x5c, 0x5c, 0xff], [0xff, 0x00, 0xff], [0x00, 0xff, 0xff], [0xff, 0xff, 0xff],
];
// The intrinsic brand checks work across realms and cannot be shadowed by an
// own `length` getter. DataView fails the TypedArray length getter below.
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!;
const stringValueOf = String.prototype.valueOf;
const stringFrom = String;
type IndexedColorInput = { readonly [index: number]: unknown };
function f32String(n: number): string {
    const v = Math.fround(n);
    for (let p = 1; p <= 9; p++) {
        const s = Number(v.toPrecision(p)).toString();
        if (Math.fround(Number(s)) === v) return s;
    }
    return String(v);
}
function hexParse(s: string): RGBA | null {
    if (!/^(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(s)) return null;
    if (s.length <= 4) s = [...s].map(c => c + c).join('');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), s.length === 8 ? parseInt(s.slice(6), 16) : 255];
}
function cssNumber(s: string, scale: number): number | null {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(s)) return null;
    const n = parseFloat(s);
    const result = s.endsWith('%') ? n * scale / 100 : n;
    return Number.isFinite(result) ? result : null;
}

/** The fixed xterm palette RGB triple behind a 16-255 palette index. */
function xterm256Entry(index: number): readonly [number, number, number] {
    if (index < 232) {
        const cube = index - 16;
        return [
            xtermCubeLevels[Math.floor(cube / 36)]!,
            xtermCubeLevels[Math.floor(cube / 6) % 6]!,
            xtermCubeLevels[cube % 6]!,
        ];
    }
    const gray = 8 + (index - 232) * 10;
    return [gray, gray, gray];
}

function ansi256Index(r: number, g: number, b: number): number {
    let closest = 16;
    let closestDistance = Infinity;
    for (let index = 16; index <= 255; index++) {
        const [pr, pg, pb] = xterm256Entry(index);
        const dr = r - pr;
        const dg = g - pg;
        const db = b - pb;
        const distance = dr * dr + dg * dg + db * db;
        // Walking indices in order makes equal distances choose the lower color.
        if (distance < closestDistance) {
            closest = index;
            closestDistance = distance;
        }
    }
    return closest;
}

/** SGR foreground code (30-37 or 90-97) for the nearest of the 16 ANSI colors. */
function ansi16Code(r: number, g: number, b: number): number {
    // Bun chains through ansi-256 before picking the 16-color entry, which
    // keeps the two formats consistent for colors the 256-palette rounds
    // together.
    const [pr, pg, pb] = xterm256Entry(ansi256Index(r, g, b));
    let index = 0;
    let closestDistance = Infinity;
    for (let candidate = 0; candidate < 16; candidate++) {
        const [cr, cg, cb] = ansi16Palette[candidate]!;
        const distance = (pr - cr) * (pr - cr) + (pg - cg) * (pg - cg) + (pb - cb) * (pb - cb);
        if (distance < closestDistance) {
            closestDistance = distance;
            index = candidate;
        }
    }
    return index < 8 ? 30 + index : 82 + index;
}

function parseString(input: string): RGBA | null {
    const s = input.trim();
    if (Object.prototype.hasOwnProperty.call(names, s)) return hexParse(names[s]);
    if (s.startsWith('#')) return hexParse(s.slice(1));
    const match = /^(rgb|rgba|hsl|hsla)\((.*)\)$/.exec(s);
    if (!match) return null;
    const body = match[2].trim();
    const comma = body.includes(',');
    let parts: string[];
    let alphaPart: string | undefined;
    if (comma) {
        if (body.includes('/')) return null;
        parts = body.split(',').map(x => x.trim());
        // Keep the historical permissive comma grammar: rgba/hsla are aliases,
        // and rgb/hsl also accept an optional fourth alpha component.
        if ((parts.length !== 3 && parts.length !== 4) || parts.some(part => part.length === 0)) return null;
        alphaPart = parts.length === 4 ? parts.pop() : undefined;
    } else {
        const slash = body.split('/');
        if (slash.length > 2) return null;
        parts = slash[0].trim().split(/\s+/);
        if (parts.length !== 3 || parts.some(part => part.length === 0)) return null;
        if (slash.length === 2) {
            alphaPart = slash[1].trim();
            if (alphaPart.length === 0) return null;
        }
    }
    const alpha = alphaPart === undefined ? 1 : cssNumber(alphaPart, 1);
    if (alpha === null) return null;
    const a = Math.round(clamp(alpha, 1) * 255);
    if (match[1].startsWith('rgb')) {
        const rgb = parts.slice(0, 3).map(x => cssNumber(x, 255));
        if (rgb.some(x => x === null)) return null;
        return [Math.round(clamp(rgb[0]!, 255)), Math.round(clamp(rgb[1]!, 255)), Math.round(clamp(rgb[2]!, 255)), a];
    }
    const hueMatch = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/.exec(parts[0]);
    if (!hueMatch || !parts[1].endsWith('%') || !parts[2].endsWith('%')) return null;
    const sat = cssNumber(parts[1], 1), light = cssNumber(parts[2], 1);
    if (sat === null || light === null) return null;
    let h = Number(hueMatch[1]);
    if (!Number.isFinite(h)) return null;
    if (hueMatch[2] === 'turn') h *= 360;
    if (hueMatch[2] === 'rad') h *= 180 / Math.PI;
    if (hueMatch[2] === 'grad') h *= 0.9;
    if (!Number.isFinite(h)) return null;
    h = ((h % 360) + 360) % 360;
    const l = clamp(light, 1), c = (1 - Math.abs(2 * l - 1)) * clamp(sat, 1);
    const x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255), a];
}

function indexedTypedArrayLength(value: object): number | undefined {
    if (!arrayBufferIsView(value)) return undefined;
    try {
        return Reflect.apply(typedArrayLength, value, []) as number;
    } catch {
        return undefined;
    }
}

function parseArrayInput(input: IndexedColorInput, length: number): RGBA {
    if (length !== 3 && length !== 4) throw new Error('Expected array length 3 or 4');
    const values: number[] = [];
    for (let index = 0; index < 3; index++) {
        const value = input[index];
        if (typeof value !== 'number') throw new TypeError(`Expected [${index}] to be a integer for 'color'.`);
        values.push(byte(value));
    }
    let alpha = 255;
    if (length === 4) {
        const value = input[3];
        if (typeof value !== 'number') throw new TypeError("Expected [3] to be a integer for 'color'.");
        alpha = byte(value);
    }
    return [values[0], values[1], values[2], alpha];
}

function parseObjectInput(input: Record<string, unknown>): RGBA {
    const values: number[] = [];
    for (const key of ['r', 'g', 'b']) {
        const value = input[key];
        if (typeof value !== 'number') throw new TypeError(`Expected ${key} to be a integer for 'color'.`);
        values.push(byte(value));
    }
    let alpha = 255;
    const value = input.a;
    if (typeof value === 'number') alpha = byte(clamp(value, 1) * 255);
    return [values[0], values[1], values[2], alpha];
}

function parse(input: unknown): RGBA | null {
    if (input === undefined) throw new TypeError("Expected input to be a string, number, or object for 'color'.");
    if (input === null) return null;
    if (typeof input === 'string') return parseString(input);
    if (typeof input === 'number') {
        const n = (input === Infinity ? 0xffffffff : input === -Infinity ? 0 : Math.trunc(input)) >>> 0;
        return [(n >>> 16) & 255, (n >>> 8) & 255, n & 255, n > 0xffffff ? (n >>> 24) & 255 : 255];
    }
    if (typeof input === 'symbol') throw new TypeError('Cannot convert a symbol to a string');
    if (typeof input !== 'object' && typeof input !== 'function') return null;
    if (!engine.isProxy(input) && Array.isArray(input)) return parseArrayInput(input, input.length);
    const typedLength = indexedTypedArrayLength(input);
    if (typedLength !== undefined) return parseArrayInput(input as IndexedColorInput, typedLength);
    return parseObjectInput(input as Record<string, unknown>);
}

function normalizeFormat(format: unknown): string {
    if (format == null) return 'css';
    if (typeof format === 'string') return format;
    if (typeof format === 'object') {
        try {
            Reflect.apply(stringValueOf, format, []);
        } catch {
            throw new TypeError("Expected format to be a string for 'color'.");
        }
        return stringFrom(format);
    }
    throw new TypeError("Expected format to be a string for 'color'.");
}
/** 0 disables ANSI output, 1 selects ansi-16, 2 ansi-256, 3 truecolor. */
export type AnsiColorDepth = 0 | 1 | 2 | 3;

/**
 * The color depth Bun's "ansi" format selects for stdout, following Bun's
 * env-based detection: FORCE_COLOR overrides everything (numeric strings
 * parse, case-insensitive true/false, anything unrecognized falls back to
 * ANSI 16), then NO_COLOR (where only 'false'/'0' leave color enabled), then
 * the TERM/TMUX/CI/COLORTERM table — which the installed Bun 1.4.4 oracle
 * answers from even on a piped stdout, so there is no TTY gate on this path.
 * An unrecognized terminal yields depth 0, matching Bun's fallthrough.
 */
export function ansiColorDepth(env: Record<string, string | undefined>, stdoutTty: boolean): AnsiColorDepth {
    void stdoutTty;
    const force = env.FORCE_COLOR;
    if (force !== undefined) {
        if (/^-?\d+$/.test(force)) {
            return Math.min(3, Math.max(0, Number(force))) as AnsiColorDepth;
        }
        const lowered = force.toLowerCase();
        if (lowered === 'false') return 0;
        // 'true', '', and unrecognized values all select ANSI 16.
        return 1;
    }
    const noColor = env.NO_COLOR;
    if (noColor !== undefined && noColor !== '') {
        const lowered = noColor.toLowerCase();
        if (lowered !== 'false' && lowered !== '0') return 0;
    }
    if (env.TERM === 'dumb') return 0;
    if (env.TMUX !== undefined) return 3;
    if (env.CI !== undefined) return 1;
    const termProgram = env.TERM_PROGRAM;
    if (termProgram === 'ghostty' || termProgram === 'MacTerm' || termProgram === 'WezTerm'
        || termProgram === 'HyperTerm' || termProgram === 'iTerm.app') return 3;
    const colorterm = env.COLORTERM;
    if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
    const term = env.TERM;
    if (term !== undefined && term.startsWith('xterm-256')) return 2;
    if (term !== undefined) {
        const exact: Record<string, AnsiColorDepth> = {
            st: 1, hurd: 1, eterm: 1, gnome: 1, kterm: 1, mosh: 3, putty: 1,
            cons25: 1, cygwin: 1, dtterm: 1, mlterm: 1, console: 1, jfbterm: 1,
            konsole: 1, terminator: 3, 'xterm-ghostty': 3, 'rxvt-unicode-24bit': 3,
        };
        const exactDepth = Object.prototype.hasOwnProperty.call(exact, term) ? exact[term] : undefined;
        if (exactDepth !== undefined) return exactDepth;
        if (/con|ansi|rxvt|color|linux|vt100|xterm|screen/.test(term)) return 1;
    }
    if (colorterm !== undefined) return 1;
    return 0;
}

let stdoutColorDepth: (() => AnsiColorDepth) | undefined;

/** Installed by the bun namespace bootstrap; the pure unit lane leaves it unset. */
export function setStdoutColorDepthProvider(provider: () => AnsiColorDepth): void {
    stdoutColorDepth = provider;
}

export const color = (input: unknown, format?: unknown): unknown => {
    if (input === undefined) throw new TypeError("Expected input to be a string, number, or object for 'color'.");
    const f = normalizeFormat(format);
    if (!formats.includes(f)) throw new TypeError(`format must be one of ${formats.map(x => `'${x}'`).join(', ').replace(/, 'rgba'$/, " or 'rgba'")}`);
    const rgba = parse(input);
    if (!rgba) return null;
    const [r, g, b, a] = rgba;
    const hex = [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    switch (f) {
        case 'hex': return '#' + hex;
        case 'HEX': return '#' + hex.toUpperCase();
        case 'number': return (r << 16) | (g << 8) | b;
        case '[rgb]': return [r, g, b];
        case '[rgba]': case '[r,g,b,a]': return [r, g, b, a];
        case '{rgb}': case '{r,g,b}': return { r, g, b };
        case '{rgba}': return { r, g, b, a: Math.fround(a / 255) };
        case 'rgb': return `rgb(${r}, ${g}, ${b})`;
        case 'rgba': return `rgba(${r}, ${g}, ${b}, ${f32String(a / 255)})`;
        case 'ansi_16m': case 'ansi-16m': case 'ansi-24bit': case 'ansi-truecolor': return `\x1b[38;2;${r};${g};${b}m`;
        case 'ansi_256': case 'ansi-256': case 'ansi256': return `\x1b[38;5;${ansi256Index(r, g, b)}m`;
        case 'ansi_16': case 'ansi-16': return `\x1b[${ansi16Code(r, g, b)}m`;
        case 'ansi': {
            // "ansi" is Bun's automatic format: pick the depth stdout supports
            // and return an empty string when it supports none.
            const depth = stdoutColorDepth ? stdoutColorDepth() : 0;
            if (depth === 0) return '';
            if (depth === 1) return `\x1b[${ansi16Code(r, g, b)}m`;
            if (depth === 2) return `\x1b[38;5;${ansi256Index(r, g, b)}m`;
            return `\x1b[38;2;${r};${g};${b}m`;
        }
        case 'css': {
            const full = hex + (a === 255 ? '' : a.toString(16).padStart(2, '0'));
            const short = full.match(/^(.)\1(.)\2(.)\3(?:(.)\4)?$/);
            const result = '#' + (short ? short.slice(1).filter(Boolean).join('') : full);
            const canonical: Record<string, string> = { 'ff0000': 'red', '008000': 'green', '808080': 'gray', '000080': 'navy', '800080': 'purple', '008080': 'teal', '800000': 'maroon', '808000': 'olive', 'c0c0c0': 'silver', 'ffa500': 'orange' };
            return a === 255 && canonical[hex] && canonical[hex].length <= result.length ? canonical[hex] : result;
        }
        default: throw new Error(`Bun.color output format '${f}' is not implemented`);
    }
};
