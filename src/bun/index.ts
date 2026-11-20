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
import { dns } from './dns';
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
import { FileSystemRouter, type FileSystemRouterOptions, type MatchedRoute } from './file-system-router';
import { Glob, type GlobScanOptions } from './glob';
import { bunHash as hash, type BunHash, type HashInput } from './hash';
import { inspect as inspectValue, inspectCustom, inspectTable, type InspectOptions } from './inspect';
import {
    connect,
    listen,
    type BunConnectOptions,
    type BunListenOptions,
    type BunSocket,
    type BunSocketData,
    type BunSocketHandler,
    type BunSocketListener,
    type BunTcpSocketListener,
    type BunTcpSocketOptions,
    type BunUnixSocketListener,
    type BunUnixSocketOptions,
} from './net';
import { spawn, spawnSync } from './process';
import { resolve, resolveSync } from './resolve';
import { bunSemver as semver } from './semver';
import {
    serve,
    type BunServeHandler,
    type BunServeHttpMethod,
    type BunServeOptions,
    type BunServeReloadOptions,
    type BunServeRoute,
    type BunServeRoutes,
    type BunServeServer,
} from './serve';
import { installServeStaticDirectoryRoutes } from './serve-static';
import { sleepSync } from './sleep-sync';
import { stderr, stdin, stdout, type StdioFile } from './stdio';
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
import { ansiColorDepth, color, setStdoutColorDepthProvider } from './utils/color';
import { shrink, unsafe } from './utils/unsafe';
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

const engine = import.meta.use('engine');
const evbus = import.meta.use('evbus');
const osModule = import.meta.use('os');
const timers = import.meta.use('timers');
const worker = import.meta.use('worker');

const webFetch = globalThis.fetch;
const reflectGet = Reflect.get;
const NativePromise = Promise;
const dateGetTime = Date.prototype.getTime;
const dateNow = Date.now;
const mathMin = Math.min;
// The native timer converts through signed int64; stay within exact JS integers.
const MAX_TIMER_DELAY = 9_007_199_254_740_991;
const UNSUPPORTED_FETCH_OPTIONS = [
    'tls',
    'verbose',
    'proxy',
    'session',
    's3',
    'unix',
    'protocol',
    'decompress',
    'compress',
    'maxRedirects',
    'timeout',
] as const;

export const fetch: typeof globalThis.fetch = async function fetch(input, init = undefined) {
    const objectInit = init !== null && (typeof init === 'object' || typeof init === 'function')
        ? init
        : undefined;
    if (objectInit !== undefined) {
        for (const name of UNSUPPORTED_FETCH_OPTIONS) {
            if (reflectGet(objectInit, name) !== undefined) {
                throw new TypeError(`Bun.fetch: unsupported Bun-specific option "${name}".`);
            }
        }
    }
    return webFetch(input, objectInit);
};
export const isMainThread = !worker.isWorker;
// cno does not produce Bun-style `--compile` standalone executables. Keep
// these feature-detection values truthful and allocation-free in normal runs.
export const isStandaloneExecutable = false;
export const embeddedFiles: ReadonlyArray<Blob> = Object.freeze([] as Blob[]);

export {
    ArrayBufferSink,
    Cookie,
    CookieMap,
    CryptoHasher,
    dns,
    FileSystemRouter,
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
    connect,
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
    listen,
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
    shrink,
    spawn,
    spawnSync,
    stderr,
    stdin,
    stdout,
    stringWidth,
    stripANSI,
    TOML,
    unsafe,
    wrapAnsi,
    which,
    write,
    resolve,
    resolveSync,
};
export type {
    ArrayBufferSinkStartOptions,
    BunConnectOptions,
    BunFileLike,
    BunFileWriteOptions,
    BunHash,
    BunListenOptions,
    BunServeHandler,
    BunServeHttpMethod,
    BunServeOptions,
    BunServeReloadOptions,
    BunServeRoute,
    BunServeRoutes,
    BunServeServer,
    BunSocket,
    BunSocketData,
    BunSocketHandler,
    BunSocketListener,
    BunTcpSocketListener,
    BunTcpSocketOptions,
    BunUnixSocketListener,
    BunUnixSocketOptions,
    BunWriteInput,
    CompressionInput,
    CompressionOptions,
    CookieInit,
    CookieOptions,
    CookieSameSite,
    CookieStoreDeleteOptions,
    FileSystemRouterOptions,
    GlobScanOptions,
    HashInput,
    HashClassInput,
    HashClassOutput,
    HashDigestEncoding,
    InspectOptions,
    JSONLInput,
    JSONLParseChunkResult,
    LibdeflateCompressionOptions,
    MatchedRoute,
    PeekStatus,
    SliceAnsiOptions,
    StdioFile,
    StringWidthOptions,
    WhichOptions,
    WrapAnsiOptions,
    ZlibCompressionOptions,
};

