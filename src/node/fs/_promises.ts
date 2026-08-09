/**
 * Node.js fs.promises API
 */


import { matchesErrnoCode } from '../_internal/errno';
import { wrapFsPromise, normalizeFsErrnoError as normalizeErrnoError } from './errno-fix';
import { getTierLimits } from '../_internal/memory';
import { resolve } from '../path';
import { copyPath, validateCopyOptions, type CopyOptions } from './copy';
import { globPaths, type GlobOptions, type GlobResult } from './glob';
import { ReadStream, WriteStream } from './streams';
import { createAsyncDir, createEagerAsyncDir, createFileHandle, decodeBuffer, encodePathResult, mkdirRecursive, modeToNumber, parseFlags, pathToString, randomHex, readDirEntries, readFileFromFdSync, removeRecursive, retryOnBusy, splitPathOrFd, timeToUnixMs, toNodeDirentAsync, toNodeStat, toNodeStatFs, toUint8Array, validateOpendirOptions, validateReaddirOptions, assertCopyFileMode, makeAbortError, rmIsDirectoryError, writeAllHandle, writeAllSync, type Mode, type PathLike, type TimeLike } from './utils';

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

import { nsfs, nsasfs, nsfswatch } from './syspath';
const asfs = nsasfs;
const fs = nsfs;

// Helper: wrap asyncfs calls, auto-convert errno to ErrnoException.
// `wrapFsPromise` also rewrites the JS API name to the libuv syscall name node
// reports (readdir -> scandir, utimes -> utime); see fs/syscall-names.ts.
function w<T>(promise: Promise<T>, syscall: string, path: string, dest?: string): Promise<T> {
    return wrapFsPromise(promise, syscall, path, dest);
}

// File read/write

export async function readFile(path: PathLike | number, options?: { encoding?: BufferEncoding | null; flag?: string | number; signal?: AbortSignal } | BufferEncoding): Promise<string | Uint8Array> {
    const target = splitPathOrFd(path);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const flag = typeof options === 'object' ? options?.flag : undefined;
    const signal = typeof options === 'object' ? options?.signal : undefined;
    if (signal?.aborted) throw makeAbortError(signal);
    const buffer = 'fd' in target
        ? readFileFromFdSync(fs.read, target.fd, READ_BUF_SIZE)
        : flag === undefined
            ? await withAbort(w(asfs.readFile(target.path), 'readFile', target.path), signal)
            : await withAbort(readFileWithFlag(target.path, flag), signal);
    if (signal?.aborted) throw makeAbortError(signal);
    return decodeBuffer(buffer, encoding);
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw makeAbortError(signal);
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(makeAbortError(signal));
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => {
                cleanup();
                resolve(value);
            },
            err => {
                cleanup();
                reject(err);
            },
        );
    });
}

async function readFileWithFlag(path: string, flag: string | number): Promise<Uint8Array<ArrayBuffer>> {
    const handle = await w(asfs.open(path, parseFlags(flag)), 'readFile', path);
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

/**
 * Collect an Iterable/AsyncIterable (which includes a Readable stream) of
 * string/Buffer chunks into one buffer. Returns null when `data` is not one, so
 * the caller falls back to the normal single-value conversion. A string is
 * itself iterable, so it must be excluded before the protocol check.
 */
async function drainIterableData(
    data: unknown,
    encoding: BufferEncoding | null | undefined,
    signal: AbortSignal | undefined,
): Promise<Uint8Array | null> {
    if (typeof data === 'string' || data === null || data === undefined) return null;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return null;
    if (typeof data !== 'object' && typeof data !== 'function') return null;
    const holder = data as { [Symbol.asyncIterator]?: unknown; [Symbol.iterator]?: unknown };
    const isAsync = typeof holder[Symbol.asyncIterator] === 'function';
    if (!isAsync && typeof holder[Symbol.iterator] !== 'function') return null;

    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of data as AsyncIterable<unknown>) {
        if (signal?.aborted) throw makeAbortError(signal);
        const bytes = toUint8Array(chunk as string | Uint8Array | ArrayBuffer, encoding);
        parts.push(bytes);
        total += bytes.byteLength;
    }
    const outBuf = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        outBuf.set(part, at);
        at += part.byteLength;
    }
    return outBuf;
}

