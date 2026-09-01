/**
 * Node.js module module
 * Connected to cts via cts.internal bridge (no direct cts imports)
 */

import { fileURLToPath, pathToFileURL } from '../url';
import path from '../path';
const { basename, dirname, isAbsolute: isAbsolutePath, join, resolve: resolvePath } = path;
const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

type CtsInternal = {
    mkRequire: (parentPath: string, parentMod: unknown) => NodeJS.Require;
    preloadModule?: (id: string, parentPath: string) => unknown;
    builtinModules: string[];
    cache: {
        get(key: string): unknown;
        has(key: string): boolean;
        set(key: string, value: unknown): unknown;
        delete(key: string): boolean;
        keys(): IterableIterator<string>;
    };
    registerModuleHooks?: (hooks: { load?: LoadHook; resolve?: ResolveHook }) => { deregister(): void };
    hasModuleResolveHooks?: () => boolean;
    hasModuleLoadHooks?: () => boolean;
    runModuleResolveHooks?: (
        specifier: string,
        context: ResolveContext,
        terminal: (specifier: string, context: ResolveContext) => ResolveResult,
    ) => ResolveResult;
    runModuleLoadHooks?: (
        url: string,
        context: LoadContext,
        terminal: (url: string, context: LoadContext) => LoadResult,
    ) => LoadResult;
    /** Identity bridge for the CJS loader's in-body require(). */
    nodeModuleInterop?: {
        getCache?: () => Record<string, unknown>;
        getExtensions?: () => RequireExtensionMap;
        setCache?: (value: Record<string, unknown>) => void;
        setExtensions?: (value: RequireExtensionMap) => void;
        replaceCache?: (value: Record<string, unknown>) => void;
        resetCache?: (value?: Record<string, unknown>) => void;
        replaceExtensions?: (value: RequireExtensionMap) => void;
        resetExtensions?: () => void;
        cacheIsDefault?: () => boolean;
        extensionsAreDefault?: () => boolean;
        defaultExtensions?: Record<string, unknown>;
    };
} & {
    specToLocalPath?: (specPath: string) => string | null;
};

function getCtsInternal(): CtsInternal | undefined {
    return Reflect.get(globalThis, Symbol.for('cts.internal')) as CtsInternal | undefined;
}

function getBuiltinModules(): string[] {
    return getCtsInternal()?.builtinModules ?? [];
}

type RequireExtensionMap = Record<string, ((module: Module, filename: string) => unknown) | undefined>;
type CommonJSWrapper = (
    exports: unknown,
    require: NodeJS.Require,
    module: Module,
    filename: string,
    dirname: string,
) => unknown;

/**
 * Node exposes ONE `require.extensions` object process-wide: `Module._extensions`,
 * `require.extensions` and every `createRequire(...).extensions` are the same
 * reference. cts hands out a fresh object per mkRequire() call, so registering a
 * handler there is silently lost. Own the map here instead and have `_load`
 * consult it — that is what pirates / ts-node / @babel/register mutate.
 */
const _extensionsStore: RequireExtensionMap = Object.create(null) as RequireExtensionMap;

/** Handlers we installed ourselves; used to tell "pristine" from "user-patched". */
const defaultExtensionHandlers = new Set<unknown>();

/** The cts require for `parentPath`, bypassing `Module._load` (no recursion). */
function rawRequire(parentPath: string): NodeJS.Require {
    const ctsInternal = getCtsInternal();
    if (!ctsInternal) throw new Error('cts internal bridge unavailable');
    return ctsInternal.mkRequire(parentPath, undefined);
}

/**
 * The two halves of the CJS wrapper — byte-identical to real Node v24
 * (`Module.wrapper`), including the space after `function`.
 */
export const wrapper: string[] = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'];

export const constants = Object.freeze({
    compileCacheStatus: Object.freeze({ FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 }),
});

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
        // Node tags this with ERR_INVALID_ARG_VALUE; bundlers branch on the code.
        throw Object.assign(
            new TypeError('The argument "filename" must be a file URL object, file URL string, or absolute path string'),
            { code: 'ERR_INVALID_ARG_VALUE' },
        );
    }
    if (!getCtsInternal()) return require;
    return makeRequire(parentPath);
}

/**
 * A `require` that routes through `Module._load` / `Module._resolveFilename` so
 * monkey-patching either one is observable (require-in-the-middle, APM agents,
 * @babel/register). `.cache` and `.extensions` are the single process-wide
 * objects, matching Node's identity guarantees.
 */
