const os = import.meta.use('os');

type FormatInputPathObject = {
    root?: string;
    dir?: string;
    base?: string;
    ext?: string;
    name?: string;
};

type ParsedPath = {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
};

type PathApi = {
    sep: '/' | '\\';
    delimiter: ':' | ';';
    _makeLong(path: string): string;
    basename(path: string, suffix?: string): string;
    dirname(path: string): string;
    extname(path: string): string;
    format(pathObject: FormatInputPathObject): string;
    isAbsolute(path: string): boolean;
    join(...paths: string[]): string;
    normalize(path: string): string;
    parse(path: string): ParsedPath;
    relative(from: string, to: string): string;
    resolve(...paths: string[]): string;
    toNamespacedPath(path: string): string;
    posix?: PathApi;
    win32?: PathApi;
};

type RootInfo = {
    absolute: boolean;
    root: string;
    rest: string;
};

function assertString(value: unknown, name: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`The "${name}" argument must be of type string`);
    }
    return value;
}

function assertPathObject(value: unknown): FormatInputPathObject {
    if (value === null || typeof value !== 'object') {
        throw new TypeError('The "pathObject" argument must be of type object');
    }
    return value;
}

function getCwd(): string {
    const proc = Reflect.get(globalThis, 'process');
    const cwd = (proc && (typeof proc === 'object' || typeof proc === 'function'))
        ? Reflect.get(proc, 'cwd')
        : undefined;
    if (typeof cwd === 'function') return String(Reflect.apply(cwd, proc, []));
    try {
        return String(os.cwd);
    } catch {
        return '/';
    }
}

function isWindowsPathSeparator(ch: string): boolean {
    return ch === '\\' || ch === '/';
}

function normalizeSlashes(path: string, windows: boolean): string {
    return windows ? path.replace(/\//g, '\\') : path.replace(/\\/g, '/');
}

function splitPosixRoot(path: string): RootInfo {
    if (path.startsWith('/')) {
        return { absolute: true, root: '/', rest: path.slice(1) };
    }
    return { absolute: false, root: '', rest: path };
}

function splitWin32Root(path: string): RootInfo {
    const unc = path.match(/^(\\\\[^\\]+\\[^\\]+)(?:\\+|$)/);
    if (unc) {
        const matchRoot = unc[1];
        if (!matchRoot) return { absolute: false, root: '', rest: path };
        const root = matchRoot.endsWith('\\') ? matchRoot : `${matchRoot}\\`;
        return { absolute: true, root, rest: path.slice(root.length) };
    }

    const drive = path.match(/^([A-Za-z]:)(\\+)?/);
    if (drive) {
        const driveRoot = drive[1];
        if (!driveRoot) return { absolute: false, root: '', rest: path };
        if (drive[2]) {
            const root = `${driveRoot}\\`;
            return { absolute: true, root, rest: path.slice(drive[0].length) };
        }
        return { absolute: false, root: driveRoot, rest: path.slice(driveRoot.length) };
    }

    if (path.startsWith('\\')) {
        return { absolute: true, root: '\\', rest: path.slice(1) };
    }

    return { absolute: false, root: '', rest: path };
}

function splitRoot(path: string, windows: boolean): RootInfo {
    return windows ? splitWin32Root(path) : splitPosixRoot(path);
}

function splitSegments(path: string, windows: boolean): string[] {
    if (!path) return [];
    return windows ? path.split(/\\+/) : path.split(/\/+/);
}

function composePath(root: string, segments: string[], sep: '/' | '\\'): string {
    const tail = segments.join(sep);
    if (!root) return tail;
    if (!tail) return root;
    if (root.endsWith(sep)) return `${root}${tail}`;
    if (/^[A-Za-z]:$/.test(root)) return `${root}${tail}`;
    return `${root}${sep}${tail}`;
}

function normalizeImpl(path: string, windows: boolean): string {
    if (path === '') return '.';

    const sep = windows ? '\\' : '/';
    const normalized = normalizeSlashes(path, windows);
    const last = normalized.charAt(normalized.length - 1);
    const trailing = normalized.length > 0
        && (windows ? isWindowsPathSeparator(last) : last === '/');
    const { absolute, root, rest } = splitRoot(normalized, windows);
    const segments: string[] = [];

    for (const segment of splitSegments(rest, windows)) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (segments.length > 0 && segments.at(-1) !== '..') {
                segments.pop();
                continue;
            }
            if (!absolute) segments.push('..');
            continue;
        }
        segments.push(segment);
    }

    let result = composePath(root, segments, sep);
    if (!result) result = absolute ? (root || sep) : '.';
    if (trailing && result !== root && result !== '.' && !result.endsWith(sep)) {
        result += sep;
    }
    return result;
}

