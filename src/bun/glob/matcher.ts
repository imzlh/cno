const MAX_BRACE_EXPANSIONS = 16_384;

export interface CompiledGlobPattern {
    readonly source: string;
    readonly expanded: readonly string[];
    readonly negated: boolean;
    readonly requiresExplicitDot: boolean;
    match(value: string, dot: boolean): boolean;
}

interface Negation {
    pattern: string;
    negated: boolean;
}

interface SegmentMatcher {
    readonly regex: RegExp;
    readonly explicitDot: boolean;
}

interface MatchOptions {
    dot: boolean;
}

function invalidPattern(value: unknown): TypeError & { code: string } {
    return Object.assign(new TypeError('pattern must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
}

function invalidMatchValue(): TypeError & { code: string } {
    return Object.assign(new TypeError('str must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
}

function isEscaped(value: string, index: number): boolean {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) slashes++;
    return (slashes & 1) === 1;
}

function parseNegation(pattern: string): Negation {
    let count = 0;
    while (pattern[count] === '!' && pattern[count + 1] !== '(') count++;
    return {
        pattern: pattern.slice(count),
        negated: (count & 1) === 1,
    };
}

function findExpandableBrace(pattern: string): { start: number; end: number; choices: string[] } | null {
    const openings: number[] = [];
    for (let index = 0; index < pattern.length; index++) {
        if (isEscaped(pattern, index)) continue;
        if (pattern[index] === '{') {
            openings.push(index);
            continue;
        }
        if (pattern[index] === '}' && openings.length > 0) {
            const start = openings.pop()!;
            const choices = braceChoices(pattern.slice(start + 1, index));
            if (choices) return { start, end: index, choices };
        }
    }
    return null;
}

function splitTopLevel(value: string, separator: string): string[] {
    const result: string[] = [];
    let braceDepth = 0;
    let parenDepth = 0;
    let classDepth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (isEscaped(value, index)) continue;
        const character = value[index];
        if (character === '[') classDepth++;
        else if (character === ']' && classDepth > 0) classDepth--;
        else if (classDepth === 0 && character === '{') braceDepth++;
        else if (classDepth === 0 && character === '}' && braceDepth > 0) braceDepth--;
        else if (classDepth === 0 && character === '(') parenDepth++;
        else if (classDepth === 0 && character === ')' && parenDepth > 0) parenDepth--;
        else if (character === separator && braceDepth === 0 && parenDepth === 0 && classDepth === 0) {
            result.push(value.slice(start, index));
            start = index + 1;
        }
    }
    result.push(value.slice(start));
    return result;
}

function paddingWidth(value: string): number {
    const unsigned = value.replace(/^[+-]/, '');
    return unsigned.length > 1 && unsigned.startsWith('0') ? unsigned.length : 0;
}

function formatRangeNumber(value: number, width: number): string {
    if (width === 0) return String(value);
    const sign = value < 0 ? '-' : '';
    return `${sign}${String(Math.abs(value)).padStart(width, '0')}`;
}

function expandSequence(body: string): string[] | null {
    const pieces = body.split('..');
    if (pieces.length !== 2 && pieces.length !== 3) return null;
    const [first = '', last = '', rawStep] = pieces;

    if (/^[+-]?\d+$/.test(first) && /^[+-]?\d+$/.test(last)) {
        const start = Number(first);
        const end = Number(last);
        let step = rawStep === undefined ? (start <= end ? 1 : -1) : Number(rawStep);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(step) || step === 0) {
            return null;
        }
        if (start < end && step < 0) step = -step;
        if (start > end && step > 0) step = -step;
        const width = Math.max(paddingWidth(first), paddingWidth(last));
        const output: string[] = [];
        for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
            output.push(formatRangeNumber(value, width));
            if (output.length > MAX_BRACE_EXPANSIONS) throw new RangeError('Glob brace expansion is too large');
        }
        return output;
    }

    const firstPoints = Array.from(first);
    const lastPoints = Array.from(last);
    if (firstPoints.length !== 1 || lastPoints.length !== 1) return null;
    const start = firstPoints[0].codePointAt(0)!;
    const end = lastPoints[0].codePointAt(0)!;
    let step = rawStep === undefined ? (start <= end ? 1 : -1) : Number(rawStep);
    if (!Number.isSafeInteger(step) || step === 0) return null;
    if (start < end && step < 0) step = -step;
    if (start > end && step > 0) step = -step;
    const output: string[] = [];
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
        output.push(String.fromCodePoint(value));
        if (output.length > MAX_BRACE_EXPANSIONS) throw new RangeError('Glob brace expansion is too large');
    }
    return output;
}

