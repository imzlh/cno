/**
 * Bounded Bun.inspect formatter. Covers common primitives, collections,
 * arrays, plain objects, cycles, and the nodejs.util.inspect.custom hook.
 * Layout and less common object kinds do not match Bun's output exactly.
 */

import { stringWidth } from './utils/text';

export const inspectCustom: symbol = Symbol.for('nodejs.util.inspect.custom');

export type InspectOptions = {
    depth?: import('bun').BunInspectOptions['depth'] | null;
};

interface State {
    seen: object[];
    depth: number;
}

const DEFAULT_DEPTH = 8;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function inspect(value: unknown, options: InspectOptions | number = {}): string {
    let depth = DEFAULT_DEPTH;
    const requestedDepth = typeof options === 'number'
        ? options
        : options !== null && typeof options === 'object' && typeof options.depth === 'number'
            ? options.depth : undefined;
    if (requestedDepth !== undefined) {
        if (Number.isNaN(requestedDepth) || Number.isFinite(requestedDepth) && !Number.isInteger(requestedDepth)) {
            throw invalidDepth(`expected depth to be an integer, got ${requestedDepth}`);
        }
        if (Number.isFinite(requestedDepth) && requestedDepth < 0) {
            throw invalidDepth(`expected depth to be greater than or equal to 0, got ${requestedDepth}`);
        }
        depth = Math.abs(requestedDepth);
    }
    return formatValue(value, 0, { seen: [], depth });
}

/** Format tabular data using Bun's console-table layout. */
export function inspectTable(value: unknown, columns?: unknown, _options?: unknown): string {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return '';
    const isMap = value instanceof Map;
    const isSet = value instanceof Set;
    const rows: Array<{ index: string; value: unknown; key?: unknown }> = [];
    const rowKeys = new Map<object, string[]>();
    const keysOf = (object: object): string[] => {
        let keys = rowKeys.get(object);
        if (keys === undefined) {
            keys = Object.keys(object);
            rowKeys.set(object, keys);
        }
        return keys;
    };
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
                for (const key of keysOf(row.value)) if (!names.includes(key)) names.push(key);
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
            ...names.map(name => object && (selected
                ? Object.prototype.hasOwnProperty.call(object, name)
                : keysOf(object).includes(name))
                ? cell(object[name]) : ''),
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

    if (typeof value === 'function') {
        const name = (value as { name?: unknown }).name;
        return typeof name === 'string' && name !== '' ? `[Function: ${name}]` : '[Function (anonymous)]';
    }
    const hook = Reflect.get(object, inspectCustom);
    if (typeof hook === 'function') {
        const reply = hook.call(object, state.depth - level, {
            stylize: (text: string) => text,
            depth: state.depth,
            colors: false,
        }, inspect);
        if (reply !== object) {
            return typeof reply === 'string' ? reply : formatValue(reply, level, state);
        }
    }

    if (level > state.depth) {
        return `[${Array.isArray(object) ? 'Array' : constructorName(object) ?? 'Object'} ...]`;
    }

    if (state.seen.includes(object)) {
        return '[Circular]';
    }

    state.seen.push(object);
    try {
        return formatObjectKind(object, level, state);
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
        .replace(/"/g, '\\"')
        .replace(/\0/g, '\\u0000')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\x08/g, '\\b')
        .replace(/\f/g, '\\f')
        .replace(/\v/g, '\\u000B')
        .replace(/[\x01-\x07\x0e-\x1f]/g, character =>
            `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    return `"${escaped}"`;
}

function formatKey(key: string | symbol): string {
    if (typeof key === 'symbol') return `[${String(key)}]`;
    return IDENTIFIER.test(key) ? key : quote(key);
}

function formatArray(array: unknown[], level: number, state: State): string {
    const items: string[] = [];
    for (let index = 0; index < array.length;) {
        if (Object.prototype.hasOwnProperty.call(array, index)) {
            items.push(formatValue(array[index++], level + 1, state));
            continue;
        }
        const start = index;
        while (index < array.length && !Object.prototype.hasOwnProperty.call(array, index)) index++;
        const count = index - start;
        items.push(count === 1 ? 'empty item' : `${count} x empty items`);
    }
    for (const key of Object.keys(array)) {
        if (!isArrayIndex(key, array.length)) {
            items.push(`${formatKey(key)}: ${formatValue((array as unknown as Record<string, unknown>)[key], level + 1, state)}`);
        }
    }
    if (items.length === 0) return '[]';
    return `[ ${items.join(', ')} ]`;
}

function formatObjectKind(object: object, level: number, state: State): string {
    if (Array.isArray(object)) return formatArray(object, level, state);
    const tag = Object.prototype.toString.call(object);
    if (tag === '[object Date]') {
        try {
            const time = Date.prototype.getTime.call(object);
            return Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString();
        } catch {}
    }
    if (tag === '[object RegExp]') {
        try {
            Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!.call(object);
            return RegExp.prototype.toString.call(object);
        } catch {}
    }
    if (tag === '[object Map]') {
        try {
            return formatMap(object as Map<unknown, unknown>, level, state);
        } catch {}
    }
    if (tag === '[object Set]') {
        try {
            return formatSet(object as Set<unknown>, level, state);
        } catch {}
    }
    if (ArrayBuffer.isView(object)) return formatArrayBufferView(object, level, state);
    if (tag === '[object ArrayBuffer]') {
        try {
            const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(object);
            return `ArrayBuffer(${byteLength}) [ ${Array.from(new Uint8Array(object as ArrayBuffer)).join(', ')} ]`;
        } catch {}
    }
    return formatObject(object, level, state);
}

function formatMap(map: Map<unknown, unknown>, level: number, state: State): string {
    const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!.call(map);
    const entries = Array.from(Map.prototype.entries.call(map), ([key, value]) =>
        `${formatValue(key, level + 1, state)}: ${formatValue(value, level + 1, state)}`);
    return entries.length === 0 ? 'Map {}' : `Map(${size}) { ${entries.join(', ')} }`;
}

function formatSet(set: Set<unknown>, level: number, state: State): string {
    const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!.call(set);
    const entries = Array.from(Set.prototype.values.call(set), value => formatValue(value, level + 1, state));
    return entries.length === 0 ? 'Set {}' : `Set(${size}) { ${entries.join(', ')} }`;
}

function formatArrayBufferView(view: ArrayBufferView, level: number, state: State): string {
    const name = constructorName(view) ?? 'ArrayBufferView';
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (Object.prototype.toString.call(view) === '[object DataView]') {
        return `DataView(${view.byteLength}) [ ${Array.from(bytes).join(', ')} ]`;
    }
    const values = Array.from(view as unknown as Iterable<unknown>, value => formatValue(value, level + 1, state));
    return `${name}(${values.length}) [ ${values.join(', ')} ]`;
}

function isArrayIndex(key: string, length: number): boolean {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function invalidDepth(message: string): TypeError & { code: string } {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
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