function dirnameImpl(path: string, windows: boolean): string {
    if (path === '') return '.';

    const normalized = normalizeSlashes(path, windows);
    const { root } = splitRoot(normalized, windows);
    const rootLength = root.length;
    const isSeparator = windows ? isWindowsPathSeparator : (ch: string) => ch === '/';

    let end = normalized.length - 1;
    while (end >= rootLength && isSeparator(normalized.charAt(end))) end--;
    if (end < rootLength) return root || '.';

    let index = end;
    while (index >= rootLength && !isSeparator(normalized.charAt(index))) index--;
    if (index < rootLength) return root || '.';
    while (index > rootLength && isSeparator(normalized.charAt(index - 1))) index--;
    return index === 0 ? normalized.slice(0, 1) : normalized.slice(0, index);
}

function basenameImpl(path: string, suffix: string | undefined, windows: boolean): string {
    if (path === '') return '';

    const normalized = normalizeSlashes(path, windows);
    const { root } = splitRoot(normalized, windows);
    const rootLength = root.length;
    const isSeparator = windows ? isWindowsPathSeparator : (ch: string) => ch === '/';

    let end = normalized.length - 1;
    while (end >= rootLength && isSeparator(normalized.charAt(end))) end--;
    if (end < rootLength) return '';

    let start = end;
    while (start >= rootLength && !isSeparator(normalized.charAt(start))) start--;
    let base = normalized.slice(start + 1, end + 1);
    if (suffix && suffix.length > 0 && base.endsWith(suffix)) {
        base = base.slice(0, base.length - suffix.length);
    }
    return base;
}

function extnameImpl(path: string, windows: boolean): string {
    const base = basenameImpl(path, undefined, windows);
    if (!base) return '';
    const index = base.lastIndexOf('.');
    if (index <= 0) return '';
    return base.slice(index);
}

function parseImpl(path: string, windows: boolean): ParsedPath {
    const normalized = normalizeSlashes(path, windows);
    const { root } = splitRoot(normalized, windows);
    const rootLength = root.length;
    const isSeparator = windows ? isWindowsPathSeparator : (ch: string) => ch === '/';

    let end = normalized.length;
    while (end > rootLength && isSeparator(normalized.charAt(end - 1))) end--;

    let start = end;
    while (start > rootLength && !isSeparator(normalized.charAt(start - 1))) start--;

    const base = normalized.slice(start, end);
    const dir = start <= rootLength ? root : normalized.slice(0, start - 1);
    const ext = base ? extnameImpl(base, windows) : '';
    const name = ext ? base.slice(0, base.length - ext.length) : base;

    return {
        root,
        dir: dir === '.' ? '' : dir,
        base,
        ext,
        name,
    };
}

function formatImpl(pathObject: FormatInputPathObject, sep: '/' | '\\'): string {
    const dir = pathObject.dir ?? pathObject.root ?? '';
    const ext = pathObject.ext ? (pathObject.ext.startsWith('.') ? pathObject.ext : `.${pathObject.ext}`) : '';
    const base = pathObject.base ?? `${pathObject.name ?? ''}${ext}`;
    if (!dir) return base;
    if (!base) return dir.endsWith(sep) ? dir : `${dir}${sep}`;
    if (dir.endsWith(sep)) return `${dir}${base}`;
    return `${dir}${sep}${base}`;
}

