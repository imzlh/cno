/**
 * Node.js module module
 * Connected to cts via cts.internal bridge (no direct cts imports)
 */

import { fileURLToPath } from '../url';
import path from '../path';
const { dirname, join } = path;

const CTS_INTERNAL = (globalThis as any)[Symbol.for('cts.internal')] as {
    mkRequire: (parentPath: string, parentMod: any) => NodeJS.Require;
    builtinModules: string[];
    cache: Map<string, any>;
} | undefined;

export interface SourceMap {
    payload: any;
    lineLengths: readonly number[];
}

// Cache for _nodeModulePaths
const _pathsCache = new Map<string, string[]>();

export function createRequire(filename: string | URL): NodeJS.Require {
    const parentPath = filename instanceof URL ? fileURLToPath(filename) : filename;
    if (CTS_INTERNAL) return CTS_INTERNAL.mkRequire(parentPath, undefined);
    return require;
}

export function createRequireFromURL(url: string | URL): NodeJS.Require {
    return createRequire(url instanceof URL ? url : new URL(url));
}

export function runMain(): void {
    // Handled by cts runtime
}

export function wrap(code: string): string {
    return `(function(exports, require, module, __filename, __dirname) { ${code}\n});`;
}

export function _nodeModulePaths(from: string): string[] {
    const hit = _pathsCache.get(from);
    if (hit) return hit;
    const out: string[] = [];
    let d = from;
    while (d !== '/' && d !== '') {
        out.push(join(d, 'node_modules'));
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    _pathsCache.set(from, out);
    return out;
}

export function _resolveFilename(request: string, parent?: { filename?: string }, isMain?: boolean, options?: { paths?: string[] }): string {
    if (CTS_INTERNAL) {
        const parentPath = parent?.filename ?? '';
        const requireFn = CTS_INTERNAL.mkRequire(parentPath, undefined);
        return (requireFn.resolve as any)(request, options);
    }
    return request;
}

export function _pathFilename(filename: string): string {
    return filename;
}

export const builtinModules: string[] = CTS_INTERNAL?.builtinModules ?? [];

export const _cache: Record<string, any> = new Proxy({} as Record<string, any>, {
    has: (_t, key) => CTS_INTERNAL?.cache.has(key as string) ?? false,
    get: (_t, key) => CTS_INTERNAL?.cache.get(key as string),
    set: (_t, key, value) => { CTS_INTERNAL?.cache.set(key as string, value); return true; },
    deleteProperty: (_t, key) => { CTS_INTERNAL?.cache.delete(key as string); return true; },
    ownKeys: () => CTS_INTERNAL ? [...CTS_INTERNAL.cache.keys()] : [],
    getOwnPropertyDescriptor: (_t, key) => {
        if (!CTS_INTERNAL?.cache.has(key as string)) return undefined;
        return { value: CTS_INTERNAL.cache.get(key as string), writable: true, enumerable: true, configurable: true };
    },
});

export const _extensions: Record<string, (module: any, filename: string) => void> = {
    '.js'() {},
    '.json'() {},
    '.node'() {},
};

export function findSourceMap(_path: string, _error?: Error): SourceMap | undefined {
    return undefined;
}

export const globalPaths: string[] = [];

export function isBuiltin(moduleName: string): boolean {
    const bare = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
    return builtinModules.includes(bare);
}

export function syncBuiltinESMExports(): void {}

export class Module {
    id: string;
    filename: string;
    loaded = false;
    exports: any;
    parent: Module | null = null;
    children: Module[] = [];
    paths: string[];
    path: string;

    constructor(id: string = '', parent?: Module | null) {
        this.id = id;
        this.filename = id;
        this.path = dirname(id);
        this.paths = _nodeModulePaths(this.path);
        this.exports = {};
        if (parent) {
            this.parent = parent;
            parent.children.push(this);
        }
    }

    require(id: string): any {
        return createRequire(this.filename)(id);
    }

    _compile(code: string, filename: string): any {
        const wrapper = Module.wrap(code);
        const fn = (0, eval)(wrapper);
        const require = createRequire(filename);
        fn(this.exports, require, this, filename, dirname(filename));
    }

    static wrap = wrap;

    static _cache: Record<string, any> = {};

    static _nodeModulePaths = _nodeModulePaths;

    static _resolveFilename = _resolveFilename;

    static builtinModules = builtinModules;

    static isBuiltin = isBuiltin;

    static createRequire = createRequire;

    static register(_specifier: string, _options?: { parentURL?: string; data?: any; transferList?: any[] }): void {
        // ESM loader hook registration — not yet implemented
    }
}

// Live cache proxy
Object.defineProperty(Module, '_cache', {
    get: () => CTS_INTERNAL?.cache ?? {},
    enumerable: true,
    configurable: true,
});

export const _compile = (content: string, filename: string): any => {
    const mod = new Module(filename);
    mod._compile(content, filename);
    return mod.exports;
};

export const register = Module.register;
