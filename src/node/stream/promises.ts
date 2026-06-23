import { Stream, Readable, Writable, PassThrough, Transform } from './mod';

/**
 * Stream.pipeline — connects streams and returns a Promise that resolves when
 * the pipeline finishes or rejects on the first error. Properly handles
 * transform functions, destroys all streams on error, and supports AbortSignal.
 */
export async function pipeline(
    ...streams: (Stream | ((source: Readable) => Stream) | { signal?: AbortSignal })[]
): Promise<void> {
    // Extract the optional signal from the last arg
    let signal: AbortSignal | undefined;
    const args = streams.map(s => {
        if (s && typeof s === 'object' && 'signal' in s && (s as any).signal instanceof AbortSignal) {
            signal = (s as any).signal;
            return null;
        }
        return s;
    }).filter(Boolean) as (Stream | ((source: Readable) => Stream))[];

    if (args.length < 2) {
        throw new TypeError('pipeline requires at least two streams');
    }

    // Resolve transform functions into actual streams
    const resolved: Stream[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg === 'function') {
            const prev = resolved[resolved.length - 1] as Readable;
            resolved.push(arg(prev));
        } else {
            resolved.push(arg);
        }
    }

    // Wire up error propagation: destroy all downstream on error
    const cleanup: (() => void)[] = [];
    const destroyAll = (err?: Error) => {
        for (const s of resolved) {
            if (!s.destroyed) s.destroy(err);
        }
    };

    // Pipe consecutive streams
    for (let i = 0; i < resolved.length - 1; i++) {
        const src = resolved[i] as Readable;
        const dst = resolved[i + 1] as Writable;
        src.pipe(dst);

        const onSrcError = (err: Error) => { destroyAll(err); };
        const onDstError = (err: Error) => { destroyAll(err); };
        src.on('error', onSrcError);
        dst.on('error', onDstError);
        cleanup.push(() => { src.removeListener('error', onSrcError); dst.removeListener('error', onDstError); });
    }

    // Handle AbortSignal
    if (signal) {
        if (signal.aborted) {
            destroyAll(new Error('The operation was aborted'));
        } else {
            const onAbort = () => { destroyAll(new Error('The operation was aborted')); };
            signal.addEventListener('abort', onAbort, { once: true });
            cleanup.push(() => signal!.removeEventListener('abort', onAbort));
        }
    }

    return new Promise<void>((resolve, reject) => {
        const last = resolved[resolved.length - 1];

        const onFinish = () => { doCleanup(); resolve(); };
        const onError = (err: Error) => { doCleanup(); destroyAll(err); reject(err); };

        const doCleanup = () => {
            last.removeListener('finish', onFinish);
            last.removeListener('error', onError);
            // For readable last streams (e.g. piping to a transform)
            if (last instanceof Readable) {
                last.removeListener('end', onFinish);
            }
            for (const fn of cleanup) fn();
        };

        // The last stream could be a Writable (finish) or Readable (end)
        if (last instanceof Writable) {
            last.on('finish', onFinish);
        }
        if (last instanceof Readable) {
            last.on('end', onFinish);
        }
        last.on('error', onError);
    });
}

/**
 * Stream.finished — returns a Promise that resolves when a stream is done
 * (ended/finished) or rejects on error. Supports AbortSignal and
 * readable/writable options.
 */
export async function finished(
    stream: Stream,
    options?: { error?: boolean; readable?: boolean; writable?: boolean; signal?: AbortSignal }
): Promise<void> {
    const { readable = true, writable = true, signal } = options ?? {};

    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const listeners: (() => void)[] = [];

        const cleanup = () => {
            for (const fn of listeners) fn();
            listeners.length = 0;
        };

        const done = (err?: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) reject(err);
            else resolve();
        };

        const on = (emitter: Stream, event: string, handler: (...args: any[]) => void) => {
            emitter.on(event, handler);
            listeners.push(() => emitter.removeListener(event, handler));
        };

        // AbortSignal
        if (signal) {
            if (signal.aborted) { done(new Error('The operation was aborted')); return; }
            const onAbort = () => done(new Error('The operation was aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
            listeners.push(() => signal!.removeEventListener('abort', onAbort));
        }

        if (readable && stream instanceof Readable) {
            on(stream, 'end', () => done());
            on(stream, 'error', (err: Error) => done(err));
        }
        if (writable && stream instanceof Writable) {
            on(stream, 'finish', () => done());
            on(stream, 'error', (err: Error) => done(err));
        }
    });
}
