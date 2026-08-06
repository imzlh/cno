/**
 * fs module internal utility functions
 */

import type { StatFsOptions } from 'fs';
import path from '../path';
const { dirname, join } = path;
import { fileURLToPath } from '../url';
import { Buffer } from '../buffer';
import { arrayBufferBackedBytes, concatChunks } from '../_internal/buffer';
import { toErrnoException } from '../_internal/errno';
import { wrapSync } from './errno-fix';

import { nsfs, nsasfs, sysPath } from './syspath';
const fs = nsfs;
const engine = import.meta.use('engine');
const asfs = nsasfs;
const nativeCrypto = import.meta.use('crypto');
const algorithm = import.meta.use('algorithm');
const text = import.meta.use('text');
const nativeError = import.meta.use('error');

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

/**
 * Node's `toUnixTimestamp`: every accepted form collapses to **seconds**.
 * A bare number is already seconds (`fs.utimesSync(p, 1614834367, ...)` means
 * 2021-03-04), a numeric string is seconds, and a Date contributes ms/1000.
 *
 * The previous version returned ms for a Date but the raw value for a number,
 * so callers that divided by 1000 turned 1614834367 *seconds* into 1614834
 * seconds and stamped every numeric utimes/futimes/lutimes call with 1970.
 */
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
    const e = new TypeError('The "time" argument must be an instance of Date or an Time in seconds.');
    Reflect.set(e, 'code', 'ERR_INVALID_ARG_TYPE');
    throw e;
}

/** Milliseconds, for the asyncfs `utime`/`lutime`/`FileHandle.utime` bindings. */
export function timeToUnixMs(time: TimeLike, name = 'time'): number {
    return timeToUnixSeconds(time, name) * 1000;
}

