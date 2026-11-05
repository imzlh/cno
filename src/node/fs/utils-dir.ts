/**
 * fs module internal helpers split out of utils.ts. Keep this file under
 * ~30KB: the Sucrase fallback transform is super-linear in file size, and a
 * single 53KB utils.ts made every --no-oxc graph spin for minutes.
 */

import {
    Dirent,
    asfs,
    decodeBuffer,
    dirClosedError,
    engine,
    errorFromUnknown,
    fs,
    isDirectory,
    isDirectorySync,
    joinWalk,
    makeAbortError,
    modeToNumber,
    nativeCrypto,
    needsResolve,
    normalizeRwArgs,
    prepareWalkRoot,
    text,
    timeToUnixMs,
    toNodeDirent,
    toNodeDirentAsync,
    toNodeStat,
    toUint8Array,
    toWalkEntry,
    type DirEntryWithParent,
    type LinkWalkPolicy,
    type Mode,
    type PathLike,
    type TimeLike,
    walkNeedsSysDir,
    walkReadDir,
} from './utils';
import { fileURLToPath } from '../url';
import { Buffer } from '../buffer';
import path from '../path';
import { arrayBufferBackedBytes, concatChunks } from '../_internal/buffer';
import { toErrnoException } from '../_internal/errno';
import { wrapSync } from './errno-fix';
import { sysPath } from './syspath';

const { join } = path;

export function readDirEntriesSync(
    pathStr: string,
    recursive = false,
    prefix = '',
    policy: LinkWalkPolicy = 'follow',
): DirEntryWithParent[] {
    const out: DirEntryWithParent[] = [];
    const pending: string[] = [prefix];
    const root = prepareWalkRoot(pathStr);
    const needsSysDir = walkNeedsSysDir;

    while (pending.length > 0) {
        const rel = pending.shift() as string;
        const absDir = rel ? joinWalk(root, rel) : root;
        for (const entry of walkReadDir(absDir)) {
            const relativePath = rel ? joinWalk(rel, entry.name) : entry.name;
            out.push(toWalkEntry(entry, relativePath, absDir));
            if (!recursive) continue;
            const descend = entry.isDirectory
                ? true
                : policy === 'follow' && needsResolve(entry) && isDirectorySync(joinWalk(absDir, entry.name));
            if (descend) pending.push(relativePath);
        }
    }
    return out;
}

export async function readDirEntries(
    pathStr: string,
    recursive = false,
    prefix = '',
    policy: LinkWalkPolicy = 'follow',
): Promise<DirEntryWithParent[]> {
    const out: DirEntryWithParent[] = [];
    const pending: string[] = [prefix];
    const root = prepareWalkRoot(pathStr);
    const needsSysDir = walkNeedsSysDir;

    while (pending.length > 0) {
        const rel = pending.shift() as string;
        const absDir = rel ? joinWalk(root, rel) : root;

        // Drain and close the handle before any stat, so the resolve step never straddles it.
        const level: DirEntryWithParent[] = [];
        const dirHandle = await asfs.readDir(needsSysDir ? absDir : sysPath(absDir));
        try {
            for await (const entry of dirHandle) {
                const relativePath = rel ? joinWalk(rel, entry.name) : entry.name;
                level.push(toWalkEntry(entry, relativePath, absDir));
            }
        } finally {
            await dirHandle.close();
        }

        for (const entry of level) {
            out.push(entry);
            if (!recursive) continue;
            const descend = entry.isDirectory
                ? true
                : policy === 'follow' && needsResolve(entry) && await isDirectory(joinWalk(absDir, entry.name));
            if (descend) pending.push(entry.relativePath);
        }
    }
    return out;
}

export class Dir {
    path: string;
    private entries: DirEntryWithParent[];
    private index = 0;
    private closed = false;

    constructor(path: PathLike, recursive = false) {
        const pathStr = pathToString(path);
        this.path = pathStr;
        // `opendir` uses the strict gate and never walks a junction or directory symlink.
        this.entries = wrapSync(
            () => readDirEntriesSync(pathStr, recursive, '', 'strict'),
            'opendir',
            pathStr,
        );
    }

