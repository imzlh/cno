// @ts-check
import { transform, type Transform, type Options } from 'sucrase';

const engine = import.meta.use('engine');
const sys = import.meta.use('sys');
const fs = import.meta.use('fs');
const os = import.meta.use('os');
const smap = import.meta.use('sourcemap');
const console = import.meta.use('console');
const xhr = import.meta.use('xhr');

/**
 * Read a text file synchronously
 */
function readTextFile(path: string): string {
    const buffer = fs.readFile(path);
    return engine.decodeString(buffer);
}

/**
 * Get error message safely
 */
const errMsg = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    return String(e);
};

/**
 * Package.json structure
 */
interface PackageJson {
    name?: string;
    version?: string;
    main?: string;
    module?: string;
    exports?: string | Record<string, any>;
    type?: 'module' | 'commonjs';
}

/**
 * Module resolution cache entry
 */
interface CacheEntry {
    resolved: string;
    timestamp: number;
}

/**
 * Runtime configuration
 */
interface RuntimeConfig {
    /** Cache directory for remote modules (JSR, HTTP) */
    cacheDir?: string | undefined;
    /** Enable HTTP module loading */
    enableHttp?: boolean;
    /** Enable JSR module loading */
    enableJsr?: boolean;
    /** Enable Node.js compatibility layer */
    enableNode?: boolean;
    /** Silent mode - suppress download logs */
    silent?: boolean;
}

/**
 * JSR package metadata
 */
interface JsrPackageMeta {
    versions: Record<string, {
        yanked?: boolean;
    }>;
    latest?: string;
}

/**
 * JSR version metadata
 */
interface JsrVersionMeta {
    manifest: Record<string, {
        size: number;
        checksum: string;
    }>;
    exports?: Record<string, string>;
}

/**
 * Simple URL parser (since URL API might not be available)
 */
class SimpleUrl {
    protocol: string;
    host: string;
    pathname: string;
    search: string;
    hash: string;

    constructor(url: string) {
        const protocolMatch = url.match(/^([a-z]+):\/\//);
        if (!protocolMatch) {
            throw new Error(`Invalid URL: ${url}`);
        }

        this.protocol = protocolMatch[1]!;
        let rest = url.substring(protocolMatch[0]!.length);

        // Extract hash
        const hashIndex = rest.indexOf('#');
        if (hashIndex !== -1) {
            this.hash = rest.substring(hashIndex);
            rest = rest.substring(0, hashIndex);
        } else {
            this.hash = '';
        }

        // Extract search
        const searchIndex = rest.indexOf('?');
        if (searchIndex !== -1) {
            this.search = rest.substring(searchIndex);
            rest = rest.substring(0, searchIndex);
        } else {
            this.search = '';
        }

        // Extract host and pathname
        const pathIndex = rest.indexOf('/');
        if (pathIndex !== -1) {
            this.host = rest.substring(0, pathIndex);
            this.pathname = rest.substring(pathIndex);
        } else {
            this.host = rest;
            this.pathname = '/';
        }
    }
}

/**
 * TypeScript Runtime for QuickJS/tjs environment
 * Provides seamless TypeScript/TSX/JSX module loading using Sucrase
 */
class TypeScriptRuntime {
    /** Supported file extensions */
    private readonly extensions = new Set(['.ts', '.tsx', '.jsx', '.js', '.mjs', '.cjs']);
    
    /** Module resolution cache */
    private readonly resolutionCache = new Map<string, CacheEntry>();
    
    /** Runtime configuration */
    private readonly config: RuntimeConfig;
    
    /** JSR registry URL */
    private readonly jsrRegistry = 'https://jsr.io';
    
    /** Map of resolved paths to their original URLs (for relative resolution) */
    private readonly urlMap = new Map<string, string>();
    
    /** Node.js builtin modules resolver */
    private nodeResolver: ((name: string) => string | null) | null = null;
    
    /** Enable source maps */
    private readonly sourceMapEnabled: boolean = true;
    
    /** Sucrase transform options */
    private readonly transformOptions: Partial<Options> = {
        disableESTransforms: true,
        preserveDynamicImport: true,
        production: false,
    };

    private mainScript: string | null = null;

