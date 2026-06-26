/**
 * fs module internal utility functions
 */

import { Stats } from 'fs';
import type { StatFsOptions } from 'fs';
// @ts-ignore - dynamic import
import { dirname } from '../path';
import { fileURLToPath } from '../url';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

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
 * Read a file from a file descriptor in chunks, returning the concatenated result.
 * Shared by _promises.ts, async.ts, callbacks.ts, sync.ts.
 */
export async function readFileFromFdAsync(
    readFn: (fd: number, buf: Uint8Array) => Promise<number>,
    fd: number,
    bufSize: number,
): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(bufSize);
    for (;;) {
        const n = await readFn(fd, buf);
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

/**
 * Synchronous version of readFileFromFd.
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

export function decodeBuffer(buffer: Uint8Array<ArrayBuffer>, encoding?: BufferEncoding | null): string | Uint8Array<ArrayBuffer> {
    if (!encoding || encoding as string === 'buffer') return buffer;
    return engine.decodeString(buffer);
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
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
        atimeMs: stat.atim.getTime(),
        mtimeMs: stat.mtim.getTime(),
        ctimeMs: stat.ctim.getTime(),
        birthtimeMs: stat.birthtim.getTime(),
        atime: stat.atim,
        mtime: stat.mtim,
        ctime: stat.ctim,
        birthtime: stat.birthtim,
        isFile: () => stat.isFile,
        isDirectory: () => stat.isDirectory,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isSymbolicLink: () => stat.isSymbolicLink,
        isFIFO: () => false,
        isSocket: () => false,
    };
}

export const toNodeStatAsync = toNodeStat;

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
    // @ts-ignore
    return flag || 'r';
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
            removeRecursiveSync(`${targetPath}/${item}`);
        }
        fs.rmdir(targetPath);
    } else {
        fs.unlink(targetPath);
    }
}

export async function removeRecursive(targetPath: string): Promise<void> {
    const asfs = import.meta.use('asyncfs');
    const stats = await asfs.stat(targetPath);

    if (stats.isDirectory) {
        const dirHandle = await asfs.readDir(targetPath);
        try {
            for await (const entry of dirHandle) {
                await removeRecursive(`${targetPath}/${entry.name}`);
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

export function mkdirRecursiveSync(pathStr: string, mode?: number): void {
    const parts = pathStr.replace(/\\/g, '/').split('/').filter(p => p);
    let current = pathStr.startsWith('/') ? '/' : '';

    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!fs.exists(current)) {
            fs.mkdir(current, mode);
        }
    }
}

export async function mkdirRecursive(pathStr: string, mode?: number): Promise<void> {
    const asfs = import.meta.use('asyncfs');
    const parts = pathStr.replace(/\\/g, '/').split('/').filter(p => p);
    let current = pathStr.startsWith('/') ? '/' : '';

    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
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
            return toNodeStatAsync(await handle.stat());
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
