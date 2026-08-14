/**
 * node:stream free functions: the is*() probes, destroy(), duplexPair(),
 * compose(), ReadableFrom() and addAbortSignal().
 *
 * Last in the chain: it needs the concrete Stream/Readable/Duplex constructors,
 * and nothing needs it back.
 */

import { Stream } from './base';
import { Readable } from './readable';
import { Duplex } from './duplex';
import { isReadableLike, isWritableLike } from './_shared';
import type { Writable } from './writable';
import type { DuplexOptions, ReadableOptions } from './types';

export function isDisturbed(stream: unknown): boolean {
    if (isReadableLike(stream)) {
        return !!stream._readableState.disturbed || stream.readableEnded || stream.readableAborted || stream.destroyed;
    }
    return false;
}

export function isErrored(stream: unknown): boolean {
    if (isReadableLike(stream) || isWritableLike(stream) || stream instanceof Stream) {
        return Reflect.get(stream, 'errored') != null;
    }
    const controller = stream && (typeof stream === 'object' || typeof stream === 'function')
        ? Reflect.get(stream as object, '_controller')
        : undefined;
    if (controller && typeof controller === 'object') return Reflect.get(controller, '_state') === 'errored';
    return false;
}

export function isDestroyed(stream: unknown): boolean | null {
    if (!stream || (typeof stream !== 'object' && typeof stream !== 'function')) return null;
    if (isReadableLike(stream)) return !!stream._readableState.destroyed;
    if (isWritableLike(stream)) return !!stream._writableState.destroyed;
    if (stream instanceof Stream) return !!stream.destroyed;
    return null;
}

export function isReadable(stream: unknown): boolean | null {
    if (isReadableLike(stream)) {
        return stream.readable === true && !stream.readableEnded && !stream.destroyed;
    }
    const controller = stream && (typeof stream === 'object' || typeof stream === 'function')
        ? Reflect.get(stream as object, '_controller')
        : undefined;
    if (controller && typeof controller === 'object' && typeof Reflect.get(stream as object, 'getReader') === 'function') {
        return Reflect.get(controller, '_state') === 'readable';
    }
    return null;
}

export function isWritable(stream: unknown): boolean | null {
    if (isWritableLike(stream)) {
        return stream.writable === true && !stream.writableEnded && !stream.destroyed;
    }
    const controller = stream && (typeof stream === 'object' || typeof stream === 'function')
        ? Reflect.get(stream as object, '_controller')
        : undefined;
    if (controller && typeof controller === 'object' && typeof Reflect.get(stream as object, 'getWriter') === 'function') {
        return Reflect.get(controller, '_state') === 'writable';
    }
    return null;
}

function createAbortError(reason?: unknown): Error & { code: string; cause?: unknown } {
    const error: Error & { code: string; cause?: unknown } = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
    });
    if (reason !== undefined) error.cause = reason;
    return error;
}

function createStreamDestroyedError(): Error & { code: string } {
    return Object.assign(new Error('Cannot call write after a stream was destroyed'), {
        code: 'ERR_STREAM_DESTROYED',
    });
}

export function destroy(stream: unknown, error?: Error | null): void {
    if (stream === null || stream === undefined) return;
    const destroyMethod = Reflect.get(Object(stream), 'destroy');
    const reason = error ?? createAbortError();
    if (typeof destroyMethod === 'function') {
        destroyMethod.call(stream, reason);
        return;
    }
    const emit = Reflect.get(Object(stream), 'emit');
    if (typeof emit === 'function') {
        queueMicrotask(() => {
            emit.call(stream, 'error', reason);
            emit.call(stream, 'close');
        });
    }
}

