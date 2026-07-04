import { EventEmitter } from '../events';
import buffer from '../buffer';
import { pathToString, toNodeStat, type PathLike } from './utils';

const fswatch = import.meta.use('fswatch');
const fs = import.meta.use('fs');
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

    constructor(private readonly options: WatchOptions = {}) {
        super();
        const signal = options.signal;
        if (signal) {
            signal.addEventListener('abort', () => this.close(), { once: true });
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

    emitChange(eventType: string, filename: string): void {
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

    private toFilename(filename: string): string | Buffer | null {
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
        const nativeWatcher = fswatch.watch(pathStr, (filename: string, eventType: CModuleFSWatch.FsEvent) => {
            watcher.emitChange(eventType, filename);
        });
        watcher.attach(nativeWatcher);
    } catch (err) {
        watcher.emitError(err);
        watcher.close();
    }

    return watcher;
}

function readStat(pathStr: string): import('fs').Stats {
    return toNodeStat(fs.stat(pathStr));
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
    let prev = readStat(pathStr);
    const interval = Math.max(1, options.interval ?? 5007);
    const timer = setInterval(() => {
        let curr: import('fs').Stats;
        try {
            curr = readStat(pathStr);
        } catch {
            return;
        }
        if (
            curr.mtimeMs !== prev.mtimeMs ||
            curr.size !== prev.size ||
            curr.mode !== prev.mode
        ) {
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
