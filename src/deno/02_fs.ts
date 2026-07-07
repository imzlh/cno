const fs = import.meta.use("fs");
const asfs = import.meta.use("asyncfs");
const engine = import.meta.use("engine");
const fswatch = import.meta.use("fswatch");
const os = import.meta.use("os");
const error = import.meta.use("error");
const console = import.meta.use('console');
const crypto = import.meta.use('crypto');

import { assert } from "../utils/assert";
import { join, normalize, systemPathSplit } from "../utils/path";
import { wrapFSErr, wrapFSns } from "../utils/wrap";
import { errors } from "./01_errors";
import { DOMException } from "../webapi/events";
import { arrayBufferBackedBytes } from "../utils/bytes";

export const toString = (e: URL | string): string => {
    if (!(e instanceof URL)) return e;
    if (e.protocol !== 'file:') throw new TypeError('Must be a file URL');
    let p = decodeURIComponent(e.pathname);
    // On Windows, file:///C:/foo → pathname is /C:/foo — strip the leading slash
    if (p.length >= 3 && p[0] === '/' && p[2] === ':') p = p.slice(1);
    return p;
};

export function toDenoStat(stat: CModuleAsyncFS.StatResult | CModuleFS.Stats) {
    return {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        nlink: stat.nlink,
        uid: stat.uid,
        gid: stat.gid,
        rdev: stat.rdev,
        size: stat.size,
        blksize: stat.blksize,
        blocks: stat.blocks,
        atime: stat.atim,
        mtime: stat.mtim,
        ctime: stat.ctim,
        birthtime: stat.birthtim ?? null,
        isSymlink: !!stat.isSymbolicLink,
        isCharDevice: !!stat.isCharacterDevice,
        isFifo: !!stat.isFIFO,
        isDirectory: !!stat.isDirectory,
        isFile: !!stat.isFile,
        isBlockDevice: !!stat.isBlockDevice,
        isSocket: !!stat.isSocket,
    } satisfies Deno.FileInfo;
}

/**
 * Yield directory paths that need to be created (cross-platform)
 */
function* iterMkdirPaths(fullPath: string): Generator<string> {
    const normalizedPath = fullPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/').filter(p => p !== '' && p !== '.');
    let currentPath = '';
    let i = 0;
    if (normalizedPath.startsWith('//') && parts.length >= 2) {
        currentPath = '//' + parts[0] + '/' + parts[1];
        i = 2;
    } else if (normalizedPath.startsWith('/')) {
        currentPath = '/';
    } else if (/^[A-Za-z]:/.test(normalizedPath) && parts.length > 0) {
        currentPath = parts[0] + '/';
        i = 1;
    }
    for (; i < parts.length; i++) {
        const part = parts[i];
        if (currentPath === '') currentPath = part;
        else if (currentPath.endsWith('/')) currentPath = currentPath + part;
        else currentPath = currentPath + '/' + part;
        yield currentPath;
    }
}

async function mkdirRecursive(fullPath: string, mode?: number): Promise<void> {
    for (const p of iterMkdirPaths(fullPath)) {
        await ensureDirectoryPart(p, mode);
    }
}

function mkdirRecursiveSync(fullPath: string, mode?: number): void {
    for (const p of iterMkdirPaths(fullPath)) {
        ensureDirectoryPartSync(p, mode);
    }
}

async function ensureDirectoryPart(path: string, mode?: number): Promise<void> {
    try {
        if ((await asfs.stat(path)).isDirectory) return;
    } catch {
        await asfs.mkdir(path, mode);
        return;
    }
    throw new Error(`Cannot create directory '${path}': File exists`);
}

function ensureDirectoryPartSync(path: string, mode?: number): void {
    try {
        if (fs.stat(path).isDirectory) return;
    } catch {
        fs.mkdir(path, mode);
        return;
    }
    throw new Error(`Cannot create directory '${path}': File exists`);
}

