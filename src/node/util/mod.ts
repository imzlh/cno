/**
 * Node.js util module
 * Utility functions
 */

const console = import.meta.use('console');
const os = import.meta.use('os');
import * as types from './types';
export { types };
import { deepEqual as _deepEqual } from '../_internal/deep-equal';

type AnyCallable = { bivarianceHack(...args: unknown[]): unknown }['bivarianceHack'];
type InheritableFunction = AnyCallable & { prototype: object };

function readEnv(name: string): string | undefined {
    try {
        return os.getenv(name) ?? undefined;
    } catch {
        return undefined;
    }
}

// Type checks

export function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

export function isNull(value: unknown): value is null {
    return value === null;
}

export function isNullOrUndefined(value: unknown): value is null | undefined {
    return value === null || value === undefined;
}

export function isNumber(value: unknown): value is number {
    return typeof value === 'number';
}

export function isString(value: unknown): value is string {
    return typeof value === 'string';
}

export function isSymbol(value: unknown): value is symbol {
    return typeof value === 'symbol';
}

export function isUndefined(value: unknown): value is undefined {
    return value === undefined;
}

export function isObject(value: unknown): value is object {
    return value !== null && typeof value === 'object';
}

export function isError(value: unknown): value is Error {
    return value instanceof Error;
}

export function isFunction(value: unknown): value is AnyCallable {
    return typeof value === 'function';
}

export function isRegExp(value: unknown): value is RegExp {
    return value instanceof RegExp;
}

export function isArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

export function isDate(value: unknown): value is Date {
    return value instanceof Date;
}

export function isPrimitive(value: unknown): value is string | number | boolean | null | undefined | symbol | bigint {
    return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

export function isBuffer(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array;
}

// Formatting

function formatNumber(value: unknown): string {
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol') return 'NaN';
    return String(Number(value));
}

function formatInteger(value: unknown): string {
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol') return 'NaN';
    return String(parseInt(String(value), 10));
}

export function format(format?: unknown, ...args: unknown[]): string {
    if (format === undefined) {
        return '';
    }

    // If first arg is not a string, inspect it and remaining args
    if (typeof format !== 'string') {
        const parts = [format, ...args].map(a => inspect(a));
        return parts.join(' ');
    }

    let result = '';
    let argIndex = 0;
    let i = 0;

    while (i < format.length) {
        if (format[i] === '%' && i + 1 < format.length) {
            const specifier = format[i + 1];
            i += 2;

            if (specifier === '%') {
                result += '%';
                continue;
            }

            // If no more args, keep the specifier literal
            if (argIndex >= args.length) {
                result += '%' + specifier;
                continue;
            }

            switch (specifier) {
                case 's':
                    result += String(args[argIndex++]);
                    break;
                case 'd':
                    result += formatNumber(args[argIndex++]);
                    break;
                case 'i':
                    result += formatInteger(args[argIndex++]);
                    break;
                case 'f':
                    result += parseFloat(String(args[argIndex++]));
                    break;
                case 'j':
                    try {
                        result += JSON.stringify(args[argIndex++]);
                    } catch {
                        result += '[Circular]';
                    }
                    break;
                case 'o':
                case 'O':
                    result += inspect(args[argIndex++], {
                        depth: specifier === 'O' ? Infinity : 4,
                        showHidden: specifier === 'o',
                    });
                    break;
                default:
                    result += '%' + specifier;
                    break;
            }
        } else {
            result += format[i++];
        }
    }

    // Append remaining arguments
    while (argIndex < args.length) {
        result += ' ' + inspect(args[argIndex++]);
    }

    return result;
}

export function formatWithOptions(inspectOptions: InspectOptions, format?: unknown, ...args: unknown[]): string {
    if (format === undefined) {
        return '';
    }

    const inspectOpts: InspectOptions = {
        colors: inspectOptions.colors,
        depth: inspectOptions.depth ?? undefined,
        showHidden: inspectOptions.showHidden,
        maxArrayLength: inspectOptions.maxArrayLength,
        maxStringLength: inspectOptions.maxStringLength,
        breakLength: inspectOptions.breakLength,
        compact: inspectOptions.compact,
        sorted: inspectOptions.sorted,
    };

    if (typeof format !== 'string') {
        const result = console.inspect(format, inspectOpts);
        if (args.length > 0) {
            return result + ' ' + args.map(a => console.inspect(a, inspectOpts)).join(' ');
        }
        return result;
    }

    let result = '';
    let argIndex = 0;
    let i = 0;
    while (i < format.length) {
        if (format[i] === '%' && i + 1 < format.length) {
            const specifier = format[i + 1];
            i += 2;
            if (specifier === '%') {
                result += '%';
                continue;
            }
            if (argIndex >= args.length) {
                result += '%' + specifier;
                continue;
            }
            switch (specifier) {
                case 's':
                    result += String(args[argIndex++]);
                    break;
                case 'd':
                    result += formatNumber(args[argIndex++]);
                    break;
                case 'i':
                    result += formatInteger(args[argIndex++]);
                    break;
                case 'f':
                    result += parseFloat(String(args[argIndex++]));
                    break;
                case 'j':
                    try {
                        result += JSON.stringify(args[argIndex++]);
                    } catch {
                        result += '[Circular]';
                    }
                    break;
                case 'o':
                case 'O':
                    result += console.inspect(args[argIndex++], {
                        ...inspectOpts,
                        depth: specifier === 'O' ? Infinity : inspectOpts.depth,
                        showHidden: specifier === 'o' ? true : inspectOpts.showHidden,
                    });
                    break;
                default:
                    result += '%' + specifier;
                    break;
            }
        } else {
            result += format[i++];
        }
    }

    while (argIndex < args.length) {
        result += ' ' + console.inspect(args[argIndex++], inspectOpts);
    }

    return result;
}

// VT control characters

// Matches the common ANSI/VT escape forms used in terminal output:
//   - CSI: ESC [ ... command
//   - OSC: ESC ] ... BEL / ESC \
//   - DCS/PM/APC/SOS: ESC P/^/_/X ... ESC \
//   - Single-character ESC sequences
const VT_CONTROL_PATTERN =
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\|[@-Z\\-_])/g;

