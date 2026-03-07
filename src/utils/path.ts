export function join(...parts: string[]): string {
    let path = '';
    for (const p of parts) {
        if (!p) continue;
        if (path) path += '/';
        path += p;
    }
    return normalize(path);
}

export function dirname(path: string): string {
    const i = path.lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : '.';
}

export function getExtension(path: string): string {
    const i = path.lastIndexOf('.');
    const j = path.lastIndexOf('/');
    return i > j ? path.slice(i) : '';
}

export function normalize(path: string): string {
    const abs = path[0] === '/';
    const out: string[] = [];
    let cur = '';
    
    for (let i = abs ? 1 : 0; i <= path.length; i++) {
        const ch = i < path.length ? path[i] : '/';
        if (ch === '/') {
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
    
    return (abs ? '/' : '') + out.join('/') || '.';
}