export async function writeFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number; signal?: AbortSignal } | BufferEncoding | number): Promise<void> {
    const target = splitPathOrFd(path);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' && options?.flag !== undefined ? parseFlags(options.flag) : 'w';
    const encoding = typeof options === 'string' ? options : typeof options === 'object' ? options?.encoding : undefined;
    // Node honours `signal` here; it was accepted and ignored, so an aborted
    // write still hit the disk and resolved.
    const signal = typeof options === 'object' && options !== null ? (options as { signal?: AbortSignal }).signal : undefined;
    if (signal?.aborted) throw makeAbortError(signal);
    // Node's promises API also accepts an Iterable / AsyncIterable / stream and
    // streams its chunks into the file. These used to reach toUint8Array and
    // produce a zero-length write, i.e. an empty file with no error.
    const chunks = await drainIterableData(data, encoding, signal);
    const buffer = chunks ?? toUint8Array(data, encoding);
    if ('fd' in target) {
        // Node: write from current offset; do not ftruncate the fd.
        writeAllSync(target.fd, buffer);
        return;
    }

    const handle = await w(asfs.open(target.path, flag, mode), 'writeFile', target.path);
    try {
        if (signal?.aborted) throw makeAbortError(signal);
        await w(writeAllHandle(handle, buffer), 'writeFile', target.path);
    } finally {
        await handle.close();
    }
}

export async function appendFile(path: PathLike | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: Mode; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const target = splitPathOrFd(path);
    const mode = typeof options === 'object' ? modeToNumber(options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' && options?.flag !== undefined ? parseFlags(options.flag) : 'a';
    const encoding = typeof options === 'string' ? options : typeof options === 'object' ? options?.encoding : undefined;
    const buffer = toUint8Array(data, encoding);
    if ('fd' in target) {
        writeAllSync(target.fd, buffer);
        return;
    }

    const handle = await w(asfs.open(target.path, flag, mode), 'appendFile', target.path);
    try {
        await w(writeAllHandle(handle, buffer), 'appendFile', target.path);
    } finally {
        await handle.close();
    }
}

// File status

export async function access(path: PathLike, mode?: number): Promise<void> {
    // asyncfs has no access(); bridge sync fs.access (mode-aware) via microtask.
    const pathStr = pathToString(path);
    const m = mode ?? fs.F_OK;
    try {
        fs.access(pathStr, m);
    } catch (e) {
        throw normalizeErrnoError(e, 'access', pathStr);
    }
}

export async function stat(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const pathStr = pathToString(path);
    const st = await w(asfs.stat(pathStr), 'stat', pathStr);
    return toNodeStat(st, options);
}

export async function lstat(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const pathStr = pathToString(path);
    const st = await w(asfs.lstat(pathStr), 'lstat', pathStr);
    return toNodeStat(st, options);
}

// Directory operations

export async function mkdir(path: PathLike, options?: { mode?: number; recursive?: boolean } | number): Promise<string | undefined> {
    const pathStr = pathToString(path);
    const mode = typeof options === 'number' ? options : options?.mode;
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        // Node returns the first created directory, or undefined if all existed.
        return await w(mkdirRecursive(pathStr, mode), 'mkdir', pathStr);
    }

    await w(asfs.mkdir(pathStr, mode), 'mkdir', pathStr);
    return undefined;
}