function makeRequire(parentPath: string): NodeJS.Require {
    const parentRef = { filename: parentPath, id: parentPath, paths: _nodeModulePaths(dirname(parentPath)) };
    const requireFn = ((id: string): unknown => Module._load(id, parentRef, false)) as NodeJS.Require;
    const resolve = ((id: string, options?: { paths?: string[] }): string =>
        Module._resolveFilename(id, parentRef, false, options)) as NodeJS.RequireResolve;
    resolve.paths = (id: string): string[] | null => Module._resolveLookupPaths(id, parentRef);
    requireFn.resolve = resolve;
    // Getters: the underlying stores are replaceable (`Module._cache = {}` is a
    // documented reset idiom), and `require.cache` must follow.
    Object.defineProperty(requireFn, 'cache', {
        get: () => Module._cache,
        set: (value) => { Module._cache = value as Record<string, unknown>; },
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(requireFn, 'extensions', {
        get: () => Module._extensions,
        set: (value) => { Module._extensions = value as RequireExtensionMap; },
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(requireFn, 'main', {
        get: () => {
            try { return rawRequire(parentPath).main; } catch { return undefined; }
        },
        enumerable: true,
        configurable: true,
    });
    return requireFn;
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
    return wrapper[0] + code + wrapper[1];
}

export function _nodeModulePaths(from: string): string[] {
    const hit = _pathsCache.get(from);
    if (hit) return hit;
    const out: string[] = [];
    let d = isAbsolutePath(from) ? from : resolvePath(from);
    // join() would rewrite separators and emit mixed paths ("/tmp/a\node_modules");
    // keep whichever style the caller used so the results stay usable as-is.
    const sep = path.sep === '\\' && d.includes('\\') ? '\\' : (d.includes('/') ? '/' : path.sep);
    while (d !== '') {
        const candidate = basename(d) === 'node_modules' ? d : d + (d.endsWith(sep) ? '' : sep) + 'node_modules';
        if (!out.includes(candidate)) out.push(candidate);
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    _pathsCache.set(from, out);
    return out;
}

let extensionsRef: RequireExtensionMap | undefined;
const _extensionsRef = (): RequireExtensionMap => extensionsRef ?? _extensionsStore;
const setExtensionsRef = (value: RequireExtensionMap): void => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        throw new TypeError('Module._extensions must be an object');
    }
    const next = value === _extensions ? undefined : value;
    const interop = getCtsInternal()?.nodeModuleInterop;
    if (next === undefined) interop?.resetExtensions?.();
    else interop?.replaceExtensions?.(next);
    extensionsRef = next;
};

/** True only while the extension table is still exactly our three defaults. */
function extensionsArePristine(): boolean {
    const table = _extensionsRef();
    if (table !== _extensionsStore) return false;
    for (const key of Object.keys(table)) {
        if (!defaultExtensionHandlers.has(table[key])) return false;
    }
    return table['.js'] === defaultJsExtension
        && table['.json'] === defaultJsonExtension
        && table['.node'] === defaultNodeExtension;
}

// Captured after the class body so we can tell "pristine" from "user-patched".
// Node calls _resolveFilename on every require and _compile on every fresh JS
// module; we only pay for the JS-side load path once someone is watching.
let pristineResolveFilename: unknown;
let pristinePrototypeCompile: unknown;

/**
 * Does this load need the JS-side path? True once user code registers a hook or
 * an extension handler, OR patches `Module._resolveFilename` /
 * `Module.prototype._compile` — require-in-the-middle patches the former and
 * older ts-node patches the latter, and neither shows up in the extension table.
 */
function needsJsLoadPath(): boolean {
    if (hasRegisteredResolveHooks() || hasRegisteredLoadHooks()) return true;
    if (!extensionsArePristine()) return true;
    if (pristineResolveFilename !== undefined && Module._resolveFilename !== pristineResolveFilename) return true;
    if (pristinePrototypeCompile !== undefined && Module.prototype._compile !== pristinePrototypeCompile) return true;
    return false;
}

export function _resolveFilename(request: string, parent?: { filename?: string }, isMain?: boolean, options?: { paths?: string[] }): string {
    // Node returns the request unchanged for builtins instead of a polyfill path.
    if (isBuiltin(request)) return request;
    const ctsInternal = getCtsInternal();
    if (!ctsInternal) return request;
    const parentPath = parent?.filename ?? '';

    const context: ResolveContext = { parentURL: toFileUrl(parentPath) };
    const terminal = (spec: string, nextContext: ResolveContext): ResolveResult => {
        const nextParent = fromFileUrl(nextContext.parentURL ?? context.parentURL!);
        return {
            url: toFileUrl(ctsInternal.mkRequire(nextParent, undefined).resolve(spec, options)),
            shortCircuit: true,
        };
    };
    if (!hasRegisteredResolveHooks()) return fromFileUrl(terminal(request, context).url);
    const result = ctsInternal.runModuleResolveHooks
        ? ctsInternal.runModuleResolveHooks(request, context, terminal)
        : runResolveChain(request, context, terminal);
    return fromFileUrl(result.url);
}

export function _pathFilename(filename: string): string {
    return filename;
}

/**
 * Builtins Node exposes ONLY under the `node:` prefix, never bare. Measured on
 * v24.18.0: `builtinModules` contains the literal strings `node:sea`,
 * `node:sqlite`, `node:test`, `node:test/reporters`, and `isBuiltin('test')` is
 * **false** while `isBuiltin('node:test')` is true. The asymmetry is deliberate
 * upstream — a bare `test` would shadow a user's own `./test` module.
 *
 * cts's own builtin list is bare-name-only, so these were missing entirely:
 * `isBuiltin('node:sqlite')` was false even though `import('node:sqlite')`
 * works. That matters because bundlers and resolvers call `isBuiltin` to decide
 * what to externalise, so a false answer makes them try to fetch it from npm.
 *
 * Declared here rather than beside isBuiltin() because builtinModules' Proxy
 * (below) also needs it, and a `const` is not hoisted.
 */
const PREFIX_ONLY_BUILTINS = ['node:sea', 'node:sqlite', 'node:test', 'node:test/reporters'];

const builtinModulesTarget: string[] = [];
/**
 * Node's `builtinModules` lists bare names plus the four `node:`-prefixed-only
 * entries (see PREFIX_ONLY_BUILTINS below). cts tracks only bare names, so the
 * prefixed ones are appended here rather than being absent.
 */
function allBuiltinModules(): string[] {
    const bare = getBuiltinModules();
    const missing = PREFIX_ONLY_BUILTINS.filter((name) => !bare.includes(name));
    return missing.length === 0 ? bare : [...bare, ...missing];
}
export const builtinModules: string[] = new Proxy(builtinModulesTarget, {
    get: (_t, key) => Reflect.get(allBuiltinModules(), key),
    has: (_t, key) => key in allBuiltinModules(),
    ownKeys: () => Reflect.ownKeys(allBuiltinModules()),
    getOwnPropertyDescriptor: (_t, key) => {
        const desc = Object.getOwnPropertyDescriptor(allBuiltinModules(), key);
        return desc ? { ...desc, configurable: true } : undefined;
    },
});

// cts keys its CJS cache with forward slashes; require.resolve() hands back host
// paths, so translate both directions or Windows lookups always miss.
const isWindowsHost = path.sep === '\\';
const toCacheKey = (key: string): string => isWindowsHost ? key.replace(/\\/g, '/') : key;
const toHostCacheKey = (key: string): string => isWindowsHost ? key.replace(/\//g, '\\') : key;
const moduleCacheTarget: Record<string, unknown> = {};
let defaultCacheDetached = false;

function detachDefaultCache(): void {
    if (defaultCacheDetached) return;
    for (const key of Reflect.ownKeys(moduleCacheTarget)) {
        Reflect.deleteProperty(moduleCacheTarget, key);
    }
    const cache = getCtsInternal()?.cache;
    if (cache) {
        for (const key of cache.keys()) {
            Reflect.set(moduleCacheTarget, toHostCacheKey(key), cache.get(key));
        }
    }
    defaultCacheDetached = true;
}

export const _cache: Record<string, unknown> = new Proxy(moduleCacheTarget, {
    has: (target, key) => {
        if (typeof key !== 'string') return Reflect.has(target, key);
        return defaultCacheDetached
            ? Reflect.has(target, key)
            : (getCtsInternal()?.cache.has(toCacheKey(key)) ?? false);
    },
    get: (target, key, receiver) => {
        if (typeof key !== 'string') return Reflect.get(target, key, receiver);
        return defaultCacheDetached
            ? Reflect.get(target, key, receiver)
            : getCtsInternal()?.cache.get(toCacheKey(key));
    },
    set: (target, key, value) => {
        if (typeof key !== 'string') return Reflect.set(target, key, value);
        if (defaultCacheDetached) return Reflect.set(target, key, value);
        getCtsInternal()?.cache.set(toCacheKey(key), value);
        return true;
    },
    deleteProperty: (target, key) => {
        if (typeof key !== 'string') return Reflect.deleteProperty(target, key);
        if (defaultCacheDetached) return Reflect.deleteProperty(target, key);
        getCtsInternal()?.cache.delete(toCacheKey(key));
        return true;
    },
    ownKeys: (target) => {
        if (defaultCacheDetached) return Reflect.ownKeys(target);
        const ctsInternal = getCtsInternal();
        return ctsInternal
            ? [...ctsInternal.cache.keys()].map(toHostCacheKey)
            : [];
    },
    getOwnPropertyDescriptor: (target, key) => {
        if (defaultCacheDetached) return Reflect.getOwnPropertyDescriptor(target, key);
        const ctsInternal = getCtsInternal();
        if (typeof key !== 'string') return undefined;
        const cacheKey = toCacheKey(key);
        if (!ctsInternal?.cache.has(cacheKey)) return undefined;
        return { value: ctsInternal.cache.get(cacheKey), writable: true, enumerable: true, configurable: true };
    },
});

/**
 * The single process-wide extension table. Node guarantees
 * `Module._extensions === require.extensions === createRequire(x).extensions`;
 * `_extensionsStore` is that object and `_load` dispatches through it.
 */
export const _extensions: RequireExtensionMap = _extensionsStore;

// A saved default cache object must become independent after replacement.  If
// it is assigned back, use its current entries as the loader's default store.
let cacheRef: Record<string, unknown> | undefined;
const _cacheRef = (): Record<string, unknown> => cacheRef ?? _cache;
const setCacheRef = (value: Record<string, unknown>): void => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        throw new TypeError('Module._cache must be an object');
    }
    const next = value === _cache ? undefined : value;
    const interop = getCtsInternal()?.nodeModuleInterop;
    if (next === undefined) {
        if (defaultCacheDetached) interop?.resetCache?.(moduleCacheTarget);
        else interop?.resetCache?.();
        cacheRef = undefined;
        defaultCacheDetached = false;
        return;
    }
    detachDefaultCache();
    interop?.replaceCache?.(next);
    cacheRef = next;
};

function readSource(filename: string): string {
    return engine.decodeString(fs.readFile(filename));
}

/**
 * Node's default `.js` loader reads the file and calls `module._compile`.
 * pirates (and therefore ts-node / @babel/register) wraps `module._compile` and
 * then calls the *previous* handler, so this must go through `_compile` — if it
 * delegated straight to cts the wrapper would never fire.
 */
const defaultJsExtension = function (module: Module, filename: string): void {
    module._compile(readSource(filename), filename);
};
const defaultJsonExtension = function (module: Module, filename: string): void {
    try {
        module.exports = JSON.parse(readSource(filename));
    } catch (e) {
        throw Object.assign(new SyntaxError(`${filename}: ${(e as Error).message}`), { code: 'ERR_INVALID_JSON' });
    }
};
const defaultNodeExtension = function (module: Module, filename: string): void {
    // Native addons have no JS-side loader; cts owns dlopen().
    module.exports = rawRequire(filename)(filename);
};

_extensionsStore['.js'] = defaultJsExtension;
_extensionsStore['.json'] = defaultJsonExtension;
_extensionsStore['.node'] = defaultNodeExtension;
defaultExtensionHandlers.add(defaultJsExtension);
defaultExtensionHandlers.add(defaultJsonExtension);
defaultExtensionHandlers.add(defaultNodeExtension);

interface SourceMapPayload {
    version?: number;
    file?: string;
    sources?: string[];
    sourcesContent?: (string | null)[];
    names?: string[];
    mappings?: string;
    sourceRoot?: string;
}

interface SourceMapEntry {
    generatedLine: number;
    generatedColumn: number;
    originalSource?: string;
    originalLine?: number;
    originalColumn?: number;
    name?: string;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Minimal VLQ decoder so SourceMap.findEntry() works without native help. */
function decodeVlq(segment: string): number[] {
    const out: number[] = [];
    let value = 0;
    let shift = 0;
    for (const char of segment) {
        const digit = BASE64_CHARS.indexOf(char);
        if (digit < 0) return out;
        value += (digit & 31) << shift;
        if (digit & 32) {
            shift += 5;
            continue;
        }
        const negative = value & 1;
        value >>= 1;
        out.push(negative ? -value : value);
        value = 0;
        shift = 0;
    }
    return out;
}

export class SourceMap {
    #payload: SourceMapPayload;
    #lineLengths: readonly number[] | undefined;
    #entries: SourceMapEntry[] | undefined;

    // Node declares only the payload parameter, so keep the reported arity at 1.
    constructor(payload: SourceMapPayload, ...rest: [options?: { lineLengths?: number[] }]) {
        this.#payload = payload;
        this.#lineLengths = rest[0]?.lineLengths;
    }

    get payload(): SourceMapPayload {
        return this.#payload;
    }

    get lineLengths(): readonly number[] | undefined {
        return this.#lineLengths;
    }

    #decode(): SourceMapEntry[] {
        if (this.#entries) return this.#entries;
        const entries: SourceMapEntry[] = [];
        const sources = this.#payload.sources ?? [];
        const names = this.#payload.names ?? [];
        let sourceIndex = 0;
        let originalLine = 0;
        let originalColumn = 0;
        let nameIndex = 0;
        const lines = (this.#payload.mappings ?? '').split(';');
        for (let generatedLine = 0; generatedLine < lines.length; generatedLine++) {
            let generatedColumn = 0;
            for (const segment of lines[generatedLine]!.split(',')) {
                if (segment === '') continue;
                const fields = decodeVlq(segment);
                if (fields.length === 0) continue;
                generatedColumn += fields[0]!;
                const entry: SourceMapEntry = { generatedLine, generatedColumn };
                if (fields.length >= 4) {
                    sourceIndex += fields[1]!;
                    originalLine += fields[2]!;
                    originalColumn += fields[3]!;
                    entry.originalSource = sources[sourceIndex];
                    entry.originalLine = originalLine;
                    entry.originalColumn = originalColumn;
                    if (fields.length >= 5) {
                        nameIndex += fields[4]!;
                        entry.name = names[nameIndex];
                    }
                }
                entries.push(entry);
            }
        }
        this.#entries = entries;
        return entries;
    }

    /** Node clamps to the closest preceding entry rather than reporting a miss. */
    findEntry(lineOffset: number, columnOffset: number): SourceMapEntry | Record<string, never> {
        const entries = this.#decode();
        let found: SourceMapEntry | undefined;
        for (const entry of entries) {
            if (entry.generatedLine > lineOffset) break;
            if (entry.generatedLine === lineOffset && entry.generatedColumn > columnOffset) break;
            found = entry;
        }
        return found ?? {};
    }

    findOrigin(lineNumber: number, columnNumber: number): { name?: string; fileName?: string; lineNumber?: number; columnNumber?: number } {
        const entry = this.findEntry(lineNumber - 1, columnNumber) as SourceMapEntry;
        if (entry.originalSource === undefined || entry.generatedLine !== lineNumber - 1) return {};
        return {
            name: entry.name,
            fileName: entry.originalSource,
            lineNumber: (entry.originalLine ?? 0) + 1,
            columnNumber: entry.originalColumn ?? 0,
        };
    }
}

type ResolveContext = { parentURL?: string; conditions?: string[]; importAttributes?: Record<string, string> };
type ResolveResult = { url: string; format?: string | null; shortCircuit?: boolean };
type LoadContext = { format?: string | null; conditions?: string[]; importAttributes?: Record<string, string> };
type LoadResult = { format?: string | null; source?: string | null; shortCircuit?: boolean };
type ResolveHook = (spec: string, ctx: ResolveContext, next: (s: string, c?: ResolveContext) => ResolveResult) => ResolveResult;
type LoadHook = (url: string, ctx: LoadContext, next: (u: string, c?: LoadContext) => LoadResult) => LoadResult;

const resolveHooks: ResolveHook[] = [];
const loadHooks: LoadHook[] = [];

function hasRegisteredResolveHooks(): boolean {
    return getCtsInternal()?.hasModuleResolveHooks?.() ?? resolveHooks.length > 0;
}

function hasRegisteredLoadHooks(): boolean {
    return getCtsInternal()?.hasModuleLoadHooks?.() ?? loadHooks.length > 0;
}

/**
 * Synchronous loader hooks. Node runs the most recently registered hook first
 * and each hook calls next() to reach the default behaviour, so the chain is
 * built by wrapping outwards.
 */
export function registerHooks(hooks: { load?: LoadHook; resolve?: ResolveHook }): { deregister: () => void } {
    const resolve = hooks?.resolve;
    const load = hooks?.load;
    if (resolve) resolveHooks.push(resolve);
    if (load) loadHooks.push(load);
    const ctsController = getCtsInternal()?.registerModuleHooks?.({ resolve, load });
    let active = true;
    return {
        deregister: () => {
            if (!active) return;
            active = false;
            if (resolve) {
                const i = resolveHooks.indexOf(resolve);
                if (i !== -1) resolveHooks.splice(i, 1);
            }
            if (load) {
                const i = loadHooks.indexOf(load);
                if (i !== -1) loadHooks.splice(i, 1);
            }
            ctsController?.deregister();
        },
    };
}

function runResolveChain(spec: string, ctx: ResolveContext, terminal: (s: string, c: ResolveContext) => ResolveResult): ResolveResult {
    let next: (s: string, c?: ResolveContext) => ResolveResult = (s, c) => terminal(s, c ?? ctx);
    for (let i = 0; i < resolveHooks.length; i++) {
        const hook = resolveHooks[i]!;
        const downstream = next;
        next = (s, c) => hook(s, c ?? ctx, downstream);
    }
    return next(spec, ctx);
}

function runLoadChain(url: string, ctx: LoadContext, terminal: (u: string, c: LoadContext) => LoadResult): LoadResult {
    let next: (u: string, c?: LoadContext) => LoadResult = (u, c) => terminal(u, c ?? ctx);
    for (let i = 0; i < loadHooks.length; i++) {
        const hook = loadHooks[i]!;
        const downstream = next;
        next = (u, c) => hook(u, c ?? ctx, downstream);
    }
    return next(url, ctx);
}

/** file: URL for a host path — hooks receive and return URLs, not paths. */
function toFileUrl(p: string): string {
    if (p.startsWith('file:') || isBuiltin(p)) return p;
    return pathToFileURL(p).href;
}

function fromFileUrl(u: string): string {
    if (!u.startsWith('file:')) return u;
    try { return fileURLToPath(u); } catch { return u; }
}

function formatForPath(p: string): string {
    const ext = path.extname(p);
    if (ext === '.mjs') return 'module';
    if (ext === '.json') return 'json';
    if (ext === '.node') return 'addon';
    return 'commonjs';
}

export function findSourceMap(_path: string, _error?: Error): SourceMap | undefined {
    return undefined;
}

/**
 * Walk up from a file URL/absolute path to the nearest package.json.
 * Node requires a file: URL when the first argument is not a bare specifier.
 */
export function findPackageJSON(specifier: string | URL, base?: string | URL): string | undefined {
    const anchor = base ?? specifier;
    let start: string;
    if (anchor instanceof URL || (typeof anchor === 'string' && anchor.startsWith('file:'))) {
        start = fileURLToPath(anchor);
    } else if (typeof anchor === 'string' && isAbsolutePath(anchor)) {
        throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
    } else {
        throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
    }

    let dir = dirname(start);
    while (true) {
        const candidate = join(dir, 'package.json');
        if (fs.exists(candidate)) return candidate;
        const up = dirname(dir);
        if (up === dir) return undefined;
        dir = up;
    }
}

export const globalPaths: string[] = [];

/** cts owns the real bytecode cache; mirror its directory through Node's API. */
function getEnv(name: string): string | undefined {
    try {
        // os.getenv throws when the variable is unset.
        const value = os.getenv(name);
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

function defaultCompileCacheDir(): string {
    const override = getEnv('CTS_CACHE_DIR');
    if (override) return override;
    const home = String(os.homeDir || getEnv('USERPROFILE') || getEnv('HOME') || '');
    return home ? join(home, '.cts') : join(os.cwd, '.cts');
}

let compileCacheDir: string | undefined;

export function enableCompileCache(cacheDir?: string): { status: number; directory?: string; message?: string } {
    const status = compileCacheDir !== undefined
        ? constants.compileCacheStatus.ALREADY_ENABLED
        : constants.compileCacheStatus.ENABLED;
    compileCacheDir = cacheDir ?? compileCacheDir ?? defaultCompileCacheDir();
    return { status, directory: compileCacheDir };
}

export function getCompileCacheDir(): string | undefined {
    return compileCacheDir;
}

export function flushCompileCache(): void {}

/** See PREFIX_ONLY_BUILTINS near builtinModules for why the bare form is false. */
export function isBuiltin(moduleName: string): boolean {
    if (typeof moduleName !== 'string') return false;
    if (PREFIX_ONLY_BUILTINS.includes(moduleName)) return true;
    // A bare name matching a prefix-only builtin is NOT a builtin, per Node.
    if (!moduleName.startsWith('node:') && PREFIX_ONLY_BUILTINS.includes(`node:${moduleName}`)) {
        return false;
    }
    const bare = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
    return getBuiltinModules().includes(bare);
}

export function syncBuiltinESMExports(): void {}

/** Node returns null for builtins and the parent directory list otherwise. */
export function _resolveLookupPaths(request: string, parent?: { paths?: string[]; filename?: string } | null): string[] | null {
    if (isBuiltin(request)) return null;
    if (request.startsWith('./') || request.startsWith('../') || request === '.' || request === '..') {
        const from = parent?.filename;
        return [from ? dirname(from) : os.cwd];
    }
    return parent?.paths ?? _nodeModulePaths(os.cwd);
}

/**
 * The CJS load funnel. Patching this (require-in-the-middle, APM agents) is
 * observable for every require produced by `createRequire`.
 *
 * Fast path: with no hooks and a pristine extension table, delegate straight to
 * cts so the bytecode cache, TS transform and ESM interop all keep working.
 * Slow path: only once user code registers a hook or an extension handler.
 */
export function _load(request: string, parent?: { filename?: string } | null, isMain?: boolean): unknown {
    const rawParent = parent?.filename ?? join(os.cwd, '__cno_module__.js');
    const parentPath = isAbsolutePath(rawParent) ? rawParent : resolvePath(rawParent);

    if (isBuiltin(request)) return rawRequire(parentPath)(request);

    if (!needsJsLoadPath()) return rawRequire(parentPath)(request);

    let filename: string;
    try {
        // Through Module._resolveFilename, not the local binding: a patched
        // resolver must be consulted, and must be counted.
        filename = Module._resolveFilename(request, { filename: parentPath }, isMain);
    } catch {
        // Unresolvable by us (npm:/jsr:/http: and other cts-only specifiers) —
        // hand the original request back to cts rather than failing the load.
        return rawRequire(parentPath)(request);
    }

    const cache = Module._cache as Record<string, unknown>;
    const cached = cache[filename];
    if (cached !== undefined) return (cached as { exports?: unknown }).exports;

    const extTable = Module._extensions as RequireExtensionMap;
    const ext = path.extname(filename);
    const handler = extTable[ext];

    // No handler for this extension: cts still knows how to load it (.ts, .mjs,
    // ESM, wasm). Only take over when a handler actually exists.
    if (typeof handler !== 'function') return rawRequire(parentPath)(request);

    const mod = new Module(filename, null);
    mod.filename = filename;
    cache[filename] = mod;
    try {
        if (hasRegisteredLoadHooks()) {
            const context: LoadContext = { format: formatForPath(filename) };
            const terminal = (u: string, c: LoadContext): LoadResult => ({
                format: c.format ?? formatForPath(fromFileUrl(u)),
                source: null,
                shortCircuit: true,
            });
            const ctsInternal = getCtsInternal();
            const result = ctsInternal?.runModuleLoadHooks
                ? ctsInternal.runModuleLoadHooks(toFileUrl(filename), context, terminal)
                : runLoadChain(toFileUrl(filename), context, terminal);
            if (typeof result.source === 'string') {
                if (result.format === 'json') mod.exports = JSON.parse(result.source);
                else if (result.format === 'module') {
                    throw Object.assign(
                        new Error(`Cannot require() ESM returned by a load hook: ${filename}`),
                        { code: 'ERR_REQUIRE_ESM' },
                    );
                } else mod._compile(result.source, filename);
                mod.loaded = true;
                return mod.exports;
            }
        }
        handler(mod, filename);
        mod.loaded = true;
        return mod.exports;
    } catch (e) {
        delete cache[filename];
        // A `.js` file that is really ESM cannot be wrapped as CJS. Compilation
        // fails before any of its code runs, so there are no side effects to
        // double and cts (which handles ESM, and require(esm) interop) can retry.
        // Guard on untouched exports so a genuine SyntaxError inside a module
        // that already started executing still propagates.
        const untouched = mod.exports !== null && typeof mod.exports === 'object'
            && Object.keys(mod.exports as object).length === 0;
        if (e instanceof SyntaxError && untouched) return rawRequire(parentPath)(request);
        throw e;
    }
}

export function _findPath(request: string, paths?: string[], _isMain?: boolean): string | false {
    try {
        return _resolveFilename(request, undefined, false, paths ? { paths } : undefined);
    } catch {
        return false;
    }
}

export function _initPaths(): void {}

export const _pathCache: Record<string, string> = {};

let sourceMapsSupport = { enabled: false, nodeModules: false, generatedCode: false };

export function getSourceMapsSupport(): { enabled: boolean; nodeModules: boolean; generatedCode: boolean } {
    return { ...sourceMapsSupport };
}

export function setSourceMapsSupport(enabled: boolean, options?: { nodeModules?: boolean; generatedCode?: boolean }): void {
    if (typeof enabled !== 'boolean') {
        throw Object.assign(new TypeError('The "enabled" argument must be of type boolean.'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    sourceMapsSupport = {
        enabled,
        nodeModules: options?.nodeModules ?? false,
        generatedCode: options?.generatedCode ?? false,
    };
}

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
        // Through _load so a patched _load sees module.require() too.
        return Module._load(id, this, false);
    }

    /** Node's Module.prototype.load: resolve, run, and mark the module loaded. */
    load(filename: string): void {
        this.filename = filename;
        this.path = dirname(filename);
        this.paths = _nodeModulePaths(this.path);
        const abs = isAbsolutePath(filename) ? filename : resolvePath(filename);
        const handler = _extensionsRef()[path.extname(abs)];
        if (typeof handler === 'function' && !defaultExtensionHandlers.has(handler)) {
            // User-registered handler owns compilation and assigns module.exports.
            handler(this, abs);
        } else {
            this.exports = Module._load(abs, { filename: abs }, false);
        }
        this.loaded = true;
    }

    get isPreloading(): boolean {
        return false;
    }

    _compile(code: string, filename: string): void {
        const wrapper = Module.wrap(code);
        const fn: unknown = (0, eval)(wrapper);
        if (typeof fn !== 'function') {
            throw new TypeError('Compiled CommonJS wrapper must be a function');
        }
        const abs = isAbsolutePath(filename) ? filename : resolvePath(filename);
        const require = createRequire(abs);
        // Node calls the wrapper with `this === module.exports`.
        Reflect.apply(fn as CommonJSWrapper, this.exports, [this.exports, require, this, abs, dirname(abs)]);
    }

    static wrap = wrap;

    static wrapper = wrapper;

    static _cache: Record<string, unknown> = {};

    static _pathCache = _pathCache;

    static _nodeModulePaths = _nodeModulePaths;

    static _resolveFilename = _resolveFilename;

    static _resolveLookupPaths = _resolveLookupPaths;

    static _load = _load;

    static _findPath = _findPath;

    static _initPaths = _initPaths;

    static isBuiltin = isBuiltin;

    static createRequire = createRequire;

    static _preloadModules = _preloadModules;

    static runMain = runMain;

    static syncBuiltinESMExports = syncBuiltinESMExports;

    static findSourceMap = findSourceMap;

    static findPackageJSON = findPackageJSON;

    static SourceMap = SourceMap;

    static constants = constants;

    static enableCompileCache = enableCompileCache;

    static getCompileCacheDir = getCompileCacheDir;

    static flushCompileCache = flushCompileCache;

    static getSourceMapsSupport = getSourceMapsSupport;

    static setSourceMapsSupport = setSourceMapsSupport;

    static registerHooks = registerHooks;

    static globalPaths = globalPaths;

    static register(_specifier: string | URL, _options?: { parentURL?: string; data?: unknown; transferList?: unknown[] }): void {
        // ESM loader hook registration — not yet implemented
    }
}

// Live cache proxy — settable so `Module._cache = {}` works and require.cache follows.
Object.defineProperty(Module, '_cache', {
    get: () => _cacheRef(),
    set: (value) => setCacheRef(value as Record<string, unknown>),
    enumerable: true,
    configurable: true,
});

Object.defineProperty(Module, '_extensions', {
    get: () => _extensionsRef(),
    set: (value) => setExtensionsRef(value as RequireExtensionMap),
    enumerable: true,
    configurable: true,
});

// Node exposes the same table under the public `extensions` alias too.
Object.defineProperty(Module, 'extensions', {
    get: () => _extensionsRef(),
    set: (value) => setExtensionsRef(value as RequireExtensionMap),
    enumerable: true,
    configurable: true,
});

/**
 * Connect the process-wide Node views to CTS' CJS loader.  The callbacks are
 * intentionally live: Node permits replacing `Module._cache` or
 * `Module._extensions`, and every `require()` created by CTS must observe the
 * replacement just like `createRequire()` does.
 */
const ctsNodeModuleInterop = getCtsInternal()?.nodeModuleInterop;
if (ctsNodeModuleInterop) {
    ctsNodeModuleInterop.getCache = () => _cacheRef();
    ctsNodeModuleInterop.getExtensions = () => _extensionsRef();
    ctsNodeModuleInterop.setCache = (value) => setCacheRef(value);
    ctsNodeModuleInterop.setExtensions = (value) => setExtensionsRef(value);
    ctsNodeModuleInterop.cacheIsDefault = () => cacheRef === undefined;
    ctsNodeModuleInterop.extensionsAreDefault = () => extensionsRef === undefined;
    ctsNodeModuleInterop.defaultExtensions = {
        '.js': defaultJsExtension,
        '.json': defaultJsonExtension,
        '.node': defaultNodeExtension,
    };
}

// Baseline for patch detection. Must be read after the class body exists, and
// after the statics are installed, or every load takes the JS path.
pristineResolveFilename = Module._resolveFilename;
pristinePrototypeCompile = Module.prototype._compile;

Object.defineProperty(Module, 'builtinModules', {
    // Node exposes the same array through both `module.builtinModules` and
    // `Module.builtinModules`.  Keep the prefix-only entries (node:test,
    // node:sqlite, ...) and the live CTS-backed view on both paths.
    get: () => builtinModules,
    enumerable: true,
    configurable: true,
});

Object.defineProperty(Module, 'stripTypeScriptTypes', {
    value: stripTypeScriptTypes,
    writable: true,
    enumerable: true,
    configurable: true,
});

export const _compile = (content: string, filename: string): unknown => {
    const mod = new Module(filename);
    mod._compile(content, filename);
    return mod.exports;
};

export const register = Module.register;

/**
 * Node strips TS types in-process; cno has no in-runtime TS transformer reachable
 * from here, so only the erasable subset (types on declarations) is handled.
 */
export function stripTypeScriptTypes(code: string, _options?: { mode?: 'strip' | 'transform'; sourceMap?: boolean; sourceUrl?: string }): string {
    if (typeof code !== 'string') {
        throw Object.assign(new TypeError('The "code" argument must be of type string.'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    throw Object.assign(
        new Error('stripTypeScriptTypes is not supported: no in-runtime TypeScript transformer is reachable from node:module'),
        { code: 'ERR_NOT_SUPPORTED' },
    );
}
