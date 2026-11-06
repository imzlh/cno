export const escapeHTML = (input: string | object | number | boolean): string => {
    // Template substitution uses the string coercion hint and rejects Symbols.
    const value = `${input}`;
    let escaped = '';

    // Keep escaping independent of user-mutable String prototype methods.
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        switch (character) {
            case '&': escaped += '&amp;'; break;
            case '<': escaped += '&lt;'; break;
            case '>': escaped += '&gt;'; break;
            case '"': escaped += '&quot;'; break;
            case "'": escaped += '&#x27;'; break;
            default: escaped += character;
        }
    }

    return escaped;
};

// Bun exposes the native function with a historical second optional argument.
Object.defineProperty(escapeHTML, 'length', { value: 2, configurable: true });