    constructor(config: RuntimeConfig = {}) {
        this.config = {
            enableHttp: config.enableHttp ?? true,
            enableJsr: config.enableJsr ?? true,
            enableNode: config.enableNode ?? true,
            cacheDir: config.cacheDir ?? this.getDefaultCacheDir(),
            silent: config.silent ?? false,
        };
        
        // Ensure cache directory exists
        if (this.config.cacheDir) {
            this.ensureDir(this.config.cacheDir);
        }
        
        this.setupModuleLoader();
    }

    /**
     * Get default cache directory (like Deno)
     */
    private getDefaultCacheDir(): string {
        // Try to get home directory
        const home = os.homedir || (sys.platform === 'win32' ? 'C:\\Users\\Default' : '/root');
        return this.joinPaths(home, '.tjs', 'cache');
    }

    /**
     * Register Node.js builtin modules resolver
     * This allows extending the runtime with Node.js compatibility layer
     * 
     * @param resolver Function that resolves node: imports to file paths
     * @example
     * runtime.registerNodeResolver((name) => {
     *   const builtins = { 'fs': '/path/to/node/fs.js', 'path': '/path/to/node/path.js' };
     *   return builtins[name] || null;
     * });
     */
    public registerNodeResolver(resolver: (name: string) => string | null): void {
        this.nodeResolver = resolver;
    }

    /**
     * Log download activity
     */
    private logDownload(message: string): void {
        if (!this.config.silent) {
            console.log(`📦 ${message}`);
        }
    }

    /**
     * Set up the QuickJS module loader hooks
     */
    private setupModuleLoader(): void {
        engine.onModule({
            resolve: (name: string, parent: string): string => {
                try {
                    const resolved = this.resolveModule(name, parent);
                    return fs.realpath(resolved);
                } catch (error) {
                    throw new Error(`Cannot resolve module "${name}" from "${parent}": ${errMsg(error)}`);
                }
            },
            load: (resolvedName: string) => {
                return this.loadModule(resolvedName);
            },
            init: (name: string, importMeta: Record<string, any>): void => {
                importMeta.url = `file://${name}`;
                importMeta.filename = name;
                importMeta.dirname = this.dirname(name);
                if (!this.mainScript){
                    importMeta.main = true;
                    this.mainScript = name;
                }else{
                    importMeta.main = false;
                }
            }
        });
    }

    /**
     * Resolve module path based on import specifier
     */
    private resolveModule(name: string, parent: string): string {
        // Check cache first
        const cacheKey = `${name}::${parent}`;
        const cached = this.resolutionCache.get(cacheKey);
        if (cached) {
            return cached.resolved;
        }

        let resolved: string;

        // Handle node: protocol
        if (name.startsWith('node:')) {
            if (!this.config.enableNode) {
                throw new Error('Node.js compatibility layer is disabled');
            }
            resolved = this.resolveNode(name);
        }
        // Handle HTTP(S) URLs
        else if (name.startsWith('http://') || name.startsWith('https://')) {
            if (!this.config.enableHttp) {
                throw new Error('HTTP module loading is disabled');
            }
            resolved = this.resolveHttp(name);
        }
        // Handle JSR imports
        else if (name.startsWith('jsr:')) {
            if (!this.config.enableJsr) {
                throw new Error('JSR module loading is disabled');
            }
            resolved = this.resolveJsr(name, parent);
        }
        // Handle relative paths
        else if (name.startsWith('./') || name.startsWith('../')) {
            // Check if parent is a remote module
            const parentUrl = this.urlMap.get(parent);
            if (parentUrl) {
                // Parent is remote, resolve relative to it
                resolved = this.resolveRemoteRelative(name, parentUrl, parent);
            } else {
                // Normal file system resolution
                resolved = this.resolveRelative(name, parent);
            }
        }
        // Handle absolute paths
        else if (name.startsWith('/')) {
            resolved = this.resolveAbsolute(name);
        }
        // Handle package imports
        else {
            resolved = this.resolvePackage(name, parent);
        }

        // Cache the resolution
        this.resolutionCache.set(cacheKey, {
            resolved,
            timestamp: Date.now()
        });

        return resolved;
    }

