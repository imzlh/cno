const fs = import.meta.use("fs");
const asfs = import.meta.use("asyncfs");
const engine = import.meta.use("engine");
const fswatch = import.meta.use("fswatch");
const os = import.meta.use("os");
const error = import.meta.use("error");
const console = import.meta.use('console');
const crypto = import.meta.use('crypto');

import { arrayBufferBackedBytes } from "../utils/bytes";
import { hasErrno } from "../utils/errno";
import { ensureDirectory, ensureDirectorySync } from "../utils/fs-path";
import {
    isAbsolutePath,
    isPathWithin,
    join,
    resolveFsPath,
    toFsPath,
} from "../utils/path";
import { isWindows } from "../utils/platform";
import { wrapFSErr, wrapFSns } from "../utils/wrap";
import { DOMException } from "../webapi/events";
import { errors } from "./01_errors";

// Keep the local spelling used by this FS facade; path conversion itself is
// owned by ../utils/path and is shared by the other Deno APIs.
export const toString = toFsPath;

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

async function mkdirRecursive(fullPath: string, mode?: number): Promise<void> {
    await ensureDirectory(fullPath, mode);
}

function mkdirRecursiveSync(fullPath: string, mode?: number): void {
    ensureDirectorySync(fullPath, mode);
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
                const bytes = toWriteBytes(value);
                let written = 0;
                while (written < bytes.length) {
                    throwIfAborted(options?.signal);
                    const n = await fhandle.write(bytes.subarray(written));
                    if (n === null) throw new errors.UnexpectedEof("write");
                    written += n;
                }
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


function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted)
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
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

// Windows needs to know at creation time whether a link points at a directory.
// Real Deno infers this from the target when `options.type` is omitted; without
// the hint the native layer creates a file symlink, which then fails with
// ERROR_ACCESS_DENIED (or reports EPERM from stat) for directory targets.
function inferredSymlinkType(old: string, opt?: Deno.SymlinkOptions): Deno.SymlinkOptions | undefined {
    if (!isWindows || opt?.type !== undefined) return opt;
    try {
        if (fs.stat(old).isDirectory) return { ...opt, type: 'dir' };
    } catch {
        // Target missing or unreadable: leave the caller's options untouched.
    }
    return opt;
}

// The sync C layer reports symlink failures as a bare TypeError with no errno,
// so wrapFSErr cannot classify them and callers saw a TypeError where async
// symlink (and real Deno) give AlreadyExists.
function classifySymlinkErr(e: unknown, newf: string): unknown {
    if (typeof Reflect.get(e as object, 'code') === 'number') return e;
    try {
        fs.lstat(newf);
        return new errors.AlreadyExists(`symlink '${newf}'`);
    } catch {
        return e;
    }
}

// `Deno.chmod` follows symlinks. On Windows the mode is emulated with the
// read-only attribute, and SetFileAttributes acts on the reparse point itself
// rather than its target, so a link has to be resolved first. POSIX chmod(2)
// already follows links, so leave the path alone there.
function chmodTarget(path: string): string {
    if (!isWindows) return path;
    try {
        if (!fs.lstat(path).isSymbolicLink) return path;
        return fs.realpath(path);
    } catch {
        // Missing/unresolvable: let chmod itself produce the NotFound error.
        return path;
    }
}

