const os = import.meta.use('os');
import { matchGlobPattern } from '../_internal/glob-match';

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
    matchesGlob(path: string, pattern: string): boolean;
    posix?: PathApi;
    win32?: PathApi;
};

type RootInfo = {
    absolute: boolean;
    root: string;
    rest: string;
};

/** Node's `Received ...` clause for ERR_INVALID_ARG_TYPE. Verified against v24.18. */
function receivedOf(actual: unknown): string {
    if (actual === null) return 'null';
    if (actual === undefined) return 'undefined';
    const t = typeof actual;
    if (t === 'string') return `type string ('${actual as string}')`;
    if (t === 'number') return `type number (${Object.is(actual, -0) ? '-0' : String(actual)})`;
    if (t === 'bigint') return `type bigint (${String(actual)}n)`;
    if (t === 'boolean') return `type boolean (${String(actual)})`;
    if (t === 'symbol') return `type symbol (${String(actual)})`;
    if (t === 'function') return `function ${(actual as { name?: string }).name ?? ''}`;
    if (t === 'object') {
        const proto = Object.getPrototypeOf(actual);
        if (proto === null) return '[Object: null prototype] {}';
        const ctor = (actual as object).constructor;
        return `an instance of ${ctor && ctor.name ? ctor.name : 'Object'}`;
    }
    return `type ${t}`;
}