function removeRecursiveSync(targetPath: string): void {
    const stats = fs.lstat(targetPath);
    if (stats.isDirectory) {
        for (const item of fs.readdir(targetPath)) {
            removeRecursiveSync(join(targetPath, item));
        }
        fs.rmdir(targetPath);
    } else {
        fs.unlink(targetPath);
    }
}

async function removeRecursive(targetPath: string): Promise<void> {
    const stats = await asfs.lstat(targetPath);
    if (stats.isDirectory) {
        const dirHandle = await asfs.readDir(targetPath);
        try {
            for await (const entry of dirHandle) {
                await removeRecursive(join(targetPath, entry.name));
            }
        } finally {
            await dirHandle.close();
        }
        await asfs.rmdir(targetPath);
    } else {
        await asfs.unlink(targetPath);
    }
}

async function denoWriteAnyFile(path: string | URL, data: string | Uint8Array | ReadableStream<string | Uint8Array>, options?: Deno.WriteFileOptions) {
    const pathStr = toString(path);
    const flag = writeOpenFlag(options);
    throwIfAborted(options?.signal);
    if (options?.create === false) await asfs.stat(pathStr);
    const fhandle = await asfs.open(pathStr, flag, options?.mode);
    let writtenAll = false;
    try {
        if (typeof data === "string")
            data = engine.encodeString(data);

        if (data instanceof Uint8Array) {
            let written = 0;
            while (written < data.length) {
                throwIfAborted(options?.signal);
                const n = await fhandle.write(arrayBufferBackedBytes(data.subarray(written)));
                if (n === null) throw new errors.UnexpectedEof("write");
                written += n;
            }
        } else {
            const reader = data.getReader();
            while (true) {
                throwIfAborted(options?.signal);
                const { value, done } = await reader.read();
                if (done) break;
                throwIfAborted(options?.signal);
                const n = await fhandle.write(
                    toWriteBytes(value)
                );
                if (n === null) throw new errors.UnexpectedEof("write");
            }
        }
        writtenAll = true;
    } finally {
        await fhandle.close();
    }
    if (writtenAll && options?.mode !== undefined) await asfs.chmod(pathStr, options.mode);
}

function writeOpenFlag(options?: Deno.WriteFileOptions): 'wx' | 'a' | 'w' {
    if (options?.createNew) return 'wx';
    return options?.append ? 'a' : 'w';
}

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal);
}

function toWriteBytes(data: string | Uint8Array): Uint8Array<ArrayBuffer> {
    return arrayBufferBackedBytes(typeof data === 'string' ? engine.encodeString(data) : data);
}

function writeFileSyncWithOptions(path: string | URL, data: string | Uint8Array, options?: Deno.WriteFileOptions): void {
    const pathStr = toString(path);
    if (options?.create === false) fs.stat(pathStr);
    const fd = fs.open(pathStr, writeOpenFlag(options), options?.mode);
    let writtenAll = false;
    try {
        const bytes = toWriteBytes(data);
        let written = 0;
        while (written < bytes.length) {
            written += fs.write(fd, bytes.subarray(written));
        }
        writtenAll = true;
    } finally {
        fs.close(fd);
    }
    if (writtenAll && options?.mode !== undefined) fs.chmod(pathStr, options.mode);
}

function truncateLen(len?: number): number {
    return Math.max(0, len ?? 0);
}

function validateTempAffix(value: string): void {
    if (/[\0*\x00-\x1f\x7f-\x9f]/.test(value)) {
        throw new errors.InvalidData('Invalid temporary file name');
    }
}

function hasErrno(value: unknown, code: number): boolean {
    return typeof value === 'object' && value !== null
        && Reflect.get(value, 'code') === code;
}

function tempPath(dir: string, prefix: string, suffix: string): string {
    validateTempAffix(prefix);
    validateTempAffix(suffix);
    const bytes = new Uint8Array(6);
    crypto.randomFill(bytes);
    const rand = crypto.hexEncode(bytes);
    return join(dir, `${prefix}${rand}${suffix}`);
}

function symlinkType(opt?: Deno.SymlinkOptions): CModuleAsyncFS.SymlinkType {
    if (opt?.type === 'dir') return 1;
    if (opt?.type === 'junction') return 2;
    return 0;
}

