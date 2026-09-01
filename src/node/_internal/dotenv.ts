/** Node-compatible dotenv text parsing shared by node:util and node:process. */
export function parseNodeEnv(content: string): Record<string, string> {
    return nodeEnvEntriesToObject(parseNodeEnvEntries(content));
}

export function parseNodeEnvEntries(content: string): Map<string, string> {
    const variables = new Map<string, string>();
    let remaining = trimSpaces(content.replace(/\r/g, ''));

    while (remaining !== '') {
        if (remaining[0] === '\n' || remaining[0] === '#') {
            remaining = discardLine(remaining);
            continue;
        }

        const separator = findAssignmentSeparator(remaining);
        if (separator === -1 || remaining[separator] === '\n') {
            if (separator !== -1) {
                remaining = trimSpaces(remaining.slice(separator + 1));
                continue;
            }
            break;
        }

        let key = trimSpaces(remaining.slice(0, separator));
        remaining = remaining.slice(separator + 1);
        if (remaining === '' || remaining[0] === '\n') {
            variables.set(key, '');
            continue;
        }

        remaining = trimSpaces(remaining);
        if (key === '') continue;
        if (key.startsWith('export ')) key = trimSpaces(key.slice('export '.length));
        if (remaining === '') {
            variables.set(key, '');
            break;
        }

        const quote = remaining[0];
        if (quote === '"') {
            const closingQuote = remaining.indexOf(quote, 1);
            if (closingQuote !== -1) {
                variables.set(key, remaining.slice(1, closingQuote).replace(/\\n/g, '\n'));
                remaining = discardAfterQuote(remaining, closingQuote);
                continue;
            }
        }

        if (quote === "'" || quote === '"' || quote === '`') {
            const closingQuote = remaining.indexOf(quote, 1);
            if (closingQuote === -1) {
                const newline = remaining.indexOf('\n');
                if (newline === -1) {
                    variables.set(key, remaining);
                    break;
                }
                variables.set(key, remaining.slice(0, newline));
                remaining = remaining.slice(newline + 1);
            } else {
                variables.set(key, remaining.slice(1, closingQuote));
                remaining = discardAfterQuote(remaining, closingQuote);
                continue;
            }
        } else {
            const newline = remaining.indexOf('\n');
            const value = newline === -1 ? remaining : remaining.slice(0, newline);
            const comment = value.indexOf('#');
            variables.set(key, trimSpaces(comment === -1 ? value : value.slice(0, comment)));
            remaining = newline === -1 ? '' : remaining.slice(newline + 1);
        }

        remaining = trimSpaces(remaining);
    }

    return variables;
}

export function nodeEnvEntriesToObject(entries: Iterable<readonly [string, string]>): Record<string, string> {
    const variables: Record<string, string> = {};
    for (const [key, value] of entries) variables[key] = value;
    return variables;
}

function trimSpaces(value: string): string {
    let start = 0;
    while (start < value.length && isNodeWhitespace(value[start]!)) start++;

    let end = value.length;
    while (end > start && isNodeWhitespace(value[end - 1]!)) end--;
    return value.slice(start, end);
}

function isNodeWhitespace(value: string): boolean {
    return value === ' ' || value === '\t' || value === '\n';
}

function findAssignmentSeparator(value: string): number {
    const equals = value.indexOf('=');
    const newline = value.indexOf('\n');
    if (equals === -1) return newline;
    if (newline === -1) return equals;
    return Math.min(equals, newline);
}

function discardLine(value: string): string {
    const newline = value.indexOf('\n');
    return newline === -1 ? '' : value.slice(newline + 1);
}

function discardAfterQuote(value: string, closingQuote: number): string {
    const newline = value.indexOf('\n', closingQuote + 1);
    return newline === -1 ? '' : value.slice(newline + 1);
}
