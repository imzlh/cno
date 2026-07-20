import { Stream, Readable, Writable, PassThrough, Transform } from './mod';

type PipelineStreamArg = Stream | ((source: Readable) => Stream);
type PipelineOptions = { signal?: AbortSignal };
type WebClosedController = {
    _addClosedCallback(resolve: () => void, reject: (reason?: unknown) => void): void;
};

function isPipelineOptions(value: unknown): value is PipelineOptions {
    return typeof value === 'object'
        && value !== null
        && 'signal' in value
        && Reflect.get(value, 'signal') instanceof AbortSignal;
}

function webClosedController(value: unknown): WebClosedController | null {
    if (
        !(value instanceof globalThis.ReadableStream) &&
        !(value instanceof globalThis.WritableStream)
    ) return null;
    const controller = Reflect.get(value, '_controller');
    if (!controller || (typeof controller !== 'object' && typeof controller !== 'function')) return null;
    const addClosedCallback = Reflect.get(controller, '_addClosedCallback');
    return typeof addClosedCallback === 'function'
        ? { _addClosedCallback: (resolve, reject) => addClosedCallback.call(controller, resolve, reject) }
        : null;
}

function isReadableLike(value: unknown): value is Readable {
    return value instanceof Readable
        || !!value && typeof value === 'object' && '_readableState' in value;
}

function isWritableLike(value: unknown): value is Writable {
    return value instanceof Writable
        || !!value && typeof value === 'object' && '_writableState' in value;
}

/**
 * Stream.pipeline — connects streams and returns a Promise that resolves when
 * the pipeline finishes or rejects on the first error. Properly handles
 * transform functions, destroys all streams on error, and supports AbortSignal.
 */
export async function pipeline(
    ...streams: (PipelineStreamArg | PipelineOptions)[]
): Promise<void> {
    // Extract the optional signal from the last arg
    let signal: AbortSignal | undefined;
    const args = streams.map(s => {
        if (isPipelineOptions(s)) {
            signal = s.signal;
            return null;
        }
        return s;
    }).filter((s): s is PipelineStreamArg => s !== null);

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

    const abortError = () => new Error('The operation was aborted');
    if (signal?.aborted) {
        const err = abortError();
        destroyAll(err);
        throw err;
    }

    if (signal) {
        const abortSignal = signal;
        const onAbort = () => { destroyAll(abortError()); };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        cleanup.push(() => abortSignal.removeEventListener('abort', onAbort));
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
    stream: Stream | globalThis.ReadableStream | globalThis.WritableStream,
    options?: { error?: boolean; readable?: boolean; writable?: boolean; signal?: AbortSignal }
): Promise<void> {
    const { error: reportErrors = true, readable = true, writable = true, signal } = options ?? {};

    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const listeners: (() => void)[] = [];

        const cleanup = () => {
            for (const fn of listeners) fn();
            listeners.length = 0;
        };

        const done = (err?: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (err !== undefined) reject(err);
            else resolve();
        };

        const on = (emitter: Stream, event: string, handler: (...args: unknown[]) => void) => {
            emitter.on(event, handler);
            listeners.push(() => emitter.removeListener(event, handler));
        };

        // AbortSignal
        if (signal) {
            const abortSignal = signal;
            if (abortSignal.aborted) {
                done(Object.assign(new Error('The operation was aborted'), {
                    name: 'AbortError',
                    code: 'ABORT_ERR',
                    cause: abortSignal.reason,
                }));
                return;
            }
            const onAbort = () => done(Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
                code: 'ABORT_ERR',
                cause: abortSignal.reason,
            }));
            abortSignal.addEventListener('abort', onAbort, { once: true });
            listeners.push(() => abortSignal.removeEventListener('abort', onAbort));
        }

        if (
            (readable && stream instanceof globalThis.ReadableStream) ||
            (writable && stream instanceof globalThis.WritableStream)
        ) {
            const controller = webClosedController(stream);
            if (controller) {
                controller._addClosedCallback(() => done(), (reason) => done(reportErrors ? reason : undefined));
                return;
            }
        }

        const nodeReadable = readable && isReadableLike(stream);
        const nodeWritable = writable && isWritableLike(stream);
        if (!nodeReadable && !nodeWritable) {
            done(new TypeError('The "stream" argument must be a stream'));
            return;
        }

        let readableDone = !nodeReadable || !!stream.readableEnded || !!stream._readableState?.endEmitted;
        let writableDone = !nodeWritable || !!stream.writableFinished || !!stream._writableState?.finished;

        const maybeDone = () => {
            if (readableDone && writableDone) done();
        };
        const onClose = () => {
            if (readableDone && writableDone) done();
            else if (reportErrors) {
                done(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
            } else {
                done();
            }
        };

        if (nodeReadable) on(stream, 'end', () => { readableDone = true; maybeDone(); });
        if (nodeWritable) on(stream, 'finish', () => { writableDone = true; maybeDone(); });
        on(stream, 'close', onClose);
        if (reportErrors) on(stream, 'error', (...args: unknown[]) => done(args[0]));

        if (Reflect.get(stream as object, 'errored') != null && reportErrors) {
            done(Reflect.get(stream as object, 'errored'));
            return;
        }
        maybeDone();
    });
}