export async function rmdir(path: PathLike, options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void> {
    const pathStr = pathToString(path);

    if (options?.recursive) {
        // Was unwrapped and unretried: measured before, fsp.rmdir(missing,
        // {recursive}) rejected with a bare `-4058` (no code/syscall/path) where
        // Node gives ENOENT. Node labels the recursive form `rm`.
        await retryOnBusy(
            () => w(removeRecursive(pathStr), 'rm', pathStr),
            options.maxRetries,
            options.retryDelay,
        );
    } else {
        await w(asfs.rmdir(pathStr), 'rmdir', pathStr);
    }
}

export async function rm(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void> {
    const pathStr = pathToString(path);
    let stats: CModuleAsyncFS.StatResult;
    try {
        stats = await w(asfs.lstat(pathStr), 'lstat', pathStr);
    } catch (err) {
        if (options?.force && Reflect.get(err, 'code') === 'ENOENT') return;
        throw err;
    }

    // Symlink-to-dir is not a directory for rm — always unlink the link.
    if (stats.isDirectory && !stats.isSymbolicLink) {
        if (!options?.recursive) throw rmIsDirectoryError(pathStr);
        await retryOnBusy(
            () => w(removeRecursive(pathStr), 'rm', pathStr),
            options.maxRetries,
            options.retryDelay,
        );
    } else {
        await w(asfs.unlink(pathStr), 'rm', pathStr);
    }
}

export async function readdir(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding): Promise<Array<string | Buffer> | import('fs').Dirent<string | Buffer>[]> {
    validateReaddirOptions(options);
    const pathStr = pathToString(path);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;
    // Unlike readdirSync, fsp.readdir does not type-check `recursive` — a truthy
    // value walks (measured against node v24.18.0).
    const recursive = typeof options === 'object' ? Boolean(options?.recursive) : false;

    try {
        // The one place Node's two gates diverge: fsp.readdir descends into
        // junctions and directory symlinks for plain names, but *not* when
        // withFileTypes is set. Measured, and inconsistent with readdirSync,
        // which follows in both modes.
        const entries = await readDirEntries(pathStr, recursive, '', withFileTypes ? 'strict' : 'follow');
        if (withFileTypes) {
            return entries.map(entry => {
                const dirent = toNodeDirentAsync(entry, entry.parentPath, encodePathResult(entry.name, options));
                if (path instanceof Uint8Array) {
                    Reflect.set(dirent, 'parentPath', encodePathResult(entry.parentPath, 'buffer'));
                }
                return dirent;
            });
        }
        return entries.map(entry => encodePathResult(entry.relativePath, options));
    } catch (err) {
        throw normalizeErrnoError(err, 'readdir', pathStr);
    }
}

export async function opendir(path: PathLike, options?: { encoding?: BufferEncoding; bufferSize?: number; recursive?: boolean }): Promise<import('fs').Dir> {
    validateOpendirOptions(options);
    const pathStr = pathToString(path);
    // opendir does not type-check `recursive`; a truthy value walks (measured).
    if (options?.recursive) {
        // Strict gate: opendir never descends into a junction or a directory
        // symlink, unlike recursive readdirSync (measured against v24.18.0).
        const entries = await w(readDirEntries(pathStr, true, '', 'strict'), 'opendir', pathStr);
        return createEagerAsyncDir(pathStr, entries);
    }
    const dirHandle = await w(asfs.readDir(pathStr), 'opendir', pathStr);
    return createAsyncDir(pathStr, dirHandle);
}

// File operations

export async function unlink(path: PathLike): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.unlink(pathStr), 'unlink', pathStr);
}

export async function rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
    const oldStr = pathToString(oldPath);
    const newStr = pathToString(newPath);
    await w(asfs.rename(oldStr, newStr), 'rename', oldStr, newStr);
}

export async function copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void> {
    const srcStr = pathToString(src);
    const destStr = pathToString(dest);
    assertCopyFileMode(srcStr, destStr, mode);
    await w(asfs.copyFile(srcStr, destStr), 'copyFile', srcStr, destStr);
}

export async function truncate(path: PathLike, len?: number): Promise<void> {
    const pathStr = pathToString(path);
    // Node opens first and reports a failure of that step as syscall 'open'
    // (measured v24.18.0: fsp.truncate(missing) -> ENOENT, syscall 'open').
    const handle = await w(asfs.open(pathStr, 'r+'), 'open', pathStr);
    try {
        // Must be wrapped: the ftruncate step fails for a directory target, and an
        // unwrapped rejection escapes with `code` as the raw UV *number* (-4071),
        // so every `err.code === 'EINVAL'` check silently fails. Node reports this
        // step with syscall 'ftruncate'.
        await w(handle.truncate(len ?? 0), 'ftruncate', pathStr);
    } finally {
        await handle.close();
    }
}

// Link operations

export async function link(existingPath: PathLike, newPath: PathLike): Promise<void> {
    const existingStr = pathToString(existingPath);
    await w(asfs.link(existingStr, pathToString(newPath)), 'link', existingStr);
}

export async function symlink(target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction'): Promise<void> {
    // Windows: DIR=1, JUNCTION=2, FILE=0 (no flags). SymlinkType enum lacks FILE,
    // so we use 0 for file symlinks which is the correct Windows API value.
    const symlinkType: CModuleAsyncFS.SymlinkType = type === 'dir' ? asfs.FS_SYMLINK_DIR : type === 'junction' ? asfs.FS_SYMLINK_JUNCTION : 0;
    const pathStr = pathToString(path);
    await w(asfs.symlink(pathToString(target), pathStr, symlinkType), 'symlink', pathStr);
}

export async function readlink(path: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): Promise<string | Buffer> {
    const pathStr = pathToString(path);
    const result = await w(asfs.readLink(pathStr), 'readlink', pathStr);
    return encodePathResult(result, options);
}

export async function realpath(pathLike: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): Promise<string | Buffer> {
    const pathStr = pathToString(pathLike);
    const resolved = await w(asfs.realPath(pathStr), 'realpathNative', pathStr);
    return encodePathResult(resolved, options);
}

