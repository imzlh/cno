const fs = import.meta.use("fs");
const asfs = import.meta.use("asyncfs");
const engine = import.meta.use("engine");
const fswatch = import.meta.use("fswatch");
const os = import.meta.use("os");

import { join } from "../utils/path";
import { errors } from "./01_errors";

export const toString = (e: URL | string) => e instanceof URL ? e.pathname : e;

const dateOrNull = (t?: number | null) => t ? new Date(t) : null;
export function toDenoStat(stat: CModuleFS.Stats) {
    return {
        atime: dateOrNull(stat.atime),
        // todo: add birthtime
        birthtime: dateOrNull(stat.atime),
        ctime: dateOrNull(stat.ctime),
        mtime: dateOrNull(stat.mtime),
        size: stat.size,
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymlink: stat.isSymbolicLink,
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        nlink: stat.nlink,
        uid: stat.uid,
        gid: stat.gid,
        rdev: stat.rdev,
        blksize: stat.blksize,
        blocks: stat.blocks,
        // todo: add this is* fields
        isBlockDevice: false,
        isCharDevice: false,
        isFifo: false,
        isSocket: false,
    } satisfies Deno.FileInfo;
}
export function asToDenoStat(stat: CModuleAsyncFS.StatResult) {
    return {
        ...stat,
        isSymlink: stat.isSymbolicLink,
        isCharDevice: stat.isCharacterDevice,
        isFifo: stat.isFIFO
    } satisfies Deno.FileInfo;
}

/**
 * Recursively create directory tree (cross-platform)
 */
async function mkdirRecursive(fullPath: string, mode?: number): Promise<void> {
    // Normalize path: convert backslashes to forward slashes
    const normalizedPath = fullPath.replace(/\\/g, '/');

    // Split path into components
    const parts = normalizedPath.split('/').filter(part => part !== '' && part !== '.');

    // Build path progressively
    let currentPath = '';

    for (const part of parts) {
        // Handle root paths
        if (currentPath === '') {
            // Unix absolute path
            if (normalizedPath.startsWith('/')) {
                currentPath = '/';
            }
            // Windows absolute path with drive letter
            else if (/^[A-Za-z]:/.test(normalizedPath)) {
                currentPath = part + '/';
                continue;
            }
            // UNC path (\\server\share)
            else if (normalizedPath.startsWith('//')) {
                currentPath = '//';
                // For UNC paths, first two parts are server and share
                if (parts.length >= 2) {
                    currentPath += parts.slice(0, 2).join('/');
                    // Skip the server and share parts in the loop
                    parts.splice(0, 2);
                }
                continue;
            }
            // Relative path
            else {
                currentPath = part;
            }
        } else {
            currentPath = currentPath + '/' + part;
        }

        try {
            if (!(await asfs.stat(currentPath)).isDirectory)
                throw -1;
            // already exists and is a directory, skip
        } catch (error) {
            if (error === -1) {
                throw new Error(`Cannot create directory '${currentPath}': File exists`);
            } else {
                await asfs.mkdir(currentPath, mode);
            }
        }
    }
}

function mkdirRecursiveSync(fullPath: string, mode?: number): void {
    // Normalize path: convert backslashes to forward slashes
    const normalizedPath = fullPath.replace(/\\/g, '/');
    
    // Split path into components
    const parts = normalizedPath.split('/').filter(part => part !== '' && part !== '.');
    
    // Build path progressively
    let currentPath = '';
    
    for (const part of parts) {
        // Handle root paths
        if (currentPath === '') {
            // Unix absolute path
            if (normalizedPath.startsWith('/')) {
                currentPath = '/';
            }
            // Windows absolute path with drive letter
            else if (/^[A-Za-z]:/.test(normalizedPath)) {
                currentPath = part + '/';
                continue;
            }
            // UNC path (\\server\share)
            else if (normalizedPath.startsWith('//')) {
                currentPath = '//';
                // For UNC paths, first two parts are server and share
                if (parts.length >= 2) {
                    currentPath += parts.slice(0, 2).join('/');
                    // Skip the server and share parts in the loop
                    parts.splice(0, 2);
                }
                continue;
            }
            // Relative path
            else {
                currentPath = part;
            }
        } else {
            currentPath = currentPath + '/' + part;
        }
        
        try {
            if (!fs.stat(currentPath).isDirectory)
                throw -1;
            // already exists and is a directory, skip
        } catch (error) {
            if (error === -1) {
                throw new Error(`Cannot create directory '${currentPath}': File exists`);
            } else {
                fs.mkdir(currentPath, mode);
            }
        }
    }
}

function removeRecursiveSync(targetPath: string): void {
    try {
        const stats = fs.stat(targetPath);
        
        if (stats.isDirectory) {
            const items = fs.readdir(targetPath);
            for (const item of items) {
                removeRecursiveSync(join(targetPath, item));
            }
            fs.rmdir(targetPath);
        } else {
            fs.unlink(targetPath);
        }
    } catch (error) {
        throw error;
    }
}

