/**
 * Node.js module module (stub)
 * Module system utilities
 */

export interface SourceMap {
    payload: any;
    lineLengths: readonly number[];
}

export function createRequire(filename: string | URL): NodeJS.Require {
    return require;
}

export function runMain(): void {}

export function wrap(code: string): string {
    return `(function(exports, require, module, __filename, __dirname) { ${code}\n});`;
}

export function _nodeModulePaths(from: string): string[] {
    return [];
}

export function _pathFilename(filename: string): string {
    return filename;
}

export const builtinModules: string[] = [];

export const _cache: Record<string, any> = {};

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
    return builtinModules.includes(moduleName);
}

export function syncBuiltinESMExports(): void {}

export const _compile = (_content: string, _filename: string): any => undefined;
