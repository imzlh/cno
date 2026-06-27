/**
 * Node.js module module
 * Connected to cts via cts.internal bridge (no direct cts imports)
 */

import { fileURLToPath } from '../url';
import path from '../path';
const { dirname, join } = path;

type CtsInternal = {
    mkRequire: (parentPath: string, parentMod: any) => NodeJS.Require;
    builtinModules: string[];
    cache: Map<string, any>;
} & {
    specToLocalPath?: (specPath: string) => string | null;
};

function getCtsInternal(): CtsInternal | undefined {
    return (globalThis as any)[Symbol.for('cts.internal')] as CtsInternal | undefined;
}

function getBuiltinModules(): string[] {
    return getCtsInternal()?.builtinModules ?? [];
}

type RequireExtensionMap = Record<string, ((module: any, filename: string) => any) | undefined>;

function getExtensions(): RequireExtensionMap {
    const ctsInternal = getCtsInternal();
    if (!ctsInternal) return Object.create(null);
    return ctsInternal.mkRequire(fileURLToPath(import.meta.url), undefined).extensions ?? Object.create(null);
}

export interface SourceMap {
    payload: any;
    lineLengths: readonly number[];
}

// Cache for _nodeModulePaths
const _pathsCache = new Map<string, string[]>();

export function createRequire(filename: string | URL): NodeJS.Require {
    const parentPath = filename instanceof URL ? fileURLToPath(filename) : filename;
    const ctsInternal = getCtsInternal();
    if (ctsInternal) return ctsInternal.mkRequire(parentPath, undefined);
    return require;
}

export function createRequireFromURL(url: string | URL): NodeJS.Require {
    if (url instanceof URL) {
        return createRequire(fileURLToPath(url));
    }
    // Already a filesystem path (no scheme)
    if (!url.includes('://')) {
        return createRequire(url);
    }
    // Has a scheme — convert via fileURLToPath which handles file:/npm:/jsr: etc.
    return createRequire(fileURLToPath(url));
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
    while (d !== '/' && d !== '' && !/^[a-zA-Z]:\\?$/.test(d)) {
        out.push(join(d, 'node_modules'));
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    _pathsCache.set(from, out);
    return out;
}

export function _resolveFilename(request: string, parent?: { filename?: string }, isMain?: boolean, options?: { paths?: string[] }): string {
    const ctsInternal = getCtsInternal();
    if (ctsInternal) {
        const parentPath = parent?.filename ?? '';
        const requireFn = ctsInternal.mkRequire(parentPath, undefined);
        return (requireFn.resolve as any)(request, options);
    }
    return request;
}

export function _pathFilename(filename: string): string {
    return filename;
}

export const builtinModules: string[] = new Proxy([] as string[], {
    get: (_t, key) => Reflect.get(getBuiltinModules(), key),
    has: (_t, key) => key in getBuiltinModules(),
    ownKeys: () => Reflect.ownKeys(getBuiltinModules()),
    getOwnPropertyDescriptor: (_t, key) => {
        const desc = Object.getOwnPropertyDescriptor(getBuiltinModules(), key);
        return desc ? { ...desc, configurable: true } : undefined;
    },
});

export const _cache: Record<string, any> = new Proxy({} as Record<string, any>, {
    has: (_t, key) => getCtsInternal()?.cache.has(key as string) ?? false,
    get: (_t, key) => getCtsInternal()?.cache.get(key as string),
    set: (_t, key, value) => { getCtsInternal()?.cache.set(key as string, value); return true; },
    deleteProperty: (_t, key) => { getCtsInternal()?.cache.delete(key as string); return true; },
    ownKeys: () => {
        const ctsInternal = getCtsInternal();
        return ctsInternal ? [...ctsInternal.cache.keys()] : [];
    },
    getOwnPropertyDescriptor: (_t, key) => {
        const ctsInternal = getCtsInternal();
        if (!ctsInternal?.cache.has(key as string)) return undefined;
        return { value: ctsInternal.cache.get(key as string), writable: true, enumerable: true, configurable: true };
    },
});

export const _extensions: RequireExtensionMap = new Proxy(Object.create(null), {
    get: (_t, key) => Reflect.get(getExtensions(), key),
    has: (_t, key) => key in getExtensions(),
    ownKeys: () => Reflect.ownKeys(getExtensions()),
    getOwnPropertyDescriptor: (_t, key) => {
        const desc = Object.getOwnPropertyDescriptor(getExtensions(), key);
        return desc ? { ...desc, configurable: true } : undefined;
    },
});

export function findSourceMap(_path: string, _error?: Error): SourceMap | undefined {
    return undefined;
}

export const globalPaths: string[] = [];

export function isBuiltin(moduleName: string): boolean {
    const bare = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
    return getBuiltinModules().includes(bare);
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

    static isBuiltin = isBuiltin;

    static createRequire = createRequire;

    static register(_specifier: string, _options?: { parentURL?: string; data?: any; transferList?: any[] }): void {
        // ESM loader hook registration — not yet implemented
    }
}

// Live cache proxy
Object.defineProperty(Module, '_cache', {
    get: () => getCtsInternal()?.cache ?? {},
    enumerable: true,
    configurable: true,
});

Object.defineProperty(Module, '_extensions', {
    get: () => _extensions,
    enumerable: true,
    configurable: true,
});

Object.defineProperty(Module, 'builtinModules', {
    get: () => getBuiltinModules(),
    enumerable: true,
    configurable: true,
});

export const _compile = (content: string, filename: string): any => {
    const mod = new Module(filename);
    mod._compile(content, filename);
    return mod.exports;
};

export const register = Module.register;
