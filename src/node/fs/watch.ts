import { EventEmitter } from '../events';
import { AsyncLocalStorage } from '../async_hooks';
import { setInterval, clearInterval, setImmediate } from '../timers';
import { Buffer } from '../buffer';
import { toErrnoException } from '../_internal/errno';
import { BigIntStats, Stats, pathToString, toNodeStat, type PathLike } from './utils';
import { nsasfs, nsfswatch } from './syspath';

const fswatch = nsfswatch;
const asfs = nsasfs;
const engine = import.meta.use('engine');

type WatchEncoding = BufferEncoding | 'buffer';
type WatchListener = (eventType: string, filename: string | Buffer | null) => void;
type WatchFileStats = Stats | BigIntStats;
type WatchFileListener = (curr: WatchFileStats, prev: WatchFileStats) => void;

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
        try {
            watcher?.close();
        } catch (err) {
            this.emit('error', normalizeError(err));
        } finally {
            this.emit('close');
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
    const pathStr = pathToString(path);
    const watcher = new FSWatcher(options);
    if (watchListener) watcher.on('change', watchListener);

    try {
        const nativeWatcher = fswatch.watch(pathStr, (filename, eventType) => {
            watcher.emitChange(eventType, filename);
        }, !!options.recursive);
        watcher.attach(nativeWatcher);
    } catch (err) {
        // Failed native creation must also release the abort listener.
        watcher.close();
        throw toErrnoException(err, 'watch', pathStr);
    }

    return watcher;
}

async function readStatOrZero(pathStr: string, bigint: boolean): Promise<WatchFileStats> {
    try {
        return toNodeStat(await asfs.stat(pathStr), { bigint });
    } catch {
        return zeroStat(bigint);
    }
}

function readInitialStatOrZero(pathStr: string, bigint: boolean): WatchFileStats {
    try {
        const pending = asfs.stat(pathStr);
        void pending.catch(() => {});
        return toNodeStat(engine.waitIO(pending), { bigint });
    } catch {
        return zeroStat(bigint);
    }
}

function zeroStat(bigint: boolean): WatchFileStats {
    // Stats/BigIntStats default every field to 0 and every date to epoch when the
    // native stat is absent, which is exactly Node's "file does not exist" Stats.
    return bigint ? new BigIntStats() : new Stats();
}

function statsEqual(a: WatchFileStats, b: WatchFileStats): boolean {
    return a.mtimeMs === b.mtimeMs && a.size === b.size && a.mode === b.mode
        && a.ino === b.ino && a.nlink === b.nlink;
}

function rethrowWatchFileListenerError(error: unknown): void {
    setImmediate(() => { throw error; });
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
    const runInContext = AsyncLocalStorage.snapshot();
    const bigint = options.bigint === true;
    let prev = readInitialStatOrZero(pathStr, bigint);
    let initial = true;
    let pending = false;
    const interval = Math.max(1, options.interval ?? 5007);
    const poll = async () => {
        if (pending) return;
        pending = true;
        const curr = await readStatOrZero(pathStr, bigint);
        pending = false;
        if (watchFileRegistry.get(pathStr) !== entry) return;
        const old = prev;
        prev = curr;
        const changed = !statsEqual(curr, old) || (initial && curr.nlink === (bigint ? 0n : 0));
        initial = false;
        if (changed) {
            try {
                runInContext(() => {
                    for (const fn of listeners) fn(curr, old);
                });
            } catch (error) {
                rethrowWatchFileListenerError(error);
            }
        }
    };
    const timer = setInterval(poll, interval);
    const entry = { listeners, timer };
    watchFileRegistry.set(pathStr, entry);
    if (options.persistent === false) timer.unref();
    void poll();
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
