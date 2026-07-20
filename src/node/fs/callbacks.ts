/**
 * Node.js fs module - callback-style API
 * All async operations support callback functions
 */
import { toUint8Array, decodeBuffer, encodePathResult, toNodeStat, toNodeStatFs, toNodeDirentAsync, parseFlags, pathToString, splitPathOrFd, describeFd, removeRecursive, mkdirRecursive, modeToNumber, timeToNumber, readFileFromFdSync, randomHex, createAsyncDir, readDirEntries, validateOpendirOptions, validateReaddirOptions, validateFd, errorFromUnknown, assertCopyFileMode, makeAbortError, rmIsDirectoryError, type PathLike, type TimeLike, type Mode } from './utils';
import { toErrnoException } from '../_internal/errno';
import { getTierLimits } from '../_internal/memory';
import { copyPath, validateCopyOptions, type CopyOptions } from './copy';
import { globPaths, validateGlobOptions, validateGlobPatterns, type GlobOptions, type GlobResult } from './glob';
import { readvSync, writevSync } from './sync';

const fs = import.meta.use('fs');
const asfs = import.meta.use('asyncfs');

type NoParamCallback = (err: NodeJS.ErrnoException | null) => void;
type OpendirCallback = (err: NodeJS.ErrnoException | null, dir?: import('fs').Dir) => void;
type FsOptionBag = {
    encoding?: BufferEncoding | 'buffer' | null;
    flag?: string | number;
    mode?: Mode;
    recursive?: boolean;
    force?: boolean;
    withFileTypes?: boolean;
    bigint?: boolean;
    signal?: AbortSignal;
};

function optionBag(value: unknown): FsOptionBag {
    return value !== null && typeof value === 'object' ? value as FsOptionBag : {};
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' ? value : fallback;
}

function assertCallback(callback: unknown): asserts callback is (...args: unknown[]) => void {
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type function');
    }
}

function runFsCallback(callback: unknown, fn: () => void): void {
    assertCallback(callback);
    queueMicrotask(fn);
}

// File read/write - callback style

export function readFile(
    path: PathLike | number,
    options: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding | null,
    callback: (err: NodeJS.ErrnoException | null, data: string | Buffer) => void
): void;
export function readFile(path: PathLike | number, callback: (err: NodeJS.ErrnoException | null, data: Buffer) => void): void;
export function readFile(path: PathLike | number, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const target = splitPathOrFd(path);
    const option = optionBag(options);
    const encoding = typeof options === 'string' ? options : option.encoding;
    const flag = option.flag;
    const signal = option.signal;
    assertCallback(callback);
    if (signal?.aborted) {
        queueMicrotask(() => callback(makeAbortError(signal), Buffer.alloc(0)));
        return;
    }
    if ('fd' in target) {
        queueMicrotask(() => {
            if (signal?.aborted) {
                callback(makeAbortError(signal), Buffer.alloc(0));
                return;
            }
            let result: string | Buffer;
            try {
                const out = readFileFromFdSync(fs.read, target.fd, getTierLimits().readBufSize);
                result = decodeBuffer(out, encoding);
            } catch (err) {
                callback(toErrnoException(err, 'readFile', describeFd(target.fd)));
                return;
            }
            callback(null, result);
        });
        return;
    }

    const read = flag === undefined ? asfs.readFile(target.path) : readFileWithFlag(target.path, flag);
    let settled = false;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    };
    const finish = (err: NodeJS.ErrnoException | null, result: string | Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(err, result);
    };
    if (signal) {
        onAbort = () => finish(makeAbortError(signal), Buffer.alloc(0));
        signal.addEventListener('abort', onAbort, { once: true });
    }
    read.then(
        buffer => {
            if (signal?.aborted) {
                finish(makeAbortError(signal), Buffer.alloc(0));
                return;
            }
            const result = decodeBuffer(toUint8Array(buffer), encoding);
            finish(null, result);
        },
        err => finish(toErrnoException(err, 'readFile', target.path), Buffer.alloc(0))
    );
}

async function readFileWithFlag(path: string, flag: string | number): Promise<Uint8Array<ArrayBuffer>> {
    const handle = await asfs.open(path, parseFlags(flag));
    try {
        const st = await handle.stat();
        const buf = new Uint8Array(st.size);
        let off = 0;
        while (off < st.size) {
            const n = await handle.read(buf.subarray(off));
            if (n === 0) break;
            off += n;
        }
        return buf;
    } finally {
        await handle.close();
    }
}