    /**
     * Resolve node: protocol imports
     * Format: node:module_name
     * Examples:
     *   node:fs
     *   node:path
     *   node:util
     */
    private resolveNode(specifier: string): string {
        const moduleName = specifier.substring(5); // Remove 'node:' prefix
        
        // Check if custom resolver is registered
        if (this.nodeResolver) {
            const resolved = this.nodeResolver(moduleName);
            if (resolved) {
                return resolved;
            }
        }
        
        // Try default node cache directory
        const nodeCacheDir = this.joinPaths(this.config.cacheDir!, 'node');
        const defaultPath = this.joinPaths(nodeCacheDir, moduleName);
        
        try {
            return this.tryResolveFile(defaultPath);
        } catch (e) {
            throw new Error(
                `Node.js module "${moduleName}" not found. ` +
                `Please install it to ${nodeCacheDir}/ or register a custom resolver using runtime.registerNodeResolver()`
            );
        }
    }

    /**
     * Resolve relative import from a remote module
     */
    private resolveRemoteRelative(name: string, parentUrl: string, parentPath: string): string {
        if (parentUrl.startsWith('jsr:')) {
            // JSR relative import
            return this.resolveJsrRelative(name, parentUrl, parentPath);
        } else if (parentUrl.startsWith('http://') || parentUrl.startsWith('https://')) {
            // HTTP relative import
            return this.resolveHttpRelative(name, parentUrl);
        }
        throw new Error(`Unknown remote protocol for ${parentUrl}`);
    }

    /**
     * Resolve relative import within JSR package
     */
    private resolveJsrRelative(relativePath: string, parentJsrUrl: string, parentPath: string): string {
        // Parent is a JSR module, find its package directory
        const parentDir = this.dirname(parentPath);
        
        // Resolve relative to parent directory
        const resolvedPath = this.normalizePath(this.joinPaths(parentDir, relativePath));
        
        // Try to resolve with extensions
        return this.tryResolveFile(resolvedPath);
    }

    /**
     * Resolve relative import from HTTP URL
     */
    private resolveHttpRelative(relativePath: string, parentUrl: string): string {
        // Parse parent URL
        const url = new SimpleUrl(parentUrl);
        const parentDir = url.pathname.substring(0, url.pathname.lastIndexOf('/'));
        
        // Resolve relative path
        const resolvedPath = this.normalizePath(this.joinPaths(parentDir, relativePath));
        
        // Construct new URL
        const newUrl = `${url.protocol}://${url.host}${resolvedPath}`;
        
        return this.resolveHttp(newUrl);
    }

    /**
     * Resolve HTTP(S) module
     */
    private resolveHttp(url: string): string {
        try {
            // Check cache first
            const cachedPath = this.getHttpCachePath(url);
            if (fs.exists(cachedPath)) {
                // Track URL mapping
                this.urlMap.set(cachedPath, url);
                return cachedPath;
            }

            // Log download activity
            this.logDownload(`Downloading ${url}`);

            // Fetch via synchronous XHR
            const content = this.fetchSync(url);
            
            // Save to cache
            this.ensureDir(this.dirname(cachedPath));
            const encoded = engine.encodeString(content);
            fs.writeFile(cachedPath, encoded.buffer);
            
            // Track URL mapping
            this.urlMap.set(cachedPath, url);
            
            return cachedPath;
        } catch (error) {
            throw new Error(`Failed to resolve HTTP module ${url}: ${errMsg(error)}`);
        }
    }

    /**
     * Resolve JSR module
     * Format: jsr:@scope/package[@version][/path]
     * Examples:
     *   jsr:@std/path
     *   jsr:@std/path@0.1.0
     *   jsr:@std/path@0.1.0/mod.ts
     */
    private resolveJsr(specifier: string, parent: string): string {
        try {
            const parsed = this.parseJsrSpecifier(specifier);
            
            // Get cached package directory
            let version = parsed.version;
            if (!version) {
                this.logDownload(`note: use latest version of @${parsed.scope}/${parsed.name}`);
                version = this.getJsrLatestVersion(parsed.scope, parsed.name);
            }
            
            const cachedPackageDir = this.getJsrCachePath(parsed.scope, parsed.name, version);
            
            // If package is not cached, download it
            if (!fs.exists(cachedPackageDir)) {
                this.logDownload(`Downloading jsr:@${parsed.scope}/${parsed.name}@${version}`);
                this.downloadJsrPackage(parsed.scope, parsed.name, version, cachedPackageDir);
                if (!this.config.silent) {
                    console.log(`✓ Cached to ${cachedPackageDir}`);
                }
            }
            
            // Resolve the file path
            const resolvedPath = this.resolveJsrFile(cachedPackageDir, parsed.scope, parsed.name, version, parsed.path);
            
            // Track URL mapping for this file
            const jsrUrl = `jsr:@${parsed.scope}/${parsed.name}@${version}${parsed.path}`;
            this.urlMap.set(resolvedPath, jsrUrl);
            
            return resolvedPath;
        } catch (error) {
            throw new Error(`Failed to resolve JSR module ${specifier}: ${errMsg(error)}`);
        }
    }