async function removeRecursive(targetPath: string): Promise<void> {
    try {
        const stats = await asfs.stat(targetPath);
        
        if (stats.isDirectory) {
            // Open directory for reading contents
            const dirHandle = await asfs.readDir(targetPath);
            
            try {
                // Read and delete all directory contents
                for await (const entry of dirHandle) {
                    const itemPath = join(targetPath, entry.name);
                    await removeRecursive(itemPath);
                }
            } finally {
                await dirHandle.close();
            }
            
            // Delete empty directory
            await CModuleAsyncFS.rmdir(targetPath);
        } else {
            // Delete file
            await CModuleAsyncFS.unlink(targetPath);
        }
    } catch (error) {
        throw error;
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
            const n = await fhandle.write(data.subarray(written));
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
                typeof value === "string" ? engine.encodeString(value) : value
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

Object.assign(Deno, {
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
        for (const el of fs.readdir(toString(path))) {
            const stat = fs.stat(path + "/" + el);
            yield {
                name: el,
                isDirectory: stat.isDirectory,
                isFile: stat.isFile,
                isSymlink: stat.isSymbolicLink,
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
                CModuleFS.unlink(pathStr);
            } catch (error1) {
                try {
                    CModuleFS.rmdir(pathStr);
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
            if((await asfs.stat(pathStr)).isDirectory)
                asfs.rmdir(pathStr);
            else
                asfs.unlink(pathStr);
            return;
        }
        
        // Recursive: delete directory tree recursively
        await removeRecursive(pathStr);
    },

    renameSync(oldPath, newPath) {
        fs.rename(toString(oldPath), toString(newPath));
    },

    rename(oldPath, newPath) {
        return asfs.rename(toString(oldPath), toString(newPath));
    },

    copyFile(from, to){
        return asfs.copyFile(toString(from), toString(to));
    },

    copyFileSync(from, to){
        return fs.copy(toString(from), toString(to));
    },

    async lstat(path) {
        return asToDenoStat(await asfs.lstat(toString(path)));
    },

    lstatSync(path) {
        return toDenoStat(fs.lstat(toString(path)));
    },

    writeFileSync(path, data, options) {
        // todo: options
        fs.writeFile(toString(path), data.buffer as ArrayBuffer);
    },

    writeFile(path, data, options) {
        return denoWriteAnyFile(path, data, options);
    },

    writeTextFileSync(path, data, options) {
        // todo: options
        fs.writeFile(toString(path), engine.encodeString(data).buffer as ArrayBuffer);
    },

    writeTextFile(path, data, options) {
        return denoWriteAnyFile(path, data, options);
    },

    async truncate(name, len){
        const file = await asfs.open(toString(name), "r+");
        file.truncate(len);
        await file.close();
    },

    truncateSync(name, len){
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
        const tmp = join(opt?.dir ?? os.tmpdir, opt?.prefix ?? 'deno', opt?.suffix ?? rand);
        await mkdirRecursive(tmp, 755);
        return tmp;
    },

    makeTempDirSync(opt){
        const rand = Math.floor(Math.random() * 1e9).toString(36);
        const tmp = join(opt?.dir ?? os.tmpdir, opt?.prefix ?? 'deno', opt?.suffix ?? rand);
        mkdirRecursiveSync(tmp, 755);
        return tmp;
    },

    chmod(path, mode){
        return asfs.chmod(toString(path), mode);
    },

    chmodSync(path, mode){
        return fs.chmod(toString(path), mode);
    },

    chown(path, uid, gid){
        const info = os.userInfo;
        return asfs.chown(toString(path), uid ?? info.userId, gid ?? info.groupId);
    },

    chownSync(path, uid, gid){
        return fs.chown(toString(path), uid ?? os.userInfo.userId, gid ?? os.userInfo.groupId);
    },

    async stat(path) {
        const st = await asfs.stat(toString(path));
        return asToDenoStat(st);
    },

    statSync(path) {
        const st = fs.stat(toString(path));
        return toDenoStat(st);
    },

    async makeTempFile(opt){
        const randomValue = Math.floor(Math.random() * 1e9).toString(36);
        const path = join(opt?.dir ?? os.tmpdir, opt?.prefix ?? 'cno', opt?.suffix ?? 'cno-')
            + randomValue;
        await mkdirRecursive(path, 755);
        return path;
    },

    makeTempFileSync(opt){
        const randomValue = Math.floor(Math.random() * 1e9).toString(36);
        const path = join(opt?.dir ?? os.tmpdir, opt?.prefix ?? 'cno', opt?.suffix ?? 'cno-')
            + randomValue;
        mkdirRecursiveSync(path, 755);
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

} satisfies Partial<typeof Deno>);