/**
 * Node.js util module
 * Utility functions
 */

const console = import.meta.use('console');
const os = import.meta.use('os');
import * as types from './types';
export { types };
import { deepEqual as _deepEqual } from '../_internal/deep-equal';
import { parseNodeEnv } from '../_internal/dotenv';

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

export function format(first?: unknown, ...args: unknown[]): string {
    if (arguments.length === 0) return '';
    return formatWithOptionsInternal(undefined, [first, ...args]);
}

export function formatWithOptions(inspectOptions: InspectOptions, first?: unknown, ...args: unknown[]): string {
    if (typeof inspectOptions !== 'object' || inspectOptions === null) {
        throw new TypeError('The "inspectOptions" argument must be of type object.');
    }
    if (arguments.length === 1) return '';
    return formatWithOptionsInternal(inspectOptions, [first, ...args]);
}

function formatWithOptionsInternal(inspectOptions: InspectOptions | undefined, args: unknown[]): string {
    const opts = inspectOptions ?? {};
    const first = args[0];
    let a = 0;
    let str = '';
    let join = '';

    if (typeof first === 'string') {
        if (args.length === 1) return first;
        let tempStr: string;
        let lastPos = 0;

        for (let i = 0; i < first.length - 1; i++) {
            if (first.charCodeAt(i) === 37) { // '%'
                const nextChar = first.charCodeAt(++i);
                if (a + 1 !== args.length) {
                    switch (nextChar) {
                        case 115: { // 's'
                            const tempArg = args[++a];
                            if (typeof tempArg === 'number') {
                                tempStr = formatNumberNoColor(tempArg, opts);
                            } else if (typeof tempArg === 'bigint') {
                                tempStr = formatBigIntNoColor(tempArg, opts);
                            } else if (
                                typeof tempArg !== 'object' || tempArg === null || !hasBuiltInToString(tempArg)
                            ) {
                                tempStr = String(tempArg);
                            } else {
                                tempStr = inspect(tempArg, { ...opts, depth: 0, colors: false, compact: 3 });
                            }
                            break;
                        }
                        case 106: // 'j'
                            tempStr = tryStringify(args[++a]);
                            break;
                        case 100: { // 'd'
                            const tempNum = args[++a];
                            if (typeof tempNum === 'bigint') tempStr = formatBigIntNoColor(tempNum, opts);
                            else if (typeof tempNum === 'symbol') tempStr = 'NaN';
                            else tempStr = formatNumberNoColor(Number(tempNum), opts);
                            break;
                        }
                        case 79: // 'O'
                            tempStr = inspect(args[++a], opts);
                            break;
                        case 111: // 'o'
                            tempStr = inspect(args[++a], {
                                ...opts,
                                showHidden: true,
                                showProxy: true,
                                depth: 4,
                            });
                            break;
                        case 105: { // 'i'
                            const tempInteger = args[++a];
                            if (typeof tempInteger === 'bigint') tempStr = formatBigIntNoColor(tempInteger, opts);
                            else if (typeof tempInteger === 'symbol') tempStr = 'NaN';
                            // No radix: Node uses Number.parseInt, so '0x10' is 16.
                            else tempStr = formatNumberNoColor(parseInt(tempInteger as string), opts);
                            break;
                        }
                        case 102: { // 'f'
                            const tempFloat = args[++a];
                            if (typeof tempFloat === 'symbol') tempStr = 'NaN';
                            else tempStr = formatNumberNoColor(parseFloat(tempFloat as string), opts);
                            break;
                        }
                        case 99: // 'c'
                            a += 1;
                            tempStr = '';
                            break;
                        case 37: // '%'
                            str += first.slice(lastPos, i);
                            lastPos = i + 1;
                            continue;
                        default:
                            continue;
                    }
                    if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
                    str += tempStr;
                    lastPos = i + 1;
                } else if (nextChar === 37) {
                    str += first.slice(lastPos, i);
                    lastPos = i + 1;
                }
            }
        }
        if (lastPos !== 0) {
            a++;
            join = ' ';
            if (lastPos < first.length) str += first.slice(lastPos);
        }
    }

    while (a < args.length) {
        const value = args[a];
        str += join;
        str += typeof value !== 'string' ? inspect(value, opts) : value;
        join = ' ';
        a++;
    }
    return str;
}

