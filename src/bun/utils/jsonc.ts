/** JSON with comments and trailing commas; deliberately not a JSON5 parser. */
export function parseJSONC(text: string): any {
    const source = `${text}`;
    const characters = source.split('');
    let inString = false;

    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (inString) {
            if (character === '\\') index++;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
            continue;
        }
        if (character !== '/') continue;
        const next = source[index + 1];
        if (next === '/') {
            characters[index++] = ' ';
            while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
                characters[index++] = ' ';
            }
            index--;
        } else if (next === '*') {
            const end = source.indexOf('*/', index + 2);
            if (end === -1) throw new SyntaxError('Unterminated JSONC comment');
            // Keep whitespace in place so comments cannot join separate tokens.
            for (; index <= end + 1; index++) {
                if (source[index] !== '\n' && source[index] !== '\r') characters[index] = ' ';
            }
            index--;
        }
    }

    inString = false;
    let previous = '';
    for (let index = 0; index < characters.length; index++) {
        const character = characters[index];
        if (inString) {
            if (character === '\\') index++;
            else if (character === '"') {
                inString = false;
                previous = '"';
            }
            continue;
        }
        if (character === '"') {
            inString = true;
            continue;
        }
        if (isJSONWhitespace(character)) continue;
        if (character === ',' && previous && !'{[,:'.includes(previous)) {
            let next = index + 1;
            while (next < characters.length && isJSONWhitespace(characters[next])) next++;
            if (characters[next] === '}' || characters[next] === ']') characters[index] = ' ';
        }
        // Track the original comma so multiple trailing commas remain invalid.
        previous = character;
    }
    return JSON.parse(characters.join(''));
}

function isJSONWhitespace(character: string): boolean {
    return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

export const JSONC = { parse: parseJSONC };
