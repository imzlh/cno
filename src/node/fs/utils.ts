/**
 * fs module internal utility functions
 */

import type { StatFsOptions } from 'fs';
import path from '../path';
const { dirname, join } = path;
import { fileURLToPath } from '../url';
import { Buffer } from '../buffer';
import { arrayBufferBackedBytes, concatChunks } from '../_internal/buffer';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const asfs = import.meta.use('asyncfs');
const nativeCrypto = import.meta.use('crypto');
const algorithm = import.meta.use('algorithm');
const text = import.meta.use('text');

// Shared type definitions (used across _promises.ts, callbacks.ts, sync.ts, async.ts)

export type PathLike = string | URL | Buffer;
export type TimeLike = string | number | Date;
export type Mode = number | string;

export function modeToNumber(mode: Mode): number;
export function modeToNumber(mode?: Mode): number | undefined;
export function modeToNumber(mode?: Mode): number | undefined {
    if (typeof mode === 'string') {
        return parseInt(mode, 8);
    }
    return mode;
}

export function timeToNumber(time: TimeLike): number {
    const value = typeof time === 'number'
        ? time
        : typeof time === 'string'
            ? new Date(time).getTime()
            : time.getTime();
    if (!Number.isFinite(value)) {
        throw new Error('invalid atime, must not be infinity or NaN');
    }
    return value;
}

export function errorFromUnknown(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
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
    return concatChunks(chunks);
}

// Data conversion

export function toUint8Array(data: string | Uint8Array | ArrayBuffer, encoding?: BufferEncoding | null): Uint8Array<ArrayBuffer> {
    if (typeof data === 'string') {
        const normalized = String(encoding ?? 'utf8').toLowerCase();
        switch (normalized) {
            case 'utf8':
            case 'utf-8':
                return arrayBufferBackedBytes(engine.encodeString(data));
            case 'utf16le':
            case 'utf-16le':
            case 'ucs2':
            case 'ucs-2': {
                const u16 = engine.encodeU16String(data);
                return new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
            }
            case 'latin1':
            case 'binary':
                return arrayBufferBackedBytes(algorithm.latin1EncodeLoose(data));
            case 'ascii':
                return arrayBufferBackedBytes(algorithm.asciiEncodeLoose(data));
            case 'hex':
                return arrayBufferBackedBytes(algorithm.hexDecodeLoose(data));
            case 'base64':
            case 'base64url':
                return arrayBufferBackedBytes(algorithm.base64DecodeLoose(data));
            default:
                return arrayBufferBackedBytes(new text.Encoder(encoding ?? 'utf8').encode(data));
        }
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    return arrayBufferBackedBytes(data);
}

export function decodeBuffer(buffer: Uint8Array<ArrayBuffer>, encoding: BufferEncoding): string;
export function decodeBuffer(buffer: Uint8Array<ArrayBuffer>, encoding?: 'buffer' | null): Buffer;
export function decodeBuffer(buffer: Uint8Array<ArrayBuffer>, encoding?: BufferEncoding | 'buffer' | null): string | Buffer {
    if (!encoding || encoding === 'buffer') return Buffer.from(buffer);
    const normalized = String(encoding).toLowerCase();
    switch (normalized) {
        case 'utf8':
        case 'utf-8':
            return engine.decodeString(buffer);
        case 'utf16le':
        case 'utf-16le':
        case 'ucs2':
        case 'ucs-2': {
            const len = buffer.byteLength & ~1;
            if (len === 0) return '';
            if ((buffer.byteOffset & 1) === 0) {
                return engine.decodeU16String(new Uint16Array(buffer.buffer, buffer.byteOffset, len >>> 1));
            }
            const copy = new Uint8Array(len);
            copy.set(buffer.subarray(0, len));
            return engine.decodeU16String(copy.buffer);
        }
        case 'latin1':
        case 'binary':
            return algorithm.latin1DecodeLoose(buffer);
        case 'ascii':
            return algorithm.asciiDecodeLoose(buffer);
        case 'hex':
            return nativeCrypto.hexEncode(buffer);
        case 'base64':
            return nativeCrypto.base64Encode(buffer);
        case 'base64url':
            return algorithm.base64UrlEncode(buffer);
        default:
            return new text.Decoder(encoding).decode(buffer);
    }
}

export function encodePathResult(
    pathStr: string,
    options?: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding,
): string | Buffer {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding == null) return pathStr;
    const bytes = arrayBufferBackedBytes(engine.encodeString(pathStr));
    if (encoding === 'buffer') return Buffer.from(bytes);
    return decodeBuffer(bytes, encoding);
}

