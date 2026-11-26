type Ordering = -1 | 0 | 1;
interface Version { parts: [bigint, bigint, bigint]; pre: string[] }
interface PartialVersion { parts: bigint[]; pre: string[] }
interface Comparator { op: '>' | '>=' | '<' | '<=' | '='; version: Version }

const identifier = '[0-9A-Za-z-]+';
const looseIdentifier = '[0-9A-Za-z-]*';
const looseIdentifiers = `${looseIdentifier}(?:\\.${looseIdentifier})*`;
const versionPattern = new RegExp(`^[v=]*(\\d+|[xX*])(?:\\.(\\d+|[xX*]))?(?:\\.(\\d+|[xX*]))?(?:-(${looseIdentifiers})|(${identifier}(?:\\.${looseIdentifier})*))?(?:\\+(${looseIdentifiers}))?$`);
const maxComponent = 18_446_744_073_709_551_615n;
const maxComponentText = String(maxComponent);

function parse(input: string, partial: boolean, range = false): PartialVersion | null {
    let text = input.trim();
    // Bun's range parser stops at extra numeric components instead of rejecting them.
    if (range) text = text.replace(/^(\s*[v=]*(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){2})\.\d+.*$/, '$1');
    const m = versionPattern.exec(text);
    if (!m) return null;
    const parts: bigint[] = [];
    let wildcard = false;
    for (const part of m.slice(1, 4)) {
        if (part === undefined || /^[xX*]$/.test(part)) wildcard = true;
        else {
            const value = BigInt(part);
            if (!range && value > maxComponent) return null;
            if (!wildcard) parts.push(value);
        }
    }
    const preText = m[4] ?? m[5];
    const pre = preText ? preText.split('.') : [];
    if (!partial && parts.length !== 3) return null;
    if (range && parts.length !== 3) pre.length = 0;
    return { parts, pre };
}

function full(p: PartialVersion): Version {
    return { parts: [p.parts[0] ?? 0n, p.parts[1] ?? 0n, p.parts[2] ?? 0n], pre: p.pre };
}
function compareNumericIdentifier(a: string, b: string): Ordering {
    a = a.replace(/^0+(?=\d)/, '');
    b = b.replace(/^0+(?=\d)/, '');
    const aOverflow = a.length > maxComponentText.length
        || (a.length === maxComponentText.length && a > maxComponentText);
    const bOverflow = b.length > maxComponentText.length
        || (b.length === maxComponentText.length && b > maxComponentText);
    if (aOverflow !== bOverflow) return aOverflow ? 1 : -1;
    // Bun compares identifiers that overflow its native numeric representation
    // as strings, rather than as arbitrary-precision decimal integers.
    if (aOverflow) return a === b ? 0 : a < b ? -1 : 1;
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a === b ? 0 : a < b ? -1 : 1;
}
function compare(a: Version, b: Version): Ordering {
    for (let i = 0; i < 3; i++) {
        if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
    }
    if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const x = a.pre[i], y = b.pre[i];
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        if (x === y) continue;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) {
            const result = compareNumericIdentifier(x, y);
            if (result !== 0) return result;
            continue;
        }
        if (xn !== yn) return xn ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}