Reflect.set(realpath, 'native', function (pathLike: PathLike, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding) {
    const pathStr = pathToString(pathLike);
    return w(asfs.realPath(pathStr), 'realpathNative', pathStr).then(resolved => encodePathResult(resolved, options));
});

// Permission operations

export async function chmod(path: PathLike, mode: Mode): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.chmod(pathStr, modeToNumber(mode)), 'chmod', pathStr);
}

export async function chown(path: PathLike, uid: number, gid: number): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.chown(pathStr, uid, gid), 'chown', pathStr);
}

export async function lchown(path: PathLike, uid: number, gid: number): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.lchown(pathStr, uid, gid), 'lchown', pathStr);
}

// Time operations

export async function utimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.utime(pathStr, timeToUnixMs(atime, 'atime'), timeToUnixMs(mtime, 'mtime')), 'utimes', pathStr);
}

export async function lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
    const pathStr = pathToString(path);
    await w(asfs.lutime(pathStr, timeToUnixMs(atime, 'atime'), timeToUnixMs(mtime, 'mtime')), 'lutimes', pathStr);
}

// statfs

export async function statfs(path: PathLike, options?: { bigint?: boolean }): Promise<import('fs').StatsFs> {
    const pathStr = pathToString(path);
    const result = await w(asfs.statFs(pathStr), 'statfs', pathStr);
    return toNodeStatFs(result, options);
}

// Open file

/**
 * Node's FileHandle carries four stream/iterator members that `createFileHandle`
 * cannot build itself: utils.ts is imported *by* streams.ts, so constructing a
 * ReadStream there would close an import cycle. They are attached here instead,
 * where `./streams` is already reachable.
 *
 * Ownership matches measured Node v24.18.0: a handle stream owns the handle and
 * closes it on 'close' (a later `handle.stat()` reports EBADF), while
 * `readableWebStream` leaves the handle open and refuses a second call.
 */
function attachHandleStreams(handle: ReturnType<typeof createFileHandle>) {
    const h = handle as ReturnType<typeof createFileHandle> & {
        createReadStream?: unknown;
        createWriteStream?: unknown;
        readableWebStream?: unknown;
        readLines?: unknown;
    };
    let webStreamTaken = false;

    h.createReadStream = function createReadStream(options?: Record<string, unknown>) {
        // Passing the handle itself (not its bare fd) makes the stream close the
        // handle on teardown, matching measured Node v24.18.0: after the
        // stream's 'close', a later handle.stat() reports EBADF.
        return new ReadStream(null as unknown as PathLike, {
            highWaterMark: 64 * 1024,
            ...(options ?? {}),
            fd: handle,
        } as ConstructorParameters<typeof ReadStream>[1]);
    };

    h.createWriteStream = function createWriteStream(options?: Record<string, unknown>) {
        return new WriteStream(null as unknown as PathLike, {
            ...(options ?? {}),
            fd: handle,
        } as ConstructorParameters<typeof WriteStream>[1]);
    };

    h.readableWebStream = function readableWebStream(): ReadableStream<Uint8Array> {
        if (webStreamTaken) {
            const e = new Error('The FileHandle is already being read');
            Reflect.set(e, 'code', 'ERR_INVALID_STATE');
            throw e;
        }
        webStreamTaken = true;
        return new ReadableStream<Uint8Array>({
            async pull(controller) {
                const buffer = new Uint8Array(64 * 1024);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (!bytesRead) {
                    controller.close();
                    return;
                }
                controller.enqueue(buffer.subarray(0, bytesRead));
            },
        });
    };

    h.readLines = function readLines(options?: Record<string, unknown>) {
        const stream = (h.createReadStream as (o?: Record<string, unknown>) => ReadStream)(options);
        const iterator = async function* lines(): AsyncGenerator<string> {
            let pending = '';
            for await (const chunk of stream as unknown as AsyncIterable<Uint8Array | string>) {
                pending += typeof chunk === 'string' ? chunk : decodeBuffer(toUint8Array(chunk), 'utf8');
                let index: number;
                // Node's readline strips a trailing \r so CRLF files yield clean lines.
                while ((index = pending.indexOf('\n')) !== -1) {
                    const line = pending.slice(0, index);
                    pending = pending.slice(index + 1);
                    yield line.endsWith('\r') ? line.slice(0, -1) : line;
                }
            }
            if (pending.length > 0) yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
        };
        const it = iterator();
        return {
            [Symbol.asyncIterator]() { return it; },
            next: () => it.next(),
            return: (value?: unknown) => it.return(value as never),
            throw: (err?: unknown) => it.throw(err),
            close: () => { stream.destroy(); },
        };
    };

    return h;
}

