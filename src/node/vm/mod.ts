/**
 * Node.js vm module
 * Uses engine.Sandbox and mirrors a host context object in and out.
 */

const engine = import.meta.use('engine');
type VmCallable = (...args: unknown[]) => unknown;

export interface Context {
    [key: string]: unknown;
}

export interface RunningScriptOptions {
    filename?: string;
    lineOffset?: number;
    columnOffset?: number;
    cachedData?: Buffer;
    produceCachedData?: boolean;
    importModuleDynamically?: VmCallable;
}

export interface ScriptOptions extends RunningScriptOptions {
    contextExtensions?: object[];
}

interface ContextState {
    sandbox: InstanceType<typeof engine.Sandbox>;
    mirroredKeys: Set<string | symbol>;
    baselineKeys: Set<string | symbol>;
}

interface CompileContext {
    context: Context;
    refresh(): void;
    commit(): void;
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
    "DisposableStack",
    "Promise",
]);

const CONTEXT_GLOBAL_KEYS = [
    'Date',
    'RegExp',
    'JSON',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt',
    'BigInt64Array',
    'BigUint64Array',
    'Atomics',
    'WeakRef',
    'FinalizationRegistry',
    'WebAssembly',
    'Promise',
    'console',
] as const;

function installContextGlobals(scope: Context): void {
    for (const key of CONTEXT_GLOBAL_KEYS) {
        if (Reflect.has(scope, key) || !Reflect.has(globalThis, key)) continue;
        Reflect.set(scope, key, Reflect.get(globalThis, key));
    }
}

function getContextState(context: Context): ContextState {
    const state = _contextMap.get(context);
    if (!state) throw new TypeError('Context was not created by vm.createContext()');
    return state;
}

