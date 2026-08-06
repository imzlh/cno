/**
 * Node.js-compatible util.inspect implementation.
 *
 * Written in TS on top of plain ECMAScript reflection so the output matches
 * Node's `util.inspect` byte-for-byte for the shapes that matter (circular
 * refs, depth truncation, Map/Set/TypedArray/Error/Promise, getters, colors).
 * The native `console.inspect` binding is only consulted for promise state.
 */

const engine = import.meta.use('engine');

export interface InspectOptions {
    showHidden?: boolean;
    depth?: number | null;
    colors?: boolean;
    customInspect?: boolean;
    showProxy?: boolean;
    maxArrayLength?: number | null;
    maxStringLength?: number | null;
    breakLength?: number;
    compact?: boolean | number;
    sorted?: boolean | ((a: string, b: string) => number);
    getters?: boolean | 'get' | 'set';
    numericSeparator?: boolean;
}

interface Ctx extends Required<Omit<InspectOptions, 'depth' | 'maxArrayLength' | 'maxStringLength'>> {
    depth: number | null;
    maxArrayLength: number | null;
    maxStringLength: number | null;
    seen: unknown[];
    circular: Map<unknown, number> | undefined;
    indentationLvl: number;
    currentDepth: number;
    budget: Record<number, number>;
    stylize: (str: string, styleType: string) => string;
}

export const inspectColors: Record<string, [number, number]> = {
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    blink: [5, 25],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    doubleunderline: [21, 24],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    framed: [51, 54],
    overlined: [53, 55],
    gray: [90, 39],
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39],
    bgGray: [100, 49],
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49],
};
// Node aliases grey -> gray and the bg variant.
inspectColors.grey = inspectColors.gray;
inspectColors.bgGrey = inspectColors.bgGray;
inspectColors.blackBright = inspectColors.gray;
inspectColors.bgBlackBright = inspectColors.bgGray;

export const inspectStyles: Record<string, string> = {
    special: 'cyan',
    number: 'yellow',
    bigint: 'yellow',
    boolean: 'yellow',
    undefined: 'grey',
    null: 'bold',
    string: 'green',
    symbol: 'green',
    date: 'magenta',
    regexp: 'red',
    module: 'underline',
};

export const defaultInspectOptions: Required<InspectOptions> = {
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    showProxy: false,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: 3,
    sorted: false,
    getters: false,
    numericSeparator: false,
};

const kObjectType = 0;
const kArrayType = 1;
const kArrayExtrasType = 2;

const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

function stylizeWithColor(str: string, styleType: string): string {
    const style = inspectStyles[styleType];
    if (style !== undefined) {
        const color = inspectColors[style];
        if (color !== undefined) {
            return `\x1b[${color[0]}m${str}\x1b[${color[1]}m`;
        }
    }
    return str;
}

function stylizeNoColor(str: string): string {
    return str;
}

// ---------------------------------------------------------------------------
// String / number formatting primitives
// ---------------------------------------------------------------------------

const strEscapeSequencesRegExp = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const strEscapeSequencesReplacer = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const strEscapeSequencesRegExpSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const strEscapeSequencesReplacerSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const meta = [
    '\\x00', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', '\\x07',
    '\\b', '\\t', '\\n', '\\x0B', '\\f', '\\r', '\\x0E', '\\x0F',
    '\\x10', '\\x11', '\\x12', '\\x13', '\\x14', '\\x15', '\\x16', '\\x17',
    '\\x18', '\\x19', '\\x1A', '\\x1B', '\\x1C', '\\x1D', '\\x1E', '\\x1F',
    '', '', '', '', '', '', '', "\\'", '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '\\\\', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '\\x7F',
    '\\x80', '\\x81', '\\x82', '\\x83', '\\x84', '\\x85', '\\x86', '\\x87',
    '\\x88', '\\x89', '\\x8A', '\\x8B', '\\x8C', '\\x8D', '\\x8E', '\\x8F',
    '\\x90', '\\x91', '\\x92', '\\x93', '\\x94', '\\x95', '\\x96', '\\x97',
    '\\x98', '\\x99', '\\x9A', '\\x9B', '\\x9C', '\\x9D', '\\x9E', '\\x9F',
];

function escapeFn(str: string): string {
    const charCode = str.charCodeAt(0);
    return meta.length > charCode ? meta[charCode] : `\\u${charCode.toString(16)}`;
}

/** Quote + escape a string the way Node does (prefers ', then ", then `). */
function strEscape(str: string): string {
    let escapeTest = strEscapeSequencesRegExp;
    let escapeReplace = strEscapeSequencesReplacer;
    let singleQuote: number | false = 39;

    if (str.includes("'")) {
        if (!str.includes('"')) {
            singleQuote = -1;
        } else if (!str.includes('`') && !str.includes('${')) {
            singleQuote = -2;
        }
        if (singleQuote !== 39) {
            escapeTest = strEscapeSequencesRegExpSingle;
            escapeReplace = strEscapeSequencesReplacerSingle;
        }
    }

    // Fast path: no escaping needed at all.
    if (str.length < 5000 && !escapeTest.test(str)) {
        return addQuotes(str, singleQuote);
    }
    if (str.length > 100) {
        return addQuotes(str.replace(escapeReplace, escapeFn), singleQuote);
    }

    let result = '';
    let last = 0;
    for (let i = 0; i < str.length; i++) {
        const point = str.charCodeAt(i);
        if (point === singleQuote || point === 92 || point < 32 || (point > 126 && point < 160)) {
            if (last === i) {
                result += meta[point];
            } else {
                result += `${str.slice(last, i)}${meta[point]}`;
            }
            last = i + 1;
        } else if (point >= 0xd800 && point <= 0xdfff) {
            // Keep valid surrogate pairs intact; escape lone surrogates.
            if (point <= 0xdbff && i + 1 < str.length) {
                const next = str.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    i++;
                    continue;
                }
            }
            result += `${str.slice(last, i)}\\u${point.toString(16)}`;
            last = i + 1;
        }
    }
    if (last !== str.length) {
        result += str.slice(last);
    }
    return addQuotes(result, singleQuote);
}

function addQuotes(str: string, quotes: number | false): string {
    if (quotes === -1) return `"${str}"`;
    if (quotes === -2) return `\`${str}\``;
    return `'${str}'`;
}

function addNumericSeparator(integerString: string): string {
    let result = '';
    let i = integerString.length;
    const start = integerString.startsWith('-') ? 1 : 0;
    for (; i >= start + 4; i -= 3) {
        result = `_${integerString.slice(i - 3, i)}${result}`;
    }
    return i === integerString.length ? integerString : `${integerString.slice(0, i)}${result}`;
}

function addNumericSeparatorEnd(fractionString: string): string {
    let result = '';
    let i = 0;
    for (; i < fractionString.length - 3; i += 3) {
        result += `${fractionString.slice(i, i + 3)}_`;
    }
    return i === 0 ? fractionString : `${result}${fractionString.slice(i)}`;
}

function formatNumberBase(fn: (s: string, t: string) => string, number: number, numericSeparator: boolean): string {
    if (!numericSeparator) {
        return fn(`${number}`, 'number');
    }
    const numberString = String(number);
    const integer = Math.trunc(number);
    if (integer === number) {
        if (!Number.isFinite(number) || numberString.includes('e')) {
            return fn(numberString, 'number');
        }
        return fn(addNumericSeparator(numberString), 'number');
    }
    if (Number.isNaN(number)) {
        return fn(numberString, 'number');
    }
    // Split on the decimal point of the *full* string. Using String(trunc(n))
    // loses the sign for -0.x and misaligns the slice offset by one.
    const decimalIndex = numberString.indexOf('.');
    const integerPart = numberString.slice(0, decimalIndex);
    const fractionalPart = numberString.slice(decimalIndex + 1);
    return fn(
        `${addNumericSeparator(integerPart)}.${addNumericSeparatorEnd(fractionalPart)}`,
        'number',
    );
}

function formatNumber(fn: (s: string, t: string) => string, number: number, numericSeparator: boolean): string {
    // Format -0 as '-0'. Only without separators: Node renders -0 as '0' there.
    if (!numericSeparator && Object.is(number, -0)) return fn('-0', 'number');
    return formatNumberBase(fn, number, numericSeparator);
}

function formatBigInt(fn: (s: string, t: string) => string, bigint: bigint, numericSeparator: boolean): string {
    const string = String(bigint);
    if (!numericSeparator) return fn(`${string}n`, 'bigint');
    return fn(`${addNumericSeparator(string)}n`, 'bigint');
}