    /**
     * Parse JSR specifier
     */
    private parseJsrSpecifier(specifier: string): {
        scope: string;
        name: string;
        version: string | null;
        path: string;
    } {
        // Remove jsr: prefix
        let rest = specifier.substring(4);
        
        // Parse @scope/name
        if (!rest.startsWith('@')) {
            throw new Error(`Invalid JSR specifier: ${specifier} (must start with @scope/name)`);
        }
        
        const match = rest.match(/^@([^\/]+)\/([^@\/]+)(?:@([^\/]+))?(\/.*)?$/);
        if (!match) {
            throw new Error(`Invalid JSR specifier format: ${specifier}`);
        }
        
        const [, scope, name, version, path] = match;
        
        return {
            scope: scope!,
            name: name!,
            version: version || null,
            path: path || ''
        };
    }

    /**
     * Get latest version of JSR package
     */
    private getJsrLatestVersion(scope: string, name: string): string {
        const metaUrl = `${this.jsrRegistry}/@${scope}/${name}/meta.json`;
        const metaJson = this.fetchSync(metaUrl);
        const meta: JsrPackageMeta = JSON.parse(metaJson);
        
        if (!meta.latest) {
            throw new Error(`No latest version found for @${scope}/${name}`);
        }
        
        return meta.latest;
    }

    /**
     * Download JSR package to cache
     */
    private downloadJsrPackage(scope: string, name: string, version: string, targetDir: string): void {
        // Get version metadata
        const versionUrl = `${this.jsrRegistry}/@${scope}/${name}/${version}_meta.json`;
        const versionJson = this.fetchSync(versionUrl);
        const versionMeta: JsrVersionMeta = JSON.parse(versionJson);
        
        // Create target directory
        this.ensureDir(targetDir);
        
        // Download all files in manifest
        for (const [filePath, fileInfo] of Object.entries(versionMeta.manifest)) {
            const fileUrl = `${this.jsrRegistry}/@${scope}/${name}/${version}/${filePath}`;
            const fileContent = this.fetchSync(fileUrl);
            
            const targetPath = this.joinPaths(targetDir, filePath);
            this.ensureDir(this.dirname(targetPath));
            const encoded = engine.encodeString(fileContent);
            fs.writeFile(targetPath, encoded.buffer);
        }
        
        // Save version metadata
        const metaPath = this.joinPaths(targetDir, '_meta.json');
        const encoded = engine.encodeString(versionJson);
        fs.writeFile(metaPath, encoded.buffer);
    }

    /**
     * Resolve file path within cached JSR package
     */
    private resolveJsrFile(packageDir: string, scope: string, name: string, version: string, path: string): string {
        // Load version metadata
        const metaPath = this.joinPaths(packageDir, '_meta.json');
        let versionMeta: JsrVersionMeta | null = null;
        
        if (fs.exists(metaPath)) {
            try {
                versionMeta = JSON.parse(readTextFile(metaPath));
            } catch (e) {
                // Ignore
            }
        }
        
        // If no path specified, use exports
        if (!path || path === '/' || path === '.') {
            if (versionMeta?.exports) {
                // Use default export
                const defaultExport = versionMeta.exports['.'] || versionMeta.exports['./mod.ts'];
                if (defaultExport) {
                    const exportPath = defaultExport.startsWith('./') ? defaultExport.substring(2) : defaultExport;
                    return this.joinPaths(packageDir, exportPath);
                }
            }
            // Fallback to common entry points
            const entryPoints = ['mod.ts', 'mod.js', 'index.ts', 'index.js'];
            for (const entry of entryPoints) {
                const entryPath = this.joinPaths(packageDir, entry);
                if (fs.exists(entryPath)) {
                    return entryPath;
                }
            }
            throw new Error(`No entry point found for @${scope}/${name}@${version}`);
        }
        
        // Resolve specific path
        const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
        const fullPath = this.joinPaths(packageDir, normalizedPath);
        
        // Try to resolve with extensions
        try {
            return this.tryResolveFile(fullPath);
        } catch (e) {
            // If not found, try without extension resolution (exact path)
            if (fs.exists(fullPath)) {
                return fullPath;
            }
            throw e;
        }
    }

