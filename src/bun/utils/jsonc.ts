/** JSON with comments and trailing commas; deliberately not a JSON5 parser. */
const parseJSON = JSON.parse;

const parse = (input: unknown): any => {
    if (input == null) throw new TypeError('input must be a string');

    // Bun applies ordinary ToString conversion here. This intentionally does not
    // decode ArrayBuffer views; Buffer works because it supplies its own toString.
    const source = `${input}`;
    const characters = source.split('');
    if (characters[0] === '\ufeff') characters[0] = ' ';
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
            while (index < source.length && !isLineTerminator(source[index])) {
                characters[index++] = ' ';
            }
            // JSON whitespace excludes the other ECMAScript line terminators.
            if (source[index] === '\u2028' || source[index] === '\u2029') characters[index] = ' ';
            index--;
        } else if (next === '*') {
            const end = source.indexOf('*/', index + 2);
            if (end === -1) throw syntaxError('Expected "*/" to terminate multi-line comment');
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
    try {
        return parseJSON(characters.join(''));
    } catch (error) {
        if (error instanceof SyntaxError) throw syntaxError(error.message);
        throw error;
    }
};

export { parse as parseJSONC };

function isJSONWhitespace(character: string): boolean {
    return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

function isLineTerminator(character: string): boolean {
    return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}

function syntaxError(message: string): SyntaxError {
    return new SyntaxError(`JSONC Parse error: ${message}`);
}

export const JSONC = { parse };
