/** A deliberately partial implementation of Bun 1.4.4's color utility.
 * Unsupported output formats throw instead of returning approximations. */
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
// Unlike `instanceof`, this intrinsic recognizes typed arrays from another
// realm. DataView has no indexed color channels and remains an object input.
const arrayBufferIsView = ArrayBuffer.isView;
type IndexedColorInput = { readonly length: number; readonly [index: number]: unknown };
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

function ansi256Index(r: number, g: number, b: number): number {
    let closest = 16;
    let closestDistance = Infinity;
    for (let index = 16; index <= 255; index++) {
        let pr: number;
        let pg: number;
        let pb: number;
        if (index < 232) {
            const cube = index - 16;
            pr = xtermCubeLevels[Math.floor(cube / 36)]!;
            pg = xtermCubeLevels[Math.floor(cube / 6) % 6]!;
            pb = xtermCubeLevels[cube % 6]!;
        } else {
            pr = pg = pb = 8 + (index - 232) * 10;
        }
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

function isIndexedTypedArray(value: unknown): value is IndexedColorInput {
    return value !== null
        && typeof value === 'object'
        && arrayBufferIsView(value)
        && typeof Reflect.get(value, 'length') === 'number';
}

function parseArrayInput(input: IndexedColorInput): RGBA {
    if (input.length !== 3 && input.length !== 4) throw new Error('Expected array length 3 or 4');
    const values = [0, 1, 2].map(index => {
        const value = input[index];
        if (typeof value !== 'number') throw new TypeError(`Expected [${index}] to be a integer for 'color'.`);
        return byte(value);
    });
    let alpha = 255;
    const value = input[3];
    if (value !== undefined) {
        if (typeof value !== 'number') throw new TypeError("Expected [3] to be a integer for 'color'.");
        alpha = byte(value);
    }
    return [values[0], values[1], values[2], alpha];
}

function parseObjectInput(input: Record<string, unknown>): RGBA {
    const values = ['r', 'g', 'b'].map(key => {
        const value = input[key];
        if (typeof value !== 'number') throw new TypeError(`Expected ${key} to be a integer for 'color'.`);
        return byte(value);
    });
    let alpha = 255;
    if (input.a !== undefined) {
        const value = input.a;
        if (typeof value !== 'number') throw new TypeError("Expected a to be a number for 'color'.");
        alpha = byte(clamp(value, 1) * 255);
    }
    return [values[0], values[1], values[2], alpha];
}

function hasColorFields(input: object): boolean {
    return Reflect.has(input, 'r') || Reflect.has(input, 'g')
        || Reflect.has(input, 'b') || Reflect.has(input, 'a');
}

function parseStringLike(input: object): RGBA | null | undefined {
    const toString = Reflect.get(input, 'toString');
    // Keep ordinary records on the RGB-object path. Other StringLike objects
    // (including boxed strings and explicit custom methods) can provide CSS.
    if (typeof toString !== 'function' || toString === Object.prototype.toString) return undefined;
    const text = Reflect.apply(toString, input, []);
    return typeof text === 'string' ? parseString(text) : null;
}

function parse(input: unknown): RGBA | null {
    if (input === undefined) throw new TypeError("Expected input to be a string, number, or object for 'color'.");
    if (input === null) return null;
    if (typeof input === 'string') return parseString(input);
    if (typeof input === 'number') {
        const n = (input === Infinity ? 0xffffffff : input === -Infinity ? 0 : Math.trunc(input)) >>> 0;
        return [(n >>> 16) & 255, (n >>> 8) & 255, n & 255, n > 0xffffff ? (n >>> 24) & 255 : 255];
    }
    if (typeof input !== 'object') return null;
    if (Array.isArray(input) || isIndexedTypedArray(input)) return parseArrayInput(input);
    // ArrayBuffer.isView also covers DataView, which has no color channels;
    // keep it on the ordinary object validation path instead of stringifying
    // its cross-realm default `toString` result.
    if (arrayBufferIsView(input)) return parseObjectInput(input as unknown as Record<string, unknown>);
    if (!hasColorFields(input)) {
        const stringified = parseStringLike(input);
        if (stringified !== undefined) return stringified;
    }
    return parseObjectInput(input as Record<string, unknown>);
}
export function color(input: unknown, format?: unknown): unknown {
    if (format != null && typeof format !== 'string') throw new TypeError("Expected format to be a string for 'color'.");
    const f = format ?? 'css';
    if (!formats.includes(f as string)) throw new TypeError(`format must be one of ${formats.map(x => `'${x}'`).join(', ').replace(/, 'rgba'$/, " or 'rgba'")}`);
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
        case 'css': {
            const full = hex + (a === 255 ? '' : a.toString(16).padStart(2, '0'));
            const short = full.match(/^(.)\1(.)\2(.)\3(?:(.)\4)?$/);
            const result = '#' + (short ? short.slice(1).filter(Boolean).join('') : full);
            const canonical: Record<string, string> = { 'ff0000': 'red', '008000': 'green', '808080': 'gray', '000080': 'navy', '800080': 'purple', '008080': 'teal', '800000': 'maroon', '808000': 'olive', 'c0c0c0': 'silver', 'ffa500': 'orange' };
            return a === 255 && canonical[hex] && canonical[hex].length <= result.length ? canonical[hex] : result;
        }
        default: throw new Error(`Bun.color output format '${f}' is not implemented`);
    }
}
