export * from './mod';
export * as promises from './promises';

import { Stream } from './mod';
import * as stream from './mod';
import * as streamPromises from './promises';
import * as streamWeb from './web';
import * as streamConsumers from './consumers';

(stream.Readable as typeof stream.Readable & {
    fromWeb?: typeof streamWeb.readableFromWeb;
    toWeb?: typeof streamWeb.readableToWeb;
}).fromWeb = streamWeb.readableFromWeb;
(stream.Readable as typeof stream.Readable & {
    fromWeb?: typeof streamWeb.readableFromWeb;
    toWeb?: typeof streamWeb.readableToWeb;
}).toWeb = streamWeb.readableToWeb;
(stream.Writable as typeof stream.Writable & {
    fromWeb?: typeof streamWeb.writableFromWeb;
    toWeb?: typeof streamWeb.writableToWeb;
}).fromWeb = streamWeb.writableFromWeb;
(stream.Writable as typeof stream.Writable & {
    fromWeb?: typeof streamWeb.writableFromWeb;
    toWeb?: typeof streamWeb.writableToWeb;
}).toWeb = streamWeb.writableToWeb;
(stream.Duplex as typeof stream.Duplex & {
    fromWeb?: typeof streamWeb.duplexFromWeb;
}).fromWeb = streamWeb.duplexFromWeb;

type StreamCallback = (error?: Error | null) => void;
type StreamPipelineArgs =
    | [...streams: unknown[], callback: StreamCallback]
    | unknown[];
type PipelineOptionsLike = { signal?: AbortSignal };
type FinishedOptions = { error?: boolean; readable?: boolean; writable?: boolean; signal?: AbortSignal };

function assertCallback(name: string, callback: unknown): asserts callback is StreamCallback {
    if (typeof callback !== 'function') {
        throw new TypeError(`The "${name}" argument must be of type function`);
    }
}

function isPipelineOptions(value: unknown): value is PipelineOptionsLike {
    return !!value && typeof value === 'object' && 'signal' in value;
}

function isFinishedOptions(value: FinishedOptions | StreamCallback | undefined): value is FinishedOptions | undefined {
    return value === undefined || typeof value !== 'function';
}

function lastPipelineStream(args: unknown[]): unknown {
    for (let i = args.length - 1; i >= 0; i--) {
        if (!isPipelineOptions(args[i])) return args[i];
    }
    return undefined;
}

export function pipeline(...args: StreamPipelineArgs): unknown {
    const callback = args.pop();
    assertCallback('callback', callback);
    const streams = args as Parameters<typeof streamPromises.pipeline>;
    const promise = streamPromises.pipeline(...streams);
    const returnValue = lastPipelineStream(args);
    promise.then(
        () => callback(null),
        (error: Error) => callback(error),
    );
    return returnValue;
}

export function finished(
    streamInstance: Stream | globalThis.ReadableStream | globalThis.WritableStream,
    options?: FinishedOptions | StreamCallback,
    callback?: StreamCallback
): Stream | globalThis.ReadableStream | globalThis.WritableStream {
    let cb = callback;
    const opts = isFinishedOptions(options) ? options : undefined;
    if (typeof options === 'function') {
        cb = options;
    }
    assertCallback('callback', cb);
    const promise = streamPromises.finished(streamInstance, opts);
    promise.then(
        () => cb(null),
        (error: Error) => cb(error),
    );
    return streamInstance;
}

export const web = streamWeb;
export const consumers = streamConsumers;

export default Object.assign(Stream, stream, {
    pipeline,
    finished,
    promises: streamPromises,
    web: streamWeb,
    consumers: streamConsumers,
});