function formatPrimitive(fn: (s: string, t: string) => string, value: unknown, ctx: Ctx): string {
    if (typeof value === 'string') {
        let trailer = '';
        if (ctx.maxStringLength !== null && value.length > ctx.maxStringLength) {
            const remaining = value.length - ctx.maxStringLength;
            value = value.slice(0, ctx.maxStringLength);
            trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
        }
        const str = value as string;
        if (
            ctx.compact !== true && str.length > kMinLineLength &&
            str.length > ctx.breakLength - ctx.indentationLvl - 4
        ) {
            // Node only ever splits *after* a newline. A long single-line string
            // is never wrapped (word-wrapping was pre-v16 behaviour).
            const indent = ' '.repeat(ctx.indentationLvl + 2);
            return str.split(/(?<=\n)/)
                .map(line => fn(strEscape(line), 'string'))
                .join(` +\n${indent}`) + trailer;
        }
        return fn(strEscape(str), 'string') + trailer;
    }
    if (typeof value === 'number') return formatNumber(fn, value, ctx.numericSeparator);
    if (typeof value === 'bigint') return formatBigInt(fn, value, ctx.numericSeparator);
    if (typeof value === 'boolean') return fn(`${value}`, 'boolean');
    if (typeof value === 'undefined') return fn('undefined', 'undefined');
    return fn(symbolToString(value as symbol), 'symbol');
}

function symbolToString(sym: symbol): string {
    return Symbol.prototype.toString.call(sym);
}

// ---------------------------------------------------------------------------
// Constructor / prefix detection
// ---------------------------------------------------------------------------

function getConstructorName(obj: object, ctx?: Ctx, recurseTimes = 0): string | null {
    let firstProto: object | null | undefined;
    let current: object | null = obj;
    let limit = 100;
    while (current !== null && limit-- > 0) {
        // A Proxy routes both reflections below through user traps that may throw.
        // Node never reaches a trap here (it reads the proxy target directly), so a
        // throw must degrade to "no constructor name" rather than escape and destroy
        // the enclosing object's whole render.
        let descriptor: PropertyDescriptor | undefined;
        try {
            descriptor = Object.getOwnPropertyDescriptor(current, 'constructor');
        } catch {
            return null;
        }
        if (
            descriptor !== undefined &&
            typeof descriptor.value === 'function' &&
            descriptor.value.name !== '' &&
            isInstanceof(obj, descriptor.value)
        ) {
            return descriptor.value.name;
        }
        try {
            current = Object.getPrototypeOf(current) as object | null;
        } catch {
            return null;
        }
        if (firstProto === undefined) firstProto = current;
    }
    if (firstProto === null || firstProto === undefined) return null;

    // No constructor anywhere on the chain, but the prototype is not null:
    // Node labels these `Object <...>` describing the unusual prototype.
    if (ctx === undefined) return null;
    const res = internalGetConstructorName(obj);
    if (recurseTimes > (ctx.depth ?? 0) && ctx.depth !== null) {
        return `${res} <Complex prototype>`;
    }
    const protoConstr = getConstructorName(firstProto, ctx, recurseTimes + 1);
    if (protoConstr === null) {
        return `${res} <${
            inspectFn(firstProto, { ...toPublicOptions(ctx), customInspect: false, depth: -1 })
        }>`;
    }
    return `${res} <${protoConstr}>`;
}

/**
 * Node requires the value to actually be an instance of the constructor it found.
 * Without this a prototype object (`Klass.prototype`) would be labelled `Klass`,
 * since it owns the `constructor` property but is not an instance of it.
 */
function isInstanceof(object: unknown, proto: Function): boolean {
    try {
        return object instanceof proto;
    } catch {
        return false;
    }
}

function getPrefix(constructor: string | null, tag: string, fallback: string, size = ''): string {
    if (constructor === null) {
        if (tag !== '' && fallback !== tag) {
            return `[${fallback}${size}: null prototype] [${tag}] `;
        }
        return `[${fallback}${size}: null prototype] `;
    }
    if (tag !== '' && constructor !== tag) {
        return `${constructor}${size} [${tag}] `;
    }
    return `${constructor}${size} `;
}

/**
 * Node's getCtxStyle: recomputes the prefix for the depth-elision marker with an
 * empty `size`, so `[Map]` is emitted rather than `[Map(2)]`.
 */
function getCtxStyle(value: object, constructor: string | null, tag: string): string {
    let fallback = '';
    if (constructor === null) {
        fallback = internalGetConstructorName(value);
        if (fallback === tag) fallback = 'Object';
    }
    return getPrefix(constructor, tag, fallback);
}

/** Approximates V8's internal class name, used only as a null-prototype fallback. */
function internalGetConstructorName(value: object): string {
    const t = Object.prototype.toString.call(value);
    return t.slice(8, -1);
}

const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const numberRegExp = /^(0|[1-9][0-9]*)$/;
const kMinLineLength = 16;

function isIntegerIndexKey(key: string | symbol): boolean {
    if (typeof key === 'symbol') return false;
    const n = Number(key);
    return Number.isInteger(n) && n >= 0 && String(n) === key;
}

// ---------------------------------------------------------------------------
// Entry formatters
// ---------------------------------------------------------------------------

type Formatter = (ctx: Ctx, value: object, recurseTimes: number) => string[];

function formatList(ctx: Ctx, value: unknown[], recurseTimes: number): string[] {
    const valLen = value.length;
    const len = ctx.maxArrayLength === null ? valLen : Math.min(ctx.maxArrayLength, valLen);
    const remaining = valLen - len;
    const output: string[] = [];
    for (let i = 0; i < len; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
            return formatArrayBuffer2(ctx, value, recurseTimes, output, i, len);
        }
        output.push(formatProperty(ctx, value, recurseTimes, i, kArrayType));
    }
    if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    return output;
}

/**
 * Sparse-array tail. Ports Node's formatSpecialArray: the empty run is derived
 * from the real index gap in Object.keys, so `<11 empty items>` still prints in
 * full when maxArrayLength is 1 (iterating only up to `len` would clip it).
 */
function formatArrayBuffer2(
    ctx: Ctx,
    value: unknown[],
    recurseTimes: number,
    output: string[],
    start: number,
    maxLength: number,
): string[] {
    const keys = Object.keys(value);
    let index = start;
    let i = start;
    for (; i < keys.length && output.length < maxLength; i++) {
        const key = keys[i];
        const tmp = +key;
        // Arrays can only have up to 2^32 - 1 entries.
        if (tmp > 2 ** 32 - 2) break;
        if (`${index}` !== key) {
            if (!numberRegExp.test(key)) break;
            const emptyItems = tmp - index;
            output.push(ctx.stylize(
                `<${emptyItems} empty item${emptyItems > 1 ? 's' : ''}>`,
                'undefined',
            ));
            index = tmp;
            if (output.length === maxLength) break;
        }
        output.push(formatProperty(ctx, value, recurseTimes, key, kArrayType));
        index++;
    }
    const remaining = value.length - index;
    if (output.length !== maxLength) {
        if (remaining > 0) {
            output.push(ctx.stylize(
                `<${remaining} empty item${remaining > 1 ? 's' : ''}>`,
                'undefined',
            ));
        }
    } else if (remaining > 0) {
        output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    }
    return output;
}

function formatTypedArray(ctx: Ctx, value: ArrayLike<unknown> & object, recurseTimes: number): string[] {
    // Read length via the intrinsic getter: a null-prototype typed array has no
    // own `length` property.
    const valLen = Reflect.apply(typedArrayLengthGetter, value, []) as number;
    const maxLength = ctx.maxArrayLength === null ? valLen : Math.min(ctx.maxArrayLength, valLen);
    const remaining = valLen - maxLength;
    const output = new Array(maxLength);
    const elementFormatter = typeof (value as unknown[])[0] === 'bigint' ? formatBigInt : formatNumber;
    for (let i = 0; i < maxLength; i++) {
        output[i] = elementFormatter(ctx.stylize as never, (value as never[])[i], ctx.numericSeparator);
    }
    if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    if (ctx.showHidden) {
        ctx.indentationLvl += 2;
        for (const key of ['BYTES_PER_ELEMENT', 'length', 'byteLength', 'byteOffset', 'buffer']) {
            const str = formatValue(ctx, (value as unknown as Record<string, unknown>)[key], recurseTimes, true);
            output.push(`[${key}]: ${str}`);
        }
        ctx.indentationLvl -= 2;
    }
    return output;
}

function formatSet(ctx: Ctx, value: Set<unknown>, recurseTimes: number): string[] {
    const length = Reflect.apply(setSizeGetter, value, []) as number;
    const maxLength = ctx.maxArrayLength === null ? length : Math.min(ctx.maxArrayLength, length);
    const remaining = length - maxLength;
    const output: string[] = [];
    ctx.indentationLvl += 2;
    let i = 0;
    // Call the intrinsic directly: a null-prototype Set has no `values` method.
    const it = Reflect.apply(setValues, value, []) as Iterator<unknown>;
    for (;;) {
        const step = it.next();
        if (step.done === true || i >= maxLength) break;
        output.push(formatValue(ctx, step.value, recurseTimes));
        i++;
    }
    if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    ctx.indentationLvl -= 2;
    return output;
}