export function stripVTControlCharacters(value: string): string {
    return String(value).replace(VT_CONTROL_PATTERN, '');
}

const ANSI_STYLE_OPEN: Record<string, string> = {
    reset: '\x1B[0m',
    bold: '\x1B[1m',
    dim: '\x1B[2m',
    italic: '\x1B[3m',
    underline: '\x1B[4m',
    inverse: '\x1B[7m',
    hidden: '\x1B[8m',
    strikethrough: '\x1B[9m',
    black: '\x1B[30m',
    red: '\x1B[31m',
    green: '\x1B[32m',
    yellow: '\x1B[33m',
    blue: '\x1B[34m',
    magenta: '\x1B[35m',
    cyan: '\x1B[36m',
    white: '\x1B[37m',
    gray: '\x1B[90m',
    grey: '\x1B[90m',
    bgBlack: '\x1B[40m',
    bgRed: '\x1B[41m',
    bgGreen: '\x1B[42m',
    bgYellow: '\x1B[43m',
    bgBlue: '\x1B[44m',
    bgMagenta: '\x1B[45m',
    bgCyan: '\x1B[46m',
    bgWhite: '\x1B[47m',
};

const ANSI_STYLE_CLOSE: Record<string, string> = {
    reset: '\x1B[0m',
    bold: '\x1B[22m',
    dim: '\x1B[22m',
    italic: '\x1B[23m',
    underline: '\x1B[24m',
    inverse: '\x1B[27m',
    hidden: '\x1B[28m',
    strikethrough: '\x1B[29m',
    black: '\x1B[39m',
    red: '\x1B[39m',
    green: '\x1B[39m',
    yellow: '\x1B[39m',
    blue: '\x1B[39m',
    magenta: '\x1B[39m',
    cyan: '\x1B[39m',
    white: '\x1B[39m',
    gray: '\x1B[39m',
    grey: '\x1B[39m',
    bgBlack: '\x1B[49m',
    bgRed: '\x1B[49m',
    bgGreen: '\x1B[49m',
    bgYellow: '\x1B[49m',
    bgBlue: '\x1B[49m',
    bgMagenta: '\x1B[49m',
    bgCyan: '\x1B[49m',
    bgWhite: '\x1B[49m',
};

