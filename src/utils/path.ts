import { isPosixCompatible } from "./platform";

export const systemPathSplit = isPosixCompatible ? '/' : '\\';

/** Convert a path to POSIX separators. */
export function toPosixPath(p: string): string {
    return p.includes('\\') ? p.replace(/\\/g, '/') : p;
}

export function join(...parts: string[]): string {
    let path = '';
    for (const p of parts) {
        if (!p) continue;
        if (path) path += systemPathSplit;
        path += p;
    }
    return normalize(path);
}

export function dirname(path: string): string {
    const i = path.lastIndexOf('\\');
    const j = path.lastIndexOf('/');
    const k = Math.max(i, j);
    if (k < 0) return '.';
    if (k === 0) return path[0] === '/' ? '/' : '.';
    const dir = path.slice(0, k);
    // On Windows, "C:" (without trailing slash) means "current dir on C:",
    // not the root.  Ensure we always return "C:\" for drive-root children.
    if (!isPosixCompatible && /^[a-zA-Z]:$/.test(dir)) return dir + systemPathSplit;
    return dir;
}


export function getExtension(path: string): string {
    const i = path.lastIndexOf('.');
    const j = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return i > j ? path.slice(i) : '';
}

export function normalize(path: string): string {
    const abs = isPosixCompatible ? path[0] == '/' : /^[A-Za-z]{1,2}\:[\/\\]/.test(path);
    const out: string[] = [];
    let cur = '';
    let startPos = 0;

    // Windows 绝对路径：保留盘符（如 C:）
    if (!isPosixCompatible && abs) {
        const colonIdx = path.indexOf(':');
        out.push(path.substring(0, colonIdx + 1));
        startPos = colonIdx + 2;  // 跳过 C:\
    }
    // POSIX 绝对路径：跳过开头的 /
    else if (abs) {
        startPos = 1;
    }

    for (let i = startPos; i <= path.length; i++) {
        const ch = i < path.length ? path[i] : systemPathSplit;
        if (ch === '/' || ch === '\\') {
            if (cur === '..') {
                if (out.length && out[out.length - 1] !== '..') out.pop();
                else if (!abs) out.push('..');
            } else if (cur && cur !== '.') {
                out.push(cur);
            }
            cur = '';
        } else {
            cur += ch;
        }
    }

    return out.join(systemPathSplit) || '.';
}