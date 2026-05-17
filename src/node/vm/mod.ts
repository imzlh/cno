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
    constructor(_code: string, _options?: ScriptOptions) {}
    runInThisContext(_options?: RunningScriptOptions): any { return undefined; }
    runInNewContext(_contextObject?: Context, _options?: RunningScriptOptions): any { return undefined; }
    runInContext(_context: Context, _options?: RunningScriptOptions): any { return undefined; }
    createCachedData(): Buffer { return Buffer.alloc(0); }
}

export function createContext(_contextObject?: Context, _options?: { name?: string; origin?: string; codeGeneration?: { strings?: boolean; wasm?: boolean }; microtaskMode?: 'after' | 'before' | 'none' }): Context {
    return {};
}

export function isContext(_object: Context): boolean { return false; }

export function runInThisContext(code: string, _options?: RunningScriptOptions): any {
    return eval(code);
}

export function runInNewContext(_code: string, _contextObject?: Context, _options?: RunningScriptOptions): any {
    return undefined;
}

export function runInContext(_code: string, _context: Context, _options?: RunningScriptOptions): any {
    return undefined;
}

export function compileFunction(_code: string, _params?: string[], _options?: { filename?: string; lineOffset?: number; columnOffset?: number; cachedData?: Buffer; produceCachedData?: boolean; parsingContext?: Context; contextExtensions?: Object[] }): Function {
    return () => {};
}

export function measureMemory(_options?: { context?: Context }): Promise<{ total: { jsMemoryEstimate: number; jsMemoryAllocated: number }; native: { jsMemoryEstimate: number; jsMemoryAllocated: number }; external: number }> {
    return Promise.resolve({
        total: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        native: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        external: 0,
    });
}
