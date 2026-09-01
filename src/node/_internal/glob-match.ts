function splitAlternatives(value: string): string[] {
    const alternatives: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (character === '{' || character === '(') depth++;
        else if (character === '}' || character === ')') depth--;
        else if ((character === ',' || character === '|') && depth === 0) {
            alternatives.push(value.slice(start, index));
            start = index + 1;
        }
    }
    alternatives.push(value.slice(start));
    return alternatives;
}

function expandBraces(pattern: string): string[] {
    let start = -1;
    let depth = 0;
    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];
        if (character === '{') {
            if (depth === 0) start = index;
            depth++;
        } else if (character === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                const alternatives = splitAlternatives(pattern.slice(start + 1, index));
                if (alternatives.length === 1) return [pattern];
                return alternatives.flatMap(alternative =>
                    expandBraces(pattern.slice(0, start) + alternative + pattern.slice(index + 1))
                );
            }
        }
    }
    return [pattern];
}

function findClosingParen(pattern: string, start: number): number {
    let depth = 0;
    for (let index = start; index < pattern.length; index++) {
        if (pattern[index] === '(') depth++;
        else if (pattern[index] === ')' && --depth === 0) return index;
    }
    return -1;
}

function segmentSource(pattern: string): string {
    let source = '';
    for (let index = 0; index < pattern.length;) {
        const character = pattern[index] ?? '';
        if ('@+?!*'.includes(character) && pattern[index + 1] === '(') {
            const close = findClosingParen(pattern, index + 1);
            if (close !== -1) {
                const alternatives = splitAlternatives(pattern.slice(index + 2, close))
                    .map(segmentSource).join('|');
                if (character === '@') source += `(?:${alternatives})`;
                else if (character === '+') source += `(?:${alternatives})+`;
                else if (character === '?') source += `(?:${alternatives})?`;
                else if (character === '*') source += `(?:${alternatives})*`;
                else source += `(?!(?:${alternatives})$).*`;
                index = close + 1;
                continue;
            }
        }
        if (character === '*') source += '.*';
        else if (character === '?') source += '.';
        else if (character === '[') {
            const close = pattern.indexOf(']', index + 1);
            if (close !== -1) {
                let body = pattern.slice(index + 1, close);
                if (body.startsWith('!')) body = `^${body.slice(1)}`;
                source += `[${body.replace(/\\/g, '\\\\')}]`;
                index = close + 1;
                continue;
            }
            source += '\\[';
        } else source += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
        index++;
    }
    return source;
}

function matchSegment(value: string, pattern: string): boolean {
    if (value.startsWith('.') && !pattern.startsWith('.') && !pattern.startsWith('[.]')) return false;
    return new RegExp(`^${segmentSource(pattern)}$`).test(value);
}

function matchSegments(values: string[], patterns: string[], valueIndex = 0, patternIndex = 0): boolean {
    if (patternIndex === patterns.length) return valueIndex === values.length;
    const pattern = patterns[patternIndex] ?? '';
    if (pattern !== '**') {
        return valueIndex < values.length && matchSegment(values[valueIndex] ?? '', pattern) &&
            matchSegments(values, patterns, valueIndex + 1, patternIndex + 1);
    }
    if (matchSegments(values, patterns, valueIndex, patternIndex + 1)) return true;
    return valueIndex < values.length && !(values[valueIndex] ?? '').startsWith('.') &&
        matchSegments(values, patterns, valueIndex + 1, patternIndex);
}

function normalize(value: string, windows: boolean): string {
    return windows ? value.replace(/\\/g, '/') : value;
}

export function matchGlobPattern(path: string, pattern: string, windows: boolean): boolean {
    const values = normalize(path, windows).split('/');
    return expandBraces(normalize(pattern, windows)).some(expanded =>
        matchSegments(values, expanded.split('/'))
    );
}