function toEpochMilliseconds(t: number | Date): number {
    return typeof t === 'number' ? t * 1000 : t.getTime();
}

function isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function absolutePath(path: string | URL): string {
    const pathStr = toString(path);
    return normalize(isAbsolutePath(pathStr) ? pathStr : join(os.cwd, pathStr));
}

function isContainedPath(parent: string, child: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(systemPathSplit) ? parent : parent + systemPathSplit);
}

function watchToIterator(path: string): AsyncIterableIterator<Deno.FsEvent> & { close(): void } {
    let watcher: CModuleFSWatch.FsWatcher | null = null;
    let deferred: ReturnType<typeof Promise.withResolvers<IteratorResult<Deno.FsEvent>>> | null = null;
    const eventQueue: Deno.FsEvent[] = [];
    let isClosed = false;

    const iterator: AsyncIterableIterator<Deno.FsEvent> & { close(): void } = {
        async next(): Promise<IteratorResult<Deno.FsEvent>> {
            if (isClosed) {
                return { done: true, value: undefined };
            }

            // if there are events in the queue, return the first one
            if (eventQueue.length > 0) {
                const value = eventQueue.shift();
                if (value !== undefined) return { done: false, value };
            }

            // wait for new events
            deferred = Promise.withResolvers();
            return deferred.promise;
        },

        [Symbol.asyncIterator]() {
            return this;
        },

        async return(): Promise<IteratorResult<Deno.FsEvent>> {
            await this.close();
            return { done: true, value: undefined };
        },

        async throw(error?: unknown): Promise<IteratorResult<Deno.FsEvent>> {
            deferred?.reject(error);
            deferred = null;
            await this.close();
            return { done: true, value: undefined };
        },

        async close() {
            if (isClosed) return;

            isClosed = true;
            if (watcher) {
                watcher.close();
                watcher = null;
            }

            // if there is a pending promise, resolve it
            deferred?.resolve({ done: true, value: undefined });
            deferred = null;
        }
    };

    watcher = fswatch.watch(path, (filename, ev) => {
        if (isClosed) return;
        const eventPath = filename
            ? absolutePath(isAbsolutePath(filename) ? filename : join(path, filename))
            : absolutePath(path);
        const event = {
            kind: ev === 'rename' ? 'rename' : 'modify',
            paths: [eventPath]
        } as Deno.FsEvent;

        if (deferred) {
            deferred.resolve({ done: false, value: event });
            deferred = null;
        } else {
            eventQueue.push(event);
        }
    }, false);
    if (isClosed && watcher) {
        watcher.close();
        watcher = null;
    }

    return iterator;
}

