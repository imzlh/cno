/**
 * fs module internal utility functions
 */

import type { StatFsOptions } from 'fs';
import path from '../path';
const { dirname, join } = path;
import { fileURLToPath } from '../url';
import { Buffer } from '../buffer';
import { randomBytes } from '../crypto';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const asfs = import.meta.use('asyncfs');

// ============================================================================
// Shared type definitions (used across _promises.ts, callbacks.ts, sync.ts, async.ts)
// ============================================================================

export type PathLike = string | URL | Buffer;
export type TimeLike = string | number | Date;
export type Mode = number | string;

export function modeToNumber(mode?: Mode): number | undefined {
    if (typeof mode === 'string') {
        return parseInt(mode, 8);
    }
    return mode;
}

export function timeToNumber(time: TimeLike): number {
    if (typeof time === 'number') return time;
    if (typeof time === 'string') return new Date(time).getTime();
    return time.getTime();
}

/**
 * Read a file synchronously from a file descriptor in chunks, returning the concatenated result.
 */
export function readFileFromFdSync(
    readFn: (fd: number, buf: Uint8Array) => number,
    fd: number,
    bufSize: number,
): Uint8Array<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(bufSize);
    for (;;) {
        const n = readFn(fd, buf);
        if (n <= 0) break;
        chunks.push(buf.slice(0, n));
        if (n < bufSize) break;
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

// ============================================================================
// Data conversion
// ============================================================================

export function toUint8Array(data: string | Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
    if (typeof data === 'string') {
        return engine.encodeString(data);
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    return data as Uint8Array<ArrayBuffer>;
}

export function decodeBuffer(buffer: Uint8Array<ArrayBuffer>, encoding?: BufferEncoding | null): string | Buffer {
    if (!encoding || encoding as string === 'buffer') return Buffer.from(buffer);
    return engine.decodeString(buffer);
}

// ============================================================================
// Stats conversion
// ============================================================================

export function toNodeStat(stat: CModuleFS.Stats): import('fs').Stats {
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
        atimeMs: stat.atim?.getTime(),
        mtimeMs: stat.mtim?.getTime(),
        ctimeMs: stat.ctim?.getTime(),
        birthtimeMs: stat.birthtim?.getTime(),
        atime: stat.atim,
        mtime: stat.mtim,
        ctime: stat.ctim,
        birthtime: stat.birthtim,
        isFile: () => stat.isFile,
        isDirectory: () => stat.isDirectory,
        isBlockDevice: () => stat.isBlockDevice,
        isCharacterDevice: () => stat.isCharacterDevice,
        isSymbolicLink: () => stat.isSymbolicLink,
        isFIFO: () => stat.isFIFO,
        isSocket: () => stat.isSocket,
    };
}

// ============================================================================
// Dirent conversion
// ============================================================================

export function toNodeDirent(
    name: string,
    stat: Pick<CModuleFS.Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink'>
        | Pick<CModuleFS.DirEnt, 'isFile' | 'isDirectory' | 'isSymbolicLink'>
): import('fs').Dirent {
    return {
        name,
        isFile: () => stat.isFile,
        isDirectory: () => stat.isDirectory,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isSymbolicLink: () => stat.isSymbolicLink,
        isFIFO: () => false,
        isSocket: () => false,
        parentPath: dirname(name)
    };
}

export function toNodeDirentAsync(ent: CModuleAsyncFS.DirEnt): import('fs').Dirent {
    return {
        name: ent.name,
        isFile: () => ent.isFile,
        isDirectory: () => ent.isDirectory,
        isBlockDevice: () => ent.isBlockDevice,
        isCharacterDevice: () => ent.isCharacterDevice,
        isSymbolicLink: () => ent.isSymbolicLink,
        isFIFO: () => ent.isFIFO,
        isSocket: () => ent.isSocket,
        parentPath: dirname(ent.name)
    };
}

// ============================================================================
// Flag parsing
// ============================================================================

export function parseFlags(flag?: string | number): Exclude<CModuleFS.OpenFlags, number> {
    if (typeof flag === 'number') {
        if (flag & fs.OPEN_APPEND) return 'a';
        if (flag & fs.OPEN_CREAT) {
            if (flag & fs.OPEN_EXCL) return 'wx';
            if (flag & fs.OPEN_TRUNC) return 'w';
            return 'w';
        }
        if (flag & fs.OPEN_RDWR) return 'r+';
        if (flag & fs.OPEN_WRONLY) return 'w';
        return 'r';
    }
    // flag is string | undefined here (number branch handled above)
    return (flag || 'r') as Exclude<CModuleFS.OpenFlags, number>;
}

// ============================================================================
// Path handling
// ============================================================================

export function pathToString(path: string | URL | Uint8Array): string {
    if (typeof path === 'string') return path;
    if (path == null) return String(path);
    if (path instanceof Uint8Array) {
        return engine.decodeString(path as Uint8Array<ArrayBuffer>);
    }
    if (path instanceof URL) {
        return fileURLToPath(path);
    }
    return String(path);
}

export function splitPathOrFd(path: string | URL | Uint8Array | number): { fd: number } | { path: string } {
    if (typeof path === 'number') return { fd: path };
    return { path: pathToString(path) };
}

export function describeFd(fd: number): string {
    return `fd:${fd}`;
}

// ============================================================================
// Recursive deletion
// ============================================================================

export function removeRecursiveSync(targetPath: string): void {
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
}

export async function removeRecursive(targetPath: string): Promise<void> {
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
        await asfs.unlink(targetPath);
    }
}