function braceChoices(body: string): string[] | null {
    const alternatives = splitTopLevel(body, ',');
    if (alternatives.length > 1) return alternatives;
    return expandSequence(body);
}

export function expandBraces(pattern: string): string[] {
    const result: string[] = [];
    const visit = (value: string): void => {
        if (result.length > MAX_BRACE_EXPANSIONS) throw new RangeError('Glob brace expansion is too large');
        const brace = findExpandableBrace(value);
        if (!brace) {
            result.push(value);
            return;
        }
        for (const choice of brace.choices) {
            visit(value.slice(0, brace.start) + choice + value.slice(brace.end + 1));
        }
    };
    visit(pattern);
    return result;
}

function regexLiteral(character: string): string {
    return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character;
}

function classLiteral(character: string): string {
    return /[\\\]\[^-]/.test(character) ? `\\${character}` : character;
}

function findClosingParen(value: string, opening: number): number {
    let depth = 0;
    let classDepth = 0;
    for (let index = opening; index < value.length; index++) {
        if (isEscaped(value, index)) continue;
        const character = value[index];
        if (character === '[') classDepth++;
        else if (character === ']' && classDepth > 0) classDepth--;
        else if (classDepth === 0 && character === '(') depth++;
        else if (classDepth === 0 && character === ')' && --depth === 0) return index;
    }
    return -1;
}

function compileCharacterClass(segment: string, start: number): { source: string; end: number } | null {
    let end = start + 1;
    if (segment[end] === '!' || segment[end] === '^') end++;
    if (segment[end] === ']') end++;
    while (end < segment.length) {
        if (segment[end] === ']' && !isEscaped(segment, end)) break;
        end++;
    }
    if (end >= segment.length) return null;

    let body = segment.slice(start + 1, end);
    let negated = false;
    if (body.startsWith('!') || body.startsWith('^')) {
        negated = true;
        body = body.slice(1);
    }
    let source = '';
    for (let index = 0; index < body.length; index++) {
        const character = body[index];
        if (character === '\\' && index + 1 < body.length) {
            // A glob escape is a literal character, never a regex class escape such as \d or \s.
            source += classLiteral(body[++index]);
        } else if (character === ']' || (character === '^' && source.length === 0)) {
            source += `\\${character}`;
        } else {
            source += character;
        }
    }
    if (source.length === 0) return null;
    return { source: `[${negated ? '^' : ''}${source}]`, end };
}

function compileSequence(value: string): string {
    let source = '';
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (character === '\\') {
            if (index + 1 < value.length) source += regexLiteral(value[++index]);
            else source += '\\\\';
            continue;
        }

        if ('@+?!*'.includes(character) && value[index + 1] === '(') {
            const close = findClosingParen(value, index + 1);
            if (close !== -1) {
                const alternatives = splitTopLevel(value.slice(index + 2, close), '|')
                    .map(compileSequence)
                    .join('|');
                if (character === '@') source += `(?:${alternatives})`;
                else if (character === '+') source += `(?:${alternatives})+`;
                else if (character === '?') source += `(?:${alternatives})?`;
                else if (character === '*') source += `(?:${alternatives})*`;
                else {
                    const remainder = compileSequence(value.slice(close + 1));
                    source += `(?!(?:${alternatives})${remainder}$)[^/]*${remainder}`;
                    return source;
                }
                index = close;
                continue;
            }
        }

        if (character === '*') source += '[^/]*';
        else if (character === '?') source += '[^/]';
        else if (character === '[') {
            const characterClass = compileCharacterClass(value, index);
            if (characterClass) {
                source += characterClass.source;
                index = characterClass.end;
            } else {
                source += '\\[';
            }
        } else {
            source += regexLiteral(character);
        }
    }
    return source;
}

function classCanMatchDot(segment: string): boolean {
    const characterClass = compileCharacterClass(segment, 0);
    if (!characterClass) return false;
    try {
        return new RegExp(`^${characterClass.source}$`, 'u').test('.');
    } catch {
        return false;
    }
}