function upper(p: PartialVersion, index: number): Version {
    const v = full(p);
    v.parts[index]++;
    for (let i = index + 1; i < 3; i++) v.parts[i] = 0n;
    v.pre = ['0'];
    return v;
}
function expand(op: string, p: PartialVersion): Comparator[] {
    const n = p.parts.length;
    const v = full(p);
    if (op === '^' || op === '~' || op === '~>') {
        if (!n) return [];
        const index = op === '^' ? (p.parts[0] !== 0n ? 0 : n === 1 ? 0 : p.parts[1] !== 0n ? 1 : n === 2 ? 1 : 2) : (n === 1 ? 0 : 1);
        return [{ op: '>=', version: v }, { op: '<', version: upper(p, index) }];
    }
    if (n === 3) return [{ op: (op || '=') as Comparator['op'], version: v }];
    if (!n) {
        // Strict comparisons with an unbounded wildcard are empty.
        return op === '>' || op === '<' ? [{ op: '<', version: { parts: [0n, 0n, 0n], pre: ['0'] } }] : [];
    }
    if (op === '>') return [{ op: '>=', version: { ...upper(p, n - 1), pre: [] } }];
    if (op === '<=') return [{ op: '<', version: upper(p, n - 1) }];
    if (op === '<') return [{ op: '<', version: { ...v, pre: ['0'] } }];
    if (op === '>=') return [{ op: '>=', version: v }];
    return [{ op: '>=', version: v }, { op: '<', version: upper(p, n - 1) }];
}
function parseRange(range: string): { comparators: Comparator[]; explicit: boolean; impossible: boolean } {
    const comparators: Comparator[] = [];
    let explicit = false;
    let impossible = false;
    // Hyphen ranges have inclusive lower and upper endpoints, including partials.
    range = range.replace(/([^\s]+)\s+-\s+([^\s]+)/g, (_, lo: string, hi: string) => {
        const a = parse(lo, true, true), b = parse(hi, true, true);
        if (!a || !b) return `${lo} - ${hi}`;
        explicit = true;
        if (a.parts.some(part => part > maxComponent) || b.parts.some(part => part > maxComponent)) {
            impossible = true;
            return '';
        }
        if (a.parts.length) comparators.push(...expand('>=', a));
        if (b.parts.length) comparators.push(...expand('<=', b));
        return '';
    });
    range = range.replace(/(\^|~>|~|>=|<=|>|<|=)\s+/g, '$1');
    // Bun accepts the common compact npm form `>=1,<2`.
    range = range.replace(/(\S),(?=[<>=~^v\d*xX])/g, '$1 ');
    for (const token of range.trim().split(/\s+/)) {
        if (!token) continue;
        const m = /^(\^|~>|~|>=|<=|>|<|=)?(.*)$/.exec(token)!;
        const p = parse(m[2].replace(/,$/, ''), true, true);
        if (!p) {
            if (!m[2] && (m[1] === '>' || m[1] === '<' || m[1] === '=' || m[1] === '>=' || m[1] === '<=')) {
                comparators.push({ op: m[1], version: full({ parts: [], pre: [] }) });
                explicit = true;
            }
            continue;
        }
        explicit = true;
        if (p.parts.some(part => part > maxComponent)) {
            impossible = true;
            continue;
        }
        comparators.push(...expand(m[1] || '', p));
    }
    return { comparators, explicit, impossible };
}

export const order = (v1: unknown, v2: unknown): Ordering => {
    // Template coercion matches Bun's TypeError for symbols while retaining
    // ordinary StringLike object support.
    const raw1 = `${v1}`, raw2 = `${v2}`;
    const s1 = raw1.trim(), s2 = raw2.trim();
    const a = parse(s1, true), b = parse(s2, true);
    if (!a) throw new Error(`Invalid SemVer: ${raw1}\n`);
    if (!b) throw new Error(`Invalid SemVer: ${raw2}\n`);
    const ma = versionPattern.exec(s1)!, mb = versionPattern.exec(s2)!;
    for (let i = 0; i < 3; i++) {
        const x = ma[i + 1] && /^\d+$/.test(ma[i + 1]) ? BigInt(ma[i + 1]) : undefined;
        const y = mb[i + 1] && /^\d+$/.test(mb[i + 1]) ? BigInt(mb[i + 1]) : undefined;
        if (x === undefined || y === undefined) {
            if (x !== y) return x === undefined ? 1 : -1;
            continue;
        }
        if (x !== y) return x < y ? -1 : 1;
    }
    return compare(full(a), full(b));
};
export const satisfies = (version: unknown, range: unknown): boolean => {
    const parsed = parse(`${version}`, false);
    const text = `${range}`;
    if (!parsed) return false;
    const v = full(parsed);
    const alternatives = text.split('||');
    const sets = alternatives.map(parseRange);
    const hasNonempty = sets.some(set => set.explicit);
    if (sets.some(set => set.impossible)) return false;
    return sets.some(set => {
        // Unrecognized text is ignored by Bun's range parser. An invalid-only
        // branch is wildcard-like unless another OR branch contains a range.
        if (!set.explicit && hasNonempty) return false;
        if (v.pre.length && !set.comparators.some(c => c.version.pre.length && c.version.parts.every((n, i) => n === v.parts[i]))) return false;
        return set.comparators.every(c => {
            const result = compare(v, c.version);
            switch (c.op) {
                case '=': return result === 0 && (text.trim().includes(' ') || alternatives.length > 1 || v.pre.join('.') === c.version.pre.join('.'));
                case '>': return result > 0;
                case '>=': return result >= 0;
                case '<': return result < 0;
                case '<=': return result <= 0;
            }
        });
    });
};
export const bunSemver = { satisfies, order };
export default bunSemver;