// ============================================================================
// Recursive directory creation
// ============================================================================

function splitMkdirPath(pathStr: string): { root: string; parts: string[] } {
    const normalized = pathStr.replace(/\\/g, '/');
    const uncMatch = normalized.match(/^\/\/[^/]+\/[^/]+/);
    if (uncMatch) {
        return {
            root: uncMatch[0],
            parts: normalized.slice(uncMatch[0].length).split('/').filter(Boolean),
        };
    }

    const driveMatch = normalized.match(/^[a-zA-Z]:(?:\/|$)/);
    if (driveMatch) {
        const root = driveMatch[0].endsWith('/') ? driveMatch[0] : `${driveMatch[0]}/`;
        return {
            root,
            parts: normalized.slice(driveMatch[0].length).split('/').filter(Boolean),
        };
    }

    return {
        root: normalized.startsWith('/') ? '/' : '',
        parts: normalized.slice(normalized.startsWith('/') ? 1 : 0).split('/').filter(Boolean),
    };
}

function appendPathPart(base: string, part: string): string {
    if (!base) return part;
    return base.endsWith('/') ? `${base}${part}` : `${base}/${part}`;
}

export function mkdirRecursiveSync(pathStr: string, mode?: number): void {
    const { root, parts } = splitMkdirPath(pathStr);
    let current = root;

    for (const part of parts) {
        current = appendPathPart(current, part);
        if (!fs.exists(current)) {
            fs.mkdir(current, mode);
        }
    }
}

export async function mkdirRecursive(pathStr: string, mode?: number): Promise<void> {
    const { root, parts } = splitMkdirPath(pathStr);
    let current = root;

    for (const part of parts) {
        current = appendPathPart(current, part);
        try {
            const stat = await asfs.stat(current);
            if (!stat.isDirectory) {
                throw new Error(`Not a directory: ${current}`);
            }
        } catch {
            await asfs.mkdir(current, mode);
        }
    }
}

export function createFileHandle(fd: number, handle: CModuleAsyncFS.FileHandle) {
    return {
        fd,
        async read(buffer: Uint8Array<ArrayBuffer>, offset?: number, length?: number, position?: number | null) {
            const o = offset ?? 0, l = length ?? buffer.length;
            const bytesRead = await handle.read(buffer.subarray(o, o + l), position ?? null);
            return { bytesRead, buffer };
        },
        async write(buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null) {
            const data = typeof buffer === 'string' ? toUint8Array(buffer) : buffer;
            const o = offset ?? 0, l = length ?? data.length;
            const bytesWritten = await handle.write(data.subarray(o, o + l) as Uint8Array<ArrayBuffer>, position ?? null);
            return { bytesWritten, buffer: data };
        },
        async close() { await handle.close(); },
        async stat(ops?: StatFsOptions) {
            if (ops?.bigint) throw new Error('bigint option is not supported');
            return toNodeStat(await handle.stat());
        },
        async sync() { await handle.sync(); },
        async datasync() { await handle.datasync(); },
        async truncate(len?: number) { await handle.truncate(len ?? 0); },
        async chmod(mode: Mode) { await handle.chmod(modeToNumber(mode)!); },
        async chown(uid: number, gid: number) { await handle.chown(uid, gid); },
        async utimes(atime: TimeLike, mtime: TimeLike) {
            await handle.utime(timeToNumber(atime) / 1000, timeToNumber(mtime) / 1000);
        },
        async appendFile(data: string | Uint8Array | ArrayBuffer) {
            await handle.write(toUint8Array(data));
        },
        async readFile(options?: { encoding?: BufferEncoding | null } | BufferEncoding) {
            const st = await handle.stat();
            const buf = new Uint8Array(st.size);
            let off = 0;
            while (off < st.size) { const n = await handle.read(buf.subarray(off), null); if (n === 0) break; off += n; }
            return decodeBuffer(buf, typeof options === 'string' ? options : options?.encoding);
        },
        async writeFile(data: string | Uint8Array | ArrayBuffer) {
            await handle.truncate(0);
            await handle.write(toUint8Array(data));
        },
        [Symbol.asyncDispose]() { return handle.close(); },
    };
}

// ============================================================================
// Shared fs helpers
// ============================================================================

/** Generate a random hex string for mkdtemp (6 bytes = 12 hex chars) */
export function randomHex(): string {
    return Array.from(randomBytes(6) as Uint8Array)
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Create an async Dir object from a CModuleAsyncFS directory iterator */
export function createAsyncDir(
    pathStr: string,
    dirHandle: CModuleAsyncFS.DirHandle,
): import('fs').Dir {
    let closed = false;

    const dir: import('fs').Dir = {
        path: pathStr,

        async read(): Promise<import('fs').Dirent | null> {
            if (closed) return null;
            const result = await dirHandle.next();
            if (result.done) return null;
            return toNodeDirentAsync(result.value);
        },

        readSync(): import('fs').Dirent | null {
            throw new Error('readSync is not supported in async opendir');
        },

        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            await dirHandle.close();
        },

        closeSync(): void {
            throw new Error('closeSync is not supported in async opendir');
        },

        [Symbol.asyncIterator](): AsyncIterableIterator<import('fs').Dirent> {
            return {
                async next() {
                    const entry = await dir.read();
                    if (entry === null) return { done: true, value: undefined };
                    return { done: false, value: entry };
                },
                async return() {
                    await dir.close();
                    return { done: true, value: undefined };
                },
            } as AsyncIterableIterator<import('fs').Dirent>;
        },
    } as import('fs').Dir;

    return dir;
}