export function writeFile(
    path: PathLike | number,
    data: string | Uint8Array | ArrayBuffer,
    options: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | null,
    callback: NoParamCallback
): void;
export function writeFile(
    path: PathLike | number,
    data: string | Uint8Array | ArrayBuffer,
    callback: NoParamCallback
): void;
export function writeFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const target = splitPathOrFd(path);
    const option = optionBag(options);
    const mode = modeToNumber(option.mode);
    const flag = option.flag !== undefined ? parseFlags(option.flag) : 'w';
    const encoding = typeof options === 'string' ? options : option.encoding;
    const buffer = toUint8Array(data, encoding);
    assertCallback(callback);
    if ('fd' in target) {
        // Node: write from current offset; do not ftruncate the fd.
        queueMicrotask(() => {
            try {
                fs.write(target.fd, buffer);
            } catch (err) {
                callback(toErrnoException(err, 'writeFile', describeFd(target.fd)));
                return;
            }
            callback(null);
        });
        return;
    }

    asfs.open(target.path, flag, mode).then(
        handle => 
            handle.write(buffer).then(
                () => callback(null),
                err => callback(toErrnoException(err, 'writeFile', target.path))
            ).finally(() => handle.close()),
        err => callback(toErrnoException(err, 'writeFile', target.path))
    );
}

export function appendFile(
    path: PathLike | number,
    data: string | Uint8Array | ArrayBuffer,
    options: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | null,
    callback: NoParamCallback
): void;
export function appendFile(
    path: PathLike | number,
    data: string | Uint8Array | ArrayBuffer,
    callback: NoParamCallback
): void;
export function appendFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const target = splitPathOrFd(path);
    const option = optionBag(options);
    const mode = modeToNumber(option.mode);
    const flag = option.flag !== undefined ? parseFlags(option.flag) : 'a';
    const encoding = typeof options === 'string' ? options : option.encoding;
    const buffer = toUint8Array(data, encoding);
    assertCallback(callback);
    if ('fd' in target) {
        queueMicrotask(() => {
            try {
                fs.write(target.fd, buffer);
            } catch (err) {
                callback(toErrnoException(err, 'appendFile', describeFd(target.fd)));
                return;
            }
            callback(null);
        });
        return;
    }

    asfs.open(target.path, flag, mode).then(
        handle =>
            handle.write(buffer).then(
                () => callback(null),
                err => callback(toErrnoException(err, 'appendFile', target.path))
            ).finally(() => handle.close()),
        err => callback(toErrnoException(err, 'appendFile', target.path))
    );
}

// File status - callback style

export function exists(path: PathLike, callback: (exists: boolean) => void): void {
    assertCallback(callback);
    const pathStr = pathToString(path);
    asfs.stat(pathStr).then(
        () => callback(true),
        () => callback(false)
    );
}

Object.defineProperty(exists, Symbol.for('nodejs.util.promisify.custom'), {
    value(path: PathLike): Promise<boolean> {
        const pathStr = pathToString(path);
        return asfs.stat(pathStr).then(
            () => true,
            () => false,
        );
    },
    configurable: true,
});

export function stat(path: PathLike, callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void): void;
export function stat(
    path: PathLike,
    options: { bigint?: boolean; throwIfNoEntry?: boolean },
    callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void
): void;
export function stat(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const option = optionBag(options);
    asfs.stat(pathStr).then(
        st => callback(null, toNodeStat(st, option)),
        err => callback(toErrnoException(err, 'stat', pathStr))
    );
}

export function lstat(path: PathLike, callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void): void;
export function lstat(
    path: PathLike,
    options: { bigint?: boolean; throwIfNoEntry?: boolean },
    callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void
): void;
export function lstat(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const option = optionBag(options);
    asfs.lstat(pathStr).then(
        st => callback(null, toNodeStat(st, option)),
        err => callback(toErrnoException(err, 'lstat', pathStr))
    );
}

export function fstat(fd: number, callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void): void;
export function fstat(
    fd: number,
    options: { bigint?: boolean },
    callback: (err: NodeJS.ErrnoException | null, stats: import('fs').Stats) => void
): void;
export function fstat(fd: number, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    assertCallback(callback);
    const option = optionBag(options);
    queueMicrotask(() => {
        let st: CModuleFS.Stats;
        try {
            st = fs.fstat(fd);
        } catch (err) {
            callback(toErrnoException(err, 'fstat', describeFd(fd)));
            return;
        }
        callback(null, toNodeStat(st, option));
    });
}