function tryStringify(arg: unknown): string {
    try {
        const res = JSON.stringify(arg);
        return res === undefined ? 'undefined' : res;
    } catch (err) {
        if (err instanceof TypeError && /circular|cyclic/i.test(err.message)) {
            return '[Circular]';
        }
        throw err;
    }
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
    if (typeof text !== 'string') {
        throw invalidArgType('text', 'string', text);
    }
    const formats = Array.isArray(format) ? format : [format];
    const validate = options?.validateStream !== false;
    let skipColorize = false;
    if (validate) {
        try {
            skipColorize = os.guessHandle(os.STDOUT_FILENO) !== 'tty';
        } catch {}
    }

    // Opens accumulate in order; closes are prepended so they unwind in
    // reverse, which is what Node emits for a multi-style array.
    let openCodes = '';
    let closeCodes = '';
    for (const name of formats) {
        if (name === 'none') continue;
        const open = ANSI_STYLE_OPEN[name as string];
        const close = ANSI_STYLE_CLOSE[name as string];
        if (open === undefined || close === undefined) {
            const err = new TypeError(
                `The argument 'format' must be one of: ${Object.keys(ANSI_STYLE_OPEN).join(', ')}. Received ${JSON.stringify(name)}`,
            ) as TypeError & { code?: string };
            err.code = 'ERR_INVALID_ARG_VALUE';
            throw err;
        }
        openCodes += open;
        closeCodes = close + closeCodes;
    }
    if (skipColorize) return text;
    return `${openCodes}${text}${closeCodes}`;
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

export type { InspectOptions } from './inspect';
export { inspect } from './inspect';
// Myers line diff + assert's inspect option set. `assert` imports these to build
// Node-style `+ actual` / `- expected` messages; in Node this machinery also
// lives under util (internal/util/diff).
export {
    diff,
    inspectDiff,
    inspectForAssert,
    kOperations,
    myersDiff,
    printMyersDiff,
} from './diff';
export type { DiffEntry, DiffOperation } from './diff';
import { inspect, defaultInspectOptions, formatNumberNoColor, formatBigIntNoColor, hasBuiltInToString } from './inspect';
import type { InspectOptions } from './inspect';

// Inheritance

export function inherits(constructor: InheritableFunction, superConstructor: InheritableFunction): void {
    if (constructor === undefined || constructor === null) {
        throw invalidArgType('ctor', 'function', constructor);
    }

    if (superConstructor === undefined || superConstructor === null) {
        throw invalidArgType('superCtor', 'function', superConstructor);
    }

    if (typeof superConstructor !== 'function') {
        throw invalidArgType('superCtor', 'function', superConstructor);
    }

    if (superConstructor.prototype === undefined) {
        throw invalidArgType('superCtor.prototype', 'object', superConstructor.prototype);
    }

    Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
    // Node leaves super_ writable and configurable; locking it makes a second
    // inherits() call on the same constructor throw.
    Object.defineProperty(constructor, 'super_', {
        value: superConstructor,
        writable: true,
        enumerable: false,
        configurable: true,
    });
}

// deprecate

export function deprecate<T extends AnyCallable>(fn: T, message: string, code?: string): T {
    let warned = false;

    const deprecated = function (this: ThisParameterType<T>, ...args: Parameters<T>): ReturnType<T> {
        // Read the global lazily: a static `../process` import from util would cycle.
        const proc = (globalThis as { process?: object }).process;
        // Node checks noDeprecation SYNCHRONOUSLY here, before emitWarning, and does
        // NOT consume the once-flag when suppressed — a later call with the flag
        // cleared still warns. Verified against v24.18 (emitWarning spy 0 then 1).
        const suppressed = proc !== undefined && proc !== null &&
            Boolean(Reflect.get(proc, 'noDeprecation'));
        if (!warned && !suppressed) {
            warned = true;
            // Routing through process.emitWarning is what makes process.on('warning')
            // fire and what gives the warning its DeprecationWarning name/code.
            // A bare console.warn bypasses both.
            const emit = proc === undefined || proc === null
                ? undefined
                : (Reflect.get(proc, 'emitWarning') as unknown);
            if (typeof emit === 'function') {
                Reflect.apply(emit as (...a: unknown[]) => unknown, proc as object, [
                    message,
                    code === undefined
                        ? { type: 'DeprecationWarning' }
                        : { type: 'DeprecationWarning', code },
                ]);
            } else if (code !== undefined) {
                console.warn(`[${code}] DeprecationWarning: ${message}`);
            } else {
                console.warn(`DeprecationWarning: ${message}`);
            }
        }
        return Reflect.apply(fn, this, args) as ReturnType<T>;
    } as T;

    // Wrapping a constructor must keep its prototype, or `new wrapped()` yields an
    // object that is not `instanceof` the original and has none of its methods.
    const proto = (fn as unknown as { prototype?: unknown }).prototype;
    if (proto !== undefined && proto !== null) {
        try {
            (deprecated as unknown as { prototype: unknown }).prototype = proto;
        } catch { /* a frozen wrapper cannot carry the prototype; keep the wrapper usable */ }
    }

    Object.defineProperty(deprecated, 'name', { value: 'deprecated' });
    Object.defineProperty(deprecated, 'length', { value: fn.length });

    return deprecated;
}

// callbackify

export function callbackify<T, F extends (...args: never[]) => Promise<T>>(fn: F): (...args: unknown[]) => void {
    if (typeof fn !== 'function') {
        throw invalidArgType('original', 'function', fn);
    }

    return function (this: unknown, ...args: unknown[]) {
        const callback = args.pop();
        if (typeof callback !== 'function') {
            throw new TypeError('Callback must be a function');
        }

        (Reflect.apply(fn, this, args) as Promise<T>).then(
            (result: T) => callback(null, result),
            (err: unknown) => {
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

interface PromisifyInterface {
    __promisify__: AnyCallable;
}

const kCustomPromisifyArgs = Symbol.for('nodejs.util.promisify.customArgs');

/** Node tags these argument-validation failures with a `code`; callers match on it. */
function invalidArgType(name: string, expected: string, actual: unknown): TypeError {
    const err = new TypeError(
        `The "${name}" argument must be of type ${expected}. Received ${typeof actual}`,
    ) as TypeError & { code?: string };
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
}

export function promisify<T>(fn: AnyCallable): (...args: unknown[]) => Promise<T> {
    const customSymbol = Symbol.for('nodejs.util.promisify.custom');

    if (typeof fn !== 'function') {
        throw invalidArgType('original', 'function', fn);
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

    // Inherit the original's prototype, then copy every own descriptor so
    // `name`, `length` and any attached metadata survive promisification.
    Object.setPrototypeOf(promisified, Object.getPrototypeOf(fn));

    Object.defineProperty(promisified, customSymbol, {
        value: promisified,
        writable: false,
        enumerable: false,
        configurable: true,
    });

    return Object.defineProperties(
        promisified,
        Object.getOwnPropertyDescriptors(fn),
    ) as (...args: unknown[]) => Promise<T>;
}

promisify.custom = Symbol.for('nodejs.util.promisify.custom');
// Node documents this as util.promisify.customPromisifyArgs (legacy name on Symbol.for).
Reflect.set(promisify, 'customPromisifyArgs', kCustomPromisifyArgs);

// TextEncoder / TextDecoder

const { Encoder: NativeTextEncoder, Decoder: NativeTextDecoder } = import.meta.use('text');
export const TextEncoder = globalThis.TextEncoder ?? NativeTextEncoder;
export const TextDecoder = globalThis.TextDecoder ?? NativeTextDecoder;

// getSystemErrorMap / getSystemErrorName

/** Deprecated in Node but still shipped, and still called by older npm packages. */
export function _extend(target: Record<PropertyKey, unknown>, source: unknown): Record<PropertyKey, unknown> {
    if (source === null || typeof source !== 'object') return target;
    const keys = Object.keys(source);
    for (let i = 0; i < keys.length; i++) {
        target[keys[i]!] = (source as Record<string, unknown>)[keys[i]!];
    }
    return target;
}

export function getSystemErrorMap(): Map<number, [string, string]> {
    const errMod = import.meta.use('error');
    const map = new Map<number, [string, string]>();
    for (const [name, code] of Object.entries(errMod.errno)) {
        // Node keeps UNKNOWN (-4094) in the map; only OK (0) is absent.
        if (name === 'OK') continue;
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

export function getSystemErrorName(err: number): string {
    const entry = getSystemErrorMap().get(validateSystemErrorCode(err));
    // Node never returns undefined here — unmapped codes get a synthetic name.
    return entry ? entry[0] : `Unknown system error ${err}`;
}

export function getSystemErrorMessage(err: number): string {
    const entry = getSystemErrorMap().get(validateSystemErrorCode(err));
    // Matches libuv's uv_strerror fallback, which Node surfaces verbatim.
    return entry ? entry[1] : `Unknown system error ${err}`;
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
            const firstShort = arg.charAt(1);
            // Node applies no '=' splitting to short options: `-a=1` with a
            // string type yields the value "=1".
            if (arg.length > 2) {
                const firstName = shorts.get(firstShort) ?? firstShort;
                if (defs[firstName]?.type === 'string') {
                    // `-fVALUE`
                    const consumed = readOption(firstName, `-${firstShort}`, i, arg.slice(2));
                    if (consumed) i += consumed;
                    continue;
                }
                // Short group: expand `-abc` to `-a -b -c`, stopping at a
                // string-typed option, whose remainder becomes its value.
                let stop = false;
                for (let k = 1; k < arg.length && !stop; k++) {
                    const ch = arg.charAt(k);
                    const chName = shorts.get(ch) ?? ch;
                    if (defs[chName]?.type === 'string' && k !== arg.length - 1) {
                        readOption(chName, `-${ch}`, i, arg.slice(k + 1));
                        stop = true;
                    } else {
                        readOption(chName, `-${ch}`, i, undefined);
                    }
                }
                continue;
            }
            const name = shorts.get(firstShort) ?? firstShort;
            const consumed = readOption(name, arg, i, undefined);
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

export function parseEnv(content: string): NodeJS.Dict<string> {
    return parseNodeEnv(content);
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
    _extend,
    parseArgs,
    MIMEParams,
    MIMEType,
    transferableAbortController,
    transferableAbortSignal,
    aborted,
    parseEnv,
};

// `export type` (not `export interface`) so `export * from './mod'`
// cannot materialise these as undefined runtime exports.
export type {
    PromisifyInterface,
};