    /**
     * Fetch URL synchronously using XHR
     */
    private fetchSync(url: string): string {
        try {
            const request = new xhr.XMLHttpRequest();
            request.open('GET', url, false); // false = synchronous
            request.send();
            
            if (request.status !== 200) {
                throw new Error(`HTTP ${request.status}: ${request.statusText}`);
            }
            
            return request.responseText;
        } catch (error) {
            throw new Error(`Failed to fetch ${url}: ${errMsg(error)}`);
        }
    }

    /**
     * Get cache path for HTTP module
     */
    private getHttpCachePath(url: string): string {
        // Parse URL to create a hierarchical cache structure
        const parsed = new SimpleUrl(url);
        const hash = this.hashString(url);
        const ext = this.getExtensionFromUrl(url);
        
        // Create path: cacheDir/http/host/hash.ext
        return this.joinPaths(this.config.cacheDir!, 'http', parsed.host, `${hash}${ext}`);
    }

    /**
     * Get cache path for JSR package
     */
    private getJsrCachePath(scope: string, name: string, version: string): string {
        return this.joinPaths(this.config.cacheDir!, 'jsr', scope, name, version);
    }

    /**
     * Simple string hash function
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Get file extension from URL
     */
    private getExtensionFromUrl(url: string): string {
        const path = url.split('?')[0]!.split('#')[0]!;
        const lastDot = path.lastIndexOf('.');
        const lastSlash = path.lastIndexOf('/');
        
        if (lastDot > lastSlash && lastDot > 0) {
            return path.substring(lastDot);
        }
        
        return '.js'; // Default extension
    }

    /**
     * Ensure directory exists (create if not)
     */
    private ensureDir(dir: string): void {
        if (fs.exists(dir)) {
            return;
        }
        
        // Create parent directories recursively
        const parent = this.dirname(dir);
        if (parent && parent !== dir && parent !== '.') {
            this.ensureDir(parent);
        }
        
        try {
            fs.mkdir(dir, 0o755);
        } catch (error) {
            // Ignore if directory already exists
            if (!fs.exists(dir)) {
                throw error;
            }
        }
    }

    /**
     * Resolve relative module path
     */
    private resolveRelative(name: string, parent: string): string {
        const parentDir = parent ? this.dirname(parent) : fs.getcwd();
        const fullPath = this.normalizePath(this.joinPaths(parentDir, name));
        return this.tryResolveFile(fullPath);
    }

    /**
     * Resolve absolute module path
     */
    private resolveAbsolute(name: string): string {
        return this.tryResolveFile(name);
    }

    /**
     * Resolve npm package import
     */
    private resolvePackage(name: string, parent: string): string {
        // Parse package name and subpath
        const { packageName, subpath } = this.parsePackageName(name);
        
        // Find package directory
        const packageDir = this.findPackageDir(packageName, parent);
        if (!packageDir) {
            throw new Error(`Package "${packageName}" not found`);
        }

        // Resolve subpath within package
        if (subpath) {
            // Check package.json exports field
            const exported = this.resolvePackageExports(packageDir, subpath);
            if (exported) {
                return exported;
            }
            
            // Fallback to direct subpath resolution
            const subpathFull = this.joinPaths(packageDir, subpath);
            return this.tryResolveFile(subpathFull);
        }

        // Resolve package main entry
        return this.resolvePackageMain(packageDir);
    }

