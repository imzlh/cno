import { isPathWithin } from '../utils/path';

const asyncfs = import.meta.use('asyncfs');

export const OPENED_FILE_CHUNK_SIZE = 64 * 1024;

export interface OpenedReadableFile {
    readonly handle: CModuleAsyncFS.FileHandle;
    readonly stat: CModuleAsyncFS.StatResult;
    readonly sizeKnown: boolean;
    readonly positional: boolean;
    /** Count an unknown-size, seekable source without retaining its contents. */
    measure(shouldCancel?: () => boolean): Promise<number>;
    /** Consume this descriptor as a single [start, end) byte stream. */
    stream(start?: number, end?: number): ReadableStream<Uint8Array<ArrayBuffer>>;
    /** Close the descriptor exactly once. Cleanup errors are intentionally ignored. */
    close(): Promise<void>;
}

interface SizeProbe {
    sizeKnown: boolean;
    positional: boolean;
}

function byteCount(value: number | null): number {
    return value ?? 0;
}

async function probeSize(
    handle: CModuleAsyncFS.FileHandle,
    stat: CModuleAsyncFS.StatResult,
): Promise<SizeProbe> {
    // Do not probe pipes and devices: even a one-byte read may block. Sparse
    // regular files are safe because a positional read from a hole returns a
    // zero-filled byte, not EOF.
    if (!stat.isFile || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        return { sizeKnown: false, positional: false };
    }

    const byte = new Uint8Array(1);
    try {
        if (stat.size === 0) {
            return { sizeKnown: byteCount(await handle.read(byte, 0)) === 0, positional: true };
        }
        const last = byteCount(await handle.read(byte, stat.size - 1));
        if (last !== 1) return { sizeKnown: false, positional: true };
        return { sizeKnown: byteCount(await handle.read(byte, stat.size)) === 0, positional: true };
    } catch {
        // Some file-like handles cannot pread. Their stat size and seekability
        // are both treated conservatively instead of retrying a path-based read.
        return { sizeKnown: false, positional: false };
    }
}

export async function adoptReadableFile(
    handle: CModuleAsyncFS.FileHandle,
    knownStat?: CModuleAsyncFS.StatResult,
): Promise<OpenedReadableFile> {
    let stat: CModuleAsyncFS.StatResult;
    try {
        stat = knownStat ?? await handle.stat();
    } catch (error) {
        await handle.close().catch(() => {});
        throw error;
    }
    let probe: SizeProbe;
    try {
        probe = await probeSize(handle, stat);
    } catch (error) {
        await handle.close().catch(() => {});
        throw error;
    }
    let closePromise: Promise<void> | undefined;
    let streamTaken = false;

    const close = (): Promise<void> => {
        return closePromise ??= handle.close().catch(() => {});
    };

    const measure = async (shouldCancel?: () => boolean): Promise<number> => {
        if (probe.sizeKnown) return stat.size;
        if (!probe.positional) {
            await close();
            throw new TypeError('Cannot resolve a negative Bun.file slice on a non-seekable source');
        }
        const buffer = new Uint8Array(OPENED_FILE_CHUNK_SIZE);
        let position = 0;
        try {
            while (true) {
                if (shouldCancel?.()) {
                    await close();
                    throw new Error('Bun.file read was cancelled');
                }
                const count = byteCount(await handle.read(buffer, position));
                if (shouldCancel?.()) {
                    await close();
                    throw new Error('Bun.file read was cancelled');
                }
                if (count <= 0) return position;
                position += count;
                if (!Number.isSafeInteger(position)) {
                    throw new RangeError('Bun.file source is too large to address safely');
                }
            }
        } catch (error) {
            await close();
            throw error;
        }
    };

    const stream = (start = 0, end = probe.sizeKnown ? stat.size : Infinity): ReadableStream<Uint8Array<ArrayBuffer>> => {
        if (streamTaken) {
            throw new TypeError('Opened file stream has already been consumed');
        }
        if (!Number.isSafeInteger(start) || start < 0 || end < start) {
            void close();
            throw new RangeError('Invalid opened file byte range');
        }
        if (end !== Infinity && (!Number.isSafeInteger(end) || end < 0)) {
            void close();
            throw new RangeError('Invalid opened file byte range');
        }
        streamTaken = true;

        let position = probe.positional ? start : 0;
        let active: Promise<void> | undefined;
        let cancelled = false;

        return new ReadableStream<Uint8Array<ArrayBuffer>>({
            pull(controller) {
                active = (async () => {
                    try {
                        while (!cancelled && position < end) {
                            const remaining = end - position;
                            const buffer = new Uint8Array(Math.min(OPENED_FILE_CHUNK_SIZE, remaining));
                            const count = byteCount(await handle.read(buffer, probe.positional ? position : undefined));
                            if (count <= 0) break;
                            const sourceStart = position;
                            position += count;
                            const from = Math.min(count, Math.max(0, start - sourceStart));
                            const to = Math.min(count, end - sourceStart);
                            if (!cancelled && to > from) {
                                controller.enqueue(buffer.slice(from, to));
                                return;
                            }
                        }
                        await close();
                        if (!cancelled) controller.close();
                    } catch (error) {
                        await close();
                        if (!cancelled) controller.error(error);
                    }
                })();
                return active;
            },
            async cancel() {
                cancelled = true;
                await active;
                await close();
            },
        });
    };

    return { handle, stat, ...probe, measure, stream, close };
}

export async function openReadableFile(path: string): Promise<OpenedReadableFile> {
    const handle = await asyncfs.open(path, 'r');
    return adoptReadableFile(handle);
}

/**
 * Open and reconcile a directory-route target before handing its descriptor
 * to the response. This is the strongest containment check available without
 * an openat2/RESOLVE_BENEATH-style host primitive.
 */
export async function openValidatedReadableFile(
    root: string,
    path: string,
): Promise<OpenedReadableFile | undefined> {
    let handle: CModuleAsyncFS.FileHandle | undefined;
    try {
        const before = await asyncfs.realPath(path);
        if (!isPathWithin(root, before)) return undefined;

        handle = await asyncfs.open(path, 'r');
        const openedStat = await handle.stat();
        if (!openedStat.isFile) {
            await handle.close().catch(() => {});
            return undefined;
        }

        const after = await asyncfs.realPath(path);
        if (after !== before || !isPathWithin(root, after)) {
            await handle.close().catch(() => {});
            return undefined;
        }
        const currentStat = await asyncfs.stat(after);
        if (currentStat.dev !== openedStat.dev || currentStat.ino !== openedStat.ino) {
            await handle.close().catch(() => {});
            return undefined;
        }

        const opened = await adoptReadableFile(handle, openedStat);
        handle = undefined;
        return opened;
    } catch {
        if (handle) await handle.close().catch(() => {});
        return undefined;
    }
}
