import { EventEmitter } from '../events';
import buffer from '../buffer';
import { pathToString, type PathLike } from './utils';

const fswatch = import.meta.use('fswatch');
const { Buffer } = buffer;

type WatchEncoding = BufferEncoding | 'buffer';
type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

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