export function access(path: PathLike, callback: NoParamCallback): void;
export function access(path: PathLike, mode: number, callback: NoParamCallback): void;
export function access(path: PathLike, mode?: unknown, callback?: unknown): void {
    if (typeof mode === 'function') {
        callback = mode;
        mode = fs.F_OK;
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const accessMode = typeof mode === 'number' ? mode : fs.F_OK;
    // Mode-aware: use sync fs.access (asyncfs has no access).
    queueMicrotask(() => {
        try {
            fs.access(pathStr, accessMode);
            callback(null);
        } catch (err) {
            callback(toErrnoException(err, 'access', pathStr));
        }
    });
}

// Directory operations - callback style

export function mkdir(path: PathLike, callback: NoParamCallback): void;
export function mkdir(path: PathLike, mode: Mode | { mode?: number; recursive?: boolean }, callback: NoParamCallback): void;
export function mkdir(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const option = optionBag(options);
    const mode = modeToNumber(option.mode ?? (typeof options === 'string' || typeof options === 'number' ? options : undefined));
    const recursive = option.recursive === true;

    if (recursive) {
        // Node callback mkdir recursive: (err, path?) — first created path.
        mkdirRecursive(pathStr, mode).then(
            first => callback(null, first),
            err => callback(toErrnoException(err, 'mkdir', pathStr)),
        );
    } else {
        asfs.mkdir(pathStr, mode).then(() => callback(null), err => callback(toErrnoException(err, 'mkdir', pathStr)));
    }
}

export function rmdir(path: PathLike, callback: NoParamCallback): void;
export function rmdir(path: PathLike, options: { recursive?: boolean; maxRetries?: number; retryDelay?: number }, callback: NoParamCallback): void;
export function rmdir(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const option = optionBag(options);

    if (option.recursive) {
        removeRecursive(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rmdir', pathStr)));
    } else {
        asfs.rmdir(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rmdir', pathStr)));
    }
}

export function rm(path: PathLike, callback: NoParamCallback): void;
export function rm(path: PathLike, options: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }, callback: NoParamCallback): void;
export function rm(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const option = optionBag(options);

    asfs.lstat(pathStr).then(
        stats => {
            // Symlink-to-dir is not a directory for rm — always unlink the link.
            if (stats.isDirectory && !stats.isSymbolicLink) {
                if (option.recursive) {
                    removeRecursive(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rm', pathStr)));
                } else {
                    callback(rmIsDirectoryError(pathStr));
                }
            } else {
                asfs.unlink(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'rm', pathStr)));
            }
        },
        err => {
            const normalized = toErrnoException(err, 'rm', pathStr);
            if (option.force && normalized.code === 'ENOENT') callback(null);
            else callback(normalized);
        }
    );
}

export function readdir(
    path: PathLike,
    callback: (err: NodeJS.ErrnoException | null, files: string[]) => void
): void;
export function readdir(
    path: PathLike,
    options: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding,
    callback: (err: NodeJS.ErrnoException | null, files: Array<string | Buffer> | import('fs').Dirent<string | Buffer>[]) => void
): void;
export function readdir(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    validateReaddirOptions(options);
    const pathStr = pathToString(path);
    const option = optionBag(options);
    const withFileTypes = option.withFileTypes === true;
    const recursive = option.recursive === true;

    readDirEntries(pathStr, recursive).then(
        entries => {
            callback(null, withFileTypes
                ? entries.map(entry => {
                    const dirent = toNodeDirentAsync(
                        entry,
                        entry.parentPath,
                        encodePathResult(entry.name, typeof options === 'string' ? options : option),
                    );
                    if (path instanceof Uint8Array) {
                        Reflect.set(dirent, 'parentPath', encodePathResult(entry.parentPath, 'buffer'));
                    }
                    return dirent;
                })
                : entries.map(entry => encodePathResult(entry.relativePath, typeof options === 'string' ? options : option))
            );
        },
        err => callback(toErrnoException(err, 'readdir', pathStr))
    );
}

// File operations - callback style

export function unlink(path: PathLike, callback: NoParamCallback): void {
    assertCallback(callback);
    const pathStr = pathToString(path);
    asfs.unlink(pathStr).then(() => callback(null), err => callback(toErrnoException(err, 'unlink', pathStr)));
}

export function rename(oldPath: PathLike, newPath: PathLike, callback: NoParamCallback): void {
    assertCallback(callback);
    const oldStr = pathToString(oldPath);
    const newStr = pathToString(newPath);
    asfs.rename(oldStr, newStr).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'rename', oldStr, newStr))
    );
}

