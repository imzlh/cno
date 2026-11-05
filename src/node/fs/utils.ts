/**
 * fs module internal utility functions
 */

import path from '../path';
const { dirname, join } = path;
import { fileURLToPath } from '../url';
import { Buffer } from '../buffer';
import { arrayBufferBackedBytes, base64ToBytes, concatChunks, hexToBytes } from '../_internal/buffer';
import { withCode } from '../_internal/errors';
import { toErrnoException } from '../_internal/errno';
import { wrapSync } from './errno-fix';

import { nsfs, nsasfs, sysPath } from './syspath';
export const fs = nsfs;
export const engine = import.meta.use('engine');
export const asfs = nsasfs;
export const nativeCrypto = import.meta.use('crypto');
const algorithm = import.meta.use('algorithm');
export const text = import.meta.use('text');
const nativeError = import.meta.use('error');

// Shared type definitions (used across _promises.ts, callbacks.ts, sync.ts, async.ts)

export type PathLike = string | URL | Buffer;
export type TimeLike = string | number | Date;
export type Mode = number | string;
export interface StatFsOptions { bigint?: boolean; }

export function modeToNumber(mode: Mode): number;
export function modeToNumber(mode?: Mode): number | undefined;
export function modeToNumber(mode?: Mode): number | undefined {
    if (typeof mode === 'string') {
        return parseInt(mode, 8);
    }
    return mode;
}

/** Every accepted form collapses to seconds; a Date contributes ms/1000. */
export function timeToUnixSeconds(time: TimeLike, _name = 'time'): number {
    if (typeof time === 'string' && String(Number(time)) === time.trim() && time.trim() !== '') {
        return Number(time);
    }
    if (typeof time === 'number' && Number.isFinite(time)) {
        // Node maps a negative timestamp to "now".
        return time < 0 ? Date.now() / 1000 : time;
    }
    if (time instanceof Date) {
        const ms = time.getTime();
        if (Number.isFinite(ms)) return ms / 1000;
    }
    // Node uses the literal name "time" here regardless of the parameter.
    throw withCode(new TypeError('The "time" argument must be an instance of Date or an Time in seconds.'), 'ERR_INVALID_ARG_TYPE');
}

/** Milliseconds, for the asyncfs `utime`/`lutime`/`FileHandle.utime` bindings. */
export function timeToUnixMs(time: TimeLike, name = 'time'): number {
    return timeToUnixSeconds(time, name) * 1000;
}