    /**
     * Parse package name into name and subpath
     * Examples:
     *   "lodash" -> { packageName: "lodash", subpath: "" }
     *   "lodash/map" -> { packageName: "lodash", subpath: "./map" }
     *   "@scope/pkg" -> { packageName: "@scope/pkg", subpath: "" }
     *   "@scope/pkg/sub" -> { packageName: "@scope/pkg", subpath: "./sub" }
     */
    private parsePackageName(name: string): { packageName: string; subpath: string } {
        if (name.startsWith('@')) {
            // Scoped package
            const parts = name.split('/');
            if (parts.length < 2) {
                throw new Error(`Invalid scoped package name: ${name}`);
            }
            const packageName = `${parts[0]}/${parts[1]}`;
            const subpath = parts.slice(2).join('/');
            return { packageName, subpath: subpath ? `./${subpath}` : '' };
        } else {
            // Regular package
            const firstSlash = name.indexOf('/');
            if (firstSlash === -1) {
                return { packageName: name, subpath: '' };
            }
            const packageName = name.substring(0, firstSlash);
            const subpath = name.substring(firstSlash + 1);
            return { packageName, subpath: `./${subpath}` };
        }
    }

    /**
     * Find package directory in node_modules
     */
    private findPackageDir(packageName: string, parent: string): string | null {
        const searchPaths = this.getModuleSearchPaths(parent);
        
        for (const searchPath of searchPaths) {
            const packagePath = this.joinPaths(searchPath, packageName);
            if (fs.exists(packagePath)) {
                const stats = fs.stat(packagePath);
                if (stats.isDirectory) {
                    return packagePath;
                }
            }
        }
        
        return null;
    }

    /**
     * Get node_modules search paths
     */
    private getModuleSearchPaths(parent: string): string[] {
        const paths: string[] = [];
        
        if (parent) {
            let current = this.dirname(parent);
            const root = sys.platform === 'win32' ? current.split(':')[0] + ':/' : '/';
            
            while (current && current !== root) {
                const nodeModules = this.joinPaths(current, 'node_modules');
                if (fs.exists(nodeModules)) {
                    paths.push(nodeModules);
                }
                const parentDir = this.dirname(current);
                if (parentDir === current) break;
                current = parentDir;
            }
        }
        
        // Add current working directory node_modules
        const cwd = fs.getcwd();
        const cwdNodeModules = this.joinPaths(cwd, 'node_modules');
        if (!paths.includes(cwdNodeModules)) {
            paths.push(cwdNodeModules);
        }
        
        return paths;
    }

    /**
     * Resolve package.json exports field
     */
    private resolvePackageExports(packageDir: string, subpath: string): string | null {
        try {
            const pkgJsonPath = this.joinPaths(packageDir, 'package.json');
            if (!fs.exists(pkgJsonPath)) {
                return null;
            }
            
            const pkgJson: PackageJson = JSON.parse(readTextFile(pkgJsonPath));
            
            if (!pkgJson.exports) {
                return null;
            }
            
            // Simple exports field handling
            if (typeof pkgJson.exports === 'string') {
                if (subpath === '.' || subpath === '') {
                    return this.joinPaths(packageDir, pkgJson.exports);
                }
                return null;
            }
            
            // Object exports
            if (typeof pkgJson.exports === 'object') {
                // Direct match
                if (pkgJson.exports[subpath]) {
                    const exportPath = pkgJson.exports[subpath];
                    if (typeof exportPath === 'string') {
                        return this.joinPaths(packageDir, exportPath);
                    }
                    // Handle conditional exports (use default)
                    if (typeof exportPath === 'object' && exportPath.default) {
                        return this.joinPaths(packageDir, exportPath.default);
                    }
                }
                
                // Try with ./ prefix
                const withDot = subpath.startsWith('./') ? subpath : `./${subpath}`;
                if (pkgJson.exports[withDot]) {
                    const exportPath = pkgJson.exports[withDot];
                    if (typeof exportPath === 'string') {
                        return this.joinPaths(packageDir, exportPath);
                    }
                    if (typeof exportPath === 'object' && exportPath.default) {
                        return this.joinPaths(packageDir, exportPath.default);
                    }
                }
            }
        } catch (error) {
            // Ignore errors, fallback to other resolution methods
        }
        
        return null;
    }