const VALID_ENCODINGS = new Set([
    'utf8',
    'utf-8',
    'utf16le',
    'utf-16le',
    'ucs2',
    'ucs-2',
    'latin1',
    'binary',
    'ascii',
    'hex',
    'base64',
    'base64url',
    'buffer',
]);

function validateEncodingOption(encoding: unknown): void {
    if (encoding === undefined || encoding === null) return;
    if (typeof encoding !== 'string' || !VALID_ENCODINGS.has(encoding.toLowerCase())) {
        throw new TypeError(`Invalid encoding: ${String(encoding)}`);
    }
}

export function validateOpendirOptions(options: unknown): void {
    if (options === undefined || options === null) return;
    if (typeof options !== 'object') throw new TypeError('The "options" argument must be of type object');
    const encoding = Reflect.get(options, 'encoding');
    const bufferSize = Reflect.get(options, 'bufferSize');
    validateEncodingOption(encoding);
    if (bufferSize === undefined) return;
    if (typeof bufferSize !== 'number') {
        throw new TypeError('The "options.bufferSize" argument must be of type number');
    }
    if (!Number.isInteger(bufferSize) || bufferSize < 1 || bufferSize > 0xffffffff) {
        throw new RangeError('The value of "options.bufferSize" is out of range');
    }
}

export function validateFd(fd: number): void {
    if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) {
        throw new RangeError('The value of "fd" is out of range. It must be a non-negative integer.');
    }
}

export function makeAbortError(signal: AbortSignal): NodeJS.ErrnoException {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;

    const error = new Error('The operation was aborted') as NodeJS.ErrnoException & { cause?: unknown };
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    if (reason !== undefined) error.cause = reason;
    return error;
}

