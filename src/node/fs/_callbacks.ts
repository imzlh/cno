/**
 * The one argument parser behind the fs callback APIs in callbacks.ts.
 *
 * Validation order is Node's: a non-object options value throws synchronously
 * before the callback is looked at, then a non-function callback throws.
 */
import { toSyncErrnoException, toAsyncFsErrnoException } from './errno-fix';

export type Callback = (...args: any[]) => void;

/**
 * A positional parameter.
 * - `default`: used when the argument list ends before this parameter.
 * - `ref`: the parameter a string options value is spelled as
 *   (`fs.readdir(p, 'utf8', cb)`); such a call never reaches the options slot.
 * - `rest`: collects the remaining positional arguments.
 */
export interface ArgSpec {
    name: string;
    default?: unknown;
    ref?: boolean;
    rest?: boolean;
}

export interface CallSpec {
    method: string;
    positional: readonly ArgSpec[];
    /** A trailing options value, passed to the implementation as the last argument. */
    options?: boolean;
    syscall?: string;
    /** The syscall path; `max` is the highest positional argument supplied (-1 for none). */
    path?: (call: Readonly<Record<string, any>>, max: number) => string;
    dest?: (call: Readonly<Record<string, any>>, max: number) => string;
}

/**
 * Positional values by name, then `options`. Deliberately `any`: `mode` stays
 * whatever the caller passed, for `modeToNumber` and `parseFlags` to coerce.
 */
export interface Call {
    [name: string]: any;
    options: any;
}

interface Parsed {
    callback: Callback;
    values: unknown[];
    options: unknown;
    max: number;
}

function namedCount(spec: CallSpec): number {
    return spec.positional.filter(arg => !arg.rest).length;
}

/** Arguments that must be present before a trailing function is the callback. */
function requiredCount(spec: CallSpec): number {
    const first = spec.positional.findIndex(arg => Object.hasOwn(arg, 'default'));
    return first === -1 ? namedCount(spec) : first;
}

function split(spec: CallSpec, args: readonly unknown[]): { supplied: readonly unknown[]; callback: unknown } {
    return args.length > requiredCount(spec) && typeof args[args.length - 1] === 'function'
        ? { supplied: args.slice(0, -1), callback: args[args.length - 1] }
        : { supplied: args, callback: undefined };
}

function parse(spec: CallSpec, args: readonly unknown[]): Parsed {
    const { supplied, callback } = split(spec, args);
    const count = namedCount(spec);
    // Only an API with an options slot reads the slot before the callback; a
    // string options value is the encoding and stays positional.
    if (spec.options && typeof supplied[count] !== 'string' && (callback !== undefined || supplied.length > count)
        && (typeof supplied[count] !== 'object' || supplied[count] === null)) {
        throw new TypeError('The "options" argument must be of type object');
    }
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }
    const reached = Math.min(supplied.length, count);
    const values: unknown[] = [];
    for (let index = 0; index < count; index++) {
        const arg = spec.positional[index];
        values.push(index < reached ? supplied[index] : Object.hasOwn(arg, 'default') ? arg.default : undefined);
    }
    const rest = spec.positional.findIndex(arg => arg.rest);
    if (rest !== -1) values.push(...supplied.slice(count));
    const options = spec.options && supplied.length > count ? supplied[count] : undefined;
    if (spec.options) values.push(options);
    return { callback: callback as Callback, values, options, max: reached - 1 };
}

function shape(spec: CallSpec, parsed: Parsed): Call {
    const out: Call = { options: parsed.options };
    const positional = spec.positional.filter(arg => !arg.rest);
    for (let index = 0; index < positional.length; index++) {
        const arg = positional[index];
        out[arg.name] = index <= parsed.max ? parsed.values[index] : arg.ref ? parsed.options : undefined;
    }
    const restArg = spec.positional.find(arg => arg.rest);
    if (restArg) out[restArg.name] = parsed.values.slice(positional.length);
    return out;
}

function failure(spec: CallSpec, call: Call, max: number, err: unknown, sync: boolean): NodeJS.ErrnoException {
    const syscall = spec.syscall ?? spec.method;
    const path = spec.path ? spec.path(call, max) : undefined;
    return sync ? toSyncErrnoException(err, syscall, path) : toAsyncFsErrnoException(err, syscall, path);
}

/**
 * Runs `impl` on the next microtask. A throw from `impl` is reported to the
 * callback, not thrown to the caller.
 */
export function invokeSync<T>(spec: CallSpec, args: readonly unknown[], callback: unknown, impl: (call: Call) => T): void {
    const parsed = parse(spec, args);
    const call = shape(spec, parsed);
    queueMicrotask(() => {
        let value: T;
        try {
            value = impl(call);
        } catch (err) {
            parsed.callback(failure(spec, call, parsed.max, err, true));
            return;
        }
        parsed.callback(null, value, call);
    });
}

export function invokeAsync<T>(spec: CallSpec, args: readonly unknown[], callback: unknown, impl: (call: Call) => Promise<T>): void {
    const parsed = parse(spec, args);
    const call = shape(spec, parsed);
    let pending: Promise<T>;
    try {
        pending = impl(call);
    } catch (err) {
        queueMicrotask(() => parsed.callback(failure(spec, call, parsed.max, err, false)));
        return;
    }
    pending.then(
        value => parsed.callback(null, value, call),
        err => parsed.callback(failure(spec, call, parsed.max, err, false)),
    );
}