    read(callback: (err: NodeJS.ErrnoException | null, dirent: Dirent | null) => void): void;
    read(): Promise<Dirent | null>;
    read(callback?: (err: NodeJS.ErrnoException | null, dirent: Dirent | null) => void): Promise<Dirent | null> | void {
        if (callback) {
            queueMicrotask(() => {
                let entry: Dirent | null;
                try {
                    entry = this.readSync();
                } catch (err) {
                    callback(errorFromUnknown(err), null);
                    return;
                }
                callback(null, entry);
            });
            return;
        }
        return Promise.resolve().then(() => this.readSync());
    }

    readSync(): Dirent | null {
        if (this.closed) throw dirClosedError();
        if (this.index >= this.entries.length) return null;
        const entry = this.entries[this.index++];
        // parentPath is the containing directory, which for a recursive walk is
        // a descendant of this.path rather than this.path itself.
        return toNodeDirent(entry.name, entry, entry.parentPath);
    }

    close(callback: (err: NodeJS.ErrnoException | null) => void): void;
    close(): Promise<void>;
    close(callback?: (err: NodeJS.ErrnoException | null) => void): Promise<void> | void {
        if (callback) {
            queueMicrotask(() => {
                try {
                    this.closeSync();
                    callback(null);
                } catch (err) {
                    callback(errorFromUnknown(err));
                }
            });
            return;
        }
        return Promise.resolve().then(() => this.closeSync());
    }

