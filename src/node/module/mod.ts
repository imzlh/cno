/**
 * Node.js module module
 * Based on cts CJS loader via cts.internal symbol
 */

import { fileURLToPath } from '../url';

const CTS_INTERNAL = (globalThis as any)[Symbol.for('cts.internal')] as {
    mkRequire: (parentPath: string, parentMod: any) => NodeJS.Require;
    builtinModules: string[];
    cache: Map<string, any>;
} | undefined;

export interface SourceMap {
    payload: any;
    lineLengths: readonly number[];
}

export function createRequire(filename: string | URL): NodeJS.Require {
    const parentPath = filename instanceof URL ? fileURLToPath(filename) : filename;
    if (CTS_INTERNAL) {
        return CTS_INTERNAL.mkRequire(parentPath, undefined);
    }
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

export const builtinModules: string[] = CTS_INTERNAL?.builtinModules ?? [];

export const _cache: Record<string, any> = CTS_INTERNAL?.cache
    ? Object.fromEntries(CTS_INTERNAL.cache) as Record<string, any>
    : {};

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
    return builtinModules.includes(moduleName) || builtinModules.includes(moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName);
}

export function syncBuiltinESMExports(): void {}

export const _compile = (_content: string, _filename: string): any => undefined;
