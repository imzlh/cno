/**
 * fs module internal utility functions
 */

import { Stats } from 'fs';
// @ts-ignore - dynamic import
import { dirname } from '../path';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

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
    if (encoding) {
        return engine.decodeString(buffer);
    }
    return buffer;
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
        atimeMs: stat.atime.getTime(),
        mtimeMs: stat.mtime.getTime(),
        ctimeMs: stat.ctime.getTime(),
        birthtimeMs: stat.birthtime.getTime(),
        atime: stat.atime,
        mtime: stat.mtime,
        ctime: stat.ctime,
        birthtime: stat.birthtime,
        isFile: () => stat.isFile,
        isDirectory: () => stat.isDirectory,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isSymbolicLink: () => stat.isSymbolicLink,
        isFIFO: () => false,
        isSocket: () => false,
    };
}

export async function toNodeStatAsync(stat: CModuleAsyncFS.StatResult): Promise<Stats> {
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
        atimeMs: stat.atime.getTime(),
        mtimeMs: stat.mtime.getTime(),
        ctimeMs: stat.ctime.getTime(),
        birthtimeMs: stat.birthtime.getTime(),
        atime: stat.atime,
        mtime: stat.mtime,
        ctime: stat.ctime,
        birthtime: stat.birthtime,
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

export function toNodeDirent(name: string, stat: CModuleFS.Stats): import('fs').Dirent {
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

export function parseFlags(flag?: string | number): CModuleFS.OpenFlags {
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

export function pathToString(path: string | URL): string {
    return path instanceof URL ? path.pathname : path;
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