export function copyFile(src: PathLike, dest: PathLike, callback: NoParamCallback): void;
export function copyFile(src: PathLike, dest: PathLike, mode: number, callback: NoParamCallback): void;
export function copyFile(src: PathLike, dest: PathLike, mode?: unknown, callback?: unknown): void {
    if (typeof mode === 'function') {
        callback = mode;
        mode = 0;
    }

    assertCallback(callback);
    const srcStr = pathToString(src);
    const destStr = pathToString(dest);
    try {
        assertCopyFileMode(srcStr, destStr, mode);
    } catch (err) {
        queueMicrotask(() => callback(toErrnoException(err, 'copyFile', srcStr, destStr)));
        return;
    }
    asfs.copyFile(srcStr, destStr).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'copyFile', srcStr, destStr))
    );
}

export function cp(source: PathLike, destination: PathLike, callback: NoParamCallback): void;
export function cp(source: PathLike, destination: PathLike, options: CopyOptions, callback: NoParamCallback): void;
export function cp(source: PathLike, destination: PathLike, options?: CopyOptions | NoParamCallback, callback?: NoParamCallback): void {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    assertCallback(callback);
    const resolvedOptions = validateCopyOptions(options);
    const sourcePath = pathToString(source);
    const destinationPath = pathToString(destination);
    copyPath(sourcePath, destinationPath, resolvedOptions).then(
        () => callback(null),
        error => callback(toErrnoException(error, 'cp', sourcePath, destinationPath)),
    );
}

export function glob(
    pattern: string | readonly string[],
    callback: (error: NodeJS.ErrnoException | null, matches: string[]) => void,
): void;
export function glob(
    pattern: string | readonly string[],
    options: GlobOptions,
    callback: (error: NodeJS.ErrnoException | null, matches: GlobResult[]) => void,
): void;
export function glob(
    pattern: string | readonly string[],
    options?: GlobOptions | ((error: NodeJS.ErrnoException | null, matches: string[]) => void),
    callback?: (error: NodeJS.ErrnoException | null, matches: GlobResult[]) => void,
): void {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    assertCallback(callback);
    validateGlobOptions(options);
    validateGlobPatterns(pattern);
    globPaths(pattern, options).then(
        matches => callback(null, matches),
        error => callback(toErrnoException(error, 'glob')),
    );
}

export function truncate(path: PathLike, callback: NoParamCallback): void;
export function truncate(path: PathLike, len: number, callback: NoParamCallback): void;
export function truncate(path: PathLike, len?: unknown, callback?: unknown): void {
    if (typeof len === 'function') {
        callback = len;
        len = 0;
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const size = numberOr(len, 0);
    asfs.open(pathStr, 'r+').then(
        handle => 
            handle.truncate(size).then(
                () => callback(null),
                err => callback(toErrnoException(err, 'truncate', pathStr))
            ).finally(() => handle.close()),
        err => callback(toErrnoException(err, 'truncate', pathStr))
    );
}

export function ftruncate(fd: number, callback: NoParamCallback): void;
export function ftruncate(fd: number, len: number, callback: NoParamCallback): void;
export function ftruncate(fd: number, len?: unknown, callback?: unknown): void {
    if (typeof len === 'function') {
        callback = len;
        len = 0;
    }
    const size = numberOr(len, 0);
    runFsCallback(callback, () => {
        try {
            fs.ftruncate(fd, size);
        } catch (err) {
            callback(toErrnoException(err, 'ftruncate', describeFd(fd)));
            return;
        }
        callback(null);
    });
}

// Link operations - callback style

export function link(existingPath: PathLike, newPath: PathLike, callback: NoParamCallback): void {
    assertCallback(callback);
    const existingStr = pathToString(existingPath);
    asfs.link(existingStr, pathToString(newPath)).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'link', existingStr))
    );
}

