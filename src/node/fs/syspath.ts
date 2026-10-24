/**
 * Windows MAX_PATH ceiling: namespaced paths at the syscall boundary.
 *
 * Node prefixes every fs path with `\\?\` before libuv and mod_fs.c does not.
 * `\\?\` disables Win32 normalisation, so paths are resolved first. Errors keep
 * the ORIGINAL path: never hand a namespaced string to `wrapSync`/`wrapAsync`.
 */

import { toNamespacedPath } from '../path';

const isWindows = process.platform === 'win32';

/**
 * Namespace a path for a syscall. No-op off Windows and for the empty string
 * (callers rely on Node's ERR_INVALID_ARG_VALUE / ENOENT for it).
 */
export function sysPath(p: string): string {
    if (!isWindows || typeof p !== 'string' || p.length === 0) return p;
    return toNamespacedPath(p);
}

/** Strip a `\\?\` / `\\?\UNC\` prefix so a returned path stays user-facing. */
export function unSysPath(p: string): string {
    if (!isWindows || typeof p !== 'string') return p;
    if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
    if (p.startsWith('\\\\?\\')) return p.slice(4);
    return p;
}

/** Argument positions holding a filesystem path, per native fn. */
const PATHS_SYNC: Record<string, readonly number[]> = {
    stat: [0], lstat: [0], statFs: [0], exists: [0], open: [0], readFile: [0],
    writeFile: [0], mkdir: [0], rmdir: [0], readdir: [0], unlink: [0],
    truncate: [0], chmod: [0], chown: [0], utimes: [0], access: [0],
    realpath: [0], readlink: [0],
    copy: [0, 1], rename: [0, 1], link: [0, 1],
    // Device paths (`\\.\pipe\…`, `\\.\NUL`) are returned resolved-but-unprefixed
    // by `toNamespacedPath`; prefixing those would break them.
    symlink: [1],
};

const PATHS_ASYNC: Record<string, readonly number[]> = {
    open: [0], stat: [0], lstat: [0], statSync: [0], realPath: [0], unlink: [0],
    readFile: [0], mkdir: [0], mkdirSync: [0], rmdir: [0], readDir: [0],
    readLink: [0], chmod: [0], chown: [0], lchown: [0], utime: [0],
    lutime: [0], statFs: [0], makeTempDir: [0], mkstemp: [0],
    rename: [0, 1], copyFile: [0, 1], link: [0, 1],
    // symlink(target, linkPath): `target` is link *content*, so only linkPath is
    // namespaced — a relative target must stay relative.
    symlink: [1],
};

/** Fns whose return value is a path the caller sees — must come back plain. */
const RET_SYNC = new Set(['realpath']);
const RET_ASYNC = new Set(['realPath', 'makeTempDir']);

/**
 * `fswatch` is a THIRD binding, separate from fs/asyncfs: without it, `fs.watch()`
 * on a >259-char directory fails with ENOENT.
 */
const PATHS_FSWATCH: Record<string, readonly number[]> = { watch: [0] };

function wrapFn(fn: (...a: unknown[]) => unknown, positions: readonly number[], stripRet: boolean) {
    return function (this: unknown, ...args: unknown[]): unknown {
        const swaps: Array<[string, string]> = [];
        for (const i of positions) {
            if (i < args.length && typeof args[i] === 'string') {
                const original = args[i] as string;
                const namespaced = sysPath(original);
                if (namespaced !== original) swaps.push([namespaced, original]);
                args[i] = namespaced;
            }
        }
        const finish = (out: unknown): unknown => (stripRet && typeof out === 'string' ? unSysPath(out) : out);
        try {
            const out = fn.apply(this, args);
            const isThenable = out && typeof (out as Promise<unknown>).then === 'function';
            if (isThenable) {
                const p = out as Promise<unknown>;
                // `engine.waitIO()` drains the native promise and cannot see
                // through a `.then()` chain, so return the original promise.
                // `dePrefixError` mutates in place, so this handler runs first;
                // the trailing catch stops it counting as a second rejection.
                if (swaps.length > 0) {
                    p.catch((e: unknown) => { dePrefixError(e, swaps); }).catch(() => { /* bookkeeping only */ });
                }
                return stripRet ? p.then(finish) : p;
            }
            return typeof out === 'string' ? finish(out) : out;
        } catch (e) {
            throw dePrefixError(e, swaps);
        }
    };
}

/**
 * mod_fs.c bakes the path it was handed into the native error message, which
 * would surface `\\?\D:\…` to the user. `err.path` is already correct, so only
 * the message and stack's first line are swapped back.
 */
function dePrefixError(e: unknown, swaps: Array<[string, string]>): unknown {
    if (swaps.length === 0 || !(e instanceof Error)) return e;
    for (const [namespaced, original] of swaps) {
        if (typeof e.message === 'string' && e.message.includes(namespaced)) {
            try { e.message = e.message.split(namespaced).join(original); } catch { /* frozen */ }
        }
        if (typeof e.stack === 'string' && e.stack.includes(namespaced)) {
            try { e.stack = e.stack.split(namespaced).join(original); } catch { /* frozen */ }
        }
    }
    return e;
}


/**
 * Proxy the native binding so path arguments are namespaced on the way in.
 * A Proxy keeps numeric constants and `S_IF*` masks passing through untouched.
 */
function wrapBinding<T extends object>(raw: T, positions: Record<string, readonly number[]>, rets: Set<string>): T {
    if (!isWindows) return raw;
    const cache = new Map<string | symbol, unknown>();
    return new Proxy(raw, {
        get(target, prop, receiver) {
            const positionsFor = typeof prop === 'string' ? positions[prop] : undefined;
            const value = Reflect.get(target, prop, receiver);
            if (!positionsFor || typeof value !== 'function') return value;
            let wrapped = cache.get(prop);
            if (wrapped === undefined) {
                wrapped = wrapFn(value as (...a: unknown[]) => unknown, positionsFor, typeof prop === 'string' && rets.has(prop));
                cache.set(prop, wrapped);
            }
            return wrapped;
        },
    });
}

/** `fs` / `asyncfs` / `fswatch` with paths namespaced at the syscall boundary. */
export const nsfs = wrapBinding(import.meta.use('fs'), PATHS_SYNC, RET_SYNC);
export const nsasfs = wrapBinding(import.meta.use('asyncfs'), PATHS_ASYNC, RET_ASYNC);
export const nsfswatch = wrapBinding(import.meta.use('fswatch'), PATHS_FSWATCH, new Set<string>());

