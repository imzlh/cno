const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

export type EnvWarn = (message: string) => void;
export type EnvFilePath = string | URL | Uint8Array;

function safeGetEnv(name: string): string | undefined {
    try {
        return os.getenv(name) ?? undefined;
    } catch {
        return undefined;
    }
}

function pathFromUrl(url: URL): string {
    if (url.protocol !== 'file:') throw new TypeError('Expected a file URL');
    const raw = url.href.startsWith('file:///') ? url.href.slice(7) : url.pathname;
    if (/^\/[A-Za-z]:\//.test(raw)) return decodeURIComponent(raw.slice(1)).replace(/\//g, '\\');
    return decodeURIComponent(raw);
}

function pathFromStringOrUrl(path: EnvFilePath): string {
    if (path instanceof URL) return pathFromUrl(path);
    return path instanceof Uint8Array ? engine.decodeString(path) : path;
}

export function resolveEnvFilePath(path: EnvFilePath): string {
    const value = pathFromStringOrUrl(path);
    const isWindows = os.uname().sysname === 'Windows_NT';
    if (/^[A-Za-z]:[\\/]/.test(value)) return isWindows ? value.replace(/\//g, '\\') : value;
    if (/^[a-z][a-z0-9+\-.]*:/i.test(value) && !value.startsWith('/')) return value;
    const normalized = value.replace(/\\/g, '/');
    if (normalized.startsWith('/')) return normalized;
    const resolved = `${os.cwd}/${normalized}`;
    return isWindows ? resolved.replace(/\//g, '\\') : resolved;
}

function expandEnv(value: string, vars: Record<string, string>): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        return vars[name] ?? safeGetEnv(name) ?? '';
    });
}

function parseEnvText(text: string, path: string, base: Record<string, string>, warn?: EnvWarn): Record<string, string> | null {
    const vars = { ...base };
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;

        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
        if (!match) {
            warn?.(`Failed to parse env file "${path}" at line ${i + 1}`);
            return null;
        }

        let value = match[2] ?? '';
        if (value.startsWith('"')) {
            value = value.slice(1);
            while (!value.includes('"')) {
                const next = lines[++i];
                if (next === undefined) {
                    warn?.(`Failed to parse env file "${path}" at line ${i + 1}`);
                    return null;
                }
                value += `\n${next}`;
            }
            const end = value.indexOf('"');
            const rest = value.slice(end + 1).trim();
            if (rest !== '' && !rest.startsWith('#')) {
                warn?.(`Failed to parse env file "${path}" at line ${i + 1}`);
                return null;
            }
            value = value.slice(0, end);
        } else {
            const comment = value.search(/\s#/);
            if (comment !== -1) value = value.slice(0, comment);
            value = value.trim();
            if (/\\(?![\\#$"'nrt])/u.test(value)) {
                warn?.(`Failed to parse env file "${path}" at line ${i + 1}`);
                return null;
            }
        }

        vars[match[1]!] = expandEnv(value, vars);
    }
    return vars;
}

function applyVars(vars: Record<string, string>): void {
    for (const key of Object.keys(vars)) os.setenv(key, vars[key]!);
}

function quotedValueEnd(value: string, quote: string): number {
    for (let i = 0; i < value.length; i++) {
        if (value[i] !== quote) continue;
        let escapes = 0;
        for (let j = i - 1; j >= 0 && value[j] === '\\'; j--) escapes++;
        if (quote === "'" || escapes % 2 === 0) return i;
    }
    return -1;
}

function parseNodeEnvText(text: string): Record<string, string> {
    const vars: Record<string, string> = {};
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        let raw = lines[i]!;
        if (/^\s*export\s+/.test(raw)) raw = raw.replace(/^\s*export\s+/, '');
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
        if (!match) continue;

        let value = match[2] ?? '';
        const quote = value[0];
        if (quote === '"' || quote === "'" || quote === '`') {
            value = value.slice(1);
            let end = quotedValueEnd(value, quote);
            while (end === -1 && i + 1 < lines.length) {
                value += `\n${lines[++i]}`;
                end = quotedValueEnd(value, quote);
            }
            if (end !== -1) value = value.slice(0, end);
            if (quote === '"') {
                value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
                    .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
        } else {
            const comment = value.indexOf('#');
            if (comment !== -1) value = value.slice(0, comment);
            value = value.trim();
        }
        vars[match[1]!] = value;
    }
    return vars;
}

function applyNodeVars(vars: Record<string, string>): void {
    for (const key of Object.keys(vars)) {
        if (safeGetEnv(key) === undefined) os.setenv(key, vars[key]!);
    }
}

export function loadNodeEnvFile(path: EnvFilePath = '.env'): Record<string, string> {
    const resolved = resolveEnvFilePath(path);
    const text = engine.decodeString(fs.readFile(resolved));
    const parsed = parseNodeEnvText(text);
    applyNodeVars(parsed);
    return parsed;
}

export function loadEnvFile(path: string | URL = '.env', warn?: EnvWarn, base: Record<string, string> = {}): Record<string, string> | null {
    const displayPath = pathFromStringOrUrl(path);
    const resolved = resolveEnvFilePath(path);
    try {
        const text = engine.decodeString(fs.readFile(resolved));
        const parsed = parseEnvText(text, displayPath, base, warn);
        if (parsed === null) return null;
        applyVars(parsed);
        return parsed;
    } catch (e) {
        warn?.(`Failed to load env file "${displayPath}": ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

export function loadEnvFiles(paths: Array<string | URL>, warn?: EnvWarn): void {
    let vars: Record<string, string> = {};
    for (const path of paths) {
        const parsed = loadEnvFile(path, warn, vars);
        if (parsed !== null) vars = parsed;
    }
}
