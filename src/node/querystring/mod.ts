/**
 * Node.js querystring module (stub)
 * URL query string parsing and stringifying
 */

export function parse(str: string, sep = '&', eq = '=', options?: { maxKeys?: number; decodeURIComponent?: (s: string) => string }): Record<string, string | string[]> {
    const decode = options?.decodeURIComponent ?? decodeURIComponent;
    const maxKeys = options?.maxKeys ?? 1000;
    const result: Record<string, string | string[]> = {};
    if (!str || str.length === 0) return result;

    let count = 0;
    for (const pair of str.split(sep)) {
        if (count >= maxKeys) break;
        const idx = pair.indexOf(eq);
        const key = idx >= 0 ? decode(pair.substring(0, idx)) : decode(pair);
        const val = idx >= 0 ? decode(pair.substring(idx + eq.length)) : '';
        const existing = result[key];
        if (existing !== undefined) {
            result[key] = Array.isArray(existing) ? [...existing, val] : [existing, val];
        } else {
            result[key] = val;
        }
        count++;
    }
    return result;
}

export function stringify(obj: Record<string, any>, sep = '&', eq = '=', options?: { encodeURIComponent?: (s: string) => string }): string {
    const encode = options?.encodeURIComponent ?? encodeURIComponent;
    const pairs: string[] = [];
    for (const [key, val] of Object.entries(obj)) {
        if (val === undefined || val === null) continue;
        if (Array.isArray(val)) {
            for (const v of val) {
                pairs.push(`${encode(key)}${eq}${encode(String(v))}`);
            }
        } else {
            pairs.push(`${encode(key)}${eq}${encode(String(val))}`);
        }
    }
    return pairs.join(sep);
}

export function escape(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function unescape(str: string): string {
    return decodeURIComponent(str.replace(/\+/g, ' '));
}