    /**
     * Resolve package main entry point
     */
    private resolvePackageMain(packageDir: string): string {
        try {
            const pkgJsonPath = this.joinPaths(packageDir, 'package.json');
            if (fs.exists(pkgJsonPath)) {
                const pkgJson: PackageJson = JSON.parse(readTextFile(pkgJsonPath));
                
                // Try exports field first
                if (pkgJson.exports) {
                    const exported = this.resolvePackageExports(packageDir, '.');
                    if (exported) {
                        return this.tryResolveFile(exported);
                    }
                }
                
                // Try module field (ES modules)
                if (pkgJson.module) {
                    const modulePath = this.joinPaths(packageDir, pkgJson.module);
                    if (fs.exists(modulePath)) {
                        return modulePath;
                    }
                }
                
                // Try main field
                if (pkgJson.main) {
                    const mainPath = this.joinPaths(packageDir, pkgJson.main);
                    return this.tryResolveFile(mainPath);
                }
            }
        } catch (error) {
            // Fall through to default resolution
        }
        
        // Default to index files
        return this.tryResolveFile(this.joinPaths(packageDir, 'index'));
    }

    /**
     * Try to resolve a file path with various extensions
     */
    private tryResolveFile(basePath: string): string {
        // Try exact path first
        if (fs.exists(basePath)) {
            const stats = fs.stat(basePath);
            if (stats.isFile) {
                return basePath;
            }
            // If directory, try index files
            if (stats.isDirectory) {
                return this.tryResolveFile(this.joinPaths(basePath, 'index'));
            }
        }
        
        // Try with extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
        for (const ext of extensions) {
            const pathWithExt = basePath + ext;
            if (fs.exists(pathWithExt)) {
                return pathWithExt;
            }
        }
        
        // Try index files in directory
        const indexPaths = [
            this.joinPaths(basePath, 'index.ts'),
            this.joinPaths(basePath, 'index.tsx'),
            this.joinPaths(basePath, 'index.js'),
            this.joinPaths(basePath, 'index.jsx'),
        ];
        
        for (const indexPath of indexPaths) {
            if (fs.exists(indexPath)) {
                return indexPath;
            }
        }
        
        throw new Error(`Cannot find module: ${basePath}`);
    }

    private isMain(scr: string){
        if (this.mainScript) return false;
        this.mainScript = scr;
        return true;
    }

    /**
     * Load and transform a module
     */
    private loadModule(resolvedName: string): CModuleEngine.Module {
        if (!fs.exists(resolvedName)) {
            throw new Error(`Module not found: ${resolvedName}`);
        }

        const stats = fs.stat(resolvedName);
        if (stats.isDirectory) {
            return this.loadModule(this.resolvePackageMain(resolvedName));
        }

        // Read source code
        const sourceCode = readTextFile(resolvedName);

        // Transform based on file extension
        let transformedCode: string;
        const ext = this.getExtension(resolvedName);

        switch (ext) {
            case '.ts':
                transformedCode = this.transformTypeScript(sourceCode, resolvedName, false);
                break;
            case '.tsx':
                transformedCode = this.transformTypeScript(sourceCode, resolvedName, true);
                break;
            case '.jsx':
                transformedCode = this.transformJSX(sourceCode, resolvedName);
                break;
            case '.json':
                transformedCode = `export default ${sourceCode};`;
                break;
            case '.mjs':
            case '.cjs':
            case '.js':
            default:
                transformedCode = sourceCode;
                break;
        }

        // Create module
        const module = new engine.Module(transformedCode, resolvedName);
        
        // Set module metadata
        Object.assign(module.meta, {
            use: import.meta.use,
            filename: resolvedName,
            dirname: this.dirname(resolvedName),
            url: `file://${resolvedName}`,
            main: this.isMain(resolvedName)
        });

        return module;
    }

    /**
     * Transform TypeScript code to JavaScript
     */
    private transformTypeScript(code: string, filename: string, jsx: boolean): string {
        try {
            const transforms: Transform[] = ['typescript'];
            if (jsx) {
                transforms.push('jsx');
            }

            const result = transform(code, {
                transforms,
                jsxPragma: 'React.createElement',
                jsxFragmentPragma: 'React.Fragment',
                enableLegacyTypeScriptModuleInterop: false,
                filePath: filename,
                ...this.transformOptions,
            });

            // Load source map if enabled
            if (this.sourceMapEnabled && result.sourceMap) {
                try {
                    smap.load(filename, result.sourceMap);
                } catch (error) {
                    console.warn(`Failed to load source map for ${filename}:`, error);
                }
            }

            return result.code;
        } catch (error) {
            throw new Error(`TypeScript transformation failed in ${filename}: ${errMsg(error)}`);
        }
    }