Object.assign(Deno, wrapFSns({
    async readFile(path, opt) {
        const pathStr = toString(path);
        throwIfAborted(opt?.signal);
        const st = await asfs.stat(pathStr);
        throwIfAborted(opt?.signal);
        if (st.isDirectory) throw new errors.IsADirectory(`Is a directory: ${pathStr}`);
        const data = await asfs.readFile(pathStr);
        throwIfAborted(opt?.signal);
        return data;
    },

    readFileSync(path) {
        const pathStr = toString(path);
        if (fs.stat(pathStr).isDirectory) throw new errors.IsADirectory(`Is a directory: ${pathStr}`);
        return new Uint8Array(fs.readFile(pathStr));
    },

    readTextFile(path, opt) {
        return Deno.readFile(path, opt).then(b => engine.decodeString(b));
    },

    readTextFileSync(path) {
        return engine.decodeString(Deno.readFileSync(path));
    },


    readDir(path) {
        const pathStr = toString(path);
        let handle: Awaited<ReturnType<typeof asfs.readDir>> | undefined;

        async function getHandle() {
            handle ??= await asfs.readDir(pathStr);
            return handle;
        }

        const iterator: AsyncIterableIterator<Deno.DirEntry> = {
            async next(): Promise<IteratorResult<Deno.DirEntry>> {
                try {
                    const h = await getHandle();
                    const e = await h.next();
                    if (e.done) return { done: true, value: undefined };
                    return {
                        done: false,
                        value: {
                            name: e.value.name,
                            isDirectory: e.value.isDirectory,
                            isFile: e.value.isFile,
                            isSymlink: e.value.isSymbolicLink,
                        },
                    };
                } catch (e) {
                    throw wrapFSErr(e);
                }
            },
            async return(): Promise<IteratorResult<Deno.DirEntry>> {
                try {
                    await handle?.close();
                    return { done: true, value: undefined };
                } catch (e) {
                    throw wrapFSErr(e);
                }
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };

        return iterator;
    },

    readDirSync(path) {
        const entries = fs.readdir(toString(path), true).map((entry) => {
            return {
                name: entry.name,
                isDirectory: entry.isDirectory,
                isFile: entry.isFile,
                isSymlink: entry.isSymbolicLink,
            } satisfies Deno.DirEntry;
        });
        return entries[Symbol.iterator]();
    },

    readLink(path) {
        return asfs.readLink(toString(path));
    },

    readLinkSync(path) {
        return fs.readlink(toString(path));
    },


    link(old, newf) {
        return asfs.link(toString(old), toString(newf));
    },

    linkSync(old, newf) {
        return fs.link(toString(old), toString(newf));
    },

    async symlink(old, newf, opt) {
        return asfs.symlink(toString(old), toString(newf), symlinkType(opt));
    },

    symlinkSync(old, newf, opt) {
        return fs.symlink(toString(old), toString(newf));
    },

    realPath(path) {
        return asfs.realPath(toString(path));
    },

    realPathSync(path) {
        return fs.realpath(toString(path));
    },

    removeSync(path, opt) {
        const pathStr = toString(path);
        const recursive = opt?.recursive ?? false;

        if (!recursive) {
            // Try both unlink and rmdir without checking file type first
            try {
                fs.unlink(pathStr);
            } catch (error1) {
                try {
                    fs.rmdir(pathStr);
                } catch (error2) {
                    // If both fail, throw the original error
                    throw error1;
                }
            }
            return;
        }

        removeRecursiveSync(pathStr);
    },

    async remove(path, opt) {
        const pathStr = toString(path);
        const recursive = opt?.recursive ?? false;

        if (!recursive) {
            if ((await asfs.lstat(pathStr)).isDirectory)
                await asfs.rmdir(pathStr);
            else
                await asfs.unlink(pathStr);
            return;
        }

        // Recursive: delete directory tree recursively
        await removeRecursive(pathStr);
    },

    renameSync(oldPath, newPath) {
        return fs.rename(toString(oldPath), toString(newPath));
    },

    async rename(oldPath, newPath) {
        return asfs.rename(toString(oldPath), toString(newPath));
    },

    copyFile(from, to) {
        return asfs.copyFile(toString(from), toString(to));
    },

    copyFileSync(from, to) {
        return fs.copy(toString(from), toString(to));
    },

    async lstat(path) {
        return toDenoStat(await asfs.lstat(toString(path)));
    },

    lstatSync(path) {
        return toDenoStat(fs.lstat(toString(path)));
    },

    writeFileSync(path, data, options) {
        writeFileSyncWithOptions(path, data, options);
    },

    writeFile(path, data, options) {
        return denoWriteAnyFile(path, data, options);
    },

    writeTextFileSync(path, data, options) {
        writeFileSyncWithOptions(path, data, options);
    },

    writeTextFile(path, data, options) {
        return denoWriteAnyFile(path, data, options);
    },

    async truncate(name, len) {
        const file = await asfs.open(toString(name), "r+");
        try {
            await file.truncate(truncateLen(len));
        } finally {
            await file.close();
        }
    },

    truncateSync(name, len) {
        fs.truncate(toString(name), truncateLen(len));
    },

    async mkdir(path, opt) {
        const pathStr = toString(path);
        const recursive = opt?.recursive ?? false;
        const mode = opt?.mode;

        if (!recursive) {
            // Non-recursive mode: create single directory
            return await asfs.mkdir(pathStr, mode);
        }

        // Recursive mode: create directory tree
        await mkdirRecursive(pathStr, mode);
    },

    mkdirSync(path, opt) {
        const pathStr = toString(path);
        const recursive = opt?.recursive ?? false;

        if (!recursive) {
            // Non-recursive mode: create single directory
            return fs.mkdir(pathStr, opt?.mode);
        }

        // Recursive mode: create directory tree
        mkdirRecursiveSync(pathStr, opt?.mode);
    },

    async makeTempDir(opt) {
        const dir = opt?.dir ?? os.tmpDir;
        const prefix = opt?.prefix ?? 'deno';
        const suffix = opt?.suffix ?? '';
        for (let i = 0; i < 100; i++) {
            const path = tempPath(dir, prefix, suffix);
            try {
                await asfs.mkdir(path, 0o700);
                return path;
            } catch (e) {
                if (!hasErrno(e, error.errno.EEXIST)) throw e;
            }
        }
        throw new errors.AlreadyExists('Could not create a unique temporary directory');
    },

    makeTempDirSync(opt) {
        const dir = opt?.dir ?? os.tmpDir;
        const prefix = opt?.prefix ?? 'deno';
        const suffix = opt?.suffix ?? '';
        for (let i = 0; i < 100; i++) {
            const path = tempPath(dir, prefix, suffix);
            try {
                fs.mkdir(path, 0o700);
                return path;
            } catch (e) {
                if (!hasErrno(e, error.errno.EEXIST)) throw e;
            }
        }
        throw new errors.AlreadyExists('Could not create a unique temporary directory');
    },

    chmod(path, mode) {
        return asfs.chmod(toString(path), mode);
    },

    chmodSync(path, mode) {
        return fs.chmod(toString(path), mode);
    },

    chown(path, uid, gid) {
        const info = os.userInfo;
        return asfs.chown(toString(path), uid ?? info.userId, gid ?? info.groupId);
    },

    chownSync(path, uid, gid) {
        return fs.chown(toString(path), uid ?? os.userInfo.userId, gid ?? os.userInfo.groupId);
    },

    utime(path, atime, mtime) {
        return asfs.utime(toString(path), toEpochMilliseconds(atime), toEpochMilliseconds(mtime));
    },

    utimeSync(path, atime, mtime) {
        return fs.utimes(toString(path), toEpochMilliseconds(atime) / 1000, toEpochMilliseconds(mtime) / 1000);
    },

    async stat(path) {
        const st = await asfs.stat(toString(path));
        return toDenoStat(st);
    },

    statSync(path) {
        const st = fs.stat(toString(path));
        return toDenoStat(st);
    },

    async makeTempFile(opt) {
        const dir = opt?.dir ?? os.tmpDir;
        const prefix = opt?.prefix ?? 'cno-';
        const suffix = opt?.suffix ?? '';
        for (let i = 0; i < 100; i++) {
            const path = tempPath(dir, prefix, suffix);
            try {
                const f = await asfs.open(path, 'wx', 0o600);
                await f.close();
                return path;
            } catch (e) {
                if (!hasErrno(e, error.errno.EEXIST)) throw e;
            }
        }
        throw new errors.AlreadyExists('Could not create a unique temporary file');
    },

    makeTempFileSync(opt) {
        const dir = opt?.dir ?? os.tmpDir;
        const prefix = opt?.prefix ?? 'cno-';
        const suffix = opt?.suffix ?? '';
        for (let i = 0; i < 100; i++) {
            const path = tempPath(dir, prefix, suffix);
            try {
                const fd = fs.open(path, 'wx', 0o600);
                fs.close(fd);
                return path;
            } catch (e) {
                if (!hasErrno(e, error.errno.EEXIST)) throw e;
            }
        }
        throw new errors.AlreadyExists('Could not create a unique temporary file');
    },

    watchFs(path, options) {
        const paths = Array.isArray(path) ? path : [path];
        const recursive = options?.recursive !== false;
        const ignored = options?.ignore === undefined
            ? []
            : (Array.isArray(options.ignore) ? options.ignore : [options.ignore]).map(absolutePath);
        const isIgnoredPath = (path: string): boolean =>
            ignored.some(ignore => isContainedPath(ignore, absolutePath(path)));
        const isIgnored = (event: Deno.FsEvent): boolean =>
            event.paths.some(isIgnoredPath);
        const watchers: Map<string, AsyncIterableIterator<Deno.FsEvent> & { close(): void }> = new Map();
        let isClosed = false;
        const eventQueue: Deno.FsEvent[] = [];
        let deferred: ReturnType<typeof Promise.withResolvers<IteratorResult<Deno.FsEvent>>> | null = null;

        function pushEvent(event: Deno.FsEvent) {
            if (deferred) {
                deferred.resolve({ done: false, value: event });
                deferred = null;
            } else {
                eventQueue.push(event);
            }
        }

        function closeAll() {
            if (isClosed) return;

            isClosed = true;
            for (const [path, watcher] of watchers) {
                try {
                    watcher.close();
                } catch (error) {
                    console.error(`Error closing watcher for path: ${path}`, error);
                }
            }
            watchers.clear();

            if (deferred) {
                deferred.resolve({ done: true, value: undefined });
                deferred = null;
            }
        }

        function watchPath(path: string) {
            const watchPath = absolutePath(path);
            if (isClosed || watchers.has(watchPath) || isIgnoredPath(watchPath)) return;
            const watcher = watchToIterator(watchPath);
            watchers.set(watchPath, watcher);

            (async () => {
                try {
                    for await (const event of watcher) {
                        if (isClosed) break;
                        if (recursive) watchCreatedDirectories(event);
                        if (isIgnored(event)) continue;
                        pushEvent(event);
                    }
                } catch (error) {
                    if (deferred && !isClosed) {
                        deferred.reject(error);
                        deferred = null;
                    }
                }
            })();
        }

        function watchDirectoryTree(dir: string) {
            const root = absolutePath(dir);
            if (isClosed || isIgnoredPath(root)) return;
            watchPath(root);
            try {
                for (const entry of fs.readdir(root, true)) {
                    if (entry.isDirectory && !entry.isSymbolicLink) {
                        watchDirectoryTree(join(root, entry.name));
                    }
                }
            } catch {
                // A directory may disappear after the watcher is registered.
            }
        }

        function watchCreatedDirectories(event: Deno.FsEvent) {
            for (const path of event.paths) {
                if (isIgnoredPath(path)) continue;
                try {
                    if (fs.stat(path).isDirectory) watchDirectoryTree(path);
                } catch {
                    // Remove/rename events commonly point at paths that no longer exist.
                }
            }
        }

        try {
            for (const path of paths) {
                const root = absolutePath(path);
                const stat = fs.stat(root);
                if (recursive && stat.isDirectory) watchDirectoryTree(root);
                else watchPath(root);
            }
        } catch (error) {
            closeAll();
            throw error;
        }

        async function next(): Promise<IteratorResult<Deno.FsEvent>> {
            if (isClosed) {
                return { done: true, value: undefined };
            }
            if (eventQueue.length > 0) {
                const value = eventQueue.shift();
                if (value !== undefined) return { done: false, value };
            }

            // wait for new events
            deferred = Promise.withResolvers();
            return deferred.promise;
        }

        async function throws(error?: unknown): Promise<IteratorResult<Deno.FsEvent>> {
            if (deferred) {
                deferred.reject(error);
                deferred = null;
            }
            await iterator.close();
            return { done: true, value: undefined };
        }

        const iterator: Deno.FsWatcher = {
            [Symbol.asyncIterator]() {
                return {
                    ...this,
                    next,
                    throw: throws
                };
            },

            [Symbol.dispose]() {
                this.close();
            },

            async return(): Promise<IteratorResult<Deno.FsEvent>> {
                await this.close();
                return { done: true, value: undefined };
            },

            close: async () => {
                closeAll();
            }
        };

        return iterator;
    }

}));