function isWinDeviceRoot(ch: string): boolean {
    const c = ch.charCodeAt(0);
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function win32DriveCwd(device: string): string {
    // Node: process.env['=C:'] is the per-drive cwd; else process.cwd().
    const proc = Reflect.get(globalThis, 'process');
    const env = (proc && typeof proc === 'object') ? Reflect.get(proc, 'env') : undefined;
    let path: string | undefined;
    if (env && typeof env === 'object') {
        const fromEnv = Reflect.get(env, `=${device}`);
        if (typeof fromEnv === 'string' && fromEnv.length > 0) path = fromEnv;
    }
    if (path === undefined) path = getCwd();
    // If cwd is not on this drive (and looks like `X:\...`), use drive root.
    if (
        path.length >= 3
        && path.slice(0, 2).toLowerCase() !== device.toLowerCase()
        && (path.charAt(2) === '\\' || path.charAt(2) === '/')
    ) {
        return `${device}\\`;
    }
    return path;
}

/** Parse one win32 path segment the way Node's path.win32.resolve does. */
function parseWin32ResolvePart(path: string): { device: string; isAbsolute: boolean; tail: string } {
    const normalized = normalizeSlashes(path, true);
    const len = normalized.length;
    let rootEnd = 0;
    let device = '';
    let isAbsolute = false;
    if (len === 0) return { device, isAbsolute, tail: '' };

    const code0 = normalized.charAt(0);
    if (len === 1) {
        if (code0 === '\\') {
            rootEnd = 1;
            isAbsolute = true;
        }
    } else if (code0 === '\\') {
        isAbsolute = true;
        if (normalized.charAt(1) === '\\') {
            // UNC or device namespace
            let j = 2;
            while (j < len && normalized.charAt(j) !== '\\') j++;
            if (j < len && j !== 2) {
                const firstPart = normalized.slice(2, j);
                let last = j;
                while (j < len && normalized.charAt(j) === '\\') j++;
                if (j < len && j !== last) {
                    last = j;
                    while (j < len && normalized.charAt(j) !== '\\') j++;
                    if (j === len || j !== last) {
                        if (firstPart !== '.' && firstPart !== '?') {
                            device = `\\\\${firstPart}\\${normalized.slice(last, j)}`;
                            rootEnd = j;
                        } else {
                            device = `\\\\${firstPart}`;
                            rootEnd = 4;
                        }
                    }
                }
            }
        } else {
            rootEnd = 1;
        }
    } else if (isWinDeviceRoot(code0) && normalized.charAt(1) === ':') {
        device = normalized.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && normalized.charAt(2) === '\\') {
            isAbsolute = true;
            rootEnd = 3;
        }
    }

    return { device, isAbsolute, tail: normalized.slice(rootEnd) };
}

function resolveImpl(paths: string[], windows: boolean): string {
    if (!windows) {
        const sep = '/';
        const cwd = normalizeSlashes(getCwd(), false);
        const parts = paths.length > 0 ? [...paths] : [''];
        parts.unshift(cwd);

        let resolved = '';
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = assertString(parts[i] ?? '', i === 0 ? 'path' : `paths[${i - 1}]`);
            if (!part) continue;
            const normalized = normalizeSlashes(part, false);
            resolved = resolved ? `${normalized}${sep}${resolved}` : normalized;
            if (splitRoot(normalized, false).absolute) break;
        }
        return normalizeImpl(resolved, false);
    }

    // Node path.win32.resolve — right-to-left device + absolute tail.
    let resolvedDevice = '';
    let resolvedTail = '';
    let resolvedAbsolute = false;

    for (let i = paths.length - 1; i >= -1; i--) {
        let path: string;
        if (i >= 0) {
            path = assertString(paths[i] ?? '', `paths[${i}]`);
            if (!path) continue;
        } else if (!resolvedDevice) {
            path = getCwd();
        } else {
            path = win32DriveCwd(resolvedDevice);
        }

        const { device, isAbsolute, tail } = parseWin32ResolvePart(path);

        if (device) {
            if (resolvedDevice) {
                if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
            } else {
                resolvedDevice = device;
            }
        }

        if (resolvedAbsolute) {
            if (resolvedDevice) break;
        } else {
            resolvedTail = resolvedTail ? `${tail}\\${resolvedTail}` : tail;
            resolvedAbsolute = isAbsolute;
            if (isAbsolute && resolvedDevice) break;
        }
    }

    // Normalize only the tail segments (never run full path normalize — a
    // leading `\\` would be misread as UNC).
    const segments: string[] = [];
    for (const segment of splitSegments(resolvedTail, true)) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (segments.length > 0 && segments.at(-1) !== '..') {
                segments.pop();
                continue;
            }
            if (!resolvedAbsolute) segments.push('..');
            continue;
        }
        segments.push(segment);
    }
    const normalizedTail = segments.join('\\');

    if (resolvedAbsolute) return `${resolvedDevice}\\${normalizedTail}`;
    return `${resolvedDevice}${normalizedTail}` || '.';
}