export function symlink(target: PathLike, path: PathLike, callback: NoParamCallback): void;
export function symlink(target: PathLike, path: PathLike, type: 'file' | 'dir' | 'junction', callback: NoParamCallback): void;
export function symlink(target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction' | NoParamCallback, callback?: NoParamCallback): void {
    if (typeof type === 'function') {
        callback = type;
        type = 'file';
    }

    assertCallback(callback);
    const symlinkType: CModuleAsyncFS.SymlinkType = type === 'dir' ? asfs.SymlinkType.DIR : type === 'junction' ? asfs.SymlinkType.JUNCTION : 0;
    asfs.symlink(pathToString(target), pathToString(path), symlinkType).then(
        () => callback(null),
        (err) => callback(toErrnoException(err, 'symlink', pathToString(path)))
    );
}

export function readlink(
    path: PathLike,
    callback: (err: NodeJS.ErrnoException | null, linkString: string) => void
): void;
export function readlink(
    path: PathLike,
    options: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding,
    callback: (err: NodeJS.ErrnoException | null, linkString: string | Buffer) => void
): void;
export function readlink(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    asfs.readLink(pathToString(path)).then(
        result => callback(null, result),
        err => callback(toErrnoException(err, 'readlink', pathToString(path)))
    );
}

export function realpath(
    path: PathLike,
    callback: (err: NodeJS.ErrnoException | null, resolvedPath: string) => void
): void;
export function realpath(
    path: PathLike,
    options: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding,
    callback: (err: NodeJS.ErrnoException | null, resolvedPath: string | Buffer) => void
): void;
export function realpath(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const encodingOpt = typeof options === 'string' ? options : optionBag(options);
    asfs.realPath(pathStr).then(
        result => callback(null, encodePathResult(result, encodingOpt)),
        err => callback(toErrnoException(err, 'realpath', pathStr))
    );
}

export function mkdtemp(prefix: string, callback: (err: NodeJS.ErrnoException | null, folder: string | Buffer) => void): void;
export function mkdtemp(prefix: string, options: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding, callback: (err: NodeJS.ErrnoException | null, folder: string | Buffer) => void): void;
export function mkdtemp(prefix: string, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    const dirPath = prefix + randomHex();
    const option = optionBag(options);
    const result = encodePathResult(dirPath, typeof options === 'string' ? options : option);
    asfs.mkdir(dirPath).then(
        () => callback(null, result),
        err => callback(toErrnoException(err, 'mkdtemp', dirPath), ''),
    );
}

// Permission operations - callback style

export function chmod(path: PathLike, mode: Mode, callback: NoParamCallback): void {
    assertCallback(callback);
    const pathStr = pathToString(path);
    asfs.chmod(pathStr, modeToNumber(mode)).then(
        () => callback(null),
        err => callback(toErrnoException(err, 'chmod', pathStr))
    );
}

export function fchmod(fd: number, mode: Mode, callback: NoParamCallback): void {
    const parsedMode = modeToNumber(mode);
    runFsCallback(callback, () => {
        try {
            fs.fchmod(fd, parsedMode);
        } catch (err) {
            callback(toErrnoException(err, 'fchmod', describeFd(fd)));
            return;
        }
        callback(null);
    });
}

export function lchmod(path: PathLike, mode: Mode, callback: NoParamCallback): void {
    // Linux has no lchmod; Node throws ENOSYS on symlinks.
    const pathStr = pathToString(path);
    const parsedMode = modeToNumber(mode);
    runFsCallback(callback, () => {
        try {
            const st = fs.lstat(pathStr);
            if (st.isSymbolicLink) {
                const err = new Error(`ENOSYS: function not implemented, lchmod '${pathStr}'`) as NodeJS.ErrnoException;
                err.code = 'ENOSYS';
                err.syscall = 'lchmod';
                err.path = pathStr;
                callback(err);
                return;
            }
            fs.chmod(pathStr, parsedMode);
        } catch (err) {
            callback(toErrnoException(err, 'lchmod', pathStr));
            return;
        }
        callback(null);
    });
}

export function chown(path: PathLike, uid: number, gid: number, callback: NoParamCallback): void {
    assertCallback(callback);
    const pathStr = pathToString(path);
    asfs.chown(pathStr, uid, gid).then(() => callback(null), err => callback(toErrnoException(err, 'chown', pathStr)));
}

export function fchown(fd: number, uid: number, gid: number, callback: NoParamCallback): void {
    runFsCallback(callback, () => {
        try {
            fs.fchown(fd, uid, gid);
        } catch (err) {
            callback(toErrnoException(err, 'fchown', describeFd(fd)));
            return;
        }
        callback(null);
    });
}