export function styleText(format: string | string[], text: string, options?: { validateStream?: boolean }): string {
    const formats = Array.isArray(format) ? format : [format];
    const validate = options?.validateStream !== false;
    if (validate) {
        try {
            if (os.guessHandle(os.STDOUT_FILENO) !== 'tty') return text;
        } catch {}
    }
    let out = text;
    for (let i = 0; i < formats.length; i++) {
        const name = formats[i];
        if (name === undefined) continue;
        const open = ANSI_STYLE_OPEN[name];
        const close = ANSI_STYLE_CLOSE[name];
        if (open && close) out = `${open}${out}${close}`;
    }
    return out;
}

export function debuglog(section: string, callback?: (fn: (...args: unknown[]) => void) => void): (...args: unknown[]) => void {
    const raw = readEnv('NODE_DEBUG') ?? readEnv('DEBUG');
    if (!raw) return () => {};
    
    const enabled = raw.split(/[,\s]+/).some(part => part && (part === '*' || part.toLowerCase() === section.toLowerCase()));
    const logger = (...args: unknown[]) => {
        if (!enabled) return;
        console.error(`${section.toUpperCase()} ${format(...args)}`);
    };
    if (callback) callback(logger);
    return logger;
}

export const debug = debuglog;

export function toUSVString(value: unknown): string {
    const input = String(value);
    let out = '';
    for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = input.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                out += input[i] + input[i + 1];
                i++;
            } else {
                out += '\uFFFD';
            }
            continue;
        }
        if (code >= 0xDC00 && code <= 0xDFFF) {
            out += '\uFFFD';
            continue;
        }
        out += input[i];
    }
    return out;
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
    return _deepEqual(a, b, true);
}

// inspect

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

const defaultInspectOptions: InspectOptions = {
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    showProxy: false,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: true,
    sorted: false,
    getters: false,
    numericSeparator: false,
};

export function inspect(object: unknown, options?: InspectOptions): string {
    const opts = options ?? defaultInspectOptions;
    return console.inspect(object, {
        colors: opts.colors,
        depth: opts.depth ?? undefined,
        showHidden: opts.showHidden,
        maxArrayLength: opts.maxArrayLength,
        maxStringLength: opts.maxStringLength,
        breakLength: opts.breakLength,
        compact: opts.compact,
        sorted: opts.sorted,
    });
}

inspect.defaultOptions = defaultInspectOptions;
inspect.custom = Symbol.for('nodejs.util.inspect.custom');

// Inheritance

export function inherits(constructor: InheritableFunction, superConstructor: InheritableFunction): void {
    if (constructor === undefined || constructor === null) {
        throw new TypeError('The constructor to inherit from must be non-null');
    }

    if (superConstructor === undefined || superConstructor === null) {
        throw new TypeError('The super constructor to inherit from must be non-null');
    }

    if (typeof superConstructor !== 'function') {
        throw new TypeError('The super constructor must be a function');
    }

    Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
    Object.defineProperty(constructor, 'super_', {
        value: superConstructor,
        writable: false,
        configurable: false,
    });
}

// deprecate

export function deprecate<T extends AnyCallable>(fn: T, message: string, code?: string): T {
    let warned = false;

    const deprecated = function (this: ThisParameterType<T>, ...args: Parameters<T>): ReturnType<T> {
        if (!warned) {
            warned = true;
            if (code) {
                console.warn(`[${code}] DeprecationWarning: ${message}`);
            } else {
                console.warn(`DeprecationWarning: ${message}`);
            }
        }
        return Reflect.apply(fn, this, args) as ReturnType<T>;
    } as T;

    Object.defineProperty(deprecated, 'name', { value: fn.name });
    Object.defineProperty(deprecated, 'length', { value: fn.length });

    return deprecated;
}

// callbackify

export function callbackify<T, F extends (...args: never[]) => Promise<T>>(fn: F): (...args: unknown[]) => void {
    if (typeof fn !== 'function') {
        throw new TypeError('The "original" argument must be of type function');
    }

    return function (this: unknown, ...args: unknown[]) {
        const callback = args.pop();
        if (typeof callback !== 'function') {
            throw new TypeError('Callback must be a function');
        }

        Reflect.apply(fn, this, args).then(
            (result) => callback(null, result),
            (err) => {
                if (err) {
                    callback(err);
                    return;
                }
                const wrapped = Object.assign(new Error('Promise was rejected with falsy value'), {
                    code: 'ERR_FALSY_VALUE_REJECTION',
                    reason: err,
                });
                callback(wrapped);
            }
        );
    };
}