export async function open(path: PathLike, flags?: string | number, mode?: Mode) {
    const flag = parseFlags(flags);
    const modeNum = modeToNumber(mode);
    const pathStr = pathToString(path);
    const handle = await w(asfs.open(pathStr, flag, modeNum), 'open', pathStr);
    return attachHandleStreams(createFileHandle(handle.fileno(), handle));
}

// Missing exports

export async function lchmod(path: PathLike, mode: Mode): Promise<void> {
    // Linux has no lchmod; Node throws ENOSYS on symlinks.
    const pathStr = pathToString(path);
    const st = await w(asfs.lstat(pathStr), 'lstat', pathStr);
    if (st.isSymbolicLink) {
        const err = new Error(`ENOSYS: function not implemented, lchmod '${pathStr}'`) as NodeJS.ErrnoException;
        err.code = 'ENOSYS';
        err.syscall = 'lchmod';
        err.path = pathStr;
        throw err;
    }
    await chmod(path, mode);
}

export async function mkdtemp(prefix: string, options?: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding): Promise<string | Buffer> {
    const dirPath = prefix + randomHex();
    const result = encodePathResult(dirPath, options);
    await w(asfs.mkdir(dirPath), 'mkdtemp', dirPath);
    return result;
}

export async function mkdtempDisposable(prefix: string, options?: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding): Promise<{
    path: string | Buffer;
    remove: () => Promise<void>;
    [Symbol.asyncDispose]: () => Promise<void>;
}> {
    const dirPath = prefix + randomHex();
    const result = encodePathResult(dirPath, options);
    await w(asfs.mkdir(dirPath), 'mkdir', dirPath);
    const fullPath = resolve(dirPath);
    const remove = async () => {
        try {
            await removeRecursive(fullPath);
        } catch (error) {
            if (!matchesErrnoCode(error, 'ENOENT')) throw normalizeErrnoError(error, 'rm', fullPath);
        }
    };
    return {
        path: result,
        remove,
        [Symbol.asyncDispose]() { return remove(); },
    };
}

export function watch(path: PathLike, options?: { persistent?: boolean; recursive?: boolean; encoding?: BufferEncoding; signal?: AbortSignal }): AsyncIterableIterator<{ eventType: string; filename: string | null }> {
    const pathStr = pathToString(path);
    const fswatch = nsfswatch;
    const signal = options?.signal;

    let watcher: CModuleFSWatch.FsWatcher | null = null;
    let queue: Array<{ eventType: string; filename: string | null }> = [];
    let resolveNext: ((value: IteratorResult<{ eventType: string; filename: string | null }>) => void) | null = null;
    let closed = false;

    const pushEvent = (event: { eventType: string; filename: string | null }) => {
        if (closed) return;
        if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ done: false, value: event });
        } else {
            queue.push(event);
        }
    };

    const close = async () => {
        if (closed) return;
        closed = true;
        if (watcher) {
            watcher.close();
            watcher = null;
        }
        if (resolveNext) {
            resolveNext({ done: true, value: undefined });
            resolveNext = null;
        }
    };

    try {
        watcher = fswatch.watch(pathStr, (filename, event) => {
            pushEvent({ eventType: event, filename });
        }, !!options?.recursive);
    } catch {
        void close();
    }

    if (signal) {
        signal.addEventListener('abort', () => { close(); }, { once: true });
        if (signal.aborted) close();
    }

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next() {
            if (closed) return { done: true, value: undefined };
            if (queue.length > 0) {
                const value = queue.shift();
                if (value !== undefined) return { done: false, value };
            }
            return new Promise((resolve) => {
                resolveNext = resolve;
            });
        },
        async return() {
            await close();
            return { done: true, value: undefined };
        },
    } as AsyncIterableIterator<{ eventType: string; filename: string | null }>;
}

export async function cp(source: PathLike, destination: PathLike, options?: CopyOptions): Promise<void> {
    const resolvedOptions = validateCopyOptions(options);
    const sourcePath = pathToString(source);
    const destinationPath = pathToString(destination);
    await copyPath(sourcePath, destinationPath, resolvedOptions);
}

export async function* glob(
    pattern: string | readonly string[],
    options?: GlobOptions,
): AsyncIterableIterator<GlobResult> {
    for (const result of await globPaths(pattern, options)) yield result;
}

// Export constants
export { constants } from './constants';
