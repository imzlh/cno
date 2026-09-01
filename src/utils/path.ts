import { isPosixCompatible } from "./platform";

export const systemPathSplit = isPosixCompatible ? '/' : '\\';

/** Convert a path to POSIX separators. */
export function toPosixPath(p: string): string {
    return p.includes('\\') ? p.replace(/\\/g, '/') : p;
}

/** Convert a path to the host platform's separator spelling. */
export function toSystemPath(p: string): string {
    return systemPathSplit === '/' ? p : p.replace(/\//g, '\\');
}

export interface PathRootParts {
    root: string;
    parts: string[];
}

/**
 * Convert a Deno filesystem path argument to the native path spelling.
 *
 * This intentionally only handles URL objects. A string beginning with
 * `file:` is still a filename to Deno's filesystem APIs.
 */
export function toFsPath(value: string | URL): string {
    if (!(value instanceof URL)) return value;
    if (value.protocol !== 'file:') throw new TypeError('Must be a file URL');
    // Convert URL separators before decoding. An encoded %2F is a filename
    // character from the URL's point of view and must stay / on Windows.
    const pathname = isPosixCompatible ? value.pathname : value.pathname.replace(/\//g, '\\');
    // Preserve malformed percent escapes as literal filename characters, but
    // keep URIError for malformed UTF-8 sequences. Deno distinguishes these:
    // `%zz` names a missing literal path while `%E0%A4%A` is malformed URI.
    const escaped = pathname.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
    let path = decodeURIComponent(escaped);
    if (!isPosixCompatible) {
        const host = value.hostname;
        if (host && host !== 'localhost') {
            return `\\\\${host}${path}`;
        }
        if (path.length >= 3 && path[0] === '\\' && path[2] === ':') {
            path = path.slice(1);
        }
    } else if (value.hostname && value.hostname !== 'localhost') {
        throw new TypeError('File URL host must be empty or localhost');
    }
    return path;
}

/**
 * Split a path into a non-creatable filesystem root and its path segments.
 * This is shared by every recursive directory creator in the compatibility
 * layer. The returned root is never passed to mkdir.
 */
export function splitPathRoot(path: string): PathRootParts {
    // A backslash is a valid filename character on POSIX. Only Windows needs
    // separator conversion here; callers that explicitly need slash spelling
    // should use toPosixPath themselves.
    const normalized = isPosixCompatible ? path : toPosixPath(path);
    const split = (rest: string): string[] => rest.split('/').filter(Boolean);

    // Verbatim/device namespace: //?/D:/x, //?/UNC/server/share/x, //./pipe/x
    const verbatim = !isPosixCompatible ? normalized.match(/^\/\/([?.])\//) : null;
    if (verbatim) {
        const prefix = verbatim[0];
        const body = normalized.slice(prefix.length);
        const unc = body.match(/^UNC\/[^/]+\/[^/]+/i);
        if (unc) {
            return { root: `${prefix}${unc[0]}/`, parts: split(body.slice(unc[0].length)) };
        }
        const drive = body.match(/^[A-Za-z]:\//);
        if (drive) {
            return {
                root: `${prefix}${drive[0].replace(/\/?$/, '/')}`,
                parts: split(body.slice(drive[0].length)),
            };
        }
        const driveRelative = body.match(/^[A-Za-z]:/);
        if (driveRelative) {
            return { root: `${prefix}${driveRelative[0]}`, parts: split(body.slice(driveRelative[0].length)) };
        }
        // Unknown device paths are not safe to walk segment by segment.
        return { root: normalized, parts: [] };
    }

    // UNC share root: //server/share is not creatable.
    const unc = !isPosixCompatible ? normalized.match(/^\/\/[^/]+\/[^/]+/) : null;
    if (unc) {
        return { root: `${unc[0]}/`, parts: split(normalized.slice(unc[0].length)) };
    }

    const drive = !isPosixCompatible ? normalized.match(/^[A-Za-z]:\//) : null;
    if (drive) {
        return {
            root: drive[0].replace(/\/?$/, '/'),
            parts: split(normalized.slice(drive[0].length)),
        };
    }

    // Drive-relative paths (C:foo) keep the drive as their anchor.
    const driveRelative = !isPosixCompatible ? normalized.match(/^[A-Za-z]:/) : null;
    if (driveRelative) {
        return { root: driveRelative[0], parts: split(normalized.slice(driveRelative[0].length)) };
    }

    if (normalized.startsWith('/')) return { root: '/', parts: split(normalized.slice(1)) };
    return { root: '', parts: split(normalized) };
}

export function appendPathPart(base: string, part: string): string {
    if (!base) return part;
    if (/^[A-Za-z]:$/.test(base)) return `${base}${part}`;
    const hasSeparator = isPosixCompatible ? base.endsWith('/') : /[\\/]$/.test(base);
    return hasSeparator ? `${base}${part}` : `${base}${systemPathSplit}${part}`;
}

/** Yield each path that must exist before the complete path can be created. */
export function* pathParents(path: string): Generator<string> {
    const { root, parts } = splitPathRoot(normalize(path));
    // splitPathRoot uses slash spelling internally. Native fs calls need the
    // host separator spelling, including the root.
    let current = toSystemPath(root);
    for (const part of parts) {
        if (part === '.') continue;
        current = appendPathPart(current, part);
        // Leading `..` components name directories that already exist. They
        // remain in the accumulated path so a later child is addressed
        // correctly, but are never themselves passed to mkdir.
        if (part !== '..') yield current;
    }
}

export function isAbsolutePath(path: string): boolean {
    if (isPosixCompatible) return path.startsWith('/');
    return path.startsWith('/') || path.startsWith('\\') || (isDrivePath(path) && /^[A-Za-z]:[\\/]/.test(path));
}

export function isDrivePath(path: string): boolean {
    return !isPosixCompatible && /^[A-Za-z]:/.test(path);
}

/** Windows drive-relative paths are not absolute, but still escape a WASI root. */
export function isRootedOrDrivePath(path: string): boolean {
    return isAbsolutePath(path) || isDrivePath(path);
}

export function resolvePath(path: string, cwd: string): string {
    if (isAbsolutePath(path)) {
        if (!isPosixCompatible && (path.startsWith('/') || path.startsWith('\\'))
            && !isDrivePath(path) && !path.startsWith('\\\\') && !path.startsWith('//')) {
            // A single leading separator is rooted on the current drive, or
            // on the current UNC/device share when cwd has one.
            const cwdRoot = toSystemPath(splitPathRoot(cwd).root);
            return normalize(cwdRoot ? cwdRoot + path : path);
        }
        return normalize(path);
    }
    if (!isPosixCompatible && isDrivePath(path)) {
        const drive = path.slice(0, 2);
        const cwdOnDrive = /^[A-Za-z]:[\\/]/.test(cwd)
            && cwd.slice(0, 2).toLowerCase() === drive.toLowerCase();
        const base = cwdOnDrive ? cwd : `${drive}${systemPathSplit}`;
        const tail = path.slice(2);
        return normalize(tail ? appendPathPart(base, tail) : base);
    }
    return normalize(join(cwd, path));
}

export function resolveFsPath(value: string | URL, cwd: string): string {
    return resolvePath(toFsPath(value), cwd);
}

/** Lexical containment check for paths already resolved to the same host. */
export function isPathWithin(parent: string, child: string): boolean {
    const normalizedParent = normalize(parent);
    const normalizedChild = normalize(child);
    if (isPosixCompatible) {
        // `normalize('/work/')` deliberately preserves the trailing slash for
        // filesystem callers.  It must not become an extra separator in the
        // containment prefix.
        const parentKey = normalizedParent === '/'
            ? normalizedParent
            : normalizedParent.replace(/\/+$/, '');
        return parentKey === '/'
            ? normalizedChild.startsWith('/')
            : normalizedChild === parentKey
                || normalizedChild.startsWith(`${parentKey}/`);
    }
    const parentKey = (normalizedParent.length > 3
        ? normalizedParent.replace(/[\\/]$/, '')
        : normalizedParent).toLowerCase();
    const childKey = normalizedChild.toLowerCase();
    return childKey === parentKey
        || (parentKey.endsWith('\\') ? childKey.startsWith(parentKey) : childKey.startsWith(`${parentKey}\\`));
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

function isPathSeparator(path: string, index: number): boolean {
    return path[index] === '/' || (!isPosixCompatible && path[index] === '\\');
}

function isWindowsShareRoot(path: string): boolean {
    const normalized = toPosixPath(path);
    return /^\/\/[^/]+\/[^/]+$/.test(normalized)
        || /^\/\/[?.]\/[A-Za-z]:$/.test(normalized);
}

function isWindowsVerbatimUncRoot(path: string): boolean {
    return /^\/\/[?.]\/UNC\/[^/]+\/[^/]+$/.test(toPosixPath(path));
}

export function dirname(path: string): string {
    if (path.length === 0) return '.';
    let end = path.length;
    while (end > 0 && isPathSeparator(path, end - 1)) end--;
    if (end === 0) return isPosixCompatible ? '/' : systemPathSplit;

    const trimmed = path.slice(0, end);
    if (!isPosixCompatible && /^[A-Za-z]:$/.test(trimmed)) {
        return /^[A-Za-z]:[\\/]/.test(path) ? `${trimmed}${systemPathSplit}` : trimmed;
    }
    if (!isPosixCompatible && isWindowsVerbatimUncRoot(trimmed)) {
        // Win32 dirname() keeps an extended UNC share root without adding a
        // trailing separator, unlike a normal UNC share root.
        return path.length === end ? trimmed : trimmed + systemPathSplit;
    }
    if (!isPosixCompatible && isWindowsShareRoot(trimmed)) {
        return path.length === end ? trimmed : `${trimmed}${systemPathSplit}`;
    }

    let k = -1;
    for (let i = end - 1; i >= 0; i--) {
        if (isPathSeparator(path, i)) {
            k = i;
            break;
        }
    }
    if (k < 0) {
        return !isPosixCompatible && /^[A-Za-z]:/.test(trimmed) ? trimmed.slice(0, 2) : '.';
    }
    if (k === 0) return isPosixCompatible ? '/' : systemPathSplit;
    const dir = path.slice(0, k);
    // On Windows, "C:" (without trailing slash) means "current dir on C:",
    // not the root.  Ensure we always return "C:\" for drive-root children.
    if (!isPosixCompatible && /^[a-zA-Z]:$/.test(dir)) return dir + systemPathSplit;
    if (!isPosixCompatible && isWindowsShareRoot(dir)) return dir + systemPathSplit;
    return dir;
}

export function basename(path: string): string {
    const end = (isPosixCompatible ? path.replace(/\/+$/, '') : path.replace(/[\\/]+$/, '')).length;
    if (end === 0) return '';
    const trimmed = path.slice(0, end);
    if (!isPosixCompatible && /^[A-Za-z]:$/.test(trimmed)) return '';
    const i = isPosixCompatible
        ? path.lastIndexOf('/', end - 1)
        : Math.max(path.lastIndexOf('\\', end - 1), path.lastIndexOf('/', end - 1));
    if (i < 0 && !isPosixCompatible && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(2);
    return path.slice(i + 1, end);
}


export function getExtension(path: string): string {
    const i = path.lastIndexOf('.');
    const j = isPosixCompatible ? path.lastIndexOf('/') : Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return i > j ? path.slice(i) : '';
}

export function normalize(path: string): string {
    const { root, parts } = splitPathRoot(path);
    const out: string[] = [];
    const rooted = root !== '' && !/^[A-Za-z]:$/.test(root);
    const hasTrailingSeparator = isPosixCompatible
        ? path.endsWith('/')
        : /[\\/]$/.test(path);

    for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!rooted) out.push('..');
            continue;
        }
        out.push(part);
    }

    const body = out.join('/');
    let result: string;
    if (root) {
        if (/^[A-Za-z]:$/.test(root)) {
            result = body ? `${root}${body}` : `${root}.`;
            if (hasTrailingSeparator && body) result += '/';
        } else {
            result = root.endsWith('/')
                ? `${root}${body}`
                : body ? `${root}/${body}` : root;
            if (hasTrailingSeparator && body && !result.endsWith('/')) {
                result += '/';
            }
        }
    } else {
        result = body || '.';
        if (hasTrailingSeparator && body) result += '/';
        else if (hasTrailingSeparator && result === '.') result += '/';
    }
    if (systemPathSplit === '\\') result = result.replace(/\//g, '\\');
    return result;
}