function formatMap(ctx: Ctx, value: Map<unknown, unknown>, recurseTimes: number): string[] {
    const length = Reflect.apply(mapSizeGetter, value, []) as number;
    const maxLength = ctx.maxArrayLength === null ? length : Math.min(ctx.maxArrayLength, length);
    const remaining = length - maxLength;
    const output: string[] = [];
    ctx.indentationLvl += 2;
    let i = 0;
    // Call the intrinsic directly: a null-prototype Map has no `entries` method.
    const it = Reflect.apply(mapEntries, value, []) as Iterator<[unknown, unknown]>;
    for (;;) {
        const step = it.next();
        if (step.done === true || i >= maxLength) break;
        const k = step.value[0];
        const v = step.value[1];
        output.push(`${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`);
        i++;
    }
    if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    ctx.indentationLvl -= 2;
    return output;
}

function formatArrayBuffer(ctx: Ctx, value: ArrayBufferLike): string[] {
    let buffer: Uint8Array;
    try {
        buffer = new Uint8Array(value);
    } catch {
        return ['(detached)'];
    }
    const maxLength = ctx.maxArrayLength === null ? buffer.length : Math.min(ctx.maxArrayLength, buffer.length);
    let str = '';
    for (let i = 0; i < maxLength; i++) {
        str += (i === 0 ? '' : ' ') + buffer[i].toString(16).padStart(2, '0');
    }
    const remaining = buffer.length - maxLength;
    if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
    return [`${ctx.stylize('[Uint8Contents]', 'special')}: <${str}>`];
}

function formatPromise(ctx: Ctx, value: Promise<unknown>, recurseTimes: number): string[] {
    let output: string[];
    const state = getPromiseState(value);
    if (state.pending) {
        output = [ctx.stylize('<pending>', 'special')];
    } else if (state.rejected) {
        const err = state.value;
        ctx.indentationLvl += 2;
        output = [`${ctx.stylize('<rejected>', 'special')} ${formatValue(ctx, err, recurseTimes)}`];
        ctx.indentationLvl -= 2;
    } else {
        output = [formatValue(ctx, state.value, recurseTimes)];
    }
    return output;
}

interface PromiseState {
    pending: boolean;
    rejected: boolean;
    value: unknown;
}

/**
 * Reads a promise's settled state synchronously.
 * `engine.promiseResult` returns null for pending, the value for fulfilled and
 * throws the rejection reason for rejected promises.
 */
function getPromiseState(p: Promise<unknown>): PromiseState {
    try {
        const v = engine.promiseResult(p);
        if (v === null) {
            // Ambiguous: pending, or fulfilled with null. Disambiguate via the
            // native inspector, which reports `Promise<pending>` for pending.
            return { pending: isNativePending(p), rejected: false, value: null };
        }
        return { pending: false, rejected: false, value: v };
    } catch (err) {
        return { pending: false, rejected: true, value: err };
    }
}

let nativeConsoleRef: { inspect(v: unknown, o?: unknown): string } | undefined;
function isNativePending(p: Promise<unknown>): boolean {
    try {
        if (nativeConsoleRef === undefined) {
            nativeConsoleRef = import.meta.use('console') as { inspect(v: unknown, o?: unknown): string };
        }
        return String(nativeConsoleRef.inspect(p)).includes('pending');
    } catch {
        return true;
    }
}

function formatWeakSet(ctx: Ctx): string[] {
    return [ctx.stylize('<items unknown>', 'special')];
}

/** Node's ErrorPrototypeToString: omits ": " when the message is empty. */
function errorToString(err: object, name: string): string | null {
    try {
        return Error.prototype.toString.call(err);
    } catch { /* fall through to the message read */ }
    try {
        const msg = String((err as { message?: unknown }).message ?? '');
        return msg === '' ? name : `${name}: ${msg}`;
    } catch {
        // Both the built-in toString AND the message read threw. Node falls all the
        // way back to Object.prototype.toString here (`[object Error]`).
        return null;
    }
}

function formatError(err: Error, constructor: string | null, tag: string, ctx: Ctx, keys: (string | symbol)[]): string {
    // A throwing `name` or `stack` getter used to escape and replace the enclosing
    // object's whole render. Node degrades to Object.prototype.toString instead —
    // measured on v24.18.0: a throwing `.name` or `.message` gives `[object Error]`,
    // and a throwing `.stack` gives `[Error: outer]` (the frameless-head form).
    const objectTag = (): string => {
        try {
            return Object.prototype.toString.call(err);
        } catch {
            return '[object Error]';
        }
    };

    let name: string;
    try {
        const raw = (err as { name?: unknown }).name;
        name = raw != null ? String(raw) : 'Error';
    } catch {
        return objectTag();
    }

    let stack: unknown;
    try {
        stack = (err as { stack?: unknown }).stack;
    } catch {
        // Treat an unreadable stack as absent so the head is rebuilt below.
        stack = undefined;
    }
    // Node's getStackString falls back to Error.prototype.toString, which omits
    // the ": " when the message is empty (so `[Error]`, not `[Error: ]`).
    let str: string;
    if (typeof stack === 'string' && stack !== '') {
        str = stack;
    } else if (stack !== undefined && stack !== null && stack !== '') {
        // A non-string, truthy `stack`: Node renders the error head then the
        // inspected stack value indented by four spaces.
        ctx.seen.push(err);
        ctx.indentationLvl += 4;
        const result = formatValue(ctx, stack, 0);
        ctx.indentationLvl -= 4;
        ctx.seen.pop();
        const head = errorToString(err, name);
        if (head === null) return objectTag();
        str = `${head}\n    ${result}`;
    } else {
        const head = errorToString(err, name);
        if (head === null) return objectTag();
        str = head;
    }

    // Our engine appends a trailing newline to stacks; Node's has none.
    str = str.replace(/\n+$/, '');

    if (ctx.showHidden) {
        // V8 defines `stack` before `message` on Error instances; our engine
        // reports the reverse order from getOwnPropertyNames. Normalise it so
        // showHidden output matches Node.
        const si = keys.indexOf('stack');
        const mi = keys.indexOf('message');
        if (si !== -1 && mi !== -1 && mi < si) {
            keys.splice(si, 1);
            keys.splice(mi, 0, 'stack');
        }
    }

    if (!ctx.showHidden && keys.length !== 0) {
        // Node only hides these when they are already visible in the rendered
        // stack; under showHidden it lists them as [stack]/[message]/[name].
        const stackIdx = keys.indexOf('stack');
        if (stackIdx !== -1) keys.splice(stackIdx, 1);

        let message: unknown;
        let messageThrew = false;
        try { message = (err as { message?: unknown }).message; } catch { messageThrew = true; }
        if (!messageThrew) {
            const msgIdx = keys.indexOf('message');
            if (msgIdx !== -1 && (typeof message !== 'string' || str.includes(message))) {
                keys.splice(msgIdx, 1);
            }
        }

        let nameVal: unknown;
        let nameThrew = false;
        try { nameVal = (err as { name?: unknown }).name; } catch { nameThrew = true; }
        if (!nameThrew) {
            const nameIdx = keys.indexOf('name');
            if (nameIdx !== -1 && (typeof nameVal !== 'string' || str.includes(nameVal))) {
                keys.splice(nameIdx, 1);
            }
        }
    }

    // `cause` and `errors` are non-enumerable but Node still lists them.
    if (Object.prototype.hasOwnProperty.call(err, 'cause') && !keys.includes('cause')) {
        keys.push('cause');
    }
    try {
        const errors = (err as { errors?: unknown }).errors;
        if (Array.isArray(errors) && Object.prototype.hasOwnProperty.call(err, 'errors') &&
            !keys.includes('errors')) {
            keys.push('errors');
        }
    } catch { /* an `errors` getter that throws is ignored */ }

    // Wrap the error in brackets when it carries no stack frames. Node applies
    // this to the rendered string regardless of where it came from.
    {
        const message = (err as { message?: unknown }).message;
        const msgStr = typeof message === 'string' ? message : '';
        // Node's own expression: an empty message or a hit at index 0 yields -1.
        let pos = (msgStr && str.indexOf(msgStr)) || -1;
        if (pos !== -1) pos += msgStr.length;
        if (str.indexOf('\n    at', pos) === -1) str = `[${str}]`;
    }

    if (ctx.indentationLvl !== 0) {
        const indentation = ' '.repeat(ctx.indentationLvl);
        str = str.split('\n').join(`\n${indentation}`);
    }
    return str;
}