function relativeImpl(from: string, to: string, windows: boolean): string {
    const sep = windows ? '\\' : '/';
    const fromResolved = resolveImpl([from], windows);
    const toResolved = resolveImpl([to], windows);
    const cmpFrom = windows ? fromResolved.toLowerCase() : fromResolved;
    const cmpTo = windows ? toResolved.toLowerCase() : toResolved;
    if (cmpFrom === cmpTo) return '';

    const fromRoot = splitRoot(fromResolved, windows).root;
    const toRoot = splitRoot(toResolved, windows).root;
    if (windows && fromRoot.toLowerCase() !== toRoot.toLowerCase()) return toResolved;

    const fromSegments = splitSegments(fromResolved.slice(fromRoot.length), windows).filter(Boolean);
    const toSegments = splitSegments(toResolved.slice(toRoot.length), windows).filter(Boolean);

    let shared = 0;
    while (shared < fromSegments.length && shared < toSegments.length) {
        const fromSegment = fromSegments[shared];
        const toSegment = toSegments[shared];
        if (fromSegment === undefined || toSegment === undefined) break;
        const fromPart = windows ? fromSegment.toLowerCase() : fromSegment;
        const toPart = windows ? toSegment.toLowerCase() : toSegment;
        if (fromPart !== toPart) break;
        shared++;
    }

    const output = new Array(fromSegments.length - shared).fill('..');
    output.push(...toSegments.slice(shared));
    return output.join(sep);
}

function toNamespacedPathImpl(path: string, windows: boolean): string {
    const input = assertString(path, 'path');
    if (!windows || input.length === 0) return input;

    const normalized = normalizeSlashes(input, true);
    if (normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) {
        return normalized;
    }

    const resolved = resolveImpl([normalized], true);
    if (resolved.startsWith('\\\\')) {
        return `\\\\?\\UNC\\${resolved.slice(2)}`;
    }
    return `\\\\?\\${resolved}`;
}

function createPathApi(windows: boolean): PathApi {
    const sep = windows ? '\\' : '/';
    const delimiter = windows ? ';' : ':';

    return {
        sep,
        delimiter,
        _makeLong(path) {
            return toNamespacedPathImpl(path, windows);
        },
        basename(path, suffix) {
            return basenameImpl(assertString(path, 'path'), suffix === undefined ? undefined : assertString(suffix, 'suffix'), windows);
        },
        dirname(path) {
            return dirnameImpl(assertString(path, 'path'), windows);
        },
        extname(path) {
            return extnameImpl(assertString(path, 'path'), windows);
        },
        format(pathObject) {
            return formatImpl(assertPathObject(pathObject), sep);
        },
        isAbsolute(path) {
            return splitRoot(normalizeSlashes(assertString(path, 'path'), windows), windows).absolute;
        },
        join(...paths) {
            for (let i = 0; i < paths.length; i++) assertString(paths[i], 'path');
            const filtered = paths.filter(part => part.length > 0);
            if (filtered.length === 0) return '.';
            return normalizeImpl(filtered.join(sep), windows);
        },
        normalize(path) {
            return normalizeImpl(assertString(path, 'path'), windows);
        },
        parse(path) {
            return parseImpl(assertString(path, 'path'), windows);
        },
        relative(from, to) {
            return relativeImpl(assertString(from, 'from'), assertString(to, 'to'), windows);
        },
        resolve(...paths) {
            return resolveImpl(paths, windows);
        },
        toNamespacedPath(path) {
            return toNamespacedPathImpl(path, windows);
        },
    };
}

export const posixPathApi = createPathApi(false);
export const win32PathApi = createPathApi(true);

posixPathApi.posix = posixPathApi;
posixPathApi.win32 = win32PathApi;
win32PathApi.posix = posixPathApi;
win32PathApi.win32 = win32PathApi;

export const createPosixPathApi = () => posixPathApi;
export const createWin32PathApi = () => win32PathApi;
