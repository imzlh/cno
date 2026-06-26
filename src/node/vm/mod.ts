/**
 * Node.js vm module
 * Uses engine.Sandbox and mirrors a host context object in and out.
 */

const engine = import.meta.use('engine');

export interface Context {
    [key: string]: any;
}

export interface RunningScriptOptions {
    filename?: string;
    lineOffset?: number;
    columnOffset?: number;
    cachedData?: Buffer;
    produceCachedData?: boolean;
    importModuleDynamically?: Function;
}

export interface ScriptOptions extends RunningScriptOptions {
    contextExtensions?: Object[];
}

interface ContextState {
    sandbox: InstanceType<typeof engine.Sandbox>;
    mirroredKeys: Set<string | symbol>;
    baselineKeys: Set<string | symbol>;
}

const _contextMap = new WeakMap<Context, ContextState>();
const RESERVED_GLOBAL_KEYS = new Set<PropertyKey>([
    'global',
    'self',
    'window',
    "globalThis",

    "parseFloat",
    "parseInt",
    "isNaN",
    "isFinite",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "unescape",

    "NaN",
    "Infinity",
    "undefined",

    "Object",
    "Function",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "InternalError",
    "AggregateError",
    "SuppressedError",

    "Math",
    "Reflect",
    "Iterator",
    "GeneratorFunction",
    "DisposableStack"
]);

function getContextState(context: Context): ContextState {
    const state = _contextMap.get(context);
    if (!state) throw new TypeError('Context was not created by vm.createContext()');
    return state;
}

function copyIn(contextObject: Context, scope: Context, state: ContextState): void {
    const currentKeys = new Set(Reflect.ownKeys(contextObject));

    for (const key of Reflect.ownKeys(scope)) {
        if (!currentKeys.has(key) && !state.baselineKeys.has(key) && !RESERVED_GLOBAL_KEYS.has(key)) {
            Reflect.deleteProperty(scope, key);
        }
    }

    for (const key of Reflect.ownKeys(contextObject)) {
        if (RESERVED_GLOBAL_KEYS.has(key)) continue;
        const desc = Object.getOwnPropertyDescriptor(contextObject, key);
        if (!desc) continue;
        if ('value' in desc) {
            Reflect.set(scope, key, desc.value);
        } else if (typeof desc.get === 'function') {
            Reflect.set(scope, key, Reflect.get(contextObject, key));
        }
    }
}

function copyOut(contextObject: Context, state: ContextState): void {
    const scope = state.sandbox.global as Context;
    const currentKeys = new Set(Reflect.ownKeys(scope));

    for (const key of state.mirroredKeys) {
        if (!currentKeys.has(key) && !state.baselineKeys.has(key)) {
            Reflect.deleteProperty(contextObject, key);
        }
    }

    for (const key of currentKeys) {
        if (state.baselineKeys.has(key)) continue;
        const value = Reflect.get(scope, key);
        Reflect.set(contextObject, key, value);
    }

    state.mirroredKeys = new Set([...currentKeys].filter((key) => !state.baselineKeys.has(key)));
}

function buildFunctionExpression(code: string, params: string[]): string {
    const args = params.join(', ');
    return `(function(${args}) {\n${code}\n})`;
}

export class Script {
    private _code: string;
    private _filename: string;

    constructor(code: string, options?: ScriptOptions) {
        this._code = code;
        this._filename = options?.filename ?? 'vm.js';
    }

    runInThisContext(_options?: RunningScriptOptions): any {
        return (0, eval)(this._code);
    }

    runInNewContext(contextObject?: Context, options?: RunningScriptOptions): any {
        const ctx = createContext(contextObject);
        return this.runInContext(ctx, options);
    }

    runInContext(context: Context, _options?: RunningScriptOptions): any {
        return runInContext(this._code, context, { filename: this._filename });
    }

    createCachedData(): Buffer {
        return Buffer.alloc(0);
    }
}

export function createContext(contextObject?: Context, _options?: { name?: string; origin?: string; codeGeneration?: { strings?: boolean; wasm?: boolean }; microtaskMode?: 'after' | 'before' | 'none' }): Context {
    const context = contextObject ?? {};
    const sandbox = new engine.Sandbox();
    const scope = sandbox.global as Context;
    Reflect.set(scope, 'global', scope);
    Reflect.set(scope, 'self', scope);
    Reflect.set(scope, 'window', scope);
    const state: ContextState = {
        sandbox,
        mirroredKeys: new Set(Reflect.ownKeys(context)),
        baselineKeys: new Set(Reflect.ownKeys(scope)),
    };
    copyIn(context, scope, state);
    _contextMap.set(context, state);
    return context;
}

export function isContext(object: Context): boolean {
    return _contextMap.has(object);
}

export function runInThisContext(code: string, _options?: RunningScriptOptions): any {
    return (0, eval)(code);
}

export function runInNewContext(code: string, contextObject?: Context, options?: RunningScriptOptions): any {
    const ctx = createContext(contextObject);
    return runInContext(code, ctx, options);
}

export function runInContext(code: string, context: Context, options?: RunningScriptOptions): any {
    const state = getContextState(context);
    const scope = state.sandbox.global as Context;
    copyIn(context, scope, state);
    const result = state.sandbox.call(code, options?.filename ?? 'vm.js');
    if (result && typeof (result as any).then === 'function') {
        return (result as Promise<any>).finally(() => copyOut(context, state));
    }
    copyOut(context, state);
    return result;
}

export function compileFunction(code: string, params?: string[], options?: { filename?: string; lineOffset?: number; columnOffset?: number; cachedData?: Buffer; produceCachedData?: boolean; parsingContext?: Context; contextExtensions?: Object[] }): Function {
    if (!options?.parsingContext) {
        return new Function(...(params ?? []), code);
    }

    const state = getContextState(options.parsingContext);
    const fn = state.sandbox.call(buildFunctionExpression(code, params ?? []), options.filename ?? 'vm.js');
    if (typeof fn !== 'function') {
        throw new TypeError('Failed to compile function');
    }
    return function (this: any, ...args: any[]) {
        const context = options.parsingContext!;
        const scope = state.sandbox.global as Context;
        copyIn(context, scope, state);
        const result = Reflect.apply(fn as (...innerArgs: any[]) => any, this, args);
        if (result && typeof (result as any).then === 'function') {
            return (result as Promise<any>).finally(() => copyOut(context, state));
        }
        copyOut(context, state);
        return result;
    };
}

export function measureMemory(_options?: { context?: Context }): Promise<{ total: { jsMemoryEstimate: number; jsMemoryAllocated: number }; native: { jsMemoryEstimate: number; jsMemoryAllocated: number }; external: number }> {
    return Promise.resolve({
        total: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        native: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        external: 0,
    });
}
