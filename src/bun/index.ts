import {
    deflateSync,
    gunzipSync,
    gzipSync,
    inflateSync,
    type CompressionInput,
    type CompressionOptions,
    type LibdeflateCompressionOptions,
    type ZlibCompressionOptions,
} from './compression';
import { ArrayBufferSink, type ArrayBufferSinkStartOptions } from './array-buffer-sink';
import { CookieMap, type CookieInit, type CookieSameSite, type CookieStoreDeleteOptions } from './cookie';
import { Cookie, type CookieOptions } from './cookie/cookie';
import { CryptoHasher } from './crypto';
import {
    MD4,
    MD5,
    SHA1,
    SHA224,
    SHA256,
    SHA384,
    SHA512,
    SHA512_256,
    sha,
    type HashClassInput,
    type HashClassOutput,
    type HashDigestEncoding,
} from './crypto/hash-classes';
import { file, type BunFileLike, type BunFileWriteOptions, type BunWriteInput, write } from './file';
import { Glob, type GlobScanOptions } from './glob';
import { bunHash as hash, type BunHash, type HashInput } from './hash';
import { inspect as inspectValue, inspectCustom, inspectTable, type InspectOptions } from './inspect';
import { spawn, spawnSync } from './process';
import { resolve, resolveSync } from './resolve';
import { bunSemver as semver } from './semver';
import { serve, type BunServeHandler, type BunServeOptions, type BunServeServer } from './serve';
import { sleepSync } from './sleep-sync';
import { allocUnsafe } from './utils/alloc-unsafe';
import { deepEquals } from './utils/deep-equals';
import { deepMatch } from './utils/deep-match';
import { escapeHTML } from './utils/escape-html';
import { fileURLToPath, pathToFileURL } from './utils/file-url';
import { indexOfLine } from './utils/index-of-line';
import { JSON5 } from './utils/json5';
import { JSONC } from './utils/jsonc';
import { JSONL, type JSONLInput, type JSONLParseChunkResult } from './utils/jsonl';
import { nanoseconds } from './utils/nanoseconds';
import { peek, type PeekStatus } from './utils/peek';
import { color } from './utils/color';
import {
    concatArrayBuffers,
    readableStreamToArray,
    readableStreamToArrayBuffer,
    readableStreamToBlob,
    readableStreamToBytes,
    readableStreamToFormData,
    readableStreamToJSON,
    readableStreamToText,
} from './utils/streams';
import {
    sliceAnsi,
    stringWidth,
    stripANSI,
    wrapAnsi,
    type SliceAnsiOptions,
    type StringWidthOptions,
    type WrapAnsiOptions,
} from './utils/text';
import { which, type WhichOptions } from './utils/which';
import { TOML } from './utils/toml';
import { randomUUIDv7 } from './uuid';
import { randomUUIDv5 } from './uuid/v5';

export {
    ArrayBufferSink,
    Cookie,
    CookieMap,
    CryptoHasher,
    Glob,
    JSONC,
    JSON5,
    JSONL,
    MD4,
    MD5,
    SHA1,
    SHA224,
    SHA256,
    SHA384,
    SHA512,
    SHA512_256,
    allocUnsafe,
    color,
    concatArrayBuffers,
    deepEquals,
    deepMatch,
    deflateSync,
    escapeHTML,
    file,
    fileURLToPath,
    gunzipSync,
    gzipSync,
    hash,
    indexOfLine,
    inflateSync,
    nanoseconds,
    pathToFileURL,
    peek,
    randomUUIDv5,
    randomUUIDv7,
    readableStreamToArray,
    readableStreamToArrayBuffer,
    readableStreamToBlob,
    readableStreamToBytes,
    readableStreamToFormData,
    readableStreamToJSON,
    readableStreamToText,
    semver,
    serve,
    sha,
    sliceAnsi,
    sleepSync,
    spawn,
    spawnSync,
    stringWidth,
    stripANSI,
    TOML,
    wrapAnsi,
    which,
    write,
    resolve,
    resolveSync,
};
export type {
    ArrayBufferSinkStartOptions,
    BunFileLike,
    BunFileWriteOptions,
    BunHash,
    BunServeHandler,
    BunServeOptions,
    BunServeServer,
    BunInspect,
    BunWriteInput,
    CompressionInput,
    CompressionOptions,
    CookieInit,
    CookieOptions,
    CookieSameSite,
    CookieStoreDeleteOptions,
    GlobScanOptions,
    HashInput,
    HashClassInput,
    HashClassOutput,
    HashDigestEncoding,
    InspectOptions,
    JSONLInput,
    JSONLParseChunkResult,
    LibdeflateCompressionOptions,
    PeekStatus,
    SliceAnsiOptions,
    StringWidthOptions,
    WhichOptions,
    WrapAnsiOptions,
    ZlibCompressionOptions,
};