export function lchown(path: PathLike, uid: number, gid: number, callback: NoParamCallback): void {
    assertCallback(callback);
    const pathStr = pathToString(path);
    asfs.lchown(pathStr, uid, gid).then(() => callback(null), err => callback(toErrnoException(err, 'lchown', pathStr)));
}

// Time operations - callback style

export function utimes(path: PathLike, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    assertCallback(callback);
    const pathStr = pathToString(path);
    asfs.utime(
        pathStr,
        timeToNumber(atime),
        timeToNumber(mtime)
    ).then(() => callback(null), err => callback(toErrnoException(err, 'utimes', pathStr)));
}

export function futimes(fd: number, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    const atimeSec = timeToNumber(atime) / 1000;
    const mtimeSec = timeToNumber(mtime) / 1000;
    runFsCallback(callback, () => {
        try {
            fs.futimes(fd, atimeSec, mtimeSec);
        } catch (err) {
            callback(toErrnoException(err, 'futimes', describeFd(fd)));
            return;
        }
        callback(null);
    });
}

export function lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    assertCallback(callback);
    const pathStr = pathToString(path);
    asfs.lutime(
        pathStr,
        timeToNumber(atime),
        timeToNumber(mtime)
    ).then(() => callback(null), err => callback(toErrnoException(err, 'lutimes', pathStr)));
}

// File descriptor operations - callback style

export function open(path: PathLike, callback: (err: NodeJS.ErrnoException | null, fd: number) => void): void;
export function open(path: PathLike, flags: string | number, callback: (err: NodeJS.ErrnoException | null, fd: number) => void): void;
export function open(path: PathLike, flags: string | number, mode: Mode, callback: (err: NodeJS.ErrnoException | null, fd: number) => void): void;
export function open(path: PathLike, flags?: unknown, mode?: unknown, callback?: unknown): void {
    if (typeof flags === 'function') {
        callback = flags;
        flags = 'r';
        mode = 0o666;
    } else if (typeof mode === 'function') {
        callback = mode;
        mode = 0o666;
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const openFlags = typeof flags === 'string' || typeof flags === 'number' ? flags : 'r';
    const openMode = modeToNumber(typeof mode === 'string' || typeof mode === 'number' ? mode : 0o666);
    Promise.resolve().then(() => {
        let fd: number;
        try {
            fd = fs.open(pathStr, parseFlags(openFlags), openMode);
        } catch (err) {
            callback(toErrnoException(err, 'open', pathStr));
            return;
        }
        callback(null, fd);
    });
}

export function close(fd: number, callback: NoParamCallback = () => {}): void {
    validateFd(fd);
    runFsCallback(callback, () => {
        try {
            fs.close(fd);
        } catch (err) {
            callback(toErrnoException(err, 'close', describeFd(fd)));
            return;
        }
        callback(null);
    });
}

export function read(
    fd: number,
    buffer: Buffer<ArrayBuffer> | Uint8Array<ArrayBuffer>,
    offset: number,
    length: number,
    position: number | null,
    callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer | Uint8Array) => void
): void {
    runFsCallback(callback, () => {
        let bytesRead: number;
        try {
            if (position !== null && position !== undefined) {
                bytesRead = fs.pread(fd, buffer.subarray(offset, offset + length), position);
            } else {
                bytesRead = fs.read(fd, buffer.subarray(offset, offset + length));
            }
        } catch (err) {
            callback(toErrnoException(err, 'read', describeFd(fd)), 0, buffer);
            return;
        }
        callback(null, bytesRead, buffer);
    });
}

export function readv(
    fd: number,
    buffers: readonly ArrayBufferView[],
    callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffers: readonly ArrayBufferView[]) => void,
): void;
export function readv(
    fd: number,
    buffers: readonly ArrayBufferView[],
    position: number | null,
    callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffers: readonly ArrayBufferView[]) => void,
): void;
export function readv(fd: number, buffers: readonly ArrayBufferView[], position?: unknown, callback?: unknown): void {
    if (typeof position === 'function') {
        callback = position;
        position = null;
    }
    const readPosition = position === null || position === undefined ? null : numberOr(position, 0);
    runFsCallback(callback, () => {
        try {
            callback(null, readvSync(fd, buffers, readPosition), buffers);
        } catch (err) {
            callback(toErrnoException(err, 'readv', describeFd(fd)), 0, buffers);
        }
    });
}

