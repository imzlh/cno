const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
import path from '../path';
import { fileURLToPath } from '../url';
import { nodeEnvEntriesToObject, parseNodeEnvEntries } from './dotenv';

const { resolve: resolvePath } = path;

export type EnvFilePath = string | URL | Uint8Array;

function safeGetEnv(name: string): string | undefined {
    try {
        return os.getenv(name) ?? undefined;
    } catch {
        return undefined;
    }
}

function isWindowsPlatform(): boolean {
    return os.platform === 'windows' || os.platform === 'win32';
}

function isRootedOrDrivePath(value: string): boolean {
    if (!isWindowsPlatform()) return value.startsWith('/');
    return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value);
}

function pathFromStringOrUrl(path: EnvFilePath): string {
    if (path instanceof URL) return fileURLToPath(path, { windows: isWindowsPlatform() });
    return path instanceof Uint8Array ? engine.decodeString(path) : path;
}

export function resolveEnvFilePath(path: EnvFilePath): string {
    const value = pathFromStringOrUrl(path);
    const isWindows = isWindowsPlatform();
    if (isRootedOrDrivePath(value)) return isWindows ? value.replace(/\//g, '\\') : value;
    if (/^[a-z][a-z0-9+\-.]*:/i.test(value) && !value.startsWith('/')) return value;
    const normalized = value.replace(/\\/g, '/');
    if (normalized.startsWith('/')) return normalized;
    const resolved = resolvePath(os.cwd, normalized);
    return isWindows ? resolved.replace(/\//g, '\\') : resolved;
}

function applyNodeVars(vars: Iterable<readonly [string, string]>): void {
    for (const [key, value] of vars) {
        if (safeGetEnv(key) === undefined) os.setenv(key, value);
    }
}

export function loadNodeEnvFile(path: EnvFilePath = '.env'): Record<string, string> {
    const resolved = resolveEnvFilePath(path);
    const text = engine.decodeString(fs.readFile(resolved));
    const parsed = parseNodeEnvEntries(text);
    applyNodeVars(parsed);
    return nodeEnvEntriesToObject(parsed);
}