// promisify

export interface PromisifyInterface {
    __promisify__: AnyCallable;
}

const kCustomPromisifyArgs = Symbol.for('nodejs.util.promisify.customArgs');

export function promisify<T>(fn: AnyCallable): (...args: unknown[]) => Promise<T> {
    const customSymbol = Symbol.for('nodejs.util.promisify.custom');

    if (typeof fn !== 'function') {
        throw new TypeError('The "original" argument must be of type Function');
    }

    // Check for existing custom promisify implementation
    const custom = Reflect.get(fn, customSymbol);
    if (typeof custom === 'function') {
        return custom as (...args: unknown[]) => Promise<T>;
    }
    const legacyCustom = Reflect.get(fn, '__promisify__');
    if (typeof legacyCustom === 'function') {
        return legacyCustom as (...args: unknown[]) => Promise<T>;
    }

    // Multi-value callbacks (e.g. dns.lookup → { address, family })
    const argumentNames = Reflect.get(fn, kCustomPromisifyArgs) as string[] | undefined;

    const promisified = function(this: unknown, ...args: unknown[]) {
        return new Promise<T>((resolve, reject) => {
            Reflect.apply(fn, this, [...args, (err: Error | null, ...values: unknown[]) => {
                if (err) {
                    reject(err);
                    return;
                }
                if (argumentNames !== undefined && values.length > 1) {
                    const obj: Record<string, unknown> = {};
                    for (let i = 0; i < argumentNames.length; i++) {
                        obj[argumentNames[i]!] = values[i];
                    }
                    resolve(obj as T);
                    return;
                }
                resolve(values[0] as T);
            }]);
        });
    };

    // Copy the custom symbol if it exists on the original
    Object.defineProperty(promisified, customSymbol, {
        value: promisified,
        writable: false,
        enumerable: false,
        configurable: true,
    });

    return promisified;
}

promisify.custom = Symbol.for('nodejs.util.promisify.custom');
// Node documents this as util.promisify.customPromisifyArgs (legacy name on Symbol.for).
Reflect.set(promisify, 'customPromisifyArgs', kCustomPromisifyArgs);

// TextEncoder / TextDecoder

const { Encoder: NativeTextEncoder, Decoder: NativeTextDecoder } = import.meta.use('text');
export const TextEncoder = globalThis.TextEncoder ?? NativeTextEncoder;
export const TextDecoder = globalThis.TextDecoder ?? NativeTextDecoder;

// getSystemErrorMap / getSystemErrorName

export function getSystemErrorMap(): Map<number, [string, string]> {
    const errMod = import.meta.use('error');
    const map = new Map<number, [string, string]>();
    for (const [name, code] of Object.entries(errMod.errno)) {
        if (name === 'OK' || name === 'UNKNOWN') continue;
        if (typeof code !== 'number') continue;
        const message = errMod.strerror(code).replace(new RegExp(`^${name}:\\s*`), '');
        map.set(code, [name, message]);
    }
    return map;
}

function validateSystemErrorCode(err: unknown): number {
    if (typeof err !== 'number') {
        throw new TypeError('The "err" argument must be of type number');
    }
    if (!Number.isInteger(err) || err >= 0) {
        throw new RangeError(`The value of "err" is out of range. It must be a negative integer. Received ${err}`);
    }
    return err;
}

export function getSystemErrorName(err: number): string | undefined {
    const entry = getSystemErrorMap().get(validateSystemErrorCode(err));
    return entry?.[0];
}

export function getSystemErrorMessage(err: number): string | undefined {
    const entry = getSystemErrorMap().get(validateSystemErrorCode(err));
    return entry?.[1];
}

type ParseArgsOption = {
    type: 'string' | 'boolean';
    short?: string;
    multiple?: boolean;
    default?: string | boolean | Array<string | boolean>;
};

type ParseArgsToken =
    | { kind: 'option'; name: string; rawName: string; index: number; value?: string; inlineValue?: boolean }
    | { kind: 'positional'; index: number; value: string }
    | { kind: 'option-terminator'; index: number };

