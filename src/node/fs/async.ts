/**
 * Node.js fs module - async operations
 */

const asfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');
import { FileHandle } from 'fs/promises';
import { toUint8Array, decodeBuffer, toNodeStatAsync, toNodeDirentAsync, parseFlags, pathToString, removeRecursive, mkdirRecursive } from './utils';
import { Stats } from 'fs';

// ============================================================================
// File read/write
// ============================================================================

export async function readFile(path: string | URL | number, options?: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding): Promise<string | Uint8Array> {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const buffer = await asfs.readFile(pathStr);
    return decodeBuffer(buffer, encoding);
}

export async function writeFile(path: string | URL | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: number | string; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path);
    const mode = typeof options === 'object' ? (typeof options?.mode === 'string' ? parseInt(options.mode, 8) : options?.mode) : typeof options === 'number' ? options : undefined;
    const flag = typeof options === 'object' ? parseFlags(options?.flag) : 'w';
    const buffer = toUint8Array(data);

    const handle = await asfs.open(pathStr, flag, mode);
    try {
        await handle.write(buffer);
    } finally {
        await handle.close();
    }
}

export async function appendFile(path: string | URL | number, data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: number | string; flag?: string | number } | BufferEncoding | number): Promise<void> {
    const pathStr = typeof path === 'number' ? `fd:${path}` : pathToString(path);
    const mode = typeof options === 'object' ? (typeof options?.mode === 'string' ? parseInt(options.mode, 8) : options?.mode) : typeof options === 'number' ? options : undefined;
    const buffer = toUint8Array(data);

    const handle = await asfs.open(pathStr, 'a', mode);
    try {
        await handle.write(buffer);
    } finally {
        await handle.close();
    }
}

// ============================================================================
// File status
// ============================================================================

export async function exists(path: string | URL): Promise<boolean> {
    try {
        await asfs.stat(pathToString(path));
        return true;
    } catch {
        return false;
    }
}

export async function stat(path: string | URL, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const st = await asfs.stat(pathToString(path));
    return toNodeStatAsync(st);
}

export async function lstat(path: string | URL, options?: { bigint?: boolean }): Promise<import('fs').Stats> {
    const st = await asfs.lstat(pathToString(path));
    return toNodeStatAsync(st);
}

export async function access(path: string | URL, mode?: number): Promise<void> {
    // asyncfs has no access, simulate with stat
    const pathStr = pathToString(path);
    await asfs.stat(pathStr);
}

// ============================================================================
// Directory operations
// ============================================================================

export async function mkdir(path: string | URL, options?: { mode?: number; recursive?: boolean } | number): Promise<string | undefined> {
    const pathStr = pathToString(path);
    const mode = typeof options === 'number' ? options : options?.mode;
    const recursive = typeof options === 'object' ? options?.recursive : false;

    if (recursive) {
        await mkdirRecursive(pathStr, mode);
        return pathStr;
    }

    await asfs.mkdir(pathStr, mode);
    return undefined;
}

export async function rmdir(path: string | URL, options?: { recursive?: boolean }): Promise<void> {
    const pathStr = pathToString(path);

    if (options?.recursive) {
        await removeRecursive(pathStr);
    } else {
        await asfs.rmdir(pathStr);
    }
}