function validateContextObject(object: unknown): asserts object is Context {
    if (object === null || typeof object !== 'object') {
        throw new TypeError('The "object" argument must be of type object.');
    }
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

function attachCachedData<T extends VmCallable>(fn: T, options?: { produceCachedData?: boolean }): T {
    if (options?.produceCachedData) {
        Object.defineProperty(fn, 'cachedData', { value: Buffer.alloc(0), configurable: true });
        Object.defineProperty(fn, 'cachedDataProduced', { value: true, configurable: true });
    }
    return fn;
}

function isPromise(value: unknown): value is Promise<unknown> {
    return (typeof value === 'object' || typeof value === 'function')
        && value !== null
        && typeof Reflect.get(value, 'then') === 'function'
        && typeof Reflect.get(value, 'finally') === 'function';
}

function copySource(source: Context, target: Context): void {
    for (const key of Reflect.ownKeys(source)) {
        const desc = Object.getOwnPropertyDescriptor(source, key);
        if (!desc) continue;
        Reflect.set(target, key, 'value' in desc ? desc.value : Reflect.get(source, key));
    }
}

function resetContext(context: Context): void {
    for (const key of Reflect.ownKeys(context)) Reflect.deleteProperty(context, key);
}

function normalizeContextExtensions(extensions?: object[]): Context[] {
    if (!extensions || extensions.length === 0) return [];
    const out: Context[] = [];
    for (const extension of extensions) {
        validateContextObject(extension);
        out.push(extension);
    }
    return out;
}

function findExtensionOwner(extensions: Context[], key: PropertyKey): Context | undefined {
    for (let i = extensions.length - 1; i >= 0; i--) {
        const extension = extensions[i];
        if (extension && Object.prototype.hasOwnProperty.call(extension, key)) return extension;
    }
    return undefined;
}

function buildCompileContext(parsingContext?: Context, contextExtensions?: object[]): CompileContext | undefined {
    const extensions = normalizeContextExtensions(contextExtensions);
    if (extensions.length === 0) {
        if (!parsingContext) return undefined;
        getContextState(parsingContext);
        return { context: parsingContext, refresh() {}, commit() {} };
    }

    if (parsingContext) getContextState(parsingContext);
    const context: Context = {};
    const knownKeys = new Set<PropertyKey>();
    const refresh = () => {
        resetContext(context);
        if (parsingContext) copySource(parsingContext, context);
        for (const extension of extensions) copySource(extension, context);
        knownKeys.clear();
        for (const key of Reflect.ownKeys(context)) knownKeys.add(key);
    };
    const commit = () => {
        const keys = new Set([...knownKeys, ...Reflect.ownKeys(context)]);
        for (const key of keys) {
            const owner = findExtensionOwner(extensions, key);
            const target = owner ?? parsingContext;
            if (!target) continue;
            if (Object.prototype.hasOwnProperty.call(context, key)) {
                Reflect.set(target, key, Reflect.get(context, key));
            } else {
                Reflect.deleteProperty(target, key);
            }
        }
    };

    refresh();
    return { context: createContext(context), refresh, commit };
}

export class Script {
    private _code: string;
    private _filename: string;
    cachedData?: Buffer;
    cachedDataProduced?: boolean;

    constructor(code: string, options?: ScriptOptions) {
        this._code = code;
        this._filename = options?.filename ?? 'vm.js';
        if (options?.produceCachedData) {
            this.cachedData = Buffer.alloc(0);
            this.cachedDataProduced = true;
        }
    }

    runInThisContext(_options?: RunningScriptOptions): unknown {
        return (0, eval)(this._code);
    }

    runInNewContext(contextObject?: Context, options?: RunningScriptOptions): unknown {
        const ctx = createContext(contextObject);
        return this.runInContext(ctx, options);
    }

    runInContext(context: Context, _options?: RunningScriptOptions): unknown {
        return runInContext(this._code, context, { filename: this._filename });
    }

    createCachedData(): Buffer {
        return Buffer.alloc(0);
    }
}

export function createContext(contextObject?: Context, _options?: { name?: string; origin?: string; codeGeneration?: { strings?: boolean; wasm?: boolean }; microtaskMode?: 'after' | 'before' | 'none' }): Context {
    if (contextObject !== undefined) validateContextObject(contextObject);
    const context = contextObject ?? {};
    const sandbox = new engine.Sandbox();
    const scope = sandbox.global as Context;
    Reflect.set(scope, 'global', scope);
    Reflect.set(scope, 'self', scope);
    Reflect.set(scope, 'window', scope);
    installContextGlobals(scope);
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
    validateContextObject(object);
    return _contextMap.has(object);
}

export function runInThisContext(code: string, _options?: RunningScriptOptions): unknown {
    return (0, eval)(code);
}

export function runInNewContext(code: string, contextObject?: Context, options?: RunningScriptOptions): unknown {
    const ctx = createContext(contextObject);
    return runInContext(code, ctx, options);
}

export function runInContext(code: string, context: Context, options?: RunningScriptOptions): unknown {
    const state = getContextState(context);
    const scope = state.sandbox.global as Context;
    copyIn(context, scope, state);
    const result = state.sandbox.call(code, options?.filename ?? 'vm.js');
    if (isPromise(result)) {
        return result.finally(() => copyOut(context, state));
    }
    copyOut(context, state);
    return result;
}

export function compileFunction(code: string, params?: string[], options?: { filename?: string; lineOffset?: number; columnOffset?: number; cachedData?: Buffer; produceCachedData?: boolean; parsingContext?: Context; contextExtensions?: object[] }): VmCallable {
    if (options?.parsingContext !== undefined) validateContextObject(options.parsingContext);
    const compileContext = buildCompileContext(options?.parsingContext, options?.contextExtensions);
    if (!compileContext) {
        return attachCachedData(new Function(...(params ?? []), code) as VmCallable, options);
    }

    const state = getContextState(compileContext.context);
    const fn = state.sandbox.call(buildFunctionExpression(code, params ?? []), options?.filename ?? 'vm.js');
    if (typeof fn !== 'function') {
        throw new TypeError('Failed to compile function');
    }
    return attachCachedData(function (this: unknown, ...args: unknown[]) {
        compileContext.refresh();
        const context = compileContext.context;
        const scope = state.sandbox.global as Context;
        copyIn(context, scope, state);
        const result = Reflect.apply(fn as (...innerArgs: unknown[]) => unknown, this, args);
        if (isPromise(result)) {
            return result.finally(() => {
                copyOut(context, state);
                compileContext.commit();
            });
        }
        copyOut(context, state);
        compileContext.commit();
        return result;
    }, options);
}

export function measureMemory(_options?: { context?: Context }): Promise<{ total: { jsMemoryEstimate: number; jsMemoryAllocated: number }; native: { jsMemoryEstimate: number; jsMemoryAllocated: number }; external: number }> {
    return Promise.resolve({
        total: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        native: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        external: 0,
    });
}
