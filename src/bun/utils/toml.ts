const engine = import.meta.use('engine');

const TOML_TEMPORAL = Symbol('cno.bun.toml.temporal');

class TomlTemporalValue {
    readonly [TOML_TEMPORAL] = true;
    constructor(private readonly value: string) {}
    toString(): string { return this.value; }
}

function validDate(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1) return false;
    const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= days[month - 1];
}

function parseTomlTemporal(value: string): TomlTemporalValue {
    const normalized = value.replace(/[t ]/, 'T').replace(/z$/, 'Z');
    const match = normalized.match(/^(?:(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d)(\.\d{1,9})?(Z|[+-]\d\d:\d\d)?)?|(\d\d):(\d\d):(\d\d)(\.\d{1,9})?)$/);
    if (!match) throw new RangeError('Invalid date or time');
    if (match[9] !== undefined) {
        const hour = Number(match[9]), minute = Number(match[10]), second = Number(match[11]);
        if (hour > 23 || minute > 59 || second > 59) throw new RangeError('Invalid time');
        return new TomlTemporalValue(`${match[9]}:${match[10]}:${match[11]}${match[12] ?? ''}`);
    }
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    if (!validDate(year, month, day)) throw new RangeError('Invalid date');
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (match[4] === undefined) return new TomlTemporalValue(date);
    const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) throw new RangeError('Invalid time');
    const local = `${date}T${match[4]}:${match[5]}:${match[6]}${match[7] ?? ''}`;
    if (!match[8]) return new TomlTemporalValue(local);
    const epoch = Date.parse(local + match[8]);
    if (!Number.isFinite(epoch)) throw new RangeError('Invalid instant');
    return new TomlTemporalValue(new Date(epoch).toISOString().replace('.000Z', 'Z'));
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const put = (o: Record<string, any>, k: string, v: any) => Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true });
const fail = (message: string): never => { throw new SyntaxError(`TOML Parse error: ${message}`); };