export function assertCopyFileMode(src: string, dest: string, mode?: unknown): void {
    if (mode == null) return;
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < -2147483648 || mode > 2147483647) {
        throw Object.assign(new TypeError('mode must be int32 or null/undefined'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    if (!mode || (mode & 1) === 0 || !fs.exists(dest)) return;
    const err = new Error(`EEXIST: file already exists, copyfile '${src}' -> '${dest}'`) as NodeJS.ErrnoException & { dest?: string };
    err.name = 'ErrnoException';
    err.code = 'EEXIST';
    err.errno = -17;
    err.syscall = 'copyfile';
    err.path = src;
    err.dest = dest;
    throw err;
}

// Stats conversion

type StatValue = number | bigint;

export class Stats {
    dev: StatValue;
    ino: StatValue;
    mode: StatValue;
    nlink: StatValue;
    uid: StatValue;
    gid: StatValue;
    rdev: StatValue;
    size: StatValue;
    blksize: StatValue;
    blocks: StatValue;
    atimeMs: StatValue;
    mtimeMs: StatValue;
    ctimeMs: StatValue;
    birthtimeMs: StatValue;
    atime: Date;
    mtime: Date;
    ctime: Date;
    birthtime: Date;
    private readonly stat: Partial<CModuleFS.Stats>;

    constructor(stat?: CModuleFS.Stats, bigint = false) {
        const statInfo: Partial<CModuleFS.Stats> = stat ?? {};
        const convert = bigint ? (value: number) => BigInt(value) : (value: number) => value;
        this.stat = statInfo;
        this.dev = convert(statInfo.dev ?? 0);
        this.ino = convert(statInfo.ino ?? 0);
        this.mode = convert(statInfo.mode ?? 0);
        this.nlink = convert(statInfo.nlink ?? 0);
        this.uid = convert(statInfo.uid ?? 0);
        this.gid = convert(statInfo.gid ?? 0);
        this.rdev = convert(statInfo.rdev ?? 0);
        this.size = convert(statInfo.size ?? 0);
        this.blksize = convert(statInfo.blksize ?? 0);
        this.blocks = convert(statInfo.blocks ?? 0);
        this.atimeMs = convert(statInfo.atim?.getTime() ?? 0);
        this.mtimeMs = convert(statInfo.mtim?.getTime() ?? 0);
        this.ctimeMs = convert(statInfo.ctim?.getTime() ?? 0);
        this.birthtimeMs = convert(statInfo.birthtim?.getTime() ?? 0);
        this.atime = statInfo.atim ?? new Date(0);
        this.mtime = statInfo.mtim ?? new Date(0);
        this.ctime = statInfo.ctim ?? new Date(0);
        this.birthtime = statInfo.birthtim ?? new Date(0);
    }

    isFile(): boolean { return this.stat.isFile === true; }
    isDirectory(): boolean { return this.stat.isDirectory === true; }
    isBlockDevice(): boolean { return this.stat.isBlockDevice === true; }
    isCharacterDevice(): boolean { return this.stat.isCharacterDevice === true; }
    isSymbolicLink(): boolean { return this.stat.isSymbolicLink === true; }
    isFIFO(): boolean { return this.stat.isFIFO === true; }
    isSocket(): boolean { return this.stat.isSocket === true; }
}

export function toNodeStat(stat: CModuleFS.Stats, options?: { bigint?: boolean }): import('fs').Stats {
    return new Stats(stat, options?.bigint === true) as import('fs').Stats;
}

type StatFsInput = CModuleFS.StatFsResult | CModuleAsyncFS.StatFsResult;
type StatFsValue = number | bigint;

export class StatFs {
    type: StatFsValue;
    bsize: StatFsValue;
    blocks: StatFsValue;
    bfree: StatFsValue;
    bavail: StatFsValue;
    files: StatFsValue;
    ffree: StatFsValue;

    constructor(stat: StatFsInput, bigint = false) {
        const convert = bigint ? (value: number) => BigInt(value) : (value: number) => value;
        this.type = convert(stat.type);
        this.bsize = convert(stat.bsize);
        this.blocks = convert(stat.blocks);
        this.bfree = convert(stat.bfree);
        this.bavail = convert(stat.bavail);
        this.files = convert(stat.files);
        this.ffree = convert(stat.ffree);
    }
}

export function toNodeStatFs(stat: StatFsInput, options?: StatFsOptions): import('fs').StatsFs {
    return new StatFs(stat, options?.bigint === true) as import('fs').StatsFs;
}

// Dirent conversion — parentPath is the directory containing `name` (Node 20.12+).

/**
 * Dir walk entry. `name` is the leaf basename (Dirent.name).
 * `relativePath` is relative to the readdir root (string readdir names).
 * `parentPath` is the absolute directory containing the leaf.
 */
export interface DirEntryWithParent {
    name: string;
    relativePath: string;
    parentPath: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    isBlockDevice?: boolean;
    isCharacterDevice?: boolean;
    isFIFO?: boolean;
    isSocket?: boolean;
}

export function toNodeDirent(
    name: string,
    stat: Pick<CModuleFS.Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'isBlockDevice' | 'isCharacterDevice' | 'isFIFO' | 'isSocket'>
        | Pick<CModuleFS.DirEnt, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'isBlockDevice' | 'isCharacterDevice' | 'isFIFO' | 'isSocket'>
        | DirEntryWithParent,
    parentPath: string,
): import('fs').Dirent {
    return {
        name,
        isFile: () => stat.isFile,
        isDirectory: () => stat.isDirectory,
        isBlockDevice: () => !!stat.isBlockDevice,
        isCharacterDevice: () => !!stat.isCharacterDevice,
        isSymbolicLink: () => stat.isSymbolicLink,
        isFIFO: () => !!stat.isFIFO,
        isSocket: () => !!stat.isSocket,
        parentPath,
    };
}

export function toNodeDirentAsync(
    ent: CModuleAsyncFS.DirEnt | DirEntryWithParent,
    parentPath: string,
): import('fs').Dirent {
    return {
        name: ent.name,
        isFile: () => ent.isFile,
        isDirectory: () => ent.isDirectory,
        isBlockDevice: () => !!ent.isBlockDevice,
        isCharacterDevice: () => !!ent.isCharacterDevice,
        isSymbolicLink: () => ent.isSymbolicLink,
        isFIFO: () => !!ent.isFIFO,
        isSocket: () => !!ent.isSocket,
        parentPath,
    };
}

export function readDirEntriesSync(pathStr: string, recursive = false, prefix = ''): DirEntryWithParent[] {
    const absDir = prefix ? join(pathStr, prefix) : pathStr;
    const entries = fs.readdir(absDir, true);
    const out: DirEntryWithParent[] = [];
    for (const entry of entries) {
        const relativePath = prefix ? join(prefix, entry.name) : entry.name;
        out.push({
            name: entry.name,
            relativePath,
            parentPath: absDir,
            isFile: entry.isFile,
            isDirectory: entry.isDirectory,
            isSymbolicLink: entry.isSymbolicLink,
            isBlockDevice: entry.isBlockDevice,
            isCharacterDevice: entry.isCharacterDevice,
            isFIFO: entry.isFIFO,
            isSocket: entry.isSocket,
        });
        if (recursive && entry.isDirectory && !entry.isSymbolicLink) {
            out.push(...readDirEntriesSync(pathStr, true, relativePath));
        }
    }
    return out;
}

export async function readDirEntries(pathStr: string, recursive = false, prefix = ''): Promise<DirEntryWithParent[]> {
    const absDir = prefix ? join(pathStr, prefix) : pathStr;
    const dirHandle = await asfs.readDir(absDir);
    const entries: DirEntryWithParent[] = [];
    try {
        for await (const entry of dirHandle) {
            const relativePath = prefix ? join(prefix, entry.name) : entry.name;
            entries.push({
                name: entry.name,
                relativePath,
                parentPath: absDir,
                isFile: entry.isFile,
                isDirectory: entry.isDirectory,
                isSymbolicLink: entry.isSymbolicLink,
                isBlockDevice: entry.isBlockDevice,
                isCharacterDevice: entry.isCharacterDevice,
                isFIFO: entry.isFIFO,
                isSocket: entry.isSocket,
            });
            if (recursive && entry.isDirectory && !entry.isSymbolicLink) {
                entries.push(...await readDirEntries(pathStr, true, relativePath));
            }
        }
    } finally {
        await dirHandle.close();
    }
    return entries;
}

export class Dir {
    path: string;
    private entries: CModuleFS.DirEnt[];
    private index = 0;
    private closed = false;

    constructor(path: PathLike) {
        const pathStr = pathToString(path);
        this.path = pathStr;
        this.entries = fs.readdir(pathStr, true);
    }

    read(callback: (err: NodeJS.ErrnoException | null, dirent: import('fs').Dirent | null) => void): void;
    read(): Promise<import('fs').Dirent | null>;
    read(callback?: (err: NodeJS.ErrnoException | null, dirent: import('fs').Dirent | null) => void): Promise<import('fs').Dirent | null> | void {
        if (callback) {
            let entry: import('fs').Dirent | null;
            try {
                entry = this.readSync();
            } catch (err) {
                callback(errorFromUnknown(err), null);
                return;
            }
            callback(null, entry);
            return;
        }
        return Promise.resolve(this.readSync());
    }

    readSync(): import('fs').Dirent | null {
        if (this.closed || this.index >= this.entries.length) return null;
        const entry = this.entries[this.index++];
        if (entry === undefined) return null;
        return toNodeDirent(entry.name, entry, this.path);
    }

    close(callback: (err: NodeJS.ErrnoException | null) => void): void;
    close(): Promise<void>;
    close(callback?: (err: NodeJS.ErrnoException | null) => void): Promise<void> | void {
        if (callback) {
            this.closeSync();
            callback(null);
            return;
        }
        this.closeSync();
        return Promise.resolve();
    }

    closeSync(): void {
        this.closed = true;
        this.entries = [];
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<import('fs').Dirent> {
        const dir = this;
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
    }
}

// Flag parsing

export function parseFlags(flag?: string | number): Exclude<CModuleFS.OpenFlags, number> {
    if (typeof flag === 'number') {
        const append = Boolean(flag & fs.OPEN_APPEND);
        const create = Boolean(flag & fs.OPEN_CREAT);
        const exclusive = Boolean(flag & fs.OPEN_EXCL);
        const truncate = Boolean(flag & fs.OPEN_TRUNC);
        const readWrite = Boolean(flag & fs.OPEN_RDWR);

        if (append) {
            if (exclusive) return readWrite ? 'ax+' : 'ax';
            return readWrite ? 'a+' : 'a';
        }
        if (create || truncate) {
            if (exclusive) return readWrite ? 'wx+' : 'wx';
            return readWrite ? 'w+' : 'w';
        }
        if (flag & fs.OPEN_RDWR) return 'r+';
        if (flag & fs.OPEN_WRONLY) return 'w';
        return 'r';
    }
    // flag is string | undefined here (number branch handled above)
    return (flag || 'r') as Exclude<CModuleFS.OpenFlags, number>;
}

// Path handling

export function pathToString(path: string | URL | Uint8Array): string {
    if (typeof path === 'string') return path;
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
    return String(path);
}

export function splitPathOrFd(path: PathLike | number): { fd: number } | { path: string } {
    if (typeof path === 'number') return { fd: path };
    return { path: pathToString(path) };
}

export function describeFd(fd: number): string {
    return `fd:${fd}`;
}

// Recursive deletion — use lstat so symlink-to-dir unlinks the link only.

export function removeRecursiveSync(targetPath: string): void {
    const stats = fs.lstat(targetPath);

    if (stats.isDirectory && !stats.isSymbolicLink) {
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
    } else {
        await asfs.unlink(targetPath);
    }
}

// Recursive directory creation

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

function enotdirError(current: string): NodeJS.ErrnoException {
    const err = new Error(`ENOTDIR: not a directory, mkdir '${current}'`) as NodeJS.ErrnoException;
    err.code = 'ENOTDIR';
    err.syscall = 'mkdir';
    err.path = current;
    return err;
}

/** True when path exists as a directory after a failed mkdir (race / already there). */
function isExistingDirSync(current: string): boolean {
    try {
        return fs.stat(current).isDirectory;
    } catch {
        return false;
    }
}

async function isExistingDir(current: string): Promise<boolean> {
    try {
        return (await asfs.stat(current)).isDirectory;
    } catch {
        return false;
    }
}

/**
 * Create path recursively. Returns the first directory actually created
 * (Node.js mkdir recursive), or undefined when every segment already existed.
 */
export function mkdirRecursiveSync(pathStr: string, mode?: number): string | undefined {
    const { root, parts } = splitMkdirPath(pathStr);
    let current = root;
    let firstCreated: string | undefined;

    for (const part of parts) {
        current = appendPathPart(current, part);
        if (fs.exists(current)) {
            if (!fs.stat(current).isDirectory) throw enotdirError(current);
            continue;
        }
        try {
            fs.mkdir(current, mode);
            if (firstCreated === undefined) firstCreated = current;
        } catch (e) {
            // Concurrent create: ok only if the path is now a directory.
            if (!isExistingDirSync(current)) throw e;
        }
    }
    return firstCreated;
}

export async function mkdirRecursive(pathStr: string, mode?: number): Promise<string | undefined> {
    const { root, parts } = splitMkdirPath(pathStr);
    let current = root;
    let firstCreated: string | undefined;

    for (const part of parts) {
        current = appendPathPart(current, part);
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
            if (!(await isExistingDir(current))) throw e;
        }
    }
    return firstCreated;
}

export function createFileHandle(fd: number, handle: CModuleAsyncFS.FileHandle) {
    let closed = false;

    async function ensureOpen(): Promise<void> {
        if (closed) throw new Error('File handle is closed');
    }

    async function writeAll(data: Uint8Array<ArrayBuffer>, position?: number | null): Promise<number> {
        let total = 0;
        let currentPosition = position;
        while (total < data.length) {
            const chunk = data.subarray(total);
            const written = currentPosition == null
                ? await handle.write(chunk)
                : await handle.write(chunk, currentPosition);
            if (written <= 0) break;
            total += written;
            if (currentPosition != null) currentPosition += written;
        }
        return total;
    }

    return {
        fd,
        async read(buffer: Uint8Array<ArrayBuffer>, offset?: number, length?: number, position?: number | null) {
            await ensureOpen();
            const o = offset ?? 0, l = length ?? buffer.length;
            // native read() treats explicit null as offset 0, not "current offset" — omit the arg instead
            const bytesRead = position == null
                ? await handle.read(buffer.subarray(o, o + l))
                : await handle.read(buffer.subarray(o, o + l), position);
            return { bytesRead, buffer };
        },
        async write(buffer: Uint8Array | string, offsetOrPosition?: number | null, lengthOrEncoding?: number | BufferEncoding, position?: number | null) {
            await ensureOpen();
            const isString = typeof buffer === 'string';
            const encoding = isString && typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined;
            const data = isString ? toUint8Array(buffer, encoding) : buffer;
            const o = isString ? 0 : offsetOrPosition ?? 0;
            const l = isString ? data.length : typeof lengthOrEncoding === 'number' ? lengthOrEncoding : data.length;
            const actualPosition = isString ? offsetOrPosition : position;
            const bytes = arrayBufferBackedBytes(data.subarray(o, o + l));
            const bytesWritten = actualPosition == null
                ? await handle.write(bytes)
                : await handle.write(bytes, actualPosition);
            return { bytesWritten, buffer: isString ? buffer : data };
        },
        async close() {
            if (closed) return;
            closed = true;
            await handle.close();
        },
        async stat(ops?: StatFsOptions) {
            await ensureOpen();
            if (ops?.bigint) throw new Error('bigint option is not supported');
            return toNodeStat(await handle.stat());
        },
        async sync() { await ensureOpen(); await handle.sync(); },
        async datasync() { await ensureOpen(); await handle.datasync(); },
        async truncate(len?: number) { await ensureOpen(); await handle.truncate(len ?? 0); },
        async chmod(mode: Mode) { await ensureOpen(); await handle.chmod(modeToNumber(mode)); },
        async chown(uid: number, gid: number) { await ensureOpen(); await handle.chown(uid, gid); },
        async utimes(atime: TimeLike, mtime: TimeLike) {
            await ensureOpen();
            await handle.utime(timeToNumber(atime), timeToNumber(mtime));
        },
        async appendFile(data: string | Uint8Array | ArrayBuffer) {
            await ensureOpen();
            await handle.write(toUint8Array(data));
        },
        async readFile(options?: { encoding?: BufferEncoding | null } | BufferEncoding) {
            await ensureOpen();
            const st = await handle.stat();
            const buf = new Uint8Array(st.size);
            let off = 0;
            while (off < st.size) {
                const n = await handle.read(buf.subarray(off));
                if (n === 0) break;
                off += n;
            }
            return decodeBuffer(buf, typeof options === 'string' ? options : options?.encoding);
        },
        async writeFile(data: string | Uint8Array | ArrayBuffer) {
            await ensureOpen();
            await writeAll(toUint8Array(data));
        },
        async writev(buffers: readonly Uint8Array[], position?: number | null) {
            await ensureOpen();
            let bytesWritten = 0;
            let currentPosition = position;
            for (const buffer of buffers) {
                const chunk = buffer instanceof Uint8Array
                    ? buffer
                    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                const written = await writeAll(arrayBufferBackedBytes(chunk), currentPosition);
                bytesWritten += written;
                if (currentPosition != null) currentPosition += written;
            }
            return { bytesWritten, buffers };
        },
        [Symbol.asyncDispose]() { return closed ? Promise.resolve() : this.close(); },
    };
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
): import('fs').Dir {
    let closed = false;

    const dir: import('fs').Dir = {
        path: pathStr,

        async read(): Promise<import('fs').Dirent | null> {
            if (closed) return null;
            const result = await dirHandle.next();
            if (result.done) return null;
            return toNodeDirentAsync(result.value, pathStr);
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
