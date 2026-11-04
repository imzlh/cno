/**
 * Bounded Bun.inspect formatter. Covers primitives, arrays, plain objects,
 * cycles, and the nodejs.util.inspect.custom hook. Other object kinds render
 * as `Name { ... }` and do not match Bun's output exactly.
 */

import { stringWidth } from './utils/text';

export const inspectCustom: symbol = Symbol.for('nodejs.util.inspect.custom');

export type InspectOptions = {
    depth?: import('bun').BunInspectOptions['depth'] | null;
};

interface State {
    seen: object[];
    refs: Map<object, number>;
    depth: number;
}

const DEFAULT_DEPTH = 2;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function inspect(value: unknown, options: InspectOptions = {}): string {
    if (options === null || typeof options !== 'object') {
        throw new TypeError("Expected options to be an object for 'inspect'.");
    }
    const depth = options.depth === undefined
        ? DEFAULT_DEPTH
        : options.depth === null ? Infinity : options.depth;
    if (typeof depth !== 'number' || Number.isNaN(depth)) {
        throw new TypeError("Expected depth to be a number or null for 'inspect'.");
    }
    return formatValue(value, 0, { seen: [], refs: new Map(), depth });
}

/** Format tabular data using Bun's console-table layout. */
export function inspectTable(value: unknown, columns?: unknown, _options?: unknown): string {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return '';
    const isMap = value instanceof Map;
    const isSet = value instanceof Set;
    const rows: Array<{ index: string; value: unknown; key?: unknown }> = [];
    if (isMap) {
        let index = 0;
        for (const [key, item] of value) rows.push({ index: String(index++), key, value: item });
    } else if (isSet || Array.isArray(value)) {
        let index = 0;
        for (const item of value) rows.push({ index: String(index++), value: item });
    } else {
        for (const key of Object.keys(value)) rows.push({ index: key, value: (value as Record<string, unknown>)[key] });
    }

    const selected = Array.isArray(columns);
    // Concatenation deliberately uses ToString (which rejects symbols), as Bun does.
    const names: string[] = selected ? Array.from(columns, column => '' + column) : [];
    let hasValues = false;
    if (!selected && !isMap) {
        for (const row of rows) {
            if (row.value !== null && typeof row.value === 'object') {
                for (const key of Object.keys(row.value)) if (!names.includes(key)) names.push(key);
            } else {
                hasValues = true;
            }
        }
    }
    if (isMap && rows.length) hasValues = true;

    const headers = ['', ...(isMap ? ['Key'] : []), ...names, ...(hasValues ? ['Values'] : [])];
    const cell = (item: unknown): string => {
        if (typeof item === 'string') return item;
        if (typeof item === 'function') return item.name ? `[Function: ${item.name}]` : '[Function]';
        return inspect(item);
    };
    const lines = rows.map(row => {
        const object = !isMap && row.value !== null && typeof row.value === 'object'
            ? row.value as Record<string, unknown> : undefined;
        return [row.index, ...(isMap ? [cell(row.key)] : []),
            ...names.map(name => object && Object.prototype.hasOwnProperty.call(object, name) ? cell(object[name]) : ''),
            ...(hasValues ? [isMap || !object && typeof row.value !== 'function' ? cell(row.value) : ''] : [])];
    });
    const widthOf = (text: string) => stringWidth(text, { perCodePoint: true });
    const widths = headers.map((header, i) => lines.reduce(
        (width, line) => Math.max(width, widthOf(line[i])), Math.max(1, widthOf(header))));
    const border = (left: string, middle: string, right: string) =>
        left + widths.map(width => '─'.repeat(width + 2)).join(middle) + right + '\n';
    const line = (cells: string[]) => '│' + cells.map((text, i) =>
        ' ' + text + ' '.repeat(widths[i] - widthOf(text) + 1)).join('│') + '│\n';
    return border('┌', '┬', '┐') + line(headers) + border('├', '┼', '┤') +
        lines.map(line).join('') + border('└', '┴', '┘');
}

function formatValue(value: unknown, level: number, state: State): string {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return formatPrimitive(value);
    }
    const object = value as object;

    const hook = Reflect.get(object, inspectCustom);
    if (typeof hook === 'function') {
        const reply = hook.call(object, state.depth - level, { depth: state.depth }, inspect);
        if (reply !== object) {
            return typeof reply === 'string' ? reply : formatValue(reply, level, state);
        }
    }

    if (state.seen.includes(object)) {
        if (!state.refs.has(object)) state.refs.set(object, state.refs.size + 1);
        return `[Circular *${state.refs.get(object)}]`;
    }
    if (typeof value === 'function') {
        const name = (value as { name?: unknown }).name;
        return typeof name === 'string' && name !== '' ? `[Function: ${name}]` : '[Function (anonymous)]';
    }
    if (level > state.depth) {
        return Array.isArray(object) ? '[Array]' : `[${constructorName(object) ?? 'Object'}]`;
    }

    state.seen.push(object);
    try {
        const body = Array.isArray(object)
            ? formatArray(object, level, state)
            : formatObject(object, level, state);
        const ref = state.refs.get(object);
        return ref === undefined ? body : `<ref *${ref}> ${body}`;
    } finally {
        state.seen.pop();
    }
}

function formatPrimitive(value: unknown): string {
    switch (typeof value) {
        case 'string': return quote(value);
        case 'bigint': return `${value}n`;
        case 'number': return Object.is(value, -0) ? '-0' : String(value);
        default: return String(value);
    }
}

function quote(text: string): string {
    const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\x08/g, '\\b')
        .replace(/\f/g, '\\f')
        .replace(/\v/g, '\\v');
    return `'${escaped}'`;
}

function formatKey(key: string | symbol): string {
    if (typeof key === 'symbol') return `[${String(key)}]`;
    return IDENTIFIER.test(key) ? key : quote(key);
}

function formatArray(array: unknown[], level: number, state: State): string {
    if (array.length === 0) return '[]';
    const items = array.map(item => formatValue(item, level + 1, state));
    return `[ ${items.join(', ')} ]`;
}

function formatObject(object: object, level: number, state: State): string {
    const prefix = constructorPrefix(object);
    const keys = Reflect.ownKeys(object).filter(key =>
        Object.getOwnPropertyDescriptor(object, key)?.enumerable === true);
    if (keys.length === 0) return `${prefix}{}`;
    const entries = keys.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        const shown = 'value' in descriptor
            ? formatValue(descriptor.value, level + 1, state)
            : descriptor.get && descriptor.set ? '[Getter/Setter]' : descriptor.get ? '[Getter]' : '[Setter]';
        return `${formatKey(key)}: ${shown}`;
    });
    return `${prefix}{ ${entries.join(', ')} }`;
}

function constructorName(object: object): string | undefined {
    const ctor = (Object.getPrototypeOf(object) as { constructor?: { name?: unknown } } | null)?.constructor;
    return typeof ctor?.name === 'string' && ctor.name !== '' ? ctor.name : undefined;
}

function constructorPrefix(object: object): string {
    const proto = Object.getPrototypeOf(object);
    if (proto === null) return '[Object: null prototype] ';
    if (proto === Object.prototype) return '';
    return `${constructorName(object) ?? 'Object'} `;
}