class Parser {
    i = 0;
    root: Record<string, any> = {};
    table = this.root;
    explicit = new WeakSet<object>();
    dotted = new WeakSet<object>();
    headers = new WeakSet<object>();
    sealed = new WeakSet<object>();
    arrays = new WeakSet<object>();
    constructor(readonly s: string) {}
    peek() { return this.s[this.i] ?? ''; }
    space() { while (this.peek() === ' ' || this.peek() === '\t') this.i++; }
    comment() { if (this.peek() === '#') while (this.peek() && this.peek() !== '\n' && this.peek() !== '\r') { const c = this.s.charCodeAt(this.i++); if (c < 32 && c !== 9 || c === 127) fail('Control character is not allowed in a comment'); } }
    ws() { for (;;) { this.space(); this.comment(); if (this.peek() === '\n') this.i++; else if (this.s.slice(this.i, this.i + 2) === '\r\n') this.i += 2; else break; } }
    expect(c: string) { if (this.peek() !== c) fail(`Expected '${c}'`); this.i++; }
    string(): string {
        const quote = this.peek(); this.i++;
        const multi = this.s.slice(this.i, this.i + 2) === quote + quote;
        if (multi) { this.i += 2; if (this.s.slice(this.i, this.i + 2) === '\r\n') this.i += 2; else if (this.peek() === '\n') this.i++; }
        let out = '';
        while (this.i < this.s.length) {
            if (this.peek() === quote) {
                if (!multi) { this.i++; return out; }
                let n = 0; while (this.s[this.i + n] === quote) n++;
                if (n >= 3) { if (n > 5) fail('Invalid string'); this.i += n; return out + quote.repeat(n - 3); }
                out += quote.repeat(n); this.i += n; continue;
            }
            let c = this.s[this.i++];
            if (c === '\r' && this.peek() === '\n') { this.i++; c = '\n'; }
            if (c === '\n' && !multi || c.charCodeAt(0) < 32 && c !== '\t' && c !== '\n' || c === '\x7f') fail('Invalid character in string');
            if (c !== '\\' || quote === "'") { out += c; continue; }
            if (multi && /^[ \t]*(?:\r?\n)/.test(this.s.slice(this.i))) { this.i += this.s.slice(this.i).match(/^[ \t]*(?:\r?\n)[ \t\r\n]*/ )![0].length; continue; }
            const e = this.s[this.i++]; const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
            if (own(escapes, e)) out += escapes[e];
            else if (e === 'u' || e === 'U') { const n = e === 'u' ? 4 : 8, hex = this.s.slice(this.i, this.i + n); if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) fail('Invalid unicode escape'); const cp = parseInt(hex, 16); if (cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) fail('Invalid unicode escape'); out += String.fromCodePoint(cp); this.i += n; }
            else fail('Invalid escape sequence');
        }
        return fail('Unterminated string');
    }
    key(): string[] {
        const keys: string[] = [];
        for (;;) { this.space(); const c = this.peek(); let k: string; if (c === '"' || c === "'") { if (this.s.slice(this.i, this.i + 3) === c.repeat(3)) fail('Invalid key'); k = this.string(); } else { const m = this.s.slice(this.i).match(/^[A-Za-z0-9_-]+/); if (!m) return fail('Expected a key'); k = m[0]; this.i += k.length; } keys.push(k); this.space(); if (this.peek() !== '.') break; this.i++; }
        return keys;
    }
    descend(obj: Record<string, any>, k: string): Record<string, any> {
        if (!own(obj, k)) put(obj, k, {});
        let v = obj[k]; if (Array.isArray(v) && this.arrays.has(v)) v = v[v.length - 1];
        if (!v || typeof v !== 'object' || Array.isArray(v) || this.sealed.has(v) || v instanceof Date || Object.getPrototypeOf(v) !== Object.prototype) fail(`Cannot redefine key '${k}'`);
        return v;
    }
    assign(obj: Record<string, any>, path: string[], value: any) { for (const k of path.slice(0, -1)) { obj = this.descend(obj, k); if (this.headers.has(obj)) fail(`Cannot extend table '${k}' with a dotted key`); this.dotted.add(obj); } const k = path[path.length - 1]; if (own(obj, k)) fail(`Cannot redefine key '${k}'`); put(obj, k, value); }
    value(): any {
        this.space(); const c = this.peek();
        if (c === '"' || c === "'") return this.string();
        if (c === '[') { this.i++; const a: any[] = []; this.ws(); while (this.peek() !== ']') { if (!this.peek()) fail('Unterminated array'); a.push(this.value()); this.ws(); if (this.peek() !== ',') break; this.i++; this.ws(); } this.expect(']'); return a; }
        if (c === '{') { this.i++; const o = {}; this.ws(); while (this.peek() !== '}') { const k = this.key(); this.expect('='); this.assign(o, k, this.value()); this.ws(); if (this.peek() !== ',') break; this.i++; this.ws(); } this.expect('}'); const seal = (x: any) => { if (x && typeof x === 'object' && !Array.isArray(x)) { this.sealed.add(x); Object.values(x).forEach(seal); } }; seal(o); return o; }
        const rest = this.s.slice(this.i); const date = rest.match(/^\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)?)?|^\d\d:\d\d:\d\d(?:\.\d+)?/);
        if (date) { const token = date[0]; this.i += token.length; const normalized = token.replace(/(\.\d{9})\d+/, '$1'); try { return parseTomlTemporal(normalized); } catch { return fail('Invalid date or time'); } }
        const m = rest.match(/^[^\s,#\]}]+/); if (!m) return fail('Expected a value'); const token = m[0]; this.i += token.length;
        if (token === 'true') return true; if (token === 'false') return false;
        if (/^[+-]?(inf|nan)$/.test(token)) return token.endsWith('nan') ? NaN : token[0] === '-' ? -Infinity : Infinity;
        const dec = '[0-9](?:_?[0-9])*';
        if (new RegExp(`^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\\.${dec})?(?:[eE][+-]?${dec})?$`).test(token)) { const n = Number(token.replace(/_/g, '')); if (!/[.eE]/.test(token) && !Number.isSafeInteger(n)) fail('Integer cannot be losslessly represented as a JavaScript number; it must be within +/-(2^53 - 1)'); return n; }
        if (/^0(?:x[0-9a-fA-F](?:_?[0-9a-fA-F])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/.test(token)) { const n = Number(token.replace(/_/g, '')); if (!Number.isSafeInteger(n)) fail('Integer cannot be losslessly represented as a JavaScript number; it must be within +/-(2^53 - 1)'); return n; }
        return fail('Invalid value');
    }
    parse() {
        if (this.s.charCodeAt(0) === 0xfeff) this.i++;
        while (true) { this.ws(); if (!this.peek()) return this.root;
            if (this.peek() === '[') { this.i++; const array = this.peek() === '['; if (array) this.i++; const path = this.key(); this.expect(']'); if (array) this.expect(']'); let obj = this.root; for (const k of path.slice(0, -1)) { obj = this.descend(obj, k); if (!this.dotted.has(obj)) this.headers.add(obj); } const k = path[path.length - 1];
                if (array) { if (!own(obj, k)) { const a: any[] = []; this.arrays.add(a); put(obj, k, a); } const a = obj[k]; if (!Array.isArray(a) || !this.arrays.has(a)) fail(`Cannot redefine key '${k}'`); this.table = {}; a.push(this.table); this.explicit.add(this.table); }
                else { this.table = this.descend(obj, k); if (this.explicit.has(this.table) || this.dotted.has(this.table)) fail(`Cannot redefine key '${k}'`); this.explicit.add(this.table); this.headers.add(this.table); }
            } else { const key = this.key(); this.expect('='); this.assign(this.table, key, this.value()); }
            this.space(); this.comment(); if (this.peek() && this.peek() !== '\n' && this.s.slice(this.i, this.i + 2) !== '\r\n') fail('Expected end of line');
        }
    }
}

export function parseTOML(input: unknown): Record<string, any> {
    if (input == null || typeof input === 'symbol') throw new TypeError('input must be a string, ArrayBuffer, ArrayBufferView or Blob');
    let s: string;
    if (input instanceof ArrayBuffer) s = engine.decodeString(input);
    else if (ArrayBuffer.isView(input)) s = engine.decodeString(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    else s = String(input);
    return new Parser(s).parse();
}

const quoteText = (text: string) => JSON.stringify(text).replace(/\x7f/g, '\\u007f');
const keyText = (key: string) => /^[A-Za-z0-9_-]+$/.test(key) ? key : quoteText(key);
const temporalValue = (value: any): string | undefined => {
    if (value instanceof Date) return value.toISOString().replace(/\.000Z$/, 'Z');
    if (value instanceof TomlTemporalValue) return value.toString();
    return undefined;
};
const tableValue = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v) && temporalValue(v) === undefined;

export function stringifyTOML(input?: unknown): string | undefined {
    if (input === undefined) return undefined;
    if (!input || typeof input !== 'object' || Array.isArray(input) || input instanceof Date || input instanceof String || input instanceof Number || input instanceof Boolean) throw new Error('TOML.stringify expects an object at the top level (a TOML document is a table)');
    const ancestors = new Set<object>();
    const enter = (o: object) => { if (ancestors.has(o)) throw new Error('TOML.stringify cannot serialize circular references'); ancestors.add(o); };
    const scalar = (v: any, context: string): string => {
        if (v === null) throw new Error(context === 'array' ? 'TOML cannot represent null in an array' : `TOML cannot represent null (key '${context}'); remove the key or use a sentinel value`);
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') throw new Error(`TOML cannot represent ${typeof v} in an array`);
        if (typeof v === 'string') return quoteText(v).replace(/\\u0008/g, '\\b').replace(/\\u000c/g, '\\f');
        if (typeof v === 'boolean') return String(v);
        if (typeof v === 'bigint') throw new Error('TOML.stringify cannot serialize BigInt');
        if (typeof v === 'number') { if (Number.isNaN(v)) return 'nan'; if (!Number.isFinite(v)) return v < 0 ? '-inf' : 'inf'; if (Object.is(v, -0)) return '-0.0'; return String(v) + (Number.isInteger(v) && !Number.isSafeInteger(v) && !/[eE]/.test(String(v)) ? '.0' : ''); }
        const t = temporalValue(v); if (t !== undefined) return t;
        enter(v);
        let result: string;
        if (Array.isArray(v)) result = `[${Array.from(v, x => scalar(x, 'array')).join(', ')}]`;
        else result = `{ ${Object.keys(v).filter(k => !['undefined', 'function', 'symbol'].includes(typeof v[k])).map(k => `${keyText(k)} = ${scalar(v[k], k)}`).join(', ')} }`;
        ancestors.delete(v); return result;
    };
    const sections: string[] = [];
    const walk = (obj: any, path: string[], header: string | null) => {
        enter(obj);
        const values: string[] = [], children: Array<[string, any, boolean]> = [];
        for (const k of Object.keys(obj)) {
            const v = obj[k]; if (['undefined', 'function', 'symbol'].includes(typeof v)) continue;
            if (tableValue(v)) children.push([k, v, false]);
            else if (Array.isArray(v) && v.length > 0 && v.every(tableValue)) children.push([k, v, true]);
            else values.push(`${keyText(k)} = ${scalar(v, k)}`);
        }
        if (header !== null && (values.length > 0 || children.length === 0 || header.startsWith('[['))) sections.push([header, ...values].join('\n'));
        else if (values.length) sections.push(values.join('\n'));
        for (const [k, v, array] of children) { const next = [...path, keyText(k)]; if (array) { enter(v); for (const item of v) walk(item, next, `[[${next.join('.')}]]`); ancestors.delete(v); } else walk(v, next, `[${next.join('.')}]`); }
        ancestors.delete(obj);
    };
    walk(input, [], null);
    return sections.length ? sections.join('\n\n') + '\n' : '';
}

export const TOML = { parse: parseTOML, stringify: stringifyTOML };