export interface BunApi {
    readonly argv: string[];
    readonly env: Record<string, string | undefined>;
    readonly main: string;
    readonly sleep: typeof sleep;
    readonly sleepSync: typeof sleepSync;
    readonly ArrayBufferSink: typeof ArrayBufferSink;
    readonly Cookie: typeof Cookie;
    readonly CookieMap: typeof CookieMap;
    readonly file: typeof file;
    readonly write: typeof write;
    readonly serve: typeof serve;
    readonly spawn: typeof spawn;
    readonly spawnSync: typeof spawnSync;
    readonly gzipSync: typeof gzipSync;
    readonly gunzipSync: typeof gunzipSync;
    readonly deflateSync: typeof deflateSync;
    readonly inflateSync: typeof inflateSync;
    readonly CryptoHasher: typeof CryptoHasher;
    readonly SHA1: typeof SHA1;
    readonly MD5: typeof MD5;
    readonly MD4: typeof MD4;
    readonly SHA224: typeof SHA224;
    readonly SHA256: typeof SHA256;
    readonly SHA384: typeof SHA384;
    readonly SHA512: typeof SHA512;
    readonly SHA512_256: typeof SHA512_256;
    readonly sha: typeof sha;
    readonly Glob: typeof Glob;
    readonly hash: BunHash;
    readonly semver: typeof semver;
    readonly randomUUIDv5: typeof randomUUIDv5;
    readonly randomUUIDv7: typeof randomUUIDv7;
    readonly escapeHTML: typeof escapeHTML;
    readonly pathToFileURL: typeof pathToFileURL;
    readonly fileURLToPath: typeof fileURLToPath;
    readonly concatArrayBuffers: typeof concatArrayBuffers;
    readonly readableStreamToArrayBuffer: typeof readableStreamToArrayBuffer;
    readonly readableStreamToBytes: typeof readableStreamToBytes;
    readonly readableStreamToFormData: typeof readableStreamToFormData;
    readonly readableStreamToText: typeof readableStreamToText;
    readonly readableStreamToJSON: typeof readableStreamToJSON;
    readonly readableStreamToArray: typeof readableStreamToArray;
    readonly readableStreamToBlob: typeof readableStreamToBlob;
    readonly deepEquals: typeof deepEquals;
    readonly deepMatch: typeof deepMatch;
    readonly JSONC: typeof JSONC;
    readonly JSON5: typeof JSON5;
    readonly JSONL: typeof JSONL;
    readonly TOML: typeof TOML;
    readonly color: typeof color;
    readonly stripANSI: typeof stripANSI;
    readonly sliceAnsi: typeof sliceAnsi;
    readonly stringWidth: typeof stringWidth;
    readonly wrapAnsi: typeof wrapAnsi;
    readonly which: typeof which;
    readonly nanoseconds: typeof nanoseconds;
    readonly peek: typeof peek;
    readonly allocUnsafe: typeof allocUnsafe;
    readonly indexOfLine: typeof indexOfLine;
    readonly inspect: typeof inspect;
    readonly resolve: typeof resolve;
    readonly resolveSync: typeof resolveSync;
}

export interface BunInspect {
    (value: unknown, options?: InspectOptions): string;
    readonly custom: symbol;
    readonly table: typeof inspectTable;
}

/** `Bun.inspect` plus the Bun-compatible `custom` and `table` properties. */
export const inspect: BunInspect = Object.defineProperties(
    function inspect(value: unknown, options?: InspectOptions): string {
        return inspectValue(value, options);
    },
    {
        custom: { value: inspectCustom, writable: true, enumerable: true, configurable: true },
        table: { value: inspectTable, writable: true, enumerable: true, configurable: true },
    },
) as BunInspect;

export function sleep(milliseconds: number | Date): Promise<void> {
    const delay = milliseconds instanceof Date
        ? milliseconds.getTime() - Date.now()
        : milliseconds;
    if (delay === Infinity) return new Promise(() => {});
    return new Promise((resolve) => setTimeout(resolve, Number.isFinite(delay) ? Math.max(0, delay) : 0));
}

function processBridge(): {
    argv: string[];
    env: Record<string, string | undefined>;
} {
    const process = Reflect.get(globalThis, 'process') as {
        argv?: string[];
        env?: Record<string, string | undefined>;
    } | undefined;
    return {
        argv: process?.argv ?? [],
        env: process?.env ?? {},
    };
}

function mainPath(): string {
    const main = String(Reflect.get(globalThis, '__mainScript') ?? '');
    if (!main.startsWith('file:')) return main;
    try {
        const url = new URL(main);
        let path = decodeURIComponent(url.pathname);
        if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
        return url.host ? `//${url.host}${path}` : path;
    } catch {
        return main;
    }
}

// Accessors intentionally stay live: env files and script arguments are applied
// by the CLI after the compatibility bootstrap and before entry evaluation.
const Bun: BunApi = {
    get argv(): string[] {
        return processBridge().argv;
    },
    get env(): Record<string, string | undefined> {
        return processBridge().env;
    },
    get main(): string {
        return mainPath();
    },
    sleep,
    sleepSync,
    ArrayBufferSink,
    Cookie,
    CookieMap,
    file,
    write,
    serve,
    spawn,
    spawnSync,
    gzipSync,
    gunzipSync,
    deflateSync,
    inflateSync,
    CryptoHasher,
    SHA1,
    MD5,
    MD4,
    SHA224,
    SHA256,
    SHA384,
    SHA512,
    SHA512_256,
    sha,
    Glob,
    hash,
    semver,
    randomUUIDv5,
    randomUUIDv7,
    escapeHTML,
    pathToFileURL,
    fileURLToPath,
    concatArrayBuffers,
    readableStreamToArrayBuffer,
    readableStreamToBytes,
    readableStreamToFormData,
    readableStreamToText,
    readableStreamToJSON,
    readableStreamToArray,
    readableStreamToBlob,
    deepEquals,
    deepMatch,
    JSONC,
    JSON5,
    JSONL,
    TOML,
    color,
    stripANSI,
    sliceAnsi,
    stringWidth,
    wrapAnsi,
    which,
    nanoseconds,
    peek,
    allocUnsafe,
    indexOfLine,
    inspect,
    resolve,
    resolveSync,
};

export default Bun;