    /**
     * Transform JSX code to JavaScript
     */
    private transformJSX(code: string, filename: string): string {
        try {
            const result = transform(code, {
                transforms: ['jsx'],
                jsxPragma: 'React.createElement',
                jsxFragmentPragma: 'React.Fragment',
                filePath: filename,
                ...this.transformOptions,
            });

            // Load source map if enabled
            if (this.sourceMapEnabled && result.sourceMap) {
                try {
                    smap.load(filename, result.sourceMap);
                } catch (error) {
                    console.warn(`Failed to load source map for ${filename}:`, error);
                }
            }

            return result.code;
        } catch (error) {
            throw new Error(`JSX transformation failed in ${filename}: ${errMsg(error)}`);
        }
    }

    /**
     * Get file extension
     */
    private getExtension(path: string): string {
        const lastDot = path.lastIndexOf('.');
        return lastDot > 0 ? path.substring(lastDot) : '';
    }

    /**
     * Get directory name from path
     */
    private dirname(path: string): string {
        const normalized = path.replace(/\\/g, '/');
        const lastSlash = normalized.lastIndexOf('/');
        return lastSlash > 0 ? normalized.substring(0, lastSlash) : '.';
    }

    /**
     * Join path segments
     */
    private joinPaths(...segments: string[]): string {
        return segments
            .filter(Boolean)
            .join('/')
            .replace(/\/+/g, '/');
    }

    /**
     * Normalize path (resolve . and ..)
     */
    private normalizePath(path: string): string {
        const parts = path.split('/').filter(p => p && p !== '.');
        const result: string[] = [];
        
        for (const part of parts) {
            if (part === '..') {
                if (result.length > 0 && result[result.length - 1] !== '..') {
                    result.pop();
                } else if (!path.startsWith('/')) {
                    result.push('..');
                }
            } else {
                result.push(part);
            }
        }
        
        let normalized = result.join('/');
        if (path.startsWith('/') && !normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        
        return normalized || '.';
    }

    /**
     * Clear resolution cache
     */
    public clearCache(): void {
        this.resolutionCache.clear();
    }
}

// Create and initialize runtime
const runtime = new TypeScriptRuntime({
    enableHttp: true,
    enableJsr: true,
    enableNode: true,
    silent: false, // Set to true to suppress download logs
    // Cache directory defaults to ~/.tjs/cache (like Deno uses ~/.deno)
    // You can override it:
    // cacheDir: '/custom/cache/path'
});

/**
 * Example: Register Node.js builtin modules resolver
 * 
 * runtime.registerNodeResolver((name) => {
 *   const nodeModulesPath = runtime.config.cacheDir + '/node';
 *   const builtins = {
 *     'fs': nodeModulesPath + '/fs.js',
 *     'path': nodeModulesPath + '/path.js',
 *     'util': nodeModulesPath + '/util.js',
 *   };
 *   return builtins[name] || null;
 * });
 */

/**
 * Main entry point
 */
async function main(): Promise<void> {
    if (sys.args.length < 2) {
        console.log('TypeScript Runtime for tjs');
        console.log('');
        console.log('Usage: cjs <file.ts> [args...]');
        console.log('');
        console.log('Built-in Features:');
        console.log('  • TypeScript/TSX/JSX support');
        console.log('  • HTTP(S) imports: https://deno.land/std/...');
        console.log('  • JSR imports: jsr:@std/path');
        console.log('  • Node.js compatibility: node:fs');
        console.log('  • npm packages from node_modules');
        os.exit(0);
        return;
    }

    let entryFile = sys.args.splice(1, 1)[0]!;
    
    // Resolve entry file path
    if (entryFile[0] != '.' && entryFile[0] != '/') {
        entryFile = fs.realpath(entryFile);
    }

    try {
        // Import and execute the entry file
        await import(entryFile);
    } catch (error) {
        console.error('\n❌ Runtime error:', errMsg(error));
        if (error instanceof Error && error.stack) {
            console.error(error.stack);
        }
        os.exit(1);
    }
}

// Run main and handle errors
main().catch((error) => {
    console.error('\n❌ Fatal error:', errMsg(error));
    if (error instanceof Error && error.stack) {
        console.error(error.stack);
    }
    os.exit(1);
});