function parseArgsError(code: string, message: string): TypeError {
    return Object.assign(new TypeError(message), { code });
}

export function parseArgs(options: {
    args?: string[];
    options?: Record<string, ParseArgsOption>;
    strict?: boolean;
    allowPositionals?: boolean;
    allowNegative?: boolean;
    tokens?: boolean;
} = {}): { values: Record<string, unknown>; positionals: string[]; tokens?: ParseArgsToken[] } {
    const args = options.args ?? [];
    const defs = options.options ?? {};
    const strict = options.strict !== false;
    const allowPositionals = options.allowPositionals === true || !strict;
    const values: Record<string, unknown> = Object.create(null);
    const positionals: string[] = [];
    const tokens: ParseArgsToken[] = [];
    const shorts = new Map<string, string>();

    for (const [name, def] of Object.entries(defs)) {
        if (def.short) shorts.set(def.short, name);
        if ('default' in def) values[name] = Array.isArray(def.default) ? [...def.default] : def.default;
    }

    const pushPositional = (value: string, index: number) => {
        if (!allowPositionals) {
            throw parseArgsError('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
                `Unexpected argument '${value}'. This command does not take positional arguments`);
        }
        positionals.push(value);
        if (options.tokens) tokens.push({ kind: 'positional', index, value });
    };

    const setValue = (name: string, value: string | boolean) => {
        const def = defs[name];
        if (def?.multiple) {
            const current = values[name];
            const list: Array<string | boolean> = Array.isArray(current) ? current : [];
            list.push(value);
            values[name] = list;
            return;
        }
        values[name] = value;
    };

    const readOption = (name: string, rawName: string, index: number, inlineValue: string | undefined) => {
        const def = defs[name];
        if (!def && strict) {
            throw parseArgsError('ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option '${rawName}'`);
        }

        if (def?.type === 'string') {
            if (inlineValue !== undefined) {
                setValue(name, inlineValue);
                if (options.tokens) tokens.push({ kind: 'option', name, rawName, index, value: inlineValue, inlineValue: true });
                return;
            }
            const next = args[index + 1];
            if (next === undefined || (strict && next.startsWith('-'))) {
                if (!strict) {
                    setValue(name, true);
                    if (options.tokens) tokens.push({ kind: 'option', name, rawName, index });
                    return;
                }
                throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${rawName} <value>' argument missing`);
            }
            if (!strict && next.startsWith('-')) {
                setValue(name, true);
                if (options.tokens) tokens.push({ kind: 'option', name, rawName, index });
                return;
            }
            setValue(name, next);
            if (options.tokens) tokens.push({ kind: 'option', name, rawName, index, value: next, inlineValue: false });
            return 1;
        }

        if (def?.type === 'boolean') {
            if (inlineValue !== undefined) {
                if (strict) {
                    throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${rawName}' does not take an argument`);
                }
                setValue(name, inlineValue);
                if (options.tokens) tokens.push({ kind: 'option', name, rawName, index, value: inlineValue, inlineValue: true });
                return;
            }
            setValue(name, true);
            if (options.tokens) tokens.push({ kind: 'option', name, rawName, index });
            return;
        }

        setValue(name, inlineValue ?? true);
        if (options.tokens) {
            const token: ParseArgsToken = { kind: 'option', name, rawName, index };
            if (inlineValue !== undefined) {
                token.value = inlineValue;
                token.inlineValue = true;
            }
            tokens.push(token);
        }
    };

    for (let i = 0; i < args.length; i++) {
        const arg = String(args[i]);
        if (arg === '--') {
            if (options.tokens) tokens.push({ kind: 'option-terminator', index: i });
            for (let j = i + 1; j < args.length; j++) pushPositional(String(args[j]), j);
            break;
        }

        if (arg.startsWith('--') && arg.length > 2) {
            const body = arg.slice(2);
            const eq = body.indexOf('=');
            const rawName = eq === -1 ? arg : `--${body.slice(0, eq)}`;
            let name = eq === -1 ? body : body.slice(0, eq);
            const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
            if (options.allowNegative && name.startsWith('no-')) {
                const positive = name.slice(3);
                const def = defs[positive];
                if (def?.type === 'boolean') {
                    setValue(positive, false);
                    if (options.tokens) tokens.push({ kind: 'option', name: positive, rawName: arg, index: i });
                    continue;
                }
            }
            const consumed = readOption(name, rawName, i, inlineValue);
            if (consumed) i += consumed;
            continue;
        }

        if (arg.startsWith('-') && arg.length > 1) {
            const rawShort = arg.slice(1);
            const eq = rawShort.indexOf('=');
            const short = eq === -1 ? rawShort : rawShort.slice(0, eq);
            const name = shorts.get(short) ?? short;
            const rawName = eq === -1 ? arg : `-${short}`;
            const inlineValue = eq === -1 ? undefined : rawShort.slice(eq + 1);
            const consumed = readOption(name, rawName, i, inlineValue);
            if (consumed) i += consumed;
            continue;
        }

        pushPositional(arg, i);
    }

    const result: { values: Record<string, unknown>; positionals: string[]; tokens?: ParseArgsToken[] } = {
        values,
        positionals,
    };
    if (options.tokens) result.tokens = tokens;
    return result;
}

const MIME_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function assertMimeToken(kind: string, value: string): void {
    if (!MIME_TOKEN_RE.test(value)) {
        throw new TypeError(`Invalid MIME ${kind}: ${value}`);
    }
}

function assertMimeParamValue(value: string): void {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code === 0x0a || code === 0x0d) {
            throw new TypeError(`Invalid MIME parameter value: ${value}`);
        }
    }
}

