/**
 * Node.js util module
 * Utility functions
 */

const console = import.meta.use('console');
const os = import.meta.use('os');
import * as types from './types';
export { types };

// ============================================================================
// Type checks
// ============================================================================

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

export function isFunction(value: unknown): value is Function {
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

// ============================================================================
// Formatting
// ============================================================================

export function format(format?: string, ...args: any[]): string {
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
                    result += Number(args[argIndex++]);
                    break;
                case 'i':
                    result += Math.floor(Number(args[argIndex++]));
                    break;
                case 'f':
                    result += parseFloat(args[argIndex++]);
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
                    result += inspect(args[argIndex++], { depth: specifier === 'O' ? Infinity : 4 });
                    break;
                case '%':
                    result += '%';
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

export function formatWithOptions(inspectOptions: InspectOptions, format?: any, ...args: any[]): string {
    if (!format) {
        return '';
    }
    // Use the first arg as the format object, remaining args for %s/%d/%j/%o substitution
    const result = console.inspect(format, {
        colors: inspectOptions.colors,
        depth: inspectOptions.depth ?? undefined,
        showHidden: inspectOptions.showHidden,
        maxArrayLength: inspectOptions.maxArrayLength,
        maxStringLength: inspectOptions.maxStringLength,
        breakLength: inspectOptions.breakLength,
        compact: inspectOptions.compact,
        sorted: inspectOptions.sorted,
    });
    // Append remaining arguments (format substitution)
    if (args.length > 0) {
        return result + ' ' + args.map(a => inspect(a, inspectOptions)).join(' ');
    }
    return result;
}

// ============================================================================
// VT control characters
// ============================================================================

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

function sameValueZero(a: unknown, b: unknown): boolean {
    return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

function deepEqual(a: unknown, b: unknown, strict: boolean, seen = new WeakMap<object, object>()): boolean {
    if (sameValueZero(a, b)) return true;
    if (!strict && a == b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object' || a === null || b === null) return false;

    if (seen.get(a as object) === b) return true;
    seen.set(a as object, b as object);

    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
        const av = new Uint8Array(a);
        const bv = new Uint8Array(b);
        if (av.length !== bv.length) return false;
        for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
        return true;
    }
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
        const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        if (av.length !== bv.length) return false;
        for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
        return true;
    }
    if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false;
        for (const [key, value] of a) {
            if (!b.has(key)) return false;
            if (!deepEqual(value, b.get(key), strict, seen)) return false;
        }
        return true;
    }
    if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false;
        for (const value of a) if (!b.has(value)) return false;
        return true;
    }

    const aKeys = Reflect.ownKeys(a);
    const bKeys = Reflect.ownKeys(b!);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!bKeys.includes(key)) return false;
        if (!deepEqual((a as any)[key], (b as any)[key], strict, seen)) return false;
    }
    return true;
}

export function styleText(format: string | string[], text: string, options?: { validateStream?: boolean }): string {
    const formats = Array.isArray(format) ? format : [format];
    const validate = options?.validateStream !== false;
    if (validate) {
        try {
            if (os.guessHandle(os.STDOUT_FILENO) !== 'tty') return text;
        } catch {}
    }
    let out = text;
    for (let i = formats.length - 1; i >= 0; i--) {
        const name = formats[i]!;
        const open = ANSI_STYLE_OPEN[name];
        const close = ANSI_STYLE_CLOSE[name];
        if (open && close) out = `${open}${out}${close}`;
    }
    return out;
}

export function debuglog(section: string, callback?: (fn: (...args: any[]) => void) => void): (...args: any[]) => void {
    const raw = String(os.getenv?.('NODE_DEBUG') ?? os.getenv?.('DEBUG') ?? '');
    const enabled = raw.split(/[,\s]+/).some(part => part && (part === '*' || part.toLowerCase() === section.toLowerCase()));
    const logger = (...args: any[]) => {
        if (!enabled) return;
        console.error(`${section.toUpperCase()} ${format(...args)}`);
    };
    if (callback) callback(logger);
    return logger;
}

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
    return deepEqual(a, b, true);
}

// ============================================================================
// inspect
// ============================================================================

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
    return formatWithOptions(options ?? defaultInspectOptions, object);
}

inspect.defaultOptions = defaultInspectOptions;
inspect.custom = Symbol.for('nodejs.util.inspect.custom');

// ============================================================================
// Inheritance
// ============================================================================

export function inherits(constructor: Function, superConstructor: Function): void {
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

// ============================================================================
// deprecate
// ============================================================================

export function deprecate<T extends Function>(fn: T, message: string, code?: string): T {
    let warned = false;

    const deprecated = function (this: any, ...args: any[]) {
        if (!warned) {
            warned = true;
            if (code) {
                console.warn(`[${code}] DeprecationWarning: ${message}`);
            } else {
                console.warn(`DeprecationWarning: ${message}`);
            }
        }
        return fn.apply(this, args);
    } as any;

    Object.defineProperty(deprecated, 'name', { value: fn.name });
    Object.defineProperty(deprecated, 'length', { value: fn.length });

    return deprecated;
}

// ============================================================================
// callbackify
// ============================================================================

export function callbackify<T>(fn: (...args: any[]) => Promise<T>): (...args: any[]) => void {
    return function (this: any, ...args: any[]) {
        const callback = args.pop();
        if (typeof callback !== 'function') {
            throw new TypeError('Callback must be a function');
        }

        fn.apply(this, args).then(
            (result) => callback(null, result),
            (err) => callback(err)
        );
    };
}

// ============================================================================
// promisify
// ============================================================================

export interface PromisifyInterface {
    __promisify__: Function;
}

export function promisify<T>(fn: Function): (...args: any[]) => Promise<T> {
    const customSymbol = Symbol.for('nodejs.util.promisify.custom');

    // Check for existing custom promisify implementation
    if ((fn as any)[customSymbol]) {
        return (fn as any)[customSymbol];
    }

    const promisified = (...args: any[]) => {
        return new Promise<T>((resolve, reject) => {
            fn(...args, (err: Error | null, result: T) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            });
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

// ============================================================================
// TextEncoder / TextDecoder
// ============================================================================

const { Encoder, Decoder } = import.meta.use('text')!;
export const TextEncoder = Encoder;
export const TextDecoder = Decoder;

// ============================================================================
// getSystemErrorMap / getSystemErrorName
// ============================================================================

export function getSystemErrorMap(): Map<number, [string, string]> {
    const errMod = import.meta.use('error');
    const map = new Map<number, [string, string]>();
    for (const [name, code] of Object.entries(errMod.errno)) {
        if (name === 'OK' || name === 'UNKNOWN') continue;
        map.set(code as number, [name, errMod.strerror(code as number)]);
    }
    return map;
}

export function getSystemErrorName(err: number): string {
    const entry = getSystemErrorMap().get(err);
    return entry ? entry[0] : `Unknown system error ${err}`;
}

export function getSystemErrorMessage(err: number): string {
    const entry = getSystemErrorMap().get(err);
    return entry ? entry[1] : `Unknown system error ${err}`;
}
