const fs = import.meta.use("fs");
const asfs = import.meta.use("asyncfs");
const engine = import.meta.use("engine");
const fswatch = import.meta.use("fswatch");
const os = import.meta.use("os");
const error = import.meta.use("error");
const console = import.meta.use('console');

import { assert } from "../utils/assert";
import { join } from "../utils/path";
import { wrapFSns } from "../utils/wrap";
import { errors } from "./01_errors";

export const toString = (e: URL | string): string => {
    if (!(e instanceof URL)) return e;
    let p = decodeURIComponent(e.pathname);
    // On Windows, file:///C:/foo → pathname is /C:/foo — strip the leading slash
    if (p.length >= 3 && p[0] === '/' && p[2] === ':') p = p.slice(1);
    return p;
};

export function toDenoStat(stat: CModuleAsyncFS.StatResult) {
    return {
        ...stat,
        atime: stat.atim,
        mtime: stat.mtim,
        ctime: stat.ctim,
        birthtime: stat.birthtim,
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
    for (const part of parts) {
        if (currentPath === '') {
            if (normalizedPath.startsWith('/')) { currentPath = '/'; }
            else if (/^[A-Za-z]:/.test(normalizedPath)) { currentPath = part + '/'; continue; }
            else if (normalizedPath.startsWith('//')) {
                currentPath = '//';
                if (parts.length >= 2) { currentPath += parts.slice(0, 2).join('/'); parts.splice(0, 2); }
                continue;
            }
            else { currentPath = part; }
        } else { currentPath = currentPath + '/' + part; }
        yield currentPath;
    }
}

async function mkdirRecursive(fullPath: string, mode?: number): Promise<void> {
    for (const p of iterMkdirPaths(fullPath)) {
        try { if (!(await asfs.stat(p)).isDirectory) throw -1; }
        catch (e) { if (e === -1) throw new Error(`Cannot create directory '${p}': File exists`); await asfs.mkdir(p, mode); }
    }
}

function mkdirRecursiveSync(fullPath: string, mode?: number): void {
    for (const p of iterMkdirPaths(fullPath)) {
        try { if (!fs.stat(p).isDirectory) throw -1; }
        catch (e) { if (e === -1) throw new Error(`Cannot create directory '${p}': File exists`); fs.mkdir(p, mode); }
    }
}

function removeRecursiveSync(targetPath: string): void {
    const stats = fs.stat(targetPath);
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
    const stats = await asfs.stat(targetPath);
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
            // Delete file
            await asfs.unlink(targetPath);
        }
}

async function denoWriteAnyFile(path: string | URL, data: string | Uint8Array | ReadableStream<string | Uint8Array>, options?: Deno.WriteFileOptions) {
    let flag = "w";
    if (options?.append) {
        flag = "a";
    } else if (options?.create) {
        flag = "x";
    } else if (options?.createNew) {
        flag = "wx";
    }
    const fhandle = await asfs.open(toString(path), flag, options?.mode);

    if (typeof data === "string")
        data = engine.encodeString(data);

    if (data instanceof Uint8Array) {
        let written = 0;
        while (written < data.length) {
            const n = await fhandle.write(data.subarray(written) as Uint8Array<ArrayBuffer>);
            if (n === null) {
                throw new errors.UnexpectedEof("write");
            }
            written += n;
        }
    } else {
        const reader = data.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const n = await fhandle.write(
                (typeof value === "string" ? engine.encodeString(value) : value) as Uint8Array<ArrayBuffer>
            );
            if (n === null) {
                throw new errors.UnexpectedEof("write");
            }
        }
    }
    await fhandle.close();
}

