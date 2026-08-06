import { Stream, Readable, Writable, PassThrough, Transform } from './mod';

type PipelineStreamArg = Stream | ((source: Readable) => unknown);
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

function isNodeStreamLike(value: unknown): value is Stream {
    return !!value && typeof value === 'object'
        && ('_readableState' in value || '_writableState' in value);
}

function isIterableLike(value: unknown): value is AsyncIterable<unknown> | Iterable<unknown> {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    return typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
        || typeof Reflect.get(value, Symbol.iterator) === 'function';
}

/**
 * Stream.pipeline — connects streams and returns a Promise that resolves when
 * the pipeline finishes or rejects on the first error. Properly handles
 * transform functions, destroys all streams on error, and supports AbortSignal.
 */
export async function pipeline(
    ...streams: (PipelineStreamArg | PipelineOptions)[]
): Promise<unknown> {
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

    // ── Error bookkeeping ─────────────────────────────────────────────────────
    // Declared before the resolve loop so generator transforms can report the
    // error they threw, which is authoritative: when a generator throws, the
    // abandoned async iterator also tears the *source* down with an ABORT_ERR /
    // premature-close, and that symptom must not mask the real cause.
    const resolved: Stream[] = [];
    const cleanup: (() => void)[] = [];
    const errors: Error[] = [];
    let settled = false;
    let settle: ((err: Error) => void) | null = null;

    const destroyAll = (err?: Error) => {
        for (const s of resolved) {
            if (!s.destroyed) s.destroy(err);
        }
    };
    const isWeakError = (err: unknown): boolean => {
        const code = err && typeof err === 'object' ? Reflect.get(err, 'code') : undefined;
        return code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE';
    };
    const bestError = (): Error => errors.find((e) => !isWeakError(e)) ?? errors[0];
    const recordError = (err: Error) => {
        errors.push(err);
        if (settled) return;
        if (isWeakError(err)) {
            // Give a real error a chance to arrive before settling on a symptom.
            queueMicrotask(() => {
                if (settled) return;
                const best = bestError();
                destroyAll(best);
                settle?.(best);
            });
            return;
        }
        destroyAll(err);
        settle?.(err);
    };

    // Resolve transform functions into actual streams.
    //
    // A function may return either a stream (classic transform factory) or an
    // iterable / async-iterable (generator transform, as in
    // `pipeline(src, async function*(source) {...}, dest)`). The generator case
    // *consumes* the previous stream itself, so the previous stream must not
    // also be piped into the resulting stream — `pipeFromPrev` tracks that.
    const pipeFromPrev: boolean[] = [];
    let terminalPending: unknown;
    let hasTerminalValue = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg !== 'function') {
            resolved.push(arg);
            pipeFromPrev.push(resolved.length > 1);
            continue;
        }

        const prev = resolved[resolved.length - 1];
        if (prev === undefined) {
            throw new TypeError('The first argument to pipeline must be a stream or an iterable');
        }
        const returned = arg(prev as Readable);

        if (isNodeStreamLike(returned)) {
            resolved.push(returned);
            pipeFromPrev.push(true);
            continue;
        }
        if (isIterableLike(returned)) {
            const source = returned;
            const tracked = (async function* () {
                try {
                    yield* source as AsyncIterable<unknown>;
                } catch (err) {
                    recordError(err instanceof Error ? err : new Error(String(err)));
                    throw err;
                }
            })();
            // The generator already reads `prev`; splice its output in as a stream.
            resolved.push(Readable.from(tracked, { objectMode: true }));
            pipeFromPrev.push(false);
            continue;
        }
        if (i === args.length - 1) {
            // Final function may consume the source and resolve with any value.
            // Awaited only after piping is wired up, so data can actually flow.
            terminalPending = returned;
            hasTerminalValue = true;
            continue;
        }
        throw Object.assign(
            new TypeError(`Expected AsyncIterable to be returned from the "transform[${i - 1}]" function`),
            { code: 'ERR_INVALID_RETURN_VALUE' },
        );
    }

    // Once the pipeline has settled, a late error must not become an unhandled
    // 'error' event. These sinks are intentionally never removed.
    for (const s of resolved) s.on('error', () => {});

    // Pipe consecutive streams
    for (let i = 0; i < resolved.length - 1; i++) {
        const src = resolved[i] as Readable;
        const dst = resolved[i + 1] as Writable;
        if (pipeFromPrev[i + 1]) src.pipe(dst);

        const onSrcError = (err: Error) => { recordError(err); };
        const onDstError = (err: Error) => { recordError(err); };
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

    // A trailing function that consumed the source itself owns completion.
    if (hasTerminalValue) {
        try {
            return await terminalPending;
        } finally {
            for (const fn of cleanup) fn();
        }
    }

    return new Promise<void>((resolve, reject) => {
        const last = resolved[resolved.length - 1];

        const doCleanup = () => {
            last.removeListener('finish', onFinish);
            last.removeListener('error', onError);
            // For readable last streams (e.g. piping to a transform)
            if (last instanceof Readable) {
                last.removeListener('end', onFinish);
            }
            for (const fn of cleanup) fn();
        };

        function onFinish() {
            if (settled) return;
            settled = true;
            doCleanup();
            resolve();
        }
        function onError(err: Error) { recordError(err); }

        settle = (err: Error) => {
            if (settled) return;
            settled = true;
            doCleanup();
            reject(err);
        };

        // The last stream could be a Writable (finish) or Readable (end)
        if (last instanceof Writable) {
            last.on('finish', onFinish);
        }
        if (last instanceof Readable) {
            last.on('end', onFinish);
            // A generator-derived tail has no consumer, so nothing would pull
            // data through it and 'end' would never fire. Drain it.
            if (!(last instanceof Writable)) last.resume();
        }
        last.on('error', onError);

        // An error may already have been recorded while wiring up the pipes.
        if (errors.length > 0) {
            const best = bestError();
            destroyAll(best);
            settle(best);
        }
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