export function errorFromUnknown(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function rmIsDirectoryError(path: string): NodeJS.ErrnoException {
    const error = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${path}`) as NodeJS.ErrnoException;
    error.code = 'ERR_FS_EISDIR';
    error.errno = 21;
    error.syscall = 'rm';
    error.path = path;
    return error;
}

function dirClosedError(): NodeJS.ErrnoException {
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
        const n = await handle.write(arrayBufferBackedBytes(bytes.subarray(written)));
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
    // Anything that is not a string, ArrayBuffer or ArrayBufferView used to fall
    // through to a zero-length view, so `writeFile(path, 42)` or
    // `writeFile(path, {})` silently truncated the target to an empty file and
    // reported success. Node rejects these with ERR_INVALID_ARG_TYPE and leaves
    // the file alone.
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

/**
 * Node accepts any `ArrayBufferView` (incl. DataView / non-Uint8Array TypedArray)
 * as an fd read/write buffer, and treats it as raw bytes over its own window.
 * `new Uint8Array(dataView)` yields length 0 (DataView has no `.length`) and
 * `dataView.subarray` does not exist, so normalise on the exact window instead.
 */
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

export function validateEncodingOption(encoding: unknown): void {
    if (encoding === undefined || encoding === null) return;
    if (typeof encoding !== 'string' || !VALID_ENCODINGS.has(encoding.toLowerCase())) {
        const error = new TypeError(`The argument '${String(encoding)}' is invalid encoding. Received 'encoding'`);
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_VALUE');
        throw error;
    }
}

/**
 * `validateRecursive` is opt-in because Node only rejects a non-boolean
 * `recursive` on `readdirSync` and callback `readdir` (both throw
 * ERR_INVALID_ARG_TYPE, the callback form synchronously). `fsp.readdir` and
 * every `opendir` form skip the check entirely and just coerce — measured, so
 * `{recursive:'yes'}` really does walk there.
 */
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
    const e = new TypeError(
        `The "options.recursive" property must be of type boolean. Received ${describeArg(recursive)}`,
    );
    Reflect.set(e, 'code', 'ERR_INVALID_ARG_TYPE');
    throw e;
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
 * Node's `validateInt32(fd, 'fd', 0, 2147483647)`, message-for-message.
 *
 * This is load-bearing beyond argument hygiene: without it a bogus fd reaches
 * the CRT, and UCRT's lowio `_VALIDATE_*` macros print
 * `... Assertion failed: (fh >= 0 && (unsigned)fh < (unsigned)_nhandle)` to
 * stderr — measured 4071 bytes on one probe sweep where Node writes 0. It is
 * also a correctness fix: before this, `fstatSync(undefined)` / `(NaN)` /
 * `({})` all *succeeded* (coerced to fd 0) and `writeSync(1.5)` wrote to
 * stdout, where Node throws. Range-checking here cannot cover an in-range but
 * unopened fd (9999); that still reaches the CRT and needs the C-side
 * `_set_invalid_parameter_handler` that libuv installs.
 */
export function validateFd(fd: number): void {
    if (typeof fd !== 'number') {
        const e = new TypeError(`The "fd" argument must be of type number. Received ${describeArg(fd)}`);
        Reflect.set(e, 'code', 'ERR_INVALID_ARG_TYPE');
        throw e;
    }
    if (!Number.isInteger(fd)) {
        const e = new RangeError(`The value of "fd" is out of range. It must be an integer. Received ${String(fd)}`);
        Reflect.set(e, 'code', 'ERR_OUT_OF_RANGE');
        throw e;
    }
    if (fd < 0 || fd > 0x7fffffff) {
        const e = new RangeError(`The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received ${String(fd)}`);
        Reflect.set(e, 'code', 'ERR_OUT_OF_RANGE');
        throw e;
    }
}

/**
 * Node rejects aborted fs operations with its own `AbortError` class, not with
 * `signal.reason`. Measured v24.18.0 for `fsp.readFile(p, { signal })`:
 * `ctor=AbortError name=AbortError code='ABORT_ERR' isDOMException=false`, and
 * the reason is on `.cause` — even a custom `abort(new Error(...))` reason is
 * *not* passed through (`err === reason` is false).
 *
 * Returning `reason` verbatim handed back the platform DOMException, whose
 * `code` is the number 20, so no `err.code === 'ABORT_ERR'` check could match.
 */
class AbortError extends Error {
    constructor(cause?: unknown) {
        super('The operation was aborted');
        this.name = 'AbortError';
        Reflect.set(this, 'code', 'ABORT_ERR');
        if (cause !== undefined) Reflect.set(this, 'cause', cause);
    }
}

export function makeAbortError(signal: AbortSignal): NodeJS.ErrnoException {
    return new AbortError(signal.reason) as NodeJS.ErrnoException;
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

type NativeStats = CModuleFS.Stats | CModuleAsyncFS.Stats;

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

export function toNodeStat(stat: NativeStats, options?: { bigint?: boolean }): import('fs').Stats {
    if (options?.bigint === true) return new BigIntStats(stat) as unknown as import('fs').Stats;
    return new Stats(stat) as import('fs').Stats;
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

/**
 * How a recursive walk decides whether to descend into a directory entry.
 *
 * Node uses two different gates and they disagree, so both are needed
 * (all figures measured against real node v24.18.0 on Windows):
 *
 * - `'follow'` — descend when the entry *resolves* to a directory. Reparse
 *   points (junctions AND directory symlinks) are therefore walked. Used by
 *   `readdirSync`, callback `readdir` (both with and without `withFileTypes`)
 *   and `fsp.readdir` without `withFileTypes`.
 * - `'strict'` — descend only when the dirent itself is typed as a directory,
 *   so no reparse point is ever walked. Used by `fsp.readdir` *with*
 *   `withFileTypes` and by every `opendir` form.
 *
 * A junction and a directory symlink are indistinguishable at the dirent level
 * on Windows: `FILE_ATTRIBUTE_REPARSE_POINT` is tested before
 * `FILE_ATTRIBUTE_DIRECTORY`, so both are `UV_DIRENT_LINK`. libuv does exactly
 * the same (see deps/libuv/src/win/fs.c:1552 and :1738), and Node's own Dirent
 * reports `isDirectory()===false, isSymbolicLink()===true` for both. So the
 * dirent type cannot be the discriminator — the follow gate must stat.
 */
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
function needsResolve(entry: DirentInfo): boolean {
    return entry.isSymbolicLink || direntTypeUnknown(entry);
}

/**
 * A resolve failure means "not a directory", never an abort: Node lists broken
 * links without descending, and terminates a junction cycle when Windows
 * refuses the 65th reparse traversal with ELOOP (measured: 64 junctions
 * traversed regardless of path length, so the cap is the OS's, not a depth
 * limit of ours).
 */
function resolvesToDirSync(absPath: string): boolean {
    try {
        return fs.stat(absPath).isDirectory;
    } catch {
        return false;
    }
}

async function resolvesToDir(absPath: string): Promise<boolean> {
    try {
        return (await asfs.stat(absPath)).isDirectory;
    } catch {
        return false;
    }
}

function toWalkEntry(
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
 * Breadth-first, because Node's recursive `readdirSync` is: every entry of a
 * level is emitted before any entry of the next one (measured — a depth-first
 * walk reorders the result the moment a directory has more than one child).
 */
export function readDirEntriesSync(
    pathStr: string,
    recursive = false,
    prefix = '',
    policy: LinkWalkPolicy = 'follow',
): DirEntryWithParent[] {
    const out: DirEntryWithParent[] = [];
    const pending: string[] = [prefix];

    while (pending.length > 0) {
        const rel = pending.shift() as string;
        const absDir = rel ? join(pathStr, rel) : pathStr;
        for (const entry of fs.readdir(absDir, true)) {
            const relativePath = rel ? join(rel, entry.name) : entry.name;
            out.push(toWalkEntry(entry, relativePath, absDir));
            if (!recursive) continue;
            const descend = entry.isDirectory
                ? true
                : policy === 'follow' && needsResolve(entry) && resolvesToDirSync(join(absDir, entry.name));
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

    while (pending.length > 0) {
        const rel = pending.shift() as string;
        const absDir = rel ? join(pathStr, rel) : pathStr;

        // Drain and close the handle before any stat: the resolve step below is
        // its own round of I/O and must not straddle an open native dir handle.
        const level: DirEntryWithParent[] = [];
        const dirHandle = await asfs.readDir(absDir);
        try {
            for await (const entry of dirHandle) {
                const relativePath = rel ? join(rel, entry.name) : entry.name;
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
                : policy === 'follow' && needsResolve(entry) && await resolvesToDir(join(absDir, entry.name));
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
        // Wrap: the raw native error carries a numeric .code, but Node's is a string.
        // `opendir` uses the strict gate — it never walks a junction or a
        // directory symlink, unlike recursive `readdirSync` (measured).
        this.entries = wrapSync(
            () => readDirEntriesSync(pathStr, recursive, '', 'strict'),
            'opendir',
            pathStr,
        );
    }

    read(callback: (err: NodeJS.ErrnoException | null, dirent: import('fs').Dirent | null) => void): void;
    read(): Promise<import('fs').Dirent | null>;
    read(callback?: (err: NodeJS.ErrnoException | null, dirent: import('fs').Dirent | null) => void): Promise<import('fs').Dirent | null> | void {
        if (callback) {
            queueMicrotask(() => {
                let entry: import('fs').Dirent | null;
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

    readSync(): import('fs').Dirent | null {
        if (this.closed) throw dirClosedError();
        if (this.index >= this.entries.length) return null;
        const entry = this.entries[this.index++];
        if (entry === undefined) return null;
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

/**
 * The exact set of flag strings Node accepts, in every documented ordering.
 * Validation matters here because the native layer matches flag *characters*
 * rather than whole strings: an unvalidated `'rw'` contains a `w` and so opened
 * the file O_TRUNC, silently destroying its contents, where Node throws
 * ERR_INVALID_ARG_VALUE and leaves it intact.
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

/**
 * Error codes Node's rimraf retries on. Copied from `internal/fs/rimraf`'s
 * `retryErrorCodes` (verified against v24.18.0 via --expose-internals).
 */
const RETRY_ERROR_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

/**
 * Node's async recursive remove retries transient Windows failures with a
 * **linear** backoff — `delay = attempt * retryDelay` — up to `maxRetries`
 * (v24.18.0 `internal/fs/rimraf`:
 *     `const delay = retries * options.retryDelay;`
 *     `return setTimeout(_rimraf, delay, path, options, CB);`).
 *
 * Measured on v24.18.0 (Windows 11) with a blocker released by a child process
 * after 600ms: `fsp.rm(dir, {recursive:true, maxRetries:10, retryDelay:200})`
 * succeeded after 608ms, while the same call with the defaults threw at once.
 *
 * Deliberately **async-only**. Node's *sync* `rmSync` accepts the same options
 * and ignores them: v24 moved sync recursive removal into C++, and
 * `internal/fs/rimraf` exports only `rimraf`/`rimrafPromises` — no sync variant.
 * Measured: sync `rmSync` with `maxRetries:10, retryDelay:200` against the same
 * releasing blocker threw EPERM in 0ms. Adding retries to the sync path would
 * therefore be a divergence, not a fix.
 *
 * `fn` must already produce string `code`s (i.e. be wrapped), because the raw
 * asyncfs rejection carries only a numeric errno.
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
 *
 * Node namespaces the path before walking it, so the value it hands back is the
 * namespaced form (`\\?\D:\a\b`) — observed directly against v24.18.0. The
 * segments built below are plain (the binding namespaces each syscall on the
 * way in), so the return needs converting explicitly to match.
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
    return firstCreated === undefined ? undefined : sysPath(firstCreated);
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
    return firstCreated === undefined ? undefined : sysPath(firstCreated);
}

/**
 * Node's promises.open() resolves to a `FileHandle` instance; this returned a
 * bare object literal, so `handle.constructor.name` read 'Object' and any
 * `instanceof FileHandle` / duck-type-by-class check failed.
 */
class FileHandle {}

export function createFileHandle(fd: number, handle: CModuleAsyncFS.FileHandle) {
    let closed = false;

    async function ensureOpen(syscall: string): Promise<void> {
        if (!closed) return;
        // Node reports EBADF for any operation on a closed FileHandle (measured
        // v24.18.0: `code` 'EBADF', `errno` undefined). A bare Error left `code`
        // undefined, so no `err.code === 'EBADF'` check could ever match.
        // Node also tags it with the libuv syscall name, which was missing at all
        // 13 methods (measured: `syscall` undefined where Node says 'read',
        // 'write', 'fstat', 'fsync', 'fdatasync', 'ftruncate', 'fchmod', 'readv',
        // 'writev', 'futimes', 'readFile').
        const err = new Error('EBADF: bad file descriptor') as NodeJS.ErrnoException;
        err.code = 'EBADF';
        err.syscall = syscall;
        throw err;
    }

    /**
     * Convert a native handle rejection to Node's ErrnoException shape.
     *
     * The native handle rejects with the raw UV number as `code` — measured -4083
     * for a `write()` on a read-only handle — which is the dangerous shape: a
     * numeric `code` silently fails every `err.code === 'EBADF'` comparison. Only
     * `truncate()` was wrapped; the other native calls leaked the number through.
     *
     * The rejection is awaited directly rather than transformed with `.then()`:
     * `engine.waitIO()` drains the *native* promise handle and cannot see through
     * a derived chain, so returning a `.then()`-derived promise from here would
     * break callers that wait on it (this is what breaks `fs.watchFile`).
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
            const written = currentPosition == null
                ? await native('write', () => handle.write(chunk))
                : await native('write', () => handle.write(chunk, currentPosition as number));
            if (written <= 0) break;
            total += written;
            if (currentPosition != null) currentPosition += written;
        }
        return total;
    }

    return {
        fd,
        __proto__: FileHandle.prototype,
        async read(
            bufferOrOptions?: ArrayBufferView | { buffer?: ArrayBufferView; offset?: number; length?: number; position?: number | null },
            offset?: number,
            length?: number,
            position?: number | null,
        ) {
            await ensureOpen('read');
            // Node also accepts `read()` (fresh 16 KiB buffer) and `read({buffer,offset,length,position})`.
            let target: ArrayBufferView;
            let opts: unknown = offset, len: unknown = length, pos: unknown = position;
            if (bufferOrOptions === undefined || bufferOrOptions === null) {
                target = new Uint8Array(16384);
            } else if (ArrayBuffer.isView(bufferOrOptions)) {
                target = bufferOrOptions;
            } else {
                const o = bufferOrOptions;
                target = o.buffer ?? new Uint8Array(16384);
                opts = o.offset; len = o.length; pos = o.position;
            }
            const norm = normalizeRwArgs(target, opts, len, pos);
            const window = arrayBufferBackedBytes(norm.window);
            // native read() treats explicit null as offset 0, not "current offset" — omit the arg instead
            const result = norm.position == null
                ? await native('read', () => handle.read(window))
                : await native('read', () => handle.read(window, norm.position as number));
            return { bytesRead: result ?? 0, buffer: target };
        },
        async write(buffer: ArrayBufferView | string, offsetOrPosition?: unknown, lengthOrEncoding?: unknown, position?: number | null) {
            await ensureOpen('write');
            if (typeof buffer === 'string') {
                const encoding = typeof lengthOrEncoding === 'string' ? (lengthOrEncoding as BufferEncoding) : undefined;
                const data = toUint8Array(buffer, encoding);
                const at = offsetOrPosition === null || offsetOrPosition === undefined ? null : Number(offsetOrPosition);
                const bytesWritten = at == null
                    ? await native('write', () => handle.write(data))
                    : await native('write', () => handle.write(data, at));
                return { bytesWritten, buffer };
            }
            const norm = normalizeRwArgs(buffer, offsetOrPosition, lengthOrEncoding, position);
            const bytes = arrayBufferBackedBytes(norm.window);
            const bytesWritten = norm.position == null
                ? await native('write', () => handle.write(bytes))
                : await native('write', () => handle.write(bytes, norm.position as number));
            return { bytesWritten, buffer };
        },
        async close() {
            if (closed) return;
            closed = true;
            await native('close', () => handle.close());
        },
        async stat(options?: { bigint?: boolean }) {
            await ensureOpen('fstat');
            return toNodeStat(await native('fstat', () => handle.stat()), options);
        },
        async sync() { await ensureOpen('fsync'); await native('fsync', () => handle.sync()); },
        async datasync() { await ensureOpen('fdatasync'); await native('fdatasync', () => handle.datasync()); },
        async truncate(len?: number) {
            await ensureOpen('ftruncate');
            // Unwrapped, a native rejection escapes with `code` as the raw UV number
            // (measured -4048 for a directory target), breaking string-code checks.
            await native('ftruncate', () => handle.truncate(len ?? 0));
        },
        async chmod(mode: Mode) { await ensureOpen('fchmod'); await native('fchmod', () => handle.chmod(modeToNumber(mode))); },
        async chown(uid: number, gid: number) { await ensureOpen('fchown'); await native('fchown', () => handle.chown(uid, gid)); },
        async utimes(atime: TimeLike, mtime: TimeLike) {
            await ensureOpen('futimes');
            await native('futimes', () => handle.utime(timeToUnixMs(atime, 'atime'), timeToUnixMs(mtime, 'mtime')));
        },
        async appendFile(data: string | Uint8Array | ArrayBuffer) {
            await ensureOpen('write');
            await writeAll(toUint8Array(data));
        },
        async readFile(options?: { encoding?: BufferEncoding | null; signal?: AbortSignal } | BufferEncoding) {
            await ensureOpen('readFile');
            // Node honours `signal` here; it was accepted and ignored, so an
            // aborted read still resolved with the whole file.
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
            await ensureOpen('write');
            await writeAll(toUint8Array(data));
        },
        async readv(buffers: readonly ArrayBufferView[], position?: number | null) {
            await ensureOpen('readv');
            if (!Array.isArray(buffers)) throw new TypeError('The "buffers" argument must be an Array');
            let bytesRead = 0;
            let currentPosition = position;
            for (const buffer of buffers) {
                if (!ArrayBuffer.isView(buffer)) throw new TypeError('The "buffers" argument must be an ArrayBufferView[]');
                const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                if (chunk.byteLength === 0) continue;
                const read = currentPosition == null
                    ? await native('readv', () => handle.read(chunk))
                    : await native('readv', () => handle.read(chunk, currentPosition as number));
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
                const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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
    let exhausted = false;

    const dir: import('fs').Dir = {
        path: pathStr,

        async read(): Promise<import('fs').Dirent | null> {
            if (closed) throw dirClosedError();
            // Node keeps returning null once the directory is drained; the native
            // handle yields `undefined` from a second post-exhaustion `next()`,
            // which used to surface as "cannot read property 'done' of undefined".
            if (exhausted) return null;
            const result = await dirHandle.next();
            if (result === undefined || result.done) {
                exhausted = true;
                return null;
            }
            return toNodeDirentAsync(result.value, pathStr);
        },

        readSync(): import('fs').Dirent | null {
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

/**
 * `opendir({recursive:true})`: the whole walk is materialised up front, the same
 * way the synchronous `Dir` already does, and handed out one entry at a time.
 * `dir.path` stays the root while each `Dirent.parentPath` is its real container
 * (measured against node v24.18.0).
 */
export function createEagerAsyncDir(
    pathStr: string,
    entries: DirEntryWithParent[],
): import('fs').Dir {
    let closed = false;
    let index = 0;

    const dir: import('fs').Dir = {
        path: pathStr,

        async read(): Promise<import('fs').Dirent | null> {
            if (closed) throw dirClosedError();
            if (index >= entries.length) return null;
            const entry = entries[index++];
            if (entry === undefined) return null;
            return toNodeDirentAsync(entry, entry.parentPath);
        },

        readSync(): import('fs').Dirent | null {
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