export function write(
    fd: number,
    buffer: Buffer | Uint8Array | string,
    offset: number,
    length: number,
    position: number | null,
    callback: (err: NodeJS.ErrnoException | null, written: number, buffer: Buffer | Uint8Array | string) => void
): void;
export function write(
    fd: number,
    buffer: Buffer | Uint8Array | string,
    callback: (err: NodeJS.ErrnoException | null, written: number, buffer: Buffer | Uint8Array | string) => void
): void;
export function write(fd: number, buffer: Buffer | Uint8Array | string, offset?: unknown, length?: unknown, position?: unknown, callback?: unknown): void {
    if (typeof offset === 'function') {
        callback = offset;
        offset = 0;
        length = buffer.length;
        position = null;
    } else if (typeof length === 'function') {
        callback = length;
        length = buffer.length - offset;
        position = null;
    } else if (typeof position === 'function') {
        callback = position;
        position = null;
    }

    const data = typeof buffer === 'string' ? toUint8Array(buffer) : buffer;
    const start = numberOr(offset, 0);
    const count = numberOr(length, data.length - start);
    const writePosition = typeof position === 'number' ? position : null;
    runFsCallback(callback, () => {
        let written: number;
        try {
            if (writePosition !== null) {
                written = fs.pwrite(fd, data.subarray(start, start + count), writePosition);
            } else {
                written = fs.write(fd, data.subarray(start, start + count));
            }
        } catch (err) {
            callback(toErrnoException(err, 'write', describeFd(fd)), 0, buffer);
            return;
        }
        callback(null, written, buffer);
    });
}

export function writev(
    fd: number,
    buffers: readonly ArrayBufferView[],
    callback: (err: NodeJS.ErrnoException | null, bytesWritten: number, buffers: readonly ArrayBufferView[]) => void,
): void;
export function writev(
    fd: number,
    buffers: readonly ArrayBufferView[],
    position: number | null,
    callback: (err: NodeJS.ErrnoException | null, bytesWritten: number, buffers: readonly ArrayBufferView[]) => void,
): void;
export function writev(fd: number, buffers: readonly ArrayBufferView[], position?: unknown, callback?: unknown): void {
    if (typeof position === 'function') {
        callback = position;
        position = null;
    }
    const writePosition = position === null || position === undefined ? null : numberOr(position, 0);
    runFsCallback(callback, () => {
        try {
            callback(null, writevSync(fd, buffers, writePosition), buffers);
        } catch (err) {
            callback(toErrnoException(err, 'writev', describeFd(fd)), 0, buffers);
        }
    });
}

export function fsync(fd: number, callback: NoParamCallback): void {
    runFsCallback(callback, () => {
        try {
            fs.fsync(fd);
        } catch (err) {
            callback(toErrnoException(err, 'fsync', describeFd(fd)));
            return;
        }
        callback(null);
    });
}

export function fdatasync(fd: number, callback: NoParamCallback): void {
    runFsCallback(callback, () => {
        try {
            fs.fdatasync(fd);
        } catch (err) {
            callback(toErrnoException(err, 'fdatasync', describeFd(fd)));
            return;
        }
        callback(null);
    });
}

// statfs - callback style

export function statfs(path: PathLike, callback: (err: NodeJS.ErrnoException | null, stats: import('fs').StatsFs) => void): void;
export function statfs(
    path: PathLike,
    options: { bigint?: boolean },
    callback: (err: NodeJS.ErrnoException | null, stats: import('fs').StatsFs) => void
): void;
export function statfs(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    const pathStr = pathToString(path);
    const statOptions = optionBag(options);
    asfs.statFs(pathStr).then(
        result => callback(null, toNodeStatFs(result, statOptions)),
        err => callback(toErrnoException(err, 'statfs', pathStr))
    );
}

// opendir - callback style

export function opendir(path: PathLike, callback: OpendirCallback): void;
export function opendir(
    path: PathLike,
    options: { encoding?: BufferEncoding; bufferSize?: number },
    callback: OpendirCallback
): void;
export function opendir(path: PathLike, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    assertCallback(callback);
    let pathStr: string;
    try {
        validateOpendirOptions(options);
        pathStr = pathToString(path);
    } catch (err) {
        callback(errorFromUnknown(err));
        return;
    }
    asfs.readDir(pathStr).then(
        dirHandle => callback(null, createAsyncDir(pathStr, dirHandle)),
        err => callback(toErrnoException(err, 'opendir', pathStr))
    );
}