export function errorFromUnknown(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function errorCode(error: unknown): unknown {
    return error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
}

export function rmIsDirectoryError(path: string): NodeJS.ErrnoException {
    const error = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${path}`) as NodeJS.ErrnoException;
    error.code = 'ERR_FS_EISDIR';
    error.errno = 21;
    error.syscall = 'rm';
    error.path = path;
    return error;
}

export function dirClosedError(): NodeJS.ErrnoException {
    const error = new Error('Directory handle was closed') as NodeJS.ErrnoException;
    error.code = 'ERR_DIR_CLOSED';
    return error;
}

/** write(2) may be partial; Node's writeFile/appendFile write every byte. */
export function writeAllSync(fd: number, bytes: Uint8Array): void {
    let written = 0;
    while (written < bytes.length) {
        const n = fs.write(fd, bytes.subarray(written));
        if (n <= 0) break;
        written += n;
    }
}

/** Async counterpart of writeAllSync for asyncfs file handles. */
export async function writeAllHandle(
    handle: CModuleAsyncFS.FileHandle,
    bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
    let written = 0;
    while (written < bytes.length) {
        const n = await handle.write(bytes.subarray(written));
        if (n <= 0) break;
        written += n;
    }
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
                return arrayBufferBackedBytes(new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength));
            }
            case 'latin1':
            case 'binary':
                return arrayBufferBackedBytes(algorithm.latin1EncodeLoose(data));
            case 'ascii':
                return arrayBufferBackedBytes(algorithm.asciiEncodeLoose(data));
            case 'hex':
                return arrayBufferBackedBytes(hexToBytes(data));
            case 'base64':
            case 'base64url':
                return arrayBufferBackedBytes(base64ToBytes(data));
            default:
                return arrayBufferBackedBytes(new text.Encoder(encoding ?? 'utf8').encode(data));
        }
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    // Reject anything that is not a string, ArrayBuffer or view: a zero-length fallback
    // would silently truncate the target to an empty file.
    if (!ArrayBuffer.isView(data)) {
        throw Object.assign(
            new TypeError(
                'The "data" argument must be of type string or an instance of '
                + `Buffer, TypedArray, or DataView. Received ${inspectArgType(data)}`,
            ),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    return arrayBufferBackedBytes(data);
}

/** Node-style "Received ..." fragment for an ERR_INVALID_ARG_TYPE message. */
function inspectArgType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const t = typeof value;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return `type ${t} (${String(value)})`;
    if (t === 'symbol' || t === 'function') return `type ${t}`;
    const name = (value as object).constructor?.name;
    return name ? `an instance of ${name}` : 'type object';
}

/** Raw bytes over the view's own window; `new Uint8Array(dataView)` would be length 0. */
export function byteViewOf(buffer: ArrayBufferView | ArrayBuffer): Uint8Array {
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (!ArrayBuffer.isView(buffer)) {
        throw new TypeError('The "buffer" argument must be an instance of Buffer, TypedArray, or DataView.');
    }
    return buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** Node's read/write `(buffer[, offset[, length[, position]]])` and `(buffer, options)` forms. */
export function normalizeRwArgs(
    buffer: ArrayBufferView | ArrayBuffer,
    offsetOrOptions?: unknown,
    length?: unknown,
    position?: unknown,
): { bytes: Uint8Array; window: Uint8Array; position: number | null } {
    const bytes = byteViewOf(buffer);
    let off: unknown = offsetOrOptions, len: unknown = length, pos: unknown = position;
    if (offsetOrOptions !== null && typeof offsetOrOptions === 'object') {
        const o = offsetOrOptions as { offset?: unknown; length?: unknown; position?: unknown };
        off = o.offset; len = o.length; pos = o.position;
    }
    // Node resets BOTH offset and length when offset is not an integer (incl. null),
    // so `writeSync(fd, buf, null, 4)` writes the whole buffer, not 4 bytes.
    let start = 0, count = bytes.byteLength;
    if (typeof off === 'number' && Number.isInteger(off)) {
        start = off;
        count = len === null || len === undefined ? bytes.byteLength - start : Number(len);
    }
    return {
        bytes,
        window: bytes.subarray(start, start + count),
        position: pos === null || pos === undefined ? null : Number(pos),
    };
}

export function decodeBuffer(buffer: Uint8Array<ArrayBuffer>, encoding: BufferEncoding): string;
export function decodeBuffer(buffer: Uint8Array<ArrayBuffer>, encoding?: 'buffer' | null): Buffer;
export function decodeBuffer(buffer: Uint8Array<ArrayBuffer>, encoding?: BufferEncoding | 'buffer' | null): string | Buffer;
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
    options?: { encoding?: BufferEncoding | 'buffer' | null } | BufferEncoding | 'buffer',
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

export function validateEncodingOption(encoding: unknown): void {
    if (encoding === undefined || encoding === null) return;
    if (typeof encoding !== 'string' || !VALID_ENCODINGS.has(encoding.toLowerCase())) {
        throw withCode(
            new TypeError(`The argument '${String(encoding)}' is invalid encoding. Received 'encoding'`),
            'ERR_INVALID_ARG_VALUE',
        );
    }
}

/** `validateRecursive` opt-in: only readdirSync and callback readdir reject a non-boolean. */
export function validateReaddirOptions(options: unknown, validateRecursive = false): void {
    if (options === undefined || options === null) return;
    if (typeof options === 'string') {
        validateEncodingOption(options);
        return;
    }
    if (typeof options !== 'object') throw new TypeError('The "options" argument must be of type string or object');
    validateEncodingOption(Reflect.get(options, 'encoding'));
    if (!validateRecursive) return;
    const recursive = Reflect.get(options, 'recursive');
    if (recursive === undefined || recursive === null || typeof recursive === 'boolean') return;
    throw withCode(
        new TypeError(`The "options.recursive" property must be of type boolean. Received ${describeArg(recursive)}`),
        'ERR_INVALID_ARG_TYPE',
    );
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

/** Node's inspect-ish rendering of a rejected value for its arg-type messages. */
function describeArg(v: unknown): string {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'string') return `type string ('${v as string}')`;
    if (t === 'object') return `an instance of ${(v as object)?.constructor?.name ?? 'Object'}`;
    if (t === 'function') return 'function';
    return `type ${t} (${String(v)})`;
}

/**
 * Without this a bogus fd reaches the CRT, whose `_VALIDATE_*` assertion writes to stderr,
 * and `fstatSync(undefined)` / `writeSync(1.5)` succeed instead of throwing.
 */
export function validateFd(fd: number): void {
    if (typeof fd !== 'number') {
        throw withCode(new TypeError(`The "fd" argument must be of type number. Received ${describeArg(fd)}`), 'ERR_INVALID_ARG_TYPE');
    }
    if (!Number.isInteger(fd)) {
        throw withCode(
            new RangeError(`The value of "fd" is out of range. It must be an integer. Received ${String(fd)}`),
            'ERR_OUT_OF_RANGE',
        );
    }
    if (fd < 0 || fd > 0x7fffffff) {
        throw withCode(
            new RangeError(`The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received ${String(fd)}`),
            'ERR_OUT_OF_RANGE',
        );
    }
}

/** Node's own AbortError shape (`code` 'ABORT_ERR', reason on `.cause`), not the DOMException. */
class AbortError extends Error {
    code = 'ABORT_ERR';
    constructor(cause?: unknown) {
        super('The operation was aborted');
        this.name = 'AbortError';
        if (cause !== undefined) Reflect.set(this, 'cause', cause);
    }
}

export function makeAbortError(signal: AbortSignal): NodeJS.ErrnoException & AbortError {
    return new AbortError(signal.reason);
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
    // UV errno values are platform-local — never hardcode (Windows differs).
    err.errno = nativeError.errno.EEXIST;
    err.syscall = 'copyfile';
    err.path = src;
    err.dest = dest;
    throw err;
}

// Stats conversion

type StatValue = number | bigint;

/** POSIX file-type mask; the host may not export S_IFMT on CModuleFS. */
const S_IFMT_BITS = fs.S_IFMT ?? 0o170000;

type NativeStats = CModuleFS.Stats | CModuleAsyncFS.StatResult;

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
    // declare: no runtime field emitted, so the constructor's non-enumerable
    // defineProperty is not clobbered by a class-field definition.
    private declare readonly stat: Partial<CModuleFS.Stats>;
    private declare readonly rawMode: number;

    constructor(stat?: NativeStats, bigint = false) {
        const statInfo: Partial<CModuleFS.Stats> = stat ?? {};
        const convert = bigint ? (value: number) => BigInt(value) : (value: number) => value;
        // Node never exposes internals as own enumerable keys (Object.keys/spread).
        Object.defineProperty(this, 'stat', { value: statInfo, enumerable: false });
        Object.defineProperty(this, 'rawMode', { value: statInfo.mode ?? 0, enumerable: false });
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

    // asyncfs stats carry no is* booleans, so fall back to mode bits like Node.
    private isType(flag: boolean | undefined, ifmt: number): boolean {
        if (flag !== undefined) return flag === true;
        return this.rawMode !== 0 && (this.rawMode & S_IFMT_BITS) === ifmt;
    }

    isFile(): boolean { return this.isType(this.stat.isFile, 0o100000); }
    isDirectory(): boolean { return this.isType(this.stat.isDirectory, 0o040000); }
    isBlockDevice(): boolean { return this.isType(this.stat.isBlockDevice, 0o060000); }
    isCharacterDevice(): boolean { return this.isType(this.stat.isCharacterDevice, 0o020000); }
    isSymbolicLink(): boolean { return this.isType(this.stat.isSymbolicLink, 0o120000); }
    isFIFO(): boolean { return this.isType(this.stat.isFIFO, 0o010000); }
    isSocket(): boolean { return this.isType(this.stat.isSocket, 0o140000); }
}

/** Node returns a distinct BigIntStats class carrying extra *Ns fields. */
export class BigIntStats extends Stats {
    atimeNs: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    birthtimeNs: bigint;

    constructor(stat?: NativeStats) {
        super(stat, true);
        // Native stats are Date-backed (ms), so ns is ms scaled — not OS-exact.
        const ns = (v: StatValue) => BigInt(v as bigint) * 1000000n;
        this.atimeNs = ns(this.atimeMs);
        this.mtimeNs = ns(this.mtimeMs);
        this.ctimeNs = ns(this.ctimeMs);
        this.birthtimeNs = ns(this.birthtimeMs);
    }
}

export function toNodeStat(stat: NativeStats, options?: { bigint?: boolean }): Stats {
    return options?.bigint === true ? new BigIntStats(stat) : new Stats(stat);
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

export type StatsFs = StatFs;

export function toNodeStatFs(stat: StatFsInput, options?: StatFsOptions): StatsFs {
    return new StatFs(stat, options?.bigint === true) as StatsFs;
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

type DirentInfo = Pick<DirEntryWithParent,
    'isFile' | 'isDirectory' | 'isSymbolicLink' | 'isBlockDevice' |
    'isCharacterDevice' | 'isFIFO' | 'isSocket'>;

function direntType(info: DirentInfo): number {
    if (info.isFile) return 1;
    if (info.isDirectory) return 2;
    if (info.isSymbolicLink) return 3;
    if (info.isFIFO) return 4;
    if (info.isSocket) return 5;
    if (info.isCharacterDevice) return 6;
    if (info.isBlockDevice) return 7;
    return 0;
}

export class Dirent<Name extends string | Buffer = string> {
    readonly name: Name;
    readonly parentPath: string;
    readonly #type: number;

    constructor(name: Name, type: number, parentPath: string) {
        this.name = name;
        this.#type = type;
        this.parentPath = parentPath;
    }

    isFile(): boolean { return this.#type === 1; }
    isDirectory(): boolean { return this.#type === 2; }
    isSymbolicLink(): boolean { return this.#type === 3; }
    isFIFO(): boolean { return this.#type === 4; }
    isSocket(): boolean { return this.#type === 5; }
    isCharacterDevice(): boolean { return this.#type === 6; }
    isBlockDevice(): boolean { return this.#type === 7; }
}

export function toNodeDirent<Name extends string | Buffer>(
    name: Name,
    stat: Pick<CModuleFS.Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'isBlockDevice' | 'isCharacterDevice' | 'isFIFO' | 'isSocket'>
        | Pick<CModuleFS.DirEnt, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'isBlockDevice' | 'isCharacterDevice' | 'isFIFO' | 'isSocket'>
        | DirEntryWithParent,
    parentPath: string,
): Dirent<Name> {
    return new Dirent(name, direntType(stat), parentPath);
}

export function toNodeDirentAsync(
    ent: CModuleAsyncFS.DirEnt | CModuleAsyncFS.StatResult | DirEntryWithParent,
    parentPath: string,
): Dirent<string>;
export function toNodeDirentAsync<Name extends string | Buffer>(
    ent: CModuleAsyncFS.DirEnt | CModuleAsyncFS.StatResult | DirEntryWithParent,
    parentPath: string,
    name: Name,
): Dirent<Name>;
export function toNodeDirentAsync(
    ent: CModuleAsyncFS.DirEnt | CModuleAsyncFS.StatResult | DirEntryWithParent,
    parentPath: string,
    name?: string | Buffer,
): Dirent<string | Buffer> {
    const entryName = name ?? ('name' in ent ? ent.name : '');
    return new Dirent(entryName, direntType(ent), parentPath);
}

/** Walk gate for a recursive listing; both must exist because they disagree (docs/node-internals.md#fs-walk-gates). */
export type LinkWalkPolicy = 'follow' | 'strict';

/** A dirent whose type the platform did not report (POSIX `DT_UNKNOWN`). */
function direntTypeUnknown(entry: DirentInfo): boolean {
    return !entry.isFile && !entry.isDirectory && !entry.isSymbolicLink &&
        entry.isBlockDevice !== true && entry.isCharacterDevice !== true &&
        entry.isFIFO !== true && entry.isSocket !== true;
}

/**
 * Does the `'follow'` gate need to resolve this entry to classify it?
 * Real directories and real files are already decided by the dirent, for free.
 */
export function needsResolve(entry: DirentInfo): boolean {
    return entry.isSymbolicLink || direntTypeUnknown(entry);
}

/** A resolve failure means "not a directory", never an abort (broken links are listed, not descended). */
export function isDirectorySync(absPath: string): boolean {
    try {
        return fs.stat(absPath).isDirectory;
    } catch {
        return false;
    }
}

export async function isDirectory(absPath: string): Promise<boolean> {
    try {
        return (await asfs.stat(absPath)).isDirectory;
    } catch {
        return false;
    }
}

export function toWalkEntry(
    entry: Pick<CModuleFS.DirEnt, 'name' | 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'isBlockDevice' | 'isCharacterDevice' | 'isFIFO' | 'isSocket'>,
    relativePath: string,
    parentPath: string,
): DirEntryWithParent {
    return {
        name: entry.name,
        relativePath,
        parentPath,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymbolicLink,
        isBlockDevice: entry.isBlockDevice,
        isCharacterDevice: entry.isCharacterDevice,
        isFIFO: entry.isFIFO,
        isSocket: entry.isSocket,
    };
}

/**
 * Fast path: `join` normalizes, which is wasted work for the plain ASCII names a directory
 * listing yields; anything else takes the real `join` so every normalisation rule still applies.
 */
export function joinWalk(dir: string, name: string): string {
    const len = name.length;
    if (len === 0 || dir.length === 0) return join(dir, name);
    for (let i = 0; i < len; i++) {
        const code = name.charCodeAt(i);
        if (code < 32 || code > 126 || code === 47 || code === 92 || code === 46 || code === 58) {
            return join(dir, name);
        }
    }
    // The walk feeds each directory through the same namespacing as any other
    // fs path argument, so `dir` is never re-resolved here — only the leaf is
    // appended. A flat level starts from the caller's string (prepareWalkRoot
    // did the URL/leading-slash work once) and is passed to the binding
    // pre-namespaced, so the syscall wrapper's per-level `resolve` is skipped.
    const last = dir.charCodeAt(dir.length - 1);
    if (last === 47 || (isWindows && last === 92)) return dir + name;
    return isWindows ? `${dir}\\${name}` : `${dir}/${name}`;
}
export let walkNeedsSysDir = false;
const isWindows = process.platform === 'win32';

/** `pathToString` has no observable effect here; only its two rewrites matter. */
export function prepareWalkRoot(pathStr: string): string {
    if (isWindows) {
        if (/^file:\/\//i.test(pathStr)) return join(fileURLToPath(pathStr), '.');
        if (/^\/[A-Za-z]{1,2}:[\\/]/.test(pathStr)) return sysPath(pathStr.slice(1));
        return pathStr;
    }
    return /^file:\/\//i.test(pathStr) ? join(fileURLToPath(pathStr), '.') : pathStr;
}

export function walkReadDir(dir: string): CModuleFS.DirEnt[] {
    return walkNeedsSysDir || dir.startsWith('\\\\') ? fs.readdir(dir, true) : fs.readdir(sysPath(dir), true);
}

/**
 * Breadth-first: Node's recursive readdir emits every entry of a level before the next,
 * so a depth-first walk would reorder results.
 */
export * from './utils-dir';