function splitMimeSections(value: string): string[] {
    const sections: string[] = [];
    let start = 0;
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quoted && ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted && ch === ';') {
            sections.push(value.slice(start, i));
            start = i + 1;
        }
    }
    sections.push(value.slice(start));
    return sections;
}

function unquoteMimeParamValue(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (!trimmed.startsWith('"')) return /[\r\n]/.test(trimmed) ? undefined : trimmed;
    if (!trimmed.endsWith('"') || trimmed.length === 1) return undefined;
    let out = '';
    let escaped = false;
    for (let i = 1; i < trimmed.length - 1; i++) {
        const ch = trimmed[i];
        if (ch === undefined) continue;
        if (escaped) {
            out += ch;
            escaped = false;
        } else if (ch === '\\') {
            escaped = true;
        } else {
            out += ch;
        }
    }
    return /[\r\n]/.test(out) ? undefined : out;
}

function quoteMimeParamValue(value: string): string {
    if (value.length > 0 && MIME_TOKEN_RE.test(value)) return value;
    return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

export class MIMEParams {
    #map = new Map<string, string>();

    constructor(entries: Array<[string, string]> = []) {
        for (const [key, value] of entries) {
            const name = String(key).toLowerCase();
            if (this.#map.has(name)) continue;
            this.#map.set(name, String(value));
        }
    }

    get(key: string): string | null {
        if (arguments.length < 1) throw new TypeError('MIMEParams.get requires 1 argument');
        return this.#map.get(String(key).toLowerCase()) ?? null;
    }

    has(key: string): boolean {
        if (arguments.length < 1) throw new TypeError('MIMEParams.has requires 1 argument');
        return this.#map.has(String(key).toLowerCase());
    }

    set(key: string, value: string): void {
        if (arguments.length < 2) throw new TypeError('MIMEParams.set requires 2 arguments');
        const name = String(key).toLowerCase();
        assertMimeToken('parameter name', name);
        const next = String(value);
        assertMimeParamValue(next);
        this.#map.set(name, next);
    }

    delete(key: string): void {
        if (arguments.length < 1) throw new TypeError('MIMEParams.delete requires 1 argument');
        this.#map.delete(String(key).toLowerCase());
    }

    entries(): IterableIterator<[string, string]> {
        return this.#map.entries();
    }

    keys(): IterableIterator<string> {
        return this.#map.keys();
    }

    values(): IterableIterator<string> {
        return this.#map.values();
    }

    toString(): string {
        return [...this.#map]
            .map(([key, value]) => `${key}=${quoteMimeParamValue(value)}`)
            .join(';');
    }

    toJSON(): string {
        return this.toString();
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries();
    }
}

export class MIMEType {
    type: string;
    subtype: string;
    params: MIMEParams;

    constructor(value: string) {
        const [essence = '', ...rawParams] = splitMimeSections(String(value));
        const normalizedEssence = essence.trim();
        const slash = normalizedEssence.indexOf('/');
        if (slash <= 0 || slash !== normalizedEssence.lastIndexOf('/') || slash === normalizedEssence.length - 1) {
            throw new TypeError(`Invalid MIME type: ${value}`);
        }
        const type = normalizedEssence.slice(0, slash);
        const subtype = normalizedEssence.slice(slash + 1);
        assertMimeToken('type', type);
        assertMimeToken('subtype', subtype);
        this.type = type.toLowerCase();
        this.subtype = subtype.toLowerCase();
        const params: Array<[string, string]> = [];
        for (const param of rawParams) {
            const trimmed = param.trim();
            if (!trimmed) continue;
            const index = trimmed.indexOf('=');
            if (index === -1) continue;
            const name = trimmed.slice(0, index).trim().toLowerCase();
            if (!MIME_TOKEN_RE.test(name) || params.some(([key]) => key === name)) continue;
            const paramValue = unquoteMimeParamValue(trimmed.slice(index + 1));
            if (paramValue === undefined) continue;
            params.push([name, paramValue]);
        }
        this.params = new MIMEParams(params);
    }

    get essence(): string {
        return `${this.type}/${this.subtype}`;
    }

    toString(): string {
        const params = this.params.toString();
        return params ? `${this.essence};${params}` : this.essence;
    }
}

export function transferableAbortController(): AbortController {
    return new AbortController();
}

export function transferableAbortSignal(signal: AbortSignal): AbortSignal {
    return signal;
}

export function aborted(signal: AbortSignal, _resource: object): Promise<Event> {
    if (signal.aborted) {
        return Promise.resolve(new Event('abort'));
    }
    return new Promise<Event>((resolve) => {
        signal.addEventListener('abort', () => resolve(new Event('abort')), { once: true });
    });
}

// parseEnv — .env file parser (Node.js 20.12+)

/**
 * Parse `.env` file content into a key-value object.
 *
 * Supports:
 *   - `KEY=value` (unquoted, trimmed, inline `#` comments)
 *   - `KEY="double quoted"` (escape sequences: \n \r \t \\ \" \')
 *   - `KEY='single quoted'` (literal, no escapes)
 *   - Multi-line quoted values
 *   - Variable expansion: `KEY="${OTHER_KEY}suffix"` (double quotes only)
 *   - `#` comment lines and blank lines
 *   - `export KEY=value` prefix (ignored)
 *   - Later keys override earlier ones
 *   - Keys without `=` get empty string value
 *
 * @param content Raw `.env` file content
 * @returns Parsed key-value pairs
 */
export function parseEnv(content: string): NodeJS.Dict<string> {
    const env: NodeJS.Dict<string> = {};
    const lines = content.split('\n');
    let i = 0;

    while (i < lines.length) {
        let line = lines[i];

        // Skip blank lines and pure comment lines
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] === '#') {
            i++;
            continue;
        }

        // Strip optional `export` prefix
        if (trimmed.startsWith('export ')) {
            line = trimmed.slice(7);
        } else {
            line = trimmed;
        }

        // Find the first `=`
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) {
            // Bare key with no value — treat as empty string
            const key = line.trim();
            if (key && key[0] !== '#') env[key] = '';
            i++;
            continue;
        }

        const key = line.slice(0, eqIdx).trim();
        if (!key) {
            i++;
            continue;
        }

        let value: string;
        const rest = line.slice(eqIdx + 1);

        if (rest.length > 0 && (rest[0] === '"' || rest[0] === "'")) {
            // Quoted value — may span multiple lines
            const quote = rest[0];
            const result = parseQuotedValue(lines, i, quote, env);
            value = result.value;
            i = result.nextLine;
        } else {
            // Unquoted value — trim and strip inline comments
            value = rest.trim();
            const commentIdx = findInlineComment(value);
            if (commentIdx !== -1) value = value.slice(0, commentIdx).trimEnd();
            i++;
        }

        env[key] = value;
    }

    return env;
}