    closeSync(): void {
        if (this.closed) throw dirClosedError();
        this.closed = true;
        this.entries = [];
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<Dirent> {
        return directoryIterator(this);
    }
}

function directoryIterator(dir: Pick<Dir, 'read' | 'close'>): AsyncIterableIterator<Dirent> {
    return {
        async next() {
            const entry = await dir.read();
            if (entry === null) return { done: true, value: undefined };
            return { done: false, value: entry };
        },
        async return() {
            try { await dir.close(); } catch { /* already closed */ }
            return { done: true, value: undefined };
        },
    } as AsyncIterableIterator<Dirent>;
}

// Flag parsing

/**
 * Whitespace validation is load-bearing (docs/node-internals.md#fs-open-flags).
 */
const VALID_OPEN_FLAGS = new Set([
    'r', 'rs', 'sr', 'r+', 'rs+', 'sr+',
    'w', 'wx', 'xw', 'w+', 'wx+', 'xw+',
    'a', 'ax', 'xa', 'a+', 'ax+', 'xa+', 'as', 'as+',
]);

export function parseFlags(flag?: string | number): CModuleFS.OpenFlags | string {
    if (flag === undefined || flag === null) return 'r';
    // Numeric flags are O_* bitmasks and are passed through untouched.
    if (typeof flag === 'number') return flag;
    if (typeof flag === 'string' && VALID_OPEN_FLAGS.has(flag)) {
        return flag as CModuleFS.OpenFlags;
    }
    throw Object.assign(
        new TypeError(`The value of "flags" is invalid. Received ${JSON.stringify(flag)}`),
        { code: 'ERR_INVALID_ARG_VALUE' },
    );
}

// Path handling

export function pathToString(path: string | URL | Uint8Array): string {
    if (typeof path === 'string') {
        // process file URL
        if (/^file:\/\//i.test(path)) {
            const localPath = fileURLToPath(path);
            return localPath;
        }
        // process Windows absolute path
        if (process.platform === 'win32' && /^\/[A-Za-z]{1,2}:[\\/]/.test(path)) {
            return path.slice(1);
        }
        return path;
    }
    if (path == null) {
        throw Object.assign(
            new TypeError('The "path" argument must be of type string or an instance of Buffer or URL.'),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    if (path instanceof Uint8Array) {
        return engine.decodeString(arrayBufferBackedBytes(path));
    }
    if (path instanceof URL) {
        return fileURLToPath(path);
    }
    throw Object.assign(
        new TypeError('The "path" argument must be of type string or an instance of Buffer or URL.'),
        { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

export function splitPathOrFd(path: PathLike | number): { fd: number } | { path: string } {
    if (typeof path === 'number') return { fd: path };
    return { path: pathToString(path) };
}

export function describeFd(fd: number): string {
    return `fd:${fd}`;
}

// Recursive deletion — use lstat so symlink-to-dir unlinks the link only.

/**
 * Remove a symlink. Windows cannot DeleteFile() a directory symlink or
 * junction — that needs RemoveDirectory() — and which one applies is not
 * knowable from lstat alone, so try the file path first and fall back.
 */
function unlinkLinkSync(targetPath: string): void {
    try {
        fs.unlink(targetPath);
    } catch (e) {
        try {
            fs.rmdir(targetPath);
        } catch {
            throw e;
        }
    }
}

export function removeRecursiveSync(targetPath: string): void {
    const stats = fs.lstat(targetPath);

    if (stats.isDirectory && !stats.isSymbolicLink) {
        const items = fs.readdir(targetPath);
        for (const item of items) {
            removeRecursiveSync(join(targetPath, item));
        }
        fs.rmdir(targetPath);
    } else if (stats.isSymbolicLink) {
        unlinkLinkSync(targetPath);
    } else {
        fs.unlink(targetPath);
    }
}

/** Node's rimraf retry codes (`internal/fs/rimraf` `retryErrorCodes`). */
const RETRY_ERROR_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

/**
 * Async rm only: Node's rmSync accepts the retry options and ignores them.
 * `fn` must produce string `code`s already (raw asyncfs errors carry a numeric errno).
 */
export async function retryOnBusy(
    fn: () => Promise<void>,
    maxRetries?: number,
    retryDelay?: number,
): Promise<void> {
    const limit = typeof maxRetries === 'number' && maxRetries > 0 ? maxRetries : 0;
    const delayUnit = typeof retryDelay === 'number' ? retryDelay : 100;

    for (let attempt = 0; ; attempt++) {
        try {
            await fn();
            return;
        } catch (e) {
            const code = Reflect.get(e as object, 'code');
            if (attempt >= limit || typeof code !== 'string' || !RETRY_ERROR_CODES.has(code)) throw e;
            // Node: retries++ happens before the multiply, so the first wait is
            // 1*retryDelay, not 0.
            const delay = (attempt + 1) * delayUnit;
            if (delay > 0) await new Promise<void>(res => { setTimeout(res, delay); });
        }
    }
}

async function unlinkLinkAsync(targetPath: string): Promise<void> {
    try {
        await asfs.unlink(targetPath);
    } catch (e) {
        try {
            await asfs.rmdir(targetPath);
        } catch {
            throw e;
        }
    }
}

export async function removeRecursive(targetPath: string): Promise<void> {
    const stats = await asfs.lstat(targetPath);

    if (stats.isDirectory && !stats.isSymbolicLink) {
        const dirHandle = await asfs.readDir(targetPath);
        try {
            for await (const entry of dirHandle) {
                await removeRecursive(join(targetPath, entry.name));
            }
        } finally {
            await dirHandle.close();
        }
        await asfs.rmdir(targetPath);
    } else if (stats.isSymbolicLink) {
        await unlinkLinkAsync(targetPath);
    } else {
        await asfs.unlink(targetPath);
    }
}

// Recursive directory creation

function splitMkdirPath(pathStr: string): { root: string; parts: string[] } {
    const windows = process.platform === 'win32';
    const normalized = windows ? pathStr.replace(/\\/g, '/') : pathStr;
    const split = (rest: string): string[] => rest.split('/').filter(Boolean);

    if (windows) {
        const verbatim = normalized.match(/^\/\/([?.])\//);
        if (verbatim) {
            const prefix = verbatim[0];
            const body = normalized.slice(prefix.length);
            const unc = body.match(/^UNC\/[^/]+\/[^/]+/i);
            if (unc) return { root: `${prefix}${unc[0]}/`, parts: split(body.slice(unc[0].length)) };
            const drive = body.match(/^[A-Za-z]:(?:\/|$)/);
            if (drive) return { root: `${prefix}${drive[0].replace(/\/?$/, '/')}`, parts: split(body.slice(drive[0].length)) };
            return { root: normalized, parts: [] };
        }

        const unc = normalized.match(/^\/\/[^/]+\/[^/]+/);
        if (unc) return { root: `${unc[0]}/`, parts: split(normalized.slice(unc[0].length)) };

        const drive = normalized.match(/^[A-Za-z]:(?:\/|$)/);
        if (drive) return { root: `${drive[0].replace(/\/?$/, '/')}`, parts: split(normalized.slice(drive[0].length)) };

        const driveRelative = normalized.match(/^[A-Za-z]:/);
        if (driveRelative) return { root: driveRelative[0], parts: split(normalized.slice(driveRelative[0].length)) };
    }

    if (normalized.startsWith('/')) return { root: '/', parts: split(normalized.slice(1)) };
    return { root: '', parts: split(normalized) };
}

function appendMkdirPart(base: string, part: string): string {
    if (!base) return part;
    if (process.platform === 'win32' && /^[A-Za-z]:$/.test(base)) return `${base}${part}`;
    if (base.endsWith('/')) return `${base}${part}`;
    return `${base}/${part}`;
}

function* mkdirPathParents(pathStr: string): Generator<string> {
    const normalized = path.normalize(pathStr);
    const { root, parts } = splitMkdirPath(normalized);
    let current = root;
    for (const part of parts) {
        if (part === '.') continue;
        current = appendMkdirPart(current, part);
        if (part !== '..') yield current;
    }
}

function enotdirError(current: string): NodeJS.ErrnoException {
    const err = new Error(`ENOTDIR: not a directory, mkdir '${current}'`) as NodeJS.ErrnoException;
    err.code = 'ENOTDIR';
    err.syscall = 'mkdir';
    err.path = current;
    return err;
}

/**
 * Returns the first directory actually created, or undefined when all existed.
 * Node returns the namespaced form (`\\?\D:\a\b`), hence the `sysPath` conversion below.
 */
export function mkdirRecursiveSync(pathStr: string, mode?: number): string | undefined {
    let firstCreated: string | undefined;

    for (const current of mkdirPathParents(pathStr)) {
        if (fs.exists(current)) {
            if (!fs.stat(current).isDirectory) throw enotdirError(current);
            continue;
        }
        try {
            fs.mkdir(current, mode);
            if (firstCreated === undefined) firstCreated = current;
        } catch (e) {
            // Concurrent create: ok only if the path is now a directory.
            if (!isDirectorySync(current)) throw e;
        }
    }
    return firstCreated === undefined ? undefined : sysPath(firstCreated);
}

export async function mkdirRecursive(pathStr: string, mode?: number): Promise<string | undefined> {
    let firstCreated: string | undefined;

    for (const current of mkdirPathParents(pathStr)) {
        try {
            const stat = await asfs.stat(current);
            if (!stat.isDirectory) throw enotdirError(current);
            continue;
        } catch (e) {
            if (e instanceof Error && Reflect.get(e, 'code') === 'ENOTDIR') throw e;
        }
        try {
            await asfs.mkdir(current, mode);
            if (firstCreated === undefined) firstCreated = current;
        } catch (e) {
            if (!(await isDirectory(current))) throw e;
        }
    }
    return firstCreated === undefined ? undefined : sysPath(firstCreated);
}

/** Exists so `handle.constructor.name` is 'FileHandle' and `instanceof` works. */
class FileHandle {}

export function createFileHandle(fd: number, handle: CModuleAsyncFS.FileHandle) {
    let closed = false;

    async function ensureOpen(syscall: string): Promise<void> {
        if (!closed) return;
        // Node: `code` 'EBADF', `errno` undefined, `syscall` the libuv operation name.
        const err = new Error('EBADF: bad file descriptor') as NodeJS.ErrnoException;
        err.code = 'EBADF';
        err.syscall = syscall;
        throw err;
    }

    /**
     * Native calls must stay wrapped: an unwrapped rejection carries the raw UV number as
     * `code`, which fails every string `err.code` comparison.
     */
    async function native<T>(syscall: string, op: () => Promise<T>): Promise<T> {
        try {
            return await op();
        } catch (e) {
            throw toErrnoException(e, syscall);
        }
    }

    async function writeAll(data: Uint8Array<ArrayBuffer>, position?: number | null): Promise<number> {
        let total = 0;
        let currentPosition = position;
        while (total < data.length) {
            const chunk = data.subarray(total);
            const written = await native('write', () => handle.write(chunk, currentPosition ?? undefined));
            if (written <= 0) break;
            total += written;
            if (currentPosition != null) currentPosition += written;
        }
        return total;
    }

    const fileHandle = {
        fd,
        __proto__: FileHandle.prototype,
        async read(
            bufferOrOptions?: ArrayBufferView | { buffer?: ArrayBufferView; offset?: number; length?: number; position?: number | null },
            offset?: number,
            length?: number,
            position?: number | null,
        ) {
            await ensureOpen('read');
            // The default buffer must be a Buffer, not a bare Uint8Array, or `toString()` yields
            // the comma-joined decimals instead of text.
            let target: ArrayBufferView;
            let opts: unknown = offset, len: unknown = length, pos: unknown = position;
            if (bufferOrOptions === undefined || bufferOrOptions === null) {
                target = Buffer.alloc(16384);
            } else if (ArrayBuffer.isView(bufferOrOptions)) {
                target = bufferOrOptions;
            } else {
                const o = bufferOrOptions;
                target = o.buffer ?? Buffer.alloc(16384);
                opts = o.offset; len = o.length; pos = o.position;
            }
            const norm = normalizeRwArgs(target, opts, len, pos);
            const window = arrayBufferBackedBytes(norm.window);
            // Native null means offset 0; undefined preserves the current offset.
            const result = await native('read', () => handle.read(window, norm.position ?? undefined));
            return { bytesRead: result ?? 0, buffer: target };
        },
        async write(buffer: ArrayBufferView | string, offsetOrPosition?: unknown, lengthOrEncoding?: unknown, position?: number | null) {
            await ensureOpen('write');
            if (typeof buffer === 'string') {
                const encoding = typeof lengthOrEncoding === 'string' ? (lengthOrEncoding as BufferEncoding) : undefined;
                const data = toUint8Array(buffer, encoding);
                const at = offsetOrPosition === null || offsetOrPosition === undefined ? null : Number(offsetOrPosition);
                const bytesWritten = await native('write', () => handle.write(data, at ?? undefined));
                return { bytesWritten, buffer };
            }
            const norm = normalizeRwArgs(buffer, offsetOrPosition, lengthOrEncoding, position);
            const bytes = arrayBufferBackedBytes(norm.window);
            const bytesWritten = await native('write', () => handle.write(bytes, norm.position ?? undefined));
            return { bytesWritten, buffer };
        },
        async close() {
            if (closed) return;
            closed = true;
            await native('close', () => handle.close());
            // Node sets `fd` to -1 once closed; a stale descriptor reads as a live handle and
            // reaches a real syscall (a stream built from it hangs).
            fileHandle.fd = -1;
        },
        async stat(options?: { bigint?: boolean }) {
            await ensureOpen('fstat');
            return toNodeStat(await native('fstat', () => handle.stat()), options);
        },
        async sync() { await ensureOpen('fsync'); await native('fsync', () => handle.sync()); },
        async datasync() { await ensureOpen('fdatasync'); await native('fdatasync', () => handle.datasync()); },
        async truncate(len?: number) {
            await ensureOpen('ftruncate');
            await native('ftruncate', () => handle.truncate(len ?? 0));
        },
        async chmod(mode: Mode) { await ensureOpen('fchmod'); await native('fchmod', () => handle.chmod(modeToNumber(mode))); },
        async chown(uid: number, gid: number) { await ensureOpen('fchown'); await native('fchown', () => handle.chown(uid, gid)); },
        async utimes(atime: TimeLike, mtime: TimeLike) {
            await ensureOpen('futimes');
            await native('futimes', () => handle.utime(timeToUnixMs(atime, 'atime'), timeToUnixMs(mtime, 'mtime')));
        },
        async appendFile(data: string | Uint8Array | ArrayBuffer) {
            // 'writeFile', not 'appendFile' or 'write'.
            await ensureOpen('writeFile');
            await writeAll(toUint8Array(data));
        },
        async readFile(options?: { encoding?: BufferEncoding | null; signal?: AbortSignal } | BufferEncoding) {
            await ensureOpen('readFile');
            const signal = typeof options === 'object' && options !== null ? options.signal : undefined;
            if (signal?.aborted) throw makeAbortError(signal);
            const st = await native('fstat', () => handle.stat());
            const chunks: Uint8Array[] = [];
            let remaining = st.size > 0 ? st.size : Number.POSITIVE_INFINITY;
            while (remaining > 0) {
                if (signal?.aborted) throw makeAbortError(signal);
                const size = Number.isFinite(remaining) ? Math.min(64 * 1024, remaining) : 64 * 1024;
                const buf = new Uint8Array(size);
                const n = await native('read', () => handle.read(buf));
                if (n === null || n === 0) break;
                chunks.push(buf.slice(0, n));
                remaining -= n;
            }
            return decodeBuffer(concatChunks(chunks), typeof options === 'string' ? options : options?.encoding);
        },
        async writeFile(data: string | Uint8Array | ArrayBuffer) {
            // 'writeFile' for both writeFile() and appendFile().
            await ensureOpen('writeFile');
            await writeAll(toUint8Array(data));
        },
        async readv(buffers: readonly ArrayBufferView[], position?: number | null) {
            await ensureOpen('readv');
            if (!Array.isArray(buffers)) throw new TypeError('The "buffers" argument must be an Array');
            let bytesRead = 0;
            let currentPosition = position;
            for (const buffer of buffers) {
                if (!ArrayBuffer.isView(buffer)) throw new TypeError('The "buffers" argument must be an ArrayBufferView[]');
                const chunk = arrayBufferBackedBytes(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
                if (chunk.byteLength === 0) continue;
                const read = await native('readv', () => handle.read(chunk, currentPosition ?? undefined));
                const count = read ?? 0;
                bytesRead += count;
                if (currentPosition != null) currentPosition += count;
                if (count < chunk.byteLength) break;
            }
            return { bytesRead, buffers };
        },
        async writev(buffers: readonly ArrayBufferView[], position?: number | null) {
            await ensureOpen('writev');
            if (!Array.isArray(buffers)) throw new TypeError('The "buffers" argument must be an Array');
            let bytesWritten = 0;
            let currentPosition = position;
            for (const buffer of buffers) {
                if (!ArrayBuffer.isView(buffer)) throw new TypeError('The "buffers" argument must be an ArrayBufferView[]');
                const chunk = arrayBufferBackedBytes(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
                const written = await writeAll(chunk, currentPosition);
                bytesWritten += written;
                if (currentPosition != null) currentPosition += written;
            }
            return { bytesWritten, buffers };
        },
        [Symbol.asyncDispose]() { return closed ? Promise.resolve() : this.close(); },
    };
    return fileHandle;
}

// Shared fs helpers

/** Generate a random hex string for mkdtemp (6 bytes = 12 hex chars) */
export function randomHex(): string {
    const bytes = new Uint8Array(6);
    nativeCrypto.randomFill(bytes);
    return nativeCrypto.hexEncode(bytes);
}

/** Create an async Dir object from a CModuleAsyncFS directory iterator */
export function createAsyncDir(
    pathStr: string,
    dirHandle: CModuleAsyncFS.DirHandle,
): Dir {
    let closed = false;
    let exhausted = false;

    const dir: Dir = {
        path: pathStr,

        async read(): Promise<Dirent | null> {
            if (closed) throw dirClosedError();
            // Sticky: a second post-exhaustion native `next()` yields undefined, not null.
            if (exhausted) return null;
            const result = await dirHandle.next();
            if (result === undefined || result.done) {
                exhausted = true;
                return null;
            }
            return toNodeDirentAsync(result.value, pathStr);
        },

        readSync(): Dirent | null {
            throw new Error('readSync is not supported in async opendir');
        },

        async close(): Promise<void> {
            if (closed) throw dirClosedError();
            closed = true;
            await dirHandle.close();
        },

        closeSync(): void {
            throw new Error('closeSync is not supported in async opendir');
        },

        [Symbol.asyncIterator](): AsyncIterableIterator<Dirent> {
            return directoryIterator(dir);
        },
    } as Dir;

    return dir;
}

/** `dir.path` stays the root while each `Dirent.parentPath` is its real container. */
export function createEagerAsyncDir(
    pathStr: string,
    entries: DirEntryWithParent[],
): Dir {
    let closed = false;
    let index = 0;

    const dir: Dir = {
        path: pathStr,

        async read(): Promise<Dirent | null> {
            if (closed) throw dirClosedError();
            if (index >= entries.length) return null;
            const entry = entries[index++];
            return toNodeDirentAsync(entry, entry.parentPath);
        },

        readSync(): Dirent | null {
            throw new Error('readSync is not supported in async opendir');
        },

        async close(): Promise<void> {
            if (closed) throw dirClosedError();
            closed = true;
            entries = [];
        },

        closeSync(): void {
            throw new Error('closeSync is not supported in async opendir');
        },

        [Symbol.asyncIterator](): AsyncIterableIterator<Dirent> {
            return directoryIterator(dir);
        },
    } as Dir;

    return dir;
}