// ---------------------------------------------------------------------------
// Property formatting
// ---------------------------------------------------------------------------

function formatProperty(
    ctx: Ctx,
    value: object,
    recurseTimes: number,
    key: string | symbol | number,
    type: number,
    desc?: PropertyDescriptor,
    original: object = value,
): string {
    let name = '';
    let str: string;
    let extra = ' ';
    const descriptor = desc ?? Object.getOwnPropertyDescriptor(value, key as PropertyKey) ??
        { value: (value as Record<PropertyKey, unknown>)[key as PropertyKey], enumerable: true };

    if (descriptor.value !== undefined || 'value' in descriptor) {
        const diff = (ctx.compact !== true || type !== kObjectType) ? 2 : 3;
        ctx.indentationLvl += diff;
        str = formatValue(ctx, descriptor.value, recurseTimes);
        // Under compact:true a wide value is pushed onto its own indented line.
        if (diff === 3 && ctx.breakLength < getStringWidth(str)) {
            extra = `\n${' '.repeat(ctx.indentationLvl)}`;
        }
        ctx.indentationLvl -= diff;
    } else if (descriptor.get !== undefined) {
        const label = descriptor.set !== undefined ? 'Getter/Setter' : 'Getter';
        const s = ctx.stylize;
        const wantGet = ctx.getters === true || (ctx.getters === 'get' && descriptor.set === undefined) ||
            (ctx.getters === 'set' && descriptor.set !== undefined);
        if (wantGet) {
            try {
                // The receiver must be the original instance: for a property
                // found by walking the prototype chain, calling the getter on
                // the prototype would throw or read the wrong slot.
                const tmp = descriptor.get.call(original);
                ctx.indentationLvl += 2;
                if (tmp === null) {
                    str = `${s(`[${label}:`, 'special')} ${s('null', 'null')}${s(']', 'special')}`;
                } else if (typeof tmp === 'object') {
                    str = `${s(`[${label}]`, 'special')} ${formatValue(ctx, tmp, recurseTimes)}`;
                } else {
                    const primitive = formatPrimitive(s, tmp, ctx);
                    str = `${s(`[${label}:`, 'special')} ${primitive}${s(']', 'special')}`;
                }
                ctx.indentationLvl -= 2;
            } catch (err) {
                const message = `<Inspection threw (${formatValue(ctx, err, recurseTimes)})>`;
                str = `${s(`[${label}:`, 'special')} ${message}${s(']', 'special')}`;
            }
        } else {
            str = ctx.stylize(`[${label}]`, 'special');
        }
    } else if (descriptor.set !== undefined) {
        str = ctx.stylize('[Setter]', 'special');
    } else {
        str = ctx.stylize('undefined', 'undefined');
    }

    if (type === kArrayType) return str;

    if (typeof key === 'symbol') {
        name = ctx.stylize(symbolToString(key).replace(/\n/g, '\\n'), 'symbol');
    } else if (key === '__proto__') {
        name = "['__proto__']";
    } else if (keyStrRegExp.test(String(key))) {
        name = ctx.stylize(String(key), 'name');
    } else {
        name = ctx.stylize(strEscape(String(key)), 'string');
    }
    // Brackets mark a non-enumerable property, never a symbol key.
    if (descriptor.enumerable === false) name = `[${name}]`;

    return `${name}:${extra}${str}`;
}

function getStringWidth(str: string): number {
    return str.length;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const separatorSpace = 2; // ", ".length

function groupArrayElements(ctx: Ctx, output: string[], value: unknown[] | undefined): string[] {
    let totalLength = 0;
    let maxLength = 0;
    let i = 0;
    let outputLength = output.length;
    if (ctx.maxArrayLength !== null && ctx.maxArrayLength < output.length) {
        // The last entry is the "... n more items" hint; exclude it from grouping.
        outputLength = output.length - 1;
    }
    const dataLen = new Array(outputLength);
    for (; i < outputLength; i++) {
        const len = getStringWidth(output[i]);
        dataLen[i] = len;
        totalLength += len + separatorSpace;
        if (maxLength < len) maxLength = len;
    }
    const actualMax = maxLength + separatorSpace;
    if (
        actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
        (totalLength / actualMax > 5 || maxLength <= 6)
    ) {
        const approxCharHeights = 2.5;
        const averageBias = Math.sqrt(actualMax - totalLength / output.length);
        const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
        const columns = Math.min(
            Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
            Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
            ctx.compact === true ? 4 : (ctx.compact as number) * 4,
            15,
        );
        if (columns <= 1) return output;
        const tmp: string[] = [];
        const maxLineLength: number[] = [];
        for (let i = 0; i < columns; i++) {
            let lineLength = 0;
            for (let j = i; j < output.length; j += columns) {
                if (dataLen[j] > lineLength) lineLength = dataLen[j];
            }
            maxLineLength.push(lineLength + separatorSpace);
        }
        let order: 'padStart' | 'padEnd' = 'padStart';
        if (value !== undefined) {
            for (let i = 0; i < output.length; i++) {
                if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') {
                    order = 'padEnd';
                    break;
                }
            }
        }
        for (let i = 0; i < outputLength; i += columns) {
            const max = Math.min(i + columns, outputLength);
            let str = '';
            let j = i;
            for (; j < max - 1; j++) {
                const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
                str += order === 'padStart'
                    ? `${output[j]}, `.padStart(padding, ' ')
                    : `${output[j]}, `.padEnd(padding, ' ');
            }
            if (order === 'padStart') {
                const padding = maxLineLength[j - i] + output[j].length - dataLen[j] - separatorSpace;
                str += output[j].padStart(padding, ' ');
            } else {
                str += output[j];
            }
            tmp.push(str);
        }
        if (ctx.maxArrayLength !== null && output.length > outputLength) {
            tmp.push(output[outputLength]);
        }
        output = tmp;
    }
    return output;
}

function isBelowBreakLength(ctx: Ctx, output: string[], start: number, base: string): boolean {
    let totalLength = output.length + start;
    if (totalLength + output.length > ctx.breakLength) return false;
    for (let i = 0; i < output.length; i++) {
        if (ctx.colors) {
            totalLength += removeColors(output[i]).length;
        } else {
            totalLength += output[i].length;
        }
        if (totalLength > ctx.breakLength) return false;
    }
    return base === '' || !base.includes('\n');
}

const colorRegExp = /\x1b\[\d\d?m/g;
function removeColors(str: string): string {
    return str.replace(colorRegExp, '');
}

function reduceToSingleString(
    ctx: Ctx,
    output: string[],
    base: string,
    braces: string[],
    extrasType: number,
    recurseTimes: number,
    value?: unknown,
): string {
    if (ctx.compact !== true) {
        if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
            const entries = output.length;
            if (extrasType === kArrayExtrasType && entries > 6) {
                output = groupArrayElements(ctx, output, value as unknown[] | undefined);
            }
            if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
                const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
                if (isBelowBreakLength(ctx, output, start, base)) {
                    const joined = join(output, ', ');
                    if (!joined.includes('\n')) {
                        return `${base ? `${base} ` : ''}${braces[0]} ${joined}` +
                            ` ${braces[1]}`;
                    }
                }
            }
        }
        const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
        return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ${
            join(output, `,${indentation}  `)
        }${indentation}${braces[1]}`;
    }
    // ctx.compact === true: line up all entries on a single line when they fit.
    if (isBelowBreakLength(ctx, output, 0, base)) {
        return `${braces[0]}${base ? ` ${base}` : ''} ${join(output, ', ')} ` +
            braces[1];
    }
    const indentation = ' '.repeat(ctx.indentationLvl);
    // If the opening brace is wide (e.g. "Set {") force the first item onto the
    // next line so items line up.
    const ln = base === '' && braces[0].length === 1
        ? ' '
        : `${base ? ` ${base}` : ''}\n${indentation}  `;
    return `${braces[0]}${ln}${join(output, `,\n${indentation}  `)} ${braces[1]}`;
}

function join(output: string[], separator: string): string {
    return output.join(separator);
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

function getKeys(value: object, showHidden: boolean): (string | symbol)[] {
    let keys: (string | symbol)[];
    // `getOwnPropertySymbols` fires the `ownKeys` trap, so it has to be guarded too —
    // it used to sit outside the `try` below and let a hostile Proxy escape.
    let symbols: symbol[];
    try {
        symbols = Object.getOwnPropertySymbols(value);
    } catch {
        symbols = [];
    }
    if (showHidden) {
        try {
            keys = Object.getOwnPropertyNames(value);
        } catch {
            keys = [];
        }
        if (symbols.length !== 0) keys.push(...symbols);
    } else {
        try {
            keys = Object.keys(value);
        } catch {
            keys = [];
        }
        if (symbols.length !== 0) {
            for (const sym of symbols) {
                let desc: PropertyDescriptor | undefined;
                try {
                    desc = Object.getOwnPropertyDescriptor(value, sym);
                } catch {
                    continue;
                }
                if (desc !== undefined && desc.enumerable) keys.push(sym);
            }
        }
    }
    return keys;
}

function getFunctionBase(value: AnyFn, constructor: string | null, tag: string): string {
    const stringified = Function.prototype.toString.call(value);
    let type = 'Function';
    if (stringified.startsWith('class') || /^\s*class[\s{]/.test(stringified)) {
        // class
        let base = '[class';
        const name = value.name;
        base += name === '' ? ' (anonymous)' : ` ${name}`;
        const superProto = Object.getPrototypeOf(value) as AnyFn | null;
        if (superProto !== null && superProto !== Function.prototype && typeof superProto === 'function' && superProto.name) {
            base += ` extends ${superProto.name}`;
        }
        if (constructor === null) base += ' (null prototype)';
        return `${base}]`;
    }
    const tagStr = Object.prototype.toString.call(value);
    if (tagStr === '[object GeneratorFunction]') type = 'GeneratorFunction';
    else if (tagStr === '[object AsyncFunction]') type = 'AsyncFunction';
    else if (tagStr === '[object AsyncGeneratorFunction]') type = 'AsyncGeneratorFunction';

    let base = `[${type}`;
    if (constructor === null) base += ' (null prototype)';
    if (value.name === '') base += ' (anonymous)';
    else base += `: ${value.name}`;
    base += ']';
    if (constructor !== type && constructor !== null && !constructor.endsWith(type)) {
        base += ` ${constructor}`;
    }
    if (tag !== '' && tag !== constructor) base += ` [${tag}]`;
    return base;
}

type AnyFn = { (...args: never[]): unknown; name: string; prototype?: unknown };

function getBoxedBase(
    value: object,
    ctx: Ctx,
    keys: (string | symbol)[],
    constructor: string | null,
    tag: string,
): string {
    const tagStr = Object.prototype.toString.call(value);
    let type: string;
    let fn: () => unknown;
    if (tagStr === '[object Number]') { type = 'Number'; fn = Number.prototype.valueOf; }
    else if (tagStr === '[object String]') {
        type = 'String';
        fn = String.prototype.valueOf;
        // Drop the 0..n-1 index entries — redundant noise for a boxed String.
        keys.splice(0, (value as unknown as string).length);
    }
    else if (tagStr === '[object Boolean]') { type = 'Boolean'; fn = Boolean.prototype.valueOf; }
    else if (tagStr === '[object BigInt]') { type = 'BigInt'; fn = BigInt.prototype.valueOf; }
    else { type = 'Symbol'; fn = Symbol.prototype.valueOf; }
    let base = `[${type}`;
    if (type !== constructor) {
        base += constructor === null ? ' (null prototype)' : ` (${constructor})`;
    }
    const primitive = Reflect.apply(fn, value, []) as never;
    // Route through formatPrimitive so maxStringLength / numericSeparator / -0
    // handling all apply, exactly as Node does.
    base += `: ${formatPrimitive(stylizeNoColor, primitive, ctx)}]`;
    if (tag !== '' && tag !== constructor) base += ` [${tag}]`;
    if (keys.length === 0) return ctx.stylize(base, type.toLowerCase());
    return base;
}

function formatRaw(ctx: Ctx, value: object, recurseTimes: number, typedArray?: boolean): string {
    let keys: (string | symbol)[] | undefined;
    const constructor = getConstructorName(value, ctx, recurseTimes);
    let tag = '';
    try {
        tag = (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] as string;
    } catch { /* a throwing getter must not break inspect */ }
    // Only list the tag when it is non-enumerable / not an own property,
    // otherwise it would be printed twice (once as the key).
    const tagOwnCheck = ctx.showHidden ? Object.prototype.hasOwnProperty : Object.prototype.propertyIsEnumerable;
    if (typeof tag !== 'string' || (tag !== '' && tagOwnCheck.call(value, Symbol.toStringTag))) {
        tag = '';
    }

    let base = '';
    let formatter: Formatter = () => [];
    let braces: string[];
    let noIterator = true;
    let extrasType = kObjectType;
    let protoProps: string[] | undefined;
    if (ctx.showHidden && (ctx.depth === null || recurseTimes <= (ctx.depth ?? 0))) {
        protoProps = [];
        // showHidden walks the prototype chain with reflection that a Proxy can trap.
        try {
            addPrototypeProperties(ctx, value, value, recurseTimes, protoProps);
        } catch { /* a throwing trap must not break inspect */ }
        if (protoProps.length === 0) protoProps = undefined;
    }
    let extraKeys: string[] = [];

    // `Object.prototype.toString` reads Symbol.toStringTag (a `get` trap / a plain
    // throwing getter), and `in` fires the `has` trap. Both used to escape formatRaw
    // and replace the ENCLOSING object's entire render with "[inspect threw: ...]".
    let objTag: string;
    try {
        objTag = Object.prototype.toString.call(value);
    } catch {
        objTag = '[object Object]';
    }

    let hasIterator: boolean;
    try {
        hasIterator = Symbol.iterator in value;
    } catch {
        hasIterator = false;
    }

    if (hasIterator || constructor === null) {
        noIterator = false;
        if (Array.isArray(value)) {
            const prefix = (constructor !== 'Array' || tag !== '')
                ? getPrefix(constructor, tag, 'Array', `(${value.length})`)
                : '';
            keys = getOwnNonIndexProperties(value, ctx.showHidden);
            braces = [`${prefix}[`, ']'];
            if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
            extrasType = kArrayExtrasType;
            formatter = formatList as unknown as Formatter;
        } else if (isTypedArray(value)) {
            keys = getOwnNonIndexProperties(value as unknown as unknown[], ctx.showHidden);
            const bound = value;
            // A null prototype hides Symbol.toStringTag, so objTag is "[object
            // Object]"; recover the real name from the constructor chain.
            const fallback = objTag === '[object Object]'
                ? getTypedArrayName(value)
                : objTag.slice(8, -1);
            const taLen = Reflect.apply(typedArrayLengthGetter, value, []) as number;
            const size = `(${taLen})`;
            const prefix = constructor !== fallback || tag !== ''
                ? getPrefix(constructor, tag, fallback, size)
                : `${fallback}${size} `;
            braces = [`${prefix}[`, ']'];
            if (taLen === 0 && keys.length === 0 && !ctx.showHidden) {
                return `${braces[0]}]`;
            }
            formatter = ((c: Ctx, _v: object, r: number) => formatTypedArray(c, bound as never, r)) as Formatter;
            extrasType = kArrayExtrasType;
        } else if (isMapObject(value)) {
            const size = Reflect.apply(mapSizeGetter, value, []) as number;
            const prefix = getPrefix(constructor, tag, 'Map', `(${size})`);
            keys = getKeys(value, ctx.showHidden);
            const bound = value as Map<unknown, unknown>;
            formatter = ((c: Ctx, _v: object, r: number) => formatMap(c, bound, r)) as Formatter;
            if (size === 0 && keys.length === 0) return `${prefix}{}`;
            braces = [`${prefix}{`, '}'];
        } else if (isSetObject(value)) {
            const size = Reflect.apply(setSizeGetter, value, []) as number;
            const prefix = getPrefix(constructor, tag, 'Set', `(${size})`);
            keys = getKeys(value, ctx.showHidden);
            const bound = value as Set<unknown>;
            formatter = ((c: Ctx, _v: object, r: number) => formatSet(c, bound, r)) as Formatter;
            if (size === 0 && keys.length === 0) return `${prefix}{}`;
            braces = [`${prefix}{`, '}'];
        } else if (isIteratorTag(objTag)) {
            // Iterator objects: Node uses a V8 preview API we do not have.
            const kind = objTag.slice(8, -1);
            const label = kind === 'Map Iterator' ? 'Map Iterator' : kind;
            keys = getKeys(value, ctx.showHidden);
            braces = [`[${label}] {`, '}'];
            if (keys.length === 0) return `[${label}] {  }`.replace('{  }', '{ <items unknown> }');
            formatter = () => [ctx.stylize('<items unknown>', 'special')];
        } else {
            noIterator = true;
            braces = ['{', '}'];
        }
    } else {
        braces = ['{', '}'];
    }

    if (noIterator) {
        keys = getKeys(value, ctx.showHidden);
        braces = ['{', '}'];
        if (constructor === 'Object') {
            if (objTag === '[object Arguments]') {
                braces[0] = '[Arguments] {';
            } else if (tag !== '') {
                braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
            }
            if (keys.length === 0 && protoProps === undefined) {
                return `${braces[0]}}`;
            }
        } else if (typeof value === 'function') {
            base = getFunctionBase(value as unknown as AnyFn, constructor, tag);
            if (keys.length === 0 && protoProps === undefined) return ctx.stylize(base, 'special');
        } else if (objTag === '[object RegExp]' && hasRegExpSlot(value)) {
            const prefix = constructor !== 'RegExp' ? getPrefix(constructor, tag, 'RegExp') : '';
            base = `${prefix}${RegExp.prototype.toString.call(value)}`;
            // Node returns the source even at the depth limit, so a RegExp with
            // visible keys (e.g. under showHidden) never degrades to [RegExp].
            if (keys.length === 0 || (recurseTimes > (ctx.depth ?? 0) && ctx.depth !== null)) {
                return ctx.stylize(base, 'regexp');
            }
        } else if (objTag === '[object Date]' && hasDateSlot(value)) {
            const time = Date.prototype.getTime.call(value);
            base = Number.isNaN(time) ? 'Invalid Date' : Date.prototype.toISOString.call(value);
            const prefix = constructor !== 'Date' ? getPrefix(constructor, tag, 'Date') : '';
            base = `${prefix}${base}`;
            if (keys.length === 0) return ctx.stylize(base, 'date');
        } else if (isErrorLike(value)) {
            base = formatError(value as Error, constructor, tag, ctx, keys);
            if (keys.length === 0 && protoProps === undefined) return base;
        } else if (
            (objTag === '[object ArrayBuffer]' || objTag === '[object SharedArrayBuffer]') &&
            hasArrayBufferSlot(value)
        ) {
            const arrayType = objTag === '[object ArrayBuffer]' ? 'ArrayBuffer' : 'SharedArrayBuffer';
            const prefix = constructor !== arrayType ? getPrefix(constructor, tag, arrayType) : `${arrayType} `;
            const bound = value as ArrayBufferLike;
            if (typedArray === undefined) {
                formatter = ((c: Ctx) => formatArrayBuffer(c, bound)) as Formatter;
            } else if (keys.length === 0 && protoProps === undefined) {
                // Reached as a typed array's .buffer slot: contents are omitted.
                return `${prefix}{ [byteLength]: ${
                    formatNumber(ctx.stylize, (value as ArrayBuffer).byteLength, false)
                } }`;
            }
            braces[0] = `${prefix}{`;
            extraKeys = ['byteLength'];
        } else if (objTag === '[object DataView]' && hasSlot('isDataView', value)) {
            braces[0] = `${getPrefix(constructor, tag, 'DataView')}{`;
            // .buffer goes last, it is not a primitive like the others.
            extraKeys = ['byteLength', 'byteOffset', 'buffer'];
        } else if (objTag === '[object Promise]' && hasSlot('isPromise', value)) {
            braces[0] = `${getPrefix(constructor, tag, 'Promise')}{`;
            const bound = value as Promise<unknown>;
            formatter = ((c: Ctx, _v: object, r: number) => formatPromise(c, bound, r)) as Formatter;
        } else if (
            (objTag === '[object WeakSet]' && hasSlot('isWeakSet', value)) ||
            (objTag === '[object WeakMap]' && hasSlot('isWeakMap', value))
        ) {
            const which = objTag === '[object WeakSet]' ? 'WeakSet' : 'WeakMap';
            braces[0] = `${getPrefix(constructor, tag, which)}{`;
            formatter = ((c: Ctx) => formatWeakSet(c)) as Formatter;
        } else if (objTag === '[object Module]') {
            braces[0] = `${getPrefix(constructor, tag, 'Module')}{`;
        } else if (isBoxedTag(objTag)) {
            base = getBoxedBase(value, ctx, keys, constructor, tag);
            if (keys.length === 0 && protoProps === undefined) return base;
        } else if (isURL(value) && !(recurseTimes > (ctx.depth ?? 0) && ctx.depth !== null)) {
            base = (value as unknown as URL).href;
            if (keys.length === 0 && protoProps === undefined) return base;
        } else {
            if (keys.length === 0 && protoProps === undefined) {
                return `${getCtxStyle(value, constructor, tag)}{}`;
            }
            braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
        }
    }

    if (recurseTimes > (ctx.depth ?? 0) && ctx.depth !== null) {
        // Recompute the prefix with an empty size (Node drops `(N)` here) and only
        // wrap in brackets when there is a real constructor — a null-prototype
        // prefix is already bracketed.
        let constructorName = getCtxStyle(value, constructor, tag).slice(0, -1);
        if (constructor !== null) constructorName = `[${constructorName}]`;
        return ctx.stylize(constructorName, 'special');
    }

    ctx.seen.push(value);
    recurseTimes += 1;
    ctx.currentDepth = recurseTimes;
    let output: string[];
    try {
        output = formatter(ctx, value, recurseTimes);
        // Synthetic slots (byteLength/buffer/…) are always shown bracketed.
        for (let i = 0; i < extraKeys.length; i++) {
            output.push(formatExtraProperties(ctx, value, recurseTimes, extraKeys[i], typedArray));
        }
        for (let i = 0; i < (keys as (string | symbol)[]).length; i++) {
            output.push(formatProperty(ctx, value, recurseTimes, (keys as (string | symbol)[])[i], extrasType));
        }
        if (protoProps !== undefined) {
            output.push(...protoProps);
        }
    } catch (err) {
        ctx.seen.pop();
        // A user's [util.inspect.custom] hook is the one thing Node propagates out of
        // util.inspect. The outermost handler honours that marker, but this inner catch
        // used to stringify first, so a TOP-LEVEL throwing hook propagated while a
        // NESTED one silently became "[inspect threw: ...]" — cno disagreeing with
        // itself. Re-throw so the marker reaches inspectImpl.
        if (err !== null && typeof err === 'object' &&
            (err as Record<PropertyKey, unknown>)[kCustomInspectError] === true) {
            throw err;
        }
        return `[inspect threw: ${(err as Error)?.message ?? String(err)}]`;
    }

    if (ctx.circular !== undefined) {
        const index = ctx.circular.get(value);
        if (index !== undefined) {
            const reference = ctx.stylize(`<ref *${index}>`, 'special');
            if (ctx.compact !== true) base = base === '' ? reference : `${reference} ${base}`;
            else braces[0] = `${reference} ${braces[0]}`;
        }
    }
    ctx.seen.pop();

    if (ctx.sorted) {
        const comparator = ctx.sorted === true ? undefined : ctx.sorted as (a: string, b: string) => number;
        if (extrasType === kObjectType) {
            output.sort(comparator);
        } else if ((keys as (string | symbol)[]).length > 1) {
            const sorted = output.slice(output.length - (keys as (string | symbol)[]).length).sort(comparator);
            output.splice(output.length - (keys as (string | symbol)[]).length, (keys as (string | symbol)[]).length, ...sorted);
        }
    }

    const res = reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value);
    return res;
}

/**
 * Under showHidden Node also lists non-function properties found on up to three
 * prototype layers (stopping at built-ins), which is where things like a
 * generator's `Symbol.toStringTag` come from. Ported from Node's
 * addPrototypeProperties.
 */
function addPrototypeProperties(
    ctx: Ctx,
    main: object,
    objIn: object,
    recurseTimes: number,
    output: string[],
): void {
    let depth = 0;
    let keys: (string | symbol)[] = [];
    let keySet: Set<string | symbol> = new Set();
    let obj: object | null = objIn;
    do {
        if (depth !== 0 || main === obj) {
            obj = Object.getPrototypeOf(obj as object) as object | null;
            if (obj === null) return;
            const descriptor = Object.getOwnPropertyDescriptor(obj, 'constructor');
            if (
                descriptor !== undefined &&
                typeof descriptor.value === 'function' &&
                builtInObjects.has((descriptor.value as { name: string }).name)
            ) {
                return;
            }
        }

        if (depth === 0) {
            keySet = new Set();
        } else {
            for (const key of keys) keySet.add(key);
        }
        keys = Reflect.ownKeys(obj as object);
        ctx.seen.push(main);
        for (const key of keys) {
            if (
                key === 'constructor' ||
                Object.prototype.hasOwnProperty.call(main, key) ||
                (depth !== 0 && keySet.has(key))
            ) {
                continue;
            }
            const desc = Object.getOwnPropertyDescriptor(obj as object, key);
            if (desc === undefined || typeof desc.value === 'function') continue;
            const formatted = formatProperty(
                ctx,
                obj as object,
                recurseTimes,
                key,
                kObjectType,
                desc,
                main,
            );
            if (ctx.colors) {
                output.push(`[2m${formatted}[22m`);
            } else {
                output.push(formatted);
            }
        }
        ctx.seen.pop();
        // Node limits this to three prototype layers.
    } while (++depth !== 3);
}

/**
 * Slot checks. `Object.prototype.toString` only reflects the prototype chain, so
 * `Object.create(ArrayBuffer.prototype)` reports `[object ArrayBuffer]` while
 * lacking the internal slot. Formatting it as a real ArrayBuffer throws; Node
 * tests the slot and renders `ArrayBuffer {}` instead.
 */
function hasSlot(
    fn: 'isDataView' | 'isPromise' | 'isWeakMap' | 'isWeakSet' | 'isArrayBuffer',
    value: object,
): boolean {
    try {
        const probe = (engine as unknown as Record<string, ((v: unknown) => boolean) | undefined>)[fn];
        return probe === undefined ? true : probe(value);
    } catch {
        return false;
    }
}

function hasArrayBufferSlot(value: object): boolean {
    if (hasSlot('isArrayBuffer', value)) return true;
    // engine.isArrayBuffer does not cover SharedArrayBuffer; probe both
    // byteLength getters directly.
    for (const getter of arrayBufferByteLengthGetters) {
        try {
            Reflect.apply(getter, value, []);
            return true;
        } catch { /* try the next one */ }
    }
    return false;
}

const arrayBufferByteLengthGetters: (() => unknown)[] = (() => {
    const out: (() => unknown)[] = [];
    const ab = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
    if (ab !== undefined) out.push(ab as () => unknown);
    const SAB = (globalThis as { SharedArrayBuffer?: { prototype: object } }).SharedArrayBuffer;
    if (SAB !== undefined) {
        const sab = Object.getOwnPropertyDescriptor(SAB.prototype, 'byteLength')?.get;
        if (sab !== undefined) out.push(sab as () => unknown);
    }
    return out;
})();

/**
 * Node's isError: a native error slot OR `instanceof Error`. Deliberately does
 * not consult Symbol.toStringTag, so an object merely tagged "Error" is printed
 * as a plain object rather than routed through formatError.
 */
function isErrorLike(value: object): boolean {
    try {
        if ((engine as { isError?: (v: unknown) => boolean }).isError?.(value) === true) return true;
    } catch { /* fall through */ }
    try {
        // `instanceof` walks the prototype chain, firing a Proxy `getPrototypeOf` trap.
        return value instanceof Error;
    } catch {
        return false;
    }
}

/** Date/RegExp slot probes, for the same spoofed-tag reason as above. */
function hasDateSlot(value: object): boolean {
    try {
        if ((engine as { isDate?: (v: unknown) => boolean }).isDate?.(value) === true) return true;
    } catch { /* fall through */ }
    try {
        Date.prototype.getTime.call(value as Date);
        return true;
    } catch {
        return false;
    }
}

function hasRegExpSlot(value: object): boolean {
    try {
        if ((engine as { isRegExp?: (v: unknown) => boolean }).isRegExp?.(value) === true) return true;
    } catch { /* fall through */ }
    try {
        // `source` is an accessor on RegExp.prototype backed by the slot.
        Reflect.apply(regExpSourceGetter, value, []);
        return true;
    } catch {
        return false;
    }
}

const regExpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!;

function isIteratorTag(objTag: string): boolean {
    return objTag === '[object Map Iterator]' || objTag === '[object Set Iterator]' ||
        objTag === '[object Array Iterator]' || objTag === '[object String Iterator]' ||
        objTag === '[object RegExp String Iterator]';
}

/** Synthetic slots like [byteLength] — Node always brackets and stylizes these. */
function formatExtraProperties(
    ctx: Ctx,
    value: object,
    recurseTimes: number,
    key: string,
    typedArray?: boolean,
): string {
    ctx.indentationLvl += 2;
    let str: string;
    try {
        str = formatValue(ctx, (value as Record<string, unknown>)[key], recurseTimes, typedArray);
    } finally {
        ctx.indentationLvl -= 2;
    }
    return `${ctx.stylize(`[${key}]`, 'string')}: ${str}`;
}

function isBoxedTag(objTag: string): boolean {
    return objTag === '[object Number]' || objTag === '[object String]' ||
        objTag === '[object Boolean]' || objTag === '[object BigInt]' ||
        objTag === '[object Symbol]';
}

/** Node renders a URL as its href rather than as a plain object. */
function isURL(value: object): boolean {
    return typeof (value as { href?: unknown }).href === 'string' && value instanceof URL;
}

const typedArrayTags = new Set([
    '[object Uint8Array]', '[object Int8Array]', '[object Uint8ClampedArray]',
    '[object Uint16Array]', '[object Int16Array]', '[object Uint32Array]',
    '[object Int32Array]', '[object Float32Array]', '[object Float64Array]',
    '[object BigInt64Array]', '[object BigUint64Array]', '[object Float16Array]',
]);

function isTypedArray(value: object): boolean {
    if (typedArrayTags.has(Object.prototype.toString.call(value))) return true;
    // A null prototype hides the Symbol.toStringTag, so fall back to a slot probe.
    try {
        Reflect.apply(typedArrayLengthGetter, value, []);
        return true;
    } catch {
        return false;
    }
}

const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Int8Array.prototype),
    'length',
)!.get!;

/**
 * Recovers a typed array's class name when a null prototype hides its tag.
 * The %TypedArray%.prototype[Symbol.toStringTag] getter reads the instance's
 * internal slot rather than the prototype chain, so it still reports the exact
 * subclass.
 */
function getTypedArrayName(value: object): string {
    try {
        const name = Reflect.apply(typedArrayTagGetter, value, []) as unknown;
        if (typeof name === 'string' && name !== '') return name;
    } catch { /* fall through */ }
    return 'TypedArray';
}

const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Int8Array.prototype),
    Symbol.toStringTag as never,
)!.get!;

const setSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const setValues = Set.prototype.values;
const mapEntries = Map.prototype.entries;

/**
 * Slot-based Set/Map probes. `Object.prototype.toString` resolves
 * Symbol.toStringTag through the prototype chain, so a null-prototype Set
 * reports `[object Object]` and would otherwise be printed as a plain object,
 * silently losing every entry.
 */
function isSetObject(value: object): boolean {
    try {
        Reflect.apply(setSizeGetter, value, []);
        return true;
    } catch {
        return false;
    }
}

function isMapObject(value: object): boolean {
    try {
        Reflect.apply(mapSizeGetter, value, []);
        return true;
    } catch {
        return false;
    }
}

/** Own properties of an array-like that are not integer indices. */
function getOwnNonIndexProperties(value: unknown[], showHidden: boolean): (string | symbol)[] {
    const out: (string | symbol)[] = [];
    // Both enumerations below route through a Proxy's `ownKeys` trap.
    let names: string[];
    try {
        names = showHidden ? Object.getOwnPropertyNames(value) : Object.keys(value);
    } catch {
        names = [];
    }
    for (const key of names) {
        // `length` is a non-enumerable own property; Node shows it as [length] under showHidden.
        if (key === 'length' && !showHidden) continue;
        if (isIntegerIndexKey(key)) continue;
        out.push(key);
    }
    let symbols: symbol[];
    try {
        symbols = Object.getOwnPropertySymbols(value);
    } catch {
        symbols = [];
    }
    for (const sym of symbols) {
        let desc: PropertyDescriptor | undefined;
        try {
            desc = Object.getOwnPropertyDescriptor(value, sym);
        } catch {
            continue;
        }
        if (showHidden || (desc !== undefined && desc.enumerable)) out.push(sym);
    }
    return out;
}

function formatValue(ctx: Ctx, value: unknown, recurseTimes: number, typedArray?: boolean): string {
    if (typeof value !== 'object' && typeof value !== 'function' && !isUndetectableObject(value)) {
        return formatPrimitive(ctx.stylize, value, ctx);
    }
    if (value === null) {
        return ctx.stylize('null', 'null');
    }

    const context = value as object;

    // A revoked proxy throws on every reflection. Node detects this via
    // getProxyDetails; we have no such binding, so probe it instead and emit the
    // same marker.
    if (isRevokedProxy(context)) {
        return ctx.stylize('<Revoked Proxy>', 'special');
    }

    if (ctx.customInspect) {
        // Reading the symbol fires a Proxy `get` trap; Node reads the target directly
        // and so never sees a throw here.
        let maybeCustom: unknown;
        try {
            maybeCustom = (context as Record<PropertyKey, unknown>)[customInspectSymbol];
        } catch {
            maybeCustom = undefined;
        }
        if (typeof maybeCustom === 'function' && maybeCustom !== (inspect as unknown)) {
            // `depth` passed to the custom inspector is the REMAINING depth.
            const depth = ctx.depth === null ? null : (ctx.depth ?? 0) - recurseTimes;
            let ret: unknown;
            try {
                ret = Reflect.apply(maybeCustom as AnyFn, context, [
                    depth,
                    { ...toPublicOptions(ctx), depth, stylize: ctx.stylize },
                    inspect,
                ] as never[]);
            } catch (err) {
                // Node propagates errors thrown by a custom inspector.
                if (err !== null && typeof err === 'object') {
                    try {
                        (err as Record<PropertyKey, unknown>)[kCustomInspectError] = true;
                    } catch { /* frozen error: the guard falls back to rethrowing below */ }
                }
                throw err;
            }
            if (ret !== context) {
                if (typeof ret !== 'string') {
                    return formatValue(ctx, ret, recurseTimes);
                }
                return ret.replace(/\n/g, `\n${' '.repeat(ctx.indentationLvl)}`);
            }
        }
    }

    // Circular detection.
    if (ctx.seen.includes(context)) {
        let index = 1;
        if (ctx.circular === undefined) {
            ctx.circular = new Map();
            ctx.circular.set(context, index);
        } else {
            index = ctx.circular.get(context) as number;
            if (index === undefined) {
                index = ctx.circular.size + 1;
                ctx.circular.set(context, index);
            }
        }
        return ctx.stylize(`[Circular *${index}]`, 'special');
    }

    return formatRaw(ctx, context, recurseTimes, typedArray);
}

/**
 * Marks an error as originating inside a user-supplied `util.inspect.custom`
 * hook. Node lets those propagate, so the top-level guard must not swallow them.
 */
const kCustomInspectError = Symbol('kCustomInspectError');

function isUndetectableObject(v: unknown): boolean {
    return typeof v === 'undefined' && v !== undefined;
}

/**
 * True for a revoked proxy. Every internal method of a revoked proxy throws, so
 * probing `isExtensible` identifies it without consulting any user trap (a live
 * proxy without an `isExtensible` trap forwards to the target).
 */
function isRevokedProxy(value: object): boolean {
    try {
        if (!(engine as { isProxy?: (v: unknown) => boolean }).isProxy?.(value)) return false;
    } catch {
        return false;
    }
    try {
        Object.isExtensible(value);
        return false;
    } catch (err) {
        return /revoked/i.test((err as Error)?.message ?? '');
    }
}

function toPublicOptions(ctx: Ctx): InspectOptions {
    return {
        showHidden: ctx.showHidden,
        depth: ctx.depth,
        colors: ctx.colors,
        customInspect: ctx.customInspect,
        showProxy: ctx.showProxy,
        maxArrayLength: ctx.maxArrayLength,
        maxStringLength: ctx.maxStringLength,
        breakLength: ctx.breakLength,
        compact: ctx.compact,
        sorted: ctx.sorted,
        getters: ctx.getters,
        numericSeparator: ctx.numericSeparator,
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface InspectFn {
    (value: unknown, opts?: InspectOptions): string;
    (value: unknown, showHidden?: boolean, depth?: number | null, colors?: boolean): string;
    custom: symbol;
    colors: Record<string, [number, number]>;
    styles: Record<string, string>;
    defaultOptions: Required<InspectOptions>;
}

function inspectImpl(
    value: unknown,
    showHiddenOrOpts?: boolean | InspectOptions | null,
    depth?: number | null,
    colors?: boolean,
): string {
    const ctx: Ctx = {
        budget: {},
        indentationLvl: 0,
        seen: [],
        currentDepth: 0,
        stylize: stylizeNoColor,
        circular: undefined,
        showHidden: inspectFn.defaultOptions.showHidden,
        depth: inspectFn.defaultOptions.depth,
        colors: inspectFn.defaultOptions.colors,
        customInspect: inspectFn.defaultOptions.customInspect,
        showProxy: inspectFn.defaultOptions.showProxy,
        maxArrayLength: inspectFn.defaultOptions.maxArrayLength,
        maxStringLength: inspectFn.defaultOptions.maxStringLength,
        breakLength: inspectFn.defaultOptions.breakLength,
        compact: inspectFn.defaultOptions.compact,
        sorted: inspectFn.defaultOptions.sorted,
        getters: inspectFn.defaultOptions.getters,
        numericSeparator: inspectFn.defaultOptions.numericSeparator,
    } as Ctx;

    if (arguments.length > 1) {
        if (showHiddenOrOpts !== null && typeof showHiddenOrOpts === 'object') {
            const opts = showHiddenOrOpts;
            for (const key of Object.keys(opts) as (keyof InspectOptions)[]) {
                const v = opts[key];
                if (v !== undefined) {
                    (ctx as unknown as Record<string, unknown>)[key] = v;
                }
            }
        } else {
            if (showHiddenOrOpts !== undefined) ctx.showHidden = Boolean(showHiddenOrOpts);
            if (arguments.length > 2 && depth !== undefined) ctx.depth = depth;
            if (arguments.length > 3 && colors !== undefined) ctx.colors = Boolean(colors);
        }
    }

    // Normalise sentinel values the way Node does.
    if (ctx.maxArrayLength === Infinity) ctx.maxArrayLength = null;
    if (ctx.maxStringLength === Infinity) ctx.maxStringLength = null;
    if (ctx.depth === Infinity) ctx.depth = null;
    if (ctx.colors) ctx.stylize = stylizeWithColor;
    try {
        return formatValue(ctx, value, 0);
    } catch (err) {
        // Node propagates errors from a user's util.inspect.custom hook.
        if (err !== null && typeof err === 'object' &&
            (err as Record<PropertyKey, unknown>)[kCustomInspectError] === true) {
            throw err;
        }
        // Otherwise util.inspect must never throw: it is the last thing that runs
        // on an error path. A hostile/buggy proxy trap or a throwing exotic
        // object would otherwise take down the caller (typically a console.log).
        try {
            return `[inspect threw: ${(err as Error)?.message ?? String(err)}]`;
        } catch {
            return '[inspect threw]';
        }
    }
}

const inspectFn = inspectImpl as unknown as InspectFn;
inspectFn.custom = customInspectSymbol;
inspectFn.colors = inspectColors;
inspectFn.styles = inspectStyles;
inspectFn.defaultOptions = { ...defaultInspectOptions };

export const inspect = inspectFn;
export default inspectFn;

/** Number/BigInt formatting for util.format's %s/%d/%i/%f (never colored). */
export const formatNumberNoColor = (n: number, opts?: InspectOptions): string =>
    formatNumber(stylizeNoColor, n, opts?.numericSeparator ?? defaultInspectOptions.numericSeparator);

export const formatBigIntNoColor = (n: bigint, opts?: InspectOptions): string =>
    formatBigInt(stylizeNoColor, n, opts?.numericSeparator ?? defaultInspectOptions.numericSeparator);

/** Globals named like `/^[A-Z][a-zA-Z0-9]+$/` — matches Node's builtInObjects. */
const builtInObjects = new Set(
    Object.getOwnPropertyNames(globalThis).filter(e => /^[A-Z][a-zA-Z0-9]+$/.test(e)),
);

const returnFalse = () => false;
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * True when String(value) is not meaningful, so %s should inspect instead.
 * Mirrors Node's hasBuiltInToString (internal/util/inspect.js).
 */
export function hasBuiltInToString(value: object): boolean {
    // Node consults getProxyDetails() first to avoid triggering proxy traps.
    // QuickJS exposes no such binding, so a proxied `toString` lookup is visible
    // to the handler here. Accepted: there is no trap-free alternative.
    let hasOwnToString: (o: object, k: PropertyKey) => boolean = (o, k) => hasOwn.call(o, k);
    let hasOwnToPrimitive: (o: object, k: PropertyKey) => boolean = (o, k) => hasOwn.call(o, k);
    const v = value as { toString?: unknown; [Symbol.toPrimitive]?: unknown };

    // Objects with neither `toString` nor `Symbol.toPrimitive` count as built-in.
    if (typeof v.toString !== 'function') {
        if (typeof v[Symbol.toPrimitive] !== 'function') return true;
        if (hasOwn.call(value, Symbol.toPrimitive)) return false;
        hasOwnToString = returnFalse;
    } else if (hasOwn.call(value, 'toString')) {
        return false;
    } else if (typeof v[Symbol.toPrimitive] !== 'function') {
        hasOwnToPrimitive = returnFalse;
    } else if (hasOwn.call(value, Symbol.toPrimitive)) {
        return false;
    }

    // Walk to the prototype that owns `toString` / `Symbol.toPrimitive`.
    let pointer: object | null = value;
    do {
        pointer = Object.getPrototypeOf(pointer);
    } while (
        pointer !== null &&
        !hasOwnToString(pointer, 'toString') &&
        !hasOwnToPrimitive(pointer, Symbol.toPrimitive)
    );
    if (pointer === null) return true;

    const descriptor = Object.getOwnPropertyDescriptor(pointer, 'constructor');
    return descriptor !== undefined &&
        typeof descriptor.value === 'function' &&
        builtInObjects.has((descriptor.value as { name: string }).name);
}