function firstTokenCanMatchDot(segment: string): boolean {
    if (segment.startsWith('.')) return true;
    if (segment.startsWith('\\.')) return true;
    if (segment.startsWith('[')) return classCanMatchDot(segment);
    if ('@+?!*'.includes(segment[0] ?? '') && segment[1] === '(') {
        const close = findClosingParen(segment, 1);
        if (close !== -1) {
            const alternatives = splitTopLevel(segment.slice(2, close), '|');
            if (alternatives.some(firstTokenCanMatchDot)) return true;
            if ((segment[0] === '?' || segment[0] === '*') && close + 1 < segment.length) {
                return firstTokenCanMatchDot(segment.slice(close + 1));
            }
        }
    }
    return false;
}

const segmentCache = new Map<string, SegmentMatcher>();

function compileSegment(segment: string): SegmentMatcher {
    const cached = segmentCache.get(segment);
    if (cached) return cached;
    let regex: RegExp;
    try {
        regex = new RegExp(`^${compileSequence(segment)}$`, 'u');
    } catch {
        regex = new RegExp(`^${Array.from(segment).map(regexLiteral).join('')}$`, 'u');
    }
    const compiled = { regex, explicitDot: firstTokenCanMatchDot(segment) };
    if (segmentCache.size > 2048) segmentCache.clear();
    segmentCache.set(segment, compiled);
    return compiled;
}

function normalizeSeparators(value: string): string {
    // Backslash is the glob escape character on every platform. Paths emitted
    // by the scanner are already normalized to forward slashes.
    return value;
}

function splitPath(value: string): string[] {
    return normalizeSeparators(value).split('/');
}

function matchSegments(
    values: readonly string[],
    patterns: readonly string[],
    valueIndex: number,
    patternIndex: number,
    options: MatchOptions,
    memo: Map<string, boolean>,
): boolean {
    const key = `${valueIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (patternIndex === patterns.length) {
        result = valueIndex === values.length;
    } else {
        const pattern = patterns[patternIndex];
        if (pattern === '**') {
            result = matchSegments(values, patterns, valueIndex, patternIndex + 1, options, memo);
            if (!result && valueIndex < values.length) {
                const value = values[valueIndex];
                result = (options.dot || !value.startsWith('.'))
                    && matchSegments(values, patterns, valueIndex + 1, patternIndex, options, memo);
            }
        } else if (valueIndex >= values.length) {
            result = false;
        } else {
            const value = values[valueIndex];
            const compiled = compileSegment(pattern);
            result = (options.dot || !value.startsWith('.') || compiled.explicitDot)
                && compiled.regex.test(value)
                && matchSegments(values, patterns, valueIndex + 1, patternIndex + 1, options, memo);
        }
    }
    memo.set(key, result);
    return result;
}

function matchExpanded(value: string, pattern: string, dot: boolean): boolean {
    if (value === '' && pattern.includes('/')) return false;
    if (pattern.endsWith('/**') && !value.endsWith('/')) {
        const prefix = pattern.slice(0, -3);
        if (value === prefix) return false;
    }
    return matchSegments(splitPath(value), splitPath(pattern), 0, 0, { dot }, new Map());
}

function patternHasExplicitDot(pattern: string): boolean {
    return splitPath(pattern).some(segment => segment !== '**' && firstTokenCanMatchDot(segment));
}

export function compileGlobPattern(value: unknown): CompiledGlobPattern {
    if (typeof value !== 'string') throw invalidPattern(value);
    const parsed = parseNegation(value);
    const expanded = expandBraces(parsed.pattern);
    const requiresExplicitDot = expanded.some(patternHasExplicitDot);
    return {
        source: value,
        expanded,
        negated: parsed.negated,
        requiresExplicitDot,
        match(candidate: string, dot: boolean): boolean {
            const matched = expanded.some(pattern => matchExpanded(candidate, pattern, dot));
            return parsed.negated ? !matched : matched;
        },
    };
}

export function assertGlobMatchValue(value: unknown): asserts value is string {
    if (typeof value !== 'string') throw invalidMatchValue();
}

export function hasGlobMagic(pattern: string): boolean {
    for (let index = 0; index < pattern.length; index++) {
        if (pattern[index] === '\\') {
            index++;
            continue;
        }
        if ('*?['.includes(pattern[index])) return true;
        if ('@+!'.includes(pattern[index]) && pattern[index + 1] === '(') return true;
    }
    return false;
}

export function unescapeGlobLiteral(pattern: string): string {
    let output = '';
    for (let index = 0; index < pattern.length; index++) {
        if (pattern[index] === '\\' && index + 1 < pattern.length) output += pattern[++index];
        else output += pattern[index];
    }
    return output;
}