function watchToIterator(path: string): AsyncIterableIterator<Deno.FsEvent> & { close(): void } {
    let watcher: CModuleFSWatch.FsWatcher | null = null;
    let resolveNext: ((value: IteratorResult<Deno.FsEvent>) => void) | null = null;
    let rejectNext: ((error: any) => void) | null = null;
    const eventQueue: Deno.FsEvent[] = [];
    let isClosed = false;

    const iterator: AsyncIterableIterator<Deno.FsEvent> & { close(): void } = {
        async next(): Promise<IteratorResult<Deno.FsEvent>> {
            if (isClosed) {
                return { done: true, value: undefined };
            }

            // if there are events in the queue, return the first one
            if (eventQueue.length > 0) {
                const value = eventQueue.shift()!;
                return { done: false, value };
            }

            // wait for new events
            return new Promise((resolve, reject) => {
                resolveNext = resolve;
                rejectNext = reject;
            });
        },

        [Symbol.asyncIterator]() {
            return this;
        },

        async return(): Promise<IteratorResult<Deno.FsEvent>> {
            await this.close();
            return { done: true, value: undefined };
        },

        async throw(error?: any): Promise<IteratorResult<Deno.FsEvent>> {
            if (rejectNext) {
                rejectNext(error);
                rejectNext = null;
                resolveNext = null;
            }
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
            if (resolveNext) {
                resolveNext({ done: true, value: undefined });
                resolveNext = null;
                rejectNext = null;
            }
        }
    };

    // initialize watcher
    fswatch.watch(path, (filename: string, ev: CModuleFSWatch.FsEvent) => {
        if (isClosed) return;
        const event = {
            kind: ev === 'rename' ? 'rename' : 'any',
            paths: [filename]
        } as Deno.FsEvent;

        // has pending event?
        if (resolveNext) {
            resolveNext({ done: false, value: event });
            resolveNext = null;
            rejectNext = null;
        } else {
            eventQueue.push(event);
        }
    }).then(w => {
        if (!isClosed) {
            watcher = w;
        } else {
            w.close();
        }
    }).catch(error => {
        if (rejectNext) {
            rejectNext(error);
            rejectNext = null;
            resolveNext = null;
        }
    });

    return iterator;
}