function toEpochMilliseconds(t: number | Date): number {
    return typeof t === 'number' ? t * 1000 : t.getTime();
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
                return this as Deno.FsWatcher & AsyncIterableIterator<Deno.FsEvent>;
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
            ? resolveFsPath(isAbsolutePath(filename) ? filename : join(path, filename), os.cwd)
            : resolveFsPath(path, os.cwd);
        let kind: Deno.FsEvent['kind'] = 'modify';
        if (ev === 'rename') {
            try {
                fs.stat(eventPath);
                kind = 'create';
            } catch {
                kind = 'remove';
            }
        }
        const event = {
            kind,
            paths: [eventPath],
            flag: null
        } as unknown as Deno.FsEvent;

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
        const target = toString(path);
        try {
            return fs.readlink(target);
        } catch (e) {
            // The native sync readlink reports failures as a TypeError with no
            // errno, so wrapFSErr cannot classify it and callers saw a
            // TypeError where async readLink (and real Deno) give NotFound.
            // Anything carrying a numeric errno is left for wrapFSErr.
            if (typeof Reflect.get(e as object, 'code') === 'number') throw e;
            let exists = true;
            try {
                fs.lstat(target);
            } catch {
                exists = false;
            }
            if (!exists) throw new errors.NotFound(`readlink '${target}'`);
            // Path resolves but is not a symlink — mirror the async path.
            throw new errors.InvalidData(`readlink '${target}'`);
        }
    },


    link(old, newf) {
        return asfs.link(toString(old), toString(newf));
    },

    linkSync(old, newf) {
        return fs.link(toString(old), toString(newf));
    },

    async symlink(old, newf, opt) {
        const oldStr = toString(old);
        const newStr = toString(newf);
        try {
            return await asfs.symlink(oldStr, newStr, symlinkType(inferredSymlinkType(oldStr, opt)));
        } catch (e) {
            throw classifySymlinkErr(e, newStr);
        }
    },

    symlinkSync(old, newf, opt) {
        const oldStr = toString(old);
        const newStr = toString(newf);
        const resolved = inferredSymlinkType(oldStr, opt);
        // Sync C layer takes a Windows hint string and has no junction flag — map to 'dir'.
        const hint = resolved?.type === 'dir' || resolved?.type === 'junction' ? 'dir' : resolved?.type;
        try {
            return fs.symlink(oldStr, newStr, hint);
        } catch (e) {
            throw classifySymlinkErr(e, newStr);
        }
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
                    // Directory removal failed; surface the rmdir error
                    throw error2;
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
        return asfs.chmod(chmodTarget(toString(path)), mode);
    },

    chmodSync(path, mode) {
        return fs.chmod(chmodTarget(toString(path)), mode);
    },

    chown(path, uid, gid) {
        // Windows has no POSIX ownership model. Real Deno rejects with
        // NotSupported; the native async chown silently succeeds here, which
        // would let callers believe ownership changed.
        if (isWindows) {
            return Promise.reject(
                new errors.NotSupported(`chown '${toString(path)}'`),
            );
        }
        const info = os.userInfo;
        return asfs.chown(toString(path), uid ?? info.userId, gid ?? info.groupId);
    },

    chownSync(path, uid, gid) {
        // Native fs.chown raises a non-Deno InternalError on Windows.
        if (isWindows) throw new errors.NotSupported(`chown '${toString(path)}'`);
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
            : (Array.isArray(options.ignore) ? options.ignore : [options.ignore]).map(path => resolveFsPath(path, os.cwd));
        const isIgnoredPath = (path: string): boolean =>
            ignored.some(ignore => isPathWithin(ignore, resolveFsPath(path, os.cwd)));
        const isIgnored = (event: Deno.FsEvent): boolean =>
            event.paths.some(isIgnoredPath);
        const watchers: Map<string, AsyncIterableIterator<Deno.FsEvent> & { close(): void }> = new Map();
        let isClosed = false;
        const eventQueue: Deno.FsEvent[] = [];
        const deferreds: ReturnType<typeof Promise.withResolvers<IteratorResult<Deno.FsEvent>>>[] = [];

        function pushEvent(event: Deno.FsEvent) {
            const deferred = deferreds.shift();
            if (deferred) {
                deferred.resolve({ done: false, value: event });
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

            for (const deferred of deferreds.splice(0)) {
                deferred.resolve({ done: true, value: undefined });
            }
        }

        function watchPath(path: string) {
            const watchPath = resolveFsPath(path, os.cwd);
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
                    if (!isClosed) {
                        for (const deferred of deferreds.splice(0)) {
                            deferred.reject(error);
                        }
                    }
                }
            })();
        }

        function watchDirectoryTree(dir: string) {
            const root = resolveFsPath(dir, os.cwd);
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
                const root = resolveFsPath(path, os.cwd);
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
            const deferred = Promise.withResolvers<IteratorResult<Deno.FsEvent>>();
            deferreds.push(deferred);
            return deferred.promise;
        }

        async function throws(error?: unknown): Promise<IteratorResult<Deno.FsEvent>> {
            for (const deferred of deferreds.splice(0)) {
                deferred.reject(error);
            }
            await iterator.close();
            return { done: true, value: undefined };
        }

        const iterator: Deno.FsWatcher & AsyncIterableIterator<Deno.FsEvent> = {
            next,
            throw: throws,

            [Symbol.asyncIterator](): AsyncIterableIterator<Deno.FsEvent> {
                return this as Deno.FsWatcher & AsyncIterableIterator<Deno.FsEvent>;
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
