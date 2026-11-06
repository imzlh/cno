const replacements: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
};

export function escapeHTML(input: string | object | number | boolean): string {
    // Template substitution uses the string coercion hint and rejects Symbols.
    return `${input}`.replace(/[&<>"']/g, character => replacements[character]);
}

// Bun exposes the native function with a historical second optional argument.
Object.defineProperty(escapeHTML, 'length', { value: 2, configurable: true });