function assertString(value: unknown, name: string): string {
    if (typeof value !== 'string') {
        throw Object.assign(
            new TypeError(`The "${name}" argument must be of type string. Received ${receivedOf(value)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    return value;
}

function matchGlob(path: string, pattern: string, windows: boolean): boolean {
    return matchGlobPattern(path, pattern, windows);
}

function assertPathObject(value: unknown): FormatInputPathObject {
    if (value === null || typeof value !== 'object') {
        throw Object.assign(
            new TypeError(`The "pathObject" argument must be of type object. Received ${receivedOf(value)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    return value;
}

const CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_COLON = 58;

function isPosixSepCode(code: number): boolean {
    return code === CHAR_FORWARD_SLASH;
}

function isWin32SepCode(code: number): boolean {
    return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

function isWindowsDeviceRootCode(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Node's internal `normalizeString`: resolve `.`/`..` in the *relative* portion
 * of a path without touching the root. Ported verbatim so both flavours agree
 * with Node byte for byte.
 */
function normalizeString(
    path: string,
    allowAboveRoot: boolean,
    separator: string,
    isSep: (code: number) => boolean,
): string {
    let res = '';
    let lastSegmentLength = 0;
    let lastSlash = -1;
    let dots = 0;
    let code = 0;
    for (let i = 0; i <= path.length; ++i) {
        if (i < path.length) code = path.charCodeAt(i);
        else if (isSep(code)) break;
        else code = CHAR_FORWARD_SLASH;

        if (isSep(code)) {
            if (lastSlash === i - 1 || dots === 1) {
                // NOOP
            } else if (dots === 2) {
                if (
                    res.length < 2 || lastSegmentLength !== 2
                    || res.charCodeAt(res.length - 1) !== CHAR_DOT
                    || res.charCodeAt(res.length - 2) !== CHAR_DOT
                ) {
                    if (res.length > 2) {
                        const lastSlashIndex = res.lastIndexOf(separator);
                        if (lastSlashIndex === -1) {
                            res = '';
                            lastSegmentLength = 0;
                        } else {
                            res = res.slice(0, lastSlashIndex);
                            lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
                        }
                        lastSlash = i;
                        dots = 0;
                        continue;
                    } else if (res.length !== 0) {
                        res = '';
                        lastSegmentLength = 0;
                        lastSlash = i;
                        dots = 0;
                        continue;
                    }
                }
                if (allowAboveRoot) {
                    res += res.length > 0 ? `${separator}..` : '..';
                    lastSegmentLength = 2;
                }
            } else {
                if (res.length > 0) res += `${separator}${path.slice(lastSlash + 1, i)}`;
                else res = path.slice(lastSlash + 1, i);
                lastSegmentLength = i - lastSlash - 1;
            }
            lastSlash = i;
            dots = 0;
        } else if (code === CHAR_DOT && dots !== -1) {
            ++dots;
        } else {
            dots = -1;
        }
    }
    return res;
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

/**
 * Length of the root prefix, treating `/` and `\` as equally valid separators
 * and preserving whichever one the caller passed.
 *
 * `parse()` is the one operation Node does NOT normalize separators for: it
 * reports the root exactly as written, so `win32.parse('/a/b/c.js').root` is
 * `'/'` and `win32.parse('C:/a').root` is `'C:/'`. Everything else in this file
 * runs on normalized input and can keep using splitWin32Root.
 */
function win32ParseRootEnd(path: string): number {
    const len = path.length;
    if (len === 0) return 0;

    if (isWindowsPathSeparator(path.charAt(0))) {
        if (len === 1 || !isWindowsPathSeparator(path.charAt(1))) return 1;
        // Possible UNC root: \\server\share
        let j = 2;
        let last = j;
        while (j < len && !isWindowsPathSeparator(path.charAt(j))) j++;
        if (j >= len || j === last) return 1;
        last = j;
        while (j < len && isWindowsPathSeparator(path.charAt(j))) j++;
        if (j >= len || j === last) return 1;
        last = j;
        while (j < len && !isWindowsPathSeparator(path.charAt(j))) j++;
        if (j === len) return j; // UNC root only, no trailing separator
        if (j !== last) return j + 1; // UNC root plus leftovers
        return 1;
    }

    if (len > 1 && isWinDeviceRoot(path.charAt(0)) && path.charAt(1) === ':') {
        // `C:` alone is drive-relative, so the root is just the device.
        if (len === 2 || !isWindowsPathSeparator(path.charAt(2))) return 2;
        return 3;
    }

    return 0;
}

function parseRoot(path: string, windows: boolean): string {
    if (windows) return path.slice(0, win32ParseRootEnd(path));
    return path.startsWith('/') ? '/' : '';
}

/**
 * Node's isAbsolute, per flavour and without any separator translation.
 *
 * posix must treat `\` as an ordinary character, so `posix.isAbsolute('\\a')`
 * is false — routing it through a normalizer that flips slashes reports true.
 * win32 accepts either separator, but a bare `C:` is drive-RELATIVE.
 */
function isAbsoluteImpl(path: string, windows: boolean): boolean {
    if (!windows) return path.startsWith('/');
    const len = path.length;
    if (len === 0) return false;
    if (isWindowsPathSeparator(path.charAt(0))) return true;
    return len > 2
        && isWinDeviceRoot(path.charAt(0))
        && path.charAt(1) === ':'
        && isWindowsPathSeparator(path.charAt(2));
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

function normalizePosix(path: string): string {
    if (path.length === 0) return '.';

    const isAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH;

    path = normalizeString(path, !isAbsolute, '/', isPosixSepCode);

    if (path.length === 0) {
        if (isAbsolute) return '/';
        return trailingSeparator ? './' : '.';
    }
    if (trailingSeparator) path += '/';

    return isAbsolute ? `/${path}` : path;
}

/**
 * Node prepends `.\` when a rootless win32 path contains a segment ending in
 * `:`, so the result can never be re-read as a drive-relative path
 * (`join('a','b:')` must not yield `a\b:`). Keyed off the INPUT segments, not
 * the normalized output: `normalize('a\\b:\\..\\c')` is `.\a\c`.
 */
function win32NeedsDotGuard(input: string): boolean {
    let segStart = 0;
    for (let i = 0; i <= input.length; i++) {
        if (i === input.length || isWin32SepCode(input.charCodeAt(i))) {
            if (i > segStart && input.charCodeAt(i - 1) === CHAR_COLON) return true;
            segStart = i + 1;
        }
    }
    return false;
}

function normalizeWin32(path: string): string {
    if (path.length === 0) return '.';

    const len = path.length;
    let rootEnd = 0;
    let device: string | undefined;
    let isAbsolute = false;
    const code = path.charCodeAt(0);

    if (len === 1) {
        // `\` and `/` normalize to `\`; everything else is a one-char name.
        return isWin32SepCode(code) ? '\\' : path;
    }

    if (isWin32SepCode(code)) {
        isAbsolute = true;

        if (isWin32SepCode(path.charCodeAt(1))) {
            // Possible UNC root
            let j = 2;
            let last = j;
            while (j < len && !isWin32SepCode(path.charCodeAt(j))) j++;
            if (j < len && j !== last) {
                const firstPart = path.slice(last, j);
                last = j;
                while (j < len && isWin32SepCode(path.charCodeAt(j))) j++;
                if (j < len && j !== last) {
                    last = j;
                    while (j < len && !isWin32SepCode(path.charCodeAt(j))) j++;
                    // `?` and `.` are DEVICE namespaces, not servers: the root is
                    // just `\\?`, so the component after it stays in the tail and
                    // any `.`/`..` there still normalizes away.
                    if (firstPart === '?' || firstPart === '.') {
                        device = `\\\\${firstPart}`;
                        rootEnd = 4;
                    } else if (j === len) {
                        // `\\server\share` — return the root as-is.
                        return `\\\\${firstPart}\\${path.slice(last)}\\`;
                    } else if (j !== last) {
                        device = `\\\\${firstPart}\\${path.slice(last, j)}`;
                        rootEnd = j;
                    }
                }
            }
        } else {
            rootEnd = 1;
        }
    } else if (isWindowsDeviceRootCode(code) && path.charCodeAt(1) === CHAR_COLON) {
        device = path.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && isWin32SepCode(path.charCodeAt(2))) {
            isAbsolute = true;
            rootEnd = 3;
        }
    }

    let tail = rootEnd < len
        ? normalizeString(path.slice(rootEnd), !isAbsolute, '\\', isWin32SepCode)
        : '';
    if (tail.length === 0 && !isAbsolute) tail = '.';
    if (tail.length > 0 && isWin32SepCode(path.charCodeAt(len - 1))) tail += '\\';

    if (device === undefined) {
        if (isAbsolute) return `\\${tail}`;
        // Rootless: guard so the result cannot be re-read as drive-relative.
        // Two independent triggers, both verified against Node v24.18:
        //   1. an INPUT segment ends in `:`  (normalize('a\\b:\\..\\c') === '.\\a\\c')
        //   2. the normalized TAIL starts with a drive root (normalize('a\\..\\C:x') === '.\\C:x')
        const tailIsDriveLike = tail.length > 1
            && isWindowsDeviceRootCode(tail.charCodeAt(0))
            && tail.charCodeAt(1) === CHAR_COLON;
        if ((win32NeedsDotGuard(path) || tailIsDriveLike) && !tail.startsWith('.\\')) {
            return `.\\${tail}`;
        }
        return tail;
    }
    return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
}

function normalizeImpl(path: string, windows: boolean): string {
    return windows ? normalizeWin32(path) : normalizePosix(path);
}

function dirnamePosix(path: string): string {
    if (path.length === 0) return '.';
    const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    let end = -1;
    let matchedSlash = true;
    for (let i = path.length - 1; i >= 1; --i) {
        if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
            if (!matchedSlash) {
                end = i;
                break;
            }
        } else {
            matchedSlash = false;
        }
    }

    if (end === -1) return hasRoot ? '/' : '.';
    if (hasRoot && end === 1) return '//';
    return path.slice(0, end);
}

function dirnameWin32(path: string): string {
    const len = path.length;
    if (len === 0) return '.';
    let rootEnd = -1;
    let offset = 0;
    const code = path.charCodeAt(0);

    if (len === 1) return isWin32SepCode(code) ? path : '.';

    if (isWin32SepCode(code)) {
        rootEnd = offset = 1;

        if (isWin32SepCode(path.charCodeAt(1))) {
            let j = 2;
            let last = j;
            while (j < len && !isWin32SepCode(path.charCodeAt(j))) j++;
            if (j < len && j !== last) {
                last = j;
                while (j < len && isWin32SepCode(path.charCodeAt(j))) j++;
                if (j < len && j !== last) {
                    last = j;
                    while (j < len && !isWin32SepCode(path.charCodeAt(j))) j++;
                    if (j === len) return path;
                    if (j !== last) rootEnd = offset = j + 1;
                }
            }
        }
    } else if (isWindowsDeviceRootCode(code) && path.charCodeAt(1) === CHAR_COLON) {
        rootEnd = len > 2 && isWin32SepCode(path.charCodeAt(2)) ? 3 : 2;
        offset = rootEnd;
    }

    let end = -1;
    let matchedSlash = true;
    for (let i = len - 1; i >= offset; --i) {
        if (isWin32SepCode(path.charCodeAt(i))) {
            if (!matchedSlash) {
                end = i;
                break;
            }
        } else {
            matchedSlash = false;
        }
    }

    if (end === -1) {
        if (rootEnd === -1) return '.';
        end = rootEnd;
    }
    return path.slice(0, end);
}

function dirnameImpl(path: string, windows: boolean): string {
    return windows ? dirnameWin32(path) : dirnamePosix(path);
}

function basenamePosix(path: string, suffix?: string): string {
    let start = 0;
    let end = -1;
    let matchedSlash = true;

    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
        if (suffix === path) return '';
        let extIdx = suffix.length - 1;
        let firstNonSlashEnd = -1;
        for (let i = path.length - 1; i >= 0; --i) {
            const code = path.charCodeAt(i);
            if (code === CHAR_FORWARD_SLASH) {
                if (!matchedSlash) {
                    start = i + 1;
                    break;
                }
            } else {
                if (firstNonSlashEnd === -1) {
                    matchedSlash = false;
                    firstNonSlashEnd = i + 1;
                }
                if (extIdx >= 0) {
                    if (code === suffix.charCodeAt(extIdx)) {
                        if (--extIdx === -1) end = i;
                    } else {
                        extIdx = -1;
                        end = firstNonSlashEnd;
                    }
                }
            }
        }

        if (start === end) end = firstNonSlashEnd;
        else if (end === -1) end = path.length;
        return path.slice(start, end);
    }

    for (let i = path.length - 1; i >= 0; --i) {
        if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
            if (!matchedSlash) {
                start = i + 1;
                break;
            }
        } else if (end === -1) {
            matchedSlash = false;
            end = i + 1;
        }
    }

    if (end === -1) return '';
    return path.slice(start, end);
}

function basenameWin32(path: string, suffix?: string): string {
    let start = 0;
    let end = -1;
    let matchedSlash = true;

    // A `C:` device prefix is never part of the basename.
    if (
        path.length >= 2 && isWindowsDeviceRootCode(path.charCodeAt(0))
        && path.charCodeAt(1) === CHAR_COLON
    ) {
        start = 2;
    }

    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
        if (suffix === path) return '';
        let extIdx = suffix.length - 1;
        let firstNonSlashEnd = -1;
        for (let i = path.length - 1; i >= start; --i) {
            const code = path.charCodeAt(i);
            if (isWin32SepCode(code)) {
                if (!matchedSlash) {
                    start = i + 1;
                    break;
                }
            } else {
                if (firstNonSlashEnd === -1) {
                    matchedSlash = false;
                    firstNonSlashEnd = i + 1;
                }
                if (extIdx >= 0) {
                    if (code === suffix.charCodeAt(extIdx)) {
                        if (--extIdx === -1) end = i;
                    } else {
                        extIdx = -1;
                        end = firstNonSlashEnd;
                    }
                }
            }
        }

        if (start === end) end = firstNonSlashEnd;
        else if (end === -1) end = path.length;
        return path.slice(start, end);
    }

    for (let i = path.length - 1; i >= start; --i) {
        if (isWin32SepCode(path.charCodeAt(i))) {
            if (!matchedSlash) {
                start = i + 1;
                break;
            }
        } else if (end === -1) {
            matchedSlash = false;
            end = i + 1;
        }
    }

    if (end === -1) return '';
    return path.slice(start, end);
}

function basenameImpl(path: string, suffix: string | undefined, windows: boolean): string {
    return windows ? basenameWin32(path, suffix) : basenamePosix(path, suffix);
}

function extnameImpl(path: string, windows: boolean): string {
    const base = basenameImpl(path, undefined, windows);
    if (!base) return '';
    // Node treats a basename of exactly '..' as having no extension, while
    // '...' does have one ('.'). A bare '.' is already covered by index <= 0.
    if (base === '..') return '';
    const index = base.lastIndexOf('.');
    if (index <= 0) return '';
    return base.slice(index);
}

function parseImpl(path: string, windows: boolean): ParsedPath {
    // Deliberately NOT normalized: Node reports root/dir/base with the caller's
    // own separators, so `win32.parse('/a/b/c.js').root` is '/', not '\'.
    const root = parseRoot(path, windows);
    const rootLength = root.length;
    const isSeparator = windows ? isWindowsPathSeparator : (ch: string) => ch === '/';

    let end = path.length;
    while (end > rootLength && isSeparator(path.charAt(end - 1))) end--;

    let start = end;
    while (start > rootLength && !isSeparator(path.charAt(start - 1))) start--;

    const base = path.slice(start, end);
    const dir = start <= rootLength ? root : path.slice(0, start - 1);

    // Node's posix.parse contradicts its own extname for exactly one shape:
    // a single-slash-rooted path whose only component is '..' reports
    // ext '.' / name '.', while extname('/..') is '' and win32.parse('/..')
    // reports ext ''. Node's carve-out for "the component is exactly .."
    // tests `startDot === startPart + 1`, but on `/..` the backward scan
    // breaks at the root instead of at a separator, so startPart stays 0
    // while the slice actually starts at 1 — and the carve-out misfires.
    // Reproduced verbatim because callers diff against Node, not the spec.
    // Only `/..` (+ trailing separators) qualifies: `//..`, `/a/..`, `..`
    // and `/./..` all take the ordinary path.
    const nodePosixDotDotQuirk = !windows && base === '..'
        && root === '/' && start === rootLength;
    if (nodePosixDotDotQuirk) {
        return { root, dir, base, ext: '.', name: '.' };
    }

    const ext = base ? extnameImpl(base, windows) : '';
    const name = ext ? base.slice(0, base.length - ext.length) : base;

    return {
        root,
        // No '.' -> '' collapse: Node reports parse('./a').dir as '.', and a
        // bare '.' already yields '' here because start <= rootLength.
        dir,
        base,
        ext,
        name,
    };
}

function formatImpl(pathObject: FormatInputPathObject, sep: '/' | '\\'): string {
    // Node: `dir || root`, and the separator is skipped exactly when dir is the
    // root itself — not merely when dir ends in a separator. That distinction
    // matters for posix format({root:'/',dir:'//',base:'a'}) === '///a'.
    const dir = pathObject.dir || pathObject.root || '';
    const ext = pathObject.ext ? (pathObject.ext.startsWith('.') ? pathObject.ext : `.${pathObject.ext}`) : '';
    const base = pathObject.base || `${pathObject.name ?? ''}${ext}`;
    if (!dir) return base;
    return dir === pathObject.root ? `${dir}${base}` : `${dir}${sep}${base}`;
}

/**
 * Node's win32 join: after concatenating, a *spurious* UNC prefix created by the
 * join itself must collapse to one separator. Only the FIRST argument decides —
 * `\\server` is a real UNC prefix (kept), a bare `\` or `//` is not.
 * join('/','a\\b') is `\a\b`, but normalize('/\\a\\b') is `\\a\b\`.
 */
function joinWin32(paths: string[]): string {
    let joined: string | undefined;
    let firstPart: string | undefined;
    for (const part of paths) {
        if (part.length === 0) continue;
        if (joined === undefined) { joined = firstPart = part; }
        else joined += `\\${part}`;
    }
    if (joined === undefined || firstPart === undefined) return '.';

    let needsReplace = true;
    let slashCount = 0;
    if (isWin32SepCode(firstPart.charCodeAt(0))) {
        ++slashCount;
        const firstLen = firstPart.length;
        if (firstLen > 1 && isWin32SepCode(firstPart.charCodeAt(1))) {
            ++slashCount;
            if (firstLen > 2) {
                if (isWin32SepCode(firstPart.charCodeAt(2))) ++slashCount;
                else needsReplace = false; // `\\server` — a genuine UNC root.
            }
        }
    }
    if (needsReplace) {
        while (slashCount < joined.length && isWin32SepCode(joined.charCodeAt(slashCount))) ++slashCount;
        if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
    }
    return normalizeWin32(joined);
}

function joinPosix(paths: string[]): string {
    let joined: string | undefined;
    for (const part of paths) {
        if (part.length === 0) continue;
        joined = joined === undefined ? part : `${joined}/${part}`;
    }
    return joined === undefined ? '.' : normalizePosix(joined);
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
        // Node's posixCwd(): on Windows the cwd is translated to forward
        // slashes AND the drive indicator is dropped, so posix.resolve('a')
        // yields '/docs/.../a'. The path ARGUMENTS are never translated —
        // for posix a backslash is an ordinary filename character.
        const rawCwd = getCwd().replace(/\\/g, '/');
        const slash = rawCwd.indexOf('/');
        const cwd = slash === -1 ? rawCwd : rawCwd.slice(slash);
        const parts = paths.length > 0 ? [...paths] : [''];
        parts.unshift(cwd);

        let resolved = '';
        let resolvedAbsolute = false;
        for (let i = parts.length - 1; i >= 0 && !resolvedAbsolute; i--) {
            // No `?? ''` here: it would mask null/undefined from assertString,
            // so resolve('/a', null) would silently succeed instead of throwing.
            const part = assertString(parts[i], i === 0 ? 'path' : `paths[${i - 1}]`);
            if (!part) continue;
            // Node always appends the separator, so a trailing `/` on the last
            // argument becomes an interior `//` that normalizeString collapses.
            // Going through normalize() instead would PRESERVE it, making
            // posix.resolve('/a/') wrongly return '/a/'.
            resolved = `${part}${sep}${resolved}`;
            resolvedAbsolute = part.charCodeAt(0) === CHAR_FORWARD_SLASH;
        }
        resolved = normalizeString(resolved, !resolvedAbsolute, sep, isPosixSepCode);
        if (resolvedAbsolute) return `/${resolved}`;
        return resolved.length > 0 ? resolved : '.';
    }

    // Node path.win32.resolve — right-to-left device + absolute tail.
    let resolvedDevice = '';
    let resolvedTail = '';
    let resolvedAbsolute = false;

    for (let i = paths.length - 1; i >= -1; i--) {
        let path: string;
        if (i >= 0) {
            path = assertString(paths[i], `paths[${i}]`);
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

/**
 * Faithful port of Node's `win32.relative`.
 *
 * Node compares the two *resolved* paths character by character after trimming
 * leading and trailing separators; it deliberately has **no root comparison**.
 * A segment model that bails out to the absolute `to` whenever the roots differ
 * gets `relative('\\\\srv\\share1\\a', '\\\\srv\\share2\\b')` wrong: Node walks
 * up out of the share (`..\..\share2\b`) because the leading `\\` is trimmed,
 * so `srv` is a common component like any other. The same applies to `\\?\` and
 * `\\.\` device paths. Node only returns `to` untouched when the paths diverge
 * *before* the first shared separator (e.g. `C:\a` vs `D:\b`).
 */
function relativeWin32(from: string, to: string): string {
    if (from === to) return '';

    const fromOrig = resolveImpl([from], true);
    const toOrig = resolveImpl([to], true);
    if (fromOrig === toOrig) return '';

    const fromLower = fromOrig.toLowerCase();
    const toLower = toOrig.toLowerCase();
    if (fromLower === toLower) return '';

    // Trim leading separators, then trailing ones (keeping at least one char).
    let fromStart = 0;
    while (fromStart < fromLower.length && fromLower.charCodeAt(fromStart) === CHAR_BACKWARD_SLASH) fromStart++;
    let fromEnd = fromLower.length;
    while (fromEnd - 1 > fromStart && fromLower.charCodeAt(fromEnd - 1) === CHAR_BACKWARD_SLASH) fromEnd--;
    const fromLen = fromEnd - fromStart;

    let toStart = 0;
    while (toStart < toLower.length && toLower.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) toStart++;
    let toEnd = toLower.length;
    while (toEnd - 1 > toStart && toLower.charCodeAt(toEnd - 1) === CHAR_BACKWARD_SLASH) toEnd--;
    const toLen = toEnd - toStart;

    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
        const fromCode = fromLower.charCodeAt(fromStart + i);
        if (fromCode !== toLower.charCodeAt(toStart + i)) break;
        else if (fromCode === CHAR_BACKWARD_SLASH) lastCommonSep = i;
    }

    if (i !== length) {
        // Diverged before any shared separator, so `to` shares nothing at all.
        if (lastCommonSep === -1) return toOrig;
    } else {
        if (toLen > length) {
            if (toLower.charCodeAt(toStart + i) === CHAR_BACKWARD_SLASH) {
                // `from` is the exact base path of `to`.
                return toOrig.slice(toStart + i + 1);
            }
            if (i === 2) {
                // `from` is the device root, e.g. from='C:\', to='C:\foo'.
                return toOrig.slice(toStart + i);
            }
        }
        if (fromLen > length) {
            if (fromLower.charCodeAt(fromStart + i) === CHAR_BACKWARD_SLASH) {
                // `to` is the exact base path of `from`.
                lastCommonSep = i;
            } else if (i === 2) {
                // `to` is the device root, e.g. from='C:\foo\bar', to='C:\'.
                lastCommonSep = 3;
            }
        }
        if (lastCommonSep === -1) lastCommonSep = 0;
    }

    let out = '';
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
        if (i === fromEnd || fromLower.charCodeAt(i) === CHAR_BACKWARD_SLASH) {
            out += out.length === 0 ? '..' : '\\..';
        }
    }

    toStart += lastCommonSep;
    if (out.length > 0) return `${out}${toOrig.slice(toStart, toEnd)}`;
    if (toOrig.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) ++toStart;
    return toOrig.slice(toStart, toEnd);
}

/** Faithful port of Node's `posix.relative`. */
function relativePosix(from: string, to: string): string {
    if (from === to) return '';

    const fromResolved = resolveImpl([from], false);
    const toResolved = resolveImpl([to], false);
    if (fromResolved === toResolved) return '';

    // A resolved POSIX path always begins with exactly one `/`.
    const fromStart = 1;
    const fromEnd = fromResolved.length;
    const fromLen = fromEnd - fromStart;
    const toStart = 1;
    const toLen = toResolved.length - toStart;

    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
        const fromCode = fromResolved.charCodeAt(fromStart + i);
        if (fromCode !== toResolved.charCodeAt(toStart + i)) break;
        else if (fromCode === CHAR_FORWARD_SLASH) lastCommonSep = i;
    }
    if (i === length) {
        if (toLen > length) {
            if (toResolved.charCodeAt(toStart + i) === CHAR_FORWARD_SLASH) {
                // `from` is the exact base path of `to`.
                return toResolved.slice(toStart + i + 1);
            }
            if (i === 0) {
                // `from` is the root.
                return toResolved.slice(toStart + i);
            }
        } else if (fromLen > length) {
            if (fromResolved.charCodeAt(fromStart + i) === CHAR_FORWARD_SLASH) {
                // `to` is the exact base path of `from`.
                lastCommonSep = i;
            } else if (i === 0) {
                // `to` is the root.
                lastCommonSep = 0;
            }
        }
    }

    let out = '';
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
        if (i === fromEnd || fromResolved.charCodeAt(i) === CHAR_FORWARD_SLASH) {
            out += out.length === 0 ? '..' : '/..';
        }
    }

    return `${out}${toResolved.slice(toStart + lastCommonSep)}`;
}

function relativeImpl(from: string, to: string, windows: boolean): string {
    return windows ? relativeWin32(from, to) : relativePosix(from, to);
}

function toNamespacedPathImpl(path: string, windows: boolean): string {
    // Node returns non-strings untouched here rather than throwing.
    if (typeof path !== 'string') return path;
    const input = path;
    if (!windows || input.length === 0) return input;

    // Node resolves FIRST and only then inspects the prefix, so a bare `\\?\`
    // (which resolve turns into `d:\?`) still gets namespaced.
    const resolved = resolveImpl([input], true);
    if (resolved.startsWith('\\\\?\\') || resolved.startsWith('\\\\.\\')) return resolved;
    if (resolved.startsWith('\\\\')) return `\\\\?\\UNC\\${resolved.slice(2)}`;
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
            // Node validates `suffix` first, so basename(1, 1) reports "suffix".
            const ext = suffix === undefined ? undefined : assertString(suffix, 'suffix');
            return basenameImpl(assertString(path, 'path'), ext, windows);
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
            return isAbsoluteImpl(assertString(path, 'path'), windows);
        },
        join(...paths) {
            for (let i = 0; i < paths.length; i++) assertString(paths[i], 'path');
            return windows ? joinWin32(paths) : joinPosix(paths);
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
        matchesGlob(path, pattern) {
            assertString(path, 'path');
            assertString(pattern, 'pattern');
            return matchGlob(path, pattern, windows);
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