Object.assign(Deno, wrapFSns({
    // @ts-ignore not SharedArrayBuffer
    readFile(path, opt) {
        return asfs.readFile(toString(path));
    },

    readFileSync(path) {
        return new Uint8Array(fs.readFile(toString(path)));
    },

    readTextFile(path, opt) {
        return Deno.readFile(path, opt).then(b => engine.decodeString(b));
    },

    readTextFileSync(path) {
        return engine.decodeString(Deno.readFileSync(path));
    },


    async *readDir(path) {
        const h = await asfs.readDir(toString(path));
        while (true) {
            const e = await h.next();
            if (e.done) break;
            yield {
                name: e.value.name,
                isDirectory: e.value.isDirectory,
                isFile: e.value.isFile,
                isSymlink: e.value.isSymbolicLink,
            } as Deno.DirEntry;
        }
    },

    *readDirSync(path) {
        for (const entry of fs.readdir(toString(path), true)) {
            yield {
                name: entry.name,
                isDirectory: entry.isDirectory,
                isFile: entry.isFile,
                isSymlink: entry.isSymbolicLink,
            } as Deno.DirEntry;
        }
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
        return asfs.symlink(toString(old), toString(newf),
            // @ts-ignore
            opt?.type == 'dir' ? asfs.SymlinkType.DIR : asfs.SymlinkType.JUNCTION
        );
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
            if ((await asfs.stat(pathStr)).isDirectory)
                await asfs.rmdir(pathStr);
            else
                await asfs.unlink(pathStr);
            return;
        }

        // Recursive: delete directory tree recursively
        await removeRecursive(pathStr);
    },

    renameSync(oldPath, newPath) {
        const np = toString(newPath);
        if (fs.exists(np)) fs.unlink(np);
        return fs.rename(toString(oldPath), np);
    },

    async rename(oldPath, newPath) {
        const np = toString(newPath);
        try { await asfs.unlink(np); } catch {};
        return asfs.rename(toString(oldPath), np);
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
        // todo: options
        fs.writeFile(toString(path), data.buffer as ArrayBuffer, options?.mode);
    },

    writeFile(path, data, options) {
        return denoWriteAnyFile(path, data, options);
    },

    writeTextFileSync(path, data, options) {
        // todo: options
        fs.writeFile(toString(path), engine.encodeString(data).buffer as ArrayBuffer, options?.mode);
    },

    writeTextFile(path, data, options) {
        return denoWriteAnyFile(path, data, options);
    },

    async truncate(name, len) {
        const file = await asfs.open(toString(name), "r+");
        file.truncate(len);
        await file.close();
    },

    truncateSync(name, len) {
        fs.truncate(toString(name), len ?? 0);
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
        const rand = Math.floor(Math.random() * 1e9).toString(36);
        const tmp = join(opt?.dir ?? os.tmpDir, opt?.prefix ?? 'deno', opt?.suffix ?? rand);
        await mkdirRecursive(tmp, 0o755);
        return tmp;
    },

    makeTempDirSync(opt) {
        const rand = Math.floor(Math.random() * 1e9).toString(36);
        const tmp = join(opt?.dir ?? os.tmpDir, opt?.prefix ?? 'deno', opt?.suffix ?? rand);
        mkdirRecursiveSync(tmp, 0o755);
        return tmp;
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
        const randomValue = Math.floor(Math.random() * 1e9).toString(36);
        const path = join(dir, prefix + randomValue + suffix);
        const f = await asfs.open(path, 'w', 0o644);
        await f.close();
        return path;
    },

    makeTempFileSync(opt) {
        const dir = opt?.dir ?? os.tmpDir;
        const prefix = opt?.prefix ?? 'cno-';
        const suffix = opt?.suffix ?? '';
        const randomValue = Math.floor(Math.random() * 1e9).toString(36);
        const path = join(dir, prefix + randomValue + suffix);
        const fd = fs.open(path, 'w', 0o644);
        fs.close(fd);
        return path;
    },

    watchFs(path, options) {
        const paths = Array.isArray(path) ? path : [path];
        const watchers: Map<string, AsyncIterableIterator<Deno.FsEvent> & { close(): void }> = new Map();
        let isClosed = false;
        const eventQueue: Deno.FsEvent[] = [];
        let resolveNext: ((value: IteratorResult<Deno.FsEvent>) => void) | null = null;
        let rejectNext: ((error: any) => void) | null = null;

        paths.forEach(path => {
            try {
                const watcher = watchToIterator(path);
                watchers.set(path, watcher);

                // create a task to consume the watcher events
                (async () => {
                    try {
                        for await (const event of watcher) {
                            if (isClosed) break;

                            if (resolveNext) {
                                resolveNext({ done: false, value: event });
                                resolveNext = null;
                                rejectNext = null;
                            } else {
                                eventQueue.push(event);
                            }
                        }
                    } catch (error) {
                        if (rejectNext && !isClosed) {
                            rejectNext(error);
                            rejectNext = null;
                            resolveNext = null;
                        }
                    }
                })();
            } catch (error) {
                console.error(`Failed to watch path: ${path}`, error);
            }
        });

        async function next(): Promise<IteratorResult<Deno.FsEvent>> {
            if (isClosed) {
                return { done: true, value: undefined };
            }
            if (eventQueue.length > 0) {
                const value = eventQueue.shift()!;
                return { done: false, value };
            }

            // wait for new events
            return new Promise((resolve, reject) => {
                resolveNext = resolve;
                rejectNext = reject;
            });
        }

        async function throws(error?: any): Promise<IteratorResult<Deno.FsEvent>> {
            if (rejectNext) {
                rejectNext(error);
                rejectNext = null;
                resolveNext = null;
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
                if (isClosed) return;

                isClosed = true;
                for (const [path, watcher] of watchers) {
                    try {
                        await watcher.close();
                    } catch (error) {
                        console.error(`Error closing watcher for path: ${path}`, error);
                    }
                }
                watchers.clear();

                if (resolveNext) {
                    resolveNext({ done: true, value: undefined });
                    resolveNext = null;
                    rejectNext = null;
                }
            }
        };

        return iterator;
    }

}));