export async function rm(path: string | URL, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void> {
    const pathStr = pathToString(path);

    try {
        const stats = await asfs.lstat(pathStr);

        if (stats.isDirectory) {
            if (options?.recursive) {
                await removeRecursive(pathStr);
            } else {
                await asfs.rmdir(pathStr);
            }
        } else {
            await asfs.unlink(pathStr);
        }
    } catch (err) {
        if (!options?.force) {
            throw err;
        }
    }
}

export async function readdir(path: string | URL, options?: { encoding?: BufferEncoding | 'buffer'; withFileTypes?: boolean; recursive?: boolean } | BufferEncoding): Promise<string[] | import('fs').Dirent[]> {
    const pathStr = pathToString(path);
    const withFileTypes = typeof options === 'object' ? options?.withFileTypes : false;

    const dirHandle = await asfs.readDir(pathStr);
    const entries: import('fs').Dirent[] = [];
    const names: string[] = [];

    try {
        for await (const entry of dirHandle) {
            if (withFileTypes) {
                entries.push(toNodeDirentAsync(entry));
            } else {
                names.push(entry.name);
            }
        }
    } finally {
        await dirHandle.close();
    }

    return withFileTypes ? entries : names;
}

export async function opendir(path: string | URL, options?: { encoding?: BufferEncoding; bufferSize?: number }): Promise<import('fs').Dir> {
    const pathStr = pathToString(path);
    const dirHandle = await asfs.readDir(pathStr);
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
                    if (entry === null) {
                        return { done: true, value: undefined };
                    }
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

// ============================================================================
// File operations
// ============================================================================

export async function unlink(path: string | URL): Promise<void> {
    await asfs.unlink(pathToString(path));
}

export async function rename(oldPath: string | URL, newPath: string | URL): Promise<void> {
    await asfs.rename(pathToString(oldPath), pathToString(newPath));
}

export async function copyFile(src: string | URL, dest: string | URL, mode?: number): Promise<void> {
    await asfs.copyFile(pathToString(src), pathToString(dest));
}

export async function truncate(path: string | URL, len?: number): Promise<void> {
    const handle = await asfs.open(pathToString(path), 'r+');
    try {
        await handle.truncate(len ?? 0);
    } finally {
        await handle.close();
    }
}

// ============================================================================
// Link operations
// ============================================================================

export async function link(existingPath: string | URL, newPath: string | URL): Promise<void> {
    await asfs.link(pathToString(existingPath), pathToString(newPath));
}

export async function symlink(target: string | URL, path: string | URL, type?: 'file' | 'dir' | 'junction'): Promise<void> {
    const symlinkType = type === 'dir' ? asfs.SymlinkType.DIR : asfs.SymlinkType.JUNCTION;
    await asfs.symlink(pathToString(target), pathToString(path), symlinkType);
}

export async function readlink(path: string | URL, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): Promise<string | Uint8Array> {
    const result = await asfs.readLink(pathToString(path));
    return result;
}

export async function realpath(path: string | URL, options?: { encoding?: BufferEncoding | 'buffer' } | BufferEncoding): Promise<string> {
    return await asfs.realPath(pathToString(path));
}

// ============================================================================
// Permission operations
// ============================================================================

export async function chmod(path: string | URL, mode: number | string): Promise<void> {
    const modeNum = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    await asfs.chmod(pathToString(path), modeNum);
}

export async function chown(path: string | URL, uid: number, gid: number): Promise<void> {
    await asfs.chown(pathToString(path), uid, gid);
}

// ============================================================================
// Time operations
// ============================================================================

export async function utimes(path: string | URL, atime: number | Date | string, mtime: number | Date | string): Promise<void> {
    const atimeMs = typeof atime === 'number' ? atime : typeof atime === 'string' ? new Date(atime).getTime() : atime.getTime();
    const mtimeMs = typeof mtime === 'number' ? mtime : typeof mtime === 'string' ? new Date(mtime).getTime() : mtime.getTime();
    await asfs.utime(pathToString(path), atimeMs / 1000, mtimeMs / 1000);
}

// ============================================================================
// FileHandle implementation
// ============================================================================

class FileHandleImpl implements FileHandle {
    constructor(
        public fd: number,
        private handle: CModuleAsyncFS.FileHandle
    ) {}

    async read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    async read(options?: { buffer?: Uint8Array; offset?: number; length?: number; position?: number | null }): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    async read(...args: any[]): Promise<{ bytesRead: number; buffer: Uint8Array }> {
        if (args.length === 1 && typeof args[0] === 'object') {
            const { buffer = new Uint8Array(16384), offset = 0, length = buffer.length, position = null } = args[0];
            const bytesRead = await this.handle.read(buffer.subarray(offset, offset + length), position);
            return { bytesRead, buffer };
        }

        const [buffer, offset = 0, length = buffer.length, position = null] = args;
        const bytesRead = await this.handle.read(buffer.subarray(offset, offset + length), position);
        return { bytesRead, buffer };
    }

    // @ts-ignore
    async write(buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number; buffer: any }> {
        const data = typeof buffer === 'string' ? toUint8Array(buffer) : buffer;
        const actualOffset = offset ?? 0;
        const actualLength = length ?? data.length;
        const bytesWritten = await this.handle.write(
            data.subarray(actualOffset, actualOffset + actualLength) as Uint8Array<ArrayBuffer>, 
            position ?? null
        );
        return { bytesWritten, buffer };
    }

    async close(): Promise<void> {
        await this.handle.close();
    }

    // @ts-ignore
    async stat(): Promise<Stats> {
        const st = await this.handle.stat();
        return toNodeStatAsync(st);
    }

    async sync(): Promise<void> {
        await this.handle.sync();
    }

    async datasync(): Promise<void> {
        await this.handle.datasync();
    }

    async truncate(len?: number): Promise<void> {
        await this.handle.truncate(len ?? 0);
    }

    async chmod(mode: number | string): Promise<void> {
        const modeNum = typeof mode === 'string' ? parseInt(mode, 8) : mode;
        await this.handle.chmod(modeNum);
    }

    async chown(uid: number, gid: number): Promise<void> {
        await this.handle.chown(uid, gid);
    }

    async utimes(atime: number | Date | string, mtime: number | Date | string): Promise<void> {
        const atimeMs = typeof atime === 'number' ? atime : typeof atime === 'string' ? new Date(atime).getTime() : atime.getTime();
        const mtimeMs = typeof mtime === 'number' ? mtime : typeof mtime === 'string' ? new Date(mtime).getTime() : mtime.getTime();
        await this.handle.utime(atimeMs / 1000, mtimeMs / 1000);
    }

    async appendFile(data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: number | string; flag?: string | number } | BufferEncoding): Promise<void> {
        const buffer = toUint8Array(data);
        await this.handle.write(buffer);
    }

    // @ts-ignore
    async readFile(options?: { encoding?: BufferEncoding | null; flag?: string | number } | BufferEncoding): Promise<string | Uint8Array> {
        const stat = await this.handle.stat();
        const buffer = new Uint8Array(stat.size);
        let offset = 0;

        while (offset < stat.size) {
            const bytesRead = await this.handle.read(buffer.subarray(offset), null);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }

        const encoding = typeof options === 'string' ? options : options?.encoding;
        return decodeBuffer(buffer, encoding);
    }

    async writeFile(data: string | Uint8Array | ArrayBuffer, options?: { encoding?: BufferEncoding | null; mode?: number | string; flag?: string | number } | BufferEncoding): Promise<void> {
        const buffer = toUint8Array(data);
        await this.handle.write(buffer);
    }

    // @ts-ignore
    readableWebStream(options?: { type?: 'bytes' }): ReadableStream<Uint8Array> {
        throw new Error('readableWebStream is not implemented');
    }

    writableWebStream(options?: { type?: 'bytes' }): WritableStream<Uint8Array> {
        throw new Error('writableWebStream is not implemented');
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }
}

// ============================================================================
// Open file
// ============================================================================

export async function open(path: string | URL, flags?: string | number, mode?: number | string) {
    const flag = parseFlags(flags);
    const modeNum = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    const handle = await asfs.open(pathToString(path), flag as any, modeNum);
    return new FileHandleImpl(handle.fileno(), handle);
}