/** Parse a single- or double-quoted value, potentially spanning multiple lines. */
function parseQuotedValue(
    lines: string[], startLine: number, quote: string, env: NodeJS.Dict<string>,
): { value: string; nextLine: number } {
    const firstLine = lines[startLine];
    const afterQuote = firstLine.slice(firstLine.indexOf(quote) + 1);

    // Check for closing quote on the same line
    const closeIdx = findClosingQuote(afterQuote, quote);
    if (closeIdx !== -1) {
        const raw = afterQuote.slice(0, closeIdx);
        return {
            value: quote === '"' ? processDoubleQuoted(raw, env) : raw,
            nextLine: startLine + 1,
        };
    }

    // Multi-line: collect until closing quote
    const parts: string[] = [afterQuote];
    let lineIdx = startLine + 1;
    while (lineIdx < lines.length) {
        const ln = lines[lineIdx];
        const ci = findClosingQuote(ln, quote);
        if (ci !== -1) {
            parts.push(ln.slice(0, ci));
            const raw = parts.join('\n');
            return {
                value: quote === '"' ? processDoubleQuoted(raw, env) : raw,
                nextLine: lineIdx + 1,
            };
        }
        parts.push(ln);
        lineIdx++;
    }
    // Unterminated quote — use everything
    const raw = parts.join('\n');
    return {
        value: quote === '"' ? processDoubleQuoted(raw, env) : raw,
        nextLine: lineIdx,
    };
}

