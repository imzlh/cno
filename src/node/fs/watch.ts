import { EventEmitter } from '../events';
import buffer from '../buffer';
import { toErrnoException } from '../_internal/errno';
import { pathToString, toNodeStat, type PathLike } from './utils';

import { nsfs, nsasfs, nsfswatch } from './syspath';
const fswatch = nsfswatch;
const fs = nsfs;
const asfs = nsasfs;
const engine = import.meta.use('engine');
const { Buffer } = buffer;

type WatchEncoding = BufferEncoding | 'buffer';
type WatchListener = (eventType: string, filename: string | Buffer | null) => void;
type WatchFileListener = (curr: import('fs').Stats, prev: import('fs').Stats) => void;

export interface WatchOptions {
    persistent?: boolean;
    recursive?: boolean;
    encoding?: WatchEncoding;
    signal?: AbortSignal;
}

interface WatchEvents {
    change: [eventType: string, filename: string | Buffer | null];
    close: [];
    error: [err: Error];
}

interface WatchFileOptions {
    persistent?: boolean;
    interval?: number;
    bigint?: boolean;
}

interface WatchFileEntry {
    listeners: Set<WatchFileListener>;
    prev: import('fs').Stats;
    timer: ReturnType<typeof setInterval>;
}

const watchFileRegistry = new Map<string, WatchFileEntry>();

function normalizeWatchArgs(
    optionsOrListener?: WatchOptions | WatchEncoding | WatchListener,
    listener?: WatchListener,
): { options: WatchOptions; listener?: WatchListener } {
    if (typeof optionsOrListener === 'function') {
        return { options: {}, listener: optionsOrListener };
    }
    if (typeof optionsOrListener === 'string') {
        return { options: { encoding: optionsOrListener }, listener };
    }
    return { options: optionsOrListener ?? {}, listener };
}

function normalizeError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

export class FSWatcher extends EventEmitter<WatchEvents> {
    private watcher: CModuleFSWatch.FsWatcher | null = null;
    private closed = false;
    private abortSignal: AbortSignal | null = null;
    private abortHandler: (() => void) | null = null;

    constructor(private readonly options: WatchOptions = {}) {
        super();
        const signal = options.signal;
        if (signal) {
            const abortHandler = () => this.close();
            this.abortSignal = signal;
            this.abortHandler = abortHandler;
            signal.addEventListener('abort', abortHandler, { once: true });
            if (signal.aborted) this.close();
        }
    }

    attach(watcher: CModuleFSWatch.FsWatcher): void {
        if (this.closed) {
            watcher.close();
            return;
        }
        this.watcher = watcher;
    }

    emitChange(eventType: string, filename: string | null): void {
        if (this.closed) return;
        this.emit('change', eventType, this.toFilename(filename));
    }

    emitError(err: unknown): void {
        if (this.closed) return;
        this.emit('error', normalizeError(err));
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        const signal = this.abortSignal;
        const abortHandler = this.abortHandler;
        this.abortSignal = null;
        this.abortHandler = null;
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        const watcher = this.watcher;
        this.watcher = null;
        if (!watcher) {
            this.emit('close');
            return;
        }
        try {
            watcher.close();
            this.emit('close');
        } catch (err) {
            try { this.emit('error', normalizeError(err)); }
            finally { this.emit('close'); }
        }
    }

    ref(): this {
        return this;
    }

    unref(): this {
        return this;
    }

    private toFilename(filename: string | null): string | Buffer | null {
        if (!filename) return null;
        return this.options.encoding === 'buffer' ? Buffer.from(filename) : filename;
    }
}

export function watch(
    path: PathLike,
    optionsOrListener?: WatchOptions | WatchEncoding | WatchListener,
    listener?: WatchListener,
): FSWatcher {
    const { options, listener: watchListener } = normalizeWatchArgs(optionsOrListener, listener);
    const watcher = new FSWatcher(options);
    if (watchListener) watcher.on('change', watchListener);

    const pathStr = pathToString(path);
    try {
        const nativeWatcher = fswatch.watch(pathStr, (filename, eventType) => {
            watcher.emitChange(eventType, filename);
        }, !!options.recursive);
        watcher.attach(nativeWatcher);
    } catch (err) {
        // fswatch throws a numeric UV code; Node callers match on 'ENOENT'.
        // The FSWatcher registers its signal listener before native creation.
        // Tear it down when creation fails, otherwise a long-lived signal keeps
        // the failed watcher (and its closure) reachable forever.
        watcher.close();
        throw toErrnoException(err, 'watch', pathStr);
    }

    return watcher;
}

// The sync C stat truncates timestamps to whole seconds, so a same-size rewrite
// within one second looks unchanged. asyncfs keeps ms precision — bridge it.
function readStat(pathStr: string, bigint = false): import('fs').Stats {
    const pending = asfs.stat(pathStr);
    // engine.waitIO rethrows synchronously but leaves the underlying promise
    // unclaimed, so a missing path also printed an "unhandled promise
    // rejection" banner on every poll tick. Claim it before waiting.
    void pending.catch(() => { /* surfaced synchronously by waitIO */ });
    return toNodeStat(engine.waitIO(pending), { bigint });
}

/**
 * Node's watchFile polls a path that need not exist yet: the first callback for
 * a missing file reports an all-zero Stats and a later create fires a change.
 * Throwing ENOENT out of watchFile instead escaped as an unhandled rejection
 * from engine.waitIO and killed the process.
 */
function readStatOrZero(pathStr: string, bigint: boolean): import('fs').Stats {
    try {
        return readStat(pathStr, bigint);
    } catch {
        return zeroStat(bigint);
    }
}

function zeroStat(bigint: boolean): import('fs').Stats {
    // Stats/BigIntStats default every field to 0 and every date to epoch when the
    // native stat is absent, which is exactly Node's "file does not exist" Stats.
    return toNodeStat(undefined as unknown as Parameters<typeof toNodeStat>[0], { bigint });
}

function statsEqual(a: import('fs').Stats, b: import('fs').Stats): boolean {
    return a.mtimeMs === b.mtimeMs && a.size === b.size && a.mode === b.mode
        && a.ino === b.ino && a.nlink === b.nlink;
}

export function watchFile(
    filename: PathLike,
    optionsOrListener?: WatchFileOptions | WatchFileListener,
    listener?: WatchFileListener,
): void {
    const pathStr = pathToString(filename);
    const options = typeof optionsOrListener === 'object' && optionsOrListener !== null ? optionsOrListener : {};
    const cb = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
    if (!cb) return;

    const existing = watchFileRegistry.get(pathStr);
    if (existing) {
        existing.listeners.add(cb);
        return;
    }

    const listeners = new Set<WatchFileListener>([cb]);
    const bigint = options.bigint === true;
    let prev = readStatOrZero(pathStr, bigint);
    const interval = Math.max(1, options.interval ?? 5007);
    const timer = setInterval(() => {
        const curr = readStatOrZero(pathStr, bigint);
        if (!statsEqual(curr, prev)) {
            const old = prev;
            prev = curr;
            for (const fn of listeners) fn(curr, old);
        } else {
            prev = curr;
        }
    }, interval);

    watchFileRegistry.set(pathStr, { listeners, prev, timer });
}

export function unwatchFile(filename: PathLike, listener?: WatchFileListener): void {
    const pathStr = pathToString(filename);
    const entry = watchFileRegistry.get(pathStr);
    if (!entry) return;

    if (listener) {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
    }

    clearInterval(entry.timer);
    watchFileRegistry.delete(pathStr);
}
