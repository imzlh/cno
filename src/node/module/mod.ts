/**
 * Node.js module module
 * Connected to cts via cts.internal bridge (no direct cts imports)
 */

import { fileURLToPath } from '../url';
import path from '../path';
const { basename, dirname, isAbsolute: isAbsolutePath, join, resolve: resolvePath } = path;
const os = import.meta.use('os');

type CtsInternal = {
    mkRequire: (parentPath: string, parentMod: unknown) => NodeJS.Require;
    preloadModule?: (id: string, parentPath: string) => unknown;
    builtinModules: string[];
    cache: Map<string, unknown>;
} & {
    specToLocalPath?: (specPath: string) => string | null;
};

function getCtsInternal(): CtsInternal | undefined {
    return Reflect.get(globalThis, Symbol.for('cts.internal')) as CtsInternal | undefined;
}

function getBuiltinModules(): string[] {
    return getCtsInternal()?.builtinModules ?? [];
}

type RequireExtensionMap = Record<string, ((module: unknown, filename: string) => unknown) | undefined>;
type CommonJSWrapper = (
    exports: unknown,
    require: NodeJS.Require,
    module: Module,
    filename: string,
    dirname: string,
) => unknown;

function getExtensions(): RequireExtensionMap {
    const ctsInternal = getCtsInternal();
    if (!ctsInternal) return Object.create(null);
    return ctsInternal.mkRequire(fileURLToPath(import.meta.url), undefined).extensions ?? Object.create(null);
}

export interface SourceMap {
    payload: unknown;
    lineLengths: readonly number[];
}

// Cache for _nodeModulePaths
const _pathsCache = new Map<string, string[]>();

export function createRequire(filename: string | URL): NodeJS.Require {
    let parentPath: string;
    if (filename instanceof URL) {
        parentPath = fileURLToPath(filename);
    } else if (typeof filename === 'string' && filename.startsWith('file:')) {
        parentPath = fileURLToPath(filename);
    } else if (typeof filename === 'string' && isAbsolutePath(filename)) {
        parentPath = filename;
    } else {
        throw new TypeError('The argument "filename" must be a file URL object, file URL string, or absolute path string');
    }
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

function requireFromCwd(): NodeJS.Require {
    return createRequire(join(os.cwd, '__cno_module__.js'));
}

export function _preloadModules(requests: string[]): void {
    const require = requireFromCwd();
    const ctsInternal = getCtsInternal();
    const parentPath = join(os.cwd, '__cno_require_preload__.js');
    for (const request of requests) {
        if (ctsInternal?.preloadModule) ctsInternal.preloadModule(request, parentPath);
        else require(request);
    }
}

export function runMain(): void {
    const processObject = Reflect.get(globalThis, 'process');
    const argv = processObject && typeof processObject === 'object'
        ? Reflect.get(processObject, 'argv')
        : undefined;
    const main = Array.isArray(argv) ? argv[1] : undefined;
    if (typeof main !== 'string' || main.length === 0) return;
    requireFromCwd()(isAbsolutePath(main) ? main : resolvePath(main));
}

export function wrap(code: string): string {
    return `(function(exports, require, module, __filename, __dirname) { ${code}\n});`;
}

export function _nodeModulePaths(from: string): string[] {
    const hit = _pathsCache.get(from);
    if (hit) return hit;
    const out: string[] = [];
    let d = isAbsolutePath(from) ? from : resolvePath(from);
    while (d !== '') {
        const candidate = basename(d) === 'node_modules' ? d : join(d, 'node_modules');
        if (!out.includes(candidate)) out.push(candidate);
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
        return requireFn.resolve(request, options);
    }
    return request;
}

export function _pathFilename(filename: string): string {
    return filename;
}

const builtinModulesTarget: string[] = [];
export const builtinModules: string[] = new Proxy(builtinModulesTarget, {
    get: (_t, key) => Reflect.get(getBuiltinModules(), key),
    has: (_t, key) => key in getBuiltinModules(),
    ownKeys: () => Reflect.ownKeys(getBuiltinModules()),
    getOwnPropertyDescriptor: (_t, key) => {
        const desc = Object.getOwnPropertyDescriptor(getBuiltinModules(), key);
        return desc ? { ...desc, configurable: true } : undefined;
    },
});

const moduleCacheTarget: Record<string, unknown> = {};
export const _cache: Record<string, unknown> = new Proxy(moduleCacheTarget, {
    has: (_t, key) => typeof key === 'string' && (getCtsInternal()?.cache.has(key) ?? false),
    get: (_t, key) => typeof key === 'string' ? getCtsInternal()?.cache.get(key) : undefined,
    set: (_t, key, value) => { if (typeof key === 'string') getCtsInternal()?.cache.set(key, value); return true; },
    deleteProperty: (_t, key) => { if (typeof key === 'string') getCtsInternal()?.cache.delete(key); return true; },
    ownKeys: () => {
        const ctsInternal = getCtsInternal();
        return ctsInternal ? [...ctsInternal.cache.keys()] : [];
    },
    getOwnPropertyDescriptor: (_t, key) => {
        const ctsInternal = getCtsInternal();
        if (typeof key !== 'string' || !ctsInternal?.cache.has(key)) return undefined;
        return { value: ctsInternal.cache.get(key), writable: true, enumerable: true, configurable: true };
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
    if (typeof moduleName !== 'string') return false;
    const bare = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
    return getBuiltinModules().includes(bare);
}

export function syncBuiltinESMExports(): void {}

export class Module {
    id: string;
    filename: string;
    loaded = false;
    exports: unknown;
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

    require(id: string): unknown {
        return createRequire(this.filename)(id);
    }

    _compile(code: string, filename: string): void {
        const wrapper = Module.wrap(code);
        const fn: unknown = (0, eval)(wrapper);
        if (typeof fn !== 'function') {
            throw new TypeError('Compiled CommonJS wrapper must be a function');
        }
        const require = createRequire(isAbsolutePath(filename) ? filename : resolvePath(filename));
        (fn as CommonJSWrapper)(this.exports, require, this, filename, dirname(filename));
    }

    static wrap = wrap;

    static _cache: Record<string, unknown> = {};

    static _nodeModulePaths = _nodeModulePaths;

    static _resolveFilename = _resolveFilename;

    static isBuiltin = isBuiltin;

    static createRequire = createRequire;

    static _preloadModules = _preloadModules;

    static runMain = runMain;

    static register(_specifier: string, _options?: { parentURL?: string; data?: unknown; transferList?: unknown[] }): void {
        // ESM loader hook registration — not yet implemented
    }
}

// Live cache proxy
Object.defineProperty(Module, '_cache', {
    get: () => _cache,
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

export const _compile = (content: string, filename: string): unknown => {
    const mod = new Module(filename);
    mod._compile(content, filename);
    return mod.exports;
};

export const register = Module.register;