export function duplexPair(options: DuplexOptions = {}): [Duplex, Duplex] {
    const pendingWrites = new WeakMap<Duplex, Array<(error?: Error | null) => void>>();
    let first: Duplex;
    let second: Duplex;

    const createEndpoint = (peer: () => Duplex): Duplex => new Duplex({
        ...options,
        autoDestroy: false,
        read() {
            const writer = peer();
            const callbacks = pendingWrites.get(writer);
            const callback = callbacks?.shift();
            if (!callback) return;
            if (callbacks && callbacks.length === 0) pendingWrites.delete(writer);
            callback();
        },
        write(chunk, _encoding, callback) {
            const target = peer();
            if (target.destroyed) {
                callback(createStreamDestroyedError());
                return;
            }
            if (target.push(chunk)) callback();
            else {
                const callbacks = pendingWrites.get(this as Duplex) ?? [];
                callbacks.push(callback);
                pendingWrites.set(this as Duplex, callbacks);
            }
        },
        final(callback) {
            const target = peer();
            if (!target.destroyed) target.push(null);
            callback();
        },
    });

    first = createEndpoint(() => second);
    second = createEndpoint(() => first);

    const closeIfComplete = () => {
        const complete = first.readableEnded && first.writableFinished
            && second.readableEnded && second.writableFinished;
        if (!complete) return;
        if (!first.destroyed) first.destroy();
        if (!second.destroyed) second.destroy();
    };
    first.on('end', closeIfComplete);
    first.on('finish', closeIfComplete);
    second.on('end', closeIfComplete);
    second.on('finish', closeIfComplete);

    const firstDestroy = first.destroy;
    const secondDestroy = second.destroy;
    const abortPendingWrites = () => {
        for (const endpoint of [first, second]) {
            const callbacks = pendingWrites.get(endpoint);
            if (!callbacks) continue;
            pendingWrites.delete(endpoint);
        }
    };
    // Node propagates an errored destroy() to the opposite endpoint, but on a
    // later tick and without re-emitting the error there (the peer only sees
    // 'close'). A plain destroy() with no error does not touch the peer at all.
    const destroyPeerLater = (peer: Duplex, peerDestroy: Duplex['destroy']) => {
        process.nextTick(() => {
            if (!peer.destroyed) peerDestroy.call(peer);
        });
    };
    first.destroy = function destroyFirst(error?: Error | null): Duplex {
        const completed = first.readableEnded && first.writableFinished;
        const result = firstDestroy.call(first, error);
        if (!completed) abortPendingWrites();
        if (!completed && error) destroyPeerLater(second, secondDestroy);
        return result;
    };
    second.destroy = function destroySecond(error?: Error | null): Duplex {
        const completed = second.readableEnded && second.writableFinished;
        const result = secondDestroy.call(second, error);
        if (!completed) abortPendingWrites();
        if (!completed && error) destroyPeerLater(first, firstDestroy);
        return result;
    };

    return [first, second];
}

export function compose(...streams: Array<Duplex | Readable | Writable>): Duplex {
    if (streams.length < 2) throw new TypeError('compose requires at least two streams');
    for (let i = 0; i < streams.length - 1; i++) {
        const src = streams[i];
        const dst = streams[i + 1];
        if (!isWritableLike(dst)) {
            throw new TypeError('compose destination must be writable');
        }
        src.pipe(dst);
        src.on('error', (err: Error) => {
            if (!dst.destroyed) dst.destroy(err);
        });
    }

    const first = streams[0];
    const last = streams[streams.length - 1];
    if (!isWritableLike(first)) {
        throw new TypeError('compose first stream must be writable');
    }
    const composed = new Duplex({
        read() {},
        write(chunk, encoding, callback) {
            const ok = first.write(chunk, encoding);
            if (!ok && typeof first.once === 'function') {
                first.once('drain', () => callback());
                return;
            }
            callback();
        },
        final(callback) {
            first.end();
            callback();
        },
    });

    last.on('data', (chunk: unknown) => {
        composed.push(chunk);
    });
    last.on('end', () => {
        composed.push(null);
    });
    last.on('error', (err: Error) => {
        composed.destroy(err);
    });

    return composed;
}

export function ReadableFrom(iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: ReadableOptions): Readable {
    return Readable.from(iterable, options);
}

export function addAbortSignal(signal: AbortSignal, stream: Stream): Stream {
    if (signal.aborted) {
        stream.destroy(createAbortError(signal.reason));
    } else {
        signal.addEventListener('abort', () => {
            stream.destroy(createAbortError(signal.reason));
        });
    }
    return stream;
}