/** Find the index of a closing quote not preceded by an odd number of backslashes. */
function findClosingQuote(s: string, quote: string): number {
    for (let j = 0; j < s.length; j++) {
        if (s[j] === quote) {
            // Count preceding backslashes
            let bs = 0;
            for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) bs++;
            if (bs % 2 === 0) return j;
        }
        // For single quotes, no escape processing — first quote closes
        if (quote === "'" && s[j] === quote) return j;
    }
    return -1;
}

/** Process escape sequences and ${VAR} expansion in double-quoted values. */
function processDoubleQuoted(raw: string, env: NodeJS.Dict<string>): string {
    let out = '';
    for (let j = 0; j < raw.length; j++) {
        if (raw[j] === '\\' && j + 1 < raw.length) {
            const next = raw[j + 1];
            switch (next) {
                case 'n': out += '\n'; j++; break;
                case 'r': out += '\r'; j++; break;
                case 't': out += '\t'; j++; break;
                case '\\': out += '\\'; j++; break;
                case '"': out += '"'; j++; break;
                case "'": out += "'"; j++; break;
                default: out += raw[j]; break;
            }
        } else if (raw[j] === '$' && j + 1 < raw.length && raw[j + 1] === '{') {
            // ${VAR} expansion
            const closeBrace = raw.indexOf('}', j + 2);
            if (closeBrace !== -1) {
                const varName = raw.slice(j + 2, closeBrace);
                const expanded = env[varName] ?? readEnv(varName) ?? '';
                out += expanded;
                j = closeBrace;
            } else {
                out += raw[j];
            }
        } else {
            out += raw[j];
        }
    }
    return out;
}

/** Find the position of an inline `#` comment (not inside quotes). */
function findInlineComment(s: string): number {
    let inQuote = false;
    let quoteChar = '';
    for (let j = 0; j < s.length; j++) {
        if (inQuote) {
            if (s[j] === quoteChar && (quoteChar !== '"' || s[j - 1] !== '\\')) {
                inQuote = false;
            }
        } else {
            if (s[j] === '"' || s[j] === "'") {
                inQuote = true;
                quoteChar = s[j];
            } else if (s[j] === '#') {
                return j;
            }
        }
    }
    return -1;
}

export default {
    types,
    isBoolean,
    isNull,
    isNullOrUndefined,
    isNumber,
    isString,
    isSymbol,
    isUndefined,
    isObject,
    isError,
    isFunction,
    isRegExp,
    isArray,
    isDate,
    isPrimitive,
    isBuffer,
    format,
    formatWithOptions,
    stripVTControlCharacters,
    styleText,
    debuglog,
    debug,
    toUSVString,
    isDeepStrictEqual,
    inspect,
    inherits,
    deprecate,
    callbackify,
    promisify,
    TextEncoder,
    TextDecoder,
    getSystemErrorMap,
    getSystemErrorName,
    getSystemErrorMessage,
    parseArgs,
    MIMEParams,
    MIMEType,
    transferableAbortController,
    transferableAbortSignal,
    aborted,
    parseEnv,
};