export interface BunApi {
    readonly argv: string[];
    readonly env: Record<string, string | undefined>;
    readonly main: string;
    cwd: string;
    readonly fetch: typeof fetch;
    readonly isMainThread: boolean;
    readonly sleep: typeof sleep;
    readonly sleepSync: typeof sleepSync;
    readonly shrink: typeof shrink;
    readonly gc: typeof gc;
    readonly enableANSIColors: boolean;
    readonly isStandaloneExecutable: boolean;
    readonly embeddedFiles: ReadonlyArray<Blob>;
    readonly connect: typeof connect;
    readonly listen: typeof listen;
    readonly stdout: StdioFile;
    readonly stderr: StdioFile;
    readonly stdin: StdioFile;
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
    readonly dns: typeof dns;
    readonly FileSystemRouter: typeof FileSystemRouter;
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
    readonly unsafe: typeof unsafe;
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

export const sleep = (milliseconds: number | Date): Promise<void> => {
    let delay: number;
    if (typeof milliseconds === 'number') {
        delay = milliseconds;
    } else if (engine.isDate(milliseconds)) {
        delay = dateGetTime.call(milliseconds) - dateNow();
    } else {
        throw new TypeError('sleep expects a number (milliseconds)');
    }

    if (delay === Infinity) return new NativePromise(() => {});
    const timerDelay = delay !== delay || delay <= 0
        ? 0
        : mathMin(delay, MAX_TIMER_DELAY);
    return new NativePromise((resolve) => timers.setTimeout(resolve, timerDelay));
};

/**
 * Manual engine GC. Bun distinguishes eden (`false`) from full (`true`)
 * collection; the engine binding only exposes one sweep, so every call runs it.
 */
export const gc = (_force?: boolean): void => {
    engine.gc.run();
};

/** Whether stdout is a terminal, i.e. whether ANSI colors are enabled. */
export const enableANSIColors: boolean = osModule.guessHandle(1) === 'tty';

// Bun.color's automatic "ansi" format reads the same stdout snapshot Bun
// captures at startup. Directory routes need the host filesystem, and wiring
// them here keeps serve.ts bundleable without runtime bindings.
installServeStaticDirectoryRoutes();
setStdoutColorDepthProvider(() => ansiColorDepth(processBridge().env, enableANSIColors));

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
    // The CLI publishes the entry URL on its `cno.runtime` channel.
    const published = evbus.get('cno.runtime', 'mainScript');
    const main = typeof published === 'string' ? published : '';
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

const noLifecycleOverride = Symbol('no Bun lifecycle override');
let argvOverride: unknown = noLifecycleOverride;
let mainOverride: unknown = noLifecycleOverride;

// Keep the lifecycle defaults live because the CLI applies env files and script
// arguments after bootstrap. Bun.argv and Bun.main remain user-replaceable.
const Bun: BunApi = {
    get argv(): string[] {
        return (argvOverride === noLifecycleOverride ? processBridge().argv : argvOverride) as string[];
    },
    set argv(value: string[]) {
        argvOverride = value;
    },
    get env(): Record<string, string | undefined> {
        return processBridge().env;
    },
    get main(): string {
        return (mainOverride === noLifecycleOverride ? mainPath() : mainOverride) as string;
    },
    set main(value: string) {
        mainOverride = value;
    },
    cwd: osModule.cwd,
    fetch,
    isMainThread,
    sleep,
    sleepSync,
    shrink,
    gc,
    enableANSIColors,
    isStandaloneExecutable,
    embeddedFiles,
    connect,
    listen,
    stdout,
    stderr,
    stdin,
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
    dns,
    FileSystemRouter,
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
    unsafe,
    indexOfLine,
    inspect,
    resolve,
    resolveSync,
};

const readOnlyBunMembers = new Set<PropertyKey>([
    'env', 'fetch', 'isMainThread', 'isStandaloneExecutable',
    'Cookie', 'CookieMap', 'dns', 'JSONL', 'semver',
]);

// Bun exposes cwd as a hidden, replaceable snapshot rather than a live
// process.cwd() view. Defining it before the public-slot pass also keeps it
// out of the enumerable module facade.
Object.defineProperty(Bun, 'cwd', {
    value: Bun.cwd,
    writable: true,
    enumerable: false,
    configurable: false,
});

// Bun's public namespace slots cannot be deleted. Most remain replaceable;
// only the small set above is read-only in Bun 1.4.4.
for (const name of Object.keys(Bun)) {
    const descriptor = Object.getOwnPropertyDescriptor(Bun, name)!;
    Object.defineProperty(Bun, name, 'value' in descriptor
        ? { ...descriptor, writable: !readOnlyBunMembers.has(name), configurable: false }
        : { ...descriptor, configurable: false });
}
Object.defineProperty(Bun, Symbol.toStringTag, {
    value: 'Bun',
    writable: false,
    enumerable: false,
    configurable: true,
});

export default Bun;
