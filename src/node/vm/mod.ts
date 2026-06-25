/**
 * Node.js vm module (stub)
 * JavaScript code compilation and execution in V8 contexts
 */

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

export class Script {
    private _code: string;
    constructor(code: string, _options?: ScriptOptions) { this._code = code; }
    runInThisContext(_options?: RunningScriptOptions): any { return eval(this._code); }
    runInNewContext(contextObject?: Context, _options?: RunningScriptOptions): any { return runInNewContext(this._code, contextObject, _options); }
    runInContext(context: Context, _options?: RunningScriptOptions): any { return runInContext(this._code, context, _options); }
    createCachedData(): Buffer { return Buffer.alloc(0); }
}

const _contextMarker = Symbol('vm_context');

export function createContext(contextObject?: Context, _options?: { name?: string; origin?: string; codeGeneration?: { strings?: boolean; wasm?: boolean }; microtaskMode?: 'after' | 'before' | 'none' }): Context {
    const ctx: Context = contextObject ? Object.create(null, Object.getOwnPropertyDescriptors(contextObject)) : Object.create(null);
    ctx[_contextMarker] = true;
    return ctx;
}

export function isContext(object: Context): boolean { return !!object?.[_contextMarker]; }

export function runInNewContext(code: string, contextObject?: Context, _options?: RunningScriptOptions): any {
    const ctx = createContext(contextObject);
    return runInContext(code, ctx, _options);
}

const _globalEval = eval;
export function runInThisContext(code: string, _options?: RunningScriptOptions): any {
    return _globalEval(code);
}

export function runInNewContext(_code: string, _contextObject?: Context, _options?: RunningScriptOptions): any {
    return undefined;
}

export function runInContext(code: string, context: Context, _options?: RunningScriptOptions): any {
    const keys = Object.keys(context).filter(k => k !== String(_contextMarker));
    const original: Record<string, any> = {};
    try {
        for (const k of keys) { original[k] = (globalThis as any)[k]; (globalThis as any)[k] = context[k]; }
        return eval(code);
    } finally {
        for (const k of keys) {
            if (k in original) (globalThis as any)[k] = original[k];
            else delete (globalThis as any)[k];
        }
    }
}

export function compileFunction(code: string, params?: string[], _options?: { filename?: string; lineOffset?: number; columnOffset?: number; cachedData?: Buffer; produceCachedData?: boolean; parsingContext?: Context; contextExtensions?: Object[] }): Function {
    return new Function(...(params ?? []), code);
}

export function measureMemory(_options?: { context?: Context }): Promise<{ total: { jsMemoryEstimate: number; jsMemoryAllocated: number }; native: { jsMemoryEstimate: number; jsMemoryAllocated: number }; external: number }> {
    return Promise.resolve({
        total: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        native: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        external: 0,
    });
